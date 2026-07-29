# `src/main/cores` — 核心注册表、安装器与进程管理

这一层只负责三件事：**知道有哪些核心**（`registry.ts`）、**把它们装到我们自己的目录里**
（`installer.ts`）、**把它们拉起来并管好生命周期**（`process.ts`）。
ACP 握手、JSON-RPC 分帧、session 管理都不在这里——`start()` 只把子进程的 stdin/stdout
交出去，由 ACP 层接管。

---

## 1. 核心清单

| id | 名称 | source | 包 / 命令 | 启动参数 | configFormat | firstParty |
|---|---|---|---|---|---|---|
| `tietiezhi` | 铁铁汁核心 | `builtin` | `$TIETIEZHI_CORE_PATH` 或 `<resources>/bin/tietiezhi-core` | `acp` | `none` | ✅ |
| `claude-code` | Claude Code | `npm` | `@zed-industries/claude-code-acp@0.16.2` | 无 | `claude-json` | ❌ |
| `codex` | Codex | `npm` | `@agentclientprotocol/codex-acp@1.1.7` | 无 | `codex-toml` | ❌ |
| `gemini` | Gemini CLI | `npm` | `@google/gemini-cli@0.53.0` | `--acp` | `gemini-json` | ❌ |

### npm 核心的启动方式

打包后的 Electron 应用**不能假设用户机器上有 `node`**，`node_modules/.bin/` 里的 shim
（POSIX 上是带 shebang 的软链，Windows 上是 `.cmd`）都依赖它。所以 npm 类核心一律用
Electron 自带的 Node 运行：

```
command = process.execPath
args    = [<包内 bin 入口的绝对路径>, ...启动参数]
env     = { ELECTRON_RUN_AS_NODE: "1", <配置目录变量>: <路径> }
```

bin 入口路径**优先从已安装包的 `package.json` 的 `bin` 字段读**，读不到才回退到
registry 里写死的默认值（`dist/index.js` / `bundle/gemini.js`）。这样锁定版本换了目录布局
也不会静默失效。

### 内置核心（tietiezhi）

自家 Rust 核心的 ACP 适配层**还没有做**。`command` 目前是占位：

1. 有 `TIETIEZHI_CORE_PATH` 就用它（开发时指向本地 build 产物）；
2. 否则指向 `<process.resourcesPath>/bin/tietiezhi-core`（打包后的预期位置）。

`checkInstalled()` 对它只做「可执行文件存在吗」的判断，所以在适配层落地之前它会一直是
`not-installed`，不会假装能跑。

---

## 2. 目录布局

全部在 app 自管的 `userData` 下，**绝不碰用户自己的 `~/.claude` / `~/.codex` / `~/.gemini`**。

```
<userData>/
  cores/<coreId>/                 ← npm 安装前缀
    package.json                  ← 我们写的空壳，防止 npm 向上找 package.json
    .tietiezhi-install.json       ← 安装回执（包名、版本、时间戳）
    node_modules/<pkg>/...
    node_modules/.bin/            ← 启动时前置到子进程 PATH
  core-config/<coreId>/           ← 该核心的隔离配置目录
```

覆盖用的环境变量（给测试和 CLI 工具用，正常运行不需要设）：

- `TIETIEZHI_DATA_DIR` — 覆盖 `app.getPath("userData")`
- `TIETIEZHI_CORES_DIR` — 直接覆盖安装前缀父目录
- `TIETIEZHI_CORE_CONFIG_ROOT` — 直接覆盖配置目录父目录

---

## 3. 各核心的配置目录环境变量

`getCoreConfigPaths(id)` 返回 `{ envName, envValue, settingsDir, confidence }`。
**配置投影一律往 `settingsDir` 写**，不要自己去猜 `~/.claude` 这种路径。

| 核心 | 变量 | 语义 | `settingsDir` | 可信度 |
|---|---|---|---|---|
| `tietiezhi` | `TIETIEZHI_CORE_CONFIG_DIR` | 配置目录本身 | `<core-config>/tietiezhi` | 我们自己定义的 |
| `claude-code` | `CLAUDE_CONFIG_DIR` | 配置目录本身（替代 `~/.claude`） | `<core-config>/claude-code` | **community** |
| `codex` | `CODEX_HOME` | 配置目录本身（替代 `~/.codex`），读 `$CODEX_HOME/config.toml` | `<core-config>/codex` | **documented** |
| `gemini` | `GEMINI_CLI_HOME` | **home 目录**，CLI 在其下自建 `.gemini/` | `<core-config>/gemini/.gemini` | **documented** |

`confidence` 的含义：

- `documented` — 在官方文档里查到了原文。
- `community` — 功能确实存在并被广泛使用，但官方文档里没有写。
- `unverified` — 没查到，属于猜测。

---

## 4. 查证记录

### 查证过的（有出处）

