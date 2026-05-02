package media

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"tietiezhi/internal/llm"
)

const (
	// DefaultMaxImageSize 默认最大图片大小 20MB
	DefaultMaxImageSize = 20 * 1024 * 1024
	// DefaultMaxTotalMediaSize 最大总媒体大小 50MB
	DefaultMaxTotalMediaSize = 50 * 1024 * 1024
	// MaxImageDimension 图片最大尺寸（超过此尺寸进行缩放）
	MaxImageDimension = 2048
)

// MediaProcessor 媒体处理器
type MediaProcessor struct {
	maxImageSize int64
	allowedTypes []string
}

// NewMediaProcessor 创建媒体处理器
func NewMediaProcessor() *MediaProcessor {
	return &MediaProcessor{
		maxImageSize: DefaultMaxImageSize,
		allowedTypes: []string{"image/png", "image/jpeg", "image/gif", "image/webp"},
	}
}

// SetMaxImageSize 设置最大图片大小
func (p *MediaProcessor) SetMaxImageSize(size int64) {
	p.maxImageSize = size
}

// SetAllowedTypes 设置允许的 MIME 类型
func (p *MediaProcessor) SetAllowedTypes(types []string) {
	p.allowedTypes = types
}

// ProcessMedia 处理媒体文件，返回 Base64 data URI 或原始 URL
// 支持输入：本地路径、HTTP URL
func (p *MediaProcessor) ProcessMedia(mediaRef string) (string, error) {
	// 判断是 URL 还是本地文件
	if strings.HasPrefix(mediaRef, "http://") || strings.HasPrefix(mediaRef, "https://") {
		return p.processRemoteMedia(mediaRef)
	}
	return p.processLocalMedia(mediaRef)
}

// processRemoteMedia 处理远程媒体
func (p *MediaProcessor) processRemoteMedia(mediaURL string) (string, error) {
	// 检查是否为图片 URL（直接返回 URL，LLM 会自己下载）
	parsedURL, err := url.Parse(mediaURL)
	if err != nil {
		return "", fmt.Errorf("解析 URL 失败: %w", err)
	}

	path := strings.ToLower(parsedURL.Path)
	ext := filepath.Ext(path)

	// 如果是图片扩展名，直接返回 URL
	if IsImageExtension(ext) {
		// 下载并检查大小
		resp, err := http.Head(mediaURL)
		if err != nil {
			// 无法 HEAD 请求，直接返回 URL
			return mediaURL, nil
		}
		resp.Body.Close()

		contentLength := resp.ContentLength
		if contentLength > 0 && contentLength > p.maxImageSize {
			// 图片太大，需要下载后压缩
			return p.downloadAndProcessRemote(mediaURL)
		}
		return mediaURL, nil
	}

	// 其他文件下载后转为 Base64
	return p.downloadAndProcessRemote(mediaURL)
}

