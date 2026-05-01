package agent

import (
	"context"
	"fmt"
	"log"

	"tietiezhi/internal/llm"
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
}

// NewBaseAgent 创建基础 Agent
func NewBaseAgent(provider llm.Provider, systemPrompt string, maxToolCalls int, sessionMgr *session.SessionManager) *BaseAgent {
	return &BaseAgent{
		provider:     provider,
		systemPrompt: systemPrompt,
		maxToolCalls: maxToolCalls,
		loopDetector: NewLoopDetector(maxToolCalls),
		sessionMgr:   sessionMgr,
	}
}

// Run 执行一次 Agent 对话
func (a *BaseAgent) Run(ctx context.Context, sessionKey string, input *Message) (*Message, error) {
	history := a.sessionMgr.GetHistory(sessionKey)

	// 构造消息列表
	messages := make([]llm.ChatMessage, 0, len(history)+2)

	// 系统提示词
	if a.systemPrompt != "" {
		messages = append(messages, llm.ChatMessage{
			Role:    "system",
			Content: a.systemPrompt,
		})
	}

	// 历史消息
	messages = append(messages, history...)

	// 当前用户消息
	messages = append(messages, llm.ChatMessage{
		Role:    "user",
		Content: input.Content,
	})

	// 调用 LLM
	req := &llm.ChatRequest{
		Messages: messages,
	}

	resp, err := a.provider.Chat(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("LLM 调用失败: %w", err)
	}

	if len(resp.Choices) == 0 {
		return nil, fmt.Errorf("LLM 返回空响应")
	}

	assistantMsg := resp.Choices[0].Message

	// 追加到 session
	a.sessionMgr.AppendMessage(sessionKey, llm.ChatMessage{Role: "user", Content: input.Content})
	a.sessionMgr.AppendMessage(sessionKey, llm.ChatMessage{Role: assistantMsg.Role, Content: assistantMsg.Content})

	log.Printf("Agent 响应 [%s]: %s", sessionKey, truncate(assistantMsg.Content, 200))
	return &Message{Role: "assistant", Content: assistantMsg.Content}, nil
}

// RunStream 流式对话
func (a *BaseAgent) RunStream(ctx context.Context, sessionKey string, input *Message) (<-chan llm.StreamChunk, error) {
	history := a.sessionMgr.GetHistory(sessionKey)

	messages := make([]llm.ChatMessage, 0, len(history)+2)

	if a.systemPrompt != "" {
		messages = append(messages, llm.ChatMessage{
			Role:    "system",
			Content: a.systemPrompt,
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

// truncate 截断字符串
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
