package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
	"tietiezhi/internal/hook"
)

const (
	// AppDirName 是 tietiezhi 在用户目录下的统一数据目录。
	AppDirName = ".tietiezhi"
	// ConfigFileName 是默认配置文件名。
	ConfigFileName = "config.yaml"
)

const defaultConfigYAML = `# tietiezhi 配置文件
# 首次启动会自动创建在 ~/.tietiezhi/config.yaml
# 所有运行时文件、记忆、会话、任务和上传内容都会保存在 ~/.tietiezhi/ 下。

server:
  host: "0.0.0.0"
  port: 18178

llm:
  provider: "openai"
  base_url: "https://api.openai.com/v1"
  api_key: "your-api-key"
  model: "gpt-4o"
  cheap_model: ""
  cheap_base_url: ""
  cheap_api_key: ""
  model_capabilities:
    - model: "gpt-4o"
      capabilities: ["vision", "coding"]
    - model: "gpt-4o-mini"
      capabilities: ["vision"]

agent:
  max_tool_calls: 20
  system_prompt: "你是一个有用的AI助手"
  loop_detection: true
  compression:
    enabled: false
    max_chars: 80000
    keep_recent: 10
    summary_prompt: "请总结以下对话的核心内容，保留关键信息、决策和重要细节，用简洁的中文概括："
  loop_detector:
    generic_repeat_threshold: 3
    generic_repeat_similarity: 0.8
    no_progress_threshold: 5
    ping_pong_window: 8
    global_circuit_breaker_limit: 20

channels:
  feishu:
    enabled: false
    app_id: ""
    app_secret: ""
    verification_token: ""
    encrypt_key: ""
    streaming: false
    bot_open_id: ""
  telegram:
    enabled: false
    bot_token: ""
    admin_ids: []

memory:
  type: "markdown"

scheduler:
  enabled: true
  exec_timeout: 300

heartbeat:
  enabled: true
  interval: 30
  chat_id: ""

log:
  level: "info"
  format: "text"

session:
  max_history_turns: 20
  auto_save_seconds: 60

hooks:
  enabled: false
  rules: []

subagent:
  enabled: true
  timeout: 300

tools:
  terminal:
    blocked_cmds: []
  web_search:
    provider: ""
    api_key: ""
    base_url: ""

approval:
  enabled: false
  require_approval: ["agent_spawn", "terminal_exec"]
  auto_approve: []

observability:
  enabled: false
  audit_log:
    enabled: false
  token_track: false

sandbox:
  enabled: false
  image: "alpine:latest"
  network_mode: "none"
  memory_limit: "128m"
  cpu_limit: 0.5
  work_dir: "/workspace"
`

// Config 顶层配置结构
type Config struct {
	ConfigPath    string              `yaml:"-"`
	AppDir        string              `yaml:"-"`
	Server        ServerConfig        `yaml:"server"`
	LLM           LLMConfig           `yaml:"llm"`
	Agent         AgentConfig         `yaml:"agent"`
	Channels      ChannelsConfig      `yaml:"channels"`
	Memory        MemoryConfig        `yaml:"memory"`
	Skills        SkillsConfig        `yaml:"-"`
	Scheduler     SchedulerConfig     `yaml:"scheduler"`
	Heartbeat     HeartbeatConfig     `yaml:"heartbeat"`
	Log           LogConfig           `yaml:"log"`
	Session       SessionConfig       `yaml:"session"`
	SubAgent      SubAgentConfig      `yaml:"subagent"`
	Hooks         HooksConfig         `yaml:"hooks"`
	Tools         ToolsConfig         `yaml:"tools"`
	Approval      ApprovalConfig      `yaml:"approval"`
	Observability ObservabilityConfig `yaml:"observability"`
	Sandbox       SandboxConfig       `yaml:"sandbox"` // 沙箱配置
}

// ServerConfig 服务器配置
type ServerConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
}

