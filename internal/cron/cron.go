package cron

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

	"github.com/google/uuid"
	"github.com/robfig/cron/v3"

	"tietiezhi/internal/llm"
)

// PendingEvent 待处理事件（Main 模式）
type PendingEvent struct {
	ID       string    `json:"id"`       // UUID
	JobID    string     `json:"job_id"`   // 来源任务 ID
	JobName  string     `json:"job_name"` // 任务名称
	Message  string     `json:"message"`  // 执行提示词
	FiredAt  time.Time  `json:"fired_at"` // 触发时间
	ChatID   string     `json:"chat_id"`  // 投递目标
	IsGroup  bool       `json:"is_group"` // 是否群聊
}

// CronJob 定时任务
type CronJob struct {
	ID             string     `json:"id"`              // UUID
	Name           string     `json:"name"`            // 任务名称
	Message        string     `json:"message"`         // 执行提示词
	Schedule       Schedule   `json:"schedule"`        // 调度规则
	Enabled        bool       `json:"enabled"`         // 是否启用
	DeleteAfterRun bool       `json:"delete_after_run"` // 一次性任务执行后删除
	CreatedAt      time.Time  `json:"created_at"`
	LastRunAt      *time.Time `json:"last_run_at,omitempty"`
	NextRunAt      *time.Time `json:"next_run_at,omitempty"`
	RunCount       int        `json:"run_count"`
	SessionKey     string     `json:"session_key"` // 来源会话 key（投递目标）
	IsGroup        bool       `json:"is_group"`    // 来源是否群聊
	ChatID         string     `json:"chat_id"`     // 飞书聊天 ID（投递目标）
	MessageID      string     `json:"message_id"`  // 来源消息 ID（用于 Reply）
	Mode           string     `json:"mode"`        // 执行模式：isolated=独立session，main=注入heartbeat
}

// Schedule 调度规则
type Schedule struct {
	Kind    string `json:"kind"`              // "at" / "every" / "cron"
	At      string `json:"at,omitempty"`      // ISO时间戳 (kind=at)
	EveryMs int64  `json:"every_ms,omitempty"` // 间隔毫秒 (kind=every)
	Expr    string `json:"expr,omitempty"`     // 5位cron表达式 (kind=cron)
	TZ      string `json:"tz,omitempty"`      // 时区，默认 Asia/Shanghai
}

// CronManager 定时任务管理器
type CronManager struct {
	jobs        map[string]*CronJob    // jobID -> job
	cronLib     *cron.Cron             // robfig/cron 调度器
	entryIDs    map[string]cron.EntryID // jobID -> cron.EntryID
	storePath   string                 // jobs.json 路径
	pendingPath string                 // pending.json 路径
	execTimeout time.Duration          // 执行超时
	agent       interface {
		RunCron(ctx context.Context, sessionKey string, isGroup bool, role, content string) (string, error)
	}
	deliveryFn func(chatID, content string) error // 投递函数
	mu         sync.RWMutex
	started    bool
}

// NewCronManager 创建定时任务管理器
func NewCronManager(storePath string, execTimeout int) *CronManager {
	// 如果 storePath 不是以 .json 结尾，自动追加 /jobs.json
	finalPath := storePath
	if !strings.HasSuffix(finalPath, ".json") {
		finalPath = finalPath + "/jobs.json"
	}
	// pending.json 存放在同一目录
	pendingPath := filepath.Join(filepath.Dir(finalPath), "pending.json")
	
	if execTimeout <= 0 {
		execTimeout = 300
	}
	m := &CronManager{
		jobs:        make(map[string]*CronJob),
		entryIDs:    make(map[string]cron.EntryID),
		storePath:   finalPath,
		pendingPath: pendingPath,
		execTimeout: time.Duration(execTimeout) * time.Second,
	}
	return m
}

// SetAgent 设置 Agent（用于执行任务）
func (m *CronManager) SetAgent(ag interface{}) {
	// 直接断言为包含 RunCron 方法的类型
	if a, ok := ag.(interface {
		RunCron(ctx context.Context, sessionKey string, isGroup bool, role, content string) (string, error)
	}); ok {
		m.agent = a
		return
	}
	
	// 如果失败，使用包装器
	m.agent = &cronAgentWrapper{agent: ag}
}

// cronAgentWrapper 包装器
type cronAgentWrapper struct {
	agent interface{}
}

