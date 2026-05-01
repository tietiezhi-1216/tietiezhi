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
	"tietiezhi/internal/session"
)

// FeishuChannel 飞书渠道
type FeishuChannel struct {
	appID        string
	appSecret    string
	botOpenID    string
	client       *lark.Client
	handler      func(ctx context.Context, msg *channel.Message) (*channel.Message, error)
	streamHandler func(ctx context.Context, msg *channel.Message, sendFunc func(content string, isFinal bool) error) error
	mu           sync.Mutex
	running      bool
	processedMu  sync.Mutex
	processed    map[string]time.Time
}

// New 创建飞书渠道
// New 创建飞书渠道（botOpenID 可选，如果 API 获取失败则使用配置值）
func New(appID, appSecret string, botOpenID ...string) *FeishuChannel {
	f := &FeishuChannel{
		appID:     appID,
		appSecret: appSecret,
		processed: make(map[string]time.Time),
	}
	if len(botOpenID) > 0 && botOpenID[0] != "" {
		f.botOpenID = botOpenID[0]
		log.Printf("使用配置的机器人 OpenID: %s", f.botOpenID)
	}
	return f
}

// SetHandler 设置消息处理函数（同步模式）
func (f *FeishuChannel) SetHandler(handler func(ctx context.Context, msg *channel.Message) (*channel.Message, error)) {
	f.handler = handler
}

