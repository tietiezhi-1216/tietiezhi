package builtin

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"tietiezhi/internal/tool"
)

// FileReadTool 文件读取工具
type FileReadTool struct {
	allowedDirs []string
}

// NewFileReadTool 创建文件读取工具
func NewFileReadTool(allowedDirs ...string) *FileReadTool {
	return &FileReadTool{
		allowedDirs: allowedDirs,
	}
}

// Name 返回工具名称
func (t *FileReadTool) Name() string {
	return "file_read"
}

// Description 返回工具描述
func (t *FileReadTool) Description() string {
	desc := `读取文件内容，支持分页读取大文件。
参数：
- path: 文件路径（必填）
- offset: 起始行号（可选，默认0）
- limit: 读取行数（可选，默认100）`
	
	if len(t.allowedDirs) > 0 {
		desc += fmt.Sprintf("\n⚠️ 仅允许读取以下目录：%s", strings.Join(t.allowedDirs, ", "))
	} else {
		desc += "\n⚠️ 警告：未限制可读目录，请注意敏感文件（如 /etc/shadow）"
	}
	
	desc += "\n返回：{\"content\": \"...\", \"total_lines\": 100, \"path\": \"...\"}"
	return desc
}

// Parameters 返回参数定义
func (t *FileReadTool) Parameters() any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path": map[string]any{
				"type":        "string",
				"description": "文件路径",
			},
			"offset": map[string]any{
				"type":        "integer",
				"description": "起始行号（可选，默认0）",
			},
			"limit": map[string]any{
				"type":        "integer",
				"description": "读取行数（可选，默认100）",
			},
		},
		"required": []string{"path"},
	}
}

// Execute 读取文件
func (t *FileReadTool) Execute(input map[string]any) (string, error) {
	path, ok := input["path"].(string)
	if !ok || path == "" {
		return "", fmt.Errorf("path 参数必填")
	}

	// 路径安全检查
	if !t.isPathAllowed(path) {
		result, _ := json.Marshal(map[string]any{
			"content":     "",
			"total_lines": 0,
			"path":         path,
			"error":        "路径不在允许范围内",
		})
		return string(result), nil
	}

	// 检查敏感文件
	if t.isSensitivePath(path) {
		result, _ := json.Marshal(map[string]any{
			"content":     "",
			"total_lines": 0,
			"path":         path,
			"error":        "禁止读取敏感文件",
		})
		return string(result), nil
	}

	// 解析分页参数
	offset := 0
	limit := 100
	if offsetVal, ok := input["offset"].(float64); ok {
		offset = int(offsetVal)
	}
	if limitVal, ok := input["limit"].(float64); ok {
		limit = int(limitVal)
	}

	// 读取文件
	content, totalLines, err := t.readFileLines(path, offset, limit)
	if err != nil {
		result, _ := json.Marshal(map[string]any{
			"content":     "",
			"total_lines": 0,
			"path":         path,
			"error":        err.Error(),
		})
		return string(result), nil
	}

	result := map[string]any{
		"content":     content,
		"total_lines": totalLines,
		"path":         path,
	}
	resultJSON, _ := json.Marshal(result)
	return string(resultJSON), nil
}

// readFileLines 读取文件指定行范围
func (t *FileReadTool) readFileLines(path string, offset, limit int) (string, int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", 0, fmt.Errorf("读取文件失败: %w", err)
	}

	content := string(data)
	lines := strings.Split(content, "\n")
	totalLines := len(lines)

	// 边界处理
	if offset < 0 {
		offset = 0
	}
	if offset >= totalLines {
		offset = totalLines - 1
	}
	if limit <= 0 {
		limit = 100
	}

	end := offset + limit
	if end > totalLines {
		end = totalLines
	}

	// 提取指定行
	slicedLines := lines[offset:end]
	result := strings.Join(slicedLines, "\n")

	return result, totalLines, nil
}

// isPathAllowed 检查路径是否在允许范围内
func (t *FileReadTool) isPathAllowed(path string) bool {
	if len(t.allowedDirs) == 0 {
		return true // 未配置则不限制
	}

	absPath, err := filepath.Abs(path)
	if err != nil {
		return false
	}

	for _, dir := range t.allowedDirs {
		absDir, err := filepath.Abs(dir)
		if err != nil {
			continue
		}
		if strings.HasPrefix(absPath, absDir) {
			return true
		}
	}
	return false
}

// isSensitivePath 检查敏感路径
func (t *FileReadTool) isSensitivePath(path string) bool {
	sensitivePaths := []string{
		"/etc/shadow",
		"/etc/sudoers",
		"/etc/passwd", // passwd 可以读，但 /etc/shadow 不行
		"/root/.ssh",
		"/home/",
	}

	lowerPath := strings.ToLower(path)
	for _, sp := range sensitivePaths {
		if strings.Contains(lowerPath, sp) {
			return true
		}
	}
	return false
}

