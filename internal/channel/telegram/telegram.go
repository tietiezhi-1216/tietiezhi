package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"tietiezhi/internal/channel"
	"tietiezhi/internal/command"
)

// TelegramChannel Telegram 渠道适配器
// 使用 long polling 模式接收消息，无需配置 webhook
type TelegramChannel struct {
	botToken     string
	chatHandler  channel.Handler
	commandMgr   *command.Registry
	client       *http.Client
	botAPI       string
	updateOffset int64
	running      bool
	mu           sync.Mutex
	stopCh       chan struct{}
}

// New 创建 Telegram 渠道
func New(botToken string) *TelegramChannel {
	return &TelegramChannel{
		botToken:   botToken,
		botAPI:     "https://api.telegram.org/bot" + botToken,
		client:     &http.Client{Timeout: 30 * time.Second},
		stopCh:     make(chan struct{}),
	}
}

// SetHandler 设置消息处理函数
func (t *TelegramChannel) SetHandler(handler channel.Handler) {
	t.chatHandler = handler
}

// SetCommandManager 设置命令管理器
func (t *TelegramChannel) SetCommandManager(mgr *command.Registry) {
	t.commandMgr = mgr
}

// ID 返回渠道标识
func (t *TelegramChannel) ID() string {
	return "telegram"
}

// Start 启动 Telegram 渠道（long polling 模式）
func (t *TelegramChannel) Start(ctx context.Context) error {
	t.mu.Lock()
	if t.running {
		t.mu.Unlock()
		return nil
	}
	t.running = true
	t.mu.Unlock()

	// 启动 long polling 接收消息
	go t.longPolling(ctx)

	log.Println("Telegram 渠道已启动（Long Polling 模式）")
	return nil
}

// longPolling 长期轮询接收消息
func (t *TelegramChannel) longPolling(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.stopCh:
			return
		default:
			t.fetchUpdates(ctx)
		}
	}
}

// fetchUpdates 获取并处理更新
func (t *TelegramChannel) fetchUpdates(ctx context.Context) {
	// 构建 getUpdates 请求
	url := fmt.Sprintf("%s/getUpdates?offset=%d&timeout=30", t.botAPI, t.updateOffset)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		log.Printf("Telegram 请求创建失败: %v", err)
		time.Sleep(3 * time.Second)
		return
	}

	resp, err := t.client.Do(req)
	if err != nil {
		log.Printf("Telegram getUpdates 失败: %v", err)
		time.Sleep(3 * time.Second)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("Telegram API 返回错误状态码: %d", resp.StatusCode)
		time.Sleep(3 * time.Second)
		return
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("Telegram 响应读取失败: %v", err)
		time.Sleep(3 * time.Second)
		return
	}

	var result struct {
		OK     bool              `json:"ok"`
		Result []json.RawMessage `json:"result"`
	}

	if err := json.Unmarshal(body, &result); err != nil {
		log.Printf("Telegram 响应解析失败: %v", err)
		time.Sleep(3 * time.Second)
		return
	}

	if !result.OK || len(result.Result) == 0 {
		return
	}

	// 处理每条更新
	for _, rawUpdate := range result.Result {
		update, err := t.parseUpdate(rawUpdate)
		if err != nil {
			log.Printf("Telegram 更新解析失败: %v", err)
			continue
		}

		// 更新 offset（消息去重）
		if update.UpdateID >= t.updateOffset {
			t.updateOffset = update.UpdateID + 1
		}

		// 处理消息
		go t.handleUpdate(ctx, update)
	}
}

// Update Telegram 更新结构
type Update struct {
	UpdateID int64   `json:"update_id"`
	Message  *Message `json:"message,omitempty"`
}

// Message Telegram 消息结构
type Message struct {
	MessageID int64    `json:"message_id"`
	Chat      Chat     `json:"chat"`
	From      *User    `json:"from,omitempty"`
	Text      string   `json:"text,omitempty"`
	Entities  []Entity `json:"entities,omitempty"`
}

// Chat Telegram 聊天结构
type Chat struct {
	ID       int64  `json:"id"`
	Type     string `json:"type"` // "private", "group", "supergroup"
	Username string `json:"username,omitempty"`
	Title    string `json:"title,omitempty"`
}

// User Telegram 用户结构
type User struct {
	ID        int64  `json:"id"`
	IsBot     bool   `json:"is_bot"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name,omitempty"`
	Username  string `json:"username,omitempty"`
}

// Entity 消息实体（用于检测命令）
type Entity struct {
	Type   string `json:"type"`
	Offset int    `json:"offset"`
	Length int    `json:"length"`
}

// parseUpdate 解析更新
func (t *TelegramChannel) parseUpdate(data json.RawMessage) (*Update, error) {
	var update Update
	if err := json.Unmarshal(data, &update); err != nil {
		return nil, err
	}
	return &update, nil
}

