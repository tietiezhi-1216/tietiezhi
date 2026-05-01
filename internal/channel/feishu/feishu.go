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

	"tietiezhi/internal/agent"
	"tietiezhi/internal/channel"
	"tietiezhi/internal/llm"
)

// FeishuChannel 飞书渠道
type FeishuChannel struct {
	appID       string
	appSecret   string
	client      *lark.Client
	handler     func(ctx context.Context, msg *channel.Message) (*channel.Message, error)
	streamHandler func(ctx context.Context, msg *channel.Message, sendFunc func(content string) error) error
	mu          sync.Mutex
	running     bool
	processedMu sync.Mutex
	processed   map[string]time.Time
}

// New 创建飞书渠道
func New(appID, appSecret string) *FeishuChannel {
	return &FeishuChannel{
		appID:     appID,
		appSecret: appSecret,
		processed: make(map[string]time.Time),
	}
}

// SetHandler 设置消息处理函数（同步模式）
func (f *FeishuChannel) SetHandler(handler func(ctx context.Context, msg *channel.Message) (*channel.Message, error)) {
	f.handler = handler
}

// SetStreamHandler 设置流式消息处理函数（流式模式）
func (f *FeishuChannel) SetStreamHandler(handler func(ctx context.Context, msg *channel.Message, sendFunc func(content string) error) error) {
	f.streamHandler = handler
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
	go f.cleanProcessedCache()
	f.running = true
	log.Println("飞书渠道已启动（WebSocket 模式）")
	return nil
}

// cleanProcessedCache 定期清理已处理消息缓存
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

// isDuplicate 检查是否为重复消息
func (f *FeishuChannel) isDuplicate(messageID string) bool {
	f.processedMu.Lock()
	defer f.processedMu.Unlock()
	if _, ok := f.processed[messageID]; ok {
		return true
	}
	f.processed[messageID] = time.Now()
	return false
}

// handleMessage 处理收到的消息
func (f *FeishuChannel) handleMessage(ctx context.Context, event *larkim.P2MessageReceiveV1) error {
	if event.Event == nil || event.Event.Message == nil {
		return nil
	}
	msg := event.Event.Message
	messageID := ""
	if msg.MessageId != nil {
		messageID = *msg.MessageId
	}
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
	if chatType == "group" && !f.isBotMentioned(msg) {
		return nil
	}
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

	if f.handler != nil || f.streamHandler != nil {
		if chatType == "group" && messageID != "" {
			f.addReaction(ctx, messageID, "THINKING")
		}

		input := &channel.Message{ChannelID: chatID, UserID: userID, Content: content}

		// 优先使用流式处理
		if f.streamHandler != nil {
			// 流式模式：先发送初始卡片，然后逐步更新
			var sentMessageID string

			sendFunc := func(content string) error {
				// 如果还没有发送消息，先发送
				if sentMessageID == "" {
					var err error
					if messageID != "" {
						// 回复模式
						cardJSON := buildStreamingCardContent(content)
						resp, err := f.client.Im.Message.Reply(ctx, larkim.NewReplyMessageReqBuilder().
							Body(larkim.NewReplyMessageReqBodyBuilder().MsgType("interactive").Content(cardJSON).Build()).
							MessageId(messageID).Build())
						if err == nil && resp != nil && resp.Data != nil && resp.Data.MessageId != nil {
							sentMessageID = *resp.Data.MessageId
						}
					} else {
						// 发送模式
						cardJSON := buildStreamingCardContent(content)
						resp, err := f.client.Im.Message.Create(ctx, larkim.NewCreateMessageReqBuilder().
							ReceiveIdType(larkim.ReceiveIdTypeChatId).
							Body(larkim.NewCreateMessageReqBodyBuilder().MsgType("interactive").ReceiveId(chatID).Content(cardJSON).Build()).
							Build())
						if err == nil && resp != nil && resp.Data != nil && resp.Data.MessageId != nil {
							sentMessageID = *resp.Data.MessageId
						}
					}
					return err
				}

				// 更新已发送的卡片
				cardJSON := buildStreamingCardContent(content)
				_, err := f.client.Im.Message.Patch(ctx, larkim.NewPatchMessageReqBuilder().
					MessageId(sentMessageID).
					Body(larkim.NewPatchMessageReqBodyBuilder().Content(cardJSON).Build()).
					Build())
				return err
			}

			err := f.streamHandler(ctx, input, sendFunc)
			if err != nil {
				log.Printf("处理飞书流式消息出错: %v", err)
				if chatType == "group" && messageID != "" {
					f.removeReaction(ctx, messageID, "THINKING")
				}
				return nil
			}
		} else if f.handler != nil {
			// 同步模式
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
		}

		if chatType == "group" && messageID != "" {
			f.removeReaction(ctx, messageID, "THINKING")
		}
	}
	return nil
}

