package feishu

import (
	"context"
	"fmt"

	"tietiezhi/internal/channel"
)

// FeishuChannel 飞书渠道
type FeishuChannel struct {
	appID     string
	appSecret string
}

// New 创建飞书渠道
func New(appID, appSecret string) *FeishuChannel {
	return &FeishuChannel{
		appID:     appID,
		appSecret: appSecret,
	}
}

// ID 返回渠道标识
func (f *FeishuChannel) ID() string { return "feishu" }

// Start 启动飞书渠道
func (f *FeishuChannel) Start(ctx context.Context) error {
	// TODO: Phase 3 实现飞书 WebSocket 长连接
	return fmt.Errorf("飞书渠道尚未实现")
}

// Stop 停止飞书渠道
func (f *FeishuChannel) Stop(ctx context.Context) error {
	// TODO: Phase 3 实现
	return nil
}

// Send 发送消息到飞书
func (f *FeishuChannel) Send(ctx context.Context, channelID string, msg *channel.Message) error {
	// TODO: Phase 3 实现
	return fmt.Errorf("飞书渠道尚未实现")
}
