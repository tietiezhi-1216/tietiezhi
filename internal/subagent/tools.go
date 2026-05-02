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
				Description: "启动一个子代理异步执行任务。子代理拥有独立的会话上下文，共享记忆和技能系统。完成后结果会自动投递到当前聊天。适用于：耗时较长的任务、需要独立上下文的并行工作、研究/分析/写作等可独立完成的子任务。\n\n支持四种高级模式：\n1. params 配置：可指定 instruction（覆盖 system prompt）、tools（工具白名单）、model（模型选择）\n2. 同步模式：sync=true 时阻塞等待结果，结果直接返回给调用方（不投递飞书）\n3. 文件共享：files 参数指定父 Agent 的文件路径列表，子代理可读取\n4. 持久会话：session_mode=persistent 时，同 label 子代理复用会话历史",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"task": map[string]any{
							"type":        "string",
							"description": "任务描述，需要足够详细让子代理独立完成",
						},
						"label": map[string]any{
							"type":        "string",
							"description": "任务标签，用于追踪和持久会话复用（可选）",
						},
						"timeout": map[string]any{
							"type":        "integer",
							"description": "超时秒数，默认300（可选）",
						},
						"instruction": map[string]any{
							"type":        "string",
							"description": "自定义 system prompt，覆盖主 Agent 的 systemPrompt（可选）",
						},
						"tools": map[string]any{
							"type": "array",
							"items": map[string]any{"type": "string"},
							"description": "工具白名单，指定子代理可以使用的工具名称列表（可选）。支持：memory_add, memory_search, delete_bootstrap, terminal_exec, web_search, web_fetch, file_read, file_write, skill_load, file_analyze, delegate_task",
						},
						"model": map[string]any{
							"type":        "string",
							"description": "模型选择：main=主模型（默认），cheap=轻量模型（可选）",
							"enum":        []string{"main", "cheap"},
						},
						"sync": map[string]any{
							"type":        "boolean",
							"description": "同步模式：true=阻塞等待结果返回，false=异步投递飞书（默认false）（可选）",
						},
						"files": map[string]any{
							"type": "array",
							"items": map[string]any{"type": "string"},
							"description": "共享文件路径列表，父 Agent 传给子代理的文件（可选）",
						},
						"session_mode": map[string]any{
							"type":        "string",
							"description": "会话模式：ephemeral=每次新会话（默认），persistent=复用会话积累知识（可选）",
							"enum":        []string{"ephemeral", "persistent"},
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
	instruction, _ := args["instruction"].(string)
	model, _ := args["model"].(string)
	sync, _ := args["sync"].(bool)
	sessionMode, _ := args["session_mode"].(string)

	// 解析 tools 列表
	var tools []string
	if toolsRaw, ok := args["tools"].([]interface{}); ok {
		for _, t := range toolsRaw {
			if tStr, ok := t.(string); ok {
				tools = append(tools, tStr)
			}
		}
	}

	// 解析 files 列表
	var files []string
	if filesRaw, ok := args["files"].([]interface{}); ok {
		for _, f := range filesRaw {
			if fStr, ok := f.(string); ok {
				files = append(files, fStr)
			}
		}
	}

	if task == "" {
		return `{"error": "任务描述不能为空"}`, nil
	}

	req := SpawnRequest{
		Task:        task,
		Label:       label,
		Timeout:     int(timeout),
		ParentKey:   sessionKey,
		ChatID:      chatID,
		IsGroup:     isGroup,
		Instruction: instruction,
		Tools:       tools,
		Model:       model,
		Sync:        sync,
		Files:       files,
		SessionMode: sessionMode,
	}

	var result *SpawnResult
	var err error

	if sync {
		// 同步模式：阻塞等待结果
		result, err = mgr.SpawnSync(req)
	} else {
		// 异步模式：非阻塞启动
		result, err = mgr.Spawn(req)
	}

	if err != nil {
		return "", fmt.Errorf("启动子代理失败: %w", err)
	}

	// 同步模式下，结果已经完成
	if sync {
		// 复制结果
		response := map[string]any{
			"success":     true,
			"spawn_id":    result.SpawnID,
			"session_key": result.SessionKey,
			"status":      result.Status,
		}

		switch result.Status {
		case "completed":
			response["result"] = result.Result
			response["message"] = "子代理任务已完成"
			if label != "" {
				response["message"] = fmt.Sprintf("子代理 [%s] 任务已完成", label)
			}
		case "failed":
			response["error"] = result.Error
			response["message"] = "子代理任务失败"
		case "timeout":
			response["error"] = result.Error
			response["message"] = "子代理任务超时"
		default:
			response["message"] = "子代理任务状态异常"
		}

		data, _ := json.Marshal(response)
		return string(data), nil
	}

	// 异步模式下，立即返回启动信息
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
