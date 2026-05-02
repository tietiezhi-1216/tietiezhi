package memory

import (
	"fmt"
	"sync"
	"time"
)

// Snapshot 记忆快照
// 用于实现 Prompt Caching，session 开始时快照记忆上下文
type Snapshot struct {
	Content   string
	CreatedAt time.Time
}

// SnapshotManager 快照管理器
// 管理所有会话的记忆快照，支持并发访问
type SnapshotManager struct {
	snapshots map[string]*Snapshot
	mu        sync.RWMutex
}

// NewSnapshotManager 创建快照管理器
func NewSnapshotManager() *SnapshotManager {
	return &SnapshotManager{
		snapshots: make(map[string]*Snapshot),
	}
}

// TakeSnapshot 为指定会话创建快照
// sessionKey: 会话唯一标识
// mm: 记忆管理器，用于获取当前记忆内容
// isGroup: 是否是群聊
func (m *SnapshotManager) TakeSnapshot(sessionKey string, mm *MemoryManager, isGroup bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// 构建当前记忆上下文
	content := mm.BuildMemoryContext(isGroup)

	m.snapshots[sessionKey] = &Snapshot{
		Content:   content,
		CreatedAt: time.Now(),
	}
}

// GetSnapshot 获取快照
// 如果快照不存在，返回空字符串
func (m *SnapshotManager) GetSnapshot(sessionKey string) *Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.snapshots[sessionKey]
}

// GetSnapshotContent 获取快照内容
// 简化版，返回字符串而非结构体
func (m *SnapshotManager) GetSnapshotContent(sessionKey string) string {
	snapshot := m.GetSnapshot(sessionKey)
	if snapshot == nil {
		return ""
	}
	return snapshot.Content
}

// Invalidate 使快照失效
// 在以下场景调用：
// - 会话结束
// - 上下文压缩
// - 用户主动清空会话
func (m *SnapshotManager) Invalidate(sessionKey string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.snapshots, sessionKey)
}

// InvalidateAll 使所有快照失效
func (m *SnapshotManager) InvalidateAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.snapshots = make(map[string]*Snapshot)
}

// HasSnapshot 检查是否存在快照
func (m *SnapshotManager) HasSnapshot(sessionKey string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.snapshots[sessionKey]
	return ok
}

// GetSnapshotCount 获取快照数量
func (m *SnapshotManager) GetSnapshotCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.snapshots)
}

// GetSnapshotAge 获取快照创建时间
func (m *SnapshotManager) GetSnapshotAge(sessionKey string) (time.Duration, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	snapshot, ok := m.snapshots[sessionKey]
	if !ok {
		return 0, false
	}
	return time.Since(snapshot.CreatedAt), true
}

// RefreshSnapshot 刷新快照
// 当需要更新快照时调用
func (m *SnapshotManager) RefreshSnapshot(sessionKey string, mm *MemoryManager, isGroup bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	content := mm.BuildMemoryContext(isGroup)
	m.snapshots[sessionKey] = &Snapshot{
		Content:   content,
		CreatedAt: time.Now(),
	}
}

// CleanupOldSnapshots 清理过期快照
// 保留超过 maxAge 的快照将被删除
func (m *SnapshotManager) CleanupOldSnapshots(maxAge time.Duration) int {
	m.mu.Lock()
	defer m.mu.Unlock()

	count := 0
	now := time.Now()
	for key, snapshot := range m.snapshots {
		if now.Sub(snapshot.CreatedAt) > maxAge {
			delete(m.snapshots, key)
			count++
		}
	}
	return count
}

// GetSnapshotInfo 获取快照信息（用于调试）
func (m *SnapshotManager) GetSnapshotInfo() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	info := make(map[string]interface{})
	info["count"] = len(m.snapshots)
	snapshots := make([]map[string]interface{}, 0, len(m.snapshots))
	for key, s := range m.snapshots {
		snapshots = append(snapshots, map[string]interface{}{
			"session_key": key,
			"content_len": len(s.Content),
			"created_at":  s.CreatedAt.Format(time.RFC3339),
		})
	}
	info["snapshots"] = snapshots
	return info
}

// SnapshotAwareMemoryManager 快照感知的记忆管理器包装
// 提供带快照功能的记忆管理接口
type SnapshotAwareMemoryManager struct {
	*MemoryManager
	*SnapshotManager
}

// NewSnapshotAwareMemoryManager 创建快照感知记忆管理器
func NewSnapshotAwareMemoryManager(workspacePath string) *SnapshotAwareMemoryManager {
	return &SnapshotAwareMemoryManager{
		MemoryManager:   NewMemoryManager(workspacePath),
		SnapshotManager: NewSnapshotManager(),
	}
}

// TakeSessionSnapshot 为会话创建快照
func (m *SnapshotAwareMemoryManager) TakeSessionSnapshot(sessionKey string, isGroup bool) {
	m.SnapshotManager.TakeSnapshot(sessionKey, m.MemoryManager, isGroup)
}

// InvalidateSessionSnapshot 使会话快照失效
func (m *SnapshotAwareMemoryManager) InvalidateSessionSnapshot(sessionKey string) {
	m.SnapshotManager.Invalidate(sessionKey)
}

// GetSessionSnapshot 获取会话快照内容
func (m *SnapshotAwareMemoryManager) GetSessionSnapshot(sessionKey string) string {
	return m.SnapshotManager.GetSnapshotContent(sessionKey)
}

// BuildSnapshotAwareContext 构建带快照的上下文
// 优先使用快照，如果快照不存在则实时构建
func (m *SnapshotAwareMemoryManager) BuildSnapshotAwareContext(sessionKey string, isGroup bool) string {
	// 优先使用快照
	snapshot := m.SnapshotManager.GetSnapshot(sessionKey)
	if snapshot != nil {
		return snapshot.Content
	}

	// 如果没有快照，实时构建并创建快照
	content := m.MemoryManager.BuildMemoryContext(isGroup)
	m.SnapshotManager.TakeSnapshot(sessionKey, m.MemoryManager, isGroup)
	return content
}

// String 返回快照管理器描述
func (m *SnapshotManager) String() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return fmt.Sprintf("SnapshotManager{snapshots=%d}", len(m.snapshots))
}
