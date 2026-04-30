package feishu

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
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
	userID := ""
	if event.Event.Sender != nil && event.Event.Sender.SenderId != nil {
		userID = *event.Event.Sender.SenderId.OpenId
	}

	// 解析飞书文本消息格式：{"text":"xxx"}
	content := ""
	if msg.Content != nil {
		var textMsg struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal([]byte(*msg.Content), &textMsg); err == nil {
			content = textMsg.Text
		} else {
			content = *msg.Content
		}
	}

	chatID := ""
	if msg.ChatId != nil {
		chatID = *msg.ChatId
	}

	chatType := ""
	if msg.ChatType != nil {
		chatType = *msg.ChatType
	}

	log.Printf("收到飞书消息: chatID=%s, chatType=%s, userID=%s, content=%s", chatID, chatType, userID, content)

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

		// 回复消息
		if reply != nil && reply.Content != "" {
			// 群聊用 reply，单聊用 create
			if chatType == "p2p" {
				if err := f.Send(ctx, chatID, reply); err != nil {
					log.Printf("发送飞书消息出错: %v", err)
				}
			} else {
				// 群聊中回复消息
				messageID := ""
				if msg.MessageId != nil {
					messageID = *msg.MessageId
				}
				if err := f.Reply(ctx, messageID, reply); err != nil {
					log.Printf("回复飞书消息出错: %v", err)
				}
			}
		}
	}

	return nil
}

// Stop 停止飞书渠道
func (f *FeishuChannel) Stop(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.running = false
	log.Println("飞书渠道已停止")
	return nil
}

// Send 发送消息到飞书
func (f *FeishuChannel) Send(ctx context.Context, chatID string, msg *channel.Message) error {
	if f.client == nil {
		return fmt.Errorf("飞书客户端未初始化")
	}

	textContent, _ := json.Marshal(map[string]string{"text": msg.Content})
	_, err := f.client.Im.Message.Create(ctx, larkim.NewCreateMessageReqBuilder().
		ReceiveIdType(larkim.ReceiveIdTypeChatId).
		Body(larkim.NewCreateMessageReqBodyBuilder().
			MsgType(larkim.MsgTypeText).
			ReceiveId(chatID).
			Content(string(textContent)).
			Build()).
		Build())

	if err != nil {
		return fmt.Errorf("发送飞书消息失败: %w", err)
	}
	return nil
}

// Reply 回复飞书消息
func (f *FeishuChannel) Reply(ctx context.Context, messageID string, msg *channel.Message) error {
	if f.client == nil {
		return fmt.Errorf("飞书客户端未初始化")
	}

	if messageID == "" {
		return fmt.Errorf("消息 ID 为空")
	}

	textContent, _ := json.Marshal(map[string]string{"text": msg.Content})
	_, err := f.client.Im.Message.Reply(ctx, larkim.NewReplyMessageReqBuilder().
		Body(larkim.NewReplyMessageReqBodyBuilder().
			MsgType(larkim.MsgTypeText).
			Content(string(textContent)).
			Build()).
		MessageId(messageID).
		Build())

	if err != nil {
		return fmt.Errorf("回复飞书消息失败: %w", err)
	}
	return nil
}