// RunCron 执行 cron 任务（包装器）
func (w *cronAgentWrapper) RunCron(ctx context.Context, sessionKey string, isGroup bool, role, content string) (string, error) {
	type runner interface {
		RunCron(ctx context.Context, sessionKey string, isGroup bool, input interface{}) (interface{}, error)
	}
	
	if r, ok := w.agent.(runner); ok {
		// 构造消息输入
		input := map[string]interface{}{
			"Role":    role,
			"Content": content,
		}
		
		result, err := r.RunCron(ctx, sessionKey, isGroup, input)
		if err != nil {
			return "", err
		}
		
		// 提取回复内容
		if result == nil {
			return "", nil
		}
		
		// 尝试提取 Content
		if m, ok := result.(map[string]interface{}); ok {
			if c, ok := m["Content"].(string); ok {
				return c, nil
			}
		}
		if s, ok := result.(string); ok {
			return s, nil
		}
		
		return "", nil
	}
	
	return "", fmt.Errorf("agent 不支持 RunCron 方法")
}

// SetDeliveryFn 设置投递函数
func (m *CronManager) SetDeliveryFn(fn func(chatID, content string) error) {
	m.deliveryFn = fn
}

// Start 启动调度器
func (m *CronManager) Start(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.started {
		return nil
	}

	// 加载已有任务
	if err := m.loadJobs(); err != nil {
		log.Printf("加载定时任务失败: %v", err)
	}

	// 创建 cron 调度器
	m.cronLib = cron.New(cron.WithSeconds())

	// 为每个已启用的任务注册调度
	for _, job := range m.jobs {
		if job.Enabled {
			m.scheduleJob(job)
		}
	}

	// 启动调度器
	m.cronLib.Start()
	m.started = true
	log.Printf("定时任务调度器已启动，共 %d 个任务", len(m.jobs))

	return nil
}

// Stop 停止调度器
func (m *CronManager) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.started || m.cronLib == nil {
		return nil
	}

	ctx := m.cronLib.Stop()
	<-ctx.Done()
	m.started = false
	log.Println("定时任务调度器已停止")

	return nil
}

// scheduleJob 为任务注册调度
func (m *CronManager) scheduleJob(job *CronJob) {
	var spec string

	switch job.Schedule.Kind {
	case "every":
		ms := job.Schedule.EveryMs
		if ms <= 0 {
			log.Printf("定时任务 %s 的间隔配置无效: %d", job.Name, ms)
			return
		}
		if ms >= 1000 {
			spec = fmt.Sprintf("@every %ds", ms/1000)
		} else {
			spec = fmt.Sprintf("@every %dms", ms)
		}
	case "cron":
		expr := job.Schedule.Expr
		if expr == "" {
			log.Printf("定时任务 %s 的 cron 表达式为空", job.Name)
			return
		}
		parts := strings.Fields(expr)
		if len(parts) != 5 {
			log.Printf("定时任务 %s 的 cron 表达式格式错误: %s", job.Name, expr)
			return
		}
		spec = "0 " + expr
	case "at":
		if job.Schedule.At == "" {
			log.Printf("定时任务 %s 的 at 时间为空", job.Name)
			return
		}
		at, err := time.Parse(time.RFC3339, job.Schedule.At)
		if err != nil {
			log.Printf("定时任务 %s 的 at 时间解析失败: %v", job.Name, err)
			return
		}
		delay := time.Until(at)
		if delay <= 0 {
			log.Printf("定时任务 %s 的 at 时间已过: %s", job.Name, job.Schedule.At)
			return
		}
		go func(j *CronJob, d time.Duration) {
			time.Sleep(d)
			m.executeJob(j)
		}(job, delay)
		job.NextRunAt = &at
		return
	default:
		log.Printf("定时任务 %s 的调度类型未知: %s", job.Name, job.Schedule.Kind)
		return
	}

	entryID, err := m.cronLib.AddFunc(spec, func() {
		m.executeJob(job)
	})
	if err != nil {
		log.Printf("定时任务 %s 注册调度失败: %v", job.Name, err)
		return
	}

	m.entryIDs[job.ID] = entryID

	entry := m.cronLib.Entry(entryID)
	if entry.ID > 0 {
		next := entry.Next
		job.NextRunAt = &next
	}
}

// unscheduleJob 取消任务调度
func (m *CronManager) unscheduleJob(jobID string) {
	if entryID, ok := m.entryIDs[jobID]; ok {
		m.cronLib.Remove(entryID)
		delete(m.entryIDs, jobID)
	}
}