- **npm 包与版本**：`npm view` 直接确认三个包在 registry 上存在且版本号有效：
  - `@zed-industries/claude-code-acp@0.16.2`，`bin: { "claude-code-acp": "dist/index.js" }`
  - `@agentclientprotocol/codex-acp@1.1.7`，`bin: { "codex-acp": "dist/index.js" }`
  - `@google/gemini-cli@0.53.0`（写这份文档时的最新 stable），`bin: { "gemini": "bundle/gemini.js" }`
- **Gemini 的 ACP flag = `--acp`**：来自 gemini-cli 仓库的
  `docs/cli/acp-mode.md`，原文即 `gemini --acp`，并说明是 stdio 上的 JSON-RPC 2.0。
  **不是** `--experimental-acp`（早期版本用过那个名字，0.53 的文档里已经是 `--acp`）。
- **`GEMINI_CLI_HOME`**：gemini-cli `docs/reference/configuration.md` 环境变量小节，
  原文说它指定 user-level 配置与存储的**根目录**，CLI 会在其下创建 `.gemini` 文件夹。
  （同节还有 `GEMINI_CLI_TRUSTED_FOLDERS_PATH`，只管 `trustedFolders.json`，不是我们要的。）
- **`CODEX_HOME`**：OpenAI Codex 官方文档，配置读自 `$CODEX_HOME/config.toml`，
  不设时默认 `~/.codex`。本仓库 `docs/CODEX-SKILLS.md` 也已经在用 `$CODEX_HOME/skills`。
- **`npm install --prefix <dir>` 的落盘布局**：实测确认包落在
  `<dir>/node_modules/<pkg>`、bin 落在 `<dir>/node_modules/.bin`，并且 npm 的
  `--loglevel=info` 输出走 stderr（所以 installer 同时收 stdout 和 stderr）。
- **整条链路在真实 Electron 里跑通过**（`claude-code`，macOS arm64）：
  `checkInstalled` → `install`（真 npm）→ `start()` → 往 stdin 写一条 ACP `initialize`
  → 从 stdout 读到真实应答：
  `{"protocolVersion":1,"agentInfo":{"name":"@zed-industries/claude-code-acp","version":"0.16.2"},...}`
  → `markReady` → `ready` → `stop()` → `stopped` 且子进程确实已消失（`process.kill(pid,0)` 抛错）。
  崩溃退避也实测过：核心连续启动失败时状态依次是 `restarting 1/3`、`2/3`、`3/3`，
  之后停在 `crashed` 不再重启。
  **注意**：`ELECTRON_RUN_AS_NODE=1` + `process.execPath` 这条启动方式是实测有效的，
  claude-code-acp 在 Electron 的 Node 里能正常完成 ACP 握手。

### 待确认 / 有保留

- **`CLAUDE_CONFIG_DIR`**：Claude Code 官方 settings 文档里**没有**这个变量，
  但它确实被支持（anthropics/claude-code issue tracker 上有多个 issue 讨论它，
  包括一个专门要求补文档的 DOCS issue）。因此标为 `community`。
  已知的坑：它管的是 user-level 的 `~/.claude` 替代位置，**项目级的 `./.claude/` 目录
  不受它影响**。也就是说我们能隔离用户的全局配置，但隔离不了工作区目录里的 `.claude/`。
- **`@zed-industries/claude-code-acp` 已改名**：该仓库的 README 现在指向
  `@agentclientprotocol/claude-agent-acp`。`@zed-industries/claude-code-acp@0.16.2`
  在 registry 上仍然存在且可安装，按任务要求锁在这个包名+版本；
  但后续升级时要注意迁移到新包名。
- **codex-acp 是否需要机器上已有 `codex` 二进制**：没有查证。如果它是对本地 codex CLI
  的封装而不是自带，第一次启动会失败，stderr 会说明原因（`getStderr("codex")` 能拿到）。
- **`tietiezhi` 核心的最终命令行**：`acp` 子命令名是按我们自己的预期写的占位，
  Rust 侧适配层落地时需要对齐。
- **Windows 上的进程树清理**：POSIX 上用 `detached: true` + `process.kill(-pid)`
  杀整个进程组，可靠。Windows 上用 `taskkill /T /F`，但那是异步的，
  在 `process.on("exit")` 这条同步兜底路径上跑不完——那种情况下靠 Electron 的
  job object 回收子进程。没有在 Windows 上实测。

---

## 5. 安装器（`installer.ts`）

```ts
import { coreInstaller } from "./installer";

coreInstaller.onStateChange((coreId, state) => { /* CoreInstallState */ });
await coreInstaller.install(descriptor);           // 版本恒为精确锁定
await coreInstaller.checkInstalled(descriptor);    // 读盘上真实版本
await coreInstaller.uninstall("gemini");           // 直接删整个前缀
```

要点：

- **版本恒为精确锁定**：`npm install <pkg>@<exact> --save-exact`。descriptor 里没有
  `version` 时**拒绝安装**而不是装 latest。
