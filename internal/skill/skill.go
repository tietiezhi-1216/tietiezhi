package skill

// Skill 技能接口
type Skill interface {
	// Name 技能名称
	Name() string
	// Description 技能描述
	Description() string
	// Tools 技能提供的工具列表
	Tools() []string
}

// Registry 技能注册表
type Registry struct {
	skills map[string]Skill
}

// NewRegistry 创建技能注册表
func NewRegistry() *Registry {
	return &Registry{
		skills: make(map[string]Skill),
	}
}

// Register 注册技能
func (r *Registry) Register(s Skill) {
	r.skills[s.Name()] = s
}

// Get 获取技能
func (r *Registry) Get(name string) (Skill, bool) {
	s, ok := r.skills[name]
	return s, ok
}