// executeJob 执行定时任务
func (m *CronManager) executeJob(job *CronJob) {
	log.Printf("开始执行定时任务: %s (ID: %s, Mode: %s)", job.Name, job.ID, job.Mode)

	// Main 模式：写入 pending 队列，等待 Heartbeat 处理
	if job.Mode == "main" {
		event := PendingEvent{
			ID:      uuid.New().String(),
			JobID:   job.ID,
			JobName: job.Name,
			Message: job.Message,
			FiredAt: time.Now(),
			ChatID:  job.ChatID,
			IsGroup: job.IsGroup,
		}
		if err := m.AddPendingEvent(&event); err != nil {
			log.Printf("添加 pending 事件失败: %v", err)
		} else {
			log.Printf("Main 模式任务已加入 pending 队列: %s", job.Name)
		}
		
		// 更新统计
		m.mu.Lock()
		job.RunCount++
		now := time.Now()
		job.LastRunAt = &now
		
		if job.DeleteAfterRun {
			m.unscheduleJob(job.ID)
			delete(m.jobs, job.ID)
			log.Printf("一次性定时任务已完成并删除: %s", job.Name)
		} else {
			if entryID, ok := m.entryIDs[job.ID]; ok {
				entry := m.cronLib.Entry(entryID)
				if entry.ID > 0 {
					next := entry.Next
					job.NextRunAt = &next
				}
			}
			m.saveJobs()
		}
		m.mu.Unlock()
		return
	}

	// Isolated 模式：创建独立 session 执行（原有逻辑）
	sessionKey := fmt.Sprintf("cron:%s", job.ID)

	ctx, cancel := context.WithTimeout(context.Background(), m.execTimeout)
	defer cancel()

	reply, err := m.agent.RunCron(ctx, sessionKey, job.IsGroup, "user", job.Message)
	if err != nil {
		log.Printf("定时任务执行失败: %s, error: %v", job.Name, err)
		return
	}

	if m.deliveryFn != nil && reply != "" {
		if err := m.deliveryFn(job.ChatID, reply); err != nil {
			log.Printf("定时任务投递失败: %s, error: %v", job.Name, err)
		} else {
			log.Printf("定时任务投递成功: %s", job.Name)
		}
	}

	m.mu.Lock()
	job.RunCount++
	now := time.Now()
	job.LastRunAt = &now

	if job.DeleteAfterRun {
		m.unscheduleJob(job.ID)
		delete(m.jobs, job.ID)
		log.Printf("一次性定时任务已完成并删除: %s", job.Name)
	} else {
		if entryID, ok := m.entryIDs[job.ID]; ok {
			entry := m.cronLib.Entry(entryID)
			if entry.ID > 0 {
				next := entry.Next
				job.NextRunAt = &next
			}
		}
		m.saveJobs()
	}
	m.mu.Unlock()
}

// AddPendingEvent 添加待处理事件
func (m *CronManager) AddPendingEvent(event *PendingEvent) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	events, err := m.loadPendingEvents()
	if err != nil {
		events = []*PendingEvent{}
	}

	events = append(events, event)

	return m.savePendingEvents(events)
}

// GetPendingEvents 获取所有待处理事件
func (m *CronManager) GetPendingEvents() []*PendingEvent {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	events, _ := m.loadPendingEvents()
	return events
}

// ClearPendingEvents 清空待处理事件
func (m *CronManager) ClearPendingEvents() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	return m.savePendingEvents([]*PendingEvent{})
}

func (m *CronManager) loadPendingEvents() ([]*PendingEvent, error) {
	dir := filepath.Dir(m.pendingPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("创建目录失败: %w", err)
	}

	if _, err := os.Stat(m.pendingPath); os.IsNotExist(err) {
		return []*PendingEvent{}, nil
	}

	data, err := os.ReadFile(m.pendingPath)
	if err != nil {
		return nil, fmt.Errorf("读取文件失败: %w", err)
	}

	if len(data) == 0 {
		return []*PendingEvent{}, nil
	}

	var events []*PendingEvent
	if err := json.Unmarshal(data, &events); err != nil {
		return nil, fmt.Errorf("解析文件失败: %w", err)
	}

	return events, nil
}

func (m *CronManager) savePendingEvents(events []*PendingEvent) error {
	dir := filepath.Dir(m.pendingPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("创建目录失败: %w", err)
	}

	data, err := json.MarshalIndent(events, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化失败: %w", err)
	}

	if err := os.WriteFile(m.pendingPath, data, 0644); err != nil {
		return fmt.Errorf("写入文件失败: %w", err)
	}

	return nil
}

