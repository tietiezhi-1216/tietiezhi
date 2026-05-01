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

// Start 启动飞书渠道（WebSocket 长连接模式）
func (f *FeishuChannel) Start(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.running {
		return nil
	}

	// 创建飞书 API 客户端（用于发送消息）
	f.client = lark.NewClient(f.appID, f.appSecret)

	// 注册事件处理器
	eventHandler := dispatcher.NewEventDispatcher("", "").
		OnP2MessageReceiveV1(func(ctx context.Context, event *larkim.P2MessageReceiveV1) error {
			return f.handleMessage(ctx, event)
		})

	// 创建 WebSocket 长连接客户端
	wsClient := larkws.NewClient(f.appID, f.appSecret,
		larkws.WithEventHandler(eventHandler),
		larkws.WithLogLevel(larkcore.LogLevelDebug),
	)

	// 启动 WebSocket 长连接
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
		return nil
	}

	msg := event.Event.Message

	chatType := ""
	if msg.ChatType != nil {
		chatType = *msg.ChatType
	}

	// 群聊中，只处理 @机器人 的消息
	if chatType == "group" {
		if !f.isBotMentioned(event) {
			return nil
		}
	}

	// 提取用户 ID
	userID := ""
	if event.Event.Sender != nil && event.Event.Sender.SenderId != nil {
		userID = *event.Event.Sender.SenderId.OpenId
	}

	// 解析消息内容（支持 text 和 post 两种格式）
	content := f.parseMessageContent(msg, event)

	chatID := ""
	if msg.ChatId != nil {
		chatID = *msg.ChatId
	}

	messageID := ""
	if msg.MessageId != nil {
		messageID = *msg.MessageId
	}

	log.Printf("收到飞书消息: chatType=%s, chatID=%s, userID=%s, content=%s", chatType, chatID, userID, content)

	if content == "" {
		return nil
	}

	// 调用消息处理函数
	if f.handler != nil {
		input := &channel.Message{
			ChannelID: chatID,
			UserID:    userID,
			Content:   content,
		}

		reply, err := f.handler(ctx, input)
		if err != nil {
			log.Printf("处理飞书消息出错: %v", err)
			return nil
		}

		if reply != nil && reply.Content != "" {
			if chatType == "p2p" {
				if err := f.Send(ctx, chatID, reply); err != nil {
					log.Printf("发送飞书消息出错: %v", err)
				}
			} else {
				// 群聊中回复消息
				if err := f.Reply(ctx, messageID, reply); err != nil {
					log.Printf("回复飞书消息出错: %v", err)
				}
			}
		}
	}

	return nil
}

// isBotMentioned 检查群聊中是否 @了机器人
func (f *FeishuChannel) isBotMentioned(event *larkim.P2MessageReceiveV1) bool {
	if event.Event == nil || event.Event.Message == nil {
		return false
	}
	msg := event.Event.Message

	// 检查 mentions 数组
	if len(msg.Mentions) > 0 {
		return true
	}

	// 检查内容中的 @_user_ 占位符
	if msg.Content != nil {
		matched, _ := regexp.MatchString(`@_user_\d+`, *msg.Content)
		if matched {
			return true
		}
	}

	return false
}

// parseMessageContent 解析消息内容，兼容 text 和 post 格式
func (f *FeishuChannel) parseMessageContent(msg *larkim.Message, event *larkim.P2MessageReceiveV1) string {
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
			return f.cleanMentionPlaceholders(textMsg.Text, event)
		}

	case "post":
		return f.parsePostContent(rawContent, event)

	default:
		log.Printf("暂不支持的消息类型: %s", msgType)
	}

	return rawContent
}

// parsePostContent 解析飞书富文本消息
func (f *FeishuChannel) parsePostContent(rawContent string, event *larkim.P2MessageReceiveV1) string {
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
	return f.cleanMentionPlaceholders(result, event)
}

// cleanMentionPlaceholders 清理飞书消息中的 @mention 占位符
func (f *FeishuChannel) cleanMentionPlaceholders(text string, event *larkim.P2MessageReceiveV1) string {
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

// Send 发送消息到飞书（使用 Post 富文本格式）
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

// Reply 回复飞书消息（使用 Post 富文本格式）
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

// buildPostContent 将 Markdown 文本转换为飞书 Post 格式
// 使用 md 标签，飞书自动渲染 Markdown（加粗、代码块、列表、链接等）
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
