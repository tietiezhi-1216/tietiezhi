package builtin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"tietiezhi/internal/tool"
)

// SearchConfig 搜索配置
type SearchConfig struct {
	Provider string // serper/brave/custom
	APIKey   string
	BaseURL  string
}

// WebSearchTool 网页搜索工具
type WebSearchTool struct {
	config *SearchConfig
}

// NewWebSearchTool 创建网页搜索工具
func NewWebSearchTool(config *SearchConfig) *WebSearchTool {
	return &WebSearchTool{
		config: config,
	}
}

// Name 返回工具名称
func (t *WebSearchTool) Name() string {
	return "web_search"
}

// Description 返回工具描述
func (t *WebSearchTool) Description() string {
	desc := `通过搜索引擎执行网页搜索。
参数：
- query: 搜索关键词（必填）
- count: 返回结果数量（可选，默认5，最大10）`
	
	if t.config != nil && t.config.Provider != "" && t.config.APIKey != "" {
		desc += fmt.Sprintf("\n当前配置：%s", t.config.Provider)
	} else {
		desc += "\n⚠️ 搜索 API 未配置，请在配置文件中设置 web_search 相关配置"
	}
	
	desc += "\n返回：{\"results\": [{\"title\": \"...\", \"url\": \"...\", \"snippet\": \"...\"}]}"
	return desc
}

// Parameters 返回参数定义
func (t *WebSearchTool) Parameters() any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"query": map[string]any{
				"type":        "string",
				"description": "搜索关键词",
			},
			"count": map[string]any{
				"type":        "integer",
				"description": "返回结果数量（默认5，最大10）",
			},
		},
		"required": []string{"query"},
	}
}

// Execute 执行搜索
func (t *WebSearchTool) Execute(input map[string]any) (string, error) {
	query, ok := input["query"].(string)
	if !ok || query == "" {
		return "", fmt.Errorf("query 参数必填")
	}

	count := 5
	if countVal, ok := input["count"].(float64); ok {
		count = int(countVal)
	}
	if count > 10 {
		count = 10
	}
	if count < 1 {
		count = 1
	}

	// 检查配置
	if t.config == nil || t.config.APIKey == "" {
		result, _ := json.Marshal(map[string]any{
			"results": []map[string]string{},
			"error":   "搜索 API 未配置，请检查配置文件中的 web_search 配置",
		})
		return string(result), nil
	}

	var results []map[string]string
	var err error

	switch t.config.Provider {
	case "serper":
		results, err = t.searchSerper(query, count)
	case "brave":
		results, err = t.searchBrave(query, count)
	case "custom":
		results, err = t.searchCustom(query, count)
	default:
		result, _ := json.Marshal(map[string]any{
			"results": []map[string]string{},
			"error":   fmt.Sprintf("不支持的搜索提供者: %s", t.config.Provider),
		})
		return string(result), nil
	}

	if err != nil {
		result, _ := json.Marshal(map[string]any{
			"results": []map[string]string{},
			"error":   fmt.Sprintf("搜索失败: %s", err.Error()),
		})
		return string(result), nil
	}

	result := map[string]any{
		"results": results,
	}
	resultJSON, _ := json.Marshal(result)
	return string(resultJSON), nil
}

// searchSerper 使用 Serper API 搜索
func (t *WebSearchTool) searchSerper(query string, count int) ([]map[string]string, error) {
	baseURL := t.config.BaseURL
	if baseURL == "" {
		baseURL = "https://google.serper.dev/search"
	}

	payload := map[string]any{
		"q":   query,
		"num": count,
	}
	payloadBytes, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", baseURL, bytes.NewBuffer(payloadBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-KEY", t.config.APIKey)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result struct {
		Organic []struct {
			Title   string `json:"title"`
			Link    string `json:"link"`
			Snippet string `json:"snippet"`
		} `json:"organic"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}

	results := make([]map[string]string, 0, len(result.Organic))
	for _, item := range result.Organic {
		results = append(results, map[string]string{
			"title":   item.Title,
			"url":     item.Link,
			"snippet": item.Snippet,
		})
	}
	return results, nil
}

// searchBrave 使用 Brave Search API 搜索
func (t *WebSearchTool) searchBrave(query string, count int) ([]map[string]string, error) {
	baseURL := t.config.BaseURL
	if baseURL == "" {
		baseURL = "https://api.search.brave.com/res/v1/web/search"
	}

	reqURL := fmt.Sprintf("%s?q=%s&count=%d", baseURL, url.QueryEscape(query), count)
	req, err := http.NewRequest("GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Subscription-Token", t.config.APIKey)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result struct {
		Web struct {
			Results []struct {
				Title       string `json:"title"`
				URL         string `json:"url"`
				Description string `json:"description"`
			} `json:"results"`
		} `json:"web"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}

	results := make([]map[string]string, 0, len(result.Web.Results))
	for _, item := range result.Web.Results {
		results = append(results, map[string]string{
			"title":   item.Title,
			"url":     item.URL,
			"snippet": item.Description,
		})
	}
	return results, nil
}

