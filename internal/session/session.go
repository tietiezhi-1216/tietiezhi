package session

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tietiezhi/internal/llm"
)

// Session 单个会话
type Session struct {
	Key     string            `json:"key"`
	History []llm.ChatMessage `json:"history"`
	Meta    map[string]string `json:"meta,omitempty"`
	mu      sync.RWMutex
}

// AppendMessage 追加消息
func (s *Session) AppendMessage(msg llm.ChatMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.History = append(s.History, msg)
}

// GetHistory 获取历史（只读拷贝，自动过滤不合法消息）
func (s *Session) GetHistory() []llm.ChatMessage {
	s.mu.RLock()
	defer s.mu.RUnlock()
	
	// 过滤掉可能导致 API 调用失败的不合法消息
	var result []llm.ChatMessage
	for _, msg := range s.History {
		// 跳过 system 角色（OpenAI API 不允许中间插入 system）
		if msg.Role == "system" {
			continue
		}
		// 跳过空的 assistant 消息（无 content 也无 tool_calls）
		if msg.Role == "assistant" && msg.GetContentAsText() == "" && len(msg.ToolCalls) == 0 {
			continue
		}
		// 跳过没有 tool_call_id 的 tool 消息
		if msg.Role == "tool" && msg.ToolCallID == "" {
			continue
		}
		result = append(result, msg)
	}
	return result
}

// TruncateHistory 截断历史
func (s *Session) TruncateHistory(maxMessages int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.History) > maxMessages {
		s.History = s.History[len(s.History)-maxMessages:]
	}
}

// Clear 清空
func (s *Session) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.History = s.History[:0]
}

// SessionManager 会话管理器
type SessionManager struct {
	sessions        map[string]*Session
	mu              sync.RWMutex
	maxHistoryMsgs  int
	persistDir      string
	autoSaveSeconds int
}

// NewSessionManager 创建会话管理器
func NewSessionManager(maxHistoryTurns, autoSaveSeconds int, persistDir string) *SessionManager {
	if maxHistoryTurns <= 0 {
		maxHistoryTurns = 20
	}
	if autoSaveSeconds <= 0 {
		autoSaveSeconds = 60
	}
	sm := &SessionManager{
		sessions:        make(map[string]*Session),
		maxHistoryMsgs:  maxHistoryTurns * 2,
		persistDir:      persistDir,
		autoSaveSeconds: autoSaveSeconds,
	}
	sm.LoadAll()
	return sm
}

// GetOrCreate 获取或创建会话
func (sm *SessionManager) GetOrCreate(key string) *Session {
	sm.mu.RLock()
	if s, ok := sm.sessions[key]; ok {
		sm.mu.RUnlock()
		return s
	}
	sm.mu.RUnlock()

	sm.mu.Lock()
	defer sm.mu.Unlock()
	if s, ok := sm.sessions[key]; ok {
		return s
	}
	s := &Session{
		Key:     key,
		History: make([]llm.ChatMessage, 0),
		Meta:    make(map[string]string),
	}
	sm.sessions[key] = s
	return s
}

// AppendMessage 向指定会话追加消息
func (sm *SessionManager) AppendMessage(sessionKey string, msg llm.ChatMessage) {
	s := sm.GetOrCreate(sessionKey)
	s.AppendMessage(msg)
	s.TruncateHistory(sm.maxHistoryMsgs)
}

// GetHistory 获取指定会话历史
func (sm *SessionManager) GetHistory(sessionKey string) []llm.ChatMessage {
	s := sm.GetOrCreate(sessionKey)
	return s.GetHistory()
}

// BuildSessionKey 构建 session key
func BuildSessionKey(chatType, chatID, userID string) string {
	if chatType == "group" {
		return "group:" + chatID
	}
	return "p2p:" + userID
}

// Save 保存单个会话到 JSONL
func (sm *SessionManager) Save(s *Session) error {
	if sm.persistDir == "" {
		return nil
	}
	if err := os.MkdirAll(sm.persistDir, 0755); err != nil {
		return err
	}
	safeKey := strings.ReplaceAll(s.Key, ":", "_")
	filePath := filepath.Join(sm.persistDir, safeKey+".jsonl")

	s.mu.RLock()
	defer s.mu.RUnlock()

	f, err := os.Create(filePath)
	if err != nil {
		return err
	}
	defer f.Close()

	encoder := json.NewEncoder(f)
	for _, msg := range s.History {
		if err := encoder.Encode(msg); err != nil {
			return err
		}
	}
	return nil
}

// SaveAll 保存所有会话
func (sm *SessionManager) SaveAll() error {
	sm.mu.RLock()
	sessions := make([]*Session, 0, len(sm.sessions))
	for _, s := range sm.sessions {
		sessions = append(sessions, s)
	}
	sm.mu.RUnlock()

	var lastErr error
	for _, s := range sessions {
		if err := sm.Save(s); err != nil {
			lastErr = err
			log.Printf("保存会话 %s 失败: %v", s.Key, err)
		}
	}
	return lastErr
}

// LoadAll 加载所有会话
func (sm *SessionManager) LoadAll() error {
	if sm.persistDir == "" {
		return nil
	}
	if err := os.MkdirAll(sm.persistDir, 0755); err != nil {
		return err
	}
	entries, err := os.ReadDir(sm.persistDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		safeKey := strings.TrimSuffix(entry.Name(), ".jsonl")
		var sessionKey string
		if strings.HasPrefix(safeKey, "p2p_") {
			sessionKey = "p2p:" + strings.TrimPrefix(safeKey, "p2p_")
		} else if strings.HasPrefix(safeKey, "group_") {
			sessionKey = "group:" + strings.TrimPrefix(safeKey, "group_")
		} else {
			sessionKey = strings.ReplaceAll(safeKey, "_", ":")
		}

		s := &Session{
			Key:     sessionKey,
			History: make([]llm.ChatMessage, 0),
			Meta:    make(map[string]string),
		}
		filePath := filepath.Join(sm.persistDir, entry.Name())
		f, err := os.Open(filePath)
		if err != nil {
			log.Printf("打开会话文件 %s 失败: %v", filePath, err)
			continue
		}
		decoder := json.NewDecoder(f)
		for decoder.More() {
			var msg llm.ChatMessage
			if err := decoder.Decode(&msg); err != nil {
				break
			}
			s.History = append(s.History, msg)
		}
		f.Close()
		sm.mu.Lock()
		sm.sessions[sessionKey] = s
		sm.mu.Unlock()
		log.Printf("加载会话: %s (%d 条消息)", sessionKey, len(s.History))
	}
	return nil
}

// StartAutoSave 启动定时自动保存
func (sm *SessionManager) StartAutoSave(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(sm.autoSaveSeconds) * time.Second)
	go func() {
		for {
			select {
			case <-ctx.Done():
				sm.SaveAll()
				return
			case <-ticker.C:
				if err := sm.SaveAll(); err != nil {
					log.Printf("自动保存会话失败: %v", err)
				}
			}
		}
	}()
}
