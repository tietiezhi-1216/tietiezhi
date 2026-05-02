package http

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"tietiezhi/internal/agent"
	"tietiezhi/internal/channel"
	"tietiezhi/internal/config"
	"tietiezhi/internal/llm"
	"tietiezhi/internal/session"
)

// HTTPChannel HTTP API 渠道
// 增强版：除了 chat/completions，还支持会话管理端点
type HTTPChannel struct {
	cfg         *config.Config
	agent       *agent.BaseAgent
	sessionMgr  *session.SessionManager
	server      *http.Server
	mux         *http.ServeMux
}

// New 创建 HTTP API 渠道
func New(cfg *config.Config, ag *agent.BaseAgent, sessionMgr *session.SessionManager) *HTTPChannel {
	h := &HTTPChannel{
		cfg:        cfg,
		agent:      ag,
		sessionMgr: sessionMgr,
		mux:        http.NewServeMux(),
	}
	h.registerRoutes()
	return h
}

// ID 返回渠道标识
func (h *HTTPChannel) ID() string {
	return "http"
}

// Start 启动 HTTP 服务器
func (h *HTTPChannel) Start(ctx context.Context) error {
	addr := fmt.Sprintf("%s:%d", h.cfg.Server.Host, h.cfg.Server.Port)
	h.server = &http.Server{
		Addr:    addr,
		Handler: h.mux,
	}

	go func() {
		if err := h.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP API 服务器异常退出: %v", err)
		}
	}()

	log.Printf("HTTP API 渠道已启动: %s", addr)
	return nil
}

// Stop 停止 HTTP 服务器
func (h *HTTPChannel) Stop(ctx context.Context) error {
	if h.server != nil {
		return h.server.Shutdown(ctx)
	}
	return nil
}

// Send 发送消息（HTTP 渠道不需要此功能）
func (h *HTTPChannel) Send(ctx context.Context, channelID string, msg *channel.Message) error {
	return fmt.Errorf("HTTP 渠道不支持 Send 方法")
}

// registerRoutes 注册路由
func (h *HTTPChannel) registerRoutes() {
	h.mux.HandleFunc("/health", h.handleHealth)
	h.mux.HandleFunc("/v1/health", h.handleV1Health)
	h.mux.HandleFunc("/v1/stats", h.handleStats)
	h.mux.HandleFunc("/v1/chat/completions", h.handleChatCompletions)
	h.mux.HandleFunc("/v1/sessions", h.handleSessions)
	h.mux.HandleFunc("/v1/sessions/", h.handleSessionByID)
}

// ==================== 路由处理函数 ====================

// handleHealth 健康检查（根路径）
func (h *HTTPChannel) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status": "ok",
		"model":  h.cfg.LLM.Model,
	})
}

// handleV1Health V1 版本健康检查
func (h *HTTPChannel) handleV1Health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "ok",
		"model":  h.cfg.LLM.Model,
		"version": "1.0",
	})
}

// handleStats Token 统计
func (h *HTTPChannel) handleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// 获取会话统计
	sessionCount := 0
	if h.sessionMgr != nil {
		sessionCount = h.sessionMgr.Count()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"active_sessions": sessionCount,
		"model":           h.cfg.LLM.Model,
		"timestamp":       time.Now().Unix(),
	})
}

