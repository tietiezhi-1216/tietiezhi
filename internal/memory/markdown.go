package memory

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// MarkdownMemory Markdown 文件记忆实现
// 参考 OpenClaw 的 MEMORY.md / SOUL.md / USER.md 方案
type MarkdownMemory struct {
	baseDir string
}

// NewMarkdownMemory 创建 Markdown 记忆
func NewMarkdownMemory(baseDir string) *MarkdownMemory {
	return &MarkdownMemory{baseDir: baseDir}
}

// Load 加载记忆文件
func (m *MarkdownMemory) Load(ctx context.Context, key string) (string, error) {
	path := filepath.Join(m.baseDir, key+".md")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", fmt.Errorf("读取记忆文件失败: %w", err)
	}
	return string(data), nil
}

// Save 保存记忆文件
func (m *MarkdownMemory) Save(ctx context.Context, key string, content string) error {
	path := filepath.Join(m.baseDir, key+".md")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("创建记忆目录失败: %w", err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return fmt.Errorf("写入记忆文件失败: %w", err)
	}
	return nil
}

// Search 简单关键词搜索记忆
func (m *MarkdownMemory) Search(ctx context.Context, query string) ([]string, error) {
	var results []string
	entries, err := os.ReadDir(m.baseDir)
	if err != nil {
		return nil, fmt.Errorf("读取记忆目录失败: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(m.baseDir, entry.Name()))
		if err != nil {
			continue
		}
		if strings.Contains(string(data), query) {
			results = append(results, string(data))
		}
	}
	return results, nil
}
