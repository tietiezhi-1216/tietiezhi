package heartbeat

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

	"tietiezhi/internal/cron"

	"gopkg.in/yaml.v3"
)

// HeartbeatTask 心跳任务（基于间隔的检查任务）
type HeartbeatTask struct {
	Name     string        `yaml:"name"`
	Interval time.Duration `yaml:"interval"`
	Prompt   string        `yaml:"prompt"`
}

// HeartbeatState 心跳状态（跟踪每个 task 的上次执行时间）
type HeartbeatState struct {
	LastChecks map[string]time.Time `json:"last_checks"` // task name -> last run time
}

// HeartbeatManager 心跳管理器
// 每隔固定时间（默认 30 分钟），Agent 自动醒来检查 HEARTBEAT.md 中的检查清单
type HeartbeatManager struct {
	interval       time.Duration // 检查间隔，默认 30 分钟
	agent         interface {
		RunCron(ctx context.Context, sessionKey string, isGroup bool, role, content string) (string, error)
	}
	memoryMgr interface {
		ReadFile(relativePath string) string
		FileExists(relativePath string) bool
		GetWorkspacePath() string
	}
	cronMgr    *cron.CronManager // Cron 管理器（用于获取 pending events）
	deliveryFn func(chatID, content string) error // 投递函数
	chatID     string                            // 默认投递目标（飞书聊天 ID）
	mu         sync.Mutex
	running    bool
	stopCh     chan struct{}
}

// NewHeartbeatManager 创建心跳管理器
func NewHeartbeatManager(intervalMinutes int) *HeartbeatManager {
	if intervalMinutes < 5 {
		intervalMinutes = 5 // 最小间隔 5 分钟
	}
	return &HeartbeatManager{
		interval: time.Duration(intervalMinutes) * time.Minute,
		stopCh:   make(chan struct{}),
	}
}

// SetAgent 设置 Agent（用于执行心跳检查）
func (m *HeartbeatManager) SetAgent(ag interface{}) {
	m.agent = ag.(interface {
		RunCron(ctx context.Context, sessionKey string, isGroup bool, role, content string) (string, error)
	})
}

// SetMemoryManager 设置记忆管理器
func (m *HeartbeatManager) SetMemoryManager(mm interface{}) {
	m.memoryMgr = mm.(interface {
		ReadFile(relativePath string) string
		FileExists(relativePath string) bool
		GetWorkspacePath() string
	})
}

// SetCronManager 设置 Cron 管理器（用于获取 pending events）
func (m *HeartbeatManager) SetCronManager(cm *cron.CronManager) {
	m.cronMgr = cm
}

// SetDeliveryFn 设置投递函数
func (m *HeartbeatManager) SetDeliveryFn(fn func(chatID, content string) error) {
	m.deliveryFn = fn
}

// SetChatID 设置默认投递目标
func (m *HeartbeatManager) SetChatID(chatID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.chatID = chatID
}

// UpdateChatID 更新投递目标（收到用户消息时调用）
func (m *HeartbeatManager) UpdateChatID(chatID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.chatID == "" {
		m.chatID = chatID
		log.Printf("心跳系统已设置投递目标: %s", chatID)
	}
}

// GetChatID 获取当前投递目标
func (m *HeartbeatManager) GetChatID() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.chatID
}

// Start 启动心跳系统
func (m *HeartbeatManager) Start(ctx context.Context) {
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		return
	}
	m.running = true
	m.mu.Unlock()

	log.Printf("心跳系统已启动，间隔: %v", m.interval)

	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()

	// 启动时立即执行一次检查
	m.executeHeartbeat(ctx)

	for {
		select {
		case <-ticker.C:
			m.executeHeartbeat(ctx)
		case <-m.stopCh:
			log.Println("心跳系统已停止")
			return
		case <-ctx.Done():
			log.Println("心跳系统因上下文取消而停止")
			return
		}
	}
}

// Stop 停止心跳系统
func (m *HeartbeatManager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.running {
		return
	}
	m.running = false
	close(m.stopCh)
}

