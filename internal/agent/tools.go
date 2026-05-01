package agent

import (
	"encoding/json"
	"strings"

	"tietiezhi/internal/llm"
	"tietiezhi/internal/memory"
)

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
