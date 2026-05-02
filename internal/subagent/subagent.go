package subagent

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tietiezhi/internal/llm"
	"github.com/google/uuid"
)

// SpawnRequest spawn 请求
type SpawnRequest struct {
	Task        string   // 任务描述
	Label       string   // 标签
	Timeout     int      // 超时秒数（默认300）
	ParentKey   string   // 父会话 key
	ChatID      string   // 投递目标的飞书 chatID
	IsGroup     bool     // 是否群聊
	Instruction string   // 自定义 system prompt，覆盖主 Agent 的 systemPrompt
	Tools       []string // 工具白名单（空=全部可用工具）
	Model       string   // 模型选择："main"(默认) 或 "cheap"
	Sync        bool     // 同步模式：true=阻塞等待结果返回，false=异步投递飞书
	Files       []string // 共享文件路径列表
	SessionMode string   // 会话模式："ephemeral"(默认) 或 "persistent"
}

// SpawnResult spawn 结果
type SpawnResult struct {
	SpawnID    string     `json:"spawn_id"`    // spawn ID（uuid）
	SessionKey string     `json:"session_key"` // 子代理的 session key
	Status     string     `json:"status"`      // pending / running / completed / failed / timeout
	Result     string     `json:"result"`      // 执行结果（completed 时）
	Error      string     `json:"error"`       // 错误信息（failed 时）
	Label      string     `json:"label"`       // 标签
	StartedAt  time.Time  `json:"started_at"`
	EndedAt    *time.Time `json:"ended_at,omitempty"`
}

// RunOptions 子代理运行选项
type RunOptions struct {
	SystemPromptOverride string   // 覆盖 system prompt
	ToolWhitelist        []string // 工具白名单（空=全部）
	UseCheapModel        bool     // 使用轻量模型
}

// SubAgentManager 子代理管理器
type SubAgentManager struct {
	agent interface {
		RunSubAgent(ctx context.Context, sessionKey string, isGroup bool, role, content string, opts *RunOptions) (string, error)
	}
	deliveryFn     func(chatID, content string) error // 投递函数
	mu             sync.RWMutex
	spawns         map[string]*SpawnResult // spawnID -> result（内存追踪）
	storePath      string                   // 持久化路径
	defaultTimeout int                      // 默认超时秒数
}

// NewSubAgentManager 创建管理器
func NewSubAgentManager(storePath string, defaultTimeout int) *SubAgentManager {
	// 如果 storePath 不是以 .json 结尾，自动追加 /spawns.json
	finalPath := storePath
	if !strings.HasSuffix(finalPath, ".json") {
		finalPath = filepath.Join(storePath, "spawns.json")
	}

	if defaultTimeout <= 0 {
		defaultTimeout = 300
	}

	return &SubAgentManager{
		spawns:        make(map[string]*SpawnResult),
		storePath:     finalPath,
		defaultTimeout: defaultTimeout,
	}
}

// SetAgent 设置 Agent（用于执行子代理任务）
func (m *SubAgentManager) SetAgent(ag interface{}) {
	m.agent = ag.(interface {
		RunSubAgent(ctx context.Context, sessionKey string, isGroup bool, role, content string, opts *RunOptions) (string, error)
	})
}

// SetDeliveryFn 设置投递函数
func (m *SubAgentManager) SetDeliveryFn(fn func(chatID, content string) error) {
	m.deliveryFn = fn
}

// buildSessionKey 生成子代理 session key
func (m *SubAgentManager) buildSessionKey(req SpawnRequest) string {
	parentKey := req.ParentKey
	if parentKey == "" {
		parentKey = "unknown"
	}

	// Persistent 模式：使用固定 key 格式，同 label 复用
	if req.SessionMode == "persistent" && req.Label != "" {
		return fmt.Sprintf("sub-persist:%s", req.Label)
	}

	// Ephemeral 模式（默认）：每次新会话
	spawnID := uuid.New().String()
	return fmt.Sprintf("sub:%s:%s", parentKey, spawnID[:8])
}

// buildRunOptions 根据 SpawnRequest 构建 RunOptions
func (m *SubAgentManager) buildRunOptions(req SpawnRequest) *RunOptions {
	opts := &RunOptions{}

	// 工具白名单
	if len(req.Tools) > 0 {
		opts.ToolWhitelist = req.Tools
	}

	// 模型选择
	if req.Model == "cheap" {
		opts.UseCheapModel = true
	}

	// System prompt 覆盖
	if req.Instruction != "" {
		opts.SystemPromptOverride = req.Instruction
	}

	return opts
}

