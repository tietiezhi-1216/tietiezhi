package feishu

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"

	"tietiezhi/internal/channel"
)

// FeishuChannel 飞书渠道
type FeishuChannel struct {
	appID       string
	appSecret   string
	client      *lark.Client
	handler     func(ctx context.Context, msg *channel.Message) (*channel.Message, error)
	mu          sync.Mutex
	running     bool
	processedMu sync.Mutex
	processed   map[string]time.Time // 消息去重：messageID -> 处理时间
}

// New 创建飞书渠道
func New(appID, appSecret string) *FeishuChannel {
	return &FeishuChannel{
		appID:     appID,
		appSecret: appSecret,
		processed: make(map[string]time.Time),
	}
}

// SetHandler 设置消息处理函数
func (f *FeishuChannel) SetHandler(handler func(ctx context.Context, msg *channel.Message) (*channel.Message, error)) {
	f.handler = handler
}

// ID 返回渠道标识
func (f *FeishuChannel) ID() string { return "feishu" }

// Start 启动飞书渠道
func (f *FeishuChannel) Start(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.running {
		return nil
	}

	f.client = lark.NewClient(f.appID, f.appSecret)

	eventHandler := dispatcher.NewEventDispatcher("", "").
		OnP2MessageReceiveV1(func(ctx context.Context, event *larkim.P2MessageReceiveV1) error {
			return f.handleMessage(ctx, event)
		})

	wsClient := larkws.NewClient(f.appID, f.appSecret,
		larkws.WithEventHandler(eventHandler),
		larkws.WithLogLevel(larkcore.LogLevelDebug),
	)

	go func() {
		if err := wsClient.Start(ctx); err != nil {
			log.Printf("飞书 WebSocket 连接异常: %v", err)
		}
	}()

	// 启动去重缓存清理
	go f.cleanProcessedCache()

	f.running = true
	log.Println("飞书渠道已启动（WebSocket 模式）")
	return nil
}

// cleanProcessedCache 定期清理过期的去重记录
func (f *FeishuChannel) cleanProcessedCache() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		f.processedMu.Lock()
		now := time.Now()
		for id, t := range f.processed {
			if now.Sub(t) > 10*time.Minute {
				delete(f.processed, id)
			}
		}
		f.processedMu.Unlock()
	}
}

// isDuplicate 检查消息是否已处理过
func (f *FeishuChannel) isDuplicate(messageID string) bool {
	f.processedMu.Lock()
	defer f.processedMu.Unlock()
	if _, ok := f.processed[messageID]; ok {
		return true
	}
	f.processed[messageID] = time.Now()
	return false
}

// handleMessage 处理飞书消息事件
func (f *FeishuChannel) handleMessage(ctx context.Context, event *larkim.P2MessageReceiveV1) error {
	if event.Event == nil || event.Event.Message == nil {
		return nil
	}

	msg := event.Event.Message

	messageID := ""
	if msg.MessageId != nil {
		messageID = *msg.MessageId
	}

	// 消息去重：同一消息飞书可能重推
	if messageID != "" && f.isDuplicate(messageID) {
		log.Printf("跳过重复消息: %s", messageID)
		return nil
	}

	chatType := ""
	if msg.ChatType != nil {
		chatType = *msg.ChatType
	}

	chatID := ""
	if msg.ChatId != nil {
		chatID = *msg.ChatId
	}

	// 群聊中，只处理 @机器人 的消息
	if chatType == "group" {
		if !f.isBotMentioned(msg) {
			return nil
		}
	}

	// 忽略机器人自己发送的消息，避免死循环
	senderType := ""
	if event.Event.Sender != nil && event.Event.Sender.SenderType != nil {
		senderType = *event.Event.Sender.SenderType
	}
	if senderType == "bot" {
		return nil
	}

	userID := ""
	if event.Event.Sender != nil && event.Event.Sender.SenderId != nil {
		userID = *event.Event.Sender.SenderId.OpenId
	}

	content := f.parseMessageContent(msg)
	if content == "" {
		return nil
	}

	log.Printf("收到飞书消息: chatType=%s, userID=%s, content=%s", chatType, userID, content)

	if f.handler != nil {
		// 群聊：先给消息加 🤔 表情
		if chatType == "group" && messageID != "" {
			f.addReaction(ctx, messageID, "THINKING")
		}

		input := &channel.Message{
			ChannelID: chatID,
			UserID:    userID,
			Content:   content,
		}

		reply, err := f.handler(ctx, input)
		if err != nil {
			log.Printf("处理飞书消息出错: %v", err)
			if chatType == "group" && messageID != "" {
				f.removeReaction(ctx, messageID, "THINKING")
			}
			return nil
		}

		if reply != nil && reply.Content != "" {
			if chatType == "p2p" {
				if err := f.Send(ctx, chatID, reply); err != nil {
					log.Printf("发送飞书消息出错: %v", err)
				}
			} else {
				if err := f.Reply(ctx, messageID, reply); err != nil {
					log.Printf("回复飞书消息出错: %v", err)
				}
			}
		}

		// 处理完成后移除 🤔 表情
		if chatType == "group" && messageID != "" {
			f.removeReaction(ctx, messageID, "THINKING")
		}
	}

	return nil
}