// searchCustom 使用自定义 API 搜索
func (t *WebSearchTool) searchCustom(query string, count int) ([]map[string]string, error) {
	baseURL := t.config.BaseURL
	if baseURL == "" {
		return nil, fmt.Errorf("自定义搜索需要配置 base_url")
	}

	reqURL := fmt.Sprintf("%s?q=%s&n=%d", baseURL, url.QueryEscape(query), count)
	req, err := http.NewRequest("GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+t.config.APIKey)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	// 尝试通用解析
	var result struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Snippet string `json:"snippet"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}

	results := make([]map[string]string, 0, len(result.Results))
	for _, item := range result.Results {
		results = append(results, map[string]string{
			"title":   item.Title,
			"url":     item.URL,
			"snippet": item.Snippet,
		})
	}
	return results, nil
}

// 确保实现 tool.Tool 接口
var _ tool.Tool = (*WebSearchTool)(nil)

// WebFetchTool 网页获取工具
type WebFetchTool struct{}

// NewWebFetchTool 创建网页获取工具
func NewWebFetchTool() *WebFetchTool {
	return &WebFetchTool{}
}

// Name 返回工具名称
func (t *WebFetchTool) Name() string {
	return "web_fetch"
}

// Description 返回工具描述
func (t *WebFetchTool) Description() string {
	return `获取网页内容，支持纯文本和 HTML 格式。
参数：
- url: 网页地址（必填）
- format: 返回格式（可选）：text=纯文本（默认），html=原始HTML，markdown=Markdown
返回：{"content": "...", "url": "...", "status_code": 200, "content_type": "text/html"}`
}

// Parameters 返回参数定义
func (t *WebFetchTool) Parameters() any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"url": map[string]any{
				"type":        "string",
				"description": "网页地址",
			},
			"format": map[string]any{
				"type":        "string",
				"description": "返回格式：text(默认)/html/markdown",
				"enum":        []string{"text", "html", "markdown"},
			},
		},
		"required": []string{"url"},
	}
}

// Execute 获取网页
func (t *WebFetchTool) Execute(input map[string]any) (string, error) {
	targetURL, ok := input["url"].(string)
	if !ok || targetURL == "" {
		return "", fmt.Errorf("url 参数必填")
	}

	format := "text"
	if formatVal, ok := input["format"].(string); ok {
		format = formatVal
	}

	// 创建请求
	req, err := http.NewRequestWithContext(context.Background(), "GET", targetURL, nil)
	if err != nil {
		return "", fmt.Errorf("创建请求失败: %w", err)
	}

	// 设置 User-Agent 头，避免被网站拒绝
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; tietiezhi/1.0; +https://github.com/tietiezhi)")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		result, _ := json.Marshal(map[string]any{
			"content":     "",
			"url":         targetURL,
			"status_code": 0,
			"content_type": "",
			"error":       fmt.Sprintf("请求失败: %s", err.Error()),
		})
		return string(result), nil
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		result, _ := json.Marshal(map[string]any{
			"content":      "",
			"url":          targetURL,
			"status_code":  resp.StatusCode,
			"content_type": resp.Header.Get("Content-Type"),
			"error":        fmt.Sprintf("读取响应失败: %s", err.Error()),
		})
		return string(result), nil
	}

	contentType := resp.Header.Get("Content-Type")
	var content string

	switch format {
	case "html":
		content = string(body)
	case "markdown":
		content = t.htmlToMarkdown(string(body))
	default: // text
		content = t.stripHTML(string(body))
	}

	result := map[string]any{
		"content":      content,
		"url":          targetURL,
		"status_code":  resp.StatusCode,
		"content_type": contentType,
	}
	resultJSON, _ := json.Marshal(result)
	return string(resultJSON), nil
}

// stripHTML 去除 HTML 标签
func (t *WebFetchTool) stripHTML(html string) string {
	// 移除 script 和 style 标签及其内容
	scriptRe := regexp.MustCompile(`(?is)<script[^>]*>.*?</script>`)
	html = scriptRe.ReplaceAllString(html, "")

	styleRe := regexp.MustCompile(`(?is)<style[^>]*>.*?</style>`)
	html = styleRe.ReplaceAllString(html, "")

	// 移除 HTML 注释
	commentRe := regexp.MustCompile(`<!--.*?-->`)
	html = commentRe.ReplaceAllString(html, "")

	// 移除所有 HTML 标签
	tagRe := regexp.MustCompile(`<[^>]+>`)
	text := tagRe.ReplaceAllString(html, "\n")

	// 解码 HTML 实体
	text = strings.ReplaceAll(text, "&nbsp;", " ")
	text = strings.ReplaceAll(text, "&lt;", "<")
	text = strings.ReplaceAll(text, "&gt;", ">")
	text = strings.ReplaceAll(text, "&amp;", "&")
	text = strings.ReplaceAll(text, "&quot;", "\"")
	text = strings.ReplaceAll(text, "&#39;", "'")
	text = strings.ReplaceAll(text, "&apos;", "'")

	// 清理空白
	lines := strings.Split(text, "\n")
	var cleanedLines []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			cleanedLines = append(cleanedLines, trimmed)
		}
	}

	return strings.Join(cleanedLines, "\n")
}

// htmlToMarkdown 简单的 HTML 转 Markdown
func (t *WebFetchTool) htmlToMarkdown(html string) string {
	// 简化实现：先获取纯文本，然后做简单转换
	text := t.stripHTML(html)

	// 简单的标题转换
	text = regexp.MustCompile(`(?m)^#{1,6}\s+(.+)$`).ReplaceAllString(text, "# $1")

	// 简单的链接转换
	text = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`).ReplaceAllString(text, "$1 ($2)")

	// 简单的加粗
	text = regexp.MustCompile(`\*\*(.+?)\*\*`).ReplaceAllString(text, "**$1**")
	text = regexp.MustCompile(`__(.+?)__`).ReplaceAllString(text, "**$1**")

	// 简单的斜体
	text = regexp.MustCompile(`\*(.+?)\*`).ReplaceAllString(text, "*$1*")
	text = regexp.MustCompile(`_(.+?)_`).ReplaceAllString(text, "*$1*")

	return text
}

// 确保实现 tool.Tool 接口
var _ tool.Tool = (*WebFetchTool)(nil)
