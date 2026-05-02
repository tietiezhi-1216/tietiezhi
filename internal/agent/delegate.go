package agent

import (
	"encoding/json"
	"fmt"

	"tietiezhi/internal/llm"
	"tietiezhi/internal/media"
)

// ModelCapability 模型能力映射
type ModelCapability struct {
	Model       string   `yaml:"model"`
	Capabilities []string `yaml:"capabilities"` // vision, audio, coding 等
}

// GetDelegateTools 返回 delegate_task 工具定义
func GetDelegateTools() []llm.ToolDef {
	return []llm.ToolDef{
		{
			Type: "function",
			Function: llm.FunctionDef{
				Name:        "delegate_task",
				Description: "将任务委托给具有特定能力的模型执行。当需要处理图片理解、音频转录、代码生成等特定任务时使用。\n\n" +
					"参数说明：\n" +
					"- capability: 任务类型，支持 'vision'（图片理解）、'audio'（音频处理）、'coding'（代码生成）\n" +
					"- prompt: 任务描述和提示\n" +
					"- media: 可选的媒体文件路径或URL列表\n\n" +
					"使用场景：\n" +
					"- 当用户发送图片并需要详细分析时，使用 vision 能力\n" +
					"- 当需要特定模型处理特定任务时",
				Parameters: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"capability": map[string]interface{}{
							"type":        "string",
							"description": "任务能力类型：vision（图片理解）、audio（音频处理）、coding（代码生成）",
							"enum":        []string{"vision", "audio", "coding"},
						},
						"prompt": map[string]interface{}{
							"type":        "string",
							"description": "任务描述和提示词",
						},
						"media": map[string]interface{}{
							"type":        "array",
							"description": "媒体文件路径或URL列表（可选）",
							"items": map[string]interface{}{
								"type": "string",
							},
						},
					},
					"required": []string{"capability", "prompt"},
				},
			},
		},
	}
}

// ExecuteDelegate 执行 delegate_task 工具
// 这个函数实际上不会真正委托给其他模型，因为模型的路由能力由 LLM 平台决定
// 这里主要提供工具定义，实际的图片处理通过 media 包完成
func ExecuteDelegate(argsJSON string, defaultProvider llm.Provider) string {
	var args struct {
		Capability string   `json:"capability"`
		Prompt     string   `json:"prompt"`
		Media      []string `json:"media,omitempty"`
	}

	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return fmt.Sprintf(`{"error": "参数解析失败: %s"}`, err.Error())
	}

	if args.Capability == "" {
		return `{"error": "capability 参数不能为空"}`
	}

	// 目前图片处理已经通过 BuildMultimodalMessage 内联处理
	// delegate_task 主要是提供一个结构化的能力委托接口
	// 实际执行时，消息会包含多模态内容，由支持多模态的模型处理

	result := map[string]interface{}{
		"success":    true,
		"message":    "任务已接收，将使用支持 " + args.Capability + " 能力的模型处理",
		"capability": args.Capability,
		"has_media":  len(args.Media) > 0,
	}

	resultJSON, _ := json.Marshal(result)
	return string(resultJSON)
}

// ProcessDelegateMedia 处理委托任务中的媒体文件
// 返回处理后的媒体数据 URI 列表
func ProcessDelegateMedia(mediaRefs []string) ([]string, error) {
	processor := media.NewMediaProcessor()
	var dataURIs []string

	for _, ref := range mediaRefs {
		dataURI, err := processor.ProcessMedia(ref)
		if err != nil {
			// 跳过处理失败的媒体
			continue
		}
		dataURIs = append(dataURIs, dataURI)
	}

	return dataURIs, nil
}
