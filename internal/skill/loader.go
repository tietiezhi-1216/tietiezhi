package skill

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// Loader 技能加载器
type Loader struct {
	skillDir string
	skills   map[string]*SkillDef // name -> SkillDef
}

// NewLoader 创建技能加载器
func NewLoader(skillDir string) *Loader {
	return &Loader{
		skillDir: skillDir,
		skills:   make(map[string]*SkillDef),
	}
}

// LoadAll 加载所有技能
func (l *Loader) LoadAll() error {
	// 确保目录存在
	if err := os.MkdirAll(l.skillDir, 0755); err != nil {
		return fmt.Errorf("创建技能目录失败: %w", err)
	}
	
	entries, err := os.ReadDir(l.skillDir)
	if err != nil {
		return fmt.Errorf("读取技能目录失败: %w", err)
	}
	
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		
		skillPath := filepath.Join(l.skillDir, entry.Name())
		skill, err := ParseSkill(skillPath)
		if err != nil {
			log.Printf("加载技能 %s 失败: %v，跳过", entry.Name(), err)
			continue
		}
		
		l.skills[skill.Name] = skill
		log.Printf("技能加载成功: %s (%s)", skill.Name, skill.Description)
	}
	
	log.Printf("技能系统初始化完成，共加载 %d 个技能", len(l.skills))
	return nil
}

// GetSkill 获取指定名称的技能
func (l *Loader) GetSkill(name string) *SkillDef {
	return l.skills[name]
}

// GetAllSkills 获取所有已加载的技能
func (l *Loader) GetAllSkills() []*SkillDef {
	var skills []*SkillDef
	for _, s := range l.skills {
		skills = append(skills, s)
	}
	return skills
}

// GetAvailableSkills 返回可用技能列表（用于生成 skill_load 工具描述）
func (l *Loader) GetAvailableSkills() []*SkillDef {
	return l.GetAllSkills()
}

// SkillDir 返回技能目录路径
func (l *Loader) SkillDir() string {
	return l.skillDir
}
