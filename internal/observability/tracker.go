package observability

import (
	"log"
	"sync"
)

// TokenTracker Token 使用追踪器
type TokenTracker struct {
	mu         sync.Mutex
	total      int64
	byModel    map[string]int64
	bySession  map[string]int64
	totalPrompt int64
	totalCompletion int64
}

// TokenStats Token 统计信息
type TokenStats struct {
	TotalTokens      int64            `json:"total_tokens"`       // 总 token 数
	TotalPrompt      int64            `json:"prompt_tokens"`     // 提示 token 总数
	TotalCompletion  int64            `json:"completion_tokens"`  // 完成 token 总数
	ByModel          map[string]int64 `json:"by_model"`           // 按模型统计
	BySession        map[string]int64 `json:"by_session"`         // 按会话统计
}

// NewTokenTracker 创建 Token 追踪器
func NewTokenTracker() *TokenTracker {
	return &TokenTracker{
		byModel:   make(map[string]int64),
		bySession: make(map[string]int64),
	}
}

// Record 记录一次 token 使用
// model: 模型名称
// sessionKey: 会话 key
// promptTokens: 提示 token 数
// completionTokens: 完成 token 数
func (t *TokenTracker) Record(model, sessionKey string, promptTokens, completionTokens int) {
	t.mu.Lock()
	defer t.mu.Unlock()

	totalTokens := int64(promptTokens + completionTokens)

	// 更新总数
	t.total += totalTokens
	t.totalPrompt += int64(promptTokens)
	t.totalCompletion += int64(completionTokens)

	// 更新模型统计
	t.byModel[model] += totalTokens

	// 更新会话统计
	t.bySession[sessionKey] += totalTokens

	log.Printf("[TokenTracker] 记录使用: model=%s, session=%s, prompt=%d, completion=%d, total=%d",
		model, sessionKey, promptTokens, completionTokens, totalTokens)
}

// RecordSimple 简单记录 token 使用（按字符数/4 估算）
func (t *TokenTracker) RecordSimple(model, sessionKey, text string) {
	// 简单估算：按字符数/4
	tokens := len(text) / 4
	t.Record(model, sessionKey, 0, tokens)
}

// RecordUsage 从 Usage 结构记录
func (t *TokenTracker) RecordUsage(model, sessionKey string, usage *TokenUsage) {
	if usage == nil {
		return
	}
	t.Record(model, sessionKey, usage.PromptTokens, usage.CompletionTokens)
}

// EstimateFromText 根据文本估算 token 数（按字符数/4）
func EstimateFromText(text string) int {
	return len(text) / 4
}

// GetStats 获取统计信息
func (t *TokenTracker) GetStats() TokenStats {
	t.mu.Lock()
	defer t.mu.Unlock()

	// 复制数据，防止并发问题
	byModel := make(map[string]int64, len(t.byModel))
	for k, v := range t.byModel {
		byModel[k] = v
	}

	bySession := make(map[string]int64, len(t.bySession))
	for k, v := range t.bySession {
		bySession[k] = v
	}

	return TokenStats{
		TotalTokens:      t.total,
		TotalPrompt:      t.totalPrompt,
		TotalCompletion: t.totalCompletion,
		ByModel:          byModel,
		BySession:        bySession,
	}
}

// GetSessionTokens 获取指定会话的 token 使用量
func (t *TokenTracker) GetSessionTokens(sessionKey string) int64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.bySession[sessionKey]
}

// GetModelTokens 获取指定模型的 token 使用量
func (t *TokenTracker) GetModelTokens(model string) int64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.byModel[model]
}