// ModelCapability 模型能力映射
type ModelCapability struct {
	Model        string   `yaml:"model"`        // 模型名称
	Capabilities []string `yaml:"capabilities"` // 支持的能力列表，如 vision, audio, coding
}

// LLMConfig 大模型配置
type LLMConfig struct {
	ModelCapabilities []ModelCapability `yaml:"model_capabilities"` // 模型能力映射
	Provider          string            `yaml:"provider"`
	BaseURL           string            `yaml:"base_url"`
	APIKey            string            `yaml:"api_key"`
	Model             string            `yaml:"model"`
	CheapModel        string            `yaml:"cheap_model"`    // 轻量级模型，用于压缩等简单任务
	CheapBaseURL      string            `yaml:"cheap_base_url"` // 轻量级模型的 API 地址
	CheapAPIKey       string            `yaml:"cheap_api_key"`  // 轻量级模型的 API Key
}

// AgentConfig Agent 配置
type AgentConfig struct {
	MaxToolCalls  int                `yaml:"max_tool_calls"`
	SystemPrompt  string             `yaml:"system_prompt"`
	LoopDetection bool               `yaml:"loop_detection"`
	Compression   CompressionConfig  `yaml:"compression"`
	LoopDetector  LoopDetectorConfig `yaml:"loop_detector"`
}

// CompressionConfig 上下文压缩配置
type CompressionConfig struct {
	Enabled       bool   `yaml:"enabled"`        // 是否启用压缩
	MaxChars      int    `yaml:"max_chars"`      // 触发压缩的字符阈值（默认 80000）
	KeepRecent    int    `yaml:"keep_recent"`    // 保留最近 N 条消息（默认 10）
	SummaryPrompt string `yaml:"summary_prompt"` // 总结提示词
}

// LoopDetectorConfig 循环检测器配置
type LoopDetectorConfig struct {
	GenericRepeatThreshold    int     `yaml:"generic_repeat_threshold"`     // 重复调用检测阈值（默认3次）
	GenericRepeatSimilarity   float64 `yaml:"generic_repeat_similarity"`    // 参数相似度阈值（默认0.8）
	NoProgressThreshold       int     `yaml:"no_progress_threshold"`        // 无进展检测阈值（默认5次）
	PingPongWindow            int     `yaml:"ping_pong_window"`             // 来回弹跳检测窗口（默认8）
	GlobalCircuitBreakerLimit int     `yaml:"global_circuit_breaker_limit"` // 全局熔断上限（默认20）
}

// SafeCopy 返回配置的值拷贝，避免指针修改影响原始配置
func (c LoopDetectorConfig) SafeCopy() *LoopDetectorConfig {
	cp := c
	return &cp
}

// ApprovalConfig 审批流配置
type ApprovalConfig struct {
	Enabled         bool     `yaml:"enabled"`          // 是否启用审批
	RequireApproval []string `yaml:"require_approval"` // 需要审批的工具名列表
	AutoApprove     []string `yaml:"auto_approve"`     // 自动放行的工具名列表
}

// ChannelsConfig 渠道配置
type ChannelsConfig struct {
	Feishu   *FeishuConfig   `yaml:"feishu"`
	Telegram *TelegramConfig `yaml:"telegram"`
}

// FeishuConfig 飞书渠道配置
type FeishuConfig struct {
	Enabled           bool   `yaml:"enabled"`
	AppID             string `yaml:"app_id"`
	AppSecret         string `yaml:"app_secret"`
	VerificationToken string `yaml:"verification_token"`
	EncryptKey        string `yaml:"encrypt_key"`
	Streaming         bool   `yaml:"streaming"`
	BotOpenID         string `yaml:"bot_open_id"`
}

// TelegramConfig Telegram 渠道配置
type TelegramConfig struct {
	Enabled  bool    `yaml:"enabled"`
	BotToken string  `yaml:"bot_token"`
	AdminIDs []int64 `yaml:"admin_ids"`
}

