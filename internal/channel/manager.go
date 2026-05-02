package channel

import (
	"context"
	"fmt"
	"log"
	"sync"
)

// AgentInterface Agent 接口（用于处理消息）
type AgentInterface interface {
	Run(ctx context.Context, sessionKey string, isGroup bool, chatID string, input *Message) (*Message, error)
}

// MultiChannelManager 多渠道管理器
type MultiChannelManager struct {
	registry  *Registry
	handlers  map[string]Handler // channelID -> handler
	agent     AgentInterface
	mu        sync.RWMutex
}

// NewMultiChannelManager 创建多渠道管理器
func NewMultiChannelManager(registry *Registry) *MultiChannelManager {
	return &MultiChannelManager{
		registry: registry,
		handlers: make(map[string]Handler),
	}
}

// SetAgent 设置 Agent 实例
func (m *MultiChannelManager) SetAgent(agent AgentInterface) {
	m.agent = agent
}

// RegisterHandler 注册消息处理函数
func (m *MultiChannelManager) RegisterHandler(channelID string, handler Handler) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.handlers[channelID] = handler
}

// GetHandler 获取处理函数
func (m *MultiChannelManager) GetHandler(channelID string) (Handler, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	handler, ok := m.handlers[channelID]
	return handler, ok
}

// RouteMessage 路由消息到指定渠道
func (m *MultiChannelManager) RouteMessage(ctx context.Context, channelID string, channelType string, msg *Message) error {
	// 查找渠道
	channel, ok := m.registry.Get(channelID)
	if !ok {
		return fmt.Errorf("渠道不存在: %s", channelID)
	}

	// 发送消息
	return channel.Send(ctx, channelID, msg)
}

// Broadcast 广播消息到所有渠道
func (m *MultiChannelManager) Broadcast(ctx context.Context, msg *Message) error {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var lastErr error
	for channelID, ch := range m.registry.channels {
		if err := ch.Send(ctx, channelID, msg); err != nil {
			log.Printf("[MultiChannelManager] 广播到渠道 %s 失败: %v", channelID, err)
			lastErr = err
		}
	}

	return lastErr
}

// HealthCheck 检查所有渠道健康状态
func (m *MultiChannelManager) HealthCheck() map[string]bool {
	results := make(map[string]bool)

	m.mu.RLock()
	defer m.mu.RUnlock()

	for channelID := range m.registry.channels {
		// 这里假设每个 Channel 实现都有健康检查机制
		// 如果没有，可以扩展 Channel 接口添加 HealthCheck 方法
		results[channelID] = true // 默认认为健康
	}

	return results
}

// ListChannels 列出所有已注册的渠道
func (m *MultiChannelManager) ListChannels() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	channels := make([]string, 0, len(m.handlers))
	for channelID := range m.handlers {
		channels = append(channels, channelID)
	}
	return channels
}

// GetRegistry 获取渠道注册表
func (m *MultiChannelManager) GetRegistry() *Registry {
	return m.registry
}

// MessageConverter 消息格式转换接口
type MessageConverter interface {
	ToChannel(msg *Message) (*Message, error)
	FromChannel(msg *Message) (*Message, error)
}

// DefaultMessageConverter 默认消息转换器
type DefaultMessageConverter struct{}

// NewDefaultMessageConverter 创建默认消息转换器
func NewDefaultMessageConverter() *DefaultMessageConverter {
	return &DefaultMessageConverter{}
}

// ToChannel 转换为渠道消息格式
func (c *DefaultMessageConverter) ToChannel(msg *Message) (*Message, error) {
	// 默认实现直接返回原消息
	return msg, nil
}

// FromChannel 从渠道消息格式转换
func (c *DefaultMessageConverter) FromChannel(msg *Message) (*Message, error) {
	// 默认实现直接返回原消息
	return msg, nil
}
