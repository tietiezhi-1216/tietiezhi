package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// OpenAIProvider OpenAI 协议实现
type OpenAIProvider struct {
	baseURL string
	apiKey  string
	model   string
	client  *http.Client
}

// NewOpenAIProvider 创建 OpenAI 提供者
func NewOpenAIProvider(baseURL, apiKey, model string) *OpenAIProvider {
	return &OpenAIProvider{
		baseURL: baseURL,
		apiKey:  apiKey,
		model:   model,
		client:  &http.Client{},
	}
}

// Chat 同步聊天
func (p *OpenAIProvider) Chat(ctx context.Context, req *ChatRequest) (*ChatResponse, error) {
	// TODO: Phase 1 实现
	return nil, fmt.Errorf("Chat 尚未实现")
}

// ChatStream 流式聊天
func (p *OpenAIProvider) ChatStream(ctx context.Context, req *ChatRequest) (<-chan StreamChunk, error) {
	// TODO: Phase 1 实现
	return nil, fmt.Errorf("ChatStream 尚未实现")
}

// sendRequest 发送 HTTP 请求到 OpenAI API
func (p *OpenAIProvider) sendRequest(ctx context.Context, req *ChatRequest) (*http.Response, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("序列化请求失败: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", p.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("创建请求失败: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+p.apiKey)

	return p.client.Do(httpReq)
}

// parseStreamChunk 解析 SSE 流式响应块
func parseStreamChunk(data []byte) (*StreamChunk, error) {
	var chunk StreamChunk
	if err := json.Unmarshal(data, &chunk); err != nil {
		return nil, fmt.Errorf("解析流式响应失败: %w", err)
	}
	return &chunk, nil
}
