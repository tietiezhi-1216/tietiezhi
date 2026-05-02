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
	"tietiezhi/internal/hook"
	"tietiezhi/internal/llm"
	"tietiezhi/internal/mcp"
	"tietiezhi/internal/media"
	"tietiezhi/internal/memory"
	"tietiezhi/internal/sandbox"
	"tietiezhi/internal/server"
	"tietiezhi/internal/session"
	"tietiezhi/internal/skill"
	"tietiezhi/internal/subagent"
	"tietiezhi/internal/tool/builtin"
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

	// ========== 沙箱初始化 ==========
	var sandboxMgr *sandbox.SandboxManager
	if cfg.Sandbox.Enabled {
		sandboxMgr = builtin.NewSandboxManagerFromConfig(&cfg.Sandbox)
		
		// 检查 Docker 是否可用
		if err := sandboxMgr.HealthCheck(); err != nil {
			log.Printf("⚠️ Docker 不可用，沙箱功能已禁用: %v", err)
			sandboxMgr = sandbox.NewSandboxManager(false, nil)
		} else {
			log.Printf("✓ Docker 可用，沙箱已启用")
			
			// 确保镜像存在
			ctx := context.Background()
			if err := sandboxMgr.EnsureImage(ctx); err != nil {
				log.Printf("⚠️ 拉取沙箱镜像失败: %v，沙箱将不可用", err)
				sandboxMgr = sandbox.NewSandboxManager(false, nil)
			} else {
				log.Printf("✓ 沙箱镜像 %s 已就绪", cfg.Sandbox.Image)
			}
		}
	} else {
		log.Println("沙箱功能已禁用")
	}

	// 初始化 LLM Provider 工厂
	factory := llm.NewProviderFactory()

	// 初始化主 LLM Provider
	var provider llm.Provider
	switch cfg.LLM.Provider {
	case "openai":
		provider, err = factory.CreateMainProvider(cfg.LLM.BaseURL, cfg.LLM.APIKey, cfg.LLM.Model)
		if err != nil {
			log.Fatalf("初始化主 LLM Provider 失败: %v", err)
		}
	default:
		log.Fatalf("不支持的 LLM Provider: %s", cfg.LLM.Provider)
	}

	// 初始化 cheap LLM Provider（用于压缩等简单任务）
	var cheapProvider llm.Provider
	if cfg.LLM.CheapModel != "" || cfg.LLM.CheapBaseURL != "" {
		cheapProvider, err = factory.CreateCheapProvider(
			cfg.LLM.BaseURL, cfg.LLM.APIKey, cfg.LLM.Model,
			cfg.LLM.CheapBaseURL, cfg.LLM.CheapAPIKey, cfg.LLM.CheapModel,
		)
		if err != nil {
			log.Printf("初始化 cheap LLM Provider 失败: %v，将使用主模型", err)
		} else {
			log.Printf("cheap LLM Provider 已初始化: %s", cfg.LLM.CheapModel)
		}
	} else {
		log.Println("cheap LLM Provider 未配置，将使用主模型进行所有操作")
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

	// ========== 初始化终端工具（带沙箱支持）==========
	if sandboxMgr != nil && sandboxMgr.IsEnabled() {
		terminalTool := builtin.NewTerminalToolWithSandbox(sandboxMgr, true, cfg.Tools.Terminal.BlockedCmds...)
		agent.SetTerminalTool(terminalTool)
		log.Printf("终端工具已初始化（沙箱模式）: image=%s, network=%s, memory=%s", 
			cfg.Sandbox.Image, cfg.Sandbox.NetworkMode, cfg.Sandbox.MemoryLimit)
	} else {
		terminalTool := builtin.NewTerminalTool(cfg.Tools.Terminal.BlockedCmds...)
		agent.SetTerminalTool(terminalTool)
		log.Println("终端工具已初始化（直接执行模式）")
	}

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

	// 初始化定时任务管理器
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

	// 初始化子代理管理器
	var subAgentMgr *subagent.SubAgentManager
	if cfg.SubAgent.Enabled {
		subAgentMgr = subagent.NewSubAgentManager(cfg.SubAgent.Path, cfg.SubAgent.Timeout)
		log.Printf("子代理管理器已创建: path=%s, timeout=%ds", cfg.SubAgent.Path, cfg.SubAgent.Timeout)
	}

	// 初始化 Hook 管理器
	hookManager := hook.NewHookManager(cfg.Hooks.Rules, cfg.Hooks.Enabled)
	if cfg.Hooks.Enabled {
		hook.RegisterBuiltinScripts(hookManager)
		log.Printf("Hook 系统已初始化: %d 条规则", len(cfg.Hooks.Rules))
	} else {
		log.Println("Hook 系统已禁用")
	}

	// 初始化 Agent（使用带配置的构造函数）
	ag := agent.NewBaseAgentWithConfig(provider, cfg.Agent.SystemPrompt, cfg.Agent.MaxToolCalls, sessionMgr, memoryMgr, &cfg.Agent)

	// 设置 cheap provider（用于压缩等简单任务）
	if cheapProvider != nil {
		ag.SetCheapProvider(cheapProvider)
	}

	// 设置审批配置
	if cfg.Approval.Enabled {
		ag.SetApprovalConfig(&cfg.Approval)
		log.Printf("审批系统已启用: %d 个工具需要审批", len(cfg.Approval.RequireApproval))
	}

	ag.SetSkillLoader(skillLoader)
	ag.SetMCPManager(mcpManager)
	ag.SetCronManager(cronMgr)
	ag.SetSubAgentManager(subAgentMgr)
	ag.SetHookManager(hookManager)

	// 初始化并设置文件分析工具
	fileAnalyzeTool := builtin.NewFileAnalyzeTool(provider)
	ag.SetFileAnalyzeTool(fileAnalyzeTool)
	log.Println("文件分析工具已初始化")

	// 初始化上传目录
	media.NewUploadManager(memoryMgr.GetUploadDir())
	log.Printf("媒体上传目录已初始化: %s", memoryMgr.GetUploadDir())

	// 打印压缩配置
	if cfg.Agent.Compression.Enabled {
		log.Printf("上下文压缩已启用: max_chars=%d, keep_recent=%d",
			cfg.Agent.Compression.MaxChars, cfg.Agent.Compression.KeepRecent)
	}

	// 打印循环检测配置
	if cfg.Agent.LoopDetection {
		log.Printf("循环检测已启用: global_limit=%d, repeat_threshold=%d, ping_pong_window=%d",
			cfg.Agent.LoopDetector.GlobalCircuitBreakerLimit,
			cfg.Agent.LoopDetector.GenericRepeatThreshold,
			cfg.Agent.LoopDetector.PingPongWindow)
	}

	// 初始化渠道注册表
	channelRegistry := channel.NewRegistry()

	// 注册飞书渠道
	if cfg.Channels.Feishu != nil && cfg.Channels.Feishu.Enabled {
		feishuCh := feishu.New(cfg.Channels.Feishu.AppID, cfg.Channels.Feishu.AppSecret, cfg.Channels.Feishu.BotOpenID)

		// 设置上传目录（用于保存媒体文件）
		feishuCh.SetUploadDir(memoryMgr.GetUploadDir())

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

		// 设置子代理投递函数
		if subAgentMgr != nil {
			subAgentMgr.SetDeliveryFn(func(chatID, content string) error {
				return feishuCh.Send(context.Background(), chatID, &channel.Message{Content: content})
			})
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
		// 注入 CronManager 到 HeartbeatManager
		heartbeatMgr.SetCronManager(cronMgr)
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