// addReaction 给消息添加表情
func (f *FeishuChannel) addReaction(ctx context.Context, messageID, emojiType string) {
	_, err := f.client.Im.MessageReaction.Create(ctx, larkim.NewCreateMessageReactionReqBuilder().
		MessageId(messageID).
		Body(larkim.NewCreateMessageReactionReqBodyBuilder().
			ReactionType(larkim.NewEmojiBuilder().
				EmojiType(emojiType).
				Build()).
			Build()).
		Build())
	if err != nil {
		log.Printf("添加表情失败: %v", err)
	}
}

// removeReaction 移除消息表情
func (f *FeishuChannel) removeReaction(ctx context.Context, messageID, emojiType string) {
	resp, err := f.client.Im.MessageReaction.List(ctx, larkim.NewListMessageReactionReqBuilder().
		MessageId(messageID).
		PageSize(50).
		Build())
	if err != nil {
		return
	}
	if resp == nil || resp.Data == nil || resp.Data.Items == nil {
		return
	}
	for _, item := range resp.Data.Items {
		if item.ReactionType != nil && item.ReactionType.EmojiType != nil {
			if *item.ReactionType.EmojiType == emojiType && item.ReactionId != nil {
				f.client.Im.MessageReaction.Delete(ctx, larkim.NewDeleteMessageReactionReqBuilder().
					MessageId(messageID).
					ReactionId(*item.ReactionId).
					Build())
				return
			}
		}
	}
}

// isBotMentioned 检查群聊中是否 @了机器人
func (f *FeishuChannel) isBotMentioned(msg *larkim.EventMessage) bool {
	if len(msg.Mentions) > 0 {
		return true
	}
	if msg.Content != nil {
		matched, _ := regexp.MatchString(`@_user_\d+`, *msg.Content)
		if matched {
			return true
		}
	}
	return false
}

// parseMessageContent 解析消息内容
func (f *FeishuChannel) parseMessageContent(msg *larkim.EventMessage) string {
	if msg.Content == nil {
		return ""
	}
	msgType := ""
	if msg.MessageType != nil {
		msgType = *msg.MessageType
	}
	rawContent := *msg.Content

	switch msgType {
	case "text":
		var textMsg struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal([]byte(rawContent), &textMsg); err == nil {
			return cleanMentionPlaceholders(textMsg.Text)
		}
	case "post":
		return parsePostContent(rawContent)
	default:
		log.Printf("暂不支持的消息类型: %s", msgType)
	}
	return rawContent
}

// parsePostContent 解析飞书富文本消息
func parsePostContent(rawContent string) string {
	var postWrapper map[string]json.RawMessage
	if err := json.Unmarshal([]byte(rawContent), &postWrapper); err != nil {
		return rawContent
	}
	var postContent struct {
		Title   string              `json:"title"`
		Content [][]json.RawMessage `json:"content"`
	}
	for _, locale := range []string{"zh_cn", "en_us", "ja_jp"} {
		if data, ok := postWrapper[locale]; ok {
			if err := json.Unmarshal(data, &postContent); err == nil {
				break
			}
		}
	}
	var parts []string
	if postContent.Title != "" {
		parts = append(parts, postContent.Title)
	}
	for _, paragraph := range postContent.Content {
		var lineParts []string
		for _, element := range paragraph {
			var elem struct {
				Tag      string `json:"tag"`
				Text     string `json:"text"`
				Href     string `json:"href"`
				UserId   string `json:"user_id"`
				Language string `json:"language"`
			}
			if err := json.Unmarshal(element, &elem); err != nil {
				continue
			}
			switch elem.Tag {
			case "text":
				lineParts = append(lineParts, elem.Text)
			case "a":
				if elem.Href != "" {
					lineParts = append(lineParts, fmt.Sprintf("[%s](%s)", elem.Text, elem.Href))
				} else {
					lineParts = append(lineParts, elem.Text)
				}
			case "at":
				lineParts = append(lineParts, fmt.Sprintf("@%s", elem.UserId))
			case "code_block":
				lineParts = append(lineParts, fmt.Sprintf("```%s\n%s\n```", elem.Language, elem.Text))
			case "hr":
				lineParts = append(lineParts, "---")
			case "md":
				lineParts = append(lineParts, elem.Text)
			default:
				if elem.Text != "" {
					lineParts = append(lineParts, elem.Text)
				}
			}
		}
		if len(lineParts) > 0 {
			parts = append(parts, strings.Join(lineParts, ""))
		}
	}
	result := strings.Join(parts, "\n")
	return cleanMentionPlaceholders(result)
}

