// 铁铁汁官网前端逻辑：i18n（中/英/日/韩，默认中文）、导航/FAQ 交互、下载区动态填充。
// 纯静态、无框架、无构建；直接被 index.html 以 <script defer> 引入。
(function () {
  "use strict";

  const LANG_KEY = "tietiezhi-lang";
  const SUPPORTED = ["zh-CN", "en", "ja", "ko"];
  // hero 标题里的高亮下划线样式（各语言共用，避免在字典里重复整串 class）
  const HL = "bg-underline1 bg-left-bottom bg-no-repeat pb-2 bg-100%";

  let currentLang = "zh-CN";
  let dlState = null; // null | "ok" | "partial" | "offline"

  // ---- GitHub Releases 下载源 ----
  const DL = {
    feedUrl: "https://api.github.com/repos/tietiezhi-1216/tietiezhi/releases?per_page=20",
    releases: "https://github.com/tietiezhi-1216/tietiezhi/releases",
  };

  // ---- 文案字典 ----
  const I18N = {
    "zh-CN": {
      "meta.title": "Tietiezhi · 下载",
      "nav.howitworks": "工作原理",
      "nav.features": "功能特性",
      "nav.download": "下载",
      "nav.faq": "常见问题",
      "nav.cta": "下载客户端",
      "hero.title": `连接每一个模型的 <span class="${HL}">智能体终端</span>`,
      "hero.desc": "铁铁汁把各家厂商的模型汇聚到一处——一个终端连接所有模型。智能体可以读写文件、执行命令、调用 MCP 工具，危险操作先征求你的批准。密钥由系统钥匙串守护，支持 Windows 与 macOS。",
      "hero.cta1": "立即下载",
      "hero.cta2": "了解功能",
      "steps.title": "三步开始使用",
      "steps.1.t": "接入模型",
      "steps.1.d": "在「接入配置」填入中转站 baseURL 与 API Key，一键测试连通，把各家模型接入终端。",
      "steps.2.t": "选择模型",
      "steps.2.d": "从已接入的各家模型中选择，随时按需切换。",
      "steps.3.t": "开始对话",
      "steps.3.d": "发送消息，实时流式返回，畅快交流。",
      "features.title": "功能特性",
      "features.1.t": "兼容各家模型",
      "features.1.d": "兼容 <code>/v1/chat/completions</code> 标准接口，填好 baseURL 与 API Key 即可把主流厂商的模型接入终端，无需额外适配。",
      "features.2.t": "密钥安全存储",
      "features.2.d": "API Key 存入系统钥匙串（macOS Keychain / Windows 凭据管理器），不明文落盘、不回传、不在界面展示。",
      "features.3.t": "智能体与内置工具",
      "features.3.d": "智能体可以读写文件、检索代码、执行命令、抓取网页，危险操作先征求你的批准；可创建多个智能体，各自带独立提示词、工具与权限模式。",
      "features.4.t": "Skills 与 MCP 扩展",
      "features.4.d": "按 Anthropic Skills 规范管理技能文档，模型按需加载；支持接入 MCP 服务器（本地命令或远程 HTTP），为智能体添加外部工具。",
      "download.title": "下载客户端",
      "download.desc": "选择你的平台，下载并安装铁铁汁。当前为测试版本，欢迎反馈。",
      "download.current": "当前版本",
      "download.mac_arm.name": "Apple 芯片",
      "download.mac_arm.req": "适用于 M 系列芯片 · 需 macOS 13.3 及以上",
      "download.mac_x64.name": "Intel 芯片",
      "download.mac_x64.req": "适用于 Intel 芯片 · 需 macOS 13.3 及以上",
      "download.win.name": "64 位",
      "download.win.req": "适用于 Windows 10 / 11 (x64)",
      "download.btn": "下载",
      "download.more": "查看历史版本",
      "download.unknown": "未知",
      "download.hint_offline": "暂时无法获取最新版本，下载按钮已指向 releases 目录，请稍后重试。",
      "download.hint_parsefail": "部分平台的下载暂不可用，请前往 releases 目录查看。",
      "faq.title": "常见问题",
      "faq.1.q": "铁铁汁是什么？",
      "faq.1.a": "铁铁汁是一个连接各家 AI 模型的枢纽与智能体终端：在一处接入不同厂商的模型、统一发起对话，并持续演进出 Agent 与多模态能力。",
      "faq.2.q": "支持哪些操作系统？",
      "faq.2.a": "目前支持 Windows 10 / 11 与 macOS 13.3 及以上（含 Apple 芯片与 Intel 芯片）。",
      "faq.3.q": "如何开始使用？",
      "faq.3.a": "下载安装后，在「接入配置」中填入中转站的 baseURL 与 API Key，测试连通后即可在聊天页使用。",
      "faq.4.q": "我的 API Key 安全吗？",
      "faq.4.a": "安全。API Key 仅保存在系统钥匙串中，不会明文写入磁盘，也不会回传或在界面展示。",
      "faq.5.q": "这是开源软件吗？",
      "faq.5.a": "是。铁铁汁基于 Apache License 2.0 开源，源代码与版本发布均托管在 GitHub。",
      "footer.tagline": "连接各家模型的智能体终端 · 面向万物互联",
      "footer.rights": "© 2026 铁铁汁 Tietiezhi. 保留所有权利。",
      "shot.tagline": "智能体终端 · 模型枢纽",
      "shot.new": "✎ 新对话",
      "shot.history": "对话记录",
      "shot.conv1": "重构登录模块",
      "shot.conv2": "整理产品需求文档",
      "shot.conv3": "周报速写",
      "shot.settings": "⚙ 设置",
      "shot.agent": "🤖 编码助手",
      "shot.workspace": "📁 my-project",
      "shot.user": "帮我把登录逻辑拆成独立模块并跑一下测试",
      "shot.done": "完成",
      "shot.running": "运行中",
      "shot.perm": "🛡 需要你的许可 — 执行命令：pnpm test",
      "shot.allow": "允许一次",
      "shot.always": "本会话始终允许",
      "shot.deny": "拒绝",
      "shot.input": "输入消息…",
    },
    en: {
      "meta.title": "Tietiezhi — An Agent Terminal for Every Model",
      "nav.howitworks": "How it works",
      "nav.features": "Features",
      "nav.download": "Download",
      "nav.faq": "FAQ",
      "nav.cta": "Download app",
      "hero.title": `The <span class="${HL}">agent terminal</span> that connects every model`,
      "hero.desc": "Tietiezhi brings models from every provider into one terminal. Agents can read and write files, run commands, and call MCP tools — risky actions always ask for your approval first. Keys stay in your system keychain. Available for Windows and macOS.",
      "hero.cta1": "Download now",
      "hero.cta2": "Explore features",
      "steps.title": "Get started in three steps",
      "steps.1.t": "Connect a model",
      "steps.1.d": "Under “Provider”, enter the gateway baseURL and API Key, test the connection in one click, and bring each model into your terminal.",
      "steps.2.t": "Pick a model",
      "steps.2.d": "Choose from the connected models and switch anytime.",
      "steps.3.t": "Start chatting",
      "steps.3.d": "Send a message and watch replies stream back in real time.",
      "features.title": "Features",
      "features.1.t": "Every model, one interface",
      "features.1.d": "Works with the standard <code>/v1/chat/completions</code> API — just set baseURL and API Key to bring models from major providers into the terminal, no extra adapters.",
      "features.2.t": "Secure key storage",
      "features.2.d": "API keys live in your system keychain (macOS Keychain / Windows Credential Manager) — never on disk, never sent back, never shown.",
      "features.3.t": "Agents with built-in tools",
      "features.3.d": "Agents read and write files, search code, run commands, and fetch the web — risky actions ask for your approval. Create multiple agents, each with its own prompt, tools, and permission mode.",
      "features.4.t": "Skills & MCP extensions",
      "features.4.d": "Manage skill documents per the Anthropic Skills spec, loaded on demand; connect MCP servers (local command or remote HTTP) to give agents external tools.",
      "download.title": "Download",
      "download.desc": "Pick your platform and install Tietiezhi. This is a preview build — feedback welcome.",
      "download.current": "Current version",
      "download.mac_arm.name": "Apple Silicon",
      "download.mac_arm.req": "For M-series chips · macOS 13.3+",
      "download.mac_x64.name": "Intel",
      "download.mac_x64.req": "For Intel chips · macOS 13.3+",
      "download.win.name": "64-bit",
      "download.win.req": "For Windows 10 / 11 (x64)",
      "download.btn": "Download",
      "download.more": "Browse all versions",
      "download.unknown": "Unknown",
      "download.hint_offline": "Couldn’t fetch the latest version right now — the buttons link to the releases folder. Please try again later.",
      "download.hint_parsefail": "Some downloads aren’t available yet. Please check the releases folder.",
      "faq.title": "FAQ",
      "faq.1.q": "What is Tietiezhi?",
      "faq.1.a": "Tietiezhi is a hub and agent terminal for AI models across providers: connect different models in one place, chat through a single interface, with agents and multimodal capabilities on the way.",
      "faq.2.q": "Which operating systems are supported?",
      "faq.2.a": "Windows 10 / 11 and macOS 13.3+ (both Apple Silicon and Intel).",
      "faq.3.q": "How do I get started?",
      "faq.3.a": "After installing, enter your gateway’s baseURL and API Key under “Provider”, test the connection, and start chatting.",
      "faq.4.q": "Is my API key safe?",
      "faq.4.a": "Yes. Your API key is stored only in the system keychain — never written to disk in plaintext, sent back, or displayed.",
      "faq.5.q": "Is it open source?",
      "faq.5.a": "Yes. Tietiezhi is open source under the Apache License 2.0, with source code and releases hosted on GitHub.",
      "footer.tagline": "An agent terminal that connects every model · built for universal connectivity",
      "footer.rights": "© 2026 Tietiezhi. All rights reserved.",
      "shot.tagline": "Agent terminal · Model hub",
      "shot.new": "✎ New chat",
      "shot.history": "History",
      "shot.conv1": "Refactor login module",
      "shot.conv2": "Organize product specs",
      "shot.conv3": "Weekly report draft",
      "shot.settings": "⚙ Settings",
      "shot.agent": "🤖 Coding agent",
      "shot.workspace": "📁 my-project",
      "shot.user": "Split the login logic into its own module and run the tests",
      "shot.done": "Done",
      "shot.running": "Running",
      "shot.perm": "🛡 Permission needed — run command: pnpm test",
      "shot.allow": "Allow once",
      "shot.always": "Always allow",
      "shot.deny": "Deny",
      "shot.input": "Type a message…",
    },
    ja: {
      "meta.title": "Tietiezhi — あらゆるモデルをつなぐエージェント端末",
      "nav.howitworks": "使い方",
      "nav.features": "機能",
      "nav.download": "ダウンロード",
      "nav.faq": "よくある質問",
      "nav.cta": "ダウンロード",
      "hero.title": `あらゆるモデルをつなぐ <span class="${HL}">エージェント端末</span>`,
      "hero.desc": "Tietiezhi は各社のモデルをひとつの端末に集約します。エージェントはファイルの読み書き・コマンド実行・MCP ツールの呼び出しができ、危険な操作は必ず事前に承認を求めます。キーはシステムのキーチェーンで保護。Windows と macOS に対応。",
      "hero.cta1": "今すぐダウンロード",
      "hero.cta2": "機能を見る",
      "steps.title": "3 ステップで始める",
      "steps.1.t": "モデルを接続",
      "steps.1.d": "「接続設定」で中継サーバーの baseURL と API キーを入力し、ワンクリックで接続テスト。各社のモデルを端末に取り込みます。",
      "steps.2.t": "モデルを選択",
      "steps.2.d": "接続済みの各社モデルから選び、いつでも切り替え可能。",
      "steps.3.t": "チャットを開始",
      "steps.3.d": "メッセージを送信すると、リアルタイムでストリーミング表示されます。",
      "features.title": "機能",
      "features.1.t": "あらゆるモデルに対応",
      "features.1.d": "標準の <code>/v1/chat/completions</code> API に対応。baseURL と API キーを設定するだけで主要プロバイダーのモデルを端末に取り込め、追加の設定は不要です。",
      "features.2.t": "安全なキー保管",
      "features.2.d": "API キーはシステムのキーチェーン（macOS Keychain / Windows 資格情報マネージャー）に保存。ディスクへの平文保存や送信、画面表示は行いません。",
      "features.3.t": "エージェントと内蔵ツール",
      "features.3.d": "エージェントはファイルの読み書き、コード検索、コマンド実行、Web 取得が可能。危険な操作は承認を求めます。プロンプト・ツール・権限モードを個別に持つ複数のエージェントを作成できます。",
      "features.4.t": "Skills と MCP 拡張",
      "features.4.d": "Anthropic Skills 仕様に沿ってスキル文書を管理し、必要時にのみ読み込み。MCP サーバー（ローカルコマンド / リモート HTTP）を接続して外部ツールを追加できます。",
      "download.title": "ダウンロード",
      "download.desc": "プラットフォームを選んで Tietiezhi をインストール。現在はプレビュー版です。フィードバック歓迎。",
      "download.current": "現在のバージョン",
      "download.mac_arm.name": "Apple シリコン",
      "download.mac_arm.req": "M シリーズチップ用 · macOS 13.3 以降",
      "download.mac_x64.name": "Intel",
      "download.mac_x64.req": "Intel チップ用 · macOS 13.3 以降",
      "download.win.name": "64 ビット",
      "download.win.req": "Windows 10 / 11 (x64) 用",
      "download.btn": "ダウンロード",
      "download.more": "すべてのバージョンを見る",
      "download.unknown": "不明",
      "download.hint_offline": "最新バージョンを取得できませんでした。ボタンはリリースフォルダーにリンクしています。後ほど再度お試しください。",
      "download.hint_parsefail": "一部のダウンロードはまだ利用できません。リリースフォルダーをご確認ください。",
      "faq.title": "よくある質問",
      "faq.1.q": "Tietiezhi とは？",
      "faq.1.a": "Tietiezhi は各社の AI モデルをつなぐハブでありエージェント端末です。さまざまなモデルを一箇所で接続し、単一の画面で対話でき、エージェントやマルチモーダル機能も今後拡張予定です。",
      "faq.2.q": "対応 OS は？",
      "faq.2.a": "Windows 10 / 11 と macOS 13.3 以降（Apple シリコンおよび Intel）に対応しています。",
      "faq.3.q": "使い始めるには？",
      "faq.3.a": "インストール後、「接続設定」で中継サーバーの baseURL と API キーを入力し、接続テストをしてからチャットを開始します。",
      "faq.4.q": "API キーは安全ですか？",
      "faq.4.a": "安全です。API キーはシステムのキーチェーンにのみ保存され、平文でディスクに書き込まれることも、送信・表示されることもありません。",
      "faq.5.q": "オープンソースですか？",
      "faq.5.a": "はい。Tietiezhi は Apache License 2.0 のもとでオープンソースとして公開され、ソースコードとリリースは GitHub で管理されています。",
      "footer.tagline": "あらゆるモデルをつなぐエージェント端末 · 万物接続へ",
      "footer.rights": "© 2026 Tietiezhi. All rights reserved.",
      "shot.tagline": "エージェント端末 · モデルハブ",
      "shot.new": "✎ 新しいチャット",
      "shot.history": "履歴",
      "shot.conv1": "ログインモジュールを再構築",
      "shot.conv2": "要件ドキュメントの整理",
      "shot.conv3": "週報ドラフト",
      "shot.settings": "⚙ 設定",
      "shot.agent": "🤖 コーディング",
      "shot.workspace": "📁 my-project",
      "shot.user": "ログイン処理を独立モジュールに分割してテストを実行して",
      "shot.done": "完了",
      "shot.running": "実行中",
      "shot.perm": "🛡 承認が必要 — コマンド実行：pnpm test",
      "shot.allow": "1回許可",
      "shot.always": "常に許可",
      "shot.deny": "拒否",
      "shot.input": "メッセージを入力…",
    },
    ko: {
      "meta.title": "Tietiezhi — 모든 모델을 잇는 에이전트 터미널",
      "nav.howitworks": "사용 방법",
      "nav.features": "기능",
      "nav.download": "다운로드",
      "nav.faq": "자주 묻는 질문",
      "nav.cta": "다운로드",
      "hero.title": `모든 모델을 잇는 <span class="${HL}">에이전트 터미널</span>`,
      "hero.desc": "Tietiezhi는 여러 공급사의 모델을 하나의 터미널로 모읍니다. 에이전트는 파일 읽기·쓰기, 명령 실행, MCP 도구 호출이 가능하며 위험한 작업은 항상 먼저 승인을 요청합니다. 키는 시스템 키체인에 안전하게 보관됩니다. Windows와 macOS 지원.",
      "hero.cta1": "지금 다운로드",
      "hero.cta2": "기능 살펴보기",
      "steps.title": "세 단계로 시작하기",
      "steps.1.t": "모델 연결",
      "steps.1.d": "‘접속 설정’에서 중계 서버의 baseURL과 API 키를 입력하고 원클릭으로 연결 테스트한 뒤, 각 모델을 터미널에 연결합니다.",
      "steps.2.t": "모델 선택",
      "steps.2.d": "연결된 각 모델 중에서 선택하고 언제든 전환하세요.",
      "steps.3.t": "대화 시작",
      "steps.3.d": "메시지를 보내면 실시간 스트리밍으로 응답이 표시됩니다.",
      "features.title": "기능",
      "features.1.t": "모든 모델 호환",
      "features.1.d": "표준 <code>/v1/chat/completions</code> API를 지원합니다. baseURL과 API 키만 설정하면 주요 제공사의 모델을 터미널에 연결할 수 있으며 별도 설정이 필요 없습니다.",
      "features.2.t": "안전한 키 보관",
      "features.2.d": "API 키는 시스템 키체인(macOS Keychain / Windows 자격 증명 관리자)에 저장되며, 디스크에 평문으로 저장하거나 전송·표시하지 않습니다.",
      "features.3.t": "에이전트와 내장 도구",
      "features.3.d": "에이전트가 파일을 읽고 쓰고, 코드를 검색하고, 명령을 실행하고, 웹을 가져옵니다. 위험한 작업은 승인을 요청하며, 프롬프트·도구·권한 모드를 각각 가진 여러 에이전트를 만들 수 있습니다.",
      "features.4.t": "Skills & MCP 확장",
      "features.4.d": "Anthropic Skills 규격에 따라 스킬 문서를 관리하고 필요할 때만 로드합니다. MCP 서버(로컬 명령 또는 원격 HTTP)를 연결해 외부 도구를 추가할 수 있습니다.",
      "download.title": "다운로드",
      "download.desc": "플랫폼을 선택하여 Tietiezhi를 설치하세요. 현재 프리뷰 버전이며 피드백을 환영합니다.",
      "download.current": "현재 버전",
      "download.mac_arm.name": "Apple 실리콘",
      "download.mac_arm.req": "M 시리즈 칩용 · macOS 13.3 이상",
      "download.mac_x64.name": "Intel",
      "download.mac_x64.req": "Intel 칩용 · macOS 13.3 이상",
      "download.win.name": "64비트",
      "download.win.req": "Windows 10 / 11 (x64)용",
      "download.btn": "다운로드",
      "download.more": "모든 버전 보기",
      "download.unknown": "알 수 없음",
      "download.hint_offline": "지금 최신 버전을 가져올 수 없습니다. 버튼은 릴리스 폴더로 연결됩니다. 나중에 다시 시도해 주세요.",
      "download.hint_parsefail": "일부 다운로드를 아직 사용할 수 없습니다. 릴리스 폴더를 확인해 주세요.",
      "faq.title": "자주 묻는 질문",
      "faq.1.q": "Tietiezhi란?",
      "faq.1.a": "Tietiezhi는 여러 제공사의 AI 모델을 잇는 허브이자 에이전트 터미널입니다. 다양한 모델을 한곳에서 연결하고 단일 화면에서 대화하며, 에이전트와 멀티모달 기능도 계속 확장될 예정입니다.",
      "faq.2.q": "어떤 운영체제를 지원하나요?",
      "faq.2.a": "Windows 10 / 11과 macOS 13.3 이상(Apple 실리콘 및 Intel)을 지원합니다.",
      "faq.3.q": "어떻게 시작하나요?",
      "faq.3.a": "설치 후 ‘접속 설정’에서 중계 서버의 baseURL과 API 키를 입력하고 연결을 테스트한 뒤 채팅을 시작하세요.",
      "faq.4.q": "제 API 키는 안전한가요?",
      "faq.4.a": "안전합니다. API 키는 시스템 키체인에만 저장되며 평문으로 디스크에 기록되거나 전송·표시되지 않습니다.",
      "faq.5.q": "오픈소스인가요?",
      "faq.5.a": "네. Tietiezhi는 Apache License 2.0으로 공개된 오픈소스이며, 소스 코드와 릴리스는 GitHub에서 관리됩니다.",
      "footer.tagline": "모든 모델을 잇는 에이전트 터미널 · 만물 연결을 향해",
      "footer.rights": "© 2026 Tietiezhi. All rights reserved.",
      "shot.tagline": "에이전트 터미널 · 모델 허브",
      "shot.new": "✎ 새 대화",
      "shot.history": "대화 기록",
      "shot.conv1": "로그인 모듈 리팩터링",
      "shot.conv2": "제품 요구사항 정리",
      "shot.conv3": "주간 보고 초안",
      "shot.settings": "⚙ 설정",
      "shot.agent": "🤖 코딩 에이전트",
      "shot.workspace": "📁 my-project",
      "shot.user": "로그인 로직을 독립 모듈로 분리하고 테스트 실행해 줘",
      "shot.done": "완료",
      "shot.running": "실행 중",
      "shot.perm": "🛡 승인 필요 — 명령 실행: pnpm test",
      "shot.allow": "한 번 허용",
      "shot.always": "항상 허용",
      "shot.deny": "거부",
      "shot.input": "메시지 입력…",
    },
  };

  function t(key) {
    const dict = I18N[currentLang] || I18N["zh-CN"];
    return dict[key];
  }

  // ---- i18n 应用 ----
  function applyLang(lang) {
    if (!SUPPORTED.includes(lang)) lang = "zh-CN";
    currentLang = lang;
    const dict = I18N[lang];
    document.documentElement.lang = lang;
    if (dict["meta.title"]) document.title = dict["meta.title"];

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const v = dict[el.getAttribute("data-i18n")];
      if (v != null) el.textContent = v;
    });
    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const v = dict[el.getAttribute("data-i18n-html")];
      if (v != null) el.innerHTML = v;
    });
    document.querySelectorAll(".langSelect").forEach((sel) => {
      sel.value = lang;
    });
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch (e) {
      /* localStorage 不可用时忽略 */
    }
    renderDlHint();
  }

  // ---- 下载区 ----
  function isAbs(u) {
    return /^https?:\/\//i.test(u);
  }
  function absolutize(u) {
    if (!u) return null;
    if (isAbs(u)) return u;
    return DL.releases.replace(/\/$/, "") + "/" + String(u).replace(/^\//, "");
  }

  // 从多种可能的 feed 结构中提取版本、日期与各平台下载 URL（真实结构确认后按需精简）
  function pickVersion(d) {
    return d.version || d.tag_name || d.tag || d.name || "";
  }
  function pickDate(d) {
    return d.pub_date || d.published_at || d.date || d.releaseDate || "";
  }
  function pickPlatformUrls(d) {
    const out = { mac_arm: null, mac_x64: null, win: null };
    if (!d || typeof d !== "object") return out;

    // 1) Tauri updater 风格：platforms['darwin-aarch64'].url
    const p = d.platforms || d.platform;
    if (p && typeof p === "object") {
      const g = (k) => (p[k] && (p[k].url || p[k])) || null;
      out.mac_arm = g("darwin-aarch64") || g("macos-aarch64");
      out.mac_x64 = g("darwin-x86_64") || g("macos-x86_64");
      out.win = g("windows-x86_64") || g("windows-x64");
    }
    // 2) 显式 downloads 字段
    const dl = d.downloads;
    if (dl && typeof dl === "object") {
      out.mac_arm = out.mac_arm || dl.macArm || dl.mac_arm || dl.mac_aarch64 || dl.dmg_arm64 || null;
      out.mac_x64 = out.mac_x64 || dl.macIntel || dl.mac_x64 || dl.mac_x86_64 || dl.dmg_x64 || null;
      out.win = out.win || dl.windows || dl.win || dl.win_x64 || dl.nsis || dl.exe || null;
    }
    // 3) GitHub Release assets，按文件名与扩展名匹配
    const assets = d.assets || d.files;
    if (Array.isArray(assets)) {
      assets.forEach((a) => {
        const url = typeof a === "string" ? a : a.browser_download_url || a.url || a.download_url || "";
        const name = (typeof a === "string" ? a : a.name || a.url || "").toLowerCase();
        if (!url) return;
        if (name.endsWith(".dmg") && /universal/.test(name)) {
          out.mac_arm = out.mac_arm || url;
          out.mac_x64 = out.mac_x64 || url;
        } else if (name.endsWith(".dmg") && /(aarch64|arm64|apple|silicon)/.test(name)) out.mac_arm = out.mac_arm || url;
        else if (name.endsWith(".dmg")) out.mac_x64 = out.mac_x64 || url;
        else if (
          name.endsWith(".exe") ||
          name.endsWith(".msi") ||
          name.includes("setup") ||
          (name.endsWith(".zip") && /windows|win-x64|win64/.test(name))
        ) out.win = out.win || url;
      });
    }
    return out;
  }

  function formatDate(s) {
    const d = new Date(s);
    if (isNaN(d.getTime())) return String(s).slice(0, 10);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function setBtn(id, url) {
    const el = document.getElementById(id);
    if (!el) return;
    if (url) {
      el.setAttribute("href", url);
      el.classList.remove("opacity-40", "pointer-events-none");
    } else {
      el.removeAttribute("href");
      el.classList.add("opacity-40", "pointer-events-none");
    }
  }

  function renderDlHint() {
    const hint = document.getElementById("dlHint");
    const ver = document.getElementById("dlVersion");
    if (!hint) return;
    if (dlState === "offline") {
      hint.textContent = t("download.hint_offline");
      if (ver) ver.textContent = t("download.unknown");
    } else if (dlState === "partial") {
      hint.textContent = t("download.hint_parsefail");
    } else {
      hint.textContent = "";
    }
  }

  async function loadDownloads() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let res;
      try {
        res = await fetch(DL.feedUrl, { cache: "no-store", signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const payload = await res.json();
      const data = Array.isArray(payload)
        ? payload.find((release) => !release.draft && pickPlatformUrls(release).mac_arm)
        : payload;
      if (!data) throw new Error("没有可用的 GitHub Release");
      const version = pickVersion(data);
      const date = pickDate(data);
      const urls = pickPlatformUrls(data);

      const ver = document.getElementById("dlVersion");
      if (ver && version) ver.textContent = "v" + String(version).replace(/^v/i, "");
      const dEl = document.getElementById("dlDate");
      if (dEl && date) dEl.textContent = formatDate(date);

      setBtn("dlMacArm", absolutize(urls.mac_arm));
      setBtn("dlMacX64", absolutize(urls.mac_x64));
      setBtn("dlWin", absolutize(urls.win));

      const allPresent = urls.mac_arm && urls.mac_x64 && urls.win;
      dlState = allPresent ? "ok" : "partial";
    } catch (e) {
      // 兜底：feed 不可达时，按钮指向 releases 目录，仍可让用户找到安装包
      ["dlMacArm", "dlMacX64", "dlWin"].forEach((id) => setBtn(id, DL.releases));
      dlState = "offline";
    }
    renderDlHint();
  }

  // ---- 导航与 FAQ 交互 ----
  function initInteractions() {
    const mobileNav = document.getElementById("mobileNav");
    const showMenu = document.getElementById("showMenu");
    const hideMenu = document.getElementById("hideMenu");
    if (showMenu && mobileNav) showMenu.addEventListener("click", () => mobileNav.classList.remove("hidden"));
    if (hideMenu && mobileNav) hideMenu.addEventListener("click", () => mobileNav.classList.add("hidden"));
    // 移动端点导航项后自动收起菜单
    if (mobileNav) {
      mobileNav.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => mobileNav.classList.add("hidden")));
    }

    document.querySelectorAll("[toggleElement]").forEach((toggle) => {
      toggle.addEventListener("click", () => {
        const answer = toggle.querySelector("[answer]");
        const caret = toggle.querySelector("img");
        if (!answer) return;
        answer.classList.toggle("hidden");
        if (caret) caret.classList.toggle("rotate-90");
      });
    });

    document.querySelectorAll(".langSelect").forEach((sel) => {
      sel.addEventListener("change", (e) => applyLang(e.target.value));
    });
  }

  // ---- 启动 ----
  function init() {
    let saved = null;
    try {
      saved = localStorage.getItem(LANG_KEY);
    } catch (e) {
      /* ignore */
    }
    // 默认中文：无有效历史选择时固定 zh-CN，不跟随浏览器语言
    applyLang(SUPPORTED.includes(saved) ? saved : "zh-CN");
    initInteractions();
    loadDownloads();
  }

  init();
})();
