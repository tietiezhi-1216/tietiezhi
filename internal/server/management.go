package server

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"tietiezhi/internal/config"
	"tietiezhi/internal/cron"
	"tietiezhi/internal/hook"
	"tietiezhi/internal/mcp"
	"tietiezhi/internal/memory"
	"tietiezhi/internal/session"
	"tietiezhi/internal/skill"
	"tietiezhi/internal/subagent"
)

// ManagementAPI 管理接口依赖
type ManagementAPI struct {
	cfg         *config.Config
	skillLoader *skill.Loader
	mcpManager  *mcp.MCPManager
	hookManager *hook.HookManager
	subAgentMgr *subagent.SubAgentManager
	cronMgr     *cron.CronManager
	memoryMgr   *memory.MemoryManager
	sessionMgr  *session.SessionManager
}

// NewManagementAPI 创建管理 API
func NewManagementAPI(
	cfg *config.Config,
	skillLoader *skill.Loader,
	mcpManager *mcp.MCPManager,
	hookManager *hook.HookManager,
	subAgentMgr *subagent.SubAgentManager,
	cronMgr *cron.CronManager,
	memoryMgr   *memory.MemoryManager,
	sessionMgr  *session.SessionManager,
) *ManagementAPI {
	return &ManagementAPI{
		cfg:         cfg,
		skillLoader: skillLoader,
		mcpManager:  mcpManager,
		hookManager: hookManager,
		subAgentMgr: subAgentMgr,
		cronMgr:     cronMgr,
		memoryMgr:   memoryMgr,
		sessionMgr:  sessionMgr,
	}
}

// RegisterRoutes 注册管理路由到 mux
func (m *ManagementAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/v1/config", m.handleConfig)
	mux.HandleFunc("/v1/skills", m.handleSkills)
	mux.HandleFunc("/v1/skills/load", m.handleSkillLoad)
	mux.HandleFunc("/v1/mcp", m.handleMCP)
	mux.HandleFunc("/v1/agents", m.handleAgents)
	mux.HandleFunc("/v1/agents/", m.handleAgentAction)
	mux.HandleFunc("/v1/hooks", m.handleHooks)
	mux.HandleFunc("/v1/cron", m.handleCron)
	mux.HandleFunc("/v1/cron/", m.handleCronAction)
	mux.HandleFunc("/v1/workspace", m.handleWorkspace)
	mux.HandleFunc("/v1/workspace/file", m.handleWorkspaceFile)
	mux.HandleFunc("/v1/status", m.handleStatus)
	mux.HandleFunc("/v1/sessions", m.handleSessions)
}

// ==================== Config ====================

func (m *ManagementAPI) handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		m.getConfig(w, r)
	case http.MethodPut:
		m.updateConfig(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (m *ManagementAPI) getConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"server": map[string]interface{}{
			"host": m.cfg.Server.Host,
			"port": m.cfg.Server.Port,
		},
		"llm": map[string]interface{}{
			"provider":    m.cfg.LLM.Provider,
			"base_url":    m.cfg.LLM.BaseURL,
			"api_key":     maskKey(m.cfg.LLM.APIKey),
			"model":       m.cfg.LLM.Model,
			"cheap_model": m.cfg.LLM.CheapModel,
		},
		"agent": map[string]interface{}{
			"max_tool_calls":  m.cfg.Agent.MaxToolCalls,
			"loop_detection":  m.cfg.Agent.LoopDetection,
			"compression":     m.cfg.Agent.Compression.Enabled,
		},
		"channels": map[string]interface{}{
			"feishu":   m.cfg.Channels.Feishu != nil && m.cfg.Channels.Feishu.Enabled,
			"telegram": m.cfg.Channels.Telegram != nil && m.cfg.Channels.Telegram.Enabled,
		},
		"scheduler": m.cfg.Scheduler.Enabled,
		"heartbeat": m.cfg.Heartbeat.Enabled,
		"hooks":     m.cfg.Hooks.Enabled,
		"subagent":  m.cfg.SubAgent.Enabled,
		"sandbox":   m.cfg.Sandbox.Enabled,
	})
}

func (m *ManagementAPI) updateConfig(w http.ResponseWriter, r *http.Request) {
	var req map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if llm, ok := req["llm"].(map[string]interface{}); ok {
		if v, ok := llm["base_url"].(string); ok && v != "" {
			m.cfg.LLM.BaseURL = v
		}
		if v, ok := llm["api_key"].(string); ok && v != "" {
			m.cfg.LLM.APIKey = v
		}
		if v, ok := llm["model"].(string); ok && v != "" {
			m.cfg.LLM.Model = v
		}
		if v, ok := llm["cheap_model"].(string); ok {
			m.cfg.LLM.CheapModel = v
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "配置已更新（部分配置需重启生效）",
	})
}

// ==================== Skills ====================

