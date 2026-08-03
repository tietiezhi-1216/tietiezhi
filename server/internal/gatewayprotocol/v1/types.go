// Package v1 定义 Tietiezhi Gateway 第一版公开协议。
package v1

import (
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"time"
)

const SchemaVersion = "tietiezhi.gateway.v1"

type AuthMode string

const (
	AuthModeLogin  AuthMode = "login"
	AuthModeAPIKey AuthMode = "api_key"
)

type NativeClient struct {
	ClientID     string   `json:"client_id"`
	RedirectURIs []string `json:"redirect_uris"`
}

// Discovery 是无需鉴权的网关能力发现文档。
type Discovery struct {
	SchemaVersion                 string         `json:"schema_version"`
	Issuer                        string         `json:"issuer"`
	APIBase                       string         `json:"api_base"`
	AuthorizationEndpoint         string         `json:"authorization_endpoint"`
	TokenEndpoint                 string         `json:"token_endpoint"`
	RevocationEndpoint            string         `json:"revocation_endpoint"`
	BootstrapEndpoint             string         `json:"bootstrap_endpoint"`
	ModelsEndpoint                string         `json:"models_endpoint"`
	AuthenticationMethods         []string       `json:"authentication_methods"`
	GrantTypesSupported           []string       `json:"grant_types_supported"`
	CodeChallengeMethodsSupported []string       `json:"code_challenge_methods_supported"`
	NativeClients                 []NativeClient `json:"native_clients"`
}

// OAuthMetadata 对应 RFC 8414，便于通用 OAuth 客户端发现登录端点。
type OAuthMetadata struct {
	Issuer                        string   `json:"issuer"`
	AuthorizationEndpoint         string   `json:"authorization_endpoint"`
	TokenEndpoint                 string   `json:"token_endpoint"`
	RevocationEndpoint            string   `json:"revocation_endpoint"`
	GrantTypesSupported           []string `json:"grant_types_supported"`
	CodeChallengeMethodsSupported []string `json:"code_challenge_methods_supported"`
}

type ModelCapabilities struct {
	InputModalities  []string `json:"input_modalities"`
	OutputModalities []string `json:"output_modalities"`
	Streaming        bool     `json:"streaming"`
	ToolCalling      bool     `json:"tool_calling"`
	StructuredOutput bool     `json:"structured_output"`
	Reasoning        bool     `json:"reasoning"`
}

type ModelLimits struct {
	ContextWindow   *int `json:"context_window"`
	MaxOutputTokens *int `json:"max_output_tokens"`
}

type ModelReasoning struct {
	Efforts       []string `json:"efforts"`
	DefaultEffort string   `json:"default_effort,omitempty"`
}

type ModelDeprecation struct {
	At               string `json:"at"`
	ReplacementModel string `json:"replacement_model,omitempty"`
}

// Model 是桌面端可依赖的稳定模型能力描述，不暴露上游厂商协议。
type Model struct {
	ID                  string            `json:"id"`
	Object              string            `json:"object"`
	DisplayName         string            `json:"display_name"`
	Description         string            `json:"description,omitempty"`
	OwnedBy             string            `json:"owned_by"`
	Created             int64             `json:"created"`
	Status              string            `json:"status"`
	Capabilities        ModelCapabilities `json:"capabilities"`
	Limits              ModelLimits       `json:"limits"`
	SupportedParameters []string          `json:"supported_parameters"`
	Reasoning           *ModelReasoning   `json:"reasoning,omitempty"`
	Deprecation         *ModelDeprecation `json:"deprecation,omitempty"`
}

type ModelList struct {
	SchemaVersion string  `json:"schema_version"`
	Object        string  `json:"object"`
	Revision      string  `json:"revision"`
	Data          []Model `json:"data"`
}

type AuthInfo struct {
	Mode      AuthMode `json:"mode"`
	Subject   string   `json:"subject"`
	Scopes    []string `json:"scopes"`
	ExpiresAt string   `json:"expires_at,omitempty"`
}

type Account struct {
	ID          string `json:"id"`
	Email       string `json:"email,omitempty"`
	DisplayName string `json:"display_name,omitempty"`
	AvatarURL   string `json:"avatar_url,omitempty"`
}

type Endpoints struct {
	Models    string `json:"models"`
	Responses string `json:"responses"`
}

// Bootstrap 是登录或 API Key 鉴权后返回的统一 JSON 文档。
type Bootstrap struct {
	SchemaVersion string    `json:"schema_version"`
	Object        string    `json:"object"`
	IssuedAt      string    `json:"issued_at"`
	Auth          AuthInfo  `json:"auth"`
	Account       *Account  `json:"account,omitempty"`
	Endpoints     Endpoints `json:"endpoints"`
	Models        ModelList `json:"models"`
}

