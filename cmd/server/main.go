package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"tietiezhi/internal/agent"
	"tietiezhi/internal/channel"
	"tietiezhi/internal/channel/feishu"
	"tietiezhi/internal/config"
	"tietiezhi/internal/cron"
	"tietiezhi/internal/heartbeat"
	"tietiezhi/internal/llm"
	"tietiezhi/internal/mcp"
	"tietiezhi/internal/memory"
	"tietiezhi/internal/server"
	"tietiezhi/internal/session"
	"tietiezhi/internal/skill"
)

func main() {
	configPath := flag.String("c", "configs/config.yaml", "配置文件路径")
	flag.Parse()

	// 加载配置
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}

	log.Printf("配置加载成功: server=%s:%d, llm=%s/%s", cfg.Server.Host, cfg.Server.Port, cfg.LLM.Provider, cfg.LLM.Model)

	// 初始化 LLM Provider
	var provider llm.Provider
	switch cfg.LLM.Provider {
	case "openai":
		provider = llm.NewOpenAIProvider(cfg.LLM.BaseURL, cfg.LLM.APIKey, cfg.LLM.Model)
	default:
		log.Fatalf("不支持的 LLM Provider: %s", cfg.LLM.Provider)
	}

	// 初始化会话管理器
	sessionMgr := session.NewSessionManager(
		cfg.Session.MaxHistoryTurns,
		cfg.Session.AutoSaveSeconds,
		cfg.Session.PersistPath,
	)

	// 初始化记忆管理器
	memoryMgr := memory.NewMemoryManager(cfg.Memory.Path)
	log.Printf("记忆系统已初始化: workspace=%s", memoryMgr.GetWorkspacePath())

	// 初始化 MCP 管理器
	mcpManager := mcp.NewMCPManager()
	log.Println("MCP 管理器已初始化")

	// 初始化技能加载器
	skillsPath := cfg.Skills.Path
	if !filepath.IsAbs(skillsPath) {
		absConfigPath, _ := filepath.Abs(*configPath)
		configDir := filepath.Dir(absConfigPath)
		skillsPath = filepath.Join(configDir, skillsPath)
	}
	skillLoader := skill.NewLoader(skillsPath)
	if err := skillLoader.LoadAll(); err != nil {
		log.Printf("技能加载失败: %v", err)
	}

	// 初始化定时任务管理器（使用修复后的路径拼接）
	cronMgr := cron.NewCronManager(cfg.Scheduler.Path, cfg.Scheduler.ExecTimeout)
	if cfg.Scheduler.Enabled {
		log.Printf("定时任务管理器已创建: path=%s/jobs.json, timeout=%ds", cfg.Scheduler.Path, cfg.Scheduler.ExecTimeout)
	}

	// 初始化心跳管理器
	var heartbeatMgr *heartbeat.HeartbeatManager
	if cfg.Heartbeat.Enabled {
		heartbeatMgr = heartbeat.NewHeartbeatManager(cfg.Heartbeat.Interval)
		log.Printf("心跳管理器已创建: interval=%dmin", cfg.Heartbeat.Interval)
	}

	// 初始化 Agent
	ag := agent.NewBaseAgent(provider, cfg.Agent.SystemPrompt, cfg.Agent.MaxToolCalls, sessionMgr, memoryMgr)
	ag.SetSkillLoader(skillLoader)
	ag.SetMCPManager(mcpManager)
	ag.SetCronManager(cronMgr)

	// 初始化渠道注册表
	channelRegistry := channel.NewRegistry()

	// 注册飞书渠道
	if cfg.Channels.Feishu != nil && cfg.Channels.Feishu.Enabled {
		feishuCh := feishu.New(cfg.Channels.Feishu.AppID, cfg.Channels.Feishu.AppSecret, cfg.Channels.Feishu.BotOpenID)

		// 设置心跳消息回调（更新 chatID）
		if heartbeatMgr != nil {
			feishuCh.SetOnMessage(func(chatType, chatID string) {
				if chatType != "group" {
					heartbeatMgr.UpdateChatID(chatID)
				}
			})
		}

		feishu.SetAgentHandler(feishuCh, ag, cfg.Channels.Feishu.Streaming)
		channelRegistry.Register(feishuCh)
		mode := "非流式(Legacy)"
		if cfg.Channels.Feishu.Streaming {
			mode = "流式(Streaming)"
		}
		log.Printf("飞书渠道已注册（%s模式）", mode)

		// 设置定时任务投递函数
		if cfg.Scheduler.Enabled {
			cronMgr.SetDeliveryFn(func(chatID, content string) error {
				return feishuCh.Send(context.Background(), chatID, &channel.Message{Content: content})
			})
		}

		// 设置心跳投递函数
		if heartbeatMgr != nil {
			heartbeatMgr.SetDeliveryFn(func(chatID, content string) error {
				return feishuCh.Send(context.Background(), chatID, &channel.Message{Content: content})
			})
			// 如果配置文件指定了 chatID，设置它
			if cfg.Heartbeat.ChatID != "" {
				heartbeatMgr.SetChatID(cfg.Heartbeat.ChatID)
			}
		}
	}

	// 设置 Agent 的 CronManager
	_ = cronMgr

	// 启动定时任务调度器
	if cfg.Scheduler.Enabled {
		cronMgr.SetAgent(ag)
		if err := cronMgr.Start(context.Background()); err != nil {
			log.Printf("启动定时任务调度器失败: %v", err)
		}
	}

	// 启动心跳系统
	if heartbeatMgr != nil {
		heartbeatMgr.SetAgent(ag)
		heartbeatMgr.SetMemoryManager(memoryMgr)
		go heartbeatMgr.Start(context.Background())
	}

	// 创建 HTTP 服务器
	srv := server.New(cfg, ag)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 启动 HTTP 服务器
	if err := srv.Start(ctx); err != nil {
		log.Fatalf("启动服务器失败: %v", err)
	}
	log.Printf("tietiezhi 服务器已启动，监听 %s:%d", cfg.Server.Host, cfg.Server.Port)

	// 启动所有渠道
	if err := channelRegistry.StartAll(ctx); err != nil {
		log.Printf("启动渠道失败: %v", err)
	}

	// 启动会话自动保存
	sessionMgr.StartAutoSave(ctx)
	log.Println("会话自动保存已启动")

	// 等待退出信号
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("正在关闭...")
	channelRegistry.StopAll(ctx)
	if err := srv.Stop(ctx); err != nil {
		log.Printf("关闭服务器出错: %v", err)
	}

	// 停止心跳系统
	if heartbeatMgr != nil {
		heartbeatMgr.Stop()
	}

	// 停止定时任务调度器
	if cfg.Scheduler.Enabled {
		if err := cronMgr.Stop(); err != nil {
			log.Printf("停止定时任务调度器出错: %v", err)
		}
	}

	// 关闭 MCP 连接
	if err := mcpManager.Close(); err != nil {
		log.Printf("关闭 MCP 连接出错: %v", err)
	}

	fmt.Println("服务器已停止")
}
