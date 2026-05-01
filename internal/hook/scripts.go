package hook

// BuiltinScripts 内置脚本注册表
var BuiltinScripts = map[string]func(HookEvent) HookResult{
	// 示例脚本，可以按需添加更多
}

// RegisterBuiltinScripts 注册所有内置脚本到 HookManager
func RegisterBuiltinScripts(m *HookManager) {
	for name, fn := range BuiltinScripts {
		m.RegisterScript(name, fn)
	}
}