// downloadAndProcessRemote 下载远程图片并处理
func (p *MediaProcessor) downloadAndProcessRemote(mediaURL string) (string, error) {
	resp, err := http.Get(mediaURL)
	if err != nil {
		return "", fmt.Errorf("下载媒体失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("下载媒体失败: HTTP %d", resp.StatusCode)
	}

	contentType := resp.Header.Get("Content-Type")
	if !p.isAllowedType(contentType) {
		// 尝试根据内容检测
		contentType = "application/octet-stream"
	}

	// 读取内容
	data, err := io.ReadAll(io.LimitReader(resp.Body, p.maxImageSize+1))
	if err != nil {
		return "", fmt.Errorf("读取媒体内容失败: %w", err)
	}

	if int64(len(data)) > p.maxImageSize {
		return "", fmt.Errorf("媒体文件超过大小限制 (%d bytes)", p.maxImageSize)
	}

	// 如果是图片，进行压缩处理
	if IsImageType(contentType) || IsImageTypeByData(data) {
		data, contentType = p.processImageData(data)
	}

	// 转换为 Base64
	base64Data := base64.StdEncoding.EncodeToString(data)
	return fmt.Sprintf("data:%s;base64,%s", contentType, base64Data), nil
}

// processLocalMedia 处理本地媒体文件
func (p *MediaProcessor) processLocalMedia(filePath string) (string, error) {
	// 打开文件
	file, err := os.Open(filePath)
	if err != nil {
		return "", fmt.Errorf("打开文件失败: %w", err)
	}
	defer file.Close()

	// 检查文件大小
	stat, err := file.Stat()
	if err != nil {
		return "", fmt.Errorf("获取文件信息失败: %w", err)
	}

	if stat.Size() > p.maxImageSize {
		return "", fmt.Errorf("文件超过大小限制 (%d bytes)", p.maxImageSize)
	}

	// 检测文件类型
	contentType, err := p.DetectContentType(filePath)
	if err != nil {
		return "", fmt.Errorf("检测文件类型失败: %w", err)
	}

	if !p.isAllowedType(contentType) && !IsImageType(contentType) {
		return "", fmt.Errorf("不支持的文件类型: %s", contentType)
	}

	// 如果是图片，读取并处理
	if IsImageType(contentType) {
		data, err := io.ReadAll(file)
		if err != nil {
			return "", fmt.Errorf("读取文件内容失败: %w", err)
		}

		processedData, finalType := p.processImageData(data)
		if finalType == "" {
			finalType = contentType
		}

		base64Data := base64.StdEncoding.EncodeToString(processedData)
		return fmt.Sprintf("data:%s;base64,%s", finalType, base64Data), nil
	}

	// 非图片文件，直接转为 Base64
	data, err := io.ReadAll(file)
	if err != nil {
		return "", fmt.Errorf("读取文件内容失败: %w", err)
	}

	base64Data := base64.StdEncoding.EncodeToString(data)
	return fmt.Sprintf("data:%s;base64,%s", contentType, base64Data), nil
}

// processImageData 处理图片数据（可能需要缩放）
func (p *MediaProcessor) processImageData(data []byte) ([]byte, string) {
	// 解码图片获取尺寸
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		// 无法解码，直接返回原始数据
		return data, http.DetectContentType(data)
	}

	// 检查是否需要缩放
	if cfg.Width > MaxImageDimension || cfg.Height > MaxImageDimension {
		// 需要缩放
		processedData, err := p.resizeImage(data, format)
		if err != nil {
			return data, formatToMimeType(format)
		}
		return processedData, formatToMimeType(format)
	}

	return data, formatToMimeType(format)
}

// resizeImage 缩放图片
func (p *MediaProcessor) resizeImage(data []byte, format string) ([]byte, error) {
	// 解码图片
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}

	bounds := img.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()

	// 计算缩放比例
	scale := float64(MaxImageDimension) / float64(maxInt(width, height))
	if scale >= 1 {
		return data, nil // 不需要缩放
	}

	newWidth := int(float64(width) * scale)
	newHeight := int(float64(height) * scale)

	// 创建缩放后的图片
	resized := image.NewRGBA(image.Rect(0, 0, newWidth, newHeight))

	// 简单的最近邻缩放
	for y := 0; y < newHeight; y++ {
		for x := 0; x < newWidth; x++ {
			srcX := int(float64(x) / scale)
			srcY := int(float64(y) / scale)
			// 边界检查
			if srcX >= width {
				srcX = width - 1
			}
			if srcY >= height {
				srcY = height - 1
			}
			resized.Set(x, y, img.At(srcX, srcY))
		}
	}

	// 编码为 JPEG（统一转为 JPEG 以节省空间）
	var buf bytes.Buffer
	switch format {
	case "png":
		err = png.Encode(&buf, resized)
	case "gif":
		err = gif.Encode(&buf, resized, nil)
	default:
		err = jpeg.Encode(&buf, resized, &jpeg.Options{Quality: 85})
	}

	if err != nil {
		return nil, err
	}

	return buf.Bytes(), nil
}

// DetectContentType 检测文件类型
func (p *MediaProcessor) DetectContentType(filePath string) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer file.Close()

	// 读取前 512 字节用于检测
	buffer := make([]byte, 512)
	n, err := file.Read(buffer)
	if err != nil && err != io.EOF {
		return "", err
	}

	return http.DetectContentType(buffer[:n]), nil
}

