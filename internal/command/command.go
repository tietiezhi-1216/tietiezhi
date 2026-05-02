package command

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// Command 聊天命令
type Command struct {
	Name        string
	Description string
	Handler     func(ctx context.Context, sessionKey string, args []string) string
}

// Registry 命令注册表
type Registry struct {
	commands map[string]*Command
	mu       sync.RWMutex
}

// NewRegistry 创建命令注册表
func NewRegistry() *Registry {
	r := &Registry{
		commands: make(map[string]*Command),
	}
	// 注册默认命令
	r.registerDefaults()
	return r
}

// registerDefaults 注册默认命令
func (r *Registry) registerDefaults() {
	// /new — 清空当前会话
	r.Register(&Command{
		Name:        "new",
		Description: "清空当前会话历史",
		Handler: func(ctx context.Context, sessionKey string, args []string) string {
			return "🔄 会话已清空，开始新对话吧！"
		},
	})

	// /help — 显示帮助
	r.Register(&Command{
		Name:        "help",
		Description: "显示帮助信息",
		Handler: func(ctx context.Context, sessionKey string, args []string) string {
			return `🤖 **tietiezhi 助手**

可用命令：
• /new — 清空当前会话
• /help — 显示帮助
• /status — 显示系统状态
• /skills — 列出可用技能
• /sessions — 列出活跃会话
• /compact — 手动触发上下文压缩`
		},
	})

	// /status — 显示系统状态（默认实现，需要外部注入）
	r.Register(&Command{
		Name:        "status",
		Description: "显示系统状态",
		Handler: func(ctx context.Context, sessionKey string, args []string) string {
			return "📊 系统状态：运行正常"
		},
	})

	// /skills — 列出可用技能（默认实现，需要外部注入）
	r.Register(&Command{
		Name:        "skills",
		Description: "列出可用技能",
		Handler: func(ctx context.Context, sessionKey string, args []string) string {
			return "🛠️ 技能列表：暂无"
		},
	})

	// /sessions — 列出活跃会话（默认实现，需要外部注入）
	r.Register(&Command{
		Name:        "sessions",
		Description: "列出活跃会话",
		Handler: func(ctx context.Context, sessionKey string, args []string) string {
			return "💬 活跃会话：暂无"
		},
	})

	// /compact — 手动触发上下文压缩（默认实现，需要外部注入）
	r.Register(&Command{
		Name:        "compact",
		Description: "手动触发上下文压缩",
		Handler: func(ctx context.Context, sessionKey string, args []string) string {
			return "📦 上下文压缩已触发"
		},
	})
}

// Register 注册命令
func (r *Registry) Register(cmd *Command) {
	r.mu.Lock()
	defer r.mu.Unlock()
	// 命令名统一小写
	r.commands[strings.ToLower(cmd.Name)] = cmd
}

// Unregister 注销命令
func (r *Registry) Unregister(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.commands, strings.ToLower(name))
}

// Get 获取命令
func (r *Registry) Get(name string) (*Command, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	cmd, ok := r.commands[strings.ToLower(name)]
	return cmd, ok
}

// Execute 执行命令
func (r *Registry) Execute(ctx context.Context, name string, sessionKey string, args []string) string {
	cmd, ok := r.Get(name)
	if !ok {
		return fmt.Sprintf("❓ 未知命令：/%s", name)
	}
	return cmd.Handler(ctx, sessionKey, args)
}

// ListCommands 列出所有命令
func (r *Registry) ListCommands() []*Command {
	r.mu.RLock()
	defer r.mu.RUnlock()

	cmds := make([]*Command, 0, len(r.commands))
	for _, cmd := range r.commands {
		cmds = append(cmds, cmd)
	}
	return cmds
}

// CommandHandler 命令处理函数类型
type CommandHandler func(ctx context.Context, sessionKey string, args []string) string

// NewSimpleCommand 创建简单命令（用于外部注入）
func NewSimpleCommand(name, description string, handler CommandHandler) *Command {
	return &Command{
		Name:        name,
		Description: description,
		Handler:     handler,
	}
}
