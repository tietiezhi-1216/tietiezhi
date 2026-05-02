package agent

import (
	"encoding/json"
	"strings"
	"sync"

	"tietiezhi/internal/config"
)

// ToolCallRecord 工具调用记录
type ToolCallRecord struct {
	ToolName string                 // 工具名称
	Args     map[string]interface{} // 工具参数
	Result   string                 // 执行结果
	ResultLen int                   // 结果长度（用于无进展检测）
}

// LoopDetector 工具调用循环检测器
// 参考 OpenClaw 的4种检测器实现：
// 1. generic_repeat - 重复调用检测：同一工具连续调用多次且参数相似
// 2. no_progress - 无进展检测：连续多次工具调用返回结果无新信息
// 3. ping_pong - 来回弹跳检测：A→B→A→B 交替调用模式
// 4. global_circuit_breaker - 全局熔断：总调用次数超限
type LoopDetector struct {
	mu           sync.RWMutex
	config       config.LoopDetectorConfig
	callHistory  []ToolCallRecord     // 工具调用历史
	totalCalls   int                  // 总调用次数

	// 各检测器的状态
	repeatCount  int                  // 当前重复调用计数
	lastToolName string               // 上次调用的工具名
	lastArgsJSON string               // 上次调用的参数（JSON字符串）
	progressCount int                 // 无进展计数
	lastResultHash string             // 上次结果哈希

	// 工具豁免与限制
	repeatExemptTools map[string]bool // 豁免重复检测的工具（如 agent_spawn 天然需要多次调用）
	toolCallCounts    map[string]int  // 每个工具的累计调用次数
	toolCallLimits    map[string]int  // 每个工具的调用上限（0=无限制）
}

// NewLoopDetector 创建循环检测器
func NewLoopDetector(maxCalls int, cfg *config.LoopDetectorConfig) *LoopDetector {
	if cfg == nil {
		cfg = &config.LoopDetectorConfig{
			GenericRepeatThreshold:    3,
			GenericRepeatSimilarity:   0.8,
			NoProgressThreshold:       5,
			PingPongWindow:            8,
			GlobalCircuitBreakerLimit: 20,
		}
	}

	// 如果传入的 maxCalls 更小，使用较小的值
	if maxCalls > 0 && maxCalls < cfg.GlobalCircuitBreakerLimit {
		cfg.GlobalCircuitBreakerLimit = maxCalls
	}

	// 设置豁免重复检测的工具（天然需要多次调用）
	exemptTools := map[string]bool{
		"agent_spawn": true,   // 子代理生成天然需要多次调用
		"file_read":   true,   // 可能需要读取多个文件
		"file_write":  true,   // 可能需要写入多个文件
		"web_search":  true,   // 可能需要多次搜索不同关键词
		"web_fetch":   true,   // 可能需要获取多个页面
		"memory_add":  true,   // 可能需要写入多条记忆
	}

	// 设置每个工具的调用上限（0=无限制，走全局熔断）
	toolLimits := map[string]int{
		// 暂无工具设置调用上限，全部走全局熔断
	}

	return &LoopDetector{
		config:            *cfg,
		callHistory:       make([]ToolCallRecord, 0),
		repeatExemptTools: exemptTools,
		toolCallCounts:    make(map[string]int),
		toolCallLimits:    toolLimits,
	}
}

// Check 检查是否出现循环，返回 true 表示检测到循环需要熔断
// toolName: 工具名称
// result: 工具执行结果
// args: 工具参数（可选，用于重复检测）
func (d *LoopDetector) Check(toolName string, result string, args map[string]interface{}) bool {
	d.mu.Lock()
	defer d.mu.Unlock()

	d.totalCalls++

	// 记录每个工具的调用次数
	d.toolCallCounts[toolName]++

	// 记录调用
	record := ToolCallRecord{
		ToolName:   toolName,
		Args:       args,
		Result:     result,
		ResultLen:  len(result),
	}
	d.callHistory = append(d.callHistory, record)

	// 0. 单工具调用上限检测（优先于其他检测）
	if limit, ok := d.toolCallLimits[toolName]; ok && limit > 0 {
		if d.toolCallCounts[toolName] > limit {
			return true
		}
	}

	// 1. 全局熔断检测
	if d.totalCalls > d.config.GlobalCircuitBreakerLimit {
		return true
	}

	// 2. 重复调用检测 (generic_repeat) — 豁免工具跳过
	isExempt := d.repeatExemptTools[toolName]
	if !isExempt {
		if d.checkGenericRepeat(toolName, args) {
			d.repeatCount++
			if d.repeatCount >= d.config.GenericRepeatThreshold {
				return true
			}
		} else {
			d.repeatCount = 1 // 重置
		}
	}

	// 3. 无进展检测 (no_progress) — 仅当结果非空且工具不在豁免名单时检测
	// 豁免工具（如 agent_spawn）可能天然返回相似格式结果，不应触发无进展检测
	if result != "" && !isExempt {
		if d.checkNoProgress(result) {
			d.progressCount++
			if d.progressCount >= d.config.NoProgressThreshold {
				return true
			}
		} else {
			d.progressCount = 0 // 重置
		}
	}

	// 4. 来回弹跳检测 (ping_pong)
	if d.checkPingPong() {
		return true
	}

	return false
}