// CreateJob 创建任务
func (m *CronManager) CreateJob(job *CronJob) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if job.ID == "" {
		job.ID = uuid.New().String()
	}
	job.CreatedAt = time.Now()
	
	// 默认 Mode 为 isolated
	if job.Mode == "" {
		job.Mode = "isolated"
	}

	m.jobs[job.ID] = job

	if m.started && job.Enabled {
		m.scheduleJob(job)
	}

	return m.saveJobs()
}

// DeleteJob 删除任务
func (m *CronManager) DeleteJob(jobID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	_, exists := m.jobs[jobID]
	if !exists {
		return fmt.Errorf("任务不存在: %s", jobID)
	}

	m.unscheduleJob(jobID)
	delete(m.jobs, jobID)

	return m.saveJobs()
}

// PauseJob 暂停任务
func (m *CronManager) PauseJob(jobID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	job, exists := m.jobs[jobID]
	if !exists {
		return fmt.Errorf("任务不存在: %s", jobID)
	}

	if !job.Enabled {
		return nil
	}

	job.Enabled = false
	m.unscheduleJob(jobID)

	return m.saveJobs()
}

// ResumeJob 恢复任务
func (m *CronManager) ResumeJob(jobID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	job, exists := m.jobs[jobID]
	if !exists {
		return fmt.Errorf("任务不存在: %s", jobID)
	}

	if job.Enabled {
		return nil
	}

	job.Enabled = true

	if m.started {
		m.scheduleJob(job)
	}

	return m.saveJobs()
}

// ListJobs 列出所有任务
func (m *CronManager) ListJobs() []*CronJob {
	m.mu.RLock()
	defer m.mu.RUnlock()

	jobs := make([]*CronJob, 0, len(m.jobs))
	for _, job := range m.jobs {
		j := *job
		jobs = append(jobs, &j)
	}
	return jobs
}

// GetCronTools 获取 cron_task 工具定义
func (m *CronManager) GetCronTools() []llm.ToolDef {
	return GetCronTools()
}

// ExecuteCronTool 执行 cron 工具调用
func (m *CronManager) ExecuteCronTool(action string, args map[string]interface{}, sessionKey string, isGroup bool, chatID string) string {
	switch action {
	case "create":
		return m.executeCreate(args, sessionKey, isGroup, chatID)
	case "list":
		return m.executeList()
	case "delete":
		return m.executeDelete(args)
	case "pause":
		return m.executePause(args)
	case "resume":
		return m.executeResume(args)
	default:
		return fmt.Sprintf(`{"error": "未知操作: %s"}`, action)
	}
}

func (m *CronManager) executeCreate(args map[string]interface{}, sessionKey string, isGroup bool, chatID string) string {
	name, _ := args["name"].(string)
	message, _ := args["message"].(string)
	scheduleKind, _ := args["schedule_kind"].(string)
	mode, _ := args["mode"].(string)

	if name == "" {
		return `{"error": "任务名称不能为空"}`
	}
	if message == "" {
		return `{"error": "执行提示词不能为空"}`
	}
	if scheduleKind == "" {
		return `{"error": "调度类型不能为空"}`
	}

	// 默认 mode 为 isolated
	if mode == "" {
		mode = "isolated"
	}
	if mode != "isolated" && mode != "main" {
		return fmt.Sprintf(`{"error": "不支持的 mode: %s，支持的值: isolated, main"}`, mode)
	}

	job := &CronJob{
		Name:       name,
		Message:    message,
		Enabled:    true,
		Mode:       mode,
		SessionKey: sessionKey,
		IsGroup:    isGroup,
		ChatID:     chatID,
		Schedule: Schedule{
			Kind: scheduleKind,
		},
	}

	switch scheduleKind {
	case "at":
		at, _ := args["schedule_at"].(string)
		if at == "" {
			return `{"error": "at 类型需要 schedule_at 参数"}`
		}
		job.Schedule.At = at
		job.DeleteAfterRun = true
	case "every":
		everyMs, ok := args["schedule_every_ms"].(float64)
		if !ok || everyMs <= 0 {
			return `{"error": "every 类型需要 schedule_every_ms 参数"}`
		}
		job.Schedule.EveryMs = int64(everyMs)
	case "cron":
		expr, _ := args["schedule_cron"].(string)
		if expr == "" {
			return `{"error": "cron 类型需要 schedule_cron 参数"}`
		}
		job.Schedule.Expr = expr
	default:
		return fmt.Sprintf(`{"error": "不支持的调度类型: %s"}`, scheduleKind)
	}

	if tz, ok := args["schedule_tz"].(string); ok && tz != "" {
		job.Schedule.TZ = tz
	} else {
		job.Schedule.TZ = "Asia/Shanghai"
	}

	if err := m.CreateJob(job); err != nil {
		return fmt.Sprintf(`{"error": "创建任务失败: %v"}`, err)
	}

	return fmt.Sprintf(`{"success": true, "message": "任务已创建", "job_id": "%s", "name": "%s", "mode": "%s"}`, job.ID, job.Name, job.Mode)
}

