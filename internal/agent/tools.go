package agent

import (
	"encoding/json"
	"strings"

	"tietiezhi/internal/llm"
	"tietiezhi/internal/memory"
	"tietiezhi/internal/tool/builtin"
)

// 终端工具实例（全局单例，用于沙箱支持）
var terminalToolInstance *builtin.TerminalTool

// SetTerminalTool 设置终端工具实例
func SetTerminalTool(t *builtin.TerminalTool) {
	terminalToolInstance = t
}

// GetTerminalTool 获取终端工具实例
func GetTerminalTool() *builtin.TerminalTool {
	return terminalToolInstance
}

// GetMemoryTools 获取记忆相关工具定义
func GetMemoryTools() []llm.ToolDef {
	return []llm.ToolDef{
		{
			Type: "function",
			Function: llm.FunctionDef{
				Name:        "memory_add",
				Description: "将内容写入记忆文件。用于记录重要信息、偏好、决策等需要持久化的内容。",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"content": map[string]any{
							"type":        "string",
							"description": "要记住的内容",
						},
						"memory_type": map[string]any{
							"type":        "string",
							"enum":        []string{"daily", "longterm", "identity", "user", "soul"},
							"description": "记忆类型：daily=每日笔记（默认追加），longterm=长期记忆（重要偏好和决策），identity=身份信息，user=用户信息，soul=灵魂设定",
						},
					},
					"required": []string{"content"},
				},
			},
		},
		{
			Type: "function",
			Function: llm.FunctionDef{
				Name:        "memory_search",
				Description: "搜索记忆文件中的相关内容。当你需要回忆之前记录的信息时使用。",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"query": map[string]any{
							"type":        "string",
							"description": "搜索关键词",
						},
					},
					"required": []string{"query"},
				},
			},
		},
		{
			Type: "function",
			Function: llm.FunctionDef{
				Name:        "delete_bootstrap",
				Description: "删除 BOOTSTRAP.md 文件。当你完成初始化引导仪式后，调用此工具删除 BOOTSTRAP.md，避免重复触发初始化流程。",
				Parameters: map[string]any{
					"type":       "object",
					"properties": map[string]any{},
					"required":   []string{},
				},
			},
		},
	}
}

// GetTerminalTools 获取终端执行工具定义
func GetTerminalTools() []llm.ToolDef {
	if terminalToolInstance == nil {
		// 返回默认的工具定义（沙箱未配置时）
		return []llm.ToolDef{
			{
				Type: "function",
				Function: llm.FunctionDef{
					Name:        "terminal_exec",
					Description: "执行 Shell 命令，返回 stdout 和 stderr。\n⚠️ 危险命令提醒：rm -rf /, mkfs, dd 等命令会永久损坏系统，请勿执行。\n参数：\n- command: 要执行的命令（必填）\n- timeout: 超时时间秒数（可选，默认30）\n- workdir: 工作目录（可选）\n- use_sandbox: 是否使用沙箱执行（可选）\n返回：{\"stdout\": \"...\", \"stderr\": \"...\", \"exit_code\": 0, \"error\": \"\"}",
					Parameters: map[string]any{
						"type": "object",
						"properties": map[string]any{
							"command": map[string]any{
								"type":        "string",
								"description": "要执行的 Shell 命令",
							},
							"timeout": map[string]any{
								"type":        "integer",
								"description": "超时时间（秒），默认30",
							},
							"workdir": map[string]any{
								"type":        "string",
								"description": "工作目录路径（可选）",
							},
							"use_sandbox": map[string]any{
								"type":        "boolean",
								"description": "是否使用沙箱执行（可选，默认跟随全局配置）",
							},
							"sandbox_config": map[string]any{
								"type":        "object",
								"description": "沙箱配置（可选）",
								"properties": map[string]any{
									"image": map[string]any{
										"type":        "string",
										"description": "沙箱镜像",
									},
									"network": map[string]any{
										"type":        "string",
										"description": "网络模式（none/bridge）",
									},
									"memory": map[string]any{
										"type":        "string",
										"description": "内存限制",
									},
								},
							},
						},
						"required": []string{"command"},
					},
				},
			},
		}
	}

	// 使用已配置的终端工具定义
	params := terminalToolInstance.Parameters()
	if _, ok := params.(map[string]any); ok {
		return []llm.ToolDef{
			{
				Type: "function",
				Function: llm.FunctionDef{
					Name:        "terminal_exec",
					Description: terminalToolInstance.Description(),
					Parameters:  params,
				},
			},
		}
	}

	return []llm.ToolDef{}
}

// ExecuteToolCall 执行工具调用
func ExecuteToolCall(call llm.ToolCall, memMgr *memory.MemoryManager) string {
	switch call.Function.Name {
	case "memory_add":
		return executeMemoryAdd(call.Function.Arguments, memMgr)
	case "memory_search":
		return executeMemorySearch(call.Function.Arguments, memMgr)
	case "delete_bootstrap":
		return executeDeleteBootstrap(memMgr)
	default:
		return `{"error": "未知工具: ` + call.Function.Name + `"}`
	}
}

