package skill

import (
	"fmt"
	"os"
	"path/filepath"
)

// Loader 技能加载器（Anthropic MD 规范）
type Loader struct {
	skillDir string
}

// NewLoader 创建技能加载器
func NewLoader(skillDir string) *Loader {
	return &Loader{skillDir: skillDir}
}

// LoadAll 加载所有技能
func (l *Loader) LoadAll() ([]Skill, error) {
	// 技能包结构参考 Anthropic MD 规范：
	// skill-name/
	//   SKILL.md          # 技能主文件
	//   references/       # 参考文档
	//   scripts/          # 脚本文件
	entries, err := os.ReadDir(l.skillDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil // 目录不存在，返回空列表
		}
		return nil, fmt.Errorf("读取技能目录失败: %w", err)
	}

	var skills []Skill
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		skillPath := filepath.Join(l.skillDir, entry.Name())
		skill, err := l.loadOne(skillPath)
		if err != nil {
			return nil, fmt.Errorf("加载技能 %s 失败: %w", entry.Name(), err)
		}
		skills = append(skills, skill)
	}
	return skills, nil
}

// loadOne 加载单个技能包
func (l *Loader) loadOne(path string) (Skill, error) {
	// TODO: 解析 SKILL.md，提取技能信息
	return nil, fmt.Errorf("技能加载尚未实现")
}
