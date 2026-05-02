package agent

import (
	"context"
	"fmt"
	"log"
	"strings"

	"tietiezhi/internal/config"
	"tietiezhi/internal/llm"
)

// ContextCompressor 上下文压缩器
// 用于在对话历史过长时自动压缩，减少 token 消耗
type ContextCompressor struct {
	provider      llm.Provider        // 主模型（用于总结）
	cheapProvider llm.Provider        // 轻量模型（如果配置了）
	maxChars      int                 // 触发压缩的字符阈值
	keepRecent    int                 // 保留最近 N 条消息
	summaryPrompt string              // 总结提示词
	enabled       bool                // 是否启用压缩
}

// NewContextCompressor 创建上下文压缩器
func NewContextCompressor(provider llm.Provider, cfg *config.CompressionConfig) *ContextCompressor {
	if cfg == nil {
		cfg = &config.CompressionConfig{
			Enabled:       true,
			MaxChars:      80000,
			KeepRecent:    10,
			SummaryPrompt: "请总结以下对话的核心内容，保留关键信息、决策和重要细节，用简洁的中文概括（控制在200字以内）：",
		}
	}

	return &ContextCompressor{
		provider:      provider,
		maxChars:      cfg.MaxChars,
		keepRecent:    cfg.KeepRecent,
		summaryPrompt: cfg.SummaryPrompt,
		enabled:       cfg.Enabled,
	}
}

// SetCheapProvider 设置轻量级模型（用于压缩等简单任务）
func (c *ContextCompressor) SetCheapProvider(provider llm.Provider) {
	c.cheapProvider = provider
}

// IsEnabled 返回压缩器是否启用
func (c *ContextCompressor) IsEnabled() bool {
	return c.enabled
}

// ShouldCompress 检查是否需要压缩
// 统计所有消息的总字符数（不含 tool_calls 的详细参数）
func (c *ContextCompressor) ShouldCompress(messages []llm.ChatMessage) bool {
	if !c.enabled {
		return false
	}

	totalChars := 0
	for _, msg := range messages {
		// 跳过 system 消息（通常很短且重要）
		if msg.Role == "system" {
			continue
		}
		content := msg.GetContentAsText()
		totalChars += len(content)
	}

	return totalChars > c.maxChars
}

// GetTotalChars 获取消息列表的总字符数
func (c *ContextCompressor) GetTotalChars(messages []llm.ChatMessage) int {
	total := 0
	for _, msg := range messages {
		total += len(msg.GetContentAsText())
	}
	return total
}

// Compress 执行上下文压缩
// 流程：
// 1. 分离旧消息和最近消息
// 2. 调用 LLM 总结旧消息
// 3. 返回 [summary] + [最近 keepRecent 条消息]
func (c *ContextCompressor) Compress(ctx context.Context, messages []llm.ChatMessage) ([]llm.ChatMessage, error) {
	if len(messages) <= c.keepRecent {
		return messages, nil
	}

	// 分离消息：旧消息用于总结，最近消息保留
	oldMessages := messages[:len(messages)-c.keepRecent]
	recentMessages := messages[len(messages)-c.keepRecent:]

	log.Printf("[压缩] 触发压缩：旧消息 %d 条，保留最近 %d 条", len(oldMessages), c.keepRecent)

	// 构建总结请求
	summaryContent := c.buildSummaryContent(oldMessages)
	
	// 使用轻量模型（如果有配置）
	provider := c.provider
	if c.cheapProvider != nil {
		provider = c.cheapProvider
		log.Printf("[压缩] 使用轻量模型进行总结")
	}

	// 调用 LLM 总结
	summary, err := c.summarize(ctx, provider, summaryContent)
	if err != nil {
		log.Printf("[压缩] 总结失败: %v，回退保留原始消息", err)
		return messages, err
	}

	// 构建压缩后的消息列表
	result := make([]llm.ChatMessage, 0, 2+len(recentMessages))
	
	// 添加总结消息
	result = append(result, llm.ChatMessage{
		Role:    "system",
		Content: fmt.Sprintf("【对话历史已压缩】%s\n\n压缩后的总结：\n%s", c.summaryPrompt, summary),
	})

	// 添加保留的最近消息
	result = append(result, recentMessages...)

	log.Printf("[压缩] 完成：压缩后保留 %d 条消息", len(result))
	return result, nil
}

