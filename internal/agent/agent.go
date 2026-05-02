package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"tietiezhi/internal/config"
	"tietiezhi/internal/hook"
	"tietiezhi/internal/llm"
	"tietiezhi/internal/media"
	"tietiezhi/internal/mcp"
	"tietiezhi/internal/memory"
	"tietiezhi/internal/session"
	"tietiezhi/internal/skill"
	"tietiezhi/internal/subagent"
)

// Message Agent 消息
type Message struct {
	Role    string   `json:"role"`
	Content string   `json:"content"`
	Media   []string `json:"media,omitempty"` // 媒体引用（路径或URL）
}

// Handler 消息处理函数类型
type Handler func(ctx context.Context, input *Message) (*Message, error)

// BaseAgent 基础 Agent 实现
type BaseAgent struct {
	provider        llm.Provider
	cheapProvider   llm.Provider   // 轻量级模型（用于压缩等简单任务）
	systemPrompt    string
	maxToolCalls    int
	loopDetector    *LoopDetector
	compressor      *ContextCompressor
	approvalMgr     *ApprovalManager
	sessionMgr      *session.SessionManager
	memoryMgr       *memory.MemoryManager
	skillLoader     *skill.Loader
	mcpManager      *mcp.MCPManager
	hookManager     *hook.HookManager
	subAgentMgr     *subagent.SubAgentManager
	cronMgr         interface {
		GetCronTools() []llm.ToolDef
		ExecuteCronTool(action string, args map[string]interface{}, sessionKey string, isGroup bool, chatID string) string
	}
	cfg              *config.AgentConfig
	fileAnalyzeTool  interface {
		Execute(input map[string]interface{}) (string, error)
	} // 文件分析工具（需要 LLM Provider）
}

// NewBaseAgent 创建基础 Agent
func NewBaseAgent(provider llm.Provider, systemPrompt string, maxToolCalls int, sessionMgr *session.SessionManager, memoryMgr *memory.MemoryManager) *BaseAgent {
	agent := &BaseAgent{
		provider:     provider,
		systemPrompt: systemPrompt,
		maxToolCalls: maxToolCalls,
		sessionMgr:   sessionMgr,
		memoryMgr:    memoryMgr,
		cfg:          &config.AgentConfig{},
	}

	// 初始化循环检测器（使用默认值）
	agent.loopDetector = NewLoopDetector(maxToolCalls, nil)

	return agent
}

// NewBaseAgentWithConfig 创建基础 Agent（带配置）
func NewBaseAgentWithConfig(provider llm.Provider, systemPrompt string, maxToolCalls int, sessionMgr *session.SessionManager, memoryMgr *memory.MemoryManager, cfg *config.AgentConfig) *BaseAgent {
	if cfg == nil {
		return NewBaseAgent(provider, systemPrompt, maxToolCalls, sessionMgr, memoryMgr)
	}

	agent := &BaseAgent{
		provider:     provider,
		systemPrompt: systemPrompt,
		maxToolCalls: maxToolCalls,
		sessionMgr:   sessionMgr,
		memoryMgr:    memoryMgr,
		cfg:          cfg,
	}

	// 初始化循环检测器
	agent.loopDetector = NewLoopDetector(maxToolCalls, &cfg.LoopDetector)

	// 初始化压缩器
	if cfg.Compression.Enabled {
		agent.compressor = NewContextCompressor(provider, &cfg.Compression)
	}

	// 初始化审批管理器
	agent.approvalMgr = NewApprovalManager(nil)

	return agent
}

// SetCheapProvider 设置轻量级模型
func (a *BaseAgent) SetCheapProvider(provider llm.Provider) {
	a.cheapProvider = provider
	if a.compressor != nil {
		a.compressor.SetCheapProvider(provider)
	}
}

