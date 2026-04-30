package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"tietiezhi/internal/config"
	"tietiezhi/internal/server"
)

func main() {
	configPath := flag.String("c", "configs/config.yaml", "配置文件路径")
	flag.Parse()

	// 加载配置
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}

	// 创建并启动服务器
	srv := server.New(cfg)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := srv.Start(ctx); err != nil {
		log.Fatalf("启动服务器失败: %v", err)
	}

	log.Printf("tietiezhi 服务器已启动，监听 %s:%d", cfg.Server.Host, cfg.Server.Port)

	// 等待退出信号
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("正在关闭服务器...")
	if err := srv.Stop(ctx); err != nil {
		log.Printf("关闭服务器出错: %v", err)
	}
	fmt.Println("服务器已停止")
}
