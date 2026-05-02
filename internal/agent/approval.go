package agent

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"tietiezhi/internal/config"
)

// ApprovalRequest 审批请求
type ApprovalRequest struct {
	SessionKey string                 // 会话 Key
	ToolName   string                 // 工具名称
	Args       map[string]interface{}  // 工具参数
	Reason     string                 // 审批原因
	RequestedAt time.Time             // 请求时间
	Approved   bool                   // 是否已批准
	ApprovedAt *time.Time             // 批准时间
	ApprovedBy string                 // 批准人（由用户在回复中提供）
}

// ApprovalManager 审批管理器
// 管理需要审批的工具调用，追踪审批状态
type ApprovalManager struct {
	mu              sync.RWMutex
	config          *config.ApprovalConfig
	pendingRequests map[string]*ApprovalRequest // 待审批请求（key: sessionToolKey）
	autoApproveTools map[string]bool           // 自动放行的工具集合
	requireApprovalTools map[string]bool         // 需要审批的工具集合
}

// NewApprovalManager 创建审批管理器
func NewApprovalManager(cfg *config.ApprovalConfig) *ApprovalManager {
	if cfg == nil {
		cfg = &config.ApprovalConfig{
			Enabled:         false,
			RequireApproval: []string{},
			AutoApprove:     []string{},
		}
	}

	// 构建工具集合
	autoApprove := make(map[string]bool)
	requireApproval := make(map[string]bool)

	for _, tool := range cfg.AutoApprove {
		autoApprove[tool] = true
	}
	for _, tool := range cfg.RequireApproval {
		requireApproval[tool] = true
	}

	return &ApprovalManager{
		config:               cfg,
		pendingRequests:      make(map[string]*ApprovalRequest),
		autoApproveTools:     autoApprove,
		requireApprovalTools: requireApproval,
	}
}

// IsEnabled 返回审批功能是否启用
func (a *ApprovalManager) IsEnabled() bool {
	return a.config != nil && a.config.Enabled
}

// NeedsApproval 检查工具是否需要审批
func (a *ApprovalManager) NeedsApproval(toolName string) bool {
	if !a.IsEnabled() {
		return false
	}
	
	// 检查是否在需要审批的列表中
	_, needs := a.requireApprovalTools[toolName]
	return needs
}

// IsAutoApproved 检查工具是否自动放行
func (a *ApprovalManager) IsAutoApproved(toolName string) bool {
	if !a.IsEnabled() {
		return true
	}
	_, approved := a.autoApproveTools[toolName]
	return approved
}

// buildRequestKey 构建请求唯一键
func (a *ApprovalManager) buildRequestKey(sessionKey, toolName string) string {
	return fmt.Sprintf("%s:%s:%d", sessionKey, toolName, time.Now().Unix())
}

// RequestApproval 请求审批
// 返回审批请求的详细信息，Agent 需要将这些信息展示给用户
func (a *ApprovalManager) RequestApproval(sessionKey, toolName string, args map[string]interface{}) *ApprovalRequest {
	a.mu.Lock()
	defer a.mu.Unlock()

	req := &ApprovalRequest{
		SessionKey:  sessionKey,
		ToolName:    toolName,
		Args:        args,
		Reason:      a.buildReason(toolName, args),
		RequestedAt: time.Now(),
		Approved:    false,
	}

	key := a.buildRequestKey(sessionKey, toolName)
	a.pendingRequests[key] = req

	return req
}

// IsApproved 检查工具是否已获得批准
func (a *ApprovalManager) IsApproved(sessionKey, toolName string) bool {
	if !a.IsEnabled() {
		return true
	}

	// 检查自动放行列表
	if a.IsAutoApproved(toolName) {
		return true
	}

	a.mu.RLock()
	defer a.mu.RUnlock()

	// 查找该会话中该工具的最近审批状态
	// 这里简化处理：只检查是否存在待审批请求
	for _, req := range a.pendingRequests {
		if req.SessionKey == sessionKey && req.ToolName == toolName {
			return req.Approved
		}
	}

	// 没有审批记录，默认不批准（需要显式确认）
	return false
}

