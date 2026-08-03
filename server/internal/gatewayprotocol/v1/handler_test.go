package v1

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type testAuthenticator struct{}

func (testAuthenticator) Authenticate(_ context.Context, bearer string, _ AuthMode) (Principal, error) {
	switch bearer {
	case "login-token":
		return Principal{
			Auth:    AuthInfo{Mode: AuthModeLogin, Subject: "user-1", Scopes: []string{"models:read"}},
			Account: &Account{ID: "user-1", Email: "user@example.com"},
		}, nil
	case "tz-key":
		return Principal{Auth: AuthInfo{Mode: AuthModeAPIKey, Subject: "key-1", Scopes: []string{"models:read"}}}, nil
	default:
		return Principal{}, ErrUnauthorized
	}
}

type testCatalog struct{}

func (testCatalog) Models(_ context.Context, _ Principal) (ModelList, error) {
	contextWindow := 128_000
	maxOutputTokens := 16_384
	return NewModelList("catalog-1", []Model{{
		ID:          "tietiezhi/default",
		Object:      "model",
		DisplayName: "Tietiezhi Default",
		OwnedBy:     "tietiezhi",
		Status:      "available",
		Capabilities: ModelCapabilities{
			InputModalities:  []string{"text"},
			OutputModalities: []string{"text"},
			Streaming:        true,
			ToolCalling:      true,
		},
		Limits:              ModelLimits{ContextWindow: &contextWindow, MaxOutputTokens: &maxOutputTokens},
		SupportedParameters: []string{"tools"},
	}}), nil
}

func newTestHandler(t *testing.T) http.Handler {
	t.Helper()
	discovery := Discovery{
		SchemaVersion:                 SchemaVersion,
		Issuer:                        "https://gateway.example.com",
		APIBase:                       "https://gateway.example.com/v1",
		AuthorizationEndpoint:         "https://gateway.example.com/oauth/authorize",
		TokenEndpoint:                 "https://gateway.example.com/oauth/token",
		RevocationEndpoint:            "https://gateway.example.com/oauth/revoke",
		BootstrapEndpoint:             "https://gateway.example.com/v1/bootstrap",
		ModelsEndpoint:                "https://gateway.example.com/v1/models",
		AuthenticationMethods:         []string{"oauth_pkce", "api_key"},
		GrantTypesSupported:           []string{"authorization_code", "refresh_token"},
		CodeChallengeMethodsSupported: []string{"S256"},
		NativeClients: []NativeClient{{
			ClientID: "tietiezhi-desktop", RedirectURIs: []string{"http://127.0.0.1/callback"},
		}},
	}
	handler := &Handler{
		Discovery:     discovery,
		Endpoints:     Endpoints{Models: discovery.ModelsEndpoint, Responses: discovery.APIBase + "/responses"},
		Authenticator: testAuthenticator{},
		Catalog:       testCatalog{},
	}
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)
	return mux
}

func TestDiscoveryAndOAuthMetadata(t *testing.T) {
	handler := newTestHandler(t)

	for _, path := range []string{"/.well-known/tietiezhi-gateway", "/.well-known/oauth-authorization-server"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s 返回状态码 %d", path, response.Code)
		}
	}
}

func TestBootstrapSupportsLoginAndAPIKey(t *testing.T) {
	handler := newTestHandler(t)
	tests := []struct {
		name   string
		mode   AuthMode
		secret string
	}{
		{name: "登录", mode: AuthModeLogin, secret: "login-token"},
		{name: "API Key", mode: AuthModeAPIKey, secret: "tz-key"},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/v1/bootstrap", nil)
			request.Header.Set("Authorization", "Bearer "+testCase.secret)
			request.Header.Set("X-Tietiezhi-Auth-Mode", string(testCase.mode))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("返回状态码 %d: %s", response.Code, response.Body.String())
			}
			var bootstrap Bootstrap
			if err := json.Unmarshal(response.Body.Bytes(), &bootstrap); err != nil {
				t.Fatal(err)
			}
			if bootstrap.Auth.Mode != testCase.mode || bootstrap.Models.Data[0].ID != "tietiezhi/default" {
				t.Fatalf("Bootstrap 内容不符合预期: %+v", bootstrap)
			}
		})
	}
}

func TestModelsReturnsETagAndUnifiedError(t *testing.T) {
	handler := newTestHandler(t)

	request := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	request.Header.Set("Authorization", "Bearer tz-key")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("ETag") != `"catalog-1"` {
		t.Fatalf("模型目录响应异常: status=%d etag=%q", response.Code, response.Header().Get("ETag"))
	}
	request = httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	request.Header.Set("Authorization", "Bearer tz-key")
	request.Header.Set("If-None-Match", `"catalog-1"`)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotModified {
		t.Fatalf("相同目录版本应返回 304，实际为 %d", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("缺少凭据应返回 401，实际为 %d", response.Code)
	}
	var body APIErrorBody
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "unauthorized" {
		t.Fatalf("错误码不符合预期: %s", body.Error.Code)
	}
}
