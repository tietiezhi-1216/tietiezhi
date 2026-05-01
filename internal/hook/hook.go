package hook

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// HookManager 管理所有 Hook 规则的执行
type HookManager struct {
	rules   []HookRule
	scripts map[string]func(HookEvent) HookResult
	mu      sync.RWMutex
	enabled bool
}

// NewHookManager 从配置创建
func NewHookManager(rules []HookRule, enabled bool) *HookManager {
	m := &HookManager{
		rules:   rules,
		scripts: make(map[string]func(HookEvent) HookResult),
		enabled: enabled,
	}
	return m
}

// SetEnabled 设置启用状态
func (m *HookManager) SetEnabled(enabled bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.enabled = enabled
}

// IsEnabled 检查是否启用
func (m *HookManager) IsEnabled() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.enabled
}

// RegisterScript 注册内置脚本
func (m *HookManager) RegisterScript(name string, fn func(HookEvent) HookResult) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.scripts[name] = fn
}

// Fire 触发事件，返回所有匹配 Hook 的结果
// 对于 pre_tool_use：任一 Hook 返回 deny 则拒绝；有 modify 则合并修改
// 对于其他事件：顺序执行，不阻塞主流程（忽略错误）
func (m *HookManager) Fire(ctx context.Context, event HookEvent) []HookResult {
	m.mu.RLock()
	if !m.enabled {
		m.mu.RUnlock()
		return nil
	}
	rules := m.rules
	scripts := m.scripts
	m.mu.RUnlock()

	var results []HookResult
	for _, rule := range rules {
		if !m.matchRule(rule, event) {
			continue
		}

		var result HookResult
		switch rule.Type {
		case TypeCommand:
			result = m.executeCommand(ctx, rule, event)
		case TypeScript:
			result = m.executeScript(rule, event, scripts)
		default:
			log.Printf("[Hook] 未知类型: %s", rule.Type)
			continue
		}

		if result.Decision != "" {
			results = append(results, result)
		}
	}

	return results
}

// ShouldProceed 简化接口：对于 pre_tool_use，判断是否允许继续
func (m *HookManager) ShouldProceed(ctx context.Context, event HookEvent) (bool, HookResult) {
	results := m.Fire(ctx, event)

	if len(results) == 0 {
		return true, HookResult{Decision: DecisionApprove}
	}

	// 合并所有 modify 结果
	mergedInput := make(map[string]interface{})
	for _, r := range results {
		if r.Decision == DecisionDeny {
			return false, r
		}
		if r.Decision == DecisionModify && r.UpdatedInput != nil {
			for k, v := range r.UpdatedInput {
				mergedInput[k] = v
			}
		}
	}

	if len(mergedInput) > 0 {
		return true, HookResult{
			Decision:     DecisionModify,
			UpdatedInput: mergedInput,
		}
	}

	return true, results[len(results)-1]
}

// executeCommand 执行 command 类型 Hook
func (m *HookManager) executeCommand(ctx context.Context, rule HookRule, event HookEvent) HookResult {
	if rule.Command == "" {
		return HookResult{Decision: DecisionApprove}
	}

	// 设置超时
	timeout := 5
	if rule.Timeout > 0 {
		timeout = rule.Timeout
	}

	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()

	// 序列化事件为 JSON
	eventJSON, err := json.Marshal(event)
	if err != nil {
		log.Printf("[Hook] 序列化事件失败: %v", err)
		return HookResult{Decision: DecisionApprove}
	}

	// 执行命令
	cmd := exec.CommandContext(ctx, "sh", "-c", rule.Command)
	cmd.Stdin = bytes.NewReader(eventJSON)

	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	err = cmd.Run()

	result := HookResult{Decision: DecisionApprove}

	// 根据 exit code 判断
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			result.Reason = fmt.Sprintf("Hook 执行超时（%d秒）", timeout)
			log.Printf("[Hook] 超时: %s", rule.Command)
		} else if exitErr, ok := err.(*exec.ExitError); ok {
			code := exitErr.ExitCode()
			if code == 2 {
				result.Decision = DecisionDeny
				result.Reason = strings.TrimSpace(stderr.String())
				if result.Reason == "" {
					result.Reason = "Hook 拒绝执行"
				}
				log.Printf("[Hook] 拒绝: %s (%s)", rule.Command, result.Reason)
			} else {
				result.Reason = strings.TrimSpace(stderr.String())
				log.Printf("[Hook] 执行错误 (code=%d): %s", code, result.Reason)
			}
		} else {
			result.Reason = err.Error()
			log.Printf("[Hook] 执行失败: %v", err)
		}
		return result
	}

	// 解析 stdout
	output := strings.TrimSpace(stdout.String())
	if output != "" {
		var hookResult HookResult
		if err := json.Unmarshal([]byte(output), &hookResult); err == nil {
			result = hookResult
		}
	}

	return result
}

// executeScript 执行 script 类型 Hook
func (m *HookManager) executeScript(rule HookRule, event HookEvent, scripts map[string]func(HookEvent) HookResult) HookResult {
	if rule.ScriptName == "" {
		return HookResult{Decision: DecisionApprove}
	}

	fn, ok := scripts[rule.ScriptName]
	if !ok {
		log.Printf("[Hook] 脚本未注册: %s", rule.ScriptName)
		return HookResult{Decision: DecisionApprove}
	}

	defer func() {
		if r := recover(); r != nil {
			log.Printf("[Hook] 脚本 panic: %s - %v", rule.ScriptName, r)
		}
	}()

	return fn(event)
}

// matchRule 判断规则是否匹配当前事件
func (m *HookManager) matchRule(rule HookRule, event HookEvent) bool {
	// 事件类型必须匹配
	if rule.Event != event.Event {
		return false
	}

	// 对于工具相关事件，检查 matcher
	if event.Event == EventPreToolUse || event.Event == EventPostToolUse {
		if rule.Matcher == "" || rule.Matcher == "*" {
			return true
		}
		return matchWildcard(event.ToolName, rule.Matcher)
	}

	return true
}

// matchWildcard 通配符匹配
func matchWildcard(name, pattern string) bool {
	// 前缀匹配（如 memory_*）
	if strings.HasSuffix(pattern, "*") {
		prefix := strings.TrimSuffix(pattern, "*")
		return strings.HasPrefix(name, prefix)
	}
	// 后缀匹配（如 *_add）
	if strings.HasPrefix(pattern, "*") {
		suffix := strings.TrimPrefix(pattern, "*")
		return strings.HasSuffix(name, suffix)
	}
	// 完全匹配
	return name == pattern
}