// handleSessions 会话管理（列表和创建）
func (h *HTTPChannel) handleSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.handleListSessions(w, r)
	case http.MethodPost:
		h.handleCreateSession(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleSessionByID 单个会话操作
func (h *HTTPChannel) handleSessionByID(w http.ResponseWriter, r *http.Request) {
	// 提取 session ID
	path := strings.TrimPrefix(r.URL.Path, "/v1/sessions/")
	if path == "" {
		http.Error(w, "session id required", http.StatusBadRequest)
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.handleGetSession(w, r, path)
	case http.MethodDelete:
		h.handleDeleteSession(w, r, path)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleListSessions 列出所有会话
func (h *HTTPChannel) handleListSessions(w http.ResponseWriter, r *http.Request) {
	if h.sessionMgr == nil {
		http.Error(w, "session manager not available", http.StatusInternalServerError)
		return
	}

	sessions := h.sessionMgr.ListSessions()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"sessions": sessions,
		"total":     len(sessions),
	})
}

// handleCreateSession 创建新会话
func (h *HTTPChannel) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID      string `json:"id,omitempty"`
		Channel string `json:"channel,omitempty"`
		UserID  string `json:"user_id,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// 如果没有请求体，使用默认值
		req = struct {
			ID      string `json:"id,omitempty"`
			Channel string `json:"channel,omitempty"`
			UserID  string `json:"user_id,omitempty"`
		}{
			Channel: "http",
		}
	}

	// 生成会话 ID
	sessionID := req.ID
	if sessionID == "" {
		sessionID = fmt.Sprintf("http:%d", time.Now().UnixNano())
	}

	// 构建 session key
	chatType := "p2p"
	sessionKey := sessionID
	if req.UserID != "" {
		sessionKey = fmt.Sprintf("http:%s:%s", chatType, req.UserID)
	}

	// 确保会话存在
	if h.sessionMgr != nil {
		h.sessionMgr.GetOrCreate(sessionKey)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"id":         sessionID,
		"session_key": sessionKey,
		"chat_type":  chatType,
		"created_at": time.Now().Unix(),
	})
}

// handleGetSession 获取会话信息
func (h *HTTPChannel) handleGetSession(w http.ResponseWriter, r *http.Request, sessionID string) {
	if h.sessionMgr == nil {
		http.Error(w, "session manager not available", http.StatusInternalServerError)
		return
	}

	session := h.sessionMgr.GetSession(sessionID)
	if session == nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"key":      session.Key,
		"messages": len(session.GetHistory()),
	})
}

// handleDeleteSession 清空会话
func (h *HTTPChannel) handleDeleteSession(w http.ResponseWriter, r *http.Request, sessionID string) {
	if h.sessionMgr == nil {
		http.Error(w, "session manager not available", http.StatusInternalServerError)
		return
	}

	h.sessionMgr.Clear(sessionID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "会话已清空",
	})
}

// ==================== Chat Completions ====================

// chatRequest OpenAI 兼容请求格式
type chatRequest struct {
	Model    string           `json:"model"`
	Messages []llm.ChatMessage `json:"messages"`
	Stream   bool             `json:"stream"`
}

// handleChatCompletions OpenAI 兼容聊天接口
func (h *HTTPChannel) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// 从请求中提取 session 信息
	sessionKey := "http:api"
	// 尝试从 messages 中提取 session 信息
	if len(req.Messages) > 0 {
		// 使用第一条消息的一些标识
		sessionKey = fmt.Sprintf("http:%s", time.Now().Format("20060102150405"))
	}

	// 取最后一条用户消息
	var userMsg string
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role == "user" {
			userMsg = req.Messages[i].Content
			break
		}
	}
	if userMsg == "" {
		http.Error(w, "no user message", http.StatusBadRequest)
		return
	}

	input := &agent.Message{Role: "user", Content: userMsg}

	if req.Stream {
		h.handleStreamChat(w, r, sessionKey, input)
		return
	}

	h.handleSyncChat(w, r, sessionKey, input)
}

// handleSyncChat 同步聊天响应
func (h *HTTPChannel) handleSyncChat(w http.ResponseWriter, r *http.Request, sessionKey string, input *agent.Message) {
	reply, err := h.agent.Run(r.Context(), sessionKey, false, "", input)
	if err != nil {
		log.Printf("Agent 处理失败: %v", err)
		http.Error(w, "agent error", http.StatusInternalServerError)
		return
	}

	resp := llm.ChatResponse{
		ID:    "tietiezhi-chat",
		Model: h.cfg.LLM.Model,
		Choices: []llm.Choice{
			{
				Index:        0,
				Message:      llm.ChatMessage{Role: "assistant", Content: reply.Content},
				FinishReason: "stop",
			},
		},
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// handleStreamChat 流式聊天响应
func (h *HTTPChannel) handleStreamChat(w http.ResponseWriter, r *http.Request, sessionKey string, input *agent.Message) {
	ch, err := h.agent.RunStream(r.Context(), sessionKey, false, input)
	if err != nil {
		log.Printf("Agent 流式处理失败: %v", err)
		http.Error(w, "agent stream error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	for chunk := range ch {
		for _, choice := range chunk.Choices {
			// 解析 delta
			delta := llm.StreamDelta{}
			if err := json.Unmarshal(choice.Delta, &delta); err != nil {
				continue
			}

			if delta.Content == "" && delta.Role == "" {
				continue
			}

			data, _ := json.Marshal(map[string]any{
				"id":      chunk.ID,
				"object":  "chat.completion.chunk",
				"model":   h.cfg.LLM.Model,
				"choices": []map[string]any{
					{
						"index": choice.Index,
						"delta": map[string]string{
							"content": delta.Content,
						},
						"finish_reason": nil,
					},
				},
			})

			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}

	// 发送结束标记
	fmt.Fprintf(w, "data: [DONE]\n\n")
	flusher.Flush()
}

// ==================== 扩展 SessionManager ====================

// ListSessions 列出所有会话（添加到 session 包）
func (sm *session.SessionManager) ListSessions() []map[string]interface{} {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	sessions := make([]map[string]interface{}, 0, len(sm.sessions))
	for key, s := range sm.sessions {
		s.mu.RLock()
		sessions = append(sessions, map[string]interface{}{
			"key":      key,
			"messages": len(s.History),
		})
		s.mu.RUnlock()
	}
	return sessions
}

// GetSession 获取指定会话
func (sm *session.SessionManager) GetSession(key string) *session.Session {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.sessions[key]
}

// Clear 清空指定会话
func (sm *session.SessionManager) Clear(key string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if s, ok := sm.sessions[key]; ok {
		s.Clear()
	}
}

// Count 获取会话数量
func (sm *session.SessionManager) Count() int {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return len(sm.sessions)
}
