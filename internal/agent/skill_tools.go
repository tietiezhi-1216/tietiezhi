package agent

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"tietiezhi/internal/llm"
	"tietiezhi/internal/mcp"
	"tietiezhi/internal/skill"
)

// LoadedSkill 已加载的技能状态
type LoadedSkill struct {
	SkillDef     *skill.SkillDef
	MCPTools     []llm.ToolDef  // MCP 工具列表（带 mcp__ 前缀）
	SystemPrompt string        // 技能注入的 system prompt
}

// GetSkillTools 获取技能相关工具定义
// 如果有可用技能，返回 skill_load 工具；否则返回 nil
func GetSkillTools(loader *skill.Loader) []llm.ToolDef {
	if loader == nil {
		return nil
	}
	
	skills := loader.GetAvailableSkills()
	if len(skills) == 0 {
		return nil
	}
	
	// 生成 skill_load 工具描述
	desc := "加载指定技能。加载后会注入技能知识和相关工具到当前对话。可用技能：\n"
	var skillLines []string
	for _, s := range skills {
		skillLines = append(skillLines, fmt.Sprintf("  - %s: %s", s.Name, s.Description))
	}
	desc += strings.Join(skillLines, "\n")
	
	return []llm.ToolDef{
		{
			Type: "function",
			Function: llm.FunctionDef{
				Name:        "skill_load",
				Description: desc,
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"skill_name": map[string]any{
							"type":        "string",
							"description": "要加载的技能名称",
						},
					},
					"required": []string{"skill_name"},
				},
			},
		},
	}
}

// GetMCPTools 获取已加载的 MCP 工具列表
func GetMCPTools(mcpMgr *mcp.MCPManager) []llm.ToolDef {
	if mcpMgr == nil {
		return nil
	}
	
	mcpTools := mcpMgr.GetTools()
	if len(mcpTools) == 0 {
		return nil
	}
	
	var tools []llm.ToolDef
	for _, t := range mcpTools {
		// 工具名格式：mcp__{server}__{tool}
		toolName := fmt.Sprintf("mcp__%s", t.Name)
		
		// 转换 inputSchema 为 parameters
		var params any
		if t.InputSchema != nil {
			params = t.InputSchema
		} else {
			params = map[string]any{
				"type": "object",
				"properties": map[string]any{},
			}
		}
		
		tools = append(tools, llm.ToolDef{
			Type: "function",
			Function: llm.FunctionDef{
				Name:        toolName,
				Description: t.Description,
				Parameters:  params,
			},
		})
	}
	
	return tools
}

// LoadSkill 加载技能（skill_load 工具执行逻辑）
// 返回：注入的 system prompt，已加载的 MCP 工具列表，错误
func LoadSkill(loader *skill.Loader, mcpMgr *mcp.MCPManager, skillName string) (string, []llm.ToolDef, error) {
	if loader == nil {
		return "", nil, fmt.Errorf("技能加载器未初始化")
	}
	
	skillDef := loader.GetSkill(skillName)
	if skillDef == nil {
		return "", nil, fmt.Errorf("技能不存在: %s", skillName)
	}
	
	log.Printf("正在加载技能: %s", skillName)
	
	// 注入技能内容到 system prompt
	var injectedPrompt string
	if skillDef.Content != "" {
		injectedPrompt = fmt.Sprintf("\n\n## 技能知识: %s\n\n%s", skillDef.Name, skillDef.Content)
	}
	
	// 连接 MCP 服务器（如果有）
	var mcptools []llm.ToolDef
	if len(skillDef.MCPServers) > 0 && mcpMgr != nil {
		if err := mcpMgr.Connect(skillDef); err != nil {
			log.Printf("技能 %s 的 MCP 连接失败: %v", skillName, err)
			// MCP 失败不影响技能加载
		} else {
			// 获取 MCP 工具
			mcptools = GetMCPTools(mcpMgr)
			log.Printf("技能 %s 加载完成，MCP 工具数: %d", skillName, len(mcptools))
		}
	} else {
		log.Printf("技能 %s 加载完成（无 MCP 依赖）", skillName)
	}
	
	return injectedPrompt, mcptools, nil
}

