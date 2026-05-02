package builtin

import (
	"tietiezhi/internal/config"
	"tietiezhi/internal/llm"
	"tietiezhi/internal/sandbox"
	"tietiezhi/internal/tool"
)

// RegisterBuiltinTools 注册所有内置工具到 Registry
func RegisterBuiltinTools(registry *tool.Registry, workspacePath string, allowedDirs []string, blockedCmds []string, searchConfig *SearchConfig, sandboxConfig *config.SandboxConfig) {
	// 创建沙箱管理器
	sandboxMgr := NewSandboxManagerFromConfig(sandboxConfig)

	// 终端执行工具（带沙箱支持）
	terminalTool := NewTerminalToolWithSandbox(sandboxMgr, sandboxConfig.Enabled, blockedCmds...)
	registry.Register(terminalTool)

	// 文件读取工具
	fileReadTool := NewFileReadTool(allowedDirs...)
	if workspacePath != "" {
		fileReadTool = NewFileReadTool(workspacePath)
	}
	registry.Register(fileReadTool)

	// 文件写入工具
	fileWriteTool := NewFileWriteTool(allowedDirs...)
	if workspacePath != "" {
		fileWriteTool = NewFileWriteTool(workspacePath)
	}
	registry.Register(fileWriteTool)

	// 网页搜索工具
	registry.Register(NewWebSearchTool(searchConfig))

	// 网页获取工具
	registry.Register(NewWebFetchTool())
}

// GetBuiltinToolDefs 获取所有内置工具的 LLM ToolDef 列表
func GetBuiltinToolDefs(registry *tool.Registry) []llm.ToolDef {
	var toolDefs []llm.ToolDef

	// 从注册表获取所有内置工具并转换为 ToolDef
	for _, t := range registry.List() {
		toolDefs = append(toolDefs, llm.ToolDef{
			Type: "function",
			Function: llm.FunctionDef{
				Name:        t.Name(),
				Description: t.Description(),
				Parameters:  t.Parameters(),
			},
		})
	}

	return toolDefs
}

// GetBuiltinToolDefsByNames 根据名称列表获取内置工具的 ToolDef
func GetBuiltinToolDefsByNames(registry *tool.Registry, names []string) []llm.ToolDef {
	nameSet := make(map[string]bool)
	for _, name := range names {
		nameSet[name] = true
	}

	var toolDefs []llm.ToolDef
	for _, t := range registry.List() {
		if nameSet[t.Name()] {
			toolDefs = append(toolDefs, llm.ToolDef{
				Type: "function",
				Function: llm.FunctionDef{
					Name:        t.Name(),
					Description: t.Description(),
					Parameters:  t.Parameters(),
				},
			})
		}
	}

	return toolDefs
}

// NewSandboxManagerFromConfig 从配置创建沙箱管理器
func NewSandboxManagerFromConfig(cfg *config.SandboxConfig) *sandbox.SandboxManager {
	if cfg == nil || !cfg.Enabled {
		return sandbox.NewSandboxManager(false, nil)
	}

	// 转换配置
	sandboxConfig := &sandbox.SandboxConfig{
		Enabled:     cfg.Enabled,
		Image:       cfg.Image,
		NetworkMode: cfg.NetworkMode,
		MemoryLimit: cfg.MemoryLimit,
		CPULimit:    cfg.CPULimit,
		WorkDir:     cfg.WorkDir,
	}

	// 转换卷挂载
	for _, v := range cfg.Volumes {
		sandboxConfig.Volumes = append(sandboxConfig.Volumes, sandbox.VolumeMountConfig{
			HostPath:      v.HostPath,
			ContainerPath: v.ContainerPath,
			ReadOnly:      v.ReadOnly,
		})
	}

	return sandbox.NewSandboxManager(true, sandboxConfig)
}
