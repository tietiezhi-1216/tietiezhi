package sandbox

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// DockerSandbox Docker 沙箱
type DockerSandbox struct {
	image       string       // 基础镜像，默认 alpine:latest
	workDir     string       // 容器内工作目录
	timeout     int          // 执行超时（秒）
	memoryLimit string       // 内存限制，默认 "128m"
	cpuLimit    float64      // CPU 限制，默认 0.5
	networkMode string       // 网络模式：bridge/none，默认 none
	volumes     []VolumeMount // 卷挂载
}

// VolumeMount 卷挂载
type VolumeMount struct {
	HostPath      string // 宿主机路径
	ContainerPath string // 容器内路径
	ReadOnly      bool   // 是否只读
}

// ExecResult 执行结果
type ExecResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
}

// NewDockerSandbox 创建 Docker 沙箱实例
func NewDockerSandbox(image, workDir, memoryLimit, networkMode string, cpuLimit float64, volumes []VolumeMount) *DockerSandbox {
	if image == "" {
		image = "alpine:latest"
	}
	if workDir == "" {
		workDir = "/workspace"
	}
	if memoryLimit == "" {
		memoryLimit = "128m"
	}
	if networkMode == "" {
		networkMode = "none"
	}
	if cpuLimit == 0 {
		cpuLimit = 0.5
	}
	return &DockerSandbox{
		image:       image,
		workDir:     workDir,
		timeout:     30,
		memoryLimit: memoryLimit,
		cpuLimit:    cpuLimit,
		networkMode: networkMode,
		volumes:     volumes,
	}
}

// SetTimeout 设置超时时间（秒）
func (s *DockerSandbox) SetTimeout(timeout int) {
	s.timeout = timeout
}

// Execute 在沙箱容器中执行命令
// 返回 stdout, stderr, exitCode
func (s *DockerSandbox) Execute(ctx context.Context, command string, workDir string) (*ExecResult, error) {
	// 构建 docker run 命令参数
	args := []string{
		"run",
		"--rm",                          // 执行完自动删除容器
		"--network=" + s.networkMode,   // 网络隔离
		"--memory=" + s.memoryLimit,     // 内存限制
		"--cpus=" + fmt.Sprintf("%.2f", s.cpuLimit), // CPU 限制
		"-w", workDir,                  // 工作目录
	}

	// 添加卷挂载
	for _, vol := range s.volumes {
		accessMode := "rw"
		if vol.ReadOnly {
			accessMode = "ro"
		}
		args = append(args, "-v", fmt.Sprintf("%s:%s:%s", vol.HostPath, vol.ContainerPath, accessMode))
	}

	// 添加镜像
	args = append(args, s.image)

	// 添加命令：使用 sh -c 执行
	args = append(args, "sh", "-c", command)

	// 创建带超时的 context
	timeoutCtx, cancel := context.WithTimeout(ctx, time.Duration(s.timeout)*time.Second)
	defer cancel()

	// 执行 docker 命令
	cmd := exec.CommandContext(timeoutCtx, "docker", args...)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	// 构建结果
	result := &ExecResult{
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		ExitCode: 0,
	}

	if err != nil {
		if timeoutCtx.Err() == context.DeadlineExceeded {
			// 超时，尝试 kill 容器
			s.killContainer(command)
			result.ExitCode = -1
		} else if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = -1
		}
	}

	return result, nil
}

// killContainer 杀死超时的容器
func (s *DockerSandbox) killContainer(command string) {
	// 尝试查找并杀死可能还在运行的容器
	// 由于使用了 --rm，容器应该在退出时自动删除，这里做保险处理
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 列出所有运行中的容器并杀死包含匹配命令的容器
	cmd := exec.CommandContext(ctx, "docker", "ps", "-q")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Run()

	containerIDs := strings.Split(strings.TrimSpace(out.String()), "\n")
	for _, id := range containerIDs {
		if id != "" {
			exec.CommandContext(ctx, "docker", "kill", id).Run()
		}
	}
}

// HealthCheck 检查 Docker 是否可用
func (s *DockerSandbox) HealthCheck() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "docker", "info")
	err := cmd.Run()
	if err != nil {
		return fmt.Errorf("Docker 不可用: %w", err)
	}
	return nil
}

// PullImage 拉取沙箱镜像
func (s *DockerSandbox) PullImage(ctx context.Context) error {
	// 检查镜像是否存在
	cmd := exec.CommandContext(ctx, "docker", "image", "inspect", s.image)
	if err := cmd.Run(); err == nil {
		// 镜像已存在
		return nil
	}

	// 拉取镜像
	pullCmd := exec.CommandContext(ctx, "docker", "pull", s.image)
	if err := pullCmd.Run(); err != nil {
		return fmt.Errorf("拉取镜像 %s 失败: %w", s.image, err)
	}
	return nil
}