// ExecuteTerminalToolCall 执行终端工具调用
func ExecuteTerminalToolCall(call llm.ToolCall) string {
	if terminalToolInstance == nil {
		return `{"error": "终端工具未初始化"}`
	}

	// 解析参数
	var args map[string]any
	if err := json.Unmarshal([]byte(call.Function.Arguments), &args); err != nil {
		return `{"error": "参数解析失败"}`
	}

	// 转换为 map[string]interface{}
	input := make(map[string]any)
	for k, v := range args {
		input[k] = v
	}

	// 执行工具
	result, err := terminalToolInstance.Execute(input)
	if err != nil {
		return `{"error": "` + err.Error() + `"}`
	}

	return result
}

// executeMemoryAdd 执行记忆写入
func executeMemoryAdd(argsJSON string, memMgr *memory.MemoryManager) string {
	var args struct {
		Content    string `json:"content"`
		MemoryType string `json:"memory_type"`
	}
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return `{"error": "参数解析失败"}`
	}
	if args.Content == "" {
		return `{"error": "内容不能为空"}`
	}
	if args.MemoryType == "" {
		args.MemoryType = "daily"
	}
	if err := memMgr.WriteMemory(args.MemoryType, args.Content); err != nil {
		return `{"error": "写入失败: ` + err.Error() + `"}`
	}
	return `{"success": true, "message": "已记录到` + args.MemoryType + `记忆"}`
}

// executeMemorySearch 执行记忆搜索（简单关键词搜索）
func executeMemorySearch(argsJSON string, memMgr *memory.MemoryManager) string {
	var args struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return `{"error": "参数解析失败"}`
	}
	results := memMgr.SearchMemory(args.Query)
	if len(results) == 0 {
		return `{"results": [], "message": "未找到相关记忆"}`
	}
	resultJSON, _ := json.Marshal(map[string]any{"results": results})
	return string(resultJSON)
}

// executeDeleteBootstrap 删除 BOOTSTRAP.md 文件
func executeDeleteBootstrap(memMgr *memory.MemoryManager) string {
	if err := memMgr.DeleteBootstrap(); err != nil {
		return `{"error": "删除失败: ` + err.Error() + `"}`
	}
	return `{"success": true, "message": "已删除 BOOTSTRAP.md"}`
}

// truncateSearchResult 截取搜索结果上下文
func truncateSearchResult(content, query string) string {
	lowerContent := strings.ToLower(content)
	idx := strings.Index(lowerContent, strings.ToLower(query))
	if idx == -1 {
		if len(content) > 500 {
			return content[:500] + "..."
		}
		return content
	}
	start := idx - 100
	if start < 0 {
		start = 0
	}
	end := idx + len(query) + 200
	if end > len(content) {
		end = len(content)
	}
	result := content[start:end]
	if start > 0 {
		result = "..." + result
	}
	if end < len(content) {
		result = result + "..."
	}
	return result
}

// GetSkillSaveTools 获取技能保存工具
func GetSkillSaveTools() []llm.ToolDef {
	return []llm.ToolDef{
		{
			Type: "function",
			Function: llm.FunctionDef{
				Name:        "skill_save",
				Description: "保存技能文档。当你完成一个复杂任务（涉及5次以上工具调用）后，将解决过程沉淀为技能以便后续复用。",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"name": map[string]any{
							"type":        "string",
							"description": "技能名称（英文，用于目录命名）",
						},
						"description": map[string]any{
							"type":        "string",
							"description": "技能描述（中文，简短说明技能用途）",
						},
						"content": map[string]any{
							"type":        "string",
							"description": "技能内容（Markdown 格式，应包含：问题分析、解决步骤、关键代码/命令、注意事项）",
						},
						"tags": map[string]any{
							"type":        "array",
							"items":       map[string]any{"type": "string"},
							"description": "技能标签列表",
						},
					},
					"required": []string{"name", "description", "content"},
				},
			},
		},
	}
}

// GetFileAnalyzeTools 获取文件分析工具定义
func GetFileAnalyzeTools() []llm.ToolDef {
	return []llm.ToolDef{
		{
			Type: "function",
			Function: llm.FunctionDef{
				Name:        "file_analyze",
				Description: "分析文件内容，支持图片、PDF、文本等文件类型。\n参数：\n- path: 文件路径（必填）\n- question: 针对文件的问题（可选，不填则返回文件摘要）\n\n支持的图片类型：png, jpg, jpeg, gif, webp, bmp\n返回格式：JSON {file_type, content, summary}",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"path": map[string]any{
							"type":        "string",
							"description": "文件路径",
						},
						"question": map[string]any{
							"type":        "string",
							"description": "针对文件的问题（可选）",
						},
					},
					"required": []string{"path"},
				},
			},
		},
	}
}
