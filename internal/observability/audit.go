package observability

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// AuditEntry 审计日志条目
type AuditEntry struct {
	Timestamp  string                 `json:"timestamp"`            // 时间戳（ISO 8601）
	SessionKey string                 `json:"session_key"`         // 会话 key
	EventType  string                 `json:"event_type"`          // tool_call, message_in, message_out, session_start, session_end
	ToolName   string                 `json:"tool_name,omitempty"` // 工具名称（仅 tool_call 时）
	ToolInput  map[string]interface{} `json:"tool_input,omitempty"` // 工具输入参数
	ToolOutput string                 `json:"tool_output,omitempty"` // 工具输出结果
	Duration   int64                  `json:"duration_ms,omitempty"` // 执行耗时（毫秒）
	TokenUsage *TokenUsage            `json:"token_usage,omitempty"` // Token 使用量
	Model      string                 `json:"model,omitempty"`      // 模型名称
	Error      string                 `json:"error,omitempty"`      // 错误信息
}

// TokenUsage Token 使用量
type TokenUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// AuditLogger 审计日志记录器
type AuditLogger struct {
	logPath string
	file    *os.File
	mu      sync.Mutex
}

// NewAuditLogger 创建审计日志记录器
func NewAuditLogger(logPath string) (*AuditLogger, error) {
	if logPath == "" {
		logPath = "./data/workspace/memory/audit.jsonl"
	}

	// 确保目录存在
	dir := filepath.Dir(logPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("创建审计日志目录失败: %w", err)
	}

	file, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return nil, fmt.Errorf("打开审计日志文件失败: %w", err)
	}

	logger := &AuditLogger{
		logPath: logPath,
		file:    file,
	}

	log.Printf("[AuditLogger] 审计日志已初始化: %s", logPath)
	return logger, nil
}

// Log 记录审计日志（JSONL 格式，一行一条）
func (l *AuditLogger) Log(entry AuditEntry) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	// 如果文件已关闭，尝试重新打开
	if l.file == nil {
		file, err := os.OpenFile(l.logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			return fmt.Errorf("重新打开审计日志文件失败: %w", err)
		}
		l.file = file
	}

	// 设置时间戳
	if entry.Timestamp == "" {
		entry.Timestamp = time.Now().Format(time.RFC3339)
	}

	// 序列化
	data, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("序列化审计日志失败: %w", err)
	}

	// 写入文件
	if _, err := l.file.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("写入审计日志失败: %w", err)
	}

	// 刷新缓冲区
	l.file.Sync()

	return nil
}

// LogToolCall 记录工具调用审计日志
func (l *AuditLogger) LogToolCall(sessionKey, toolName string, toolInput map[string]interface{}, toolOutput string, durationMs int64) error {
	entry := AuditEntry{
		SessionKey: sessionKey,
		EventType:  "tool_call",
		ToolName:   toolName,
		ToolInput:  toolInput,
		ToolOutput: truncateOutput(toolOutput, 2000), // 限制输出长度
		Duration:   durationMs,
	}
	return l.Log(entry)
}

// LogMessageIn 记录消息输入审计日志
func (l *AuditLogger) LogMessageIn(sessionKey, content string) error {
	entry := AuditEntry{
		SessionKey: sessionKey,
		EventType:  "message_in",
	}
	// 限制内容长度
	if len(content) > 2000 {
		content = content[:2000] + "...(truncated)"
	}
	return l.Log(entry)
}

// LogMessageOut 记录消息输出审计日志
func (l *AuditLogger) LogMessageOut(sessionKey, content string) error {
	entry := AuditEntry{
		SessionKey: sessionKey,
		EventType:  "message_out",
	}
	// 限制内容长度
	if len(content) > 2000 {
		content = content[:2000] + "...(truncated)"
	}
	return l.Log(entry)
}

// LogSessionStart 记录会话开始审计日志
func (l *AuditLogger) LogSessionStart(sessionKey string) error {
	entry := AuditEntry{
		SessionKey: sessionKey,
		EventType:  "session_start",
	}
	return l.Log(entry)
}

// LogSessionEnd 记录会话结束审计日志
func (l *AuditLogger) LogSessionEnd(sessionKey string) error {
	entry := AuditEntry{
		SessionKey: sessionKey,
		EventType:  "session_end",
	}
	return l.Log(entry)
}

// LogTokenUsage 记录 Token 使用审计日志
func (l *AuditLogger) LogTokenUsage(sessionKey, model string, usage *TokenUsage) error {
	entry := AuditEntry{
		SessionKey: sessionKey,
		EventType:  "token_usage",
		Model:      model,
		TokenUsage: usage,
	}
	return l.Log(entry)
}

// Close 关闭审计日志文件
func (l *AuditLogger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.file != nil {
		err := l.file.Close()
		l.file = nil
		return err
	}
	return nil
}

// truncateOutput 截断输出
func truncateOutput(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "...(truncated)"
}
