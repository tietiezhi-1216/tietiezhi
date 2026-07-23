# 工具执行机制

## 问题结论

旧实现把整轮对话用时显示在当前 Bash 工具旁，因此截图中的 `1259s` 不等于 Bash 本身已运行 1259 秒。但工具卡只有开始和结束两个事件，命令执行期间没有输出、独立计时或终态原因；若 shell 的子进程继承输出管道、等待外部资源，界面就会长期保持“运行中”。停止或切换任务时，前端也没有把未结束的工具卡持久化为已取消状态。

简单表格任务还暴露出另一类问题：模型先尝试不存在的 Python，再用 HTML 冒充 `.xls`，之后继续重复检查。这不是表格任务本身复杂，而是工具说明缺少“能力探测、真实格式、非交互命令、失败后换方法”等约束，执行环路也缺少重复调用保护。

## 方案对比

| 项目 | 可取机制 | 本项目采用情况 |
| --- | --- | --- |
| OpenCode | Bash 默认/最大超时、进程树清理、有界输出、命令权限、连续相同调用的 doom-loop 保护 | 采用 |
| OpenAI Codex | 进程独立状态、增量输出、运行时长/退出码、取消后等待清理、头尾有界缓冲 | 采用适合桌面会话的部分 |
| Claude Code 等终端代理 | 非交互优先、后台任务显式管理、工具结果驱动下一步 | 通过系统指令约束；后台会话暂不开放给模型 |

参考实现：

- [OpenCode Bash 工具](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/bash.ts)
- [OpenCode 进程管理](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/process.ts)
- [OpenCode 权限规则](https://opencode.ai/docs/permissions/)
- [Codex 进程管理](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/process_manager.rs)
- [Codex 头尾输出缓冲](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/head_tail_buffer.rs)

## 落地规则

- Bash 默认超时 120 秒，允许显式调整，最大 600 秒。
- 每轮任务最长 15 分钟，工具调用最多 20 轮。
- 相同工具与参数连续调用 3 次时停止任务并显示循环保护原因。
- Bash 使用独立进程组；取消或超时时先终止、3 秒后强制清理整个进程树。
- 标准输出和错误输出边执行边回传，只保留 30 KiB 头尾内容。
- 工具事件包含独立时长、退出码、超时、取消、截断状态。
- 运行超过 30 秒仍无输出时，界面提示可能在等待输入、网络或外部进程。
- 工具开始和结束状态会写入任务记录；应用异常退出后，遗留的 `running` 状态按“上次运行未正常结束”恢复。
- Bash 只用于会自行结束的非交互命令；简单文本、Markdown、CSV 直接使用文件工具。
- 不通过更改扩展名伪造 XLS/XLSX 等二进制文件。
- `/context` 查看上下文占用，`/compact`、`/summarize` 或 `/压缩` 可提前压缩；所有模型按 256K 计算并在约 80% 自动压缩。

## 后续演进

当前仍保持单次 `bash` 对模型同步返回，避免在没有任务会话管理界面的情况下制造不可见后台进程。若以后需要常驻服务或交互式终端，应像 Codex 一样增加独立的 `exec_command`、`write_stdin`、进程会话 ID 和后台任务面板，而不是放宽现有 Bash 的阻塞时间。