// MemoryConfig 记忆配置
type MemoryConfig struct {
	Type string `yaml:"type"`
	Path string `yaml:"-"`
}

// SkillsConfig 技能配置
type SkillsConfig struct {
	Path string `yaml:"-"`
}

// SchedulerConfig 定时任务配置
type SchedulerConfig struct {
	Enabled     bool   `yaml:"enabled"`
	Path        string `yaml:"-"`
	ExecTimeout int    `yaml:"exec_timeout"` // 秒
}

// HeartbeatConfig 心跳配置
type HeartbeatConfig struct {
	Enabled  bool   `yaml:"enabled"`
	Interval int    `yaml:"interval"` // 分钟
	ChatID   string `yaml:"chat_id"`  // 默认投递目标
}

// LogConfig 日志配置
type LogConfig struct {
	Level  string `yaml:"level"`
	Format string `yaml:"format"`
}

// SessionConfig 会话配置
type SessionConfig struct {
	MaxHistoryTurns int    `yaml:"max_history_turns"`
	PersistPath     string `yaml:"-"`
	AutoSaveSeconds int    `yaml:"auto_save_seconds"`
}

// SubAgentConfig 子代理配置
type SubAgentConfig struct {
	Enabled bool   `yaml:"enabled"`
	Path    string `yaml:"-"`       // 存储路径，固定在 ~/.tietiezhi/subagents
	Timeout int    `yaml:"timeout"` // 默认超时，默认 300
}

// HooksConfig Hook 配置
type HooksConfig struct {
	Enabled bool            `yaml:"enabled"`
	Rules   []hook.HookRule `yaml:"rules"`
}

// ToolsConfig 内置工具配置
type ToolsConfig struct {
	Terminal    TerminalConfig  `yaml:"terminal"`
	FileIO      FileIOConfig    `yaml:"-"`
	WebSearch   WebSearchConfig `yaml:"web_search"`
	AllowedDirs []string        `yaml:"-"` // 允许文件操作的目录列表
}

// TerminalConfig 终端工具配置
type TerminalConfig struct {
	BlockedCmds []string `yaml:"blocked_cmds"` // 被阻止的命令
}

// FileIOConfig 文件 IO 配置
type FileIOConfig struct {
	AllowedDirs []string `yaml:"-"` // 允许文件操作的目录
}

// WebSearchConfig 网页搜索配置
type WebSearchConfig struct {
	Provider string `yaml:"provider"` // 搜索服务提供商
	APIKey   string `yaml:"api_key"`  // API Key
	BaseURL  string `yaml:"base_url"` // API 地址
}

// SandboxConfig 沙箱配置
type SandboxConfig struct {
	Enabled     bool                `yaml:"enabled"`      // 是否启用沙箱
	Image       string              `yaml:"image"`        // 沙箱镜像
	NetworkMode string              `yaml:"network_mode"` // 网络模式：none/bridge
	MemoryLimit string              `yaml:"memory_limit"` // 内存限制
	CPULimit    float64             `yaml:"cpu_limit"`    // CPU 限制
	WorkDir     string              `yaml:"work_dir"`     // 容器内工作目录
	Volumes     []VolumeMountConfig `yaml:"-"`            // 卷挂载，固定从 ~/.tietiezhi 派生
}

// VolumeMountConfig 卷挂载配置
type VolumeMountConfig struct {
	HostPath      string `yaml:"host_path"`
	ContainerPath string `yaml:"container_path"`
	ReadOnly      bool   `yaml:"read_only"`
}

// AppHomeDir 返回 tietiezhi 的本地数据目录。
func AppHomeDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("获取用户目录失败: %w", err)
	}
	if home == "" {
		return "", fmt.Errorf("用户目录为空")
	}
	return filepath.Join(home, AppDirName), nil
}