// ExecuteSkillLoad 执行 skill_load 工具
func ExecuteSkillLoad(argsJSON string, loader *skill.Loader, mcpMgr *mcp.MCPManager, loadedSkills map[string]*LoadedSkill) string {
	var args struct {
		SkillName string `json:"skill_name"`
	}
	
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return fmt.Sprintf(`{"error": "参数解析失败: %v"}`, err)
	}
	
	if args.SkillName == "" {
		return `{"error": "skill_name 不能为空"}`
	}
	
	// 检查是否已加载
	if _, exists := loadedSkills[args.SkillName]; exists {
		return fmt.Sprintf(`{"success": true, "message": "技能 %s 已加载", "already_loaded": true}`, args.SkillName)
	}
	
	// 加载技能
	injectedPrompt, mcptools, err := LoadSkill(loader, mcpMgr, args.SkillName)
	if err != nil {
		return fmt.Sprintf(`{"error": "加载技能失败: %s"}`, err.Error())
	}
	
	// 获取技能定义
	skillDef := loader.GetSkill(args.SkillName)
	if skillDef == nil {
		return `{"error": "技能定义获取失败"}`
	}
	
	// 记录已加载状态
	loadedSkills[args.SkillName] = &LoadedSkill{
		SkillDef:     skillDef,
		MCPTools:     mcptools,
		SystemPrompt: injectedPrompt,
	}
	
	result := map[string]any{
		"success":       true,
		"skill_name":    args.SkillName,
		"description":   skillDef.Description,
		"has_mcp_tools": len(mcptools) > 0,
		"mcp_tool_count": len(mcptools),
	}
	
	if len(mcptools) > 0 {
		var toolNames []string
		for _, t := range mcptools {
			toolNames = append(toolNames, t.Function.Name)
		}
		result["mcp_tools"] = toolNames
	}
	
	resultJSON, _ := json.Marshal(result)
	return string(resultJSON)
}

// ExecuteMCPToolCall 执行 MCP 工具调用
func ExecuteMCPToolCall(call llm.ToolCall, mcpMgr *mcp.MCPManager) string {
	toolName := call.Function.Name
	argsJSON := call.Function.Arguments
	
	// 解析参数
	var args map[string]interface{}
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		args = make(map[string]interface{})
	}
	
	// 调用 MCP 工具
	result, err := mcpMgr.CallTool(toolName, args)
	if err != nil {
		return fmt.Sprintf(`{"error": "调用 MCP 工具失败: %s"}`, err.Error())
	}
	
	// 如果结果是纯文本或空，包装为 JSON
	if result == "" {
		return `{"success": true, "result": ""}`
	}
	
	// 尝试解析为 JSON
	var jsonResult interface{}
	if err := json.Unmarshal([]byte(result), &jsonResult); err != nil {
		// 不是 JSON，直接返回
		return result
	}
	
	return result
}

// GetLoadedSkillPrompts 获取所有已加载技能的 system prompt
func GetLoadedSkillPrompts(loadedSkills map[string]*LoadedSkill) string {
	if len(loadedSkills) == 0 {
		return ""
	}
	
	var prompts []string
	for _, ls := range loadedSkills {
		if ls.SystemPrompt != "" {
			prompts = append(prompts, ls.SystemPrompt)
		}
	}
	
	if len(prompts) == 0 {
		return ""
	}
	
	return strings.Join(prompts, "\n")
}

// GetAllLoadedMCPTools 获取所有已加载技能的 MCP 工具
func GetAllLoadedMCPTools(loadedSkills map[string]*LoadedSkill) []llm.ToolDef {
	var allTools []llm.ToolDef
	seen := make(map[string]bool)
	
	for _, ls := range loadedSkills {
		for _, tool := range ls.MCPTools {
			if !seen[tool.Function.Name] {
				allTools = append(allTools, tool)
				seen[tool.Function.Name] = true
			}
		}
	}
	
	return allTools
}
