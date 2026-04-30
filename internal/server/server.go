package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/tietiezhi-1216/tietiezhi/internal/config"
)

// Server HTTP 服务器
type Server struct {
	cfg *config.Config
	mux *http.ServeMux
	srv *http.Server
}

// New 创建服务器实例
func New(cfg *config.Config) *Server {
	s := &Server{
		cfg: cfg,
		mux: http.NewServeMux(),
	}
	s.registerRoutes()
	return s
}

// registerRoutes 注册路由
func (s *Server) registerRoutes() {
	s.mux.HandleFunc("/health", s.handleHealth)
	// OpenAI 兼容接口（Phase 1 实现）
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
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// handleChatCompletions OpenAI 兼容聊天接口
func (s *Server) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	// TODO: Phase 1 实现
	http.Error(w, "not implemented", http.StatusNotImplemented)
}
