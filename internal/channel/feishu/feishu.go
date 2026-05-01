package feishu

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strings"
	"sync"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"

	"tietiezhi/internal/channel"
)

// FeishuChannel 飞书渠道
type FeishuChannel struct {
	appID     string
	appSecret string
	client    *lark.Client
	handler   func(ctx context.Context, msg *channel.Message) (*channel.Message, error)
	mu        sync.Mutex
	running   bool
}

// New 创建飞书渠道
func New(appID, appSecret string) *FeishuChannel {
	return &FeishuChannel{
		appID:     appID,
		appSecret: appSecret,
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

	f.running = true
	log.Println("飞书渠道已启动（WebSocket 模式）")
	return nil
}

// handleMessage 处理飞书消息事件
func (f *FeishuChannel) handleMessage(ctx context.Context, event *larkim.P2MessageReceiveV1) error {
	if event.Event == nil || event.Event.Message == nil {
		log.Printf("飞书事件: Event 或 Message 为空")
		return nil
	}

	msg := event.Event.Message

	chatType := ""
	if msg.ChatType != nil {
		chatType = *msg.ChatType
	}

	chatID := ""
	if msg.ChatId != nil {
		chatID = *msg.ChatId
	}

	messageID := ""
	if msg.MessageId != nil {
		messageID = *msg.MessageId
	}

	msgType := ""
	if msg.MessageType != nil {
		msgType = *msg.MessageType
	}

	// 记录所有收到的消息（调试用）
	log.Printf("飞书原始消息: chatType=%s, msgType=%s, chatID=%s, messageID=%s, mentions=%d",
		chatType, msgType, chatID, messageID, len(msg.Mentions))

	if msg.Content != nil {
		log.Printf("飞书原始内容: %s", *msg.Content)
	}

	// 群聊中，只处理 @机器人 的消息
	if chatType == "group" {
		if !f.isBotMentioned(msg) {
			log.Printf("群聊消息但未 @机器人，跳过")
			return nil
		}
		log.Printf("群聊消息，已 @机器人，开始处理")
	}

	userID := ""
	if event.Event.Sender != nil && event.Event.Sender.SenderId != nil {
		userID = *event.Event.Sender.SenderId.OpenId
	}

	content := f.parseMessageContent(msg)

	if content == "" {
		log.Printf("消息内容为空，跳过")
		return nil
	}

	log.Printf("处理飞书消息: chatType=%s, content=%s", chatType, content)

	if f.handler != nil {
		// 群聊：先给消息加表情回复（typing indicator）
		if chatType == "group" && messageID != "" {
			f.addTypingReaction(ctx, messageID)
		}

		input := &channel.Message{
			ChannelID: chatID,
			UserID:    userID,
			Content:   content,
		}

		reply, err := f.handler(ctx, input)
		if err != nil {
			log.Printf("处理飞书消息出错: %v", err)
			// 出错也要移除 typing 表情
			if chatType == "group" && messageID != "" {
				f.removeTypingReaction(ctx, messageID)
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

		// 处理完成后移除 typing 表情
		if chatType == "group" && messageID != "" {
			f.removeTypingReaction(ctx, messageID)
		}
	}

	return nil
}

// addTypingReaction 给消息添加 "处理中" 表情回复
func (f *FeishuChannel) addTypingReaction(ctx context.Context, messageID string) {
	_, err := f.client.Im.MessageReaction.Create(ctx, larkim.NewCreateMessageReactionReqBuilder().
		MessageId(messageID).
		Body(larkim.NewCreateMessageReactionReqBodyBuilder().
			ReactionType(larkim.NewReactionTypeBuilder().
				EmojiType("Typing").
				Build()).
			Build()).
		Build())
	if err != nil {
		log.Printf("添加 Typing 表情失败: %v", err)
	} else {
		log.Printf("已添加 Typing 表情到消息 %s", messageID)
	}
}

// removeTypingReaction 移除消息的 "处理中" 表情回复
func (f *FeishuChannel) removeTypingReaction(ctx context.Context, messageID string) {
	// 先获取表情列表找到 reaction_id
	resp, err := f.client.Im.MessageReaction.List(ctx, larkim.NewListMessageReactionReqBuilder().
		MessageId(messageID).
		PageSize(50).
		Build())
	if err != nil {
		log.Printf("获取表情列表失败: %v", err)
		return
	}

	if resp == nil || resp.Data == nil || resp.Data.Items == nil {
		return
	}

	// 找到 Typing 表情的 reaction_id
	for _, item := range resp.Data.Items {
		if item.ReactionType != nil && item.ReactionType.EmojiType != nil {
			if *item.ReactionType.EmojiType == "Typing" && item.ReactionId != nil {
				_, err := f.client.Im.MessageReaction.Delete(ctx, larkim.NewDeleteMessageReactionReqBuilder().
					MessageId(messageID).
					ReactionId(*item.ReactionId).
					Build())
				if err != nil {
					log.Printf("移除 Typing 表情失败: %v", err)
				} else {
					log.Printf("已移除 Typing 表情")
				}
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
func buildPostContent(markdownText string) string {
	post := map[string]any{
		"zh_cn": map[string]any{
			"content": [][]map[string]any{
				{
					{
						"tag":  "md",
						"text": markdownText,
					},
				},
			},
		},
	}
	data, _ := json.Marshal(post)
	return string(data)
}
