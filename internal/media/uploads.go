package media

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// UploadManager 上传文件管理器
type UploadManager struct {
	uploadDir string
}

// NewUploadManager 创建上传文件管理器
func NewUploadManager(uploadDir string) *UploadManager {
	if uploadDir == "" {
		uploadDir = "./data/uploads"
	}
	// 确保目录存在
	os.MkdirAll(uploadDir, 0755)
	return &UploadManager{uploadDir: uploadDir}
}

// GetUploadDir 获取上传目录路径
func (um *UploadManager) GetUploadDir() string {
	return um.uploadDir
}

// SaveFile 保存文件到上传目录
// filename: 原始文件名
// data: 文件内容
// 返回保存后的文件路径
func (um *UploadManager) SaveFile(filename string, data []byte) (string, error) {
	// 生成带时间戳的文件名
	timestamp := time.Now().Unix()
	ext := filepath.Ext(filename)
	name := strings.TrimSuffix(filename, ext)
	safeName := sanitizeFilename(name)
	newFilename := fmt.Sprintf("%d_%s%s", timestamp, safeName, ext)
	
	filePath := filepath.Join(um.uploadDir, newFilename)
	
	err := os.WriteFile(filePath, data, 0644)
	if err != nil {
		return "", fmt.Errorf("保存文件失败: %w", err)
	}
	
	return filePath, nil
}

// GetFilePath 获取上传目录中的文件路径
func (um *UploadManager) GetFilePath(filename string) string {
	return filepath.Join(um.uploadDir, filename)
}

// ListFiles 列出上传目录中的所有文件
func (um *UploadManager) ListFiles() ([]string, error) {
	entries, err := os.ReadDir(um.uploadDir)
	if err != nil {
		return nil, err
	}
	
	var files []string
	for _, entry := range entries {
		if !entry.IsDir() {
			files = append(files, entry.Name())
		}
	}
	return files, nil
}

// DeleteFile 删除上传目录中的文件
func (um *UploadManager) DeleteFile(filename string) error {
	filePath := filepath.Join(um.uploadDir, filename)
	return os.Remove(filePath)
}

// sanitizeFilename 清理文件名，移除不安全字符
func sanitizeFilename(filename string) string {
	// 移除非字母数字、下划线、短横线的字符
	var result strings.Builder
	for _, r := range filename {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			result.WriteRune(r)
		} else if r == ' ' || r == '.' {
			result.WriteRune(r)
		}
	}
	if result.Len() == 0 {
		return "file"
	}
	return result.String()
}
