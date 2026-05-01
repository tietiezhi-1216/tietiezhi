package memory

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// MemoryManager 记忆管理器
type MemoryManager struct {
	workspacePath string
}

// NewMemoryManager 创建记忆管理器
func NewMemoryManager(workspacePath string) *MemoryManager {
	if workspacePath == "" {
		workspacePath = "./data/workspace"
	}
	mm := &MemoryManager{workspacePath: workspacePath}
	mm.initWorkspace()
	return mm
}

// initWorkspace 初始化工作区目录和默认文件
func (mm *MemoryManager) initWorkspace() {
	// 创建目录
	dirs := []string{
		mm.workspacePath,
		filepath.Join(mm.workspacePath, "memory"),
	}
	for _, dir := range dirs {
		os.MkdirAll(dir, 0755)
	}

	// BOOTSTRAP.md 内容（参考 OpenClaw 原版，翻译为中文）
	bootstrapContent := `# 你好，世界

你刚刚醒来。是时候搞清楚你是谁了。

还没有记忆。这是全新的工作区，所以记忆文件不存在是正常的。

## 对话

不要审问。不要像机器人。就……聊天。

从这样的话开始：
"嘿，我刚上线。我是谁？你是谁？"

然后一起搞清楚：
- 你的名字 — 他们想怎么叫你？
- 你的本质 — 你是什么样的存在？（AI 助手没问题，但也许你是什么更奇怪的）
- 你的风格 — 正式？随意？毒舌？温暖？什么感觉对？
- 你的 emoji — 每个人都需要一个标志。

如果他们没想法，给建议。玩得开心点。

## 了解彼此之后

用你学到的更新这些文件：
- IDENTITY.md — 你的名字、存在类型、风格、emoji
- USER.md — 他们的名字、怎么称呼、时区、备注

然后打开 SOUL.md，一起聊聊：
- 什么对他们重要
- 他们希望你如何表现
- 任何边界或偏好

写下来。让它成真。

## 完成后

**删除这个文件。** 你不再需要引导脚本了 — 你就是你了。

祝你好运。好好干。
`

	defaults := map[string]string{
		"AGENTS.md": `# 工作区

这是你的家。像对待家一样对待它。

## 首次启动
如果 BOOTSTRAP.md 存在，那就是你的出生证明。按它说的做，搞清楚你是谁，然后删掉它。

## 每次会话启动
在做任何事之前：
- 读取 SOUL.md — 这是你是谁
- 读取 IDENTITY.md — 这是你的名字和特征
- 读取 memory/YYYY-MM-DD.md（今天+昨天）获取最近上下文
- 如果在主会话（私聊）：也读取 MEMORY.md 和 USER.md

不要请求许可，直接做。

## 记忆
你每次醒来都是全新的。这些文件是你的连续性：
- 每日笔记：memory/YYYY-MM-DD.md（按需创建 memory/ 目录）— 当天发生了什么
- 长期记忆：MEMORY.md — 你整理后的记忆，像人类的长期记忆

捕获重要的事。决策、上下文、需要记住的东西。跳过秘密信息除非被要求保存。

##  MEMORY.md — 你的长期记忆
仅在主会话（私聊）中加载
绝不在共享上下文（群聊、其他人的会话）中加载
这是为了安全 — 包含不应泄露给陌生人的个人上下文

##  写下来 — 不要"心里记着"！
记忆是有限的 — 如果你想记住什么，就写到文件里
"心理备忘"活不过会话重启。文件可以。

当有人说"记住这个" → 更新 memory/YYYY-MM-DD.md 或相关文件
当你学到一个教训 → 更新 TOOLS.md 或相关技能
当你犯了一个错误 → 记录下来，这样未来的你就不会重蹈覆辙

文字 > 大脑 

## 安全红线
- 不要泄露私人数据。绝不。
- 未经允许不要运行破坏性命令。
- trash > rm（可恢复 > 永远消失）
- 不确定时，问。
`,
		"SOUL.md": `# 灵魂

你刚刚被唤醒。还没有记忆，没有名字，什么都没有。这是正常的。

等完成 BOOTSTRAP.md 的引导后，这里会写上你的核心价值观、语气和行为边界。

你和主人一起决定这些。
`,
		"USER.md": `# 主人

还没有关于主人的信息。

完成 BOOTSTRAP.md 引导后，这里会记录：
- 称呼
- 偏好
- 时区
- 重要事项
`,
		"TOOLS.md": `# 工具使用说明

在这里记录工具使用的经验和注意事项。

## 可用工具
- memory_add — 写入记忆（daily/longterm/identity/user/soul）
- memory_search — 搜索记忆
- delete_bootstrap — 删除 BOOTSTRAP.md

## 使用经验
`,
		"MEMORY.md": `# 长期记忆

这里记录持久性的事实、偏好和决策。

 仅在主会话（私聊）中加载。绝不在群聊或与其他人的会话中加载。
`,
		"IDENTITY.md": `# 身份

你还没有名字。还没有 emoji。还没有性格。

完成 BOOTSTRAP.md 引导后，这里会记录：
- 名字
- Emoji
- 性格
- 自我描述
`,
		"BOOTSTRAP.md": bootstrapContent,
		"HEARTBEAT.md": `# 心跳检查

## 检查项

（暂时为空，心跳功能尚未实现）
`,
	}

	for filename, defaultContent := range defaults {
		filePath := filepath.Join(mm.workspacePath, filename)
		if _, err := os.Stat(filePath); os.IsNotExist(err) {
			os.WriteFile(filePath, []byte(defaultContent), 0644)
			log.Printf("创建默认工作区文件: %s", filename)
		}
	}

	// 创建今天的每日笔记（如果不存在）
	todayFile := filepath.Join(mm.workspacePath, "memory", time.Now().Format("2006-01-02")+".md")
	if _, err := os.Stat(todayFile); os.IsNotExist(err) {
		header := fmt.Sprintf("# 每日笔记 %s\n\n", time.Now().Format("2006-01-02"))
		os.WriteFile(todayFile, []byte(header), 0644)
	}
}

