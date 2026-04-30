package scheduler

import "context"

// Scheduler 定时任务调度器
type Scheduler struct {
	// TODO: Phase 6 实现定时任务调度
}

// New 创建调度器
func New() *Scheduler {
	return &Scheduler{}
}

// Start 启动调度器
func (s *Scheduler) Start(ctx context.Context) error {
	// TODO: 实现调度器启动
	return nil
}

// Stop 停止调度器
func (s *Scheduler) Stop(ctx context.Context) error {
	// TODO: 实现调度器停止
	return nil
}
