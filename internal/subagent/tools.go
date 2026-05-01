package subagent

import (
	"encoding/json"
	"fmt"

	"tietiezhi/internal/llm"
)

// GetSubAgentTools 返回 agent_spawn 工具定义
func GetSubAgentTools() []llm.ToolDef {
	return []llm.ToolDef{
		{
			Type: "function",
			Function: llm.FunctionDef{
				Name:        "agent_spawn",
				Description: "启动一个子代理异步执行任务。子代理拥有独立的会话上下文，共享记忆和技能系统。完成后结果会自动投递到当前聊天。适用于：耗时较长的任务、需要独立上下文的并行工作、研究/分析/写作等可独立完成的子任务。",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"task": map[string]any{
							"type":        "string",
							"description": "任务描述，需要足够详细让子代理独立完成",
						},
						"label": map[string]any{
							"type":        "string",
							"description": "任务标签，用于追踪（可选）",
						},
						"timeout": map[string]any{
							"type":        "integer",
							"description": "超时秒数，默认300（可选）",
						},
					},
					"required": []string{"task"},
				},
			},
		},
	}
}

// ExecuteSpawn 执行 agent_spawn 工具调用
func ExecuteSpawn(mgr *SubAgentManager, args map[string]interface{}, sessionKey, chatID string, isGroup bool) (string, error) {
	task, _ := args["task"].(string)
	label, _ := args["label"].(string)
	timeout, _ := args["timeout"].(float64)

	if task == "" {
		return `{"error": "任务描述不能为空"}`, nil
	}

	req := SpawnRequest{
		Task:      task,
		Label:     label,
		Timeout:   int(timeout),
		ParentKey: sessionKey,
		ChatID:    chatID,
		IsGroup:   isGroup,
	}

	result, err := mgr.Spawn(req)
	if err != nil {
		return "", fmt.Errorf("启动子代理失败: %w", err)
	}

	// 复制结果以防并发问题
	response := map[string]any{
		"success":     true,
		"spawn_id":    result.SpawnID,
		"session_key": result.SessionKey,
		"status":      result.Status,
		"message":     "子代理任务已启动",
	}

	if label != "" {
		response["message"] = fmt.Sprintf("子代理任务 [%s] 已启动", label)
	}

	data, _ := json.Marshal(response)
	return string(data), nil
}
