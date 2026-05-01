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

type FeishuChannel struct {
	appID       string
	appSecret   string
	client      *lark.Client
	handler     func(ctx context.Context, msg *channel.Message) (*channel.Message, error)
	mu          sync.Mutex
	running     bool
	processedMu sync.Mutex
	processed   map[string]time.Time
}

func New(appID, appSecret string) *FeishuChannel {
	return &FeishuChannel{
		appID:     appID,
		appSecret: appSecret,
		processed: make(map[string]time.Time),
	}
}

func (f *FeishuChannel) SetHandler(handler func(ctx context.Context, msg *channel.Message) (*channel.Message, error)) {
	f.handler = handler
}

func (f *FeishuChannel) ID() string { return "feishu" }

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

func (f *FeishuChannel) isDuplicate(messageID string) bool {
	f.processedMu.Lock()
	defer f.processedMu.Unlock()
	if _, ok := f.processed[messageID]; ok {
		return true
	}
	f.processed[messageID] = time.Now()
	return false
}

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
	if f.handler != nil {
		if chatType == "group" && messageID != "" {
			f.addReaction(ctx, messageID, "THINKING")
		}
		input := &channel.Message{ChannelID: chatID, UserID: userID, Content: content}
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
		if chatType == "group" && messageID != "" {
			f.removeReaction(ctx, messageID, "THINKING")
		}
	}
	return nil
}

func (f *FeishuChannel) addReaction(ctx context.Context, messageID, emojiType string) {
	_, err := f.client.Im.MessageReaction.Create(ctx, larkim.NewCreateMessageReactionReqBuilder().
		MessageId(messageID).
		Body(larkim.NewCreateMessageReactionReqBodyBuilder().
			ReactionType(larkim.NewEmojiBuilder().EmojiType(emojiType).Build()).Build()).Build())
	if err != nil {
		log.Printf("添加表情失败: %v", err)
	}
}

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
			if err := json.Unmarshal(data, &postContent); err == nil { break }
		}
	}
	var parts []string
	if postContent.Title != "" { parts = append(parts, postContent.Title) }
	for _, paragraph := range postContent.Content {
		var lineParts []string
		for _, element := range paragraph {
			var elem struct {
				Tag string `json:"tag"`; Text string `json:"text"`; Href string `json:"href"`
				UserId string `json:"user_id"`; Language string `json:"language"`
			}
			if err := json.Unmarshal(element, &elem); err != nil { continue }
			switch elem.Tag {
			case "text": lineParts = append(lineParts, elem.Text)
			case "a":
				if elem.Href != "" { lineParts = append(lineParts, fmt.Sprintf("[%s](%s)", elem.Text, elem.Href)) } else { lineParts = append(lineParts, elem.Text) }
			case "at": lineParts = append(lineParts, fmt.Sprintf("@%s", elem.UserId))
			case "code_block": lineParts = append(lineParts, fmt.Sprintf("```%s\n%s\n```", elem.Language, elem.Text))
			case "hr": lineParts = append(lineParts, "---")
			case "md": lineParts = append(lineParts, elem.Text)
			default: if elem.Text != "" { lineParts = append(lineParts, elem.Text) }
			}
		}
		if len(lineParts) > 0 { parts = append(parts, strings.Join(lineParts, "")) }
	}
	return cleanMentionPlaceholders(strings.Join(parts, "\n"))
}

func cleanMentionPlaceholders(text string) string {
	re := regexp.MustCompile(`@_user_\d+`)
	return strings.TrimSpace(re.ReplaceAllString(text, ""))
}

func (f *FeishuChannel) Stop(ctx context.Context) error {
	f.mu.Lock(); defer f.mu.Unlock(); f.running = false; log.Println("飞书渠道已停止"); return nil
}

// Send 自动判断用 Post 还是 Card
func (f *FeishuChannel) Send(ctx context.Context, chatID string, msg *channel.Message) error {
	if f.client == nil { return fmt.Errorf("飞书客户端未初始化") }
	if containsMarkdownTable(msg.Content) {
		return f.sendCardMessage(ctx, chatID, "", msg.Content)
	}
	content := buildPostContent(msg.Content)
	_, err := f.client.Im.Message.Create(ctx, larkim.NewCreateMessageReqBuilder().
		ReceiveIdType(larkim.ReceiveIdTypeChatId).
		Body(larkim.NewCreateMessageReqBodyBuilder().MsgType(larkim.MsgTypePost).ReceiveId(chatID).Content(content).Build()).Build())
	if err != nil { return fmt.Errorf("发送飞书消息失败: %w", err) }
	return nil
}