// handleUpdate 处理单条更新
func (t *TelegramChannel) handleUpdate(ctx context.Context, update *Update) {
	if update.Message == nil {
		return
	}

	msg := update.Message

	// 忽略 bot 自己的消息
	if msg.From != nil && msg.From.IsBot {
		return
	}

	// 构建 channel.Message
	chatType := "p2p"
	if msg.Chat.Type == "group" || msg.Chat.Type == "supergroup" {
		chatType = "group"
	}

	content := msg.Text
	if content == "" {
		content = msg.Text
	}

	if content == "" {
		return
	}

	// 检测命令
	if strings.HasPrefix(content, "/") {
		t.handleCommand(ctx, update, content)
		return
	}

	// 群组消息处理
	if chatType == "group" {
		// 群组模式下，纯文本消息不处理（需要 @ 机器人）
		// 这里简化处理
		if !strings.Contains(content, "@") {
			return
		}
	}

	// 构建 session key
	userID := ""
	if msg.From != nil {
		userID = strconv.FormatInt(msg.From.ID, 10)
	}
	chatID := strconv.FormatInt(msg.Chat.ID, 10)


	channelMsg := &channel.Message{
		ChannelID: chatID,
		UserID:    userID,
		Content:   content,
		ChatType:  chatType,
	}

	log.Printf("收到 Telegram 消息: chatType=%s, chatID=%s, userID=%s, content=%s",
		chatType, chatID, userID, truncate(content, 100))

	if t.chatHandler != nil {
		reply, err := t.chatHandler(ctx, channelMsg)
		if err != nil {
			log.Printf("Telegram 消息处理失败: %v", err)
			return
		}
		if reply != nil && reply.Content != "" {
			t.Send(ctx, chatID, reply)
		}
	}
}

// handleCommand 处理命令
func (t *TelegramChannel) handleCommand(ctx context.Context, update *Update, content string) {
	if t.commandMgr == nil {
		return
	}

	msg := update.Message
	chatID := strconv.FormatInt(msg.Chat.ID, 10)

	// 解析命令和参数
	// 支持格式：/command 或 /command@botname
	parts := strings.Fields(content)
	if len(parts) == 0 {
		return
	}

	rawCmd := strings.TrimPrefix(parts[0], "/")
	// 去除 @botname 部分
	if idx := strings.Index(rawCmd, "@"); idx != -1 {
		rawCmd = rawCmd[:idx]
	}

	args := []string{}
	if len(parts) > 1 {
		args = parts[1:]
	}

	sessionKey := fmt.Sprintf("telegram:%s", chatID)

	// 执行命令
	result := t.commandMgr.Execute(ctx, rawCmd, sessionKey, args)

	// 发送命令结果
	if result != "" {
		t.Send(ctx, chatID, &channel.Message{Content: result})
	}
}

// Send 发送消息
func (t *TelegramChannel) Send(ctx context.Context, chatID string, msg *channel.Message) error {
	// 将 chatID 从字符串转换为 int64
	chatIDInt, err := strconv.ParseInt(chatID, 10, 64)
	if err != nil {
		return fmt.Errorf("无效的 chatID: %s", chatID)
	}

	// 构建发送请求
	sendReq := map[string]interface{}{
		"chat_id":    chatIDInt,
		"text":       msg.Content,
		"parse_mode": "Markdown",
	}

	jsonData, err := json.Marshal(sendReq)
	if err != nil {
		return fmt.Errorf("消息序列化失败: %w", err)
	}

	url := fmt.Sprintf("%s/sendMessage", t.botAPI)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(jsonData))
	if err != nil {
		return fmt.Errorf("请求创建失败: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := t.client.Do(req)
	if err != nil {
		return fmt.Errorf("消息发送失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Telegram API 错误: %d - %s", resp.StatusCode, string(body))
	}

	return nil
}

// Stop 停止 Telegram 渠道
func (t *TelegramChannel) Stop(ctx context.Context) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	if !t.running {
		return nil
	}

	close(t.stopCh)
	t.running = false
	t.stopCh = make(chan struct{})

	log.Println("Telegram 渠道已停止")
	return nil
}

// truncate 截断字符串
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

// sendMessageDirect 直接发送消息（内部使用）
func (t *TelegramChannel) sendMessageDirect(ctx context.Context, chatID int64, text string) error {
	sendReq := map[string]interface{}{
		"chat_id":    chatID,
		"text":       text,
		"parse_mode": "Markdown",
	}

	jsonData, err := json.Marshal(sendReq)
	if err != nil {
		return err
	}

	url := fmt.Sprintf("%s/sendMessage", t.botAPI)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(jsonData))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := t.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// isCommand 检测消息是否是命令
func isCommand(text string) bool {
	// 以 / 开头，且 / 不在文本中间
	matched, _ := regexp.MatchString(`^/\w+`, text)
	return matched
}

// extractCommand 提取命令名称和参数
func extractCommand(text string) (string, []string) {
	parts := strings.Fields(text)
	if len(parts) == 0 {
		return "", nil
	}

	rawCmd := strings.TrimPrefix(parts[0], "/")
	// 去除 @botname 部分
	if idx := strings.Index(rawCmd, "@"); idx != -1 {
		rawCmd = rawCmd[:idx]
	}

	args := []string{}
	if len(parts) > 1 {
		args = parts[1:]
	}

	return strings.ToLower(rawCmd), args
}
