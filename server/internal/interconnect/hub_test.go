package interconnect

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// testServer 起一个带 hub 路由的 httptest 服务，返回 ws:// 基址与清理函数。
func testServer(t *testing.T) (*Hub, string, func()) {
	t.Helper()
	hub := NewHub()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/connect", hub.HandleConnect)
	mux.HandleFunc("/v1/devices", hub.HandleDevices)
	srv := httptest.NewServer(mux)
	wsBase := "ws" + strings.TrimPrefix(srv.URL, "http")
	return hub, wsBase, srv.Close
}

// dialDevice 连上 hub 并发送 hello，返回连接。
func dialDevice(t *testing.T, wsBase, id, name, platform string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(wsBase+"/v1/connect?id="+id, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", id, err)
	}
	if err := conn.WriteJSON(Envelope{Type: TypeHello, Name: name, Platform: platform}); err != nil {
		t.Fatalf("hello %s: %v", id, err)
	}
	return conn
}

// readUntil 一直读，直到拿到指定 type 的信封或超时。
func readUntil(t *testing.T, conn *websocket.Conn, typ string) Envelope {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		var env Envelope
		if err := conn.ReadJSON(&env); err != nil {
			t.Fatalf("等待 type=%s 超时/出错: %v", typ, err)
		}
		if env.Type == typ {
			return env
		}
	}
}

func TestWelcomeAndPresence(t *testing.T) {
	_, wsBase, closeFn := testServer(t)
	defer closeFn()

	a := dialDevice(t, wsBase, "A", "设备A", "macos")
	defer a.Close()

	welcome := readUntil(t, a, TypeWelcome)
	if welcome.From != "A" {
		t.Fatalf("welcome.From = %q, 期望 A", welcome.From)
	}

	// A 应收到 presence，且包含自己
	p := readUntil(t, a, TypePresence)
	if len(p.Devices) != 1 || p.Devices[0].ID != "A" {
		t.Fatalf("presence = %+v, 期望仅含 A", p.Devices)
	}

	// B 上线后，A 应收到含两台设备的新 presence
	b := dialDevice(t, wsBase, "B", "设备B", "android")
	defer b.Close()
	readUntil(t, b, TypeWelcome)

	p2 := readUntil(t, a, TypePresence)
	if len(p2.Devices) != 2 {
		t.Fatalf("B 上线后 A 的 presence 应有 2 台，实得 %d: %+v", len(p2.Devices), p2.Devices)
	}
}

func TestDirectMessageRelay(t *testing.T) {
	_, wsBase, closeFn := testServer(t)
	defer closeFn()

	a := dialDevice(t, wsBase, "A", "设备A", "macos")
	defer a.Close()
	b := dialDevice(t, wsBase, "B", "设备B", "android")
	defer b.Close()
	readUntil(t, a, TypeWelcome)
	readUntil(t, b, TypeWelcome)

	// A 定向发消息给 B
	payload := json.RawMessage(`{"text":"铁汁你好"}`)
	if err := a.WriteJSON(Envelope{Type: TypeMessage, To: "B", Payload: payload}); err != nil {
		t.Fatal(err)
	}

	got := readUntil(t, b, TypeMessage)
	if got.From != "A" {
		t.Fatalf("消息 From = %q, 期望 A（hub 应强制填发送方）", got.From)
	}
	if string(got.Payload) != string(payload) {
		t.Fatalf("payload = %s, 期望 %s", got.Payload, payload)
	}
}

func TestBroadcastMessage(t *testing.T) {
	_, wsBase, closeFn := testServer(t)
	defer closeFn()

	a := dialDevice(t, wsBase, "A", "A", "macos")
	defer a.Close()
	b := dialDevice(t, wsBase, "B", "B", "android")
	defer b.Close()
	c := dialDevice(t, wsBase, "C", "C", "web")
	defer c.Close()
	for _, conn := range []*websocket.Conn{a, b, c} {
		readUntil(t, conn, TypeWelcome)
	}

	// C 广播（to 空），A 和 B 都应收到，C 自己不应收到回声
	if err := c.WriteJSON(Envelope{Type: TypeMessage, Payload: json.RawMessage(`{"broadcast":true}`)}); err != nil {
		t.Fatal(err)
	}
	ga := readUntil(t, a, TypeMessage)
	gb := readUntil(t, b, TypeMessage)
	if ga.From != "C" || gb.From != "C" {
		t.Fatalf("广播来源应为 C，实得 A:%q B:%q", ga.From, gb.From)
	}
}

// waitCount 轮询等待 hub 在线数达到 want（掉线是异步的，不能读完一条消息就断言）。
func waitCount(t *testing.T, hub *Hub, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if hub.Count() == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("hub.Count() = %d, 期望 %d（超时）", hub.Count(), want)
}

// restDevices 打 GET /v1/devices 返回在线数。
func restDevices(t *testing.T, wsBase string) int {
	t.Helper()
	httpBase := "http" + strings.TrimPrefix(wsBase, "ws")
	resp, err := http.Get(httpBase + "/v1/devices")
	if err != nil {
		t.Fatalf("GET /v1/devices: %v", err)
	}
	defer resp.Body.Close()
	var body struct {
		Count   int          `json:"count"`
		Devices []DeviceInfo `json:"devices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode devices: %v", err)
	}
	return body.Count
}

func TestDevicesRESTAndDisconnect(t *testing.T) {
	hub, wsBase, closeFn := testServer(t)
	defer closeFn()

	a := dialDevice(t, wsBase, "A", "A", "macos")
	b := dialDevice(t, wsBase, "B", "B", "android")
	readUntil(t, a, TypeWelcome)
	readUntil(t, b, TypeWelcome)

	waitCount(t, hub, 2)
	if n := restDevices(t, wsBase); n != 2 {
		t.Fatalf("REST /v1/devices count = %d, 期望 2", n)
	}

	// B 掉线后，hub 与 REST 都应降到 1（掉线异步，轮询等待）
	b.Close()
	waitCount(t, hub, 1)
	if n := restDevices(t, wsBase); n != 1 {
		t.Fatalf("B 掉线后 REST count = %d, 期望 1", n)
	}
	a.Close()
}