// DetectContentTypeFromData 从数据检测文件类型
func (p *MediaProcessor) DetectContentTypeFromData(data []byte) string {
	if len(data) < 512 {
		return http.DetectContentType(data)
	}
	return http.DetectContentType(data[:512])
}

// isAllowedType 检查类型是否允许
func (p *MediaProcessor) isAllowedType(contentType string) bool {
	for _, t := range p.allowedTypes {
		if t == contentType {
			return true
		}
	}
	return false
}

// IsImageType 判断是否是图片类型
func IsImageType(contentType string) bool {
	return strings.HasPrefix(contentType, "image/")
}

// IsImageExtension 判断是否是图片扩展名
func IsImageExtension(ext string) bool {
	ext = strings.ToLower(ext)
	return ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".gif" || ext == ".webp"
}

// IsImageTypeByData 通过数据判断是否是图片
func IsImageTypeByData(data []byte) bool {
	if len(data) < 4 {
		return false
	}
	// PNG
	if data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47 {
		return true
	}
	// JPEG
	if data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
		return true
	}
	// GIF
	if data[0] == 0x47 && data[1] == 0x49 && data[2] == 0x46 {
		return true
	}
	// WebP (RIFF)
	if data[0] == 0x52 && data[1] == 0x49 && data[2] == 0x46 && data[3] == 0x46 {
		return true
	}
	return false
}

// formatToMimeType 将图片格式转为 MIME 类型
func formatToMimeType(format string) string {
	switch format {
	case "png":
		return "image/png"
	case "jpeg", "jpg":
		return "image/jpeg"
	case "gif":
		return "image/gif"
	case "webp":
		return "image/webp"
	default:
		return "image/jpeg"
	}
}

// BuildImageContentPart 构建图片内容部分
func BuildImageContentPart(dataURI string) llm.ContentPart {
	return llm.ContentPart{
		Type: "image_url",
		ImageURL: &llm.ImageURL{
			URL:    dataURI,
			Detail: "auto",
		},
	}
}

// BuildTextContentPart 构建文本内容部分
func BuildTextContentPart(text string) llm.ContentPart {
	return llm.ContentPart{
		Type: "text",
		Text: text,
	}
}

// BuildMultimodalMessage 构建多模态消息
// text: 文本内容
// mediaRefs: 媒体引用列表（路径或URL）
func BuildMultimodalMessage(role, text string, mediaRefs []string) (llm.ChatMessage, error) {
	processor := NewMediaProcessor()
	var parts []llm.ContentPart

	// 添加文本部分
	if text != "" {
		parts = append(parts, BuildTextContentPart(text))
	}

	// 添加媒体部分
	for _, ref := range mediaRefs {
		dataURI, err := processor.ProcessMedia(ref)
		if err != nil {
			// 记录错误但继续处理其他媒体
			continue
		}
		parts = append(parts, BuildImageContentPart(dataURI))
	}

	// 如果没有内容部分，返回纯文本消息
	if len(parts) == 0 {
		return llm.ChatMessage{Role: role, Content: text}, nil
	}

	// 如果只有文本部分，直接返回字符串
	if len(parts) == 1 && parts[0].Type == "text" {
		return llm.ChatMessage{Role: role, Content: text}, nil
	}

	return llm.ChatMessage{Role: role, Content: parts}, nil
}

// BuildSimpleMultimodalMessage 构建简单的多模态消息（不处理媒体，直接使用 data URI）
func BuildSimpleMultimodalMessage(role, text string, dataURIs []string) llm.ChatMessage {
	var parts []llm.ContentPart

	// 添加文本部分
	if text != "" {
		parts = append(parts, BuildTextContentPart(text))
	}

	// 添加媒体部分
	for _, uri := range dataURIs {
		parts = append(parts, BuildImageContentPart(uri))
	}

	// 如果没有内容部分，返回空
	if len(parts) == 0 {
		return llm.ChatMessage{Role: role, Content: ""}
	}

	// 如果只有文本部分，直接返回字符串
	if len(parts) == 1 && parts[0].Type == "text" {
		return llm.ChatMessage{Role: role, Content: text}
	}

	return llm.ChatMessage{Role: role, Content: parts}
}

// maxInt 返回较大值
func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
