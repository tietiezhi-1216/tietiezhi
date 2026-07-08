# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 开发规范（必须遵守）

1. **必须使用中文回复**——所有对话、解释、提交说明默认使用简体中文。代码内的注释沿用现有文件的语言风格（本仓库注释多为英文，UI 文案为中文）。
2. **保持优雅，遵守 Apple 的设计与开发规范**——UI 遵循 macOS Human Interface Guidelines（原生控件、`NSVisualEffectView` 毛玻璃、SF Symbols、系统配色与排版）；代码遵循 Swift API Design Guidelines。
3. **坚持主流技术栈**——SwiftUI 为主，必要时用薄 AppKit 桥接（菜单栏、悬浮面板、事件监听）。不引入小众框架。
4. **优先用主流、常见的方案解决问题**——能用系统框架（AVFoundation / URLSession / Combine）就不要自造轮子；新增能力先看是否能复用现有抽象（见下方「配置数据模型」）。

## 常用命令

本项目是 **Swift Package（无 Xcode 工程）**，只装了 Command Line Tools 即可构建。所有命令在仓库根目录执行：

```bash
./build.sh run        # 编译 → 组装 → Apple Development 签名 → 装到 /Applications/Orbit Dev.app → 启动（最常用）
./build.sh build      # 仅编译并组装 debug 版 .app（留在 .build/，不安装）
./build.sh release    # release 配置组装
./build.sh clean      # 删除 .build
```

> ⚠️ 没有 Makefile（旧记忆里的 `make run` 已过时）。也**没有单元测试**——验证靠 `./build.sh run` 实际运行。
> `swift build` 只产出裸可执行文件；`build.sh` 额外把它组装成带 `Info.plist` 的 `.app`、用**受信任证书**签名、**安装到 `/Applications`** 再启动——这三步都是 TCC 权限能生效的前提（见下方「签名 / 权限规则」）。

直接编译检查（不组装 app）：`swift build`。

### 签名 / 权限规则（TCC）—— 改动前必读

macOS 把每项隐私授权（TCC）绑定到 app 的**代码签名 + bundle id**。Orbit 有**两个独立身份**，权限互不相通（签名不同，无法合并）：

| | 正式版 | 开发版（本地 `./build.sh run`） |
|---|---|---|
| bundle id | `com.orbit.app` | `com.orbit.app.dev` |
| 可执行名 | `Orbit` | `OrbitDev`（**故意不同**，见下） |
| 签名 | Developer ID（Team `LQ97GA8LY8`）+ 公证，CI 出 | **Apple Development**（`嘉伟 薛`/`FMUHLV5VG6`），本地 `build.sh` 签 |
| 位置 | `/Applications/Orbit.app` | `/Applications/Orbit Dev.app`（**必须装这儿**） |

**三条铁律（都是血泪换来的，破坏任一条截图就废）：**

1. **屏幕录制必须从 `/Applications` 运行。** macOS 屏幕录制（`kTCCServiceScreenCapture`）**拒绝给「从 `.build/` 非标准目录运行的 app」注册/授权**，哪怕签名受信任。所以 `build.sh run` 会把开发版**装到 `/Applications/Orbit Dev.app`** 再启动。辅助功能 / 麦克风不挑位置，从 `.build/` 跑也行——只有屏幕录制有此限制。
2. **屏幕录制需要「受信任」签名。** 自签名证书（`Orbit Self-Signed`，`CSSMERR_TP_NOT_TRUSTED`）能保住辅助功能，但**保不住屏幕录制**。必须用 Apple 签发的证书（Apple Development 或 Developer ID）。`build.sh` 的 `sign()` 优先级：Apple Development ＞ Orbit Self-Signed ＞ ad-hoc。
   - Apple Development 证书要能签名，**login 钥匙串里必须有完整证书链**（缺 `WWDR G3` 中间证书会报 `unable to build chain to self-signed root`）。可从系统钥匙串导出或联网下 `AppleWWDRCAG3.cer` 导入。
