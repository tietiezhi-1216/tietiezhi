package cron

import (
	"tietiezhi/internal/llm"
)

// GetCronTools 获取 cron_task 工具定义
func GetCronTools() []llm.ToolDef {
	return []llm.ToolDef{
		{
			Type: "function",
			Function: llm.FunctionDef{
				Name:        "cron_task",
				Description: "管理定时任务。可以创建、查看、删除、暂停和恢复定时任务。",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"action": map[string]any{
							"type":        "string",
							"enum":        []string{"create", "list", "delete", "pause", "resume"},
							"description": "操作类型：create=创建任务，list=列出任务，delete=删除任务，pause=暂停任务，resume=恢复任务",
						},
						"name": map[string]any{
							"type":        "string",
							"description": "任务名称（create时必填）",
						},
						"message": map[string]any{
							"type":        "string",
							"description": "定时执行的提示词（create时必填）",
						},
						"schedule_kind": map[string]any{
							"type":        "string",
							"enum":        []string{"at", "every", "cron"},
							"description": "调度类型：at=一次性定时，every=固定间隔执行，cron=cron表达式调度",
						},
						"schedule_at": map[string]any{
							"type":        "string",
							"description": "一次性任务时间，ISO格式如2026-05-02T10:00:00+08:00（kind=at时必填）",
						},
						"schedule_every_ms": map[string]any{
							"type":        "integer",
							"description": "间隔毫秒（kind=every时必填，如3600000=1小时）",
						},
						"schedule_cron": map[string]any{
							"type":        "string",
							"description": "cron表达式如'0 9 * * *'（kind=cron时必填，5位表达式表示分、时、日、月、周）",
						},
						"schedule_tz": map[string]any{
							"type":        "string",
							"description": "时区，默认Asia/Shanghai",
						},
						"job_id": map[string]any{
							"type":        "string",
							"description": "任务ID（delete/pause/resume时必填）",
						},
					},
					"required": []string{"action"},
				},
			},
		},
	}
}