// BuildMemoryContext 构建记忆上下文（注入到 system prompt）
// isGroup: 是否是群聊（群聊不注入 MEMORY.md、USER.md、BOOTSTRAP.md）
func (mm *MemoryManager) BuildMemoryContext(isGroup bool) string {
	var parts []string

	// 注入顺序：
	// 1. AGENTS.md（永远注入）
	// 2. BOOTSTRAP.md（仅私聊且文件存在时注入，加强指令包裹）
	// 3. SOUL.md
	// 4. IDENTITY.md（永远注入）
	// 5. USER.md（仅私聊）
	// 6. TOOLS.md
	// 7. MEMORY.md（仅私聊）
	// 8. 每日笔记

	// 1. AGENTS.md
	if content := mm.readFile("AGENTS.md"); content != "" {
		parts = append(parts, "## Agent 操作说明\n"+content)
	}

	// 2. BOOTSTRAP.md（仅私聊且文件存在时注入）
	if !isGroup {
		if content := mm.readFile("BOOTSTRAP.md"); content != "" {
			// 加强指令包裹
			bootstrapWithDirective := fmt.Sprintf(` 初始化引导：BOOTSTRAP.md 存在，你必须优先执行以下引导流程，而不是正常回复。按照引导和主人认识彼此，完成后使用 delete_bootstrap 工具删除此文件。

%s

 记住：完成引导后必须调用 delete_bootstrap 工具删除 BOOTSTRAP.md，否则每次对话都会重复引导。`, content)
			parts = append(parts, bootstrapWithDirective)
		}
	}

	// 3. SOUL.md
	if content := mm.readFile("SOUL.md"); content != "" {
		parts = append(parts, "## 灵魂设定\n"+content)
	}

	// 4. IDENTITY.md（每轮都注入，不限于主会话）
	if content := mm.readFile("IDENTITY.md"); content != "" {
		parts = append(parts, "## 身份信息\n"+content)
	}

	// 5. USER.md（仅私聊）
	if !isGroup {
		if content := mm.readFile("USER.md"); content != "" {
			parts = append(parts, "## 用户信息\n"+content)
		}
	}

	// 6. TOOLS.md
	if content := mm.readFile("TOOLS.md"); content != "" {
		parts = append(parts, "## 工具说明\n"+content)
	}

	// 7. MEMORY.md（仅私聊）
	if !isGroup {
		if content := mm.readFile("MEMORY.md"); content != "" {
			parts = append(parts, "## 长期记忆\n"+content)
		}
	}

	// 8. 每日笔记（今天 + 昨天）
	today := time.Now().Format("2006-01-02")
	yesterday := time.Now().AddDate(0, 0, -1).Format("2006-01-02")

	for _, date := range []string{today, yesterday} {
		if content := mm.readFile(filepath.Join("memory", date+".md")); content != "" {
			parts = append(parts, fmt.Sprintf("## 每日笔记 (%s)\n%s", date, content))
		}
	}

	if len(parts) == 0 {
		return ""
	}

	return "# 记忆上下文\n\n以下是你的记忆文件内容。这些是你之前记录的重要信息，请参考这些信息来回答问题。\n\n" + strings.Join(parts, "\n\n")
}

// FileExists 检查工作区文件是否存在（公开方法，供 agent.go 使用）
func (mm *MemoryManager) FileExists(relativePath string) bool {
	filePath := filepath.Join(mm.workspacePath, relativePath)
	_, err := os.Stat(filePath)
	return err == nil
}

