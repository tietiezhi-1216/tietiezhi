package heartbeat

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"tietiezhi/internal/cron"
)

// HeartbeatManager 心跳管理器
// 每隔固定时间（默认 30 分钟），Agent 自动醒来检查 HEARTBEAT.md 中的检查清单
type HeartbeatManager struct {
	interval    time.Duration // 检查间隔，默认 30 分钟
	agent       interface {
		RunCron(ctx context.Context, sessionKey string, isGroup bool, role, content string) (string, error)
	}
	memoryMgr interface {
		ReadFile(relativePath string) string
		FileExists(relativePath string) bool
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

// executeHeartbeat 执行心跳检查
func (m *HeartbeatManager) executeHeartbeat(ctx context.Context) {
	log.Println("执行心跳检查...")

	// 读取 HEARTBEAT.md 内容
	if m.memoryMgr == nil {
		log.Println("心跳检查失败: 记忆管理器未设置")
		return
	}

	heartbeatContent := m.memoryMgr.ReadFile("HEARTBEAT.md")

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

	// 检查是否有实际检查项（以 "- " 开头的行），没有则跳过
	hasCheckItems := false
	if heartbeatContent != "" {
		for _, line := range strings.Split(heartbeatContent, "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "- ") {
				hasCheckItems = true
				break
			}
		}
	}

	if !hasCheckItems && !hasPendingEvents {
		log.Println("心跳检查跳过: 无检查项且无待处理事件")
		return
	}

	// 构建检查 prompt
	prompt := m.buildHeartbeatPrompt(heartbeatContent, pendingSection)

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
	if reply == "" || reply == "NO_REPLY" {
		log.Println("心跳检查完成: 无需通知")
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
func (m *HeartbeatManager) buildHeartbeatPrompt(heartbeatContent string, pendingSection string) string {
	prompt := fmt.Sprintf("你正在进行心跳检查。以下是你的检查清单，请逐项快速检查：\n\n%s", heartbeatContent)

	if pendingSection != "" {
		prompt += pendingSection
	}

	prompt += "\n检查规则：\n- 逐项检查，如果某项没有需要通知的情况，就跳过\n- 只有确实需要通知用户的事项才回复\n- 如果所有检查项都正常且无需处理任何定时任务事件，请只回复 NO_REPLY（不要回复其他任何内容）\n- 回复要简洁，每项一两句话即可"

	return prompt
}

// truncate 截断字符串
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