// parseTasksBlock 解析 tasks 代码块
// 从 HEARTBEAT.md 内容中提取 ```tasks ... ``` 代码块，解析为 []HeartbeatTask
// 返回 tasks 列表和去掉 tasks 代码块后的剩余内容
func parseTasksBlock(content string) ([]HeartbeatTask, string) {
	// 查找 ```tasks ... ``` 代码块
	startMarker := "```tasks"
	endMarker := "```"
	
	startIdx := strings.Index(content, startMarker)
	if startIdx == -1 {
		return nil, content
	}
	
	// 找到开始标记的结束位置
	codeStart := startIdx + len(startMarker)
	// 确保在 ```tasks 后有换行
	if codeStart < len(content) && content[codeStart] != '\n' && content[codeStart] != '\r' {
		// ```tasks 后面没有换行，可能格式不对
		return nil, content
	}
	if codeStart < len(content) && content[codeStart] == '\r' {
		codeStart++
	}
	if codeStart < len(content) && content[codeStart] == '\n' {
		codeStart++
	}
	
	// 找到结束标记
	endIdx := strings.Index(content[codeStart:], endMarker)
	if endIdx == -1 {
		// 没有结束标记，格式错误
		return nil, content
	}
	endIdx += codeStart // 转换为绝对索引
	
	// 提取代码块内容
	tasksContent := content[codeStart:endIdx]
	
	// 去掉 tasks 代码块后的剩余内容
	remainingContent := content[:startIdx] + content[endIdx+len(endMarker):]
	remainingContent = strings.TrimRight(remainingContent, " \t\r\n")
	
	// 解析 YAML
	// tasks 代码块内容应该是 tasks: [...] 格式
	var wrapper struct {
		Tasks []HeartbeatTask `yaml:"tasks"`
	}
	
	// 如果没有 tasks: 前缀，手动包装
	var yamlContent string
	if strings.Contains(tasksContent, "tasks:") {
		yamlContent = tasksContent
	} else {
		yamlContent = "tasks:\n" + tasksContent
	}
	
	if err := yaml.Unmarshal([]byte(yamlContent), &wrapper); err != nil {
		log.Printf("解析 tasks 代码块失败: %v", err)
		return nil, remainingContent
	}
	
	return wrapper.Tasks, remainingContent
}

// isEmptyOrCommentOnly 检查内容是否为空或只有标题/注释/空行
func isEmptyOrCommentOnly(content string) bool {
	if content == "" {
		return true
	}
	
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		// 跳过空行
		if trimmed == "" {
			continue
		}
		// 跳过标题行（# 开头）
		if strings.HasPrefix(trimmed, "#") {
			continue
		}
		// 发现非空非注释行
		return false
	}
	return true
}

// getStateFilePath 获取 state 文件路径
func (m *HeartbeatManager) getStateFilePath() string {
	if m.memoryMgr != nil {
		return filepath.Join(m.memoryMgr.GetWorkspacePath(), "memory", "heartbeat-state.json")
	}
	return "./data/workspace/memory/heartbeat-state.json"
}

// loadState 加载心跳状态
func (m *HeartbeatManager) loadState() (*HeartbeatState, error) {
	stateFile := m.getStateFilePath()
	
	data, err := os.ReadFile(stateFile)
	if err != nil {
		if os.IsNotExist(err) {
			// 文件不存在，返回空的 state
			return &HeartbeatState{
				LastChecks: make(map[string]time.Time),
			}, nil
		}
		return nil, err
	}
	
	var state HeartbeatState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	
	return &state, nil
}

// saveState 保存心跳状态
func (m *HeartbeatManager) saveState(state *HeartbeatState) error {
	stateFile := m.getStateFilePath()
	
	// 确保目录存在
	dir := filepath.Dir(stateFile)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	
	return os.WriteFile(stateFile, data, 0644)
}