3. **屏幕录制列表按「可执行名」显示条目，不是 bundle id。** 若开发版和正式版可执行名都叫 `Orbit`，会**塌成同一行**，用户开的永远是正式版那个、开发版拿不到。所以开发版可执行名改成 `OrbitDev`，在列表里单独成行。（辅助功能按 bundle id 区分，无此问题。）

**权限行为速查：** 辅助功能/麦克风 = 按 bundle id、不挑位置、自签名即可；屏幕录制 = 按可执行名、必须 /Applications、必须受信任证书。**新增权限时**先判断它属于哪一类：像前者就直接能用；像屏幕录制这类敏感权限，就得满足「/Applications + 独立可执行名 + 受信任签名」。

**授权持久性：** 只要签名证书稳定（Apple Development 稳定）且 bundle id/可执行名不变，`./build.sh run` 反复重建重装**都保留授权**，无需重授——本地免发版调试成立。**只有换证书/换签名那一次**，三项权限会全部失效、需各重授一次。

**诊断利器：** 启动自检写入 `~/.orbit/capture-debug.log`（可 `tail`），打印运行的 bundle id、`CGPreflightScreenCaptureAccess`、实测 `SCShareableContent` 成败。排障第一步永远先 `pgrep -x OrbitDev` / `pgrep -x Orbit` 确认在跑哪个。详细来龙去脉见记忆 `orbit-dev-codesigning-tcc`。

## 架构总览

Orbit 是 **macOS-only 的原生应用**（Swift 6 工具链 / Swift 5 语言模式 / SwiftUI），定位是「开放的多模态 AI 平台——每个模型都是一颗卫星」。当前落地了两个界面：**聊天（Chat，主界面）** 和 **全局语音听写（Dictation，首个卫星）**。

### 应用骨架（`App/`）

- **`main.swift`** 是真正入口——手动 `NSApplication.run()`（不是 `@main`）。启动时设为 `.accessory`，这样在任何窗口出现前菜单栏图标和后台听写就已存在。
- **`AppDelegate`** 把一切接线起来：`SettingsStore`、`ChatStore`、`DictationHistoryStore`、`AppController`、菜单栏 status item、主窗口、`DictationEngine` + `HotkeyMonitor`。聊天窗口打开后把激活策略提升为 `.regular`（像 Claude/Codex 那样有 Dock 图标），但**听写始终在后台运行，与窗口无关**。
- **`AppController`** 是 UI 唯一对话的「大脑」（`ObservableObject`）：持有权限状态、热键捕获状态、当前 workspace（`.chat` / `.settings`）。它通过闭包回调（`onToggleDictation` 等）与听写层解耦——UI 不直接依赖引擎。
- **单窗口双 workspace**：聊天和设置不是两个窗口，而是同一个主窗口里按 `AppController.workspace` 切换的两个视图区。听写的录音胶囊是独立的悬浮 `NSPanel`。

### 配置数据模型（最核心、最需要先读懂的抽象，`Models/Settings.swift`）

这是整个应用的中枢，新增任何「模型能力」都绕不开它。分层是刻意设计的：

```
Provider（厂商：baseURL + apiKey + AuthScheme + 一组 Service）
  └─ Service（厂商支持的一种协议，本质就是一个 Wire）
       └─ Wire（归一化的协议规格，决定 端点路径 + 请求体 + 响应/流解析）
            └─ Capability（这个协议实现的功能：chat/asr/embedding/image/video/tts/rerank）
ModelConfig（具体模型）── 挂到某个 Service 上，功能由 Service 推导
```

关键设计点：

- **「模型说什么协议」不是厂商级事实**——同一个 baseURL 下可以有多个模型各说不同协议。所以协议（`Wire`）挂在 `Service` 上，而不是 `Provider` 上。
- **用户从不手填 URL/路径**——只在 UI 里挑一个 `Wire`，端点路径由 `Wire.defaultPath` 固定；鉴权由 `Provider.auth`（`AuthScheme`：bearer / anthropic / api-key）决定。
- **新增一个协议** = 在 `Wire` 枚举加一个 case（含 `capability`/`defaultPath`/`applyProtocolHeaders`），再在对应调用点（`ChatClient` 或 `Transcriber`）加一个 adapter 分支。**只有真正实现了的协议才会出现在 UI**。
- **`Settings.resolve(model)` → `ResolvedModel`**：把模型 + 厂商凭证 + 服务端点打包成「可直接发起调用」的结构。所有网络调用都从 `ResolvedModel` 出发（`.url` 给端点，`.authorize(&req)` 加鉴权+协议头）。