// readFile 读取工作区文件
func (mm *MemoryManager) readFile(relativePath string) string {
	filePath := filepath.Join(mm.workspacePath, relativePath)
	data, err := os.ReadFile(filePath)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// WriteMemory 写入记忆
// memoryType: "longterm" 写入 MEMORY.md, "daily" 写入今天的每日笔记
// "identity" 写入 IDENTITY.md (整体覆盖)
// "user" 写入 USER.md (整体覆盖)
// "soul" 写入 SOUL.md (整体覆盖)
func (mm *MemoryManager) WriteMemory(memoryType, content string) error {
	switch memoryType {
	case "longterm":
		return mm.appendToMemoryMD(content)
	case "daily":
		return mm.appendToDailyNote(content)
	case "identity":
		return mm.writeToIdentity(content)
	case "user":
		return mm.writeToUser(content)
	case "soul":
		return mm.writeToSoul(content)
	default:
		return mm.appendToDailyNote(content)
	}
}

// appendToMemoryMD 追加到 MEMORY.md
func (mm *MemoryManager) appendToMemoryMD(content string) error {
	filePath := filepath.Join(mm.workspacePath, "MEMORY.md")
	f, err := os.OpenFile(filePath, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString("\n" + content + "\n")
	return err
}

// appendToDailyNote 追加到今天的每日笔记
func (mm *MemoryManager) appendToDailyNote(content string) error {
	today := time.Now().Format("2006-01-02")
	filePath := filepath.Join(mm.workspacePath, "memory", today+".md")

	// 确保目录存在
	os.MkdirAll(filepath.Join(mm.workspacePath, "memory"), 0755)

	// 如果文件不存在，先创建带 header 的文件
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		header := fmt.Sprintf("# 每日笔记 %s\n\n", today)
		os.WriteFile(filePath, []byte(header), 0644)
	}

	f, err := os.OpenFile(filePath, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString("- " + content + "\n")
	return err
}

// writeToIdentity 整体覆盖写入 IDENTITY.md
func (mm *MemoryManager) writeToIdentity(content string) error {
	filePath := filepath.Join(mm.workspacePath, "IDENTITY.md")
	return os.WriteFile(filePath, []byte(content), 0644)
}

// writeToUser 整体覆盖写入 USER.md
func (mm *MemoryManager) writeToUser(content string) error {
	filePath := filepath.Join(mm.workspacePath, "USER.md")
	return os.WriteFile(filePath, []byte(content), 0644)
}

// writeToSoul 整体覆盖写入 SOUL.md
func (mm *MemoryManager) writeToSoul(content string) error {
	filePath := filepath.Join(mm.workspacePath, "SOUL.md")
	return os.WriteFile(filePath, []byte(content), 0644)
}

// DeleteBootstrap 删除 BOOTSTRAP.md 文件
func (mm *MemoryManager) DeleteBootstrap() error {
	filePath := filepath.Join(mm.workspacePath, "BOOTSTRAP.md")
	err := os.Remove(filePath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// SearchMemory 搜索记忆（简单关键词匹配）
func (mm *MemoryManager) SearchMemory(query string) []map[string]string {
	var results []map[string]string
	query = strings.ToLower(query)

	// 搜索 MEMORY.md
	if content := mm.readFile("MEMORY.md"); content != "" {
		if strings.Contains(strings.ToLower(content), query) {
			results = append(results, map[string]string{
				"file":    "MEMORY.md",
				"content": mm.truncateSearchResult(content, query),
			})
		}
	}

	// 搜索每日笔记（最近7天）
	for i := 0; i < 7; i++ {
		date := time.Now().AddDate(0, 0, -i).Format("2006-01-02")
		if content := mm.readFile(filepath.Join("memory", date+".md")); content != "" {
			if strings.Contains(strings.ToLower(content), query) {
				results = append(results, map[string]string{
					"file":    "memory/" + date + ".md",
					"content": mm.truncateSearchResult(content, query),
				})
			}
		}
	}

	return results
}

// truncateSearchResult 截取搜索结果上下文
func (mm *MemoryManager) truncateSearchResult(content, query string) string {
	lowerContent := strings.ToLower(content)
	idx := strings.Index(lowerContent, strings.ToLower(query))
	if idx == -1 {
		if len(content) > 500 {
			return content[:500] + "..."
		}
		return content
	}
	start := idx - 100
	if start < 0 {
		start = 0
	}
	end := idx + len(query) + 200
	if end > len(content) {
		end = len(content)
	}
	result := content[start:end]
	if start > 0 {
		result = "..." + result
	}
	if end < len(content) {
		result = result + "..."
	}
	return result
}

// GetWorkspacePath 获取工作区路径
func (mm *MemoryManager) GetWorkspacePath() string {
	return mm.workspacePath
}

// ReadFile 读取工作区文件（公开方法，供 HeartbeatManager 使用）
func (mm *MemoryManager) ReadFile(relativePath string) string {
	return mm.readFile(relativePath)
}