// addReaction 添加表情反应
func (f *FeishuChannel) addReaction(ctx context.Context, messageID, emojiType string) {
	_, err := f.client.Im.MessageReaction.Create(ctx, larkim.NewCreateMessageReactionReqBuilder().
		MessageId(messageID).
		Body(larkim.NewCreateMessageReactionReqBodyBuilder().
			ReactionType(larkim.NewEmojiBuilder().EmojiType(emojiType).Build()).Build()).Build())
	if err != nil {
		log.Printf("添加表情失败: %v", err)
	}
}

// removeReaction 移除表情反应
func (f *FeishuChannel) removeReaction(ctx context.Context, messageID, emojiType string) {
	resp, err := f.client.Im.MessageReaction.List(ctx, larkim.NewListMessageReactionReqBuilder().
		MessageId(messageID).PageSize(50).Build())
	if err != nil || resp == nil || resp.Data == nil || resp.Data.Items == nil {
		return
	}
	for _, item := range resp.Data.Items {
		if item.ReactionType != nil && item.ReactionType.EmojiType != nil {
			if *item.ReactionType.EmojiType == emojiType && item.ReactionId != nil {
				f.client.Im.MessageReaction.Delete(ctx, larkim.NewDeleteMessageReactionReqBuilder().
					MessageId(messageID).ReactionId(*item.ReactionId).Build())
				return
			}
		}
	}
}

// isBotMentioned 检查机器人是否被提及
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
		var textMsg struct{ Text string `json:"text"` }
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

// parsePostContent 解析富文本消息内容（保留，用于接收用户发送的 Post 消息）
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
	return cleanMentionPlaceholders(strings.Join(parts, "\n"))
}

// cleanMentionPlaceholders 清理提及占位符
func cleanMentionPlaceholders(text string) string {
	re := regexp.MustCompile(`@_user_\d+`)
	return strings.TrimSpace(re.ReplaceAllString(text, ""))
}

// Stop 停止飞书渠道
func (f *FeishuChannel) Stop(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.running = false
	log.Println("飞书渠道已停止")
	return nil
}

// Send 发送卡片消息到指定会话
func (f *FeishuChannel) Send(ctx context.Context, chatID string, msg *channel.Message) error {
	if f.client == nil {
		return fmt.Errorf("飞书客户端未初始化")
	}
	cardJSON := buildCardContent(msg.Content)
	_, err := f.client.Im.Message.Create(ctx, larkim.NewCreateMessageReqBuilder().
		ReceiveIdType(larkim.ReceiveIdTypeChatId).
		Body(larkim.NewCreateMessageReqBodyBuilder().MsgType("interactive").ReceiveId(chatID).Content(cardJSON).Build()).
		Build())
	if err != nil {
		return fmt.Errorf("发送飞书卡片失败: %w", err)
	}
	return nil
}

// Reply 回复卡片消息
func (f *FeishuChannel) Reply(ctx context.Context, messageID string, msg *channel.Message) error {
	if f.client == nil {
		return fmt.Errorf("飞书客户端未初始化")
	}
	if messageID == "" {
		return fmt.Errorf("消息 ID 为空")
	}
	cardJSON := buildCardContent(msg.Content)
	_, err := f.client.Im.Message.Reply(ctx, larkim.NewReplyMessageReqBuilder().
		Body(larkim.NewReplyMessageReqBodyBuilder().MsgType("interactive").Content(cardJSON).Build()).
		MessageId(messageID).Build())
	if err != nil {
		return fmt.Errorf("回复飞书卡片失败: %w", err)
	}
	return nil
}

// containsMarkdownTable 检测文本是否包含 Markdown 表格
func containsMarkdownTable(text string) bool {
	lines := strings.Split(text, "\n")
	count := 0
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "|") && strings.HasSuffix(t, "|") && strings.Count(t, "|") >= 3 {
			count++
		}
	}
	return count >= 2
}

// buildCardContent 构建飞书卡片 JSON 2.0，自动拆分表格和非表格
func buildCardContent(markdownText string) string {
	segments := splitByTables(markdownText)
	var elements []map[string]any
	for _, seg := range segments {
		if seg.isTable {
			table := markdownTableToCardTable(seg.text)
			if table != nil {
				elements = append(elements, table)
			}
		} else if strings.TrimSpace(seg.text) != "" {
			elements = append(elements, map[string]any{"tag": "markdown", "content": seg.text})
		}
	}
	if len(elements) == 0 {
		elements = append(elements, map[string]any{"tag": "markdown", "content": markdownText})
	}

	// 构建完整的卡片结构
	card := map[string]any{
		"schema": "2.0",
		"config": map[string]any{
			"wide_screen_mode": true,
			"update_multi":     true,
		},
		"header": map[string]any{
			"title": map[string]any{
				"tag":     "plain_text",
				"content": "AI 助手",
			},
			"template": "blue",
		},
		"body": map[string]any{
			"elements": elements,
		},
	}

	data, _ := json.Marshal(card)
	return string(data)
}