- 安装前会在前缀里写一个空壳 `package.json`，否则 npm 会向上找并可能把无关工程当成安装根。
- 同一个核心的并发 `install()` 共享同一次 npm 运行（npm 对同一 prefix 并发不安全）。
- **失败一定带 npm 的 stderr 尾部**（最后 4000 字符）进 `CoreInstallState.failed.message`。
  `npm` 不在 PATH 上时给的是明确的 "npm must be on PATH to install cores"。
- **进度是启发式的**：npm 没有机器可读的进度输出，所以按日志行数以
  `0.1 + 0.8 * (1 - e^(-lines/60))` 渐近逼近 0.9，250ms 节流。别拿它当精确百分比用。
- **国内网络**：默认**不动** registry。用户配置了才用，优先级
  `InstallOptions.registryUrl` > `process.env.TIETIEZHI_NPM_REGISTRY`。
- 支持 `AbortSignal` 取消和超时（默认 **30 分钟**）。

### 安装回执：为什么 `checkInstalled` 不只看 package.json

实测踩到的坑：`claude-code-acp` 会拖进 `sharp`，它的 `libvips` 预编译二进制在冷缓存下
从国内拉了将近 9 分钟。安装超时被打断后，**顶层包的 `package.json` 已经落盘了**，
只看它会判定成 "installed"，而实际依赖树不完整——核心一启动就
`ERR_MODULE_NOT_FOUND` 崩溃，报错还指向一个跟安装毫无关系的地方。

所以 `.tietiezhi-install.json` 回执**只在 npm 退出码为 0 之后**才写。
`checkInstalled()` 对 npm 类核心要求「包的 package.json 存在 **且** 回执存在且包名对得上」，
否则返回 `{ status: "failed", message: "...the install never completed; re-install the core" }`，
让 UI 直接引导重装，而不是让用户去看一堆 Node 模块解析栈。

---

## 6. 进程管理（`process.ts`）

```ts
import { getCoreProcessManager } from "./process";

const mgr = getCoreProcessManager();
const handle = mgr.start("claude-code");   // { pid, stdin, stdout, generation }
// ... ACP 层在 handle.stdin/stdout 上建连接，initialize 成功后：
mgr.markReady("claude-code", handle.pid === 0 ? 1 : protocolVersion);
await mgr.stop("claude-code");
await mgr.stopAll();
```

- 单例是**懒构造**的（`getCoreProcessManager()`），因为构造函数会注册 Electron 退出钩子，
  不应该作为 import 的副作用发生。
- **状态**：`start()` 后是 `starting`；`ready` 需要 ACP 层调 `markReady(coreId, protocolVersion)`
  ——只有它知道握手结果和协议版本。
- **崩溃不无限重启**：默认最多 3 次，退避 1s → 2s → 4s（上限 15s）。
  进程活过 60s 视为健康，重启计数清零。超出预算后状态停在 `crashed`，不再自动拉起。
  `stop()` 触发的退出走 `stopped`，不算崩溃。
- **`generation`**：每次 (重) 启动 +1。ACP 层为第 N 代建立的连接，看到管理器已经到 N+1
  就该自行放弃，避免往已经换掉的进程里写。
- **不留孤儿进程**：
  - POSIX：`detached: true` 让核心自成进程组，`process.kill(-pid)` 能连它自己拉起的
    工具进程一起杀掉；
  - `stop()` 先 `stdin.end()`（守规矩的 ACP agent 收到 EOF 会自己退），再 SIGTERM，
    3 秒不退就 SIGKILL；
  - `app.on("before-quit" / "will-quit")` 触发 `stopAll()`；
  - `process.on("exit")` 里同步 SIGKILL 兜底（同步路径下不能 await）。
- **stderr 收集**：每个核心保留最近 500 行环形缓冲，`getStderr(coreId)` 取。
  崩溃消息里也会带最后 8 行。
- 子进程 PATH 前置了 `<install prefix>/node_modules/.bin`，核心内部再去找同伴 CLI 时
  会先命中我们前缀里的版本。
- 启动前会 `mkdir -p` 该核心的 `settingsDir`——有些 CLI 在配置目录不存在时直接拒绝启动。

---

## 7. 导出一览

`registry.ts`
- `listCores(): CoreDescriptor[]`
- `getCore(id): CoreDescriptor | undefined` / `requireCore(id): CoreDescriptor`
- `getCoreConfigPaths(id): CoreConfigPaths | undefined` ← **配置投影用这个**
- `getCoreInstallDir(id): string`
- `getCoreTemplate(id)`（内部用，安装器靠它拿 packageName/version）

`installer.ts`
- `CoreInstaller` 类 + `coreInstaller` 单例
- `install` / `checkInstalled` / `uninstall` / `getState` / `onStateChange`

`process.ts`
- `CoreProcessManager` 类 + `getCoreProcessManager()`
- `CoreProcessHandle`、`RunStateListener`、`CoreExitListener`

`paths.ts`
- `coresRoot` / `coreInstallDir` / `coreConfigRoot` / `coreConfigDir` / `executableName`