// DefaultConfigPath 返回默认配置文件路径。
func DefaultConfigPath() (string, error) {
	appDir, err := AppHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(appDir, ConfigFileName), nil
}

// Load 从 YAML 文件加载配置；文件不存在时会创建默认模板。
func Load(path string) (*Config, error) {
	if path == "" {
		defaultPath, err := DefaultConfigPath()
		if err != nil {
			return nil, err
		}
		path = defaultPath
	}

	path, err := expandHomePath(path)
	if err != nil {
		return nil, err
	}

	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("解析配置文件路径失败: %w", err)
	}
	path = absPath

	if err := ensureConfigFile(path); err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取配置文件失败: %w", err)
	}

	cfg := &Config{}
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("解析配置文件失败: %w", err)
	}

	appDir, err := AppHomeDir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(appDir, 0700); err != nil {
		return nil, fmt.Errorf("创建本地数据目录失败: %w", err)
	}
	cfg.ConfigPath = path
	cfg.AppDir = appDir
	cfg.applyDefaults(appDir)
	return cfg, nil
}

// Save 将配置保存回来源 YAML 文件。
func (c *Config) Save() error {
	path := c.ConfigPath
	if path == "" {
		defaultPath, err := DefaultConfigPath()
		if err != nil {
			return err
		}
		path = defaultPath
	}

	data, err := yaml.Marshal(c)
	if err != nil {
		return fmt.Errorf("序列化配置失败: %w", err)
	}
	return writeFileAtomic(path, data, 0600)
}

func ensureConfigFile(path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("检查配置文件失败: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("创建配置目录失败: %w", err)
	}
	if err := os.WriteFile(path, []byte(defaultConfigYAML), 0600); err != nil {
		return fmt.Errorf("初始化配置文件失败: %w", err)
	}
	return nil
}

func expandHomePath(path string) (string, error) {
	if path == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("获取用户目录失败: %w", err)
		}
		return home, nil
	}

	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("获取用户目录失败: %w", err)
		}
		return filepath.Join(home, strings.TrimPrefix(path, "~/")), nil
	}

	return path, nil
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("创建配置目录失败: %w", err)
	}

	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("创建临时配置文件失败: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("写入临时配置文件失败: %w", err)
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return fmt.Errorf("设置临时配置文件权限失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("关闭临时配置文件失败: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("保存配置文件失败: %w", err)
	}
	return nil
}