// buildTaskContent 在任务内容中注入文件信息
func (m *SubAgentManager) buildTaskContent(req SpawnRequest) string {
	content := req.Task

	// 注入共享文件信息
	if len(req.Files) > 0 {
		var fileList string
		for _, f := range req.Files {
			fileList += fmt.Sprintf("- %s\n", f)
		}
		content += fmt.Sprintf("\n\n## 可用文件\n以下文件可供你使用：\n%s你可以使用 file_read 工具读取这些文件。", fileList)
	}

	return content
}

// Spawn 启动子代理（非阻塞）
func (m *SubAgentManager) Spawn(req SpawnRequest) (*SpawnResult, error) {
	// 生成 spawnID（仅 persistent 模式不需要 uuid）
	spawnID := uuid.New().String()

	// 生成 sessionKey
	sessionKey := m.buildSessionKey(req)

	// 设置默认超时
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = m.defaultTimeout
	}

	// 创建结果记录
	result := &SpawnResult{
		SpawnID:    spawnID,
		SessionKey:  sessionKey,
		Status:     "pending",
		Label:      req.Label,
		StartedAt:  time.Now(),
	}

	// 内存追踪
	m.mu.Lock()
	m.spawns[spawnID] = result
	m.mu.Unlock()

	// 构建运行选项
	opts := m.buildRunOptions(req)

	// 异步执行
	go m.executeSpawn(spawnID, sessionKey, timeout, req, opts)

	return result, nil
}

// SpawnSync 同步启动子代理（阻塞等待结果）
func (m *SubAgentManager) SpawnSync(req SpawnRequest) (*SpawnResult, error) {
	// 生成 spawnID
	spawnID := uuid.New().String()

	// 生成 sessionKey
	sessionKey := m.buildSessionKey(req)

	// 设置默认超时
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = m.defaultTimeout
	}

	// 创建结果记录
	result := &SpawnResult{
		SpawnID:    spawnID,
		SessionKey:  sessionKey,
		Status:     "pending",
		Label:      req.Label,
		StartedAt:  time.Now(),
	}

	// 内存追踪
	m.mu.Lock()
	m.spawns[spawnID] = result
	m.mu.Unlock()

	// 构建运行选项
	opts := m.buildRunOptions(req)

	// 创建超时 context
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
	defer cancel()

	log.Printf("[SubAgent] 同步执行子代理任务: spawnID=%s, label=%s, timeout=%ds", spawnID, req.Label, timeout)

	// 构建任务内容（注入文件信息）
	taskContent := m.buildTaskContent(req)

	// 同步执行
	reply, err := m.agent.RunSubAgent(ctx, sessionKey, req.IsGroup, "user", taskContent, opts)

	// 更新结果
	m.mu.Lock()
	spawn, ok := m.spawns[spawnID]
	if !ok {
		m.mu.Unlock()
		return nil, fmt.Errorf("spawn 不存在: %s", spawnID)
	}

	now := time.Now()
	spawn.EndedAt = &now

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			spawn.Status = "timeout"
			spawn.Error = fmt.Sprintf("任务执行超时（%d秒）", timeout)
			log.Printf("[SubAgent] 子代理任务超时: spawnID=%s", spawnID)
		} else {
			spawn.Status = "failed"
			spawn.Error = err.Error()
			log.Printf("[SubAgent] 子代理任务失败: spawnID=%s, error=%v", spawnID, err)
		}
	} else {
		spawn.Status = "completed"
		spawn.Result = reply
		log.Printf("[SubAgent] 子代理任务完成: spawnID=%s", spawnID)
	}
	m.mu.Unlock()

	// 持久化
	m.saveSpawns()

	// 同步模式下不投递飞书，直接返回结果
	return result, nil
}

// executeSpawn 执行子代理任务
func (m *SubAgentManager) executeSpawn(spawnID, sessionKey string, timeout int, req SpawnRequest, opts *RunOptions) {
	// 更新状态为 running
	m.mu.Lock()
	if spawn, ok := m.spawns[spawnID]; ok {
		spawn.Status = "running"
	}
	m.mu.Unlock()

	log.Printf("[SubAgent] 开始执行子代理任务: spawnID=%s, label=%s, timeout=%ds", spawnID, req.Label, timeout)

	// 创建超时 context
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
	defer cancel()

	// 构建任务内容（注入文件信息）
	taskContent := m.buildTaskContent(req)

	// 执行任务
	reply, err := m.agent.RunSubAgent(ctx, sessionKey, req.IsGroup, "user", taskContent, opts)

	// 更新结果
	m.mu.Lock()
	spawn, ok := m.spawns[spawnID]
	if !ok {
		m.mu.Unlock()
		return
	}

	now := time.Now()
	spawn.EndedAt = &now

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			spawn.Status = "timeout"
			spawn.Error = fmt.Sprintf("任务执行超时（%d秒）", timeout)
			log.Printf("[SubAgent] 子代理任务超时: spawnID=%s", spawnID)
		} else {
			spawn.Status = "failed"
			spawn.Error = err.Error()
			log.Printf("[SubAgent] 子代理任务失败: spawnID=%s, error=%v", spawnID, err)
		}
	} else {
		spawn.Status = "completed"
		spawn.Result = reply
		log.Printf("[SubAgent] 子代理任务完成: spawnID=%s", spawnID)
	}
	m.mu.Unlock()

	// 持久化
	m.saveSpawns()

	// 投递结果
	m.deliverResult(spawnID, req.ChatID, req.Label)
}