// buildStreamingCardContent 构建流式卡片 JSON（用于打字机效果）
func buildStreamingCardContent(content string) string {
	elements := []map[string]any{
		{
			"tag":        "markdown",
			"content":    content,
			"element_id": "markdown_content",
		},
	}

	card := map[string]any{
		"schema": "2.0",
		"config": map[string]any{
			"wide_screen_mode": true,
			"update_multi":     true,
			"streaming_mode":   true,
		},
		"header": map[string]any{
			"title": map[string]any{
				"tag":     "plain_text",
				"content": "AI 助手",
			},
			"template": "blue",
		},
		"body": map[string]any{
			"elements": elements,
		},
	}

	data, _ := json.Marshal(card)
	return string(data)
}

// textSegment 文本片段
type textSegment struct {
	text     string
	isTable  bool
}

// splitByTables 按表格分割文本
func splitByTables(text string) []textSegment {
	lines := strings.Split(text, "\n")
	var segments []textSegment
	var current []string
	inTable := false
	flush := func() {
		if len(current) > 0 {
			segments = append(segments, textSegment{text: strings.Join(current, "\n"), isTable: inTable})
			current = nil
		}
	}
	for _, line := range lines {
		t := strings.TrimSpace(line)
		isTL := strings.HasPrefix(t, "|") && strings.HasSuffix(t, "|") && strings.Count(t, "|") >= 3
		if isTL != inTable {
			flush()
			inTable = isTL
		}
		current = append(current, line)
	}
	flush()
	return segments
}

// markdownTableToCardTable 将 Markdown 表格转换为飞书卡片表格组件
func markdownTableToCardTable(tableText string) map[string]any {
	lines := strings.Split(tableText, "\n")
	var headerCells []string
	var dataRows [][]string
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if !strings.HasPrefix(t, "|") || !strings.HasSuffix(t, "|") {
			continue
		}
		cleaned := strings.ReplaceAll(t, "-", "")
		cleaned = strings.ReplaceAll(cleaned, " ", "")
		if cleaned == "||" || cleaned == "|" {
			continue
		}
		inner := strings.TrimPrefix(t, "|")
		inner = strings.TrimSuffix(inner, "|")
		cells := strings.Split(inner, "|")
		for i := range cells {
			cells[i] = strings.TrimSpace(cells[i])
		}
		if len(headerCells) == 0 {
			headerCells = cells
		} else {
			dataRows = append(dataRows, cells)
		}
	}
	if len(headerCells) == 0 {
		return nil
	}
	columns := make([]map[string]any, 0, len(headerCells))
	for i, h := range headerCells {
		columns = append(columns, map[string]any{
			"name":        fmt.Sprintf("col_%d", i),
			"display_name": h,
			"data_type":   "text",
			"width":       "auto",
		})
	}
	rows := make([]map[string]any, 0, len(dataRows))
	for _, dr := range dataRows {
		row := map[string]any{}
		for i := 0; i < len(columns); i++ {
			v := ""
			if i < len(dr) {
				v = dr[i]
			}
			row[fmt.Sprintf("col_%d", i)] = v
		}
		rows = append(rows, row)
	}
	return map[string]any{
		"tag":         "table",
		"page_size":   10,
		"header_style": map[string]any{"bold": true, "text_align": "left", "background_style": "blue", "text_color": "default"},
		"columns":     columns,
		"rows":        rows,
	}
}

// SetAgentHandler 配置 Agent 处理函数（支持流式）
func SetAgentHandler(f *FeishuChannel, ag *agent.BaseAgent) {
	// 使用流式处理实现打字机效果
	f.SetStreamHandler(func(ctx context.Context, msg *channel.Message, sendFunc func(content string) error) error {
		// 获取流式响应
		ch, err := ag.RunStream(ctx, &agent.Message{Role: "user", Content: msg.Content})
		if err != nil {
			return err
		}

		var fullContent strings.Builder
		content := "正在思考中..."
		if err := sendFunc(content); err != nil {
			log.Printf("发送初始卡片失败: %v", err)
		}

		// 定时器：每 300ms 更新一次
		ticker := time.NewTicker(300 * time.Millisecond)
		defer ticker.Stop()

		for {
			select {
			case chunk, ok := <-ch:
				if !ok {
					// 流结束，发送最终内容
					if fullContent.Len() > 0 {
						sendFunc(fullContent.String())
					}
					return nil
				}

				// 解析 delta
				for _, choice := range chunk.Choices {
					delta := llm.StreamDelta{}
					if err := json.Unmarshal(choice.Delta, &delta); err != nil {
						continue
					}
					if delta.Content != "" {
						fullContent.WriteString(delta.Content)
						content = fullContent.String()
					}
				}

			case <-ticker.C:
				// 定时更新
				if fullContent.Len() > 0 {
					if err := sendFunc(content); err != nil {
						log.Printf("更新卡片失败: %v", err)
					}
				}

			case <-ctx.Done():
				// 上下文取消
				if fullContent.Len() > 0 {
					sendFunc(fullContent.String())
				}
				return ctx.Err()
			}
		}
	})
}
