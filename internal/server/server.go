package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"tietiezhi/internal/agent"
	"tietiezhi/internal/config"
	"tietiezhi/internal/llm"
)

// Server HTTP 服务器
type Server struct {
	cfg    *config.Config
	agent  *agent.BaseAgent
	mux    *http.ServeMux
	srv    *http.Server
}

// New 创建服务器实例
func New(cfg *config.Config, ag *agent.BaseAgent) *Server {
	s := &Server{
		cfg:   cfg,
		agent: ag,
		mux:   http.NewServeMux(),
	}
	s.registerRoutes()
	return s
}

// registerRoutes 注册路由
func (s *Server) registerRoutes() {
	s.mux.HandleFunc("/health", s.handleHealth)
	s.mux.HandleFunc("/v1/chat/completions", s.handleChatCompletions)
}

// Start 启动服务器
func (s *Server) Start(ctx context.Context) error {
	addr := fmt.Sprintf("%s:%d", s.cfg.Server.Host, s.cfg.Server.Port)
	s.srv = &http.Server{
		Addr:    addr,
		Handler: s.mux,
	}
	go func() {
		if err := s.srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP 服务器异常退出: %v", err)
		}
	}()
	return nil
}

// Stop 停止服务器
func (s *Server) Stop(ctx context.Context) error {
	if s.srv != nil {
		return s.srv.Shutdown(ctx)
	}
	return nil
}

// handleHealth 健康检查
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status": "ok",
		"model":  s.cfg.LLM.Model,
	})
}

// chatRequest OpenAI 兼容请求格式
type chatRequest struct {
	Model    string           `json:"model"`
	Messages []llm.ChatMessage `json:"messages"`
	Stream   bool             `json:"stream"`
}

// handleChatCompletions OpenAI 兼容聊天接口
func (s *Server) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
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
		s.handleStreamChat(w, r, input)
		return
	}

	s.handleSyncChat(w, r, input)
}

// handleSyncChat 同步聊天响应
func (s *Server) handleSyncChat(w http.ResponseWriter, r *http.Request, input *agent.Message) {
	reply, err := s.agent.Run(r.Context(), "api", false, "", input)
	if err != nil {
		log.Printf("Agent 处理失败: %v", err)
		http.Error(w, "agent error", http.StatusInternalServerError)
		return
	}

	resp := llm.ChatResponse{
		ID:    "tietiezhi-chat",
		Model: s.cfg.LLM.Model,
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
func (s *Server) handleStreamChat(w http.ResponseWriter, r *http.Request, input *agent.Message) {
	ch, err := s.agent.RunStream(r.Context(), "api", false, input)
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
				"model":   s.cfg.LLM.Model,
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

