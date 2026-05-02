package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
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
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		model:   model,
		client:  &http.Client{},
	}
}

// Chat 同步聊天
func (p *OpenAIProvider) Chat(ctx context.Context, req *ChatRequest) (*ChatResponse, error) {
	req.Stream = false
	req.Model = p.model

	resp, err := p.sendRequest(ctx, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("LLM 请求失败 (status=%d): %s", resp.StatusCode, string(body))
	}

	var chatResp ChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&chatResp); err != nil {
		return nil, fmt.Errorf("解析响应失败: %w", err)
	}
	return &chatResp, nil
}

// ChatStream 流式聊天
func (p *OpenAIProvider) ChatStream(ctx context.Context, req *ChatRequest) (<-chan StreamChunk, error) {
	req.Stream = true
	req.Model = p.model

	resp, err := p.sendRequest(ctx, req)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("LLM 流式请求失败 (status=%d): %s", resp.StatusCode, string(body))
	}

	ch := make(chan StreamChunk, 64)
	go func() {
		defer close(ch)
		defer resp.Body.Close()

		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

		for scanner.Scan() {
			line := scanner.Text()
			// SSE 格式：data: {...}
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			data := strings.TrimPrefix(line, "data: ")
			if data == "[DONE]" {
				return
			}

			var chunk StreamChunk
			if err := json.Unmarshal([]byte(data), &chunk); err != nil {
				continue // 跳过无法解析的行
			}
			select {
			case ch <- chunk:
			case <-ctx.Done():
				return
			}
		}
	}()

	return ch, nil
}

// sendRequest 发送 HTTP 请求到 OpenAI API
func (p *OpenAIProvider) sendRequest(ctx context.Context, req *ChatRequest) (*http.Response, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("序列化请求失败: %w", err)
	}

	url := p.baseURL + "/chat/completions"
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("创建请求失败: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+p.apiKey)

	return p.client.Do(httpReq)
}

// ProviderFactory LLM Provider 工厂
// 用于创建主 Provider 和 cheap Provider
type ProviderFactory struct{}

// NewProviderFactory 创建 Provider 工厂
func NewProviderFactory() *ProviderFactory {
	return &ProviderFactory{}
}

// CreateMainProvider 创建主 Provider
func (f *ProviderFactory) CreateMainProvider(baseURL, apiKey, model string) (Provider, error) {
	if baseURL == "" {
		return nil, fmt.Errorf("base_url 不能为空")
	}
	if apiKey == "" {
		return nil, fmt.Errorf("api_key 不能为空")
	}
	if model == "" {
		return nil, fmt.Errorf("model 不能为空")
	}
	return NewOpenAIProvider(baseURL, apiKey, model), nil
}

// CreateCheapProvider 创建 cheap Provider（用于简单任务如压缩总结）
// 如果 cheap 配置为空，使用主 Provider
func (f *ProviderFactory) CreateCheapProvider(
	mainBaseURL, mainAPIKey, mainModel string,
	cheapBaseURL, cheapAPIKey, cheapModel string,
) (Provider, error) {
	// 如果 cheap 配置完整，使用 cheap 配置
	if cheapBaseURL != "" && cheapAPIKey != "" && cheapModel != "" {
		return NewOpenAIProvider(cheapBaseURL, cheapAPIKey, cheapModel), nil
	}

	// 否则回退到主 Provider
	if mainBaseURL != "" && mainAPIKey != "" && mainModel != "" {
		return NewOpenAIProvider(mainBaseURL, mainAPIKey, mainModel), nil
	}

	return nil, fmt.Errorf("LLM 配置不完整")
}
