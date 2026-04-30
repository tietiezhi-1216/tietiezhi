package memory

import "context"

// Memory 记忆接口
type Memory interface {
	// Load 加载记忆
	Load(ctx context.Context, key string) (string, error)
	// Save 保存记忆
	Save(ctx context.Context, key string, content string) error
	// Search 搜索记忆
	Search(ctx context.Context, query string) ([]string, error)
}