// Approve 批准请求
func (a *ApprovalManager) Approve(sessionKey, toolName string, approvedBy string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()

	// 查找并批准
	for key, req := range a.pendingRequests {
		if req.SessionKey == sessionKey && req.ToolName == toolName && !req.Approved {
			now := time.Now()
			req.Approved = true
			req.ApprovedAt = &now
			req.ApprovedBy = approvedBy
			delete(a.pendingRequests, key)
			return true
		}
	}

	return false
}

// Deny 拒绝请求
func (a *ApprovalManager) Deny(sessionKey, toolName string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()

	for key, req := range a.pendingRequests {
		if req.SessionKey == sessionKey && req.ToolName == toolName {
			delete(a.pendingRequests, key)
			return true
		}
	}

	return false
}

// GetPendingRequests 获取待审批请求
func (a *ApprovalManager) GetPendingRequests(sessionKey string) []*ApprovalRequest {
	a.mu.RLock()
	defer a.mu.RUnlock()

	var requests []*ApprovalRequest
	for _, req := range a.pendingRequests {
		if req.SessionKey == sessionKey {
			requests = append(requests, req)
		}
	}

	return requests
}

// ClearSessionRequests 清除会话的所有审批请求
func (a *ApprovalManager) ClearSessionRequests(sessionKey string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	for key, req := range a.pendingRequests {
		if req.SessionKey == sessionKey {
			delete(a.pendingRequests, key)
		}
	}
}

// BuildApprovalMessage 构建审批请求消息
// 返回一个 JSON 字符串，包含需要用户确认的信息
func (a *ApprovalManager) BuildApprovalMessage(req *ApprovalRequest) string {
	approvalMsg := map[string]interface{}{
		"needs_approval": true,
		"message":        fmt.Sprintf("⚠️ 执行 %s 需要您确认", req.ToolName),
		"tool_name":      req.ToolName,
		"reason":         req.Reason,
		"args":           req.Args,
		"instruction":    fmt.Sprintf("请回复\"确认执行 %s\"或\"取消\"来响应此请求", req.ToolName),
	}

	data, err := json.Marshal(approvalMsg)
	if err != nil {
		return fmt.Sprintf(`{"needs_approval": true, "message": "执行 %s 需要您确认", "error": "failed to build approval message"}`, req.ToolName)
	}

	return string(data)
}

// buildReason 构建审批原因描述
func (a *ApprovalManager) buildReason(toolName string, args map[string]interface{}) string {
	switch toolName {
	case "terminal_exec":
		// 检查是否包含危险命令
		cmd, _ := args["command"].(string)
		if cmd != "" {
			if isDangerousCommand(cmd) {
				return fmt.Sprintf("执行终端命令（检测到潜在危险操作）：%s", truncateString(cmd, 100))
			}
			return fmt.Sprintf("执行终端命令：%s", truncateString(cmd, 100))
		}
		return "执行终端命令"

	case "file_write", "file_create", "file_edit":
		path, _ := args["path"].(string)
		return fmt.Sprintf("写入/编辑文件：%s", path)

	case "file_delete", "delete_file":
		path, _ := args["path"].(string)
		return fmt.Sprintf("删除文件：%s", path)

	case "agent_spawn":
		return "创建子代理任务"

	default:
		return fmt.Sprintf("执行工具：%s", toolName)
	}
}

// isDangerousCommand 检查命令是否危险
func isDangerousCommand(cmd string) bool {
	dangerous := []string{
		"rm -rf",
		"rm /",
		"dd if=",
		":(){:|:&};:",  // fork bomb
		"chmod -R 777",
		"mkfs",
		"shutdown",
		"reboot",
		"init 0",
	}

	lowerCmd := cmd
	for i := 0; i < len(lowerCmd); i++ {
		c := lowerCmd[i]
		if c >= 'A' && c <= 'Z' {
			lowerCmd = lowerCmd[:i] + string(c+'a'-'A') + lowerCmd[i+1:]
		}
	}

	for _, d := range dangerous {
		if len(lowerCmd) >= len(d) && containsString(lowerCmd, d) {
			return true
		}
	}

	return false
}

// containsString 检查字符串是否包含子串
func containsString(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// truncateString 截断字符串
func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
