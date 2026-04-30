package feishu

import (
	"context"
	"fmt"
	"log"
	"sync"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"

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

	// 创建飞书客户端
	f.client = lark.NewClient(f.appID, f.appSecret,
		lark.WithEventCallbackVerify(lark.EventCallbackVerify{
			VerificationToken: "",
			EncryptKey:        "",
		}),
	)

	// 注册消息事件处理器
	eventHandler := larkim.NewP2MessageReceiveV1Handler(
		func(ctx context.Context, event *larkim.P2MessageReceiveV1) error {
			return f.handleMessage(ctx, event)
		},
	)

	// 启动 WebSocket 长连接
	wsClient := lark.NewClient(f.appID, f.appSecret,
		lark.WithEventCallbackVerify(lark.EventCallbackVerify{}),
	)

	go func() {
		err := wsClient.Start(ctx, eventHandler)
		if err != nil {
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

	// 提取消息内容
	msg := event.Event.Message
	userID := ""
	if event.Event.Sender != nil && event.Event.Sender.SenderId != nil {
		userID = *event.Event.Sender.SenderId.OpenId
	}

	content := ""
	if msg.Content != nil {
		content = *msg.Content
	}

	chatID := ""
	if msg.ChatId != nil {
		chatID = *msg.ChatId
	}

	log.Printf("收到飞书消息: chatID=%s, userID=%s, content=%s", chatID, userID, content)

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
			return nil // 不返回错误，避免飞书重试
		}

		// 回复消息
		if reply != nil && reply.Content != "" {
			if err := f.Send(ctx, chatID, reply); err != nil {
				log.Printf("回复飞书消息出错: %v", err)
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

	// 构造飞书文本消息
	textContent := fmt.Sprintf(`{"text":"%s"}`, msg.Content)
	_, err := f.client.Im.Message.Create(ctx, larkim.NewCreateMessageReqBuilder().
		ReceiveIdType(larkim.ReceiveIdTypeChatId).
		Body(larkim.NewCreateMessageReqBodyBuilder().
			MsgType(larkim.MsgTypeText).
			ReceiveId(chatID).
			Content(textContent).
			Build()).
		Build())

	if err != nil {
		return fmt.Errorf("发送飞书消息失败: %w", err)
	}
	return nil
}
