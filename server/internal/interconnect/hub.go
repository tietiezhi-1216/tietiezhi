// Package interconnect 实现「万物互联」设备 hub：一个核心（章鱼头），
// 每台连接的设备是一条触手。设备通过 WebSocket 连上来注册身份，
// hub 负责在线状态广播（presence）与设备间消息路由（点对点 / 广播）。
package interconnect

import (
	"encoding/json"
	"sync"
)

// Message type 常量。
const (
	TypeHello    = "hello"    // 设备 → hub：连接后注册身份
	TypeWelcome  = "welcome"  // hub → 设备：确认注册，回带分配的 deviceID
	TypePresence = "presence" // hub → 设备：当前在线设备列表（有变化就广播）
	TypeMessage  = "message"  // 设备 ↔ 设备：业务消息，经 hub 转发
	TypePing     = "ping"     // 设备 → hub
	TypePong     = "pong"     // hub → 设备
)

// Envelope 是所有互联消息的统一信封。
type Envelope struct {
	Type     string          `json:"type"`
	From     string          `json:"from,omitempty"`     // 发送方 deviceID（hub 填充，不信任客户端）
	To       string          `json:"to,omitempty"`       // 目标 deviceID；空 = 广播给其它所有设备
	Name     string          `json:"name,omitempty"`     // hello / welcome 携带的设备名
	Platform string          `json:"platform,omitempty"` // hello 携带的平台（macos/android/...）
	Payload  json.RawMessage `json:"payload,omitempty"`  // message 的任意业务数据
	Devices  []DeviceInfo    `json:"devices,omitempty"`  // presence 携带的在线列表
	Ts       int64           `json:"ts,omitempty"`       // 毫秒时间戳（由调用方填充）
}

// DeviceInfo 是对外暴露的设备摘要（presence / REST /v1/devices）。
type DeviceInfo struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Platform string `json:"platform"`
}

// Hub 是万物互联核心，持有所有在线设备并负责路由。
type Hub struct {
	mu      sync.RWMutex
	devices map[string]*Device
}

// NewHub 创建一个空 hub。
func NewHub() *Hub {
	return &Hub{devices: make(map[string]*Device)}
}

// register 把设备加入在线集合，并广播新的在线列表。
func (h *Hub) register(d *Device) {
	h.mu.Lock()
	h.devices[d.id] = d
	h.mu.Unlock()
	h.broadcastPresence()
}

// unregister 把设备移出在线集合（幂等），并广播新的在线列表。
func (h *Hub) unregister(d *Device) {
	h.mu.Lock()
	if cur, ok := h.devices[d.id]; ok && cur == d {
		delete(h.devices, d.id)
	}
	h.mu.Unlock()
	h.broadcastPresence()
}

// List 返回当前在线设备摘要（供 REST /v1/devices 使用）。
func (h *Hub) List() []DeviceInfo {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]DeviceInfo, 0, len(h.devices))
	for _, d := range h.devices {
		out = append(out, DeviceInfo{ID: d.id, Name: d.name, Platform: d.platform})
	}
	return out
}

// Count 返回在线设备数。
func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.devices)
}

// route 处理一条来自 from 设备的消息：定向转发或广播。
// From 由 hub 强制填成发送方 id，客户端无法伪造来源。
func (h *Hub) route(from *Device, env Envelope) {
	env.From = from.id
	if env.To != "" {
		h.mu.RLock()
		target, ok := h.devices[env.To]
		h.mu.RUnlock()
		if ok {
			target.enqueue(env)
		}
		return
	}
	// 广播：发给除自己以外的所有设备
	h.mu.RLock()
	targets := make([]*Device, 0, len(h.devices))
	for _, d := range h.devices {
		if d.id != from.id {
			targets = append(targets, d)
		}
	}
	h.mu.RUnlock()
	for _, d := range targets {
		d.enqueue(env)
	}
}

// broadcastPresence 把最新在线列表推给每台设备。
func (h *Hub) broadcastPresence() {
	list := h.List()
	env := Envelope{Type: TypePresence, Devices: list}
	h.mu.RLock()
	targets := make([]*Device, 0, len(h.devices))
	for _, d := range h.devices {
		targets = append(targets, d)
	}
	h.mu.RUnlock()
	for _, d := range targets {
		d.enqueue(env)
	}
}
