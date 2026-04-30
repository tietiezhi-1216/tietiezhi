package workspace

import "fmt"

// Workspace 工作区
type Workspace struct {
	ID      string
	Name    string
	BaseDir string
}

// Manager 工作区管理器
type Manager struct {
	workspaces map[string]*Workspace
	baseDir    string
}

// NewManager 创建工作区管理器
func NewManager(baseDir string) *Manager {
	return &Manager{
		workspaces: make(map[string]*Workspace),
		baseDir:    baseDir,
	}
}

// Create 创建工作区
func (m *Manager) Create(id, name string) (*Workspace, error) {
	ws := &Workspace{
		ID:      id,
		Name:    name,
		BaseDir: fmt.Sprintf("%s/%s", m.baseDir, id),
	}
	m.workspaces[id] = ws
	return ws, nil
}

// Get 获取工作区
func (m *Manager) Get(id string) (*Workspace, bool) {
	ws, ok := m.workspaces[id]
	return ws, ok
}