func (m *CronManager) executeList() string {
	jobs := m.ListJobs()
	if len(jobs) == 0 {
		return `{"jobs": [], "message": "暂无定时任务"}`
	}

	type JobInfo struct {
		ID        string    `json:"id"`
		Name      string    `json:"name"`
		Mode      string    `json:"mode"`
		Schedule  Schedule  `json:"schedule"`
		Enabled   bool      `json:"enabled"`
		RunCount  int       `json:"run_count"`
		LastRunAt *string   `json:"last_run_at,omitempty"`
		NextRunAt *string   `json:"next_run_at,omitempty"`
		CreatedAt string    `json:"created_at"`
	}

	infos := make([]JobInfo, 0, len(jobs))
	for _, job := range jobs {
		info := JobInfo{
			ID:        job.ID,
			Name:      job.Name,
			Mode:      job.Mode,
			Schedule:  job.Schedule,
			Enabled:   job.Enabled,
			RunCount:  job.RunCount,
			CreatedAt: job.CreatedAt.Format(time.RFC3339),
		}
		if job.LastRunAt != nil {
			s := job.LastRunAt.Format(time.RFC3339)
			info.LastRunAt = &s
		}
		if job.NextRunAt != nil {
			s := job.NextRunAt.Format(time.RFC3339)
			info.NextRunAt = &s
		}
		infos = append(infos, info)
	}

	data, _ := json.Marshal(map[string]any{
		"jobs":    infos,
		"message": fmt.Sprintf("共 %d 个定时任务", len(jobs)),
	})
	return string(data)
}

func (m *CronManager) executeDelete(args map[string]interface{}) string {
	jobID, _ := args["job_id"].(string)
	if jobID == "" {
		return `{"error": "job_id 不能为空"}`
	}

	if err := m.DeleteJob(jobID); err != nil {
		return fmt.Sprintf(`{"error": "删除任务失败: %v"}`, err)
	}

	return fmt.Sprintf(`{"success": true, "message": "任务已删除", "job_id": "%s"}`, jobID)
}

func (m *CronManager) executePause(args map[string]interface{}) string {
	jobID, _ := args["job_id"].(string)
	if jobID == "" {
		return `{"error": "job_id 不能为空"}`
	}

	if err := m.PauseJob(jobID); err != nil {
		return fmt.Sprintf(`{"error": "暂停任务失败: %v"}`, err)
	}

	return fmt.Sprintf(`{"success": true, "message": "任务已暂停", "job_id": "%s"}`, jobID)
}

func (m *CronManager) executeResume(args map[string]interface{}) string {
	jobID, _ := args["job_id"].(string)
	if jobID == "" {
		return `{"error": "job_id 不能为空"}`
	}

	if err := m.ResumeJob(jobID); err != nil {
		return fmt.Sprintf(`{"error": "恢复任务失败: %v"}`, err)
	}

	return fmt.Sprintf(`{"success": true, "message": "任务已恢复", "job_id": "%s"}`, jobID)
}

func (m *CronManager) loadJobs() error {
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

	var jobs []*CronJob
	if err := json.Unmarshal(data, &jobs); err != nil {
		return fmt.Errorf("解析文件失败: %w", err)
	}

	for _, job := range jobs {
		// 确保默认 Mode 为 isolated
		if job.Mode == "" {
			job.Mode = "isolated"
		}
		m.jobs[job.ID] = job
	}

	log.Printf("已加载 %d 个定时任务", len(jobs))
	return nil
}

func (m *CronManager) saveJobs() error {
	dir := filepath.Dir(m.storePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("创建目录失败: %w", err)
	}

	jobs := make([]*CronJob, 0, len(m.jobs))
	for _, job := range m.jobs {
		jobs = append(jobs, job)
	}

	data, err := json.MarshalIndent(jobs, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化失败: %w", err)
	}

	if err := os.WriteFile(m.storePath, data, 0644); err != nil {
		return fmt.Errorf("写入文件失败: %w", err)
	}

	return nil
}
