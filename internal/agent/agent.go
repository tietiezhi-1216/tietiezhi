package agent

import "context"

// Message Agent 消息
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Agent Agent 接口
type Agent interface {
	// Run 执行一次 Agent 对话
	Run(ctx context.Context, input *Message) (*Message, error)
}

// BaseAgent 基础 Agent 实现
type BaseAgent struct {
	// TODO: Phase 1 填充字段
}

// NewBaseAgent 创建基础 Agent
func NewBaseAgent() *BaseAgent {
	return &BaseAgent{}
}

// Run 执行对话
func (a *BaseAgent) Run(ctx context.Context, input *Message) (*Message, error) {
	// TODO: Phase 1 实现对话循环
	return &Message{Role: "assistant", Content: "Agent 尚未实现"}, nil
}