### 容错解码与迁移（改 Settings 结构前必读）

配置以 JSON 持久化，schema 在演进，**绝不能因为字段变更丢用户数据**：

- `Settings.init(from:)` 对每个数组**独立解码**——一个集合损坏不会拖垮其它集合或重置成空默认值。
- `Provider` / `ModelConfig` 有自定义 `init(from:)` / `encode(to:)`：读取旧字段（provider 级的 `api`、model 级的 `kind`/`transport`）并迁移，但**不写回**。
- `SettingsStore.migrate(_:)` 做一次性清理：删空 baseURL 的脏 provider、按旧 `kind` 回填 `serviceID`、清理悬空的 active 选择。
- 改结构时请沿用这套模式：新字段用 `decodeIfPresent` + 默认值，旧字段保留 decode-only 路径。

### 持久化（`Persistence/`）

- **`SettingsStore`**：把 `Settings` 存为 `~/Library/Application Support/com.orbit.app/config.json`，写入**防抖 0.4s**（编辑文本框不会每次击键都落盘），`flush()` 在退出时强制写。热键变更走 `hotkeyDidChange` 立即广播给监听器。提供 `addProvider/removeModel/...` 等可变助手，让视图代码保持声明式。
- **`ChatStore`**：聊天会话当前**仅内存**（模型已 Codable，落盘是直接的后续工作）。它**复用 Settings 里选中的 LLM**（`llmModel`）——聊天和听写润色共用同一个模型，没有独立的聊天配置。
- API Key 目前**明文**存在 JSON 里（迁移到 Keychain 是 TODO）。

### 听写管线（`Dictation/`）

一条状态机串起：录音 → ASR →（可选）LLM 润色 →（可选）自动插入。

`HotkeyMonitor`（CGEventTap 全局热键，仅按 keycode）→ `DictationEngine`（`@MainActor` 状态机，首次按键开始录音、再次按键提交、✗ 取消）→ `AudioCapture`（`AVAudioEngine` 采集 + 降混重采样到 16k）→ `Transcriber`（按 `Wire` 分支：Whisper multipart / MiMo input_audio）→ 可选 `LLM` 润色（流式）→ `TextInserter`（写剪贴板 + 合成 ⌘V，再恢复原剪贴板——对中文和长文本最稳）。`PillController` 全程驱动底部悬浮胶囊（录音音量 / 润色扫光 / 完成确认）。每条结果都记入 `DictationHistoryStore`，胶囊消失也不丢转写。

### 网络层（`Networking/`，全部 `URLSession`）

- **`ChatClient.stream`**：流式聊天，按 `Wire` 分支构造请求体与解析 SSE（OpenAI Chat / OpenAI Responses / Anthropic Messages 都是 `data: {json}` 行，只是 body 和 chunk 形状不同）。
- **`ProviderAPI`**：设置页的轻量探针——`test`（探 `/models` 校验凭证）、`fetchModels`（拉取模型 id 列表）。
- **`Transcriber`**：ASR，同样按 `Wire` 分支（见听写管线）。

### 并发约定

`Package.swift` 用 Swift 6 工具链但**显式选择 Swift 5 语言模式**——这是一个充满 AppKit/SwiftUI 回调的 UI 应用，严格的 Swift 6 并发检查收益小、标注噪音大。核心对象（`AppDelegate` / `AppController` / `DictationEngine` / `ChatStore`）都是 `@MainActor` 隔离；音频线程的 PCM 帧用 `FrameSink`（`NSLock`）跨线程汇聚。

## 文档状态

`README.md`（英）与 `docs/README.zh-CN.md`（中）、`docs/ROADMAP.md` 部分内容可能滞后于代码（例如聊天界面、service 目录抽象是后加的）。改了对外行为时记得同步更新；以源码为准。
