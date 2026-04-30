package agent

import (
	"context"
	"fmt"
	"log"

	"tietiezhi/internal/llm"
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
	history      []llm.ChatMessage // 对话历史
}

// NewBaseAgent 创建基础 Agent
func NewBaseAgent(provider llm.Provider, systemPrompt string, maxToolCalls int) *BaseAgent {
	return &BaseAgent{
		provider:     provider,
		systemPrompt: systemPrompt,
		maxToolCalls: maxToolCalls,
		loopDetector: NewLoopDetector(maxToolCalls),
		history:      make([]llm.ChatMessage, 0),
	}
}

// Run 执行一次 Agent 对话
func (a *BaseAgent) Run(ctx context.Context, input *Message) (*Message, error) {
	// 构造消息列表
	messages := make([]llm.ChatMessage, 0, len(a.history)+2)

	// 系统提示词
	if a.systemPrompt != "" {
		messages = append(messages, llm.ChatMessage{
			Role:    "system",
			Content: a.systemPrompt,
		})
	}

	// 历史消息
	messages = append(messages, a.history...)

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

	// 保存到历史
	a.history = append(a.history,
		llm.ChatMessage{Role: "user", Content: input.Content},
		llm.ChatMessage{Role: assistantMsg.Role, Content: assistantMsg.Content},
	)

	// 限制历史长度，保留最近 20 轮
	if len(a.history) > 40 {
		a.history = a.history[len(a.history)-40:]
	}

	log.Printf("Agent 响应: %s", truncate(assistantMsg.Content, 200))
	return &Message{Role: "assistant", Content: assistantMsg.Content}, nil
}

// RunStream 流式对话
func (a *BaseAgent) RunStream(ctx context.Context, input *Message) (<-chan llm.StreamChunk, error) {
	messages := make([]llm.ChatMessage, 0, len(a.history)+2)

	if a.systemPrompt != "" {
		messages = append(messages, llm.ChatMessage{
			Role:    "system",
			Content: a.systemPrompt,
		})
	}

	messages = append(messages, a.history...)
	messages = append(messages, llm.ChatMessage{
		Role:    "user",
		Content: input.Content,
	})

	req := &llm.ChatRequest{
		Messages: messages,
	}

	return a.provider.ChatStream(ctx, req)
}

// ClearHistory 清空对话历史
func (a *BaseAgent) ClearHistory() {
	a.history = a.history[:0]
	a.loopDetector.Reset()
}

// truncate 截断字符串
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
