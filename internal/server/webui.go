package server

import (
	"io/fs"
	"net/http"
	"path"
	"strings"

	"tietiezhi/internal/webui"
)

func (s *Server) registerWebUIRoutes() {
	s.mux.HandleFunc("/", s.handleWebUI)
}

func (s *Server) handleWebUI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Path == "/v1" || strings.HasPrefix(r.URL.Path, "/v1/") {
		http.NotFound(w, r)
		return
	}

	dist, err := fs.Sub(webui.Dist, "dist")
	if err != nil {
		http.Error(w, "WebUI 文件系统不可用", http.StatusInternalServerError)
		return
	}

	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" || name == "." {
		name = "index.html"
	}
	if hasHiddenPathSegment(name) {
		http.NotFound(w, r)
		return
	}

	if webUIFileExists(dist, name) {
		http.ServeFileFS(w, r, dist, name)
		return
	}

	if webUIFileExists(dist, "index.html") {
		http.ServeFileFS(w, r, dist, "index.html")
		return
	}

	http.Error(w, "WebUI 尚未构建，请运行 task build", http.StatusNotFound)
}

func webUIFileExists(dist fs.FS, name string) bool {
	info, err := fs.Stat(dist, name)
	return err == nil && !info.IsDir()
}

func hasHiddenPathSegment(name string) bool {
	for _, segment := range strings.Split(name, "/") {
		if strings.HasPrefix(segment, ".") {
			return true
		}
	}
	return false
}
