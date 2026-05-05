package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadInitializesDefaultConfigInAppHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	appDir := filepath.Join(home, AppDirName)
	configPath := filepath.Join(appDir, ConfigFileName)
	if cfg.ConfigPath != configPath {
		t.Fatalf("ConfigPath = %q, want %q", cfg.ConfigPath, configPath)
	}
	if cfg.AppDir != appDir {
		t.Fatalf("AppDir = %q, want %q", cfg.AppDir, appDir)
	}
	if _, err := os.Stat(configPath); err != nil {
		t.Fatalf("default config was not created: %v", err)
	}

	wantWorkspace := filepath.Join(appDir, "workspace")
	if cfg.Memory.Path != wantWorkspace {
		t.Fatalf("Memory.Path = %q, want %q", cfg.Memory.Path, wantWorkspace)
	}
	if got := cfg.Tools.FileIO.AllowedDirs; len(got) != 1 || got[0] != wantWorkspace {
		t.Fatalf("file allowed dirs = %#v, want [%q]", got, wantWorkspace)
	}
	if got := cfg.Sandbox.Volumes; len(got) != 1 || got[0].HostPath != wantWorkspace {
		t.Fatalf("sandbox volumes = %#v, want host path %q", got, wantWorkspace)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read default config: %v", err)
	}
	assertNoPathKeys(t, string(data))

	if err := cfg.Save(); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	data, err = os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read saved config: %v", err)
	}
	assertNoPathKeys(t, string(data))
}

func TestLoadIgnoresPathFieldsFromYaml(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	configPath := filepath.Join(t.TempDir(), "config.yaml")
	configYAML := []byte(`
memory:
  type: markdown
  path: /tmp/legacy-workspace
skills:
  path: /tmp/legacy-skills
scheduler:
  path: /tmp/legacy-cron
session:
  persist_path: /tmp/legacy-sessions
subagent:
  path: /tmp/legacy-subagents
tools:
  file_io:
    allowed_dirs: ["/tmp/legacy-allowed"]
sandbox:
  volumes:
    - host_path: /tmp/legacy-volume
      container_path: /workspace
      read_only: false
`)
	if err := os.WriteFile(configPath, configYAML, 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(configPath)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	appDir := filepath.Join(home, AppDirName)
	wantWorkspace := filepath.Join(appDir, "workspace")
	if cfg.Memory.Path != wantWorkspace {
		t.Fatalf("Memory.Path = %q, want %q", cfg.Memory.Path, wantWorkspace)
	}
	if cfg.Skills.Path != filepath.Join(appDir, "skills") {
		t.Fatalf("Skills.Path = %q", cfg.Skills.Path)
	}
	if cfg.Scheduler.Path != filepath.Join(appDir, "cron") {
		t.Fatalf("Scheduler.Path = %q", cfg.Scheduler.Path)
	}
	if cfg.Session.PersistPath != filepath.Join(appDir, "sessions") {
		t.Fatalf("Session.PersistPath = %q", cfg.Session.PersistPath)
	}
	if cfg.SubAgent.Path != filepath.Join(appDir, "subagents") {
		t.Fatalf("SubAgent.Path = %q", cfg.SubAgent.Path)
	}
	if got := cfg.Tools.FileIO.AllowedDirs; len(got) != 1 || got[0] != wantWorkspace {
		t.Fatalf("file allowed dirs = %#v, want [%q]", got, wantWorkspace)
	}
	if got := cfg.Sandbox.Volumes; len(got) != 1 || got[0].HostPath != wantWorkspace {
		t.Fatalf("sandbox volumes = %#v, want host path %q", got, wantWorkspace)
	}
}

func assertNoPathKeys(t *testing.T, text string) {
	t.Helper()

	for _, removed := range []string{"path:", "persist_path:", "allowed_dirs:", "volumes:", "host_path:"} {
		if strings.Contains(text, removed) {
			t.Fatalf("config contains removed path key %q:\n%s", removed, text)
		}
	}
}
