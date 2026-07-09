package interconnect

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// upgrader 把 HTTP 连接升级为 WebSocket。允许跨源，鉴权由上层（网关/反代）负责。
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// HandleConnect 处理 GET /v1/connect：升级为 WebSocket，完成 hello 握手后启动读写 pump。
//
// 握手：客户端连上后必须先发一条 {"type":"hello","name":...,"platform":...}。
// 客户端可在 payload 之外通过 query ?id= 复用固定 deviceID（便于断线重连保持身份）；
// 不传则由服务端分配一个随机 UUID。hub 回发 {"type":"welcome","from":<id>}。
func (h *Hub) HandleConnect(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade 已写过响应
	}

	// 读取首帧 hello（带超时，避免连上不注册占资源）。
	conn.SetReadDeadline(time.Now().Add(pongWait))
	var hello Envelope
	if err := conn.ReadJSON(&hello); err != nil || hello.Type != TypeHello {
		conn.WriteJSON(Envelope{Type: TypeMessage, Payload: json.RawMessage(`{"error":"expected hello"}`)})
		conn.Close()
		return
	}

	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		id = uuid.NewString()
	}
	name := strings.TrimSpace(hello.Name)
	if name == "" {
		name = "device-" + id[:8]
	}

	d := &Device{
		id:       id,
		name:     name,
		platform: strings.TrimSpace(hello.Platform),
		conn:     conn,
		hub:      h,
		send:     make(chan Envelope, sendQueue),
		done:     make(chan struct{}),
	}

	// 若同 id 已有旧会话（重连），踢掉旧的。
	h.mu.Lock()
	if old, ok := h.devices[id]; ok {
		h.mu.Unlock()
		old.close()
	} else {
		h.mu.Unlock()
	}

	go d.writePump()
	d.enqueue(Envelope{Type: TypeWelcome, From: id, Name: name})
	h.register(d) // 广播 presence
	log.Printf("[interconnect] 设备上线 id=%s name=%s platform=%s (在线 %d)", id, name, d.platform, h.Count())

	d.readPump() // 阻塞直到断开
	log.Printf("[interconnect] 设备下线 id=%s name=%s (在线 %d)", id, name, h.Count())
}

// HandleDevices 处理 GET /v1/devices：返回当前在线设备列表（JSON）。
func (h *Hub) HandleDevices(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"count":   h.Count(),
		"devices": h.List(),
	})
}
