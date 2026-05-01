package agent

import (
	"context"
	"fmt"
	"log"

	"tietiezhi/internal/llm"
	"tietiezhi/internal/memory"
	"tietiezhi/internal/session"
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

// Run 执行 Agent 对话（含工具调用循环）
// isGroup: 是否是群聊（影响是否注入 MEMORY.md）
func (a *BaseAgent) Run(ctx context.Context, sessionKey string, isGroup bool, input *Message) (*Message, error) {
	history := a.sessionMgr.GetHistory(sessionKey)

	messages := make([]llm.ChatMessage, 0, len(history)+2)

	// 系统提示词
	systemPrompt := a.systemPrompt
	if a.memoryMgr != nil {
		memoryContext := a.memoryMgr.BuildMemoryContext(isGroup)
		if memoryContext != "" {
			systemPrompt = systemPrompt + "\n\n" + memoryContext
		}
	}
	// 追加记忆写入指引
	systemPrompt += "\n\n## 记忆写入指引\n你可以使用 memory_add 工具来记录重要信息。当用户说\"记住\"、\"记一下\"，或者对话中出现重要的偏好、决策、事实时，请主动调用 memory_add 工具。日常笔记用 daily 类型，重要偏好和决策用 longterm 类型。"

	if systemPrompt != "" {
		messages = append(messages, llm.ChatMessage{Role: "system", Content: systemPrompt})
	}

	messages = append(messages, history...)
	messages = append(messages, llm.ChatMessage{Role: "user", Content: input.Content})

	// 追加用户消息到 session
	a.sessionMgr.AppendMessage(sessionKey, llm.ChatMessage{Role: "user", Content: input.Content})

	// ReAct 循环：最多 5 轮工具调用
	maxToolRounds := 5
	for round := 0; round < maxToolRounds; round++ {
		req := &llm.ChatRequest{
			Messages: messages,
			Tools:    GetMemoryTools(),
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
			result := ExecuteToolCall(toolCall, a.memoryMgr)
			log.Printf("工具结果 [%s]: %s", sessionKey, result)

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

// RunStream 流式对话
// isGroup: 是否是群聊（影响是否注入 MEMORY.md）
func (a *BaseAgent) RunStream(ctx context.Context, sessionKey string, isGroup bool, input *Message) (<-chan llm.StreamChunk, error) {
	history := a.sessionMgr.GetHistory(sessionKey)

	messages := make([]llm.ChatMessage, 0, len(history)+2)

	// 系统提示词 = 基础 prompt + 记忆上下文
	systemPrompt := a.systemPrompt
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

// truncate 截断字符串
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
