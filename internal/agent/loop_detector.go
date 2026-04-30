package agent

// LoopDetector 工具调用循环检测器
// 参考 OpenClaw 的4种检测器：generic_repeat / known_poll_no_progress / ping_pong / global_circuit_breaker
type LoopDetector struct {
	// TODO: Phase 2 实现
	maxCalls    int
	windowSize  int
	callHistory []string
}

// NewLoopDetector 创建循环检测器
func NewLoopDetector(maxCalls int) *LoopDetector {
	return &LoopDetector{
		maxCalls:    maxCalls,
		callHistory: make([]string, 0),
	}
}

// Check 检查是否出现循环，返回 true 表示检测到循环
func (d *LoopDetector) Check(toolName string, result string) bool {
	// TODO: 实现滑动窗口检测
	// 1. 记录工具调用
	// 2. 检测重复调用模式（不管成功失败）
	// 3. 检测无新进展
	// 4. 全局熔断（总调用次数上限）
	return false
}

// Reset 重置检测状态
func (d *LoopDetector) Reset() {
	d.callHistory = d.callHistory[:0]
}
