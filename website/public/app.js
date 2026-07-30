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
      "hero.title": `对话与图片创作的 <span class="${HL}">桌面 AI 工作台</span>`,
      "hero.desc": "登录 Tietiezhi Gateway 即可自动同步模型，也可以通过 AI SDK 连接 OpenAI、Anthropic、Google 与自定义兼容端点。在 Workspace 中运行 Agent，在 Create 中生成并管理图片。",
      "hero.cta1": "立即下载",
      "hero.cta2": "了解功能",
      "steps.title": "三步开始使用",
      "steps.1.t": "登录或接入模型",
      "steps.1.d": "登录 Tietiezhi Gateway 自动同步模型，或在供应商设置中填写自定义 Base URL 与 API Key。",
      "steps.2.t": "选择模型",
      "steps.2.d": "从已接入的各家模型中选择，随时按需切换。",
      "steps.3.t": "开始对话",
      "steps.3.d": "发送消息，实时流式返回，畅快交流。",
      "features.title": "功能特性",
      "features.1.t": "兼容各家模型",
      "features.1.d": "通过 AI SDK 接入 OpenAI、Anthropic、Google 与 OpenAI-compatible 端点，统一完成流式对话和模型切换。",
      "features.2.t": "密钥安全存储",
      "features.2.d": "中转站 Session 与 API Key 由 Electron safeStorage 使用系统安全能力加密，不明文落盘、不在界面展示。",
      "features.3.t": "Workspace 流式对话",
      "features.3.d": "创建和管理本地会话，实时显示模型输出，支持停止真实请求并在应用重启后恢复历史。",
      "features.4.t": "Create 图片生成",
      "features.4.d": "使用 AI SDK 原生图片接口设置 Prompt、模型、比例与数量，生成结果保存在本地资产库。",
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
      "faq.1.a": "Tietiezhi 是一个 Electron 桌面 AI 应用，提供 Workspace 文字对话和 Create 图片生成。",
      "faq.2.q": "支持哪些操作系统？",
      "faq.2.a": "目前支持 Windows 10 / 11 与 macOS 13.3 及以上（含 Apple 芯片与 Intel 芯片）。",
      "faq.3.q": "如何开始使用？",
      "faq.3.a": "下载安装后可直接登录 Tietiezhi Gateway，授权完成后模型会自动同步；也可以在供应商设置中接入自己的模型服务。",
      "faq.4.q": "我的 API Key 安全吗？",
      "faq.4.a": "安全。API Key 通过 Electron safeStorage 使用系统凭据能力加密，不会明文写入磁盘、回传或在界面展示。",
      "faq.5.q": "这是开源软件吗？",
      "faq.5.a": "是。铁铁汁基于 Apache License 2.0 开源，源代码与版本发布均托管在 GitHub。",
      "footer.tagline": "Workspace 对话 · Create 图片创作",
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
      "hero.title": `A desktop AI workspace for <span class="${HL}">chat and image creation</span>`,
      "hero.desc": "Sign in to Tietiezhi Gateway to sync models automatically, or connect OpenAI, Anthropic, Google, and compatible endpoints through the AI SDK. Run agents in Workspace and create local image assets in Create.",
      "hero.cta1": "Download now",
      "hero.cta2": "Explore features",
      "steps.title": "Get started in three steps",
      "steps.1.t": "Sign in or connect",
      "steps.1.d": "Sign in to Tietiezhi Gateway to sync models, or enter a custom Base URL and API key under Providers.",
      "steps.2.t": "Pick a model",
      "steps.2.d": "Choose from the connected models and switch anytime.",
      "steps.3.t": "Start chatting",
      "steps.3.d": "Send a message and watch replies stream back in real time.",
      "features.title": "Features",
      "features.1.t": "Every model, one interface",
      "features.1.d": "Connect OpenAI, Anthropic, Google, and OpenAI-compatible endpoints through one AI SDK engine.",
      "features.2.t": "Secure key storage",
      "features.2.d": "Gateway sessions and API keys are encrypted through Electron safeStorage and are never written to disk in plaintext or shown in the UI.",
      "features.3.t": "Streaming Workspace",
      "features.3.d": "Create local conversations, stream model output, cancel real requests, and restore history after restarting the app.",
      "features.4.t": "Create images",
      "features.4.d": "Choose a prompt, model, aspect ratio, and image count. Generated files stay in your local asset library.",
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
      "faq.1.a": "Tietiezhi is an Electron desktop AI app with a text Workspace and an AI image Create studio.",
      "faq.2.q": "Which operating systems are supported?",
      "faq.2.a": "Windows 10 / 11 and macOS 13.3+ (both Apple Silicon and Intel).",
      "faq.3.q": "How do I get started?",
      "faq.3.a": "After installing, sign in to Tietiezhi Gateway to sync models automatically, or connect your own model service under Providers.",
      "faq.4.q": "Is my API key safe?",
      "faq.4.a": "Yes. Electron safeStorage encrypts your API key with the operating system’s credential protection; it is never written in plaintext, sent back, or displayed.",
      "faq.5.q": "Is it open source?",
      "faq.5.a": "Yes. Tietiezhi is open source under the Apache License 2.0, with source code and releases hosted on GitHub.",
      "footer.tagline": "Workspace chat · Create images",
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
      "hero.desc": "Tietiezhi Gateway にログインするとモデルを自動同期できます。AI SDK 経由の各社モデル接続、Workspace の Agent、Create の画像生成をひとつの Electron アプリで提供します。",
      "hero.cta1": "今すぐダウンロード",
      "hero.cta2": "機能を見る",
      "steps.title": "3 ステップで始める",
      "steps.1.t": "ログインまたは接続",
      "steps.1.d": "Tietiezhi Gateway にログインしてモデルを同期するか、プロバイダー設定で Base URL と API キーを入力します。",
      "steps.2.t": "モデルを選択",
      "steps.2.d": "接続済みの各社モデルから選び、いつでも切り替え可能。",
      "steps.3.t": "チャットを開始",
      "steps.3.d": "メッセージを送信すると、リアルタイムでストリーミング表示されます。",
      "features.title": "機能",
      "features.1.t": "あらゆるモデルに対応",
      "features.1.d": "標準の <code>/v1/chat/completions</code> API に対応。baseURL と API キーを設定するだけで主要プロバイダーのモデルを端末に取り込め、追加の設定は不要です。",
      "features.2.t": "安全なキー保管",
      "features.2.d": "Gateway セッションと API キーは Electron safeStorage で暗号化され、平文保存や画面表示は行いません。",
      "features.3.t": "Workspace 対話",
      "features.3.d": "会話をローカルに保存し、モデル出力をリアルタイム表示。実際のリクエストを停止できます。",
      "features.4.t": "Create 画像生成",
      "features.4.d": "Prompt、モデル、比率、枚数を選択し、生成画像をローカル資産として保存します。",
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
      "faq.3.a": "インストール後に Tietiezhi Gateway へログインするとモデルが自動同期されます。独自のモデルサービスもプロバイダー設定から接続できます。",
      "faq.4.q": "API キーは安全ですか？",
      "faq.4.a": "安全です。API キーは Electron safeStorage と OS の資格情報保護機能で暗号化され、平文でディスクに書き込まれたり、送信・表示されたりすることはありません。",
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
      "hero.desc": "Tietiezhi Gateway에 로그인하면 모델이 자동으로 동기화됩니다. AI SDK 모델 연결, Workspace Agent, Create 이미지 생성을 하나의 Electron 앱에서 제공합니다.",
      "hero.cta1": "지금 다운로드",
      "hero.cta2": "기능 살펴보기",
      "steps.title": "세 단계로 시작하기",
      "steps.1.t": "로그인 또는 연결",
      "steps.1.d": "Tietiezhi Gateway에 로그인해 모델을 동기화하거나 공급자 설정에서 Base URL과 API 키를 입력합니다.",
      "steps.2.t": "모델 선택",
      "steps.2.d": "연결된 각 모델 중에서 선택하고 언제든 전환하세요.",
      "steps.3.t": "대화 시작",
      "steps.3.d": "메시지를 보내면 실시간 스트리밍으로 응답이 표시됩니다.",
      "features.title": "기능",
      "features.1.t": "모든 모델 호환",
      "features.1.d": "표준 <code>/v1/chat/completions</code> API를 지원합니다. baseURL과 API 키만 설정하면 주요 제공사의 모델을 터미널에 연결할 수 있으며 별도 설정이 필요 없습니다.",
      "features.2.t": "안전한 키 보관",
      "features.2.d": "Gateway 세션과 API 키는 Electron safeStorage로 암호화되며 디스크에 평문으로 저장하거나 화면에 표시하지 않습니다.",
      "features.3.t": "Workspace 대화",
      "features.3.d": "대화를 로컬에 저장하고 모델 출력을 실시간으로 표시하며 실제 요청을 중단할 수 있습니다.",
      "features.4.t": "Create 이미지 생성",
      "features.4.d": "Prompt, 모델, 비율, 수량을 선택하고 생성 이미지를 로컬 자산으로 보관합니다.",
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
      "faq.3.a": "설치 후 Tietiezhi Gateway에 로그인하면 모델이 자동으로 동기화됩니다. 공급자 설정에서 자체 모델 서비스도 연결할 수 있습니다.",
      "faq.4.q": "제 API 키는 안전한가요?",
      "faq.4.a": "안전합니다. API 키는 Electron safeStorage와 운영체제 자격 증명 보호 기능으로 암호화되며 평문으로 기록되거나 전송·표시되지 않습니다.",
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

    // 1) 通用平台下载字段
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
