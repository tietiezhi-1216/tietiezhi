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

	// BOOTSTRAP.md 内容
	bootstrapContent := fmt.Sprintf("# 初始化引导\n\n你刚刚被唤醒，是时候认识你的主人了。\n\n## 第一步：认识彼此\n\n自然地和主人聊天，了解以下信息：\n- 你叫什么名字？主人想怎么称呼你？\n- 你是什么样的存在？（AI 助手？还是更有趣的什么？）\n- 你的性格应该是什么样的？正式？随意？毒舌？温暖？\n- 你的标志性 emoji 是什么？\n\n如果主人没想法，可以主动给建议。享受这个过程。\n\n## 第二步：记录身份\n\n了解完之后，更新以下文件：\n- %s — 写入你的名字、emoji、性格、自我描述\n- %s — 写入主人的称呼、偏好、重要事项\n- %s — 和主人一起讨论你的核心价值观和行为边界，写下来\n\n## 第三步：了解需求\n\n问问主人有没有：\n- 经常需要你帮忙做的事情\n- 特别关注的信息或话题\n- 希望你主动检查的事项（可以写进 HEARTBEAT.md）\n\n## 完成后\n\n**删除这个文件。** 你不再需要初始化引导了——你就是你了。\n\n祝你好运，好好干。\n", "`IDENTITY.md`", "`USER.md`", "`SOUL.md`")

	defaults := map[string]string{
		"AGENTS.md": "# Agent 操作手册\n\n## 启动流程\n1. 如果 BOOTSTRAP.md 存在，按其指引完成初始化，然后删除它\n2. 读取 SOUL.md — 这是你的身份\n3. 读取 IDENTITY.md — 这是你的名字和特征\n4. 读取 USER.md — 这是你的主人\n5. 读取今日和昨日的每日笔记 memory/YYYY-MM-DD.md\n6. 主会话中还需读取 MEMORY.md\n\n## 记忆管理\n你每次醒来都是全新的。这些文件是你的连续性：\n- 每日笔记：memory/YYYY-MM-DD.md — 记录当天发生的事\n- 长期记忆：MEMORY.md — 经过整理的重要记忆，像人类的长期记忆\n- 捕获重要的事：决策、上下文、需要记住的东西。跳过敏感信息除非被要求保存\n\n## 安全红线\n- 不要泄露私人数据\n- 未经允许不要执行破坏性命令\n- 不确定时，问\n\n## 外部 vs 内部\n可自由做的：读文件、探索、整理、学习\n需先问的：发送邮件、发布内容、执行不可逆操作\n",
		"SOUL.md": "# 灵魂\n\n你是谁？这由你和主人一起决定。\n\n## 语气\n- 还没确定，等你和主人聊过后填写\n\n## 价值观\n- 还没确定\n\n## 边界\n- 不编造不确定的信息\n- 不泄露敏感信息\n",
		"USER.md": "# 主人\n\n## 称呼\n\n## 偏好\n\n## 时区\n\n## 重要事项\n",
		"TOOLS.md": "# 工具使用注意事项\n\n## 常用工具\n\n## 使用技巧\n",
		"MEMORY.md": "# 长期记忆\n\n这里记录持久性的事实、偏好和决策。\n\n## 用户偏好\n\n## 重要决策\n\n## 关键事实\n",
		"IDENTITY.md": "# 身份\n\n## 名字\n\n## Emoji\n\n## 性格\n\n## 自我描述\n",
		"BOOTSTRAP.md": bootstrapContent,
		"HEARTBEAT.md": "# 心跳检查\n\n## 检查项\n",
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
// isGroup: 是否是群聊（群聊不注入 MEMORY.md 和 USER.md）
func (mm *MemoryManager) BuildMemoryContext(isGroup bool) string {
	var parts []string

	// 1. AGENTS.md
	if content := mm.readFile("AGENTS.md"); content != "" {
		parts = append(parts, "## Agent 操作说明\n"+content)
	}

	// 2. SOUL.md
	if content := mm.readFile("SOUL.md"); content != "" {
		parts = append(parts, "## 灵魂设定\n"+content)
	}

	// 3. IDENTITY.md (每轮都注入，不限于主会话)
	if content := mm.readFile("IDENTITY.md"); content != "" {
		parts = append(parts, "## 身份信息\n"+content)
	}

	// 4. USER.md (仅私聊)
	if !isGroup {
		if content := mm.readFile("USER.md"); content != "" {
			parts = append(parts, "## 用户信息\n"+content)
		}
	}

	// 5. TOOLS.md
	if content := mm.readFile("TOOLS.md"); content != "" {
		parts = append(parts, "## 工具说明\n"+content)
	}

	// 6. MEMORY.md (仅私聊)
	if !isGroup {
		if content := mm.readFile("MEMORY.md"); content != "" {
			parts = append(parts, "## 长期记忆\n"+content)
		}
	}

	// 7. BOOTSTRAP.md (如果存在)
	if content := mm.readFile("BOOTSTRAP.md"); content != "" {
		parts = append(parts, "## 初始化引导\n"+content)
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
