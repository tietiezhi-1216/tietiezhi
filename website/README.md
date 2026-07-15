# 铁铁汁官网（website/）

铁铁汁（Tietiezhi）的官方网站与**下载页**，纯静态站点（无框架）：Tailwind CSS v2 经 PostCSS 构建，一个 `app.js` 负责国际化、交互与下载区。部署到 `https://tietiezhi.xyz`。

> 与 `desktop/`（Tauri + React 应用）相互独立：这里是对外官网，不参与桌面端构建，也不受其 shadcn / Tailwind v4 规范约束。

## 目录

```
website/
├── public/
│   ├── index.html          # 单页官网（含 data-i18n 标记）
│   ├── app.js              # i18n（中/英/日/韩）+ 导航/FAQ 交互 + 下载区
│   └── dist/
│       ├── styles.css      # Tailwind 构建产物（勿手改）
│       └── assets/         # 图片、图标、章鱼 logo（tietiezhi-mark.png）
├── src/styles.css          # Tailwind 源样式（@tailwind + @layer 自定义）
├── tailwind.config.js
├── postcss.config.js
└── package.json
```

## 本地预览

纯静态，任意静态服务器即可：

```bash
cd website/public
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 修改样式后重新构建

`dist/styles.css` 是构建产物，**不要手改**。改了 HTML 类名或 `src/styles.css` 后重建：

```bash
cd website
npm install          # 首次
npm run build        # 开发构建（全量 CSS）
npm run prod         # 生产精简（purge），上线前用
```

> `npm run prod` 会按 `tailwind.config.js` 的 `purge` 精简。已把 `public/**/*.js` 纳入扫描，保住 `app.js` 里动态添加的类名（如 `opacity-40`、`pointer-events-none`）。

## 国际化

- 需翻译的文本在 HTML 上标注 `data-i18n="key"`（纯文本）或 `data-i18n-html="key"`（含标签，如 hero 标题、`<code>` 片段）。
- 文案字典在 `app.js` 的 `I18N`，语言：`zh-CN`（默认）、`en`、`ja`、`ko`。
- **默认固定简体中文，不跟随浏览器**；用户的选择存于 `localStorage["tietiezhi-lang"]`。
- **新增一种语言**：① 在 `SUPPORTED` 数组加语言码；② 在 `I18N` 加一份同 key 的字典；③ 在两处 `<select class="langSelect">`（桌面导航 + 移动菜单）各加一个 `<option>`。

## 下载区（对接 latest.json）

- `app.js` 顶部 `DL` 配置 `feedUrl`（`https://tietiezhi.xyz/latest.json`）与 `releases` 目录。
- `pickPlatformUrls / pickVersion / pickDate` 做**容错解析**，兼容三种结构：Tauri updater 风格（`platforms['darwin-aarch64'].url`）、显式 `downloads` 字段、GitHub-assets 数组（按 `.dmg / .exe / .msi` 扩展名匹配）。
- 拿到真实 `latest.json` 后，按其实际字段精简这几个函数即可，其余无需改动。
- **feed 不可达时兜底**：三个下载按钮指向 `releases/` 目录，并提示稍后重试，保证用户仍能找到安装包。

## 部署

把 `public/` 目录作为站点根发布到 `tietiezhi.xyz`（Caddy 静态托管）。上线前建议先 `npm run prod` 精简 CSS。