type APIErrorBody struct {
	Error APIError `json:"error"`
}

type APIError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id,omitempty"`
}

func NewModelList(revision string, models []Model) ModelList {
	return ModelList{SchemaVersion: SchemaVersion, Object: "list", Revision: revision, Data: models}
}

func NewBootstrap(auth AuthInfo, account *Account, endpoints Endpoints, models ModelList) Bootstrap {
	return Bootstrap{
		SchemaVersion: SchemaVersion,
		Object:        "gateway.bootstrap",
		IssuedAt:      time.Now().UTC().Format(time.RFC3339),
		Auth:          auth,
		Account:       account,
		Endpoints:     endpoints,
		Models:        models,
	}
}

func (d Discovery) OAuthMetadata() OAuthMetadata {
	return OAuthMetadata{
		Issuer:                        d.Issuer,
		AuthorizationEndpoint:         d.AuthorizationEndpoint,
		TokenEndpoint:                 d.TokenEndpoint,
		RevocationEndpoint:            d.RevocationEndpoint,
		GrantTypesSupported:           d.GrantTypesSupported,
		CodeChallengeMethodsSupported: d.CodeChallengeMethodsSupported,
	}
}

func (d Discovery) Validate() error {
	if d.SchemaVersion != SchemaVersion {
		return fmt.Errorf("不支持的 schema_version: %s", d.SchemaVersion)
	}
	issuer, err := url.Parse(d.Issuer)
	if err != nil || issuer.Scheme != "https" || issuer.Host == "" {
		return errors.New("issuer 必须是有效 HTTPS 地址")
	}
	for name, raw := range map[string]string{
		"api_base":               d.APIBase,
		"authorization_endpoint": d.AuthorizationEndpoint,
		"token_endpoint":         d.TokenEndpoint,
		"revocation_endpoint":    d.RevocationEndpoint,
		"bootstrap_endpoint":     d.BootstrapEndpoint,
		"models_endpoint":        d.ModelsEndpoint,
	} {
		endpoint, parseErr := url.Parse(raw)
		if parseErr != nil || endpoint.Scheme != issuer.Scheme || endpoint.Host != issuer.Host {
			return fmt.Errorf("%s 必须与 issuer 同源", name)
		}
	}
	if !slices.Contains(d.AuthenticationMethods, "oauth_pkce") ||
		!slices.Contains(d.AuthenticationMethods, "api_key") {
		return errors.New("authentication_methods 必须包含 oauth_pkce 和 api_key")
	}
	if !slices.Contains(d.CodeChallengeMethodsSupported, "S256") {
		return errors.New("网关必须支持 PKCE S256")
	}
	return nil
}

func (m Model) Validate() error {
	if strings.TrimSpace(m.ID) == "" || strings.TrimSpace(m.DisplayName) == "" {
		return errors.New("模型 id 和 display_name 不能为空")
	}
	if m.Object != "model" {
		return errors.New("模型 object 必须为 model")
	}
	if m.Status != "available" && m.Status != "deprecated" && m.Status != "disabled" {
		return fmt.Errorf("模型 %s 的 status 无效", m.ID)
	}
	if len(m.Capabilities.InputModalities) == 0 || len(m.Capabilities.OutputModalities) == 0 {
		return fmt.Errorf("模型 %s 必须声明输入和输出模态", m.ID)
	}
	return nil
}

func (l ModelList) Validate() error {
	if l.SchemaVersion != SchemaVersion || l.Object != "list" || strings.TrimSpace(l.Revision) == "" {
		return errors.New("模型列表头部无效")
	}
	seen := make(map[string]struct{}, len(l.Data))
	for _, model := range l.Data {
		if err := model.Validate(); err != nil {
			return err
		}
		if _, exists := seen[model.ID]; exists {
			return fmt.Errorf("模型 id 重复: %s", model.ID)
		}
		seen[model.ID] = struct{}{}
	}
	return nil
}

func (b Bootstrap) Validate() error {
	if b.SchemaVersion != SchemaVersion || b.Object != "gateway.bootstrap" {
		return errors.New("Bootstrap 头部无效")
	}
	if b.Auth.Mode != AuthModeLogin && b.Auth.Mode != AuthModeAPIKey {
		return errors.New("Bootstrap auth.mode 无效")
	}
	if strings.TrimSpace(b.Auth.Subject) == "" {
		return errors.New("Bootstrap auth.subject 不能为空")
	}
	return b.Models.Validate()
}
