<div align="center">

<img src="./assets/brand/tietiezhi-mark-transparent.png" alt="Tietiezhi" width="120">

# Tietiezhi

**从 Workspace 开始构建的 Electron 桌面 Agent。**

</div>

## 当前阶段

项目正在从基础重新构建，目前只实现本地 Workspace 与对话存储：

- 项目 Workspace：绑定用户选择的真实目录。
- 临时 Workspace：在应用数据目录创建 UUID 隔离目录。
- Conversation：一个 Workspace 可以包含多个对话。
- Message：使用自有结构保存到 SQLite，不依赖任何 AI SDK。

Agent Loop、Provider、工具、审批和 Create 尚未接入。

## 数据关系

```text
Workspace (project | temporary)
  └── Conversation
        └── Message
```

## 启动

要求 Node.js 24+ 和 pnpm 10。

```bash
cd app
pnpm install
pnpm dev
```

验证：

```bash
pnpm typecheck
pnpm test
pnpm build
TIETIEZHI_HEADLESS=1 ./node_modules/.bin/electron .
```

项目采用 [Apache License 2.0](./LICENSE)。
