package llm

import (
	"context"
	"encoding/json"
	"strings"
)

// ChatMessage 聊天消息
// Content 字段支持两种类型：
// - string: 纯文本消息
// - []ContentPart: 多模态消息（包含文本和图片）
type ChatMessage struct {
	Role       string      `json:"role"`                         // system, user, assistant, tool
	Content    any         `json:"content,omitempty"`             // 文本内容或 []ContentPart
	ToolCalls  []ToolCall  `json:"tool_calls,omitempty"`          // assistant 发起的工具调用
	ToolCallID string      `json:"tool_call_id,omitempty"`        // tool 角色对应的 tool_call ID
	Name       string      `json:"name,omitempty"`                // tool 角色对应的函数名
}

// ContentPart 消息内容部分（支持多模态）
// 用于构建包含文本和图片的混合消息
type ContentPart struct {
	Type     string    `json:"type"`                // "text" 或 "image_url"
	Text     string    `json:"text,omitempty"`       // text 类型的内容
	ImageURL *ImageURL `json:"image_url,omitempty"`  // image_url 类型的内容
}

// ImageURL 图片 URL
// 可以是 HTTP URL 或 data:image/xxx;base64,xxx 格式
type ImageURL struct {
	URL    string `json:"url"`              // 图片 URL 或 data:image/xxx;base64,xxx
	Detail string `json:"detail,omitempty"` // "low", "high", "auto"
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

// NewTextMessage 创建纯文本消息
func NewTextMessage(role, content string) ChatMessage {
	return ChatMessage{
		Role:    role,
		Content: content,
	}
}

// NewMultimodalMessage 创建多模态消息
// parts: 内容部分列表
func NewMultimodalMessage(role string, parts []ContentPart) ChatMessage {
	return ChatMessage{
		Role:    role,
		Content: parts,
	}
}

// GetContentAsText 获取文本内容
// 如果 Content 是字符串，直接返回
// 如果 Content 是 []ContentPart，提取所有文本部分拼接
func (m *ChatMessage) GetContentAsText() string {
	if m.Content == nil {
		return ""
	}

	switch v := m.Content.(type) {
	case string:
		return v
	case []ContentPart:
		var sb strings.Builder
		for _, part := range v {
			if part.Type == "text" && part.Text != "" {
				sb.WriteString(part.Text)
			}
		}
		return sb.String()
	default:
		// 尝试 JSON 序列化
		if data, err := json.Marshal(m.Content); err == nil {
			return string(data)
		}
		return ""
	}
}