// checkGenericRepeat 检测重复调用模式
// 同一工具连续调用多次且参数相似度超过阈值
func (d *LoopDetector) checkGenericRepeat(toolName string, args map[string]interface{}) bool {
	if d.lastToolName != toolName {
		d.lastToolName = toolName
		d.lastArgsJSON = argsToJSON(args)
		return false
	}

	// 工具相同，检查参数相似度
	currentArgsJSON := argsToJSON(args)
	similarity := calculateSimilarity(d.lastArgsJSON, currentArgsJSON)

	d.lastArgsJSON = currentArgsJSON

	return similarity >= d.config.GenericRepeatSimilarity
}

// checkNoProgress 检测无进展模式
// 连续多次工具调用返回结果高度相似（长度和内容）
func (d *LoopDetector) checkNoProgress(result string) bool {
	resultHash := simpleHash(result)

	if resultHash == d.lastResultHash {
		return true
	}

	d.lastResultHash = resultHash
	return false
}

// checkPingPong 检测来回弹跳模式
// A→B→A→B 交替调用模式
func (d *LoopDetector) checkPingPong() bool {
	windowSize := d.config.PingPongWindow
	// 至少需要 6 次调用（3 轮 A-B-A-B）才有意义
	if len(d.callHistory) < 6 || len(d.callHistory) < windowSize {
		return false
	}

	// 获取最近 windowSize 个工具调用
	recentCalls := d.callHistory[len(d.callHistory)-windowSize:]

	// 检查是否存在 A-B-A-B 交替模式
	for i := 0; i < len(recentCalls)-3; i++ {
		// 检查前4个调用是否形成 A-B-A-B 模式
		if recentCalls[i].ToolName == recentCalls[i+2].ToolName &&
			recentCalls[i].ToolName != recentCalls[i+1].ToolName &&
			recentCalls[i+1].ToolName == recentCalls[i+3].ToolName {
			return true
		}
	}

	return false
}

// Reset 重置检测状态
func (d *LoopDetector) Reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.callHistory = d.callHistory[:0]
	d.totalCalls = 0
	d.repeatCount = 0
	d.lastToolName = ""
	d.lastArgsJSON = ""
	d.progressCount = 0
	d.lastResultHash = ""
	for k := range d.toolCallCounts {
		delete(d.toolCallCounts, k)
	}
}

// GetTotalCalls 获取总调用次数
func (d *LoopDetector) GetTotalCalls() int {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.totalCalls
}

// GetCallHistory 获取调用历史（用于调试）
func (d *LoopDetector) GetCallHistory() []ToolCallRecord {
	d.mu.RLock()
	defer d.mu.RUnlock()
	result := make([]ToolCallRecord, len(d.callHistory))
	copy(result, d.callHistory)
	return result
}

// argsToJSON 将参数 map 转换为 JSON 字符串
func argsToJSON(args map[string]interface{}) string {
	if args == nil {
		return "{}"
	}
	data, err := json.Marshal(args)
	if err != nil {
		return "{}"
	}
	return string(data)
}

// calculateSimilarity 计算两个字符串的相似度（简单实现：Jaccard系数）
func calculateSimilarity(a, b string) float64 {
	if a == b {
		return 1.0
	}
	if len(a) == 0 || len(b) == 0 {
		return 0.0
	}

	// 将字符串转换为 rune 集合
	setA := make(map[rune]bool)
	setB := make(map[rune]bool)

	for _, r := range a {
		setA[r] = true
	}
	for _, r := range b {
		setB[r] = true
	}

	// 计算交集大小
	intersection := 0
	for r := range setA {
		if setB[r] {
			intersection++
		}
	}

	// 计算并集大小
	union := len(setA) + len(setB) - intersection

	if union == 0 {
		return 0.0
	}

	return float64(intersection) / float64(union)
}

// simpleHash 计算字符串的简单哈希值（用于快速比较）
func simpleHash(s string) string {
	if len(s) == 0 {
		return ""
	}

	// 简化：使用长度 + 首尾字符 + 关键字符的哈希
	length := len(s)

	// 计算一个简单的校验和
	var sum int
	for i := 0; i < len(s) && i < 100; i++ {
		sum += int(s[i])
	}

	// 返回简化表示：长度 + 校验和
	return strings.Join([]string{
		string(rune(length / 256)),
		string(rune(length % 256)),
		string(rune(sum % 256)),
	}, "")
}
