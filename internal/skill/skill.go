package skill

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// SkillDef 技能定义
type SkillDef struct {
	Name        string                      // 技能名称（来自 SKILL.md frontmatter）
	Description string                      // 技能描述（来自 SKILL.md frontmatter）
	Content     string                      // SKILL.md 正文（frontmatter 之后的内容）
	DirPath     string                      // 技能目录绝对路径
	MCPServers  map[string]MCPServerConfig  // 从 mcp.json 读取，可能为空
	AllowedTools []string                   // 允许的工具白名单（来自 frontmatter 的 tools 字段）
}

// MCPServerConfig MCP 服务器配置（对应 mcp.json 中的每个 server）
type MCPServerConfig struct {
	Command string            `json:"command"` // 启动命令，如 "npx"
	Args    []string          `json:"args"`    // 命令参数
	Env     map[string]string `json:"env"`    // 环境变量
}

// MCPServersConfig MCP 服务器配置集合（对应完整的 mcp.json）
type MCPServersConfig struct {
	MCPServers map[string]MCPServerConfig `json:"mcpServers"`
}

// ParseSkill 解析技能目录，返回技能定义
// 解析 SKILL.md 的 frontmatter 和正文，以及可选的 mcp.json
func ParseSkill(dirPath string) (*SkillDef, error) {
	skillMDPath := filepath.Join(dirPath, "SKILL.md")

	// 读取 SKILL.md
	data, err := os.ReadFile(skillMDPath)
	if err != nil {
		return nil, fmt.Errorf("读取 SKILL.md 失败: %w", err)
	}

	content := string(data)

	// 解析 frontmatter
	name, desc, body, allowedTools, err := parseFrontmatter(content)
	if err != nil {
		return nil, fmt.Errorf("解析 frontmatter 失败: %w", err)
	}

	skill := &SkillDef{
		Name:         name,
		Description:  desc,
		Content:      strings.TrimSpace(body), // 去掉首尾空白
		DirPath:      dirPath,
		MCPServers:   make(map[string]MCPServerConfig),
		AllowedTools: allowedTools,
	}

	// 尝试读取 mcp.json（可选）
	mcpJSONPath := filepath.Join(dirPath, "mcp.json")
	if mcpData, err := os.ReadFile(mcpJSONPath); err == nil {
		var config MCPServersConfig
		if err := json.Unmarshal(mcpData, &config); err != nil {
			return nil, fmt.Errorf("解析 mcp.json 失败: %w", err)
		}
		skill.MCPServers = config.MCPServers
	}

	return skill, nil
}

// parseFrontmatter 解析 YAML frontmatter
// 返回: name, description, body(正文), allowedTools, error
func parseFrontmatter(content string) (name, description, body string, allowedTools []string, err error) {
	// 检查是否有 frontmatter
	if !strings.HasPrefix(content, "---") {
		return "", "", content, nil, fmt.Errorf("SKILL.md 缺少 frontmatter")
	}

	// 找到第二个 --- 的位置
	lines := strings.SplitN(content, "\n", -1)
	if len(lines) < 3 {
		return "", "", content, nil, fmt.Errorf("frontmatter 格式错误")
	}

	frontmatterEnd := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			frontmatterEnd = i
			break
		}
	}

	if frontmatterEnd == -1 {
		return "", "", content, nil, fmt.Errorf("frontmatter 未闭合")
	}

	// 解析 frontmatter 行
	var frontmatterLines []string
	for i := 1; i < frontmatterEnd; i++ {
		frontmatterLines = append(frontmatterLines, lines[i])
	}

	for _, line := range frontmatterLines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "name:") {
			name = strings.TrimSpace(strings.TrimPrefix(line, "name:"))
		} else if strings.HasPrefix(line, "description:") {
			description = strings.TrimSpace(strings.TrimPrefix(line, "description:"))
		} else if strings.HasPrefix(line, "tools:") {
			// 解析 tools 字段（支持单行和多行格式）
			toolsContent := strings.TrimSpace(strings.TrimPrefix(line, "tools:"))
			
			// 如果是单行格式（如 "tools: [tool1, tool2]"）
			if strings.HasPrefix(toolsContent, "[") {
				allowedTools = parseToolsArray(toolsContent)
			} else if toolsContent != "" {
				// 单个工具名
				allowedTools = append(allowedTools, toolsContent)
			}
		}
	}

	if name == "" {
		return "", "", "", nil, fmt.Errorf("frontmatter 缺少 name 字段")
	}

	// 正文是 frontmatter 之后的内容
	bodyLines := lines[frontmatterEnd+1:]
	// 跳过开头的空行
	startIdx := 0
	for startIdx < len(bodyLines) && strings.TrimSpace(bodyLines[startIdx]) == "" {
		startIdx++
	}
	body = strings.Join(bodyLines[startIdx:], "\n")

	return name, description, body, allowedTools, nil
}

// parseToolsArray 解析 tools 数组
func parseToolsArray(content string) []string {
	// 去掉 [ 和 ]
	content = strings.TrimPrefix(content, "[")
	content = strings.TrimSuffix(content, "]")
	content = strings.TrimSpace(content)

	if content == "" {
		return nil
	}

	// 按逗号分割
	parts := strings.Split(content, ",")
	var tools []string
	for _, part := range parts {
		tool := strings.TrimSpace(part)
		tool = strings.Trim(tool, "'\"")
		if tool != "" {
			tools = append(tools, tool)
		}
	}
	return tools
}

// HasAllowedTools 检查是否有工具白名单限制
func (s *SkillDef) HasAllowedTools() bool {
	return len(s.AllowedTools) > 0
}