// SetApprovalConfig 设置审批配置
func (a *BaseAgent) SetApprovalConfig(cfg *config.ApprovalConfig) {
	if cfg != nil {
		a.approvalMgr = NewApprovalManager(cfg)
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

// SetHookManager 设置 Hook 管理器
func (a *BaseAgent) SetHookManager(mgr *hook.HookManager) {
	a.hookManager = mgr
}

// SetSubAgentManager 设置子代理管理器
func (a *BaseAgent) SetSubAgentManager(mgr *subagent.SubAgentManager) {
	a.subAgentMgr = mgr
}

// SetFileAnalyzeTool 设置文件分析工具
func (a *BaseAgent) SetFileAnalyzeTool(tool interface{}) {
	a.fileAnalyzeTool = tool
}

// GetSkillLoader 获取技能加载器
func (a *BaseAgent) GetSkillLoader() *skill.Loader {
	return a.skillLoader
}

// GetMCPManager 获取 MCP 管理器
func (a *BaseAgent) GetMCPManager() *mcp.MCPManager {
	return a.mcpManager
}

// GetLoopDetector 获取循环检测器
func (a *BaseAgent) GetLoopDetector() *LoopDetector {
	return a.loopDetector
}

// GetApprovalManager 获取审批管理器
func (a *BaseAgent) GetApprovalManager() *ApprovalManager {
	return a.approvalMgr
}

// Run 执行 Agent 对话（含工具调用循环）
func (a *BaseAgent) Run(ctx context.Context, sessionKey string, isGroup bool, chatID string, input *Message) (*Message, error) {
	// 触发 session_start hook
	if a.hookManager != nil {
		event := hook.NewHookEvent(hook.EventSessionStart, sessionKey)
		a.hookManager.Fire(ctx, event)
	}

	// 触发 message_in hook
	if a.hookManager != nil {
		event := hook.NewHookEvent(hook.EventMessageIn, sessionKey)
		event.Message = input.Content
		a.hookManager.Fire(ctx, event)
	}

	result, err := a.runWithTools(ctx, sessionKey, isGroup, chatID, input, true)

	// 触发 message_out hook
	if a.hookManager != nil && result != nil {
		event := hook.NewHookEvent(hook.EventMessageOut, sessionKey)
		event.Message = result.Content
		a.hookManager.Fire(ctx, event)
	}

	// 触发 session_end hook
	if a.hookManager != nil {
		event := hook.NewHookEvent(hook.EventSessionEnd, sessionKey)
		a.hookManager.Fire(ctx, event)
	}

	return result, err
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

你可以使用 skill_load 工具加载技能来增强我的能力。加载技能后会注入相关知识到当前对话，部分技能还会提供额外的工具。`
	}

	// 追加审批系统指引
	if a.approvalMgr != nil && a.approvalMgr.IsEnabled() {
		systemPrompt += `

## 审批确认系统

某些操作需要用户确认后才能执行。如果工具返回 needs_approval=true，请告知用户需要确认并等待用户回复。
当用户确认后，再次调用该工具即可执行。`
	}

	// 追加多模态能力指引
	systemPrompt += `

## 多模态支持

你可以处理图片和文本的混合输入。当你收到图片时，可以直接理解图片内容。
支持的图片格式：PNG、JPEG、GIF、WebP。`

	if systemPrompt != "" {
		messages = append(messages, llm.ChatMessage{Role: "system", Content: systemPrompt})
	}

	messages = append(messages, history...)

	// 构建用户消息（支持多模态）
	var userMsg llm.ChatMessage
	if len(input.Media) > 0 {
		// 有媒体文件，构建多模态消息
		mmMsg, err := media.BuildMultimodalMessage("user", input.Content, input.Media)
		if err != nil {
			// 媒体处理失败，回退到纯文本
			userMsg = llm.ChatMessage{Role: "user", Content: input.Content}
		} else {
			userMsg = mmMsg
		}
	} else {
		userMsg = llm.ChatMessage{Role: "user", Content: input.Content}
	}
	messages = append(messages, userMsg)

	// 追加用户消息到 session（只保存文本内容）
	a.sessionMgr.AppendMessage(sessionKey, llm.ChatMessage{Role: "user", Content: input.Content})

	// ========== Context 压缩检查 ==========
	if a.compressor != nil && a.compressor.IsEnabled() && a.compressor.ShouldCompress(messages) {
		log.Printf("[压缩] 上下文过长（%d 字符），触发压缩", a.compressor.GetTotalChars(messages))
		// 执行压缩
		compressed, err := a.compressor.Compress(ctx, messages)
		if err != nil {
			log.Printf("[压缩] 压缩失败: %v，使用原始消息继续", err)
		} else if compressed != nil {
			messages = compressed
			log.Printf("[压缩] 压缩完成：%d 条消息", len(messages))
		}
	}

	// ReAct 循环
	maxToolRounds := a.maxToolCalls
	if maxToolRounds <= 0 {
		maxToolRounds = 20
	}
	loadedSkills := make(map[string]*LoadedSkill)

	for round := 0; round < maxToolRounds; round++ {
		// 构建工具列表
		tools := a.buildToolsList(injectCronTools, sessionKey)

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
			a.sessionMgr.AppendMessage(sessionKey, llm.ChatMessage{Role: assistantMsg.Role, Content: assistantMsg.GetContentAsText()})
			log.Printf("Agent 响应 [%s]: %s", sessionKey, truncate(assistantMsg.GetContentAsText(), 200))
			return &Message{Role: "assistant", Content: assistantMsg.GetContentAsText()}, nil
		}

		// 有工具调用
		messages = append(messages, assistantMsg)
		a.sessionMgr.AppendMessage(sessionKey, assistantMsg)

		// 执行每个工具调用
		for _, toolCall := range assistantMsg.ToolCalls {
			toolArgs := parseToolArgs(toolCall.Function.Arguments)

			log.Printf("工具调用 [%s]: %s(%s)", sessionKey, toolCall.Function.Name, toolCall.Function.Arguments)

			// ========== 循环检测（前置） ==========
			if a.loopDetector != nil && a.cfg != nil && a.cfg.LoopDetection {
				if a.loopDetector.Check(toolCall.Function.Name, "", toolArgs) {
					log.Printf("[循环检测] 检测到循环，已熔断")
					loopMsg := llm.ChatMessage{
						Role:    "system",
						Content: "⚠️ 检测到工具调用循环（重复调用相同工具或来回弹跳），已自动终止。请简化你的请求或改变策略。",
					}
					messages = append(messages, loopMsg)
					a.sessionMgr.AppendMessage(sessionKey, loopMsg)
					return &Message{Role: "assistant", Content: "检测到工具调用循环，已自动终止。请简化你的请求或改变策略。"}, nil
				}
			}

			result := a.ExecuteToolCall(toolCall, loadedSkills, sessionKey, isGroup, chatID)
			log.Printf("工具结果 [%s]: %s", sessionKey, truncate(result, 200))

			// ========== 循环检测（基于结果） ==========
			if a.loopDetector != nil && a.cfg != nil && a.cfg.LoopDetection {
				if a.loopDetector.Check(toolCall.Function.Name, result, toolArgs) {
					log.Printf("[循环检测] 基于结果检测到循环，已熔断")
					loopMsg := llm.ChatMessage{
						Role:    "system",
						Content: "⚠️ 检测到工具调用循环（无新进展或结果重复），已自动终止。请简化你的请求。",
					}
					messages = append(messages, loopMsg)
					a.sessionMgr.AppendMessage(sessionKey, loopMsg)
					return &Message{Role: "assistant", Content: "检测到工具调用循环，已自动终止。请简化你的请求。"}, nil
				}
			}

			// 检查是否是 skill_load 结果
			if toolCall.Function.Name == "skill_load" {
				if injectedPrompt := a.handleSkillLoadResult(result, loadedSkills); injectedPrompt != "" {
					for i := range messages {
						if messages[i].Role == "system" {
							messages[i].Content = messages[i].GetContentAsText() + injectedPrompt
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

	return nil, fmt.Errorf("工具调用轮数超限（%d次）", maxToolRounds)
}

// buildToolsList 构建工具列表
func (a *BaseAgent) buildToolsList(injectCron bool, sessionKey string) []llm.ToolDef {
	var tools []llm.ToolDef

	// 基础记忆工具
	tools = append(tools, GetMemoryTools()...)

	// 终端执行工具（Docker 沙箱）
	tools = append(tools, GetTerminalTools()...)

	// 技能工具
	if skillTools := GetSkillTools(a.skillLoader); len(skillTools) > 0 {
		tools = append(tools, skillTools...)
	}

	// 子代理工具（递归防护：sub session 不注入 agent_spawn）
	if !strings.HasPrefix(sessionKey, "sub:") && a.subAgentMgr != nil {
		tools = append(tools, subagent.GetSubAgentTools()...)
	}

	// delegate_task 工具（递归防护：sub session 不注入）
	if !strings.HasPrefix(sessionKey, "sub:") {
		tools = append(tools, GetDelegateTools()...)
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

	// 构建用户消息（支持多模态）
	var userMsg llm.ChatMessage
	if len(input.Media) > 0 {
		mmMsg, err := media.BuildMultimodalMessage("user", input.Content, input.Media)
		if err != nil {
			userMsg = llm.ChatMessage{Role: "user", Content: input.Content}
		} else {
			userMsg = mmMsg
		}
	} else {
		userMsg = llm.ChatMessage{Role: "user", Content: input.Content}
	}
	messages = append(messages, userMsg)

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
	if a.loopDetector != nil {
		a.loopDetector.Reset()
	}
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
	toolArgs := parseToolArgs(call.Function.Arguments)

	// ========== 审批检查 ==========
	if a.approvalMgr != nil && a.approvalMgr.IsEnabled() && a.approvalMgr.NeedsApproval(toolName) {
		if !a.approvalMgr.IsApproved(sessionKey, toolName) {
			// 请求审批
			req := a.approvalMgr.RequestApproval(sessionKey, toolName, toolArgs)
			return a.approvalMgr.BuildApprovalMessage(req)
		}
	}

	// 触发 pre_tool_use hook
	if a.hookManager != nil {
		event := hook.NewHookEvent(hook.EventPreToolUse, sessionKey)
		event.ToolName = toolName
		event.ToolInput = toolArgs

		proceed, hookResult := a.hookManager.ShouldProceed(context.Background(), event)
		if !proceed {
			log.Printf("[Hook] 工具 %s 被拒绝: %s", toolName, hookResult.Reason)
			return fmt.Sprintf(`{"error": "tool blocked by hook", "reason": "%s"}`, hookResult.Reason)
		}

		// 如果 hook 返回了修改后的输入，应用它
		if hookResult.Decision == hook.DecisionModify && hookResult.UpdatedInput != nil {
			modifiedArgsJSON, _ := json.Marshal(hookResult.UpdatedInput)
			toolArgs = hookResult.UpdatedInput
			call.Function.Arguments = string(modifiedArgsJSON)
			log.Printf("[Hook] 工具 %s 参数已修改", toolName)
		}
	}

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
			action, _ := toolArgs["action"].(string)
			return a.cronMgr.ExecuteCronTool(action, toolArgs, sessionKey, isGroup, chatID)
		}
		return `{"error": "定时任务管理器未初始化"}`
	}

	// delegate_task 工具
	if toolName == "delegate_task" {
		return ExecuteDelegate(call.Function.Arguments, a.provider)
	}

	// agent_spawn 子代理工具
	if toolName == "agent_spawn" {
		if a.subAgentMgr != nil {
			result, err := subagent.ExecuteSpawn(a.subAgentMgr, toolArgs, sessionKey, chatID, isGroup)
			if err != nil {
				return fmt.Sprintf(`{"error": "%s"}`, err.Error())
			}
			return result
		}
		return `{"error": "子代理管理器未初始化"}`
	}

	// 其他工具（记忆相关）
	var result string
	if call.Function.Name == "terminal_exec" {
		result = ExecuteTerminalToolCall(call)
	} else {
		result = ExecuteToolCall(call, a.memoryMgr)
	}

	// 触发 post_tool_use hook
	if a.hookManager != nil {
		event := hook.NewHookEvent(hook.EventPostToolUse, sessionKey)
		event.ToolName = toolName
		event.ToolInput = toolArgs
		event.ToolOutput = result
		a.hookManager.Fire(context.Background(), event)
	}

	return result
}

// ApproveToolCall 批准工具调用
// 由外部调用（如消息处理中识别到用户确认）
func (a *BaseAgent) ApproveToolCall(sessionKey, toolName string, approvedBy string) bool {
	if a.approvalMgr == nil {
		return false
	}
	return a.approvalMgr.Approve(sessionKey, toolName, approvedBy)
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
