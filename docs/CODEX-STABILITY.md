# Codex Runtime 稳定性工程

## 范围

R37 使用 `crates/agent-stability` 对源码级 Runtime 做跨模块故障注入和长期运行验证。常规 CI 在 macOS、Windows 每次运行快速回归；定时与手动 `Codex Runtime Soak` 工作流在两平台执行 15 分钟以上的持续工具调用。

## 常规故障矩阵

| 场景 | 验证 |
| --- | --- |
| 长工具链 | 同一 Turn 连续执行 256 次写工具，不存在固定工具次数或总轮次终止 |
| 并发调度 | 只读工具允许重叠，写工具与所有调用互斥 |
| 取消 | 实际子进程收到终止并等待退出，移除后 Manager 会话计数归零 |
| Responses 断流 | HTTP/SSE 在 `response.completed` 前断开后重试，只有一个 Completed 终态 |
| SSE 分块 | Proptest 任意切分 CRLF/LF 帧，解码结果保持一致 |
| MCP 卡死 | 实际 stdio MCP 工具超过独立超时后返回结构化错误，随后停止 Server |
| Rollout 崩溃 | 128 条事件后追加半条 JSON，恢复完整前缀并截断损坏尾部 |
| 原子发布失败 | Rename 前故障保留上一个已提交文件，不暴露 staged 内容 |
| 资源泄漏 | ExecManager 暴露总量和 Owner 维度计数，soak 终态必须为零 |

`FaultInjector` 的 FaultPoint 是一次性且确定的，避免依赖磁盘容量、网络时序或系统权限制造不可重复故障。进程、MCP 和 HTTP 仍使用真实 OS/传输路径。

## Soak

`.github/workflows/codex-soak.yml` 每周和手动运行：

- macOS、Windows 两平台。
- 默认每平台 900 秒。
- 每个周期 256 次工具调用。
- 无固定调用次数上限。
- 结束时无残留 Exec 会话。

本地可运行：

```bash
TIETIEZHI_SOAK_SECONDS=60 \
TIETIEZHI_SOAK_TOOL_CALLS=256 \
cargo test --manifest-path crates/agent-stability/Cargo.toml \
  long_runtime_soak_has_no_process_session_leak -- --ignored --test-threads=1
```

## 门禁

```bash
cargo test --manifest-path crates/agent-stability/Cargo.toml -- --test-threads=1
cargo clippy --manifest-path crates/agent-stability/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path crates/agent-exec/Cargo.toml
```

R38 已删除旧 Workspace Agent Runtime；稳定性测试只允许通过新 Thread/Turn/Item、Responses、Tool Runtime 和 Rollout 路径运行。
