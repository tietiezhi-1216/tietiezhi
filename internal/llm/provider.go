package llm

import (
	"context"
	"encoding/json"
)

// ChatMessage 聊天消息
type ChatMessage struct {
	Role       string      `json:"role"`                        // system, user, assistant, tool
	Content    string      `json:"content,omitempty"`          // 文本内容
	ToolCalls  []ToolCall  `json:"tool_calls,omitempty"`       // assistant 发起的工具调用
	ToolCallID string      `json:"tool_call_id,omitempty"`     // tool 角色对应的 tool_call ID
	Name       string      `json:"name,omitempty"`              // tool 角色对应的函数名
}

// ToolCall 工具调用
type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`     // "function"
	Function FunctionCall `json:"function"`
}

// FunctionCall 函数调用
type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"` // JSON 字符串
}

// ChatRequest 聊天请求
type ChatRequest struct {
	Model    string        `json:"model"`
	Messages []ChatMessage `json:"messages"`
	Stream   bool          `json:"stream"`
	Tools    []ToolDef     `json:"tools,omitempty"`
}

// ToolDef 工具定义
type ToolDef struct {
	Type     string      `json:"type"`
	Function FunctionDef `json:"function"`
}

// FunctionDef 函数定义
type FunctionDef struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Parameters  any    `json:"parameters,omitempty"`
}

// ChatResponse 聊天响应
type ChatResponse struct {
	ID      string   `json:"id"`
	Model   string   `json:"model"`
	Choices []Choice `json:"choices"`
}

// Choice 选择项
type Choice struct {
	Index        int         `json:"index"`
	Message      ChatMessage `json:"message"`
	FinishReason string      `json:"finish_reason"`
}

// StreamChunk 流式响应块
type StreamChunk struct {
	ID      string         `json:"id"`
	Choices []StreamChoice `json:"choices"`
}

// StreamChoice 流式选择项
type StreamChoice struct {
	Index        int             `json:"index"`
	Delta        json.RawMessage `json:"delta"`
	FinishReason *string         `json:"finish_reason"`
}

// StreamDelta 流式消息增量
type StreamDelta struct {
	Role    string `json:"role,omitempty"`
	Content string `json:"content,omitempty"`
}

// Provider LLM 提供者接口
type Provider interface {
	Chat(ctx context.Context, req *ChatRequest) (*ChatResponse, error)
	ChatStream(ctx context.Context, req *ChatRequest) (<-chan StreamChunk, error)
}
