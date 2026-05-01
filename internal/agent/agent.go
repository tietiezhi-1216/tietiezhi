package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"tietiezhi/internal/llm"
	"tietiezhi/internal/mcp"
	"tietiezhi/internal/memory"
	"tietiezhi/internal/session"
	"tietiezhi/internal/skill"
)

// Message Agent 消息
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Handler 消息处理函数类型
type Handler func(ctx context.Context, input *Message) (*Message, error)

// BaseAgent 基础 Agent 实现
type BaseAgent struct {
	provider     llm.Provider
	systemPrompt string
	maxToolCalls int
	loopDetector *LoopDetector
	sessionMgr   *session.SessionManager
	memoryMgr    *memory.MemoryManager
	skillLoader  *skill.Loader
	mcpManager   *mcp.MCPManager
	cronMgr      interface {
		GetCronTools() []llm.ToolDef
		ExecuteCronTool(action string, args map[string]interface{}, sessionKey string, isGroup bool, chatID string) string
	}
}

// NewBaseAgent 创建基础 Agent
func NewBaseAgent(provider llm.Provider, systemPrompt string, maxToolCalls int, sessionMgr *session.SessionManager, memoryMgr *memory.MemoryManager) *BaseAgent {
	return &BaseAgent{
		provider:     provider,
		systemPrompt: systemPrompt,
		maxToolCalls: maxToolCalls,
		loopDetector: NewLoopDetector(maxToolCalls),
		sessionMgr:   sessionMgr,
		memoryMgr:    memoryMgr,
	}
}

// SetSkillLoader 设置技能加载器
func (a *BaseAgent) SetSkillLoader(loader *skill.Loader) {
	a.skillLoader = loader
}

// SetMCPManager 设置 MCP 管理器
func (a *BaseAgent) SetMCPManager(mgr *mcp.MCPManager) {
	a.mcpManager = mgr
}

// SetCronManager 设置定时任务管理器
func (a *BaseAgent) SetCronManager(mgr interface{}) {
	a.cronMgr = mgr.(interface {
		GetCronTools() []llm.ToolDef
		ExecuteCronTool(action string, args map[string]interface{}, sessionKey string, isGroup bool, chatID string) string
	})
}

// GetSkillLoader 获取技能加载器
func (a *BaseAgent) GetSkillLoader() *skill.Loader {
	return a.skillLoader
}

// GetMCPManager 获取 MCP 管理器
func (a *BaseAgent) GetMCPManager() *mcp.MCPManager {
	return a.mcpManager
}

// Run 执行 Agent 对话（含工具调用循环）
func (a *BaseAgent) Run(ctx context.Context, sessionKey string, isGroup bool, chatID string, input *Message) (*Message, error) {
	return a.runWithTools(ctx, sessionKey, isGroup, chatID, input, true)
}

// RunCron 执行 cron 任务（隔离 session，不注入 cron 工具）
func (a *BaseAgent) RunCron(ctx context.Context, sessionKey string, isGroup bool, role, content string) (string, error) {
	msg := &Message{Role: role, Content: content}
	
	// 使用 runWithTools，但注入 cron 工具
	// 注意：cron session 会话 key 以 "cron:" 开头，所以 buildToolsList 会跳过 cron 工具
	result, err := a.runWithTools(ctx, sessionKey, isGroup, "", msg, false)
	if err != nil {
		return "", err
	}
	if result != nil {
		return result.Content, nil
	}
	return "", nil
}

