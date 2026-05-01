package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// Config 顶层配置结构
type Config struct {
	Server    ServerConfig    `yaml:"server"`
	LLM       LLMConfig       `yaml:"llm"`
	Agent     AgentConfig     `yaml:"agent"`
	Channels  ChannelsConfig  `yaml:"channels"`
	Memory    MemoryConfig    `yaml:"memory"`
	Skills    SkillsConfig    `yaml:"skills"`
	Scheduler SchedulerConfig `yaml:"scheduler"`
	Heartbeat HeartbeatConfig `yaml:"heartbeat"`
	Log       LogConfig       `yaml:"log"`
	Session   SessionConfig   `yaml:"session"`
}

// ServerConfig 服务器配置
type ServerConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
}

// LLMConfig 大模型配置
type LLMConfig struct {
	Provider string `yaml:"provider"`
	BaseURL  string `yaml:"base_url"`
	APIKey   string `yaml:"api_key"`
	Model    string `yaml:"model"`
}

// AgentConfig Agent 配置
type AgentConfig struct {
	MaxToolCalls  int    `yaml:"max_tool_calls"`
	SystemPrompt  string `yaml:"system_prompt"`
	LoopDetection bool   `yaml:"loop_detection"`
}

// ChannelsConfig 渠道配置
type ChannelsConfig struct {
	Feishu *FeishuConfig `yaml:"feishu"`
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

// MemoryConfig 记忆配置
type MemoryConfig struct {
	Type string `yaml:"type"`
	Path string `yaml:"path"`
}

// SkillsConfig 技能配置
type SkillsConfig struct {
	Path string `yaml:"path"`
}

// SchedulerConfig 定时任务配置
type SchedulerConfig struct {
	Enabled     bool   `yaml:"enabled"`
	Path        string `yaml:"path"`
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
	PersistPath     string `yaml:"persist_path"`
	AutoSaveSeconds int    `yaml:"auto_save_seconds"`
}

// Load 从 YAML 文件加载配置
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取配置文件失败: %w", err)
	}

	cfg := &Config{}
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("解析配置文件失败: %w", err)
	}

	cfg.applyDefaults(path)
	return cfg, nil
}

// applyDefaults 填充默认值
func (c *Config) applyDefaults(configPath string) {
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
	if c.Memory.Path == "" {
		c.Memory.Path = "./data/workspace"
	}
	if c.Skills.Path == "" {
		c.Skills.Path = "./skills"
	}
	if c.Scheduler.Path == "" {
		c.Scheduler.Path = "./data/cron"
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
	if c.Session.PersistPath == "" {
		c.Session.PersistPath = "./data/sessions"
	}
	if c.Session.AutoSaveSeconds == 0 {
		c.Session.AutoSaveSeconds = 60
	}

	// 解析相对路径为绝对路径
	c.Memory.Path = resolvePath(c.Memory.Path, configPath)
	c.Skills.Path = resolvePath(c.Skills.Path, configPath)
	c.Scheduler.Path = resolvePath(c.Scheduler.Path, configPath)
	c.Session.PersistPath = resolvePath(c.Session.PersistPath, configPath)
}

// resolvePath 解析相对路径为绝对路径
func resolvePath(path string, configPath string) string {
	if filepath.IsAbs(path) {
		return path
	}
	absConfigPath, _ := filepath.Abs(configPath)
	configDir := filepath.Dir(absConfigPath)
	return filepath.Join(configDir, path)
}