// deliverResult 投递结果到父会话
func (m *SubAgentManager) deliverResult(spawnID, chatID, label string) {
	if m.deliveryFn == nil || chatID == "" {
		return
	}

	m.mu.RLock()
	spawn, ok := m.spawns[spawnID]
	if !ok {
		m.mu.RUnlock()
		return
	}

	// 复制结果以防并发问题
	status := spawn.Status
	result := spawn.Result
	errMsg := spawn.Error
	labelVal := spawn.Label
	m.mu.RUnlock()

	var content string
	switch status {
	case "completed":
		if labelVal != "" {
			content = fmt.Sprintf("[子代理 %s] 任务完成：\n%s", labelVal, result)
		} else {
			content = fmt.Sprintf("[子代理] 任务完成：\n%s", result)
		}
	case "failed":
		if labelVal != "" {
			content = fmt.Sprintf("[子代理 %s] 任务失败：\n%s", labelVal, errMsg)
		} else {
			content = fmt.Sprintf("[子代理] 任务失败：\n%s", errMsg)
		}
	case "timeout":
		if labelVal != "" {
			content = fmt.Sprintf("[子代理 %s] 任务超时：\n%s", labelVal, errMsg)
		} else {
			content = fmt.Sprintf("[子代理] 任务超时：\n%s", errMsg)
		}
	default:
		return
	}

	if err := m.deliveryFn(chatID, content); err != nil {
		log.Printf("[SubAgent] 结果投递失败: spawnID=%s, error=%v", spawnID, err)
	} else {
		log.Printf("[SubAgent] 结果已投递: spawnID=%s, status=%s", spawnID, status)
	}
}

// GetSpawn 获取 spawn 状态
func (m *SubAgentManager) GetSpawn(spawnID string) (*SpawnResult, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	spawn, ok := m.spawns[spawnID]
	if !ok {
		return nil, fmt.Errorf("spawn 不存在: %s", spawnID)
	}

	// 复制结果
	result := *spawn
	return &result, nil
}

// ListSpawns 列出所有 spawn
func (m *SubAgentManager) ListSpawns() []*SpawnResult {
	m.mu.RLock()
	defer m.mu.RUnlock()

	results := make([]*SpawnResult, 0, len(m.spawns))
	for _, spawn := range m.spawns {
		result := *spawn
		results = append(results, &result)
	}
	return results
}

// GetSpawnTools 获取 subagent 工具定义
func (m *SubAgentManager) GetSpawnTools() []llm.ToolDef {
	return GetSubAgentTools()
}

// saveSpawns 持久化 spawn 结果
func (m *SubAgentManager) saveSpawns() error {
	m.mu.RLock()
	defer m.mu.RUnlock()

	dir := filepath.Dir(m.storePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("创建目录失败: %w", err)
	}

	data, err := json.MarshalIndent(m.spawns, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化失败: %w", err)
	}

	if err := os.WriteFile(m.storePath, data, 0644); err != nil {
		return fmt.Errorf("写入文件失败: %w", err)
	}

	return nil
}

// loadSpawns 加载 spawn 结果
func (m *SubAgentManager) loadSpawns() error {
	dir := filepath.Dir(m.storePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("创建目录失败: %w", err)
	}

	if _, err := os.Stat(m.storePath); os.IsNotExist(err) {
		return nil
	}

	data, err := os.ReadFile(m.storePath)
	if err != nil {
		return fmt.Errorf("读取文件失败: %w", err)
	}

	if len(data) == 0 {
		return nil
	}

	var spawns map[string]*SpawnResult
	if err := json.Unmarshal(data, &spawns); err != nil {
		return fmt.Errorf("解析文件失败: %w", err)
	}

	m.mu.Lock()
	m.spawns = spawns
	m.mu.Unlock()

	log.Printf("已加载 %d 个子代理任务", len(spawns))
	return nil
}