// cleanMentionPlaceholders 清理 @mention 占位符
func cleanMentionPlaceholders(text string) string {
	re := regexp.MustCompile(`@_user_\d+`)
	cleaned := re.ReplaceAllString(text, "")
	return strings.TrimSpace(cleaned)
}

// Stop 停止飞书渠道
func (f *FeishuChannel) Stop(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.running = false
	log.Println("飞书渠道已停止")
	return nil
}

// Send 发送消息（Post 富文本格式）
func (f *FeishuChannel) Send(ctx context.Context, chatID string, msg *channel.Message) error {
	if f.client == nil {
		return fmt.Errorf("飞书客户端未初始化")
	}
	content := buildPostContent(msg.Content)
	_, err := f.client.Im.Message.Create(ctx, larkim.NewCreateMessageReqBuilder().
		ReceiveIdType(larkim.ReceiveIdTypeChatId).
		Body(larkim.NewCreateMessageReqBodyBuilder().
			MsgType(larkim.MsgTypePost).
			ReceiveId(chatID).
			Content(content).
			Build()).
		Build())
	if err != nil {
		return fmt.Errorf("发送飞书消息失败: %w", err)
	}
	return nil
}

// Reply 回复消息（Post 富文本格式）
func (f *FeishuChannel) Reply(ctx context.Context, messageID string, msg *channel.Message) error {
	if f.client == nil {
		return fmt.Errorf("飞书客户端未初始化")
	}
	if messageID == "" {
		return fmt.Errorf("消息 ID 为空")
	}
	content := buildPostContent(msg.Content)
	_, err := f.client.Im.Message.Reply(ctx, larkim.NewReplyMessageReqBuilder().
		Body(larkim.NewReplyMessageReqBodyBuilder().
			MsgType(larkim.MsgTypePost).
			Content(content).
			Build()).
		MessageId(messageID).
		Build())
	if err != nil {
		return fmt.Errorf("回复飞书消息失败: %w", err)
	}
	return nil
}

// buildPostContent 将 Markdown 转换为飞书 Post 格式
// 飞书 md 标签不支持表格，需要将表格转换为对齐文本
func buildPostContent(markdownText string) string {
	// 预处理：将 Markdown 表格转换为对齐文本（飞书 md 不支持表格）
	processedText := convertMarkdownTables(markdownText)

	post := map[string]any{
		"zh_cn": map[string]any{
			"content": [][]map[string]any{
				{
					{
						"tag":  "md",
						"text": processedText,
					},
				},
			},
		},
	}
	data, _ := json.Marshal(post)
	return string(data)
}

// convertMarkdownTables 将 Markdown 表格转换为对齐文本格式
// 飞书 md 标签不支持 | col1 | col2 | 语法
// 策略：检测到表格时，转为代码块显示（保留对齐）
func convertMarkdownTables(text string) string {
	lines := strings.Split(text, "\n")
	var result []string
	var tableLines []string
	inTable := false

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		isTableLine := strings.Contains(trimmed, "|") && strings.HasPrefix(trimmed, "|") && strings.HasSuffix(trimmed, "|")

		if isTableLine {
			if !inTable {
				inTable = true
				tableLines = []string{}
			}
			tableLines = append(tableLines, trimmed)
		} else {
			if inTable {
				// 表格结束，转换为代码块
				result = append(result, markdownTableToCodeBlock(tableLines))
				tableLines = nil
				inTable = false
			}
			result = append(result, line)
		}
	}

	// 处理末尾的表格
	if inTable {
		result = append(result, markdownTableToCodeBlock(tableLines))
	}

	return strings.Join(result, "\n")
}

// markdownTableToCodeBlock 将 Markdown 表格行转换为代码块
func markdownTableToCodeBlock(lines []string) string {
	// 过滤分隔行（|---|---|）
	var dataLines []string
	for _, line := range lines {
		cleaned := strings.ReplaceAll(line, "-", "")
		cleaned = strings.ReplaceAll(cleaned, " ", "")
		if cleaned != "||" && cleaned != "|" {
			dataLines = append(dataLines, line)
		}
	}

	if len(dataLines) == 0 {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("```")
	for _, line := range dataLines {
		// 去掉首尾 |，保留内容
		trimmed := strings.TrimPrefix(line, "|")
		trimmed = strings.TrimSuffix(trimmed, "|")
		// 用制表符对齐
		cells := strings.Split(trimmed, "|")
		for i, cell := range cells {
			cells[i] = strings.TrimSpace(cell)
		}
		sb.WriteString(strings.Join(cells, "\t"))
		sb.WriteString("\n")
	}
	sb.WriteString("```")
	return sb.String()
}
