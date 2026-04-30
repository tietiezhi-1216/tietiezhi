package config

import (
	"fmt"
	"os"

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
	Log       LogConfig       `yaml:"log"`
}

// ServerConfig 服务器配置
type ServerConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
}

// LLMConfig 大模型配置
type LLMConfig struct {
	Provider string `yaml:"provider"` // 目前仅支持 openai
	BaseURL  string `yaml:"base_url"`
	APIKey   string `yaml:"api_key"`
	Model    string `yaml:"model"`
}

// AgentConfig Agent 配置
type AgentConfig struct {
	MaxToolCalls  int    `yaml:"max_tool_calls"`  // 单次对话最大工具调用次数
	SystemPrompt  string `yaml:"system_prompt"`   // 默认系统提示词
	LoopDetection bool   `yaml:"loop_detection"`  // 是否启用循环检测
}

// ChannelsConfig 渠道配置
type ChannelsConfig struct {
	Feishu *FeishuConfig `yaml:"feishu"`
	// 后续扩展：DingTalk, Telegram, Discord, Slack...
}

// FeishuConfig 飞书渠道配置
type FeishuConfig struct {
	Enabled   bool   `yaml:"enabled"`
	AppID     string `yaml:"app_id"`
	AppSecret string `yaml:"app_secret"`
}

// MemoryConfig 记忆配置
type MemoryConfig struct {
	Type string `yaml:"type"` // markdown
	Path string `yaml:"path"` // 记忆文件目录
}

// SkillsConfig 技能配置
type SkillsConfig struct {
	Path string `yaml:"path"` // 技能包目录
}

// SchedulerConfig 定时任务配置
type SchedulerConfig struct {
	Enabled bool `yaml:"enabled"`
}

// LogConfig 日志配置
type LogConfig struct {
	Level  string `yaml:"level"`  // debug, info, warn, error
	Format string `yaml:"format"` // json, text
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

	cfg.applyDefaults()
	return cfg, nil
}

// applyDefaults 填充默认值
func (c *Config) applyDefaults() {
	if c.Server.Host == "" {
		c.Server.Host = "0.0.0.0"
	}
	if c.Server.Port == 0 {
		c.Server.Port = 8080
	}
	if c.Agent.MaxToolCalls == 0 {
		c.Agent.MaxToolCalls = 20
	}
	if c.Memory.Type == "" {
		c.Memory.Type = "markdown"
	}
	if c.Memory.Path == "" {
		c.Memory.Path = "./workspaces"
	}
	if c.Skills.Path == "" {
		c.Skills.Path = "./skills"
	}
	if c.Log.Level == "" {
		c.Log.Level = "info"
	}
	if c.Log.Format == "" {
		c.Log.Format = "text"
	}
}