// runWithTools 通用运行方法
func (a *BaseAgent) runWithTools(ctx context.Context, sessionKey string, isGroup bool, chatID string, input *Message, injectCronTools bool) (*Message, error) {
	history := a.sessionMgr.GetHistory(sessionKey)

	messages := make([]llm.ChatMessage, 0, len(history)+2)

	// 系统提示词
	systemPrompt := a.systemPrompt

	// 检查 BOOTSTRAP.md 是否存在
	if !isGroup && a.memoryMgr != nil {
		if a.memoryMgr.FileExists("BOOTSTRAP.md") {
			bootstrapDirective := " 重要：BOOTSTRAP.md 存在于你的工作区。你必须优先执行初始化引导——和主人认识彼此，了解他们的偏好，然后使用工具更新 IDENTITY.md、USER.md、SOUL.md，最后用 delete_bootstrap 删除 BOOTSTRAP.md。不要正常回复，而是从引导对话开始。\n\n"
			systemPrompt = bootstrapDirective + systemPrompt
		}
	}

	if a.memoryMgr != nil {
		memoryContext := a.memoryMgr.BuildMemoryContext(isGroup)
		if memoryContext != "" {
			systemPrompt = systemPrompt + "\n\n" + memoryContext
		}
	}

	// 追加记忆写入指引
	systemPrompt += `

## 记忆工具使用指引

你可以使用以下工具来管理记忆：
- memory_add：记录重要信息。当用户说"记住"、"记一下"，或对话中出现重要的偏好、决策、事实时主动调用。日常笔记用 daily 类型，重要偏好和决策用 longterm 类型。
- memory_search：搜索记忆文件中的相关内容。当你需要回忆之前记录的信息时使用。
- delete_bootstrap：删除 BOOTSTRAP.md。完成初始化引导后必须调用此工具，避免重复触发。`

	// 追加技能系统指引
	if a.skillLoader != nil && len(a.skillLoader.GetAvailableSkills()) > 0 {
		systemPrompt += `

## 技能系统

你可以使用 skill_load 工具加载技能来增强你的能力。加载技能后会注入相关知识到当前对话，部分技能还会提供额外的工具。`
	}

	if systemPrompt != "" {
		messages = append(messages, llm.ChatMessage{Role: "system", Content: systemPrompt})
	}

	messages = append(messages, history...)
	messages = append(messages, llm.ChatMessage{Role: "user", Content: input.Content})

	// 追加用户消息到 session
	a.sessionMgr.AppendMessage(sessionKey, llm.ChatMessage{Role: "user", Content: input.Content})

	// ReAct 循环
	maxToolRounds := 5
	loadedSkills := make(map[string]*LoadedSkill)

	for round := 0; round < maxToolRounds; round++ {
		// 构建工具列表
		tools := a.buildToolsList(injectCronTools)

		req := &llm.ChatRequest{
			Messages: messages,
			Tools:    tools,
		}

		resp, err := a.provider.Chat(ctx, req)
		if err != nil {
			return nil, fmt.Errorf("LLM 调用失败: %w", err)
		}
		if len(resp.Choices) == 0 {
			return nil, fmt.Errorf("LLM 返回空响应")
		}

		assistantMsg := resp.Choices[0].Message

		// 如果没有工具调用，返回最终回复
		if len(assistantMsg.ToolCalls) == 0 {
			a.sessionMgr.AppendMessage(sessionKey, llm.ChatMessage{Role: assistantMsg.Role, Content: assistantMsg.Content})
			log.Printf("Agent 响应 [%s]: %s", sessionKey, truncate(assistantMsg.Content, 200))
			return &Message{Role: "assistant", Content: assistantMsg.Content}, nil
		}

		// 有工具调用
		messages = append(messages, assistantMsg)
		a.sessionMgr.AppendMessage(sessionKey, assistantMsg)

		// 执行每个工具调用
		for _, toolCall := range assistantMsg.ToolCalls {
			log.Printf("工具调用 [%s]: %s(%s)", sessionKey, toolCall.Function.Name, toolCall.Function.Arguments)
			result := a.ExecuteToolCall(toolCall, loadedSkills, sessionKey, isGroup, chatID)
			log.Printf("工具结果 [%s]: %s", sessionKey, truncate(result, 200))

			// 检查是否是 skill_load 结果
			if toolCall.Function.Name == "skill_load" {
				if injectedPrompt := a.handleSkillLoadResult(result, loadedSkills); injectedPrompt != "" {
					for i := range messages {
						if messages[i].Role == "system" {
							messages[i].Content += injectedPrompt
							break
						}
					}
					log.Printf("技能已注入到 system prompt")
				}
			}

			toolMsg := llm.ChatMessage{
				Role:       "tool",
				Content:    result,
				ToolCallID: toolCall.ID,
				Name:       toolCall.Function.Name,
			}
			messages = append(messages, toolMsg)
		}
	}

	return nil, fmt.Errorf("工具调用轮数超限")
}

// buildToolsList 构建工具列表
func (a *BaseAgent) buildToolsList(injectCron bool) []llm.ToolDef {
	var tools []llm.ToolDef

	// 基础记忆工具
	tools = append(tools, GetMemoryTools()...)

	// 技能工具
	if skillTools := GetSkillTools(a.skillLoader); len(skillTools) > 0 {
		tools = append(tools, skillTools...)
	}

	// 定时任务工具（递归防护）
	if injectCron && a.cronMgr != nil {
		tools = append(tools, a.cronMgr.GetCronTools()...)
	}

	return tools
}

