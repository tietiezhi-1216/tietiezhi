package builtin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"tietiezhi/internal/sandbox"
	"tietiezhi/internal/tool"
)

// TerminalTool 终端执行工具
type TerminalTool struct {
	blockedCmds   []string
	sandboxMgr    *sandbox.SandboxManager
	defaultUseSandbox bool // 默认是否使用沙箱
}

// NewTerminalTool 创建终端执行工具
func NewTerminalTool(blockedCmds ...string) *TerminalTool {
	return &TerminalTool{
		blockedCmds: blockedCmds,
	}
}

// NewTerminalToolWithSandbox 创建带沙箱的终端执行工具
func NewTerminalToolWithSandbox(sandboxMgr *sandbox.SandboxManager, defaultUseSandbox bool, blockedCmds ...string) *TerminalTool {
	return &TerminalTool{
		blockedCmds:         blockedCmds,
		sandboxMgr:          sandboxMgr,
		defaultUseSandbox:   defaultUseSandbox,
	}
}

// Name 返回工具名称
func (t *TerminalTool) Name() string {
	return "terminal_exec"
}

// Description 返回工具描述
func (t *TerminalTool) Description() string {
	sandboxDesc := ""
	if t.sandboxMgr != nil && t.sandboxMgr.IsEnabled() {
		sandboxDesc = "\n- use_sandbox: 是否使用沙箱执行（可选，默认跟随全局配置）\n- sandbox_config: 沙箱配置（可选）\n  - image: 沙箱镜像\n  - network: 网络模式（none/bridge）\n  - memory: 内存限制"
	}
	return `执行 Shell 命令，返回 stdout 和 stderr。
⚠️ 危险命令提醒：rm -rf /, mkfs, dd 等命令会永久损坏系统，请勿执行。
参数：
- command: 要执行的命令（必填）
- timeout: 超时时间秒数（可选，默认30）
- workdir: 工作目录（可选）` + sandboxDesc + `
返回：{"stdout": "...", "stderr": "...", "exit_code": 0, "error": ""}`
}

// Parameters 返回参数定义
func (t *TerminalTool) Parameters() any {
	props := map[string]any{
		"command": map[string]any{
			"type":        "string",
			"description": "要执行的 Shell 命令",
		},
		"timeout": map[string]any{
			"type":        "integer",
			"description": "超时时间（秒），默认30",
		},
		"workdir": map[string]any{
			"type":        "string",
			"description": "工作目录路径（可选）",
		},
	}

	// 如果沙箱启用，添加沙箱参数
	if t.sandboxMgr != nil && t.sandboxMgr.IsEnabled() {
		props["use_sandbox"] = map[string]any{
			"type":        "boolean",
			"description": "是否使用沙箱执行（可选，默认跟随全局配置）",
		}
		props["sandbox_config"] = map[string]any{
			"type": "object",
			"description": "沙箱配置（可选）",
			"properties": map[string]any{
				"image": map[string]any{
					"type":        "string",
					"description": "沙箱镜像",
				},
				"network": map[string]any{
					"type":        "string",
					"description": "网络模式（none/bridge）",
				},
				"memory": map[string]any{
					"type":        "string",
					"description": "内存限制",
				},
			},
		}
	}

	return map[string]any{
		"type":       "object",
		"properties": props,
		"required":   []string{"command"},
	}
}

// Execute 执行命令
func (t *TerminalTool) Execute(input map[string]any) (string, error) {
	command, cmdOk := input["command"].(string)
	if !cmdOk || command == "" {
		return "", fmt.Errorf("command 参数必填")
	}

	// 检查危险命令
	if blocked := t.isBlockedCmd(command); blocked != "" {
		result, _ := json.Marshal(map[string]any{
			"stdout":   "",
			"stderr":   fmt.Sprintf("⚠️ 命令被拦截：%s 是危险命令", command),
			"exit_code": -1,
			"error":    "blocked command",
		})
		return string(result), nil
	}

	// 解析超时
	timeout := 30
	if timeoutVal, ok := input["timeout"].(float64); ok {
		timeout = int(timeoutVal)
	}

	// 解析工作目录
	workdir := ""
	if wd, ok := input["workdir"].(string); ok {
		workdir = wd
	}

	// 判断是否使用沙箱
	useSandbox := t.defaultUseSandbox
	if useSandboxVal, ok := input["use_sandbox"]; ok {
		useSandbox = useSandboxVal == true || useSandboxVal == "true"
	}

	// 如果启用沙箱且沙箱管理器可用，优先使用沙箱
	if useSandbox && t.sandboxMgr != nil && t.sandboxMgr.IsEnabled() {
		return t.executeInSandbox(command, workdir, timeout, input)
	}

	// 否则直接在宿主机执行
	return t.executeDirect(command, workdir, timeout)
}

