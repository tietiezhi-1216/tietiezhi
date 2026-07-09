package interconnect

import (
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// writeWait 单次写超时。
	writeWait = 10 * time.Second
	// pongWait 读超时：超过这么久没收到 pong/消息就判定掉线。
	pongWait = 60 * time.Second
	// pingPeriod 服务端主动发 WebSocket ping 的周期（须小于 pongWait）。
	pingPeriod = 30 * time.Second
	// sendQueue 每台设备的发送缓冲；满了说明该设备写太慢，直接踢掉。
	sendQueue = 64
)

// Device 代表一条已连接的触手（一台设备的 WebSocket 会话）。
type Device struct {
	id       string
	name     string
	platform string
	conn     *websocket.Conn
	hub      *Hub
	send     chan Envelope
	done     chan struct{}
	once     sync.Once
}

// close 关闭该设备会话（幂等）：关掉底层连接会让读写 pump 都退出。
func (d *Device) close() {
	d.once.Do(func() {
		close(d.done)
		d.conn.Close()
	})
}

// enqueue 把一条消息投递到设备的发送队列；队列满则踢掉该设备（慢消费者）。
func (d *Device) enqueue(env Envelope) {
	select {
	case d.send <- env:
	case <-d.done:
	default:
		d.close()
	}
}

// readPump 读取设备上行消息并交给 hub 路由，直到连接关闭。
func (d *Device) readPump() {
	defer func() {
		d.hub.unregister(d)
		d.close()
	}()

	d.conn.SetReadDeadline(time.Now().Add(pongWait))
	d.conn.SetPongHandler(func(string) error {
		d.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		var env Envelope
		if err := d.conn.ReadJSON(&env); err != nil {
			return
		}
		d.conn.SetReadDeadline(time.Now().Add(pongWait))

		switch env.Type {
		case TypePing:
			d.enqueue(Envelope{Type: TypePong, Ts: env.Ts})
		case TypeMessage:
			d.hub.route(d, env)
		default:
			// hello 已在握手时处理；其余类型忽略。
		}
	}
}

// writePump 把发送队列里的消息写到连接，并周期性发 ping 保活。
func (d *Device) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		d.close()
	}()

	for {
		select {
		case env := <-d.send:
			d.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := d.conn.WriteJSON(env); err != nil {
				return
			}
		case <-ticker.C:
			d.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := d.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-d.done:
			d.conn.SetWriteDeadline(time.Now().Add(writeWait))
			d.conn.WriteMessage(websocket.CloseMessage, []byte{})
			return
		}
	}
}
