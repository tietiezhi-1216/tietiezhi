package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"tietiezhi/internal/agent"
	"tietiezhi/internal/channel"
	"tietiezhi/internal/channel/feishu"
	"tietiezhi/internal/config"
	"tietiezhi/internal/llm"
	"tietiezhi/internal/server"
	"tietiezhi/internal/session"
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

	// 初始化 Agent
	ag := agent.NewBaseAgent(provider, cfg.Agent.SystemPrompt, cfg.Agent.MaxToolCalls, sessionMgr)

	// 初始化渠道注册表
	channelRegistry := channel.NewRegistry()

	// 注册飞书渠道
	if cfg.Channels.Feishu != nil && cfg.Channels.Feishu.Enabled {
		feishuCh := feishu.New(cfg.Channels.Feishu.AppID, cfg.Channels.Feishu.AppSecret)
		feishu.SetAgentHandler(feishuCh, ag, cfg.Channels.Feishu.Streaming)
		channelRegistry.Register(feishuCh)
		mode := "非流式(Legacy)"
		if cfg.Channels.Feishu.Streaming {
			mode = "流式(Streaming)"
		}
		log.Printf("飞书渠道已注册（%s模式）", mode)
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
	fmt.Println("服务器已停止")
}