// Reply 自动判断用 Post 还是 Card
func (f *FeishuChannel) Reply(ctx context.Context, messageID string, msg *channel.Message) error {
	if f.client == nil { return fmt.Errorf("飞书客户端未初始化") }
	if messageID == "" { return fmt.Errorf("消息 ID 为空") }
	if containsMarkdownTable(msg.Content) {
		return f.sendCardMessage(ctx, "", messageID, msg.Content)
	}
	content := buildPostContent(msg.Content)
	_, err := f.client.Im.Message.Reply(ctx, larkim.NewReplyMessageReqBuilder().
		Body(larkim.NewReplyMessageReqBodyBuilder().MsgType(larkim.MsgTypePost).Content(content).Build()).MessageId(messageID).Build())
	if err != nil { return fmt.Errorf("回复飞书消息失败: %w", err) }
	return nil
}

// sendCardMessage 发送飞书卡片消息
func (f *FeishuChannel) sendCardMessage(ctx context.Context, chatID, replyMessageID, markdownText string) error {
	cardJSON := buildCardContent(markdownText)
	if replyMessageID != "" {
		_, err := f.client.Im.Message.Reply(ctx, larkim.NewReplyMessageReqBuilder().
			Body(larkim.NewReplyMessageReqBodyBuilder().MsgType("interactive").Content(cardJSON).Build()).MessageId(replyMessageID).Build())
		if err != nil { return fmt.Errorf("回复飞书卡片失败: %w", err) }
	} else {
		_, err := f.client.Im.Message.Create(ctx, larkim.NewCreateMessageReqBuilder().
			ReceiveIdType(larkim.ReceiveIdTypeChatId).
			Body(larkim.NewCreateMessageReqBodyBuilder().MsgType("interactive").ReceiveId(chatID).Content(cardJSON).Build()).Build())
		if err != nil { return fmt.Errorf("发送飞书卡片失败: %w", err) }
	}
	return nil
}

func containsMarkdownTable(text string) bool {
	lines := strings.Split(text, "\n")
	count := 0
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "|") && strings.HasSuffix(t, "|") && strings.Count(t, "|") >= 3 { count++ }
	}
	return count >= 2
}

func buildPostContent(markdownText string) string {
	post := map[string]any{"zh_cn": map[string]any{"content": [][]map[string]any{{{  "tag": "md", "text": markdownText,}}}}}
	data, _ := json.Marshal(post)
	return string(data)
}

// buildCardContent 构建飞书卡片 JSON 2.0，自动拆分表格和非表格
func buildCardContent(markdownText string) string {
	segments := splitByTables(markdownText)
	var elements []map[string]any
	for _, seg := range segments {
		if seg.isTable {
			table := markdownTableToCardTable(seg.text)
			if table != nil { elements = append(elements, table) }
		} else if strings.TrimSpace(seg.text) != "" {
			elements = append(elements, map[string]any{"tag": "markdown", "content": seg.text})
		}
	}
	if len(elements) == 0 {
		elements = append(elements, map[string]any{"tag": "markdown", "content": markdownText})
	}
	card := map[string]any{"schema": "2.0", "body": map[string]any{"elements": elements}}
	data, _ := json.Marshal(card)
	return string(data)
}

type textSegment struct { text string; isTable bool }

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
		if isTL != inTable { flush(); inTable = isTL }
		current = append(current, line)
	}
	flush()
	return segments
}

func markdownTableToCardTable(tableText string) map[string]any {
	lines := strings.Split(tableText, "\n")
	var headerCells []string
	var dataRows [][]string
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if !strings.HasPrefix(t, "|") || !strings.HasSuffix(t, "|") { continue }
		cleaned := strings.ReplaceAll(t, "-", ""); cleaned = strings.ReplaceAll(cleaned, " ", "")
		if cleaned == "||" || cleaned == "|" { continue }
		inner := strings.TrimPrefix(t, "|"); inner = strings.TrimSuffix(inner, "|")
		cells := strings.Split(inner, "|")
		for i := range cells { cells[i] = strings.TrimSpace(cells[i]) }
		if len(headerCells) == 0 { headerCells = cells } else { dataRows = append(dataRows, cells) }
	}
	if len(headerCells) == 0 { return nil }
	columns := make([]map[string]any, 0, len(headerCells))
	for i, h := range headerCells {
		columns = append(columns, map[string]any{
			"name": fmt.Sprintf("col_%d", i), "display_name": h, "data_type": "text", "width": "auto",
		})
	}
	rows := make([]map[string]any, 0, len(dataRows))
	for _, dr := range dataRows {
		row := map[string]any{}
		for i := 0; i < len(columns); i++ {
			v := ""
			if i < len(dr) { v = dr[i] }
			row[fmt.Sprintf("col_%d", i)] = v
		}
		rows = append(rows, row)
	}
	return map[string]any{
		"tag": "table", "page_size": 10,
		"header_style": map[string]any{"bold": true, "text_align": "left", "background_style": "blue", "text_color": "default"},
		"columns": columns, "rows": rows,
	}
}