// executeInSandbox 在沙箱中执行命令
func (t *TerminalTool) executeInSandbox(command, workdir string, timeout int, input map[string]any) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
	defer cancel()

	// 获取沙箱实例
	sb := t.sandboxMgr.GetSandbox()
	if sb == nil {
		return t.executeDirect(command, workdir, timeout)
	}

	// 如果有自定义配置，创建临时沙箱
	if sandboxConfig, ok := input["sandbox_config"].(map[string]any); ok {
		customSandbox := t.createCustomSandbox(sandboxConfig)
		if customSandbox != nil {
			customSandbox.SetTimeout(timeout)
			result, err := customSandbox.Execute(ctx, command, workdir)
			if err != nil {
				// 沙箱执行失败，回退到直接执行
				return t.executeDirect(command, workdir, timeout)
			}
			return result.ToJSON(), nil
		}
	}

	// 使用默认沙箱
	sb.SetTimeout(timeout)
	result, err := sb.Execute(ctx, command, workdir)
	if err != nil {
		// 沙箱执行失败，回退到直接执行
		return t.executeDirect(command, workdir, timeout)
	}
	return result.ToJSON(), nil
}

// createCustomSandbox 根据配置创建自定义沙箱
func (t *TerminalTool) createCustomSandbox(config map[string]any) *sandbox.DockerSandbox {
	image := ""
	if img, ok := config["image"].(string); ok {
		image = img
	}

	network := ""
	if net, ok := config["network"].(string); ok {
		network = net
	}

	memory := ""
	if mem, ok := config["memory"].(string); ok {
		memory = mem
	}

	return sandbox.NewDockerSandbox(image, "", memory, network, 0, nil)
}

// executeDirect 直接在宿主机执行命令
func (t *TerminalTool) executeDirect(command, workdir string, timeout int) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
	defer cancel()

	// 构建命令
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", command)
	if workdir != "" {
		cmd.Dir = workdir
	}

	// 执行命令
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	// 构建结果
	result := map[string]any{
		"stdout":    stdout.String(),
		"stderr":    stderr.String(),
		"exit_code": 0,
		"error":     "",
	}

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			result["exit_code"] = -1
			result["error"] = fmt.Sprintf("命令执行超时（%d秒）", timeout)
		} else {
			if exitErr, ok := err.(*exec.ExitError); ok {
				result["exit_code"] = exitErr.ExitCode()
			} else {
				result["exit_code"] = -1
				result["error"] = err.Error()
			}
		}
	}

	resultJSON, _ := json.Marshal(result)
	return string(resultJSON), nil
}

// isBlockedCmd 检查是否包含危险命令，返回被拦截的命令名称或空字符串
func (t *TerminalTool) isBlockedCmd(command string) string {
	blocked := []string{
		"rm -rf /",
		"rm -rf /*",
		"mkfs",
		"dd if=/dev/zero",
		":(){ :|:& };:", // Fork bomb
	}

	lowerCmd := strings.ToLower(command)
	for _, blockedCmd := range blocked {
		if strings.Contains(lowerCmd, strings.ToLower(blockedCmd)) {
			return blockedCmd
		}
	}

	// 检查用户自定义的 blockedCmds
	for _, blockedCmd := range t.blockedCmds {
		if strings.Contains(lowerCmd, strings.ToLower(blockedCmd)) {
			return blockedCmd
		}
	}

	return ""
}

// 确保实现 tool.Tool 接口
var _ tool.Tool = (*TerminalTool)(nil)
