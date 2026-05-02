package agent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"tietiezhi/internal/memory"
)

// skillArgs skill_save 工具参数
type skillArgs struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Content     string   `json:"content"`
	Tags        []string `json:"tags"`
}

// ExecuteSkillSave 执行 skill_save 工具
// 将技能保存到 workspace/skills/{name}/SKILL.md
func ExecuteSkillSave(argsJSON string, mm *memory.MemoryManager) string {
	var args skillArgs

	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return fmt.Sprintf(`{"error": "参数解析失败: %v"}`, err)
	}

	// 验证参数
	if args.Name == "" {
		return `{"error": "技能名称不能为空"}`
	}
	if args.Description == "" {
		return `{"error": "技能描述不能为空"}`
	}
	if args.Content == "" {
		return `{"error": "技能内容不能为空"}`
	}

	// 获取工作区路径
	workspacePath := "./data/workspace"
	if mm != nil {
		workspacePath = mm.GetWorkspacePath()
	}

	// 构建技能目录路径
	skillDir := filepath.Join(workspacePath, "skills", args.Name)
	if err := os.MkdirAll(skillDir, 0755); err != nil {
		return fmt.Sprintf(`{"error": "创建技能目录失败: %s"}`, err.Error())
	}

	// 构建 SKILL.md 内容
	skillMD := buildSkillMarkdown(args)

	// 写入文件
	skillFile := filepath.Join(skillDir, "SKILL.md")
	if err := os.WriteFile(skillFile, []byte(skillMD), 0644); err != nil {
		return fmt.Sprintf(`{"error": "写入技能文件失败: %s"}`, err.Error())
	}

	result := map[string]interface{}{
		"success":    true,
		"skill_name": args.Name,
		"skill_path": skillFile,
		"message":    fmt.Sprintf("技能 %s 已保存", args.Name),
	}

	resultJSON, _ := json.Marshal(result)
	return string(resultJSON)
}

// buildSkillMarkdown 构建技能 Markdown 内容
func buildSkillMarkdown(args skillArgs) string {
	// 构建 tags 部分
	var tagsStr string
	if len(args.Tags) > 0 {
		tagsStr = fmt.Sprintf("tags: [%s]", strings.Join(args.Tags, ", "))
	} else {
		tagsStr = "tags: []"
	}

	// 组装完整内容
	skillMD := fmt.Sprintf(`---
name: %s
description: %s
%s
---

%s
`, args.Name, args.Description, tagsStr, args.Content)

	return skillMD
}
