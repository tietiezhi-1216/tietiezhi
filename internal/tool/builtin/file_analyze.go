package builtin

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"tietiezhi/internal/llm"
	"tietiezhi/internal/tool"
)

// FileAnalyzeTool 文件分析工具
type FileAnalyzeTool struct {
	llmProvider llm.Provider
}

// NewFileAnalyzeTool 创建文件分析工具
func NewFileAnalyzeTool(provider llm.Provider) *FileAnalyzeTool {
	return &FileAnalyzeTool{llmProvider: provider}
}

// Name 返回工具名称
func (t *FileAnalyzeTool) Name() string {
	return "file_analyze"
}

// Description 返回工具描述
func (t *FileAnalyzeTool) Description() string {
	return `分析文件内容，支持图片、PDF、文本等文件类型。
参数：
- path: 文件路径（必填）
- question: 针对文件的问题（可选，不填则返回文件摘要）

支持的图片类型：png, jpg, jpeg, gif, webp, bmp
返回格式：JSON {file_type, content, summary}`
}

// Parameters 返回参数定义
func (t *FileAnalyzeTool) Parameters() any {
	return map[string]any{
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
	}
}

// Execute 分析文件
func (t *FileAnalyzeTool) Execute(input map[string]any) (string, error) {
	path, ok := input["path"].(string)
	if !ok || path == "" {
		return "", fmt.Errorf("path 参数必填")
	}

	question, _ := input["question"].(string)

	// 检查文件是否存在
	if _, err := os.Stat(path); os.IsNotExist(err) {
		result, _ := json.Marshal(map[string]any{
			"error": fmt.Sprintf("文件不存在: %s", path),
		})
		return string(result), nil
	}

	// 获取文件扩展名
	ext := strings.ToLower(filepath.Ext(path))
	fileType := getFileType(ext)

	var content string
	var summary string

	switch fileType {
	case "image":
		// 图片文件：使用多模态 LLM
		content, summary = t.analyzeImage(path, question)

	case "pdf":
		// PDF 文件：提取文本
		text, err := t.extractPDF(path)
		if err != nil {
			content = ""
			summary = fmt.Sprintf("PDF 提取失败: %v", err)
		} else {
			content = text
			if question != "" {
				summary = fmt.Sprintf("PDF 内容已提取，共 %d 字符", len(text))
			} else {
				// 截取前 500 字符作为摘要
				if len(text) > 500 {
					summary = text[:500] + "..."
				} else {
					summary = text
				}
			}
		}

	case "code", "text":
		// 文本/代码文件：直接读取
		data, err := os.ReadFile(path)
		if err != nil {
			content = ""
			summary = fmt.Sprintf("读取失败: %v", err)
		} else {
			content = string(data)
			if question != "" {
				summary = fmt.Sprintf("文件内容共 %d 字符", len(content))
			} else {
				// 截取前 500 字符作为摘要
				if len(content) > 500 {
					summary = content[:500] + "..."
				} else {
					summary = content
				}
			}
		}

	default:
		content = ""
		summary = fmt.Sprintf("不支持的文件类型: %s", ext)
	}

	result := map[string]any{
		"file_type": fileType,
		"content":   content,
		"summary":   summary,
	}

	resultJSON, _ := json.Marshal(result)
	return string(resultJSON), nil
}

// analyzeImage 使用多模态 LLM 分析图片
func (t *FileAnalyzeTool) analyzeImage(imagePath, question string) (string, string) {
	// 读取图片文件
	imageData, err := os.ReadFile(imagePath)
	if err != nil {
		return "", fmt.Sprintf("读取图片失败: %v", err)
	}

	// 获取图片扩展名
	ext := strings.ToLower(filepath.Ext(imagePath))
	mediaType := getMediaType(ext)

	// 构建多模态消息
	systemPrompt := "你是一个图片分析助手。请详细描述这张图片的内容。"
	userPrompt := "请描述这张图片。"
	if question != "" {
		userPrompt = question
	}

	// 构建请求
	req := &llm.ChatRequest{
		Model: "",
		Messages: []llm.ChatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: []llm.ContentPart{
				{Type: "text", Text: userPrompt},
				{Type: "image_url", ImageURL: &llm.ImageURL{
					URL:    fmt.Sprintf("data:%s;base64,%s", mediaType, base64Encode(imageData)),
					Detail: "auto",
				}},
			}},
		},
		Stream: false,
	}

	// 调用 LLM
	resp, err := t.llmProvider.Chat(context.Background(), req)
	if err != nil {
		return "", fmt.Sprintf("分析失败: %v", err)
	}

	if len(resp.Choices) == 0 {
		return "", "分析返回为空"
	}

	// 获取回复内容（Content 可能是 string 或其他类型）
	rawContent := resp.Choices[0].Message.Content
	var content string
	switch v := rawContent.(type) {
	case string:
		content = v
	case []llm.ContentPart:
		// 提取所有文本
		var textParts []string
		for _, part := range v {
			if part.Text != "" {
				textParts = append(textParts, part.Text)
			}
		}
		content = strings.Join(textParts, "\n")
	default:
		content = fmt.Sprintf("%v", v)
	}

	summary := content
	if len(summary) > 500 {
		summary = summary[:500] + "..."
	}

	return content, summary
}

