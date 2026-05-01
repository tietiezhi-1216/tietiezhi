package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"tietiezhi/internal/skill"
)

// MCPManager MCP 管理器，管理所有 MCP 客户端生命周期
type MCPManager struct {
	clients map[string]*MCPClient // serverName -> client
	toolMap map[string]string    // mcp__{server}__{tool} -> serverName
	mu      sync.RWMutex
}

// MCPToolDef MCP 工具定义
type MCPToolDef struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"inputSchema"`
}

// NewMCPManager 创建 MCP 管理器
func NewMCPManager() *MCPManager {
	return &MCPManager{
		clients: make(map[string]*MCPClient),
		toolMap: make(map[string]string),
	}
}

// Connect 连接到 MCP 服务器（基于技能定义）
func (m *MCPManager) Connect(skillDef *skill.SkillDef) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	for serverName, serverConfig := range skillDef.MCPServers {
		// 检查是否已连接
		if _, exists := m.clients[serverName]; exists {
			log.Printf("MCP 服务器 %s 已连接，跳过", serverName)
			continue
		}

		client, err := newMCPClient(serverName, serverConfig)
		if err != nil {
			return fmt.Errorf("连接 MCP 服务器 %s 失败: %w", serverName, err)
		}

		if err := client.Connect(); err != nil {
			return fmt.Errorf("MCP 服务器 %s 初始化失败: %w", serverName, err)
		}

		m.clients[serverName] = client

		// 更新工具映射
		for _, tool := range client.tools {
			toolName := fmt.Sprintf("mcp__%s__%s", serverName, tool.Name)
			m.toolMap[toolName] = serverName
		}

		log.Printf("MCP 服务器 %s 已连接，发现 %d 个工具", serverName, len(client.tools))
	}

	return nil
}

// CallTool 调用 MCP 工具
func (m *MCPManager) CallTool(toolName string, args map[string]interface{}) (string, error) {
	m.mu.RLock()
	serverName, ok := m.toolMap[toolName]
	if !ok {
		m.mu.RUnlock()
		return "", fmt.Errorf("未知 MCP 工具: %s", toolName)
	}
	client, ok := m.clients[serverName]
	m.mu.RUnlock()

	if !ok {
		return "", fmt.Errorf("MCP 服务器 %s 未连接", serverName)
	}

	// 提取实际工具名（去掉 mcp__{server}__ 前缀）
	parts := strings.SplitN(toolName, "__", 3)
	if len(parts) != 3 {
		return "", fmt.Errorf("工具名格式错误: %s", toolName)
	}
	actualToolName := parts[2]

	result, err := client.CallTool(actualToolName, args)
	if err != nil {
		return "", fmt.Errorf("调用工具 %s 失败: %w", toolName, err)
	}

	return result, nil
}

// GetTools 获取所有已连接 MCP 服务器的工具列表
func (m *MCPManager) GetTools() []MCPToolDef {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var tools []MCPToolDef
	for _, client := range m.clients {
		tools = append(tools, client.tools...)
	}
	return tools
}

// Close 关闭所有 MCP 连接
func (m *MCPManager) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	var errs []string
	for serverName, client := range m.clients {
		if err := client.Close(); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", serverName, err))
		}
		delete(m.clients, serverName)
	}

	// 清空工具映射
	for k := range m.toolMap {
		delete(m.toolMap, k)
	}

	if len(errs) > 0 {
		return fmt.Errorf("关闭 MCP 连接时出错: %s", strings.Join(errs, "; "))
	}

	log.Printf("MCP 管理器已关闭")
	return nil
}

// MCPClient MCP 协议客户端（stdio transport）
type MCPClient struct {
	name    string
	config  skill.MCPServerConfig
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	stdout  *bufio.Scanner
	stderr  io.Closer
	tools   []MCPToolDef
	mu      sync.Mutex
	reqID   int
	done    chan struct{}
}

// newMCPClient 创建 MCP 客户端实例
func newMCPClient(name string, config skill.MCPServerConfig) (*MCPClient, error) {
	return &MCPClient{
		name:   name,
		config: config,
		reqID:  0,
		done:   make(chan struct{}),
	}, nil
}

// Connect 连接到 MCP 服务器并初始化
func (c *MCPClient) Connect() error {
	// 构建命令
	cmd := exec.Command(c.config.Command, c.config.Args...)

	// 设置环境变量
	cmd.Env = os.Environ()
	for k, v := range c.config.Env {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}

	// 使用 cmd.StdinPipe() 获取 stdin 管道（正确连接到 MCP 进程）
	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("创建 stdin pipe 失败: %w", err)
	}

	// 使用 cmd.StdoutPipe() 获取 stdout 管道（正确连接到 MCP 进程）
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("创建 stdout pipe 失败: %w", err)
	}

	// 使用 cmd.StderrPipe() 获取 stderr 管道
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("创建 stderr pipe 失败: %w", err)
	}

	// 启动进程
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动 MCP 进程失败: %w", err)
	}

	// 设置成员变量
	c.cmd = cmd
	c.stdin = stdinPipe
	c.stderr = stderrPipe
	c.stdout = bufio.NewScanner(stdoutPipe)
	c.stdout.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB buffer

	// 读取 stderr（异步，防止阻塞）
	go func() {
		scanner := bufio.NewScanner(stderrPipe)
		for scanner.Scan() {
			log.Printf("[MCP %s stderr] %s", c.name, scanner.Text())
		}
	}()

	// 初始化：发送 initialize
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// 等待进程准备好
	time.Sleep(500 * time.Millisecond)

	// 发送 initialize
	c.mu.Lock()
	initReq := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      c.nextReqIDLocked(),
		"method":  "initialize",
		"params": map[string]interface{}{
			"protocolVersion": "2024-11-05",
			"capabilities": map[string]interface{}{
				"roots": map[string]interface{}{
					"listChanged": true,
				},
			},
			"clientInfo": map[string]interface{}{
				"name":    "tietiezhi",
				"version": "1.0.0",
			},
		},
	}
	c.mu.Unlock()

	if err := c.sendRequest(ctx, initReq); err != nil {
		c.Close()
		return fmt.Errorf("发送 initialize 失败: %w", err)
	}

	// 读取响应
	resp, err := c.readResponse(ctx)
	if err != nil {
		c.Close()
		return fmt.Errorf("读取 initialize 响应失败: %w", err)
	}

	// 检查是否有错误
	if errResp, ok := resp["error"]; ok {
		c.Close()
		return fmt.Errorf("initialize 返回错误: %v", errResp)
	}

	log.Printf("[MCP %s] 初始化成功", c.name)

	// 发送 notifications/initialized
	notif := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "notifications/initialized",
		"params":  map[string]interface{}{},
	}
	c.sendNotification(notif)

	// 调用 tools/list 获取工具列表
	c.mu.Lock()
	toolsReq := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      c.nextReqIDLocked(),
		"method":  "tools/list",
		"params":  map[string]interface{}{},
	}
	c.mu.Unlock()

	if err := c.sendRequest(ctx, toolsReq); err != nil {
		c.Close()
		return fmt.Errorf("发送 tools/list 失败: %w", err)
	}

	// 读取 tools/list 响应
	toolsResp, err := c.readResponse(ctx)
	if err != nil {
		c.Close()
		return fmt.Errorf("读取 tools/list 响应失败: %w", err)
	}

	// 解析工具列表
	if result, ok := toolsResp["result"].(map[string]interface{}); ok {
		if tools, ok := result["tools"].([]interface{}); ok {
			for _, t := range tools {
				if toolMap, ok := t.(map[string]interface{}); ok {
					tool := MCPToolDef{
						Name:        getString(toolMap, "name"),
						Description: getString(toolMap, "description"),
						InputSchema: getMap(toolMap, "inputSchema"),
					}
					c.tools = append(c.tools, tool)
				}
			}
		}
	}

	log.Printf("[MCP %s] 发现 %d 个工具: %v", c.name, len(c.tools), c.getToolNames())
	return nil
}

// CallTool 调用 MCP 工具
func (c *MCPClient) CallTool(name string, args map[string]interface{}) (string, error) {
	c.mu.Lock()
	c.reqID++ // 递增请求 ID
	reqID := c.reqID
	c.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// 构建请求
	req := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      reqID,
		"method":  "tools/call",
		"params": map[string]interface{}{
			"name":      name,
			"arguments": args,
		},
	}

	if err := c.sendRequest(ctx, req); err != nil {
		return "", fmt.Errorf("发送 tools/call 失败: %w", err)
	}

	// 读取响应
	resp, err := c.readResponse(ctx)
	if err != nil {
		return "", fmt.Errorf("读取 tools/call 响应失败: %w", err)
	}

	// 检查错误
	if errResp, ok := resp["error"]; ok {
		return "", fmt.Errorf("tools/call 返回错误: %v", errResp)
	}

	// 解析结果
	if result, ok := resp["result"].(map[string]interface{}); ok {
		// 尝试获取 content
		if content, ok := result["content"].([]interface{}); ok {
			var sb strings.Builder
			for _, item := range content {
				if itemMap, ok := item.(map[string]interface{}); ok {
					if text, ok := itemMap["text"].(string); ok {
						sb.WriteString(text)
					}
				}
			}
			return sb.String(), nil
		}

		// 直接返回整个 result
		jsonBytes, _ := json.Marshal(result)
		return string(jsonBytes), nil
	}

	return "", fmt.Errorf("响应格式错误")
}

// Close 关闭 MCP 连接
func (c *MCPClient) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	// 先关闭 stdin pipe，通知进程输入结束
	if c.stdin != nil {
		c.stdin.Close()
		c.stdin = nil
	}

	// 关闭 stderr pipe
	if c.stderr != nil {
		c.stderr.Close()
		c.stderr = nil
	}

	// Kill 进程并等待其退出
	if c.cmd != nil && c.cmd.Process != nil {
		c.cmd.Process.Kill()
		c.cmd.Wait()
		c.cmd = nil
	}

	// 关闭 done channel
	close(c.done)

	return nil
}

// sendRequest 发送请求（带锁，确保并发安全）
func (c *MCPClient) sendRequest(ctx context.Context, req map[string]interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	// 检查 stdin 是否已关闭
	if c.stdin == nil {
		return fmt.Errorf("stdin pipe 已关闭")
	}

	jsonBytes, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("序列化请求失败: %w", err)
	}

	// 写入 JSON-RPC 消息
	_, err = c.stdin.Write(jsonBytes)
	if err != nil {
		return fmt.Errorf("发送请求失败: %w", err)
	}
	// 添加换行符（MCP 协议使用 JSON-RPC 2.0，每条消息一行）
	_, err = c.stdin.Write([]byte("\n"))
	if err != nil {
		return fmt.Errorf("发送换行符失败: %w", err)
	}

	return nil
}

// sendNotification 发送通知（无响应，带锁）
func (c *MCPClient) sendNotification(notif map[string]interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// 检查 stdin 是否已关闭
	if c.stdin == nil {
		log.Printf("[MCP %s] stdin pipe 已关闭，跳过通知", c.name)
		return
	}

	jsonBytes, _ := json.Marshal(notif)
	c.stdin.Write(jsonBytes)
	c.stdin.Write([]byte("\n"))
}

// readResponse 读取响应
func (c *MCPClient) readResponse(ctx context.Context) (map[string]interface{}, error) {
	responseCh := make(chan map[string]interface{})
	errorCh := make(chan error)

	go func() {
		if c.stdout.Scan() {
			line := c.stdout.Text()
			var resp map[string]interface{}
			if err := json.Unmarshal([]byte(line), &resp); err != nil {
				errorCh <- fmt.Errorf("解析响应失败: %w", err)
				return
			}
			responseCh <- resp
		} else {
			errorCh <- fmt.Errorf("读取响应失败: stdout 已关闭")
		}
	}()

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.done:
		return nil, fmt.Errorf("客户端已关闭")
	case resp := <-responseCh:
		return resp, nil
	case err := <-errorCh:
		return nil, err
	}
}

// nextReqIDLocked 生成下一个请求 ID（内部方法，已持有锁）
func (c *MCPClient) nextReqIDLocked() int {
	id := c.reqID
	c.reqID++
	return id
}

// getToolNames 获取所有工具名
func (c *MCPClient) getToolNames() []string {
	var names []string
	for _, t := range c.tools {
		names = append(names, t.Name)
	}
	return names
}

// 辅助函数：安全获取字符串
func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// 辅助函数：安全获取 map
func getMap(m map[string]interface{}, key string) map[string]interface{} {
	if v, ok := m[key].(map[string]interface{}); ok {
		return v
	}
	return nil
}
