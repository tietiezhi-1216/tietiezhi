package hook

import "time"

// 事件类型常量
const (
	EventPreToolUse   = "pre_tool_use"
	EventPostToolUse  = "post_tool_use"
	EventSessionStart = "session_start"
	EventSessionEnd   = "session_end"
	EventMessageIn    = "message_in"
	EventMessageOut   = "message_out"
)

// HookRule 一条 Hook 规则
type HookRule struct {
	Event      string `yaml:"event"`                // 事件类型
	Matcher    string `yaml:"matcher,omitempty"`   // 工具名匹配（pre/post_tool_use 专用）
	Type       string `yaml:"type"`                // command / script
	Command    string `yaml:"command,omitempty"`   // type=command 时的命令
	ScriptName string `yaml:"name,omitempty"`      // type=script 时的脚本名
	Timeout    int    `yaml:"timeout,omitempty"`   // 超时秒数，默认5
}

// HookEvent 事件数据（传给 handler 的 JSON）
type HookEvent struct {
	Event      string                 `json:"event"`
	SessionKey string                 `json:"session_key"`
	Timestamp  string                 `json:"timestamp"`
	// PreToolUse / PostToolUse 专用
	ToolName   string                 `json:"tool_name,omitempty"`
	ToolInput  map[string]interface{} `json:"tool_input,omitempty"`
	ToolOutput string                 `json:"tool_output,omitempty"`
	// MessageIn / MessageOut 专用
	Message string `json:"message,omitempty"`
	// 额外上下文
	Context map[string]interface{} `json:"context,omitempty"`
}

// HookResult Hook 执行结果
type HookResult struct {
	Decision          string                 `json:"decision"`                     // approve / deny / modify
	Reason            string                 `json:"reason,omitempty"`
	UpdatedInput      map[string]interface{} `json:"updated_input,omitempty"`
	AdditionalContext string                 `json:"additional_context,omitempty"`
}

// NewHookEvent 创建 HookEvent
func NewHookEvent(event, sessionKey string) HookEvent {
	return HookEvent{
		Event:      event,
		SessionKey: sessionKey,
		Timestamp:  time.Now().Format(time.RFC3339),
	}
}

// Decision 常量
const (
	DecisionApprove = "approve"
	DecisionDeny    = "deny"
	DecisionModify  = "modify"
)

// Type 常量
const (
	TypeCommand = "command"
	TypeScript  = "script"
)
