package v1

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

var ErrUnauthorized = errors.New("unauthorized")

// Principal 是鉴权层交给协议层的身份，不包含原始凭据。
type Principal struct {
	Auth    AuthInfo
	Account *Account
}

// Authenticator 同时接受登录 Access Token 和用户 API Key。
// 具体令牌格式、哈希和账号存储由中转站鉴权实现负责。
type Authenticator interface {
	Authenticate(ctx context.Context, bearer string, hintedMode AuthMode) (Principal, error)
}

type CatalogProvider interface {
	Models(ctx context.Context, principal Principal) (ModelList, error)
}

type Handler struct {
	Discovery     Discovery
	Endpoints     Endpoints
	Authenticator Authenticator
	Catalog       CatalogProvider
}

func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/.well-known/tietiezhi-gateway", h.handleDiscovery)
	mux.HandleFunc("/.well-known/oauth-authorization-server", h.handleOAuthMetadata)
	mux.HandleFunc("/v1/bootstrap", h.handleBootstrap)
	mux.HandleFunc("/v1/models", h.handleModels)
}

func (h *Handler) handleOAuthMetadata(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET", "")
		return
	}
	if err := h.Discovery.Validate(); err != nil {
		writeError(w, http.StatusInternalServerError, "gateway_misconfigured", err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, h.Discovery.OAuthMetadata())
}

func (h *Handler) handleDiscovery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET", "")
		return
	}
	if err := h.Discovery.Validate(); err != nil {
		writeError(w, http.StatusInternalServerError, "gateway_misconfigured", err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, h.Discovery)
}

func (h *Handler) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET", "")
		return
	}
	principal, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	models, err := h.Catalog.Models(r.Context(), principal)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "catalog_unavailable", "模型目录暂时不可用", "")
		return
	}
	bootstrap := NewBootstrap(principal.Auth, principal.Account, h.Endpoints, models)
	if err := bootstrap.Validate(); err != nil {
		writeError(w, http.StatusInternalServerError, "gateway_misconfigured", err.Error(), "")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, bootstrap)
}

func (h *Handler) handleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET", "")
		return
	}
	principal, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	models, err := h.Catalog.Models(r.Context(), principal)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "catalog_unavailable", "模型目录暂时不可用", "")
		return
	}
	if err := models.Validate(); err != nil {
		writeError(w, http.StatusInternalServerError, "gateway_misconfigured", err.Error(), "")
		return
	}
	etag := strconv.Quote(models.Revision)
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, max-age=60")
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, http.StatusOK, models)
}

func (h *Handler) authenticate(w http.ResponseWriter, r *http.Request) (Principal, bool) {
	if h.Authenticator == nil || h.Catalog == nil {
		writeError(w, http.StatusServiceUnavailable, "gateway_unavailable", "网关尚未配置", "")
		return Principal{}, false
	}
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(header) < 8 || !strings.EqualFold(header[:7], "Bearer ") {
		w.Header().Set("WWW-Authenticate", `Bearer realm="tietiezhi-gateway"`)
		writeError(w, http.StatusUnauthorized, "unauthorized", "缺少 Bearer 凭据", "")
		return Principal{}, false
	}
	mode := AuthMode(strings.TrimSpace(r.Header.Get("X-Tietiezhi-Auth-Mode")))
	if mode != "" && mode != AuthModeLogin && mode != AuthModeAPIKey {
		writeError(w, http.StatusBadRequest, "invalid_auth_mode", "鉴权模式必须为 login 或 api_key", "")
		return Principal{}, false
	}
	principal, err := h.Authenticator.Authenticate(r.Context(), strings.TrimSpace(header[7:]), mode)
	if err != nil {
		w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
		writeError(w, http.StatusUnauthorized, "unauthorized", "凭据无效或已过期", "")
		return Principal{}, false
	}
	if mode != "" && principal.Auth.Mode != mode {
		writeError(w, http.StatusUnauthorized, "auth_mode_mismatch", "凭据类型与鉴权模式不匹配", "")
		return Principal{}, false
	}
	return principal, true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message, requestID string) {
	writeJSON(w, status, APIErrorBody{Error: APIError{
		Code: code, Message: message, RequestID: requestID,
	}})
}