// applyDefaults 填充默认值
func (c *Config) applyDefaults(appDir string) {
	if c.Server.Host == "" {
		c.Server.Host = "0.0.0.0"
	}
	if c.Server.Port == 0 {
		c.Server.Port = 18178
	}
	if c.Agent.MaxToolCalls == 0 {
		c.Agent.MaxToolCalls = 20
	}
	if c.Memory.Type == "" {
		c.Memory.Type = "markdown"
	}
	if c.Scheduler.ExecTimeout == 0 {
		c.Scheduler.ExecTimeout = 300
	}
	// Heartbeat 默认值
	if c.Heartbeat.Interval == 0 {
		c.Heartbeat.Interval = 30
	}
	if c.Log.Level == "" {
		c.Log.Level = "info"
	}
	if c.Log.Format == "" {
		c.Log.Format = "text"
	}
	if c.Session.MaxHistoryTurns == 0 {
		c.Session.MaxHistoryTurns = 20
	}
	if c.Session.AutoSaveSeconds == 0 {
		c.Session.AutoSaveSeconds = 60
	}
	// SubAgent 默认值
	if c.SubAgent.Timeout == 0 {
		c.SubAgent.Timeout = 300
	}
	// Hooks 默认值
	if c.Hooks.Rules == nil {
		c.Hooks.Rules = []hook.HookRule{}
	}
	// Tools 默认值
	if c.Tools.Terminal.BlockedCmds == nil {
		c.Tools.Terminal.BlockedCmds = []string{}
	}
	if c.Tools.FileIO.AllowedDirs == nil {
		c.Tools.FileIO.AllowedDirs = []string{}
	}

	// 压缩配置默认值
	if c.Agent.Compression.MaxChars == 0 {
		c.Agent.Compression.MaxChars = 80000 // 约 20K token
	}
	if c.Agent.Compression.KeepRecent == 0 {
		c.Agent.Compression.KeepRecent = 10
	}
	if c.Agent.Compression.SummaryPrompt == "" {
		c.Agent.Compression.SummaryPrompt = "请总结以下对话的核心内容，保留关键信息、决策和重要细节，用简洁的中文概括："
	}

	// 循环检测器默认值
	if c.Agent.LoopDetector.GenericRepeatThreshold == 0 {
		c.Agent.LoopDetector.GenericRepeatThreshold = 3
	}
	if c.Agent.LoopDetector.GenericRepeatSimilarity == 0 {
		c.Agent.LoopDetector.GenericRepeatSimilarity = 0.8
	}
	if c.Agent.LoopDetector.NoProgressThreshold == 0 {
		c.Agent.LoopDetector.NoProgressThreshold = 5
	}
	if c.Agent.LoopDetector.PingPongWindow == 0 {
		c.Agent.LoopDetector.PingPongWindow = 8
	}
	if c.Agent.LoopDetector.GlobalCircuitBreakerLimit == 0 {
		c.Agent.LoopDetector.GlobalCircuitBreakerLimit = 20
	}

	// 审批配置默认值
	if c.Approval.RequireApproval == nil {
		c.Approval.RequireApproval = []string{}
	}
	if c.Approval.AutoApprove == nil {
		c.Approval.AutoApprove = []string{}
	}

	// 沙箱配置默认值
	if c.Sandbox.Image == "" {
		c.Sandbox.Image = "alpine:latest"
	}
	if c.Sandbox.NetworkMode == "" {
		c.Sandbox.NetworkMode = "none"
	}
	if c.Sandbox.MemoryLimit == "" {
		c.Sandbox.MemoryLimit = "128m"
	}
	if c.Sandbox.CPULimit == 0 {
		c.Sandbox.CPULimit = 0.5
	}
	if c.Sandbox.WorkDir == "" {
		c.Sandbox.WorkDir = "/workspace"
	}

	// 运行时路径固定在 ~/.tietiezhi 下，YAML 中不暴露 path 配置。
	c.Memory.Path = filepath.Join(appDir, "workspace")
	c.Skills.Path = filepath.Join(appDir, "skills")
	c.Scheduler.Path = filepath.Join(appDir, "cron")
	c.Session.PersistPath = filepath.Join(appDir, "sessions")
	c.SubAgent.Path = filepath.Join(appDir, "subagents")
	c.Observability.AuditLog.Path = filepath.Join(appDir, "audit", "audit.jsonl")
	c.Tools.FileIO.AllowedDirs = []string{c.Memory.Path}
	c.Tools.AllowedDirs = []string{c.Memory.Path}

	if c.Sandbox.Volumes == nil || len(c.Sandbox.Volumes) == 0 {
		c.Sandbox.Volumes = []VolumeMountConfig{
			{
				HostPath:      c.Memory.Path,
				ContainerPath: c.Sandbox.WorkDir,
				ReadOnly:      true,
			},
		}
	}
}

// ObservabilityConfig 可观测性配置
type ObservabilityConfig struct {
	Enabled    bool           `yaml:"enabled"`     // 是否启用可观测性
	AuditLog   AuditLogConfig `yaml:"audit_log"`   // 审计日志配置
	TokenTrack bool           `yaml:"token_track"` // 是否追踪 Token 使用
}

// AuditLogConfig 审计日志配置
type AuditLogConfig struct {
	Enabled bool   `yaml:"enabled"` // 是否启用审计日志
	Path    string `yaml:"-"`       // 审计日志路径，固定在 ~/.tietiezhi/audit/audit.jsonl
}