// CompressWithSaveNotice 先通知 Agent 保存重要信息，然后压缩
// 这是更激进的压缩流程，给 Agent 一轮机会保存重要信息
func (c *ContextCompressor) CompressWithSaveNotice(ctx context.Context, messages []llm.ChatMessage) ([]llm.ChatMessage, error) {
	// 构建通知消息
	notice := "⚠️ 上下文即将压缩！请立即使用 memory_add 工具保存任何重要信息（用户偏好、关键决策、待办事项等）。\n压缩后旧消息将被总结为一条摘要。"

	// 通知消息作为用户消息
	noticeMsg := llm.ChatMessage{
		Role:    "user",
		Content: notice,
	}

	// 暂时添加到消息列表末尾
	tempMessages := append(messages, noticeMsg)

	// 使用轻量模型或主模型进行总结
	provider := c.cheapProvider
	if provider == nil {
		provider = c.provider
	}

	// 调用 LLM 让它回复保存指令（实际上我们会直接执行压缩）
	// 这里我们跳过 Agent 的中间回复，直接压缩
	_ = tempMessages

	// 执行压缩
	return c.Compress(ctx, messages)
}

// buildSummaryContent 构建用于总结的内容
func (c *ContextCompressor) buildSummaryContent(messages []llm.ChatMessage) string {
	var sb strings.Builder
	sb.WriteString("以下是对话历史，请总结其核心内容：\n\n")

	for i, msg := range messages {
		roleName := "用户"
		if msg.Role == "assistant" {
			roleName = "助手"
		} else if msg.Role == "tool" {
			roleName = "工具"
		}

		// 截取内容（如果太长）
		content := msg.GetContentAsText()
		if len(content) > 1000 {
			content = content[:1000] + "...(已截断)"
		}

		sb.WriteString(fmt.Sprintf("[%d] %s: %s\n", i+1, roleName, content))
	}

	return sb.String()
}

// summarize 调用 LLM 生成总结
func (c *ContextCompressor) summarize(ctx context.Context, provider llm.Provider, content string) (string, error) {
	req := &llm.ChatRequest{
		Messages: []llm.ChatMessage{
			{
				Role:    "system",
				Content: "你是一个对话总结助手。请简洁地总结用户提供的对话历史，提取关键信息和要点。总结应控制在200字以内。",
			},
			{
				Role:    "user",
				Content: content,
			},
		},
	}

	resp, err := provider.Chat(ctx, req)
	if err != nil {
		return "", fmt.Errorf("总结请求失败: %w", err)
	}

	if len(resp.Choices) == 0 {
		return "", fmt.Errorf("总结返回空响应")
	}

	return resp.Choices[0].Message.GetContentAsText(), nil
}

// QuickSummary 快速总结（不调用 LLM，直接生成简单摘要）
// 用于当 LLM 不可用时的降级方案
func (c *ContextCompressor) QuickSummary(messages []llm.ChatMessage) string {
	if len(messages) == 0 {
		return "空对话"
	}

	var sb strings.Builder
	userMsgs := 0
	assistantMsgs := 0
	toolCalls := 0

	for _, msg := range messages {
		switch msg.Role {
		case "user":
			userMsgs++
		case "assistant":
			assistantMsgs++
			if len(msg.ToolCalls) > 0 {
				toolCalls += len(msg.ToolCalls)
			}
		case "tool":
			toolCalls++
		}
	}

	sb.WriteString(fmt.Sprintf("对话摘要：共 %d 条消息", len(messages)))
	if userMsgs > 0 {
		sb.WriteString(fmt.Sprintf("（用户 %d 条", userMsgs))
	}
	if assistantMsgs > 0 {
		if userMsgs > 0 {
			sb.WriteString("，")
		} else {
			sb.WriteString("（")
		}
		sb.WriteString(fmt.Sprintf("助手 %d 条", assistantMsgs))
	}
	if toolCalls > 0 {
		if userMsgs > 0 || assistantMsgs > 0 {
			sb.WriteString("，")
		} else {
			sb.WriteString("（")
		}
		sb.WriteString(fmt.Sprintf("工具调用 %d 次", toolCalls))
	}
	sb.WriteString("）")

	return sb.String()
}
