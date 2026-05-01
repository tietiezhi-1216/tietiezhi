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
	provider      llm.Provider
	systemPrompt  string
	maxToolCalls  int
	loopDetector  *LoopDetector
	sessionMgr    *session.SessionManager
	memoryMgr     *memory.MemoryManager
	skillLoader   *skill.Loader
	mcpManager    *mcp.MCPManager
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

// GetSkillLoader 获取技能加载器
func (a *BaseAgent) GetSkillLoader() *skill.Loader {
	return a.skillLoader
}

// GetMCPManager 获取 MCP 管理器
func (a *BaseAgent) GetMCPManager() *mcp.MCPManager {
	return a.mcpManager
}

// Run 执行 Agent 对话（含工具调用循环）
// isGroup: 是否是群聊（影响是否注入 MEMORY.md）
func (a *BaseAgent) Run(ctx context.Context, sessionKey string, isGroup bool, input *Message) (*Message, error) {
	history := a.sessionMgr.GetHistory(sessionKey)

	messages := make([]llm.ChatMessage, 0, len(history)+2)

	// 系统提示词
	systemPrompt := a.systemPrompt

	// 检查 BOOTSTRAP.md 是否存在（仅私聊），在 system prompt 最开头加强指令
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

	// 追加技能系统指引（如果有可用技能）
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

	// ReAct 循环：最多 5 轮工具调用
	maxToolRounds := 5
	// 会话级别的已加载技能状态
	loadedSkills := make(map[string]*LoadedSkill)
	
	for round := 0; round < maxToolRounds; round++ {
		// 构建工具列表
		tools := a.buildToolsList()
		
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

		// 有工具调用：追加 assistant 消息（含 tool_calls）到历史
		messages = append(messages, assistantMsg)
		a.sessionMgr.AppendMessage(sessionKey, assistantMsg)

		// 执行每个工具调用
		for _, toolCall := range assistantMsg.ToolCalls {
			log.Printf("工具调用 [%s]: %s(%s)", sessionKey, toolCall.Function.Name, toolCall.Function.Arguments)
			result := a.ExecuteToolCall(toolCall, loadedSkills)
			log.Printf("工具结果 [%s]: %s", sessionKey, truncate(result, 200))

			// 检查是否是 skill_load 结果（需要注入系统提示词）
			if toolCall.Function.Name == "skill_load" {
				if injectedPrompt := a.handleSkillLoadResult(result, loadedSkills); injectedPrompt != "" {
					// 注入技能内容到系统提示词
					// 找到系统消息并追加
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
			// tool 消息不追加到 session history，避免污染上下文
		}
	}

	return nil, fmt.Errorf("工具调用轮数超限")
}

// buildToolsList 构建工具列表
func (a *BaseAgent) buildToolsList() []llm.ToolDef {
	var tools []llm.ToolDef
	
	// 基础记忆工具
	tools = append(tools, GetMemoryTools()...)
	
	// 技能工具（如果有）
	if skillTools := GetSkillTools(a.skillLoader); len(skillTools) > 0 {
		tools = append(tools, skillTools...)
	}
	
	return tools
}

// handleSkillLoadResult 处理 skill_load 结果，返回需要注入的 system prompt
func (a *BaseAgent) handleSkillLoadResult(result string, loadedSkills map[string]*LoadedSkill) string {
	// 解析 result
	var loadResult struct {
		Success    bool     `json:"success"`
		SkillName  string   `json:"skill_name"`
		Error      string   `json:"error"`
		MCPTools   []string `json:"mcp_tools,omitempty"`
	}
	
	if err := json.Unmarshal([]byte(result), &loadResult); err != nil {
		return ""
	}
	
	if !loadResult.Success {
		return ""
	}
	
	// 获取已加载的技能信息
	ls, exists := loadedSkills[loadResult.SkillName]
	if !exists {
		return ""
	}
	
	return ls.SystemPrompt
}

// RunStream 流式对话
// isGroup: 是否是群聊（影响是否注入 MEMORY.md）
func (a *BaseAgent) RunStream(ctx context.Context, sessionKey string, isGroup bool, input *Message) (<-chan llm.StreamChunk, error) {
	history := a.sessionMgr.GetHistory(sessionKey)

	messages := make([]llm.ChatMessage, 0, len(history)+2)

	// 系统提示词 = 基础 prompt + 记忆上下文
	systemPrompt := a.systemPrompt

	// 检查 BOOTSTRAP.md 是否存在（仅私聊），在 system prompt 最开头加强指令
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

	// 先追加用户消息
	a.sessionMgr.AppendMessage(sessionKey, llm.ChatMessage{Role: "user", Content: input.Content})

	req := &llm.ChatRequest{
		Messages: messages,
		Tools:    GetMemoryTools(), // 流式暂时只用基础工具
	}

	return a.provider.ChatStream(ctx, req)
}

// AppendToSession 追加助手消息到会话（流式完成后调用）
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

// ExecuteToolCall 执行工具调用（带已加载技能状态）
func (a *BaseAgent) ExecuteToolCall(call llm.ToolCall, loadedSkills map[string]*LoadedSkill) string {
	toolName := call.Function.Name
	
	// MCP 工具：以 mcp__ 开头
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
	
	// 其他工具（记忆相关）
	return ExecuteToolCall(call, a.memoryMgr)
}

// truncate 截断字符串
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
