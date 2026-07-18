<div align="center">

<img src="./assets/brand/tietiezhi-mark.png" alt="Tietiezhi" width="140">

# Tietiezhi · 铁铁汁

**AI 中转站官方桌面客户端 —— 填一个 baseURL + API Key，即刻开聊。**

[![Desktop CI](https://github.com/tietiezhi-1216/tietiezhi/actions/workflows/desktop.yml/badge.svg)](https://github.com/tietiezhi-1216/tietiezhi/actions/workflows/desktop.yml)
[![Server CI](https://github.com/tietiezhi-1216/tietiezhi/actions/workflows/server-ci.yml/badge.svg)](https://github.com/tietiezhi-1216/tietiezhi/actions/workflows/server-ci.yml)

[官网与下载](https://tietiezhi-1216.github.io/tietiezhi/) · [版本发布](https://github.com/tietiezhi-1216/tietiezhi/releases)

</div>

> 本项目采用 [Apache License 2.0](./LICENSE) 开源。欢迎提交 Issue 与 Pull Request。

## 定位

Tietiezhi（铁铁汁）是一个以 **AI 模型中转 / 接入**为核心的桌面工具，是中转站的官方桌面客户端：

- **自主**：首次启动不预置任何供应商，由用户在设置中添加自己的 baseURL 与 API Key；
- **安全**：API Key 存入系统安全存储（macOS Keychain / Windows 凭据管理器），不明文落盘；
- **轻快**：Tauri 2 + React 原生壳，安装包小、内存占用低。

当前支持 **Windows 与 macOS** 两端；其它平台（Linux / iOS / Android / Web）暂不提供，但架构上不做排斥。

## 仓库结构

| 目录 | 说明 |
|---|---|
| `desktop/` | 桌面客户端主工程（Tauri 2 + React + TypeScript） |
| `server/` | Go 后端 hub：OpenAI 兼容 API + Agent 运行时 + 飞书/Telegram 渠道 + 万物互联（WebSocket 设备 hub），单二进制部署 |
| `shared/` | 跨端对齐的协议 / 配置规格（单一事实源） |
| `assets/brand/` | 章鱼 logo 与全端图标源文件 |
| `docs/` | 路线图等文档 |

## 开发

### 环境要求

- **Node.js ≥ 22**、**pnpm ≥ 9**（仓库统一使用 pnpm）
- **Rust stable**（经 [rustup](https://rustup.rs) 安装）
- macOS：Xcode Command Line Tools
- Windows：Visual Studio Build Tools（C++ 工作负载）+ WebView2 Runtime

### 桌面端（desktop/）

```bash
cd desktop
pnpm install
pnpm tauri dev       # 开发调试
pnpm tauri build     # 打包发布产物
pnpm typecheck       # TypeScript 检查（tsc --noEmit）
cargo check --manifest-path src-tauri/Cargo.toml   # Rust 检查
```

### 服务端（server/）

```bash
cd server
task build           # 构建 Web 控制台 + 编译单二进制到 bin/tietiezhi
./bin/tietiezhi -c ~/.tietiezhi/config.yaml
```

需要 Go 1.26+；详见 `server/Taskfile.yml`。

## 开源许可

Copyright © 2026 Tietiezhi。本项目基于 [Apache License 2.0](./LICENSE) 发布。