// 确保实现 tool.Tool 接口
var _ tool.Tool = (*FileReadTool)(nil)

// FileWriteTool 文件写入工具
type FileWriteTool struct {
	allowedDirs []string
}

// NewFileWriteTool 创建文件写入工具
func NewFileWriteTool(allowedDirs ...string) *FileWriteTool {
	return &FileWriteTool{
		allowedDirs: allowedDirs,
	}
}

// Name 返回工具名称
func (t *FileWriteTool) Name() string {
	return "file_write"
}

// Description 返回工具描述
func (t *FileWriteTool) Description() string {
	desc := `写入内容到文件，支持创建、追加、覆盖模式。
参数：
- path: 文件路径（必填）
- content: 要写入的内容（必填）
- mode: 写入模式（可选）：create=创建（默认），overwrite=覆盖，append=追加`
	
	if len(t.allowedDirs) > 0 {
		desc += fmt.Sprintf("\n⚠️ 仅允许写入以下目录：%s", strings.Join(t.allowedDirs, ", "))
	} else {
		desc += "\n⚠️ 警告：未限制可写目录，请谨慎使用"
	}
	
	desc += "\n返回：{\"success\": true, \"path\": \"...\", \"bytes_written\": 100}"
	return desc
}

// Parameters 返回参数定义
func (t *FileWriteTool) Parameters() any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path": map[string]any{
				"type":        "string",
				"description": "文件路径",
			},
			"content": map[string]any{
				"type":        "string",
				"description": "要写入的内容",
			},
			"mode": map[string]any{
				"type":        "string",
				"description": "写入模式：create(默认)/overwrite/append",
				"enum":        []string{"create", "overwrite", "append"},
			},
		},
		"required": []string{"path", "content"},
	}
}

// Execute 写入文件
func (t *FileWriteTool) Execute(input map[string]any) (string, error) {
	path, ok := input["path"].(string)
	if !ok || path == "" {
		return "", fmt.Errorf("path 参数必填")
	}

	content, ok := input["content"].(string)
	if !ok {
		content = ""
	}

	// 路径安全检查
	if !t.isPathAllowed(path) {
		result, _ := json.Marshal(map[string]any{
			"success":      false,
			"path":         path,
			"bytes_written": 0,
			"error":        "路径不在允许范围内",
		})
		return string(result), nil
	}

	// 解析模式
	mode := "create"
	if modeVal, ok := input["mode"].(string); ok {
		mode = modeVal
	}

	// 确保目录存在
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		result, _ := json.Marshal(map[string]any{
			"success":      false,
			"path":         path,
			"bytes_written": 0,
			"error":        fmt.Sprintf("创建目录失败: %s", err.Error()),
		})
		return string(result), nil
	}

	var err error
	var bytesWritten int

	switch mode {
	case "append":
		// 追加模式
		var file *os.File
		file, err = os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			break
		}
		defer file.Close()
		bytesWritten, err = file.WriteString(content)

	case "overwrite":
		// 覆盖模式
		err = os.WriteFile(path, []byte(content), 0644)
		bytesWritten = len(content)

	case "create":
		// 创建模式：检查文件是否存在
		if _, statErr := os.Stat(path); statErr == nil {
			result, _ := json.Marshal(map[string]any{
				"success":      false,
				"path":         path,
				"bytes_written": 0,
				"error":        "文件已存在，请使用 overwrite 模式覆盖或 append 模式追加",
			})
			return string(result), nil
		}
		err = os.WriteFile(path, []byte(content), 0644)
		bytesWritten = len(content)

	default:
		result, _ := json.Marshal(map[string]any{
			"success":      false,
			"path":         path,
			"bytes_written": 0,
			"error":        fmt.Sprintf("未知模式: %s", mode),
		})
		return string(result), nil
	}

	if err != nil {
		result, _ := json.Marshal(map[string]any{
			"success":      false,
			"path":         path,
			"bytes_written": 0,
			"error":        fmt.Sprintf("写入失败: %s", err.Error()),
		})
		return string(result), nil
	}

	result := map[string]any{
		"success":      true,
		"path":         path,
		"bytes_written": bytesWritten,
	}
	resultJSON, _ := json.Marshal(result)
	return string(resultJSON), nil
}

// isPathAllowed 检查路径是否在允许范围内
func (t *FileWriteTool) isPathAllowed(path string) bool {
	if len(t.allowedDirs) == 0 {
		return true // 未配置则不限制
	}

	absPath, err := filepath.Abs(path)
	if err != nil {
		return false
	}

	for _, dir := range t.allowedDirs {
		absDir, err := filepath.Abs(dir)
		if err != nil {
			continue
		}
		if strings.HasPrefix(absPath, absDir) {
			return true
		}
	}
	return false
}

// 确保实现 tool.Tool 接口
var _ tool.Tool = (*FileWriteTool)(nil)