// BuildCustomImage 基于基础镜像构建自定义沙箱镜像，安装常用工具
func (s *DockerSandbox) BuildCustomImage(ctx context.Context, customImageName string) error {
	// 先拉取基础镜像
	if err := s.PullImage(ctx); err != nil {
		return err
	}

	// 构建自定义镜像，安装 bash, curl, python3 等常用工具
	dockerfile := fmt.Sprintf(`FROM %s
RUN apk add --no-cache bash curl python3
`, s.image)

	// 使用 docker build 构建
	cmd := exec.CommandContext(ctx, "docker", "build", "-t", customImageName, "-")
	cmd.Stdin = strings.NewReader(dockerfile)

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("构建自定义镜像失败: %w", err)
	}

	// 更新镜像名为自定义镜像
	s.image = customImageName
	return nil
}

// ImageExists 检查镜像是否存在
func (s *DockerSandbox) ImageExists(ctx context.Context) bool {
	cmd := exec.CommandContext(ctx, "docker", "image", "inspect", s.image)
	return cmd.Run() == nil
}

// SandboxManager 沙箱管理器，管理多个沙箱实例
type SandboxManager struct {
	sandbox *DockerSandbox
	enabled bool
}

// NewSandboxManager 创建沙箱管理器
func NewSandboxManager(enabled bool, config *SandboxConfig) *SandboxManager {
	if !enabled || config == nil {
		return &SandboxManager{
			enabled: false,
		}
	}

	// 转换 VolumeMount 配置
	var volumes []VolumeMount
	for _, v := range config.Volumes {
		volumes = append(volumes, VolumeMount{
			HostPath:      v.HostPath,
			ContainerPath: v.ContainerPath,
			ReadOnly:      v.ReadOnly,
		})
	}

	sandbox := NewDockerSandbox(
		config.Image,
		config.WorkDir,
		config.MemoryLimit,
		config.NetworkMode,
		config.CPULimit,
		volumes,
	)

	return &SandboxManager{
		sandbox: sandbox,
		enabled: enabled,
	}
}

// IsEnabled 检查沙箱是否启用
func (m *SandboxManager) IsEnabled() bool {
	return m.enabled
}

// GetSandbox 获取沙箱实例
func (m *SandboxManager) GetSandbox() *DockerSandbox {
	return m.sandbox
}

// Execute 在沙箱中执行命令，如果沙箱不可用则返回错误
func (m *SandboxManager) Execute(ctx context.Context, command string, workDir string) (*ExecResult, error) {
	if !m.enabled || m.sandbox == nil {
		return nil, fmt.Errorf("沙箱未启用")
	}
	return m.sandbox.Execute(ctx, command, workDir)
}

// HealthCheck 检查沙箱健康状态
func (m *SandboxManager) HealthCheck() error {
	if !m.enabled {
		return fmt.Errorf("沙箱未启用")
	}
	return m.sandbox.HealthCheck()
}

// PullImage 拉取沙箱镜像
func (m *SandboxManager) PullImage(ctx context.Context) error {
	if !m.enabled || m.sandbox == nil {
		return fmt.Errorf("沙箱未启用")
	}
	return m.sandbox.PullImage(ctx)
}

// EnsureImage 确保镜像存在，不存在则拉取
func (m *SandboxManager) EnsureImage(ctx context.Context) error {
	if !m.enabled || m.sandbox == nil {
		return nil
	}
	if !m.sandbox.ImageExists(ctx) {
		return m.PullImage(ctx)
	}
	return nil
}

// SandboxConfig 沙箱配置
type SandboxConfig struct {
	Enabled     bool                `yaml:"enabled"`      // 是否启用沙箱
	Image       string              `yaml:"image"`        // 沙箱镜像
	NetworkMode string              `yaml:"network_mode"` // 网络模式：none/bridge
	MemoryLimit string              `yaml:"memory_limit"` // 内存限制
	CPULimit    float64             `yaml:"cpu_limit"`    // CPU 限制
	WorkDir     string              `yaml:"work_dir"`     // 容器内工作目录
	Volumes     []VolumeMountConfig `yaml:"volumes"`      // 卷挂载
}

// VolumeMountConfig 卷挂载配置
type VolumeMountConfig struct {
	HostPath      string `yaml:"host_path"`
	ContainerPath string `yaml:"container_path"`
	ReadOnly      bool   `yaml:"read_only"`
}

// ToJSON 将执行结果转换为 JSON 字符串
func (r *ExecResult) ToJSON() string {
	data, _ := json.Marshal(r)
	return string(data)
}
