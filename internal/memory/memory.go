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

	// 创建默认文件（如果不存在）
	defaults := map[string]string{
		"AGENTS.md": "# Agent 操作说明\n\n你是一个有用的 AI 助手。以下是你需要遵守的规则：\n\n- 回答问题时要准确、有帮助\n- 如果不确定，请诚实地说明\n- 用清晰、简洁的语言回复\n- 群聊中注意区分不同发言者\n",
		"SOUL.md":   "# 灵魂设定\n\n你是一个友好、专业的 AI 助手。\n\n## 语气\n- 亲切但不随意\n- 专业但不生硬\n\n## 边界\n- 不编造不确定的信息\n- 不泄露敏感信息\n",
		"USER.md":   "# 用户信息\n\n请在这里记录用户的基本信息。\n\n## 称呼\n\n## 偏好\n\n## 重要事项\n",
		"TOOLS.md":  "# 工具使用注意事项\n\n## 常用工具\n\n## 使用技巧\n",
		"MEMORY.md": "# 长期记忆\n\n这里记录持久性的事实、偏好和决策。\n\n## 用户偏好\n\n## 重要决策\n\n## 关键事实\n",
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
// isGroup: 是否是群聊（群聊不注入 MEMORY.md）
func (mm *MemoryManager) BuildMemoryContext(isGroup bool) string {
	var parts []string

	// 1. 加载 AGENTS.md
	if content := mm.readFile("AGENTS.md"); content != "" {
		parts = append(parts, "## Agent 操作说明\n"+content)
	}

	// 2. 加载 SOUL.md
	if content := mm.readFile("SOUL.md"); content != "" {
		parts = append(parts, "## 灵魂设定\n"+content)
	}

	// 3. 加载 USER.md
	if content := mm.readFile("USER.md"); content != "" {
		parts = append(parts, "## 用户信息\n"+content)
	}

	// 4. 加载 TOOLS.md
	if content := mm.readFile("TOOLS.md"); content != "" {
		parts = append(parts, "## 工具说明\n"+content)
	}

	// 5. 加载 MEMORY.md（仅私聊）
	if !isGroup {
		if content := mm.readFile("MEMORY.md"); content != "" {
			parts = append(parts, "## 长期记忆\n"+content)
		}
	}

	// 6. 加载每日笔记（今天 + 昨天）
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
func (mm *MemoryManager) WriteMemory(memoryType, content string) error {
	switch memoryType {
	case "longterm":
		return mm.appendToMemoryMD(content)
	case "daily":
		return mm.appendToDailyNote(content)
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

// GetWorkspacePath 获取工作区路径
func (mm *MemoryManager) GetWorkspacePath() string {
	return mm.workspacePath
}
