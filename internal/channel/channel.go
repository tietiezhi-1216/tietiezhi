package channel

import "context"

// Message 渠道消息
type Message struct {
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
	Content   string `json:"content"`
}

// Handler 消息处理函数类型
type Handler func(ctx context.Context, msg *Message) (*Message, error)

// Channel 渠道接口
type Channel interface {
	// ID 返回渠道唯一标识
	ID() string
	// Start 启动渠道
	Start(ctx context.Context) error
	// Stop 停止渠道
	Stop(ctx context.Context) error
	// Send 发送消息到渠道
	Send(ctx context.Context, channelID string, msg *Message) error
}

// Registry 渠道注册表
type Registry struct {
	channels map[string]Channel
}

// NewRegistry 创建渠道注册表
func NewRegistry() *Registry {
	return &Registry{
		channels: make(map[string]Channel),
	}
}

// Register 注册渠道
func (r *Registry) Register(ch Channel) {
	r.channels[ch.ID()] = ch
}

// Get 获取渠道
func (r *Registry) Get(id string) (Channel, bool) {
	ch, ok := r.channels[id]
	return ch, ok
}

// StartAll 启动所有渠道
func (r *Registry) StartAll(ctx context.Context) error {
	for _, ch := range r.channels {
		if err := ch.Start(ctx); err != nil {
			return err
		}
	}
	return nil
}

// StopAll 停止所有渠道
func (r *Registry) StopAll(ctx context.Context) error {
	for _, ch := range r.channels {
		_ = ch.Stop(ctx)
	}
	return nil
}