// SetStreamHandler 设置流式消息处理函数（流式模式）
func (f *FeishuChannel) SetStreamHandler(handler func(ctx context.Context, msg *channel.Message, sendFunc func(content string, isFinal bool) error) error) {
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
	// 获取机器人 OpenID
	f.fetchBotOpenID(ctx)
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
		// 所有消息都加 THINKING 表情（不管群聊还是私聊）
		if messageID != "" {
			f.addReaction(ctx, messageID, "THINKING")
		}

		// 群聊消息加上发言者标识，让模型能感知不同发言者
		messageContent := content
		if chatType == "group" && userID != "" {
			messageContent = fmt.Sprintf("[%s]: %s", userID, content)
		}
		input := &channel.Message{ChannelID: chatID, UserID: userID, Content: messageContent, ChatType: chatType}

		// 优先使用流式处理
		if f.streamHandler != nil {
			// 流式模式：先发送初始卡片，然后逐步更新
			var sentMessageID string
			var replyMode bool
			if messageID != "" {
				replyMode = true
			}

			sendFunc := func(content string, isFinal bool) error {
				// 清理 Markdown 格式
				cleanContent := sanitizeMarkdown(content)

				// 构建卡片内容
				var cardJSON string
				if isFinal {
					// 最终内容使用 buildCardContent（含表格检测）
					cardJSON = buildCardContent(cleanContent)
				} else {
					// 流式内容使用简单的 markdown 组件
					cardJSON = buildStreamingCardContent(cleanContent, "streaming")
				}

				// 如果还没有发送消息，先发送
				if sentMessageID == "" {
					var err error
					if replyMode {
						resp, err := f.client.Im.Message.Reply(ctx, larkim.NewReplyMessageReqBuilder().
							Body(larkim.NewReplyMessageReqBodyBuilder().MsgType("interactive").Content(cardJSON).Build()).
							MessageId(messageID).Build())
						if err == nil && resp != nil && resp.Data != nil && resp.Data.MessageId != nil {
							sentMessageID = *resp.Data.MessageId
						}
					} else {
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

				// 更新已发送的卡片（使用 UpdateMessage）
				var updateContent string
				if isFinal {
					updateContent = buildCardContent(cleanContent)
				} else {
					updateContent = buildStreamingCardContent(cleanContent, "streaming")
				}

				_, err := f.client.Im.Message.Update(ctx, larkim.NewUpdateMessageReqBuilder().
					MessageId(sentMessageID).
					Body(larkim.NewUpdateMessageReqBodyBuilder().
						MsgType("interactive").
						Content(updateContent).
						Build()).
					Build())
				return err
			}

			err := f.streamHandler(ctx, input, sendFunc)
			if err != nil {
				log.Printf("处理飞书流式消息出错: %v", err)
				// 发送错误提示卡片
				if sentMessageID != "" {
					f.client.Im.Message.Update(ctx, larkim.NewUpdateMessageReqBuilder().
						MessageId(sentMessageID).
						Body(larkim.NewUpdateMessageReqBodyBuilder().
							MsgType("interactive").
							Content(buildCardContent("⚠️ 处理消息时发生错误，请稍后重试。")).
							Build()).
						Build())
				}
				if messageID != "" {
					f.removeReaction(ctx, messageID, "THINKING")
				}
				return nil
			}
		} else if f.handler != nil {
			// 同步模式
			reply, err := f.handler(ctx, input)
			if err != nil {
				log.Printf("处理飞书消息出错: %v", err)
				if messageID != "" {
					f.removeReaction(ctx, messageID, "THINKING")
				}
				return nil
			}
			// 所有消息优先用 Reply API 回复，如果 messageID 为空才 fallback 到 Create
			if reply != nil && reply.Content != "" {
				if messageID != "" {
					if err := f.Reply(ctx, messageID, reply); err != nil {
						log.Printf("回复飞书消息出错: %v", err)
					}
				} else {
					if err := f.Send(ctx, chatID, reply); err != nil {
						log.Printf("发送飞书消息出错: %v", err)
					}
				}
			}
		}

		if messageID != "" {
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

// fetchBotOpenID 获取机器人 OpenID
// 注意：如果 New 函数传入了 botOpenID，这里会打印确认；如果未传入，则只打印提示
func (f *FeishuChannel) fetchBotOpenID(ctx context.Context) {
	if f.botOpenID != "" {
		log.Printf("使用配置的机器人 OpenID: %s", f.botOpenID)
	} else {
		log.Printf("未配置机器人 OpenID，将使用降级逻辑（任何 @ 都会响应）")
	}
}

// isBotMentioned 检查机器人是否被提及（精确匹配）
func (f *FeishuChannel) isBotMentioned(msg *larkim.EventMessage) bool {
	// 如果已知 botOpenID，精确匹配
	if f.botOpenID != "" && len(msg.Mentions) > 0 {
		for _, mention := range msg.Mentions {
			if mention.Id != nil && mention.Id.OpenId != nil && *mention.Id.OpenId == f.botOpenID {
				return true
			}
		}
		return false // mentions 中有人被@，但不是@机器人
	}
	// 如果未知 botOpenID，降级到旧行为（有 mention 就响应）
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
	cardJSON := buildCardContent(sanitizeMarkdown(msg.Content))
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
	cardJSON := buildCardContent(sanitizeMarkdown(msg.Content))
	_, err := f.client.Im.Message.Reply(ctx, larkim.NewReplyMessageReqBuilder().
		Body(larkim.NewReplyMessageReqBodyBuilder().MsgType("interactive").Content(cardJSON).Build()).
		MessageId(messageID).Build())
	if err != nil {
		return fmt.Errorf("回复飞书卡片失败: %w", err)
	}
	return nil
}

// sanitizeMarkdown 清理 Markdown 格式，转换为飞书卡片兼容格式
func sanitizeMarkdown(text string) string {
	if text == "" {
		return text
	}

	// 1. Checkbox 转换: - [ ] -> - ☐, - [x] 或 - [X] -> - ☑
	text = regexp.MustCompile(`- \[ \]`).ReplaceAllString(text, "- ☐")
	text = regexp.MustCompile(`- \[x\]`).ReplaceAllString(text, "- ☑")
	text = regexp.MustCompile(`- \[X\]`).ReplaceAllString(text, "- ☑")

	// 2. 图片语法转链接: ![alt](url) -> [alt](url)
	text = regexp.MustCompile(`!\[([^\]]*)\]\(([^)]+)\)`).ReplaceAllString(text, "[$1]($2)")

	// 3. 去除 HTML 标签
	text = regexp.MustCompile(`<[^>]+>`).ReplaceAllString(text, "")

	// 4. 去除飞书不支持的语法
	// 去除脚注语法 [^1]
	text = regexp.MustCompile(`\[[\^]?\d+\]`).ReplaceAllString(text, "")

	return strings.TrimSpace(text)
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

// buildCardContent 构建飞书卡片 JSON 2.0，自动拆分表格和非表格（无 header）
func buildCardContent(markdownText string) string {
	markdownText = strings.TrimSpace(markdownText)
	segments := splitByTables(markdownText)
	var elements []map[string]any
	for _, seg := range segments {
		if seg.isTable {
			table := markdownTableToCardTable(seg.text)
			if table != nil {
				elements = append(elements, table)
			}
		} else if strings.TrimSpace(seg.text) != "" {
			elements = append(elements, map[string]any{"tag": "markdown", "content": seg.text, "text_size": "heading"})
		}
	}
	if len(elements) == 0 {
		elements = append(elements, map[string]any{"tag": "markdown", "content": markdownText, "text_size": "heading"})
	}

	// 构建完整的卡片结构（无 header）
	card := map[string]any{
		"schema": "2.0",
		"config": map[string]any{
			"wide_screen_mode": true,
			"update_multi":     true,
		},
		"body": map[string]any{
			"elements": elements,
		},
	}

	data, _ := json.Marshal(card)
	return string(data)
}

// buildStreamingCardContent 构建流式卡片 JSON（用于打字机效果，无 header）
func buildStreamingCardContent(content string, streamingStatus string) string {
	content = strings.TrimSpace(content)
	elements := []map[string]any{
		{
			"tag":        "markdown",
			"content":    content,
			"element_id": "streaming_md",
			"text_size":  "heading",
		},
	}

	// 流式状态：streaming 表示正在输入，finished 表示完成
	streamingMode := streamingStatus == "streaming"

	card := map[string]any{
		"schema": "2.0",
		"config": map[string]any{
			"wide_screen_mode": true,
			"update_multi":     true,
			"streaming_mode":   streamingMode,
			"summary": map[string]any{
				"content": "AI 正在回复...",
			},
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
	text    string
	isTable bool
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
			"name":         fmt.Sprintf("col_%d", i),
			"display_name": h,
			"data_type":    "text",
			"width":        "auto",
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
		"tag":          "table",
		"page_size":    10,
		"header_style": map[string]any{"bold": true, "text_align": "left", "background_style": "blue", "text_color": "default"},
		"columns":      columns,
		"rows":         rows,
	}
}

// SetAgentHandler 配置 Agent 处理函数（支持流式/非流式双模式）
func SetAgentHandler(f *FeishuChannel, ag *agent.BaseAgent, streaming bool) {
	if streaming {
		// 流式模式：CardKit 打字机效果
		f.SetStreamHandler(func(ctx context.Context, msg *channel.Message, sendFunc func(content string, isFinal bool) error) error {
			ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
			defer cancel()

			sessionKey := session.BuildSessionKey(msg.ChatType, msg.ChannelID, msg.UserID)

			ch, err := ag.RunStream(ctx, sessionKey, msg.ChatType == "group", &agent.Message{Role: "user", Content: msg.Content})
			if err != nil {
				return err
			}

			var fullContent strings.Builder
			content := "🤔 思考中..."
			if err := sendFunc(content, false); err != nil {
				log.Printf("发送初始卡片失败: %v", err)
			}

			var (
				lastUpdateTime       = time.Now()
				chunkCount           = 0
				updateInterval       = 300 * time.Millisecond
				maxChunkBeforeUpdate = 3
			)

			for {
				var chunk llm.StreamChunk
				readCtx, readCancel := context.WithTimeout(ctx, 30*time.Second)

				select {
				case <-readCtx.Done():
					readCancel()
					if fullContent.Len() > 0 {
						ag.AppendToSession(sessionKey, fullContent.String())
						sendFunc(fullContent.String(), true)
					}
					return nil
				case chunk = <-ch:
					readCancel()
			case <-ctx.Done():
					readCancel()
					if fullContent.Len() > 0 {
						ag.AppendToSession(sessionKey, fullContent.String())
						sendFunc(fullContent.String(), true)
					}
					return ctx.Err()
				}

				for _, choice := range chunk.Choices {
					delta := llm.StreamDelta{}
					if err := json.Unmarshal(choice.Delta, &delta); err != nil {
						continue
					}
					if delta.Content != "" {
						fullContent.WriteString(delta.Content)
						content = fullContent.String()
						chunkCount++
					}
				}

				shouldUpdate := false
				if time.Since(lastUpdateTime) >= updateInterval {
					shouldUpdate = true
				} else if chunkCount >= maxChunkBeforeUpdate {
					shouldUpdate = true
				}

				if shouldUpdate && fullContent.Len() > 0 {
					if err := sendFunc(content, false); err != nil {
						log.Printf("更新卡片失败: %v", err)
					}
					lastUpdateTime = time.Now()
					chunkCount = 0
				}
			}
		})
	} else {
		// 非流式模式（Legacy）：等完整回复后一次性发卡片
		f.SetHandler(func(ctx context.Context, msg *channel.Message) (*channel.Message, error) {
			ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
			defer cancel()

			sessionKey := session.BuildSessionKey(msg.ChatType, msg.ChannelID, msg.UserID)

			log.Printf("[Legacy] 开始处理消息: sessionKey=%s, content=%s", sessionKey, msg.Content)

			// 同步调用 LLM，等完整回复
			reply, err := ag.Run(ctx, sessionKey, msg.ChatType == "group", &agent.Message{Role: "user", Content: msg.Content})
			if err != nil {
				log.Printf("[Legacy] LLM 调用失败: %v", err)
				return &channel.Message{Content: "⚠️ 处理消息时发生错误，请稍后重试。"}, nil
			}

			log.Printf("[Legacy] LLM 回复完成: sessionKey=%s, replyLen=%d", sessionKey, len(reply.Content))
			return &channel.Message{Content: reply.Content}, nil
		})
	}
}