// executeHeartbeat 执行心跳检查
func (m *HeartbeatManager) executeHeartbeat(ctx context.Context) {
	log.Println("执行心跳检查...")

	// 读取 HEARTBEAT.md 内容
	if m.memoryMgr == nil {
		log.Println("心跳检查失败: 记忆管理器未设置")
		return
	}

	heartbeatContent := m.memoryMgr.ReadFile("HEARTBEAT.md")

	// 空文件或只有标题/注释/空行，跳过
	if isEmptyOrCommentOnly(heartbeatContent) {
		log.Println("心跳检查跳过: HEARTBEAT.md 为空或只有标题/注释")
		return
	}

	// 解析 tasks 代码块
	tasks, remainingContent := parseTasksBlock(heartbeatContent)
	
	// 加载心跳状态
	state, err := m.loadState()
	if err != nil {
		log.Printf("加载心跳状态失败: %v", err)
		// 继续执行，不因状态加载失败而停止
		state = &HeartbeatState{LastChecks: make(map[string]time.Time)}
	}

	// 计算哪些 tasks 到期
	var dueTasks []HeartbeatTask
	if tasks != nil {
		now := time.Now()
		for _, task := range tasks {
			lastRun, exists := state.LastChecks[task.Name]
			if !exists || now.Sub(lastRun) >= task.Interval {
				dueTasks = append(dueTasks, task)
			}
		}
	}

	// 获取 pending events
	var pendingSection string
	hasPendingEvents := false
	if m.cronMgr != nil {
		events := m.cronMgr.GetPendingEvents()
		if len(events) > 0 {
			log.Printf("发现 %d 个待处理的定时任务事件", len(events))
			pendingSection = m.buildPendingSection(events)
			hasPendingEvents = true
		}
	}

	// 提取普通检查项（tasks 代码块外的 `- ` 列表项）
	var checkItems []string
	for _, line := range strings.Split(remainingContent, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "- ") {
			checkItems = append(checkItems, trimmed[2:])
		}
	}

	// 如果没有普通检查项且没有到期的 tasks，跳过
	if len(checkItems) == 0 && len(dueTasks) == 0 && !hasPendingEvents {
		log.Println("心跳检查跳过: 无检查项且无到期任务")
		return
	}

	// 构建检查 prompt
	prompt := m.buildHeartbeatPrompt(checkItems, dueTasks, pendingSection)

	// 调用 Agent 执行检查
	if m.agent == nil {
		log.Println("心跳检查失败: Agent 未设置")
		return
	}

	reply, err := m.agent.RunCron(ctx, "heartbeat:main", false, "user", prompt)
	if err != nil {
		log.Printf("心跳检查执行失败: %v", err)
		return
	}

	// 检查是否需要通知
	reply = strings.TrimSpace(reply)
	if reply == "" || reply == "HEARTBEAT_OK" {
		log.Println("心跳检查完成: 无需通知 (HEARTBEAT_OK)")
	} else {
		// 投递消息
		m.mu.Lock()
		targetChatID := m.chatID
		m.mu.Unlock()

		if targetChatID == "" {
			log.Println("心跳检查完成但无投递目标: chatID 为空")
		} else if m.deliveryFn != nil {
			if err := m.deliveryFn(targetChatID, reply); err != nil {
				log.Printf("心跳消息投递失败: %v", err)
			} else {
				log.Printf("心跳消息投递成功: %s", truncate(reply, 100))
			}
		}
	}

	// 更新 state：将本次执行的所有到期 task 的 LastChecks 更新为当前时间
	now := time.Now()
	for _, task := range dueTasks {
		state.LastChecks[task.Name] = now
	}

	// 保存 state
	if err := m.saveState(state); err != nil {
		log.Printf("保存心跳状态失败: %v", err)
	}

	// 清空已处理的 pending events（无论是否投递成功，只要处理了就清空）
	if hasPendingEvents {
		if err := m.cronMgr.ClearPendingEvents(); err != nil {
			log.Printf("清空 pending events 失败: %v", err)
		} else {
			log.Println("已清空 pending events 队列")
		}
	}
}

// buildPendingSection 构建 pending events 部分
func (m *HeartbeatManager) buildPendingSection(events []*cron.PendingEvent) string {
	if len(events) == 0 {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("\n\n===定时任务事件===\n")
	sb.WriteString("以下定时任务已到期，请处理：\n")

	for i, event := range events {
		firedAt := event.FiredAt.Format("2006-01-02 15:04:05")
		sb.WriteString(fmt.Sprintf("%d. %s (触发时间: %s): %s\n", i+1, event.JobName, firedAt, event.Message))
	}

	return sb.String()
}

// buildHeartbeatPrompt 构建心跳检查 prompt
func (m *HeartbeatManager) buildHeartbeatPrompt(checkItems []string, dueTasks []HeartbeatTask, pendingSection string) string {
	var sb strings.Builder

	sb.WriteString("你正在进行心跳检查。请逐项快速检查以下内容：\n\n")

	// 普通检查项
	if len(checkItems) > 0 {
		sb.WriteString("【普通检查项】\n")
		for _, item := range checkItems {
			sb.WriteString("- " + item + "\n")
		}
		sb.WriteString("\n")
	}

	// 到期任务
	if len(dueTasks) > 0 {
		sb.WriteString("【到期任务】\n")
		for _, task := range dueTasks {
			sb.WriteString(fmt.Sprintf("- %s: %s\n", task.Name, task.Prompt))
		}
		sb.WriteString("\n")
	}

	// 待处理定时任务事件
	if pendingSection != "" {
		sb.WriteString(pendingSection)
	}

	sb.WriteString("检查规则：\n")
	sb.WriteString("- 逐项检查，如果某项没有需要通知的情况，就跳过\n")
	sb.WriteString("- 只有确实需要通知用户的事项才回复\n")
	sb.WriteString("- 如果所有检查项都正常，请只回复 HEARTBEAT_OK（不要回复其他任何内容）\n")
	sb.WriteString("- 回复要简洁，每项一两句话即可")

	return sb.String()
}

// truncate 截断字符串
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