// extractPDF 提取 PDF 文本（简单实现）
func (t *FileAnalyzeTool) extractPDF(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}

	// 简单 PDF 文本提取：查找文本流
	var text strings.Builder
	streamDepth := 0

	content := string(data)

	// 移除 PDF 头部注释
	if idx := strings.Index(content, "%PDF-"); idx >= 0 {
		content = content[idx:]
	}

	// 简单提取：查找括号内的文本 (text extraction)
	// 这是一个简化实现，完整实现需要解析 PDF 结构
	lines := strings.Split(content, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		// 跳过命令和对象声明
		if strings.HasPrefix(line, "<<") || strings.HasPrefix(line, ">>") ||
			strings.HasPrefix(line, "stream") || strings.HasPrefix(line, "endstream") ||
			strings.HasPrefix(line, "obj") || strings.HasPrefix(line, "endobj") {
			continue
		}
		// 提取括号内的文本
		for i := 0; i < len(line); i++ {
			if line[i] == '(' {
				streamDepth = 1
				i++
				var textContent strings.Builder
				for i < len(line) && streamDepth > 0 {
					if line[i] == '\\' && i+1 < len(line) {
						// 转义字符
						i++
						textContent.WriteByte(line[i])
					} else if line[i] == '(' {
						streamDepth++
						textContent.WriteByte(line[i])
					} else if line[i] == ')' {
						streamDepth--
						if streamDepth > 0 {
							textContent.WriteByte(line[i])
						}
					} else {
						textContent.WriteByte(line[i])
					}
					i++
				}
				if textContent.Len() > 0 {
					text.WriteString(textContent.String())
					text.WriteString("\n")
				}
				continue
			}
		}
	}

	result := strings.TrimSpace(text.String())
	if result == "" {
		result = "[PDF 内容为空或无法提取文本]"
	}

	return result, nil
}

// getFileType 根据扩展名获取文件类型
func getFileType(ext string) string {
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg":
		return "image"
	case ".pdf":
		return "pdf"
	case ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx":
		return "document"
	case ".mp4", ".avi", ".mov", ".mkv", ".webm":
		return "video"
	case ".mp3", ".wav", ".ogg", ".flac":
		return "audio"
	case ".go", ".py", ".js", ".ts", ".java", ".c", ".cpp", ".h", ".rs", ".rb", ".php", ".swift", ".kt":
		return "code"
	default:
		// 检查是否为文本文件
		return "text"
	}
}

// getMediaType 根据扩展名获取 MIME 类型
func getMediaType(ext string) string {
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	default:
		return "image/png"
	}
}

// base64Encode 编码为 base64
func base64Encode(data []byte) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

	var result strings.Builder
	result.Grow((len(data)+2)/3*4)

	for i := 0; i < len(data); i += 3 {
		var n uint32
		n |= uint32(data[i]) << 16
		if i+1 < len(data) {
			n |= uint32(data[i+1]) << 8
		}
		if i+2 < len(data) {
			n |= uint32(data[i+2])
		}

		result.WriteByte(alphabet[(n>>18)&0x3F])
		result.WriteByte(alphabet[(n>>12)&0x3F])
		if i+1 < len(data) {
			result.WriteByte(alphabet[(n>>6)&0x3F])
		} else {
			result.WriteByte('=')
		}
		if i+2 < len(data) {
			result.WriteByte(alphabet[n&0x3F])
		} else {
			result.WriteByte('=')
		}
	}

	return result.String()
}

// 确保实现 tool.Tool 接口
var _ tool.Tool = (*FileAnalyzeTool)(nil)
