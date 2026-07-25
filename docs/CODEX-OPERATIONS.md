# Codex Runtime 运维能力

R36 以固定上游 `rust-v0.145.0` 为行为基线，在 Tauri 进程内实现日志、指标、Doctor、Feedback 和 App Server reverse-request 生命周期，不调用或分发 Codex 二进制。

## 结构化日志与指标

- `crates/agent-observability` 使用 4 MiB 尾部环形缓冲保存 JSONL 事件。
- App Server Request、非 Delta 通知、模型重路由、安全缓冲和运行错误带 Thread/Turn 标识。
- `authorization`、Cookie、密码、Token、API Key、私钥及字符串中的 Bearer/JWT/查询密钥在入缓冲前替换为 `[REDACTED]`。
- 指标只保存计数、耗时分布和不含内容的分类标签。
- 配置 `TIETIEZHI_OTLP_ENDPOINT` 后，日志和指标按 OTLP/HTTP JSON 的 `/v1/logs`、`/v1/metrics` 路径导出；未配置时不产生遥测网络请求。

## Doctor

Doctor 报告使用平坦、可筛选的 `check` 结构，包含状态、摘要、脱敏详情、问题原因、期望和修复建议。目前检查：

- Runtime 和任务目录创建、写入与删除
- SQLite 状态文件类型
- Runtime 所在磁盘可用空间
- 当前 Responses Provider URL
- Windows Sandbox readiness
- 当前 Runtime uptime

设置中的“运行诊断”页面展示检查状态和无内容指标。`codex_doctor_report` 返回完整结构化报告，便于支持工具读取。

## Feedback

`feedback/upload` 严格使用 App Server V2 参数和响应。

1. 生成 Doctor 报告。
2. 可选截取脱敏日志环形缓冲。
3. 附加文件数量限制为 16，每个文件上限 8 MiB。
4. 生成每个附件的 SHA-256 清单。
5. 原子写入 `app_data_dir()/agent-runtime/operations/feedback-outbox/<feedback-id>/`。
6. 配置 `TIETIEZHI_FEEDBACK_ENDPOINT` 时以 multipart 上传，并写入 `uploaded` receipt；未配置或产品服务暂不可用时保留 Outbox，不静默丢失。

OpenAI 的 Sentry/Statsig 服务端和凭据属于专有服务，不复制到本仓库。Tietiezhi 只复现客户端数据边界与生命周期，并将服务传输映射到自有可配置端点。

## App Server 补齐

- `hooks/list` 复用实际 Hook discovery、优先级、精确文件哈希和 trust state，未受信项目 Hook 会显示但不会执行。
- `modelProvider/capabilities/read` 根据当前 Provider 的 Responses wire、模型缓存和内置 Gateway 能力返回。
- `attestation/generate` 使用强类型 reverse-request Broker、60 秒超时和 Thread 精确路由。
- 每个已登记 reverse request 收到客户端响应后，先发布 `serverRequest/resolved`，再唤醒审批、用户输入、MCP、账号刷新或 Attestation 等待者。
- 设置 UI 可运行 Doctor、查看指标、刷新 OTLP 和提交诊断反馈。

## 验证

- 环形缓冲边界和密钥脱敏
- 指标累积和 Doctor 结构
- multipart Feedback 与原子 Outbox
- Attestation request/response 和 `serverRequest/resolved`
- Thread 精确取消
- Hook 目录 trust projection
- React SSR 运行诊断界面
- App Server Schema、TypeScript、Rust 和生产构建