func (m *ManagementAPI) handleSkills(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var skills []map[string]interface{}
	if m.skillLoader != nil {
		for _, s := range m.skillLoader.GetAllSkills() {
			mcpNames := make([]string, 0)
			for name := range s.MCPServers {
				mcpNames = append(mcpNames, name)
			}
			skills = append(skills, map[string]interface{}{
				"name":          s.Name,
				"description":   s.Description,
				"dir_path":      s.DirPath,
				"mcp_servers":   mcpNames,
				"has_mcp":       len(s.MCPServers) > 0,
				"allowed_tools": s.AllowedTools,
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"skills": skills,
		"total":  len(skills),
	})
}

func (m *ManagementAPI) handleSkillLoad(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if m.skillLoader == nil {
		http.Error(w, "skill loader not available", http.StatusServiceUnavailable)
		return
	}

	s := m.skillLoader.GetSkill(req.Name)
	if s == nil {
		http.Error(w, fmt.Sprintf("skill %s not found", req.Name), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":     true,
		"name":        s.Name,
		"description": s.Description,
	})
}

// ==================== MCP ====================

func (m *ManagementAPI) handleMCP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	servers := make([]map[string]interface{}, 0)
	if m.mcpManager != nil {
		for name, client := range m.mcpManager.GetClients() {
			tools := make([]map[string]string, 0)
			for _, t := range client.GetTools() {
				tools = append(tools, map[string]string{
					"name":        t.Name,
					"description": t.Description,
				})
			}
			servers = append(servers, map[string]interface{}{
				"name":  name,
				"tools": tools,
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"servers": servers,
		"total":   len(servers),
	})
}

// ==================== Agents ====================

func (m *ManagementAPI) handleAgents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	agents := make([]map[string]interface{}, 0)
	if m.subAgentMgr != nil {
		for _, s := range m.subAgentMgr.ListSpawns() {
			agents = append(agents, map[string]interface{}{
				"spawn_id":    s.SpawnID,
				"session_key": s.SessionKey,
				"status":      s.Status,
				"label":       s.Label,
				"started_at":  s.StartedAt,
				"ended_at":    s.EndedAt,
				"error":       s.Error,
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"agents": agents,
		"total":  len(agents),
	})
}

func (m *ManagementAPI) handleAgentAction(w http.ResponseWriter, r *http.Request) {
	spawnID := strings.TrimPrefix(r.URL.Path, "/v1/agents/")
	if spawnID == "" {
		http.Error(w, "agent id required", http.StatusBadRequest)
		return
	}

	if r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if m.subAgentMgr == nil {
		http.Error(w, "sub-agent manager not available", http.StatusServiceUnavailable)
		return
	}

	if err := m.subAgentMgr.KillSpawn(spawnID); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":  true,
		"spawn_id": spawnID,
	})
}

// ==================== Hooks ====================

func (m *ManagementAPI) handleHooks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	rules := make([]map[string]interface{}, 0)
	if m.hookManager != nil {
		for i, r := range m.hookManager.GetRules() {
			rules = append(rules, map[string]interface{}{
				"index":   i,
				"event":   r.Event,
				"matcher": r.Matcher,
				"type":    r.Type,
				"command": r.Command,
				"script":  r.ScriptName,
				"timeout": r.Timeout,
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"rules":  rules,
		"total":  len(rules),
		"enabled": m.hookManager != nil && m.hookManager.IsEnabled(),
	})
}

// ==================== Cron ====================

func (m *ManagementAPI) handleCron(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		m.listCronJobs(w, r)
	case http.MethodPost:
		m.createCronJob(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (m *ManagementAPI) listCronJobs(w http.ResponseWriter, r *http.Request) {
	jobs := make([]map[string]interface{}, 0)
	if m.cronMgr != nil {
		for _, j := range m.cronMgr.ListJobs() {
			jobs = append(jobs, map[string]interface{}{
				"id":               j.ID,
				"name":             j.Name,
				"message":          j.Message,
				"schedule":         j.Schedule,
				"enabled":          j.Enabled,
				"delete_after_run": j.DeleteAfterRun,
				"created_at":       j.CreatedAt,
				"last_run_at":      j.LastRunAt,
				"next_run_at":      j.NextRunAt,
				"run_count":        j.RunCount,
				"mode":             j.Mode,
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"jobs":  jobs,
		"total": len(jobs),
	})
}

func (m *ManagementAPI) createCronJob(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name    string `json:"name"`
		Message string `json:"message"`
		Kind    string `json:"kind"`
		At      string `json:"at"`
		EveryMs int64  `json:"every_ms"`
		Expr    string `json:"expr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if m.cronMgr == nil {
		http.Error(w, "cron manager not available", http.StatusServiceUnavailable)
		return
	}

	job := &cron.CronJob{
		Name:    req.Name,
		Message: req.Message,
		Schedule: cron.Schedule{
			Kind:    req.Kind,
			At:      req.At,
			EveryMs: req.EveryMs,
			Expr:    req.Expr,
			TZ:      "Asia/Shanghai",
		},
		Enabled:        true,
		DeleteAfterRun: req.Kind == "at",
		CreatedAt:      time.Now(),
		Mode:           "isolated",
	}

	if err := m.cronMgr.CreateJob(job); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"job_id":  job.ID,
	})
}

func (m *ManagementAPI) handleCronAction(w http.ResponseWriter, r *http.Request) {
	jobID := strings.TrimPrefix(r.URL.Path, "/v1/cron/")
	if jobID == "" {
		http.Error(w, "job id required", http.StatusBadRequest)
		return
	}

	if r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if m.cronMgr == nil {
		http.Error(w, "cron manager not available", http.StatusServiceUnavailable)
		return
	}

	if err := m.cronMgr.DeleteJob(jobID); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"job_id":  jobID,
	})
}

// ==================== Workspace ====================

func (m *ManagementAPI) handleWorkspace(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var workspacePath string
	if m.memoryMgr != nil {
		workspacePath = m.memoryMgr.GetWorkspacePath()
	} else {
		workspacePath = "./data/workspace"
	}

	files := make([]map[string]interface{}, 0)
	filepath.WalkDir(workspacePath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		relPath, _ := filepath.Rel(workspacePath, path)
		if relPath == "." {
			return nil
		}
		if strings.HasPrefix(relPath, "uploads") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		info, _ := d.Info()
		files = append(files, map[string]interface{}{
			"path":     relPath,
			"is_dir":   d.IsDir(),
			"size":     info.Size(),
			"modified": info.ModTime(),
		})
		return nil
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"files":     files,
		"total":     len(files),
		"base_path": workspacePath,
	})
}

func (m *ManagementAPI) handleWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		m.getWorkspaceFile(w, r)
	case http.MethodPut:
		m.updateWorkspaceFile(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (m *ManagementAPI) getWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		http.Error(w, "path parameter required", http.StatusBadRequest)
		return
	}

	var workspacePath string
	if m.memoryMgr != nil {
		workspacePath = m.memoryMgr.GetWorkspacePath()
	} else {
		workspacePath = "./data/workspace"
	}

	fullPath := filepath.Join(workspacePath, filePath)
	if !strings.HasPrefix(filepath.Clean(fullPath), filepath.Clean(workspacePath)) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}

	data, err := os.ReadFile(fullPath)
	if err != nil {
		http.Error(w, "file not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"path":    filePath,
		"content": string(data),
		"size":    len(data),
	})
}

func (m *ManagementAPI) updateWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	var workspacePath string
	if m.memoryMgr != nil {
		workspacePath = m.memoryMgr.GetWorkspacePath()
	} else {
		workspacePath = "./data/workspace"
	}

	fullPath := filepath.Join(workspacePath, req.Path)
	if !strings.HasPrefix(filepath.Clean(fullPath), filepath.Clean(workspacePath)) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}

	os.MkdirAll(filepath.Dir(fullPath), 0755)

	if err := os.WriteFile(fullPath, []byte(req.Content), 0644); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"path":    req.Path,
	})
}

// ==================== Status ====================

func (m *ManagementAPI) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	skillCount := 0
	mcpCount := 0
	agentCount := 0
	hookCount := 0
	cronCount := 0

	if m.skillLoader != nil {
		skillCount = len(m.skillLoader.GetAllSkills())
	}
	if m.mcpManager != nil {
		mcpCount = len(m.mcpManager.GetClients())
	}
	if m.subAgentMgr != nil {
		agentCount = len(m.subAgentMgr.ListSpawns())
	}
	if m.hookManager != nil {
		hookCount = len(m.hookManager.GetRules())
	}
	if m.cronMgr != nil {
		cronCount = len(m.cronMgr.ListJobs())
	}

	status := map[string]interface{}{
		"timestamp": time.Now().Unix(),
		"model":     m.cfg.LLM.Model,
		"features": map[string]bool{
			"scheduler": m.cfg.Scheduler.Enabled,
			"heartbeat": m.cfg.Heartbeat.Enabled,
			"hooks":     m.cfg.Hooks.Enabled,
			"subagent":  m.cfg.SubAgent.Enabled,
			"sandbox":   m.cfg.Sandbox.Enabled,
			"feishu":    m.cfg.Channels.Feishu != nil && m.cfg.Channels.Feishu.Enabled,
			"telegram":  m.cfg.Channels.Telegram != nil && m.cfg.Channels.Telegram.Enabled,
		},
		"counts": map[string]int{
			"skills":      skillCount,
			"mcp_servers": mcpCount,
			"agents":      agentCount,
			"hooks":       hookCount,
			"cron_jobs":   cronCount,
		},
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// ==================== Sessions ====================

func (m *ManagementAPI) handleSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sessions := make([]map[string]interface{}, 0)
	if m.sessionMgr != nil {
		for _, s := range m.sessionMgr.ListSessions() {
			sessions = append(sessions, map[string]interface{}{
				"key":      s.Key,
				"messages": s.Messages,
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"sessions": sessions,
		"total":    len(sessions),
	})
}

// ==================== Helpers ====================

func maskKey(key string) string {
	if len(key) <= 8 {
		return "****"
	}
	return key[:4] + "****" + key[len(key)-4:]
}