// handleSkillLoadResult 处理 skill_load 结果
func (a *BaseAgent) handleSkillLoadResult(result string, loadedSkills map[string]*LoadedSkill) string {
	var loadResult struct {
		Success   bool     `json:"success"`
		SkillName string   `json:"skill_name"`
		Error     string   `json:"error"`
		MCPTools  []string `json:"mcp_tools,omitempty"`
	}

	if err := json.Unmarshal([]byte(result), &loadResult); err != nil {
		return ""
	}

	if !loadResult.Success {
		return ""
	}

	ls, exists := loadedSkills[loadResult.SkillName]
	if !exists {
		return ""
	}

	return ls.SystemPrompt
}

// RunStream 流式对话
func (a *BaseAgent) RunStream(ctx context.Context, sessionKey string, isGroup bool, input *Message) (<-chan llm.StreamChunk, error) {
	history := a.sessionMgr.GetHistory(sessionKey)

	messages := make([]llm.ChatMessage, 0, len(history)+2)

	systemPrompt := a.systemPrompt

	if !isGroup && a.memoryMgr != nil {
		if a.memoryMgr.FileExists("BOOTSTRAP.md") {
			bootstrapDirective := " 重要：BOOTSTRAP.md 存在于你的工作区。你必须优先执行初始化引导——和主人认识彼此，了解他们的偏好，然后使用工具更新 IDENTITY.md、USER.md、SOUL.md，最后用 delete_bootstrap 删除 BOOTSTRAP.md。不要正常回复，而是从引导对话开始。\n\n"
			systemPrompt = bootstrapDirective + systemPrompt
		}
	}

	if a.memoryMgr != nil {
		memoryContext := a.memoryMgr.BuildMemoryContext(isGroup)
		if memoryContext != "" {
			systemPrompt = systemPrompt + "\n\n" + memoryContext
		}
	}

	if systemPrompt != "" {
		messages = append(messages, llm.ChatMessage{
			Role:    "system",
			Content: systemPrompt,
		})
	}

	messages = append(messages, history...)
	messages = append(messages, llm.ChatMessage{
		Role:    "user",
		Content: input.Content,
	})

	a.sessionMgr.AppendMessage(sessionKey, llm.ChatMessage{Role: "user", Content: input.Content})

	req := &llm.ChatRequest{
		Messages: messages,
		Tools:    GetMemoryTools(),
	}

	return a.provider.ChatStream(ctx, req)
}

// AppendToSession 追加助手消息到会话
func (a *BaseAgent) AppendToSession(sessionKey, content string) {
	a.sessionMgr.AppendMessage(sessionKey, llm.ChatMessage{Role: "assistant", Content: content})
}

// ClearHistory 清空指定会话历史
func (a *BaseAgent) ClearHistory(sessionKey string) {
	s := a.sessionMgr.GetOrCreate(sessionKey)
	s.Clear()
	a.loopDetector.Reset()
}

// GetSessionMgr 获取会话管理器
func (a *BaseAgent) GetSessionMgr() *session.SessionManager {
	return a.sessionMgr
}

// GetMemoryMgr 获取记忆管理器
func (a *BaseAgent) GetMemoryMgr() *memory.MemoryManager {
	return a.memoryMgr
}

// ExecuteToolCall 执行工具调用
func (a *BaseAgent) ExecuteToolCall(call llm.ToolCall, loadedSkills map[string]*LoadedSkill, sessionKey string, isGroup bool, chatID string) string {
	toolName := call.Function.Name

	// MCP 工具
	if strings.HasPrefix(toolName, "mcp__") {
		if a.mcpManager != nil {
			return ExecuteMCPToolCall(call, a.mcpManager)
		}
		return `{"error": "MCP 管理器未初始化"}`
	}

	// 技能加载工具
	if toolName == "skill_load" {
		return ExecuteSkillLoad(call.Function.Arguments, a.skillLoader, a.mcpManager, loadedSkills)
	}

	// cron 工具
	if toolName == "cron_task" {
		if a.cronMgr != nil {
			args := parseToolArgs(call.Function.Arguments)
			action, _ := args["action"].(string)
			return a.cronMgr.ExecuteCronTool(action, args, sessionKey, isGroup, chatID)
		}
		return `{"error": "定时任务管理器未初始化"}`
	}

	// 其他工具（记忆相关）
	return ExecuteToolCall(call, a.memoryMgr)
}

// parseToolArgs 解析工具参数
func parseToolArgs(argsJSON string) map[string]interface{} {
	var args map[string]interface{}
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return make(map[string]interface{})
	}
	return args
}

// truncate 截断字符串
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
