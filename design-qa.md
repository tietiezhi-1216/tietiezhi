# Design QA — 官网余弦扫光明度优化
# Design QA — 余弦扫光明度优化

- source visual truth: `/Users/tietiezhi/.codex/visualizations/2026/07/18/019f74a2-91b9-79b2-8054-98d9b589d2b7/release-codex-cosine/codex-cosine-timeline.png`
- implementation desktop: `/Users/tietiezhi/.codex/visualizations/2026/07/18/019f74a2-91b9-79b2-8054-98d9b589d2b7/release-lighter-cosine/lighter-cosine-desktop.png`
- implementation mobile: `/Users/tietiezhi/.codex/visualizations/2026/07/18/019f74a2-91b9-79b2-8054-98d9b589d2b7/release-lighter-cosine/lighter-cosine-mobile.png`
- focused comparison: `/Users/tietiezhi/.codex/visualizations/2026/07/18/019f74a2-91b9-79b2-8054-98d9b589d2b7/release-lighter-cosine/compare-dark-vs-lighter.png`
- viewport: 1280 × 720 desktop; 390 × 844 mobile
- state: `v0.0.1`, sweep captured around 34% background position

## Full-view comparison evidence

Only the shadow opacity and neutral tone changed. Typography, layout, timing, starfield, mascot, and download controls remain identical.

## Focused region comparison evidence

The comparison shows the previous 82% black center above and the new 54% cool-charcoal center below. The lower version preserves a visible sweep while keeping glyph interiors readable instead of appearing erased.

## Findings

- No actionable P0/P1/P2 findings.

## Comparison history

- Earlier finding [P2]: the 82% black center was visually too dense and made the active characters look partially removed.
- Fix: changed the curve from 10/40/70/82/70/40/10% black to 7/27/46/54/46/27/7% cool charcoal (`rgb(12,14,18)`).
- Post-fix evidence: focused comparison shows clearly lighter character interiors with the same symmetric cosine falloff.

## Runtime checks

- Animation remains `title-shine 8.8s ease-in-out infinite`.
- Desktop and mobile have no horizontal overflow.
- Browser warnings/errors: none.
- Reduced-motion fallback remains enabled.
---

# Design QA — 桌面端功能与视觉验收
# Design QA

## Target

- Previous provider panel: `artifacts/provider-panel/builtin-provider-panel.png`
- Gateway mascot: `desktop/public/gateway/tietiezhi-gateway.webp`
- Current panel: `artifacts/gateway-panel/gateway-panel.png`
- Viewport: 1280 × 720

## Result

- Removed the “模型渠道” title, introductory copy, built-in badge, and Key messaging.
- Gateway appears first as `tietiezhi Gateway` with a dedicated octopus logo.
- Gateway has no management entry; “查看额度” opens a working mock quota dialog.
- “添加供应商” is aligned with “自定义供应商”.
- Empty custom-provider state remains clear without adding explanatory clutter.
- No P0/P1/P2 visual or interaction issues found.

## Checks

- Gateway logo remains legible at 48 px and uses a real raster asset.
- “查看额度” resolves uniquely and opens balance, daily usage, monthly usage, and request-count previews.
- `pnpm typecheck`: passed.
- `cargo test`: passed, 59 tests.

final result: passed

# Design QA — 应用文本选择边界

## Target

- Source visual truth: `/var/folders/dh/4xyy8_s111dfpk0msplz51_h0000gn/T/codex-clipboard-996e84f6-4bdd-4b38-bf7e-bd28651e9439.png`
- Browser-rendered implementation: `artifacts/selection-policy-browser.png`
- Full-view comparison: `artifacts/selection-policy-comparison.png`
- Focused comparison: `artifacts/selection-policy-focused-comparison.png`
- Viewport: 1280 × 720 implementation; source normalized into the comparison canvas
- State: dark theme, desktop chat with user message, assistant Markdown, code block, table, status area, and composer

## Findings

- No actionable P0/P1/P2 findings remain.
- Selection semantics: application chrome now defaults to `user-select: none`; the retry/stream status, mascot, model label, navigation, headers, buttons, and passive labels cannot be accidentally highlighted.
- Copyable content: user messages, assistant Markdown, assistant error text, tool arguments/output, error details, permission descriptions, and editable fields explicitly use `user-select: text`.
- Fonts and typography: unchanged; the selection policy introduces no font, weight, line-height, wrapping, or truncation drift.
- Spacing and layout rhythm: unchanged; no box dimensions, padding, margins, radii, or scroll behavior were modified.
- Colors and visual tokens: unchanged; the only visible color difference is the absence of accidental native blue selection over non-content UI.
- Image quality and asset fidelity: mascot and icon rendering are unchanged; disabling selection prevents the mascot canvas/raster from being included in drag selection.
- Copy and content: unchanged.

## Interaction And Technical Checks

- Browser-computed `user-select`: body `none`, status `none`, sampled buttons `none`, message/Markdown/code body `text`, code toolbar `none`, and textarea `text`.
- Message composer remained editable and the local mock message sent successfully.
- Markdown, fenced code, table, link, and status layout remained intact after the global policy change.
- Browser console warnings/errors: none.
- `pnpm typecheck`: passed.
- `pnpm build`: passed (existing bundle-size warning only).
- `git diff --check`: passed.

## Comparison History

- Source: dragging across the transient retry indicator selected the mascot and all status metadata as one blue text range.
- Fix: made the application shell non-selectable by default and added explicit selection opt-ins only to content with copy value.
- Post-fix evidence: the full and focused comparisons show no layout drift; browser-computed styles confirm the retry/status class inherits `none` while message and input content resolve to `text`.

## Follow-up Polish

- No P3 follow-up is required for this selection-policy pass.

final result: passed

# Design QA — 模型选中后的动画章鱼

## Target

- Source visual truth: `/var/folders/dh/4xyy8_s111dfpk0msplz51_h0000gn/T/codex-clipboard-c9791941-58b8-43a8-acd7-d36d1195ab95.png`
- Implementation screenshot: `artifacts/ready-animated-octopus-frame-1.png`
- Side-by-side comparison: `artifacts/ready-animated-octopus-comparison.png`
- State: dark theme, provider and model selected, empty new task
- Surface: macOS Tauri development app

## Findings

- No actionable P0/P1/P2 findings remain.
- State semantics: the channel-setup raster is now limited to loading, missing-channel, and choose-model states. The ready state renders the established animated `AppIconLoader` instead.
- Motion: the ready mascot restores blinking, gaze changes, floating props, and the existing idle motion while retaining the shared cyan/orange particle field.
- Spacing and alignment: the animated mascot keeps the existing 128 px hero slot and remains centered on the particle field and `开始新任务` title.
- Image quality and asset fidelity: the ready mascot uses the existing high-resolution animation frame assets; no replacement drawing or generated approximation was introduced.
- Reduced-motion behavior remains delegated to the existing loader and particle-field implementations.

## Interaction And Technical Checks

- Selected-model ready state renders the animated mascot instead of `/octopus-channel-setup/body.webp`: passed in the live Tauri app.
- Setup and choose-model states retain the channel-setup mascot through the component fallback: passed by code-path inspection.
- The shared particle canvas remains visible behind the animated mascot without clipping or overflow: passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed (existing bundle-size warning only).
- `git diff --check`: passed.

## Comparison History

- Source: the ready/new-task state incorrectly reused the disconnected channel-setup mascot.
- Fix: made the particle shell accept a centered mascot child and supplied `AppIconLoader` only in the ready state.
- Post-fix evidence: `artifacts/ready-animated-octopus-comparison.png` shows the disconnected source mascot on the left and the restored animated mascot on the right.

final result: passed

# Design QA — 章鱼光学居中

## Target

- Source visual truth: `/var/folders/dh/4xyy8_s111dfpk0msplz51_h0000gn/T/codex-clipboard-cf72ad5f-c5ba-4c3e-9e12-a7f2d65e717a.png`
- Implementation screenshot: `artifacts/home-mascot-optical-center.png`
- Focused side-by-side comparison: `artifacts/home-mascot-optical-center-comparison.png`
- State: dark theme, model-selection empty state, menu closed
- Surface: live macOS Tauri development app

## Findings

- No actionable P0/P1/P2 findings remain.
- Fonts and typography: the approved title remains unchanged and centered beneath the particle composition.
- Spacing and layout rhythm: alpha analysis found the visible mascot bounds centered 11 px right and 18.5 px below the 384 × 384 source canvas center. The raster now receives a proportional `-3%` X and `-7%` Y optical correction while the particle canvas and layout box remain mathematically centered.
- Colors and visual tokens: no color, glow, opacity, or particle-position changes were introduced.
- Image quality and asset fidelity: the original `body.webp` remains unscaled and uncropped; translation occurs inside the existing fixed image box, so sharpness and transparency are preserved.
- Copy and content: no text changes were introduced in this pass.

## Interaction And Technical Checks

- The corrected raster continues using the existing float/breathe animation and reduced-motion behavior.
- Ready-state and choose-model state share the same corrected mascot component.
- `pnpm typecheck`: passed.
- `pnpm build`: passed (existing bundle-size warning only).
- `git diff --check`: passed.

## Comparison History

- Earlier P2: the layout box was centered, but transparent padding and asymmetric props placed the visible mascot approximately 6 px right and 11–16 px low at the rendered 224 px size.
- Fix: applied an optical translation to the raster only, preserving the centered particle field and title anchors.
- Post-fix evidence: `artifacts/home-mascot-optical-center-comparison.png` shows the visible body aligned with the particle-field/title center axis without changing the surrounding composition.

final result: passed

# Design QA — 整句探索标题模型选择器

## Target

- Source visual truth: `/var/folders/dh/4xyy8_s111dfpk0msplz51_h0000gn/T/codex-clipboard-aba5e036-56c9-4396-ab46-c5188700038b.png`
- Approved copy: `选择和铁铁汁一起探索世界的方式`
- Closed-state implementation: `artifacts/home-model-title-explore-closed.png`
- Open-state implementation: `artifacts/home-model-title-explore-open.png`
- Full-view comparison: `artifacts/home-model-title-explore-comparison.png`
- Focused comparison: `artifacts/home-model-title-explore-focused.png`
- Surface: rebuilt macOS Tauri development app; application window 1320 × 860
- State: dark theme, no model selected; model menu checked both closed and open

## Findings

- No actionable P0/P1/P2 findings remain.
- Fonts and typography: the approved sentence is rendered as one uninterrupted 18 px semibold headline with the existing system font stack, tracking, antialiasing, and single-line truncation behavior.
- Spacing and layout rhythm: the entire sentence is one trigger with no internal model-label split, icon, border, or capsule. The popup remains centered on the complete sentence rather than on a substring.
- Colors and visual tokens: the base title uses 90% foreground and brightens on hover. A cyan highlight traverses the complete sentence over 5.6 seconds, with quiet dwell time before and after the sweep; reduced-motion mode removes the overlay animation.
- Image quality and asset fidelity: the existing mascot raster and particle composition remain untouched, sharp, and correctly layered behind the open popover.
- Copy and content: the title exactly matches the approved `选择和铁铁汁一起探索世界的方式`; no extra selector label or up/down icon remains.

## Interaction And Technical Checks

- Clicking the sentence opens the searchable grouped model menu: passed in the live Tauri app.
- Open and closed trigger states remain borderless and background-free: passed.
- The open panel stays centered above the complete title and may cover the mascot as intended: passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed (existing bundle-size warning only).

## Comparison History

- Earlier P2: the title was assembled from a lead phrase, cyan `AI` placeholder, and trailing phrase; the small center label and chevron made the sentence feel like separate UI fragments, and the 1.2-second sweep was too fast.
- Fix: replaced all fragments with one approved sentence, removed the chevron and model placeholder, expanded the masked highlight across the full title, and slowed the animation to 5.6 seconds with dwell intervals.
- Post-fix evidence: `artifacts/home-model-title-explore-focused.png` shows the old fragmented control beside the final uninterrupted headline while preserving the centered panel geometry.

final result: passed

# Design QA — 首页章鱼多帧动作

## Target

- Approved motion board: `/Users/tietiezhi/.codex/generated_images/019f7490-f502-7752-b25e-0bdd7e3aa901/exec-c623985c-32ee-4a44-aff2-40f119bba58c.png`
- Neutral implementation: `artifacts/home-multiframe-final.png`
- Live action implementation: `artifacts/home-multiframe-action.png`
- Compact-window implementation: `artifacts/home-multiframe-compact.png`
- Side-by-side comparison: `artifacts/home-multiframe-comparison.png`
- Viewports: 1280 × 720 and 900 × 600

## Findings

- No actionable P0/P1/P2 findings remain.
- The mascot now uses independent neutral, blink, curious-look, cable-wave, and happy-signal raster frames; settle is expressed by returning to neutral with a short eased overshoot.
- The random scheduler avoids immediately repeating the same action and combines frame changes with restrained squash, tilt, wave, and bounce transforms.
- Blink holds long enough to fully resolve after the 150 ms crossfade; reduced-motion mode remains on the neutral frame and disables the ambient motion.
- The mascot slot is 224 × 224 px, down from 288 × 288 px. Generated action frames include additional transparent padding so switching poses does not produce a visible scale jump.
- The approved board and live action capture were opened together. Character identity, cyan/orange palette, props, and pose intent remain aligned; the implementation is intentionally smaller to satisfy the requested homepage hierarchy.
- The 900 × 600 layout has no horizontal or vertical overflow, clipping, or control overlap.

## Interaction And Technical Checks

- Browser samples observed `neutral`, `wave`, `look`, and `signal` in one live random run; blink is also implemented as an independent frame with a 360 ms hold.
- Browser console warnings/errors: none.
- `pnpm typecheck`: passed.
- `pnpm build`: passed (existing bundle-size warning only).
- `git diff --check`: passed.

final result: passed

# Design QA — 首页模型选择空状态

## Target

- Source visual truth: `/Users/tietiezhi/.codex/generated_images/019f7490-f502-7752-b25e-0bdd7e3aa901/exec-617f4b0f-861a-466c-b5ee-e4c6d5ed0b05.png`
- Implementation screenshot: `artifacts/home-animation-final.png`
- Compact-window screenshot: `artifacts/home-animation-compact.png`
- Viewport: 1012 × 780; compact resilience check at 900 × 600
- State: dark theme, provider configured, 16 chat models available, no model selected
- Full-view comparison evidence: source visual and final browser capture were opened together and compared at the same aspect ratio.
- Focused comparison evidence: a separate crop was not needed because the source is a single centered empty-state composition and the mascot, copy, particles, and selector remain readable in the full-view comparison.

## Findings

- No actionable P0/P1/P2 findings remain.
- Fonts and typography: the system font stack, semibold 24 px heading, 14 px support copy, and compact helper text preserve the selected direction's hierarchy without conflicting with the surrounding app shell.
- Spacing and layout rhythm: the mascot/particle field, heading, support copy, selector, and helper text form one centered sequence with generous negative space; the 900 × 600 capture has no clipping or control overlap.
- Colors and visual tokens: elliptical guide lines and cyan/orange particles use restrained dark-theme contrast, while copy and controls continue to use the app's semantic foreground and border tokens.
- Image quality and asset fidelity: the implementation uses the original transparent octopus raster asset rather than the generated mock's redrawn mascot; no halos, stretching, or compression artifacts are visible.
- Copy and content: heading is `模型已到位，就等你选择`; model count remains dynamic, so the mock correctly shows 16 rather than hard-coding the concept image's 27; helper copy confirms later switching.
- Interaction and accessibility: the model picker opens from one uniquely named button, exposes its searchable combobox and grouped options, and reduced-motion behavior disables particle/gesture animation while retaining a static readable state.

## Comparison History

- Initial browser pass: `artifacts/home-animation-v1.png` showed the mascot, particle field, heading, and selector noticeably smaller than the selected visual direction (P2 scale/hierarchy drift).
- Fix: increased the particle field from 352 × 256 to 416 × 288, mascot from 224 to 288 px, heading from 20 to 24 px, and prominent selector from 32 to 40 px high.
- Post-fix evidence: `artifacts/home-animation-v2.png` and `artifacts/home-animation-final.png` restore the selected direction's visual weight while preserving the real sidebar and title bar.

## Interaction And Technical Checks

- Two browser frames captured 1.2 seconds apart differ, confirming live particle/body motion.
- Model selector opens and exposes the search field and grouped model options: passed.
- Browser console warnings/errors: none.
- Compact 900 × 600 layout: passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed after the final scale refinement (existing bundle-size warning only).
- `git diff --check`: passed.

## Follow-up Polish

- P3: the concept mock uses slightly heavier display typography, but the implementation intentionally retains the product's native system typography for consistency with the surrounding desktop shell.

final result: passed

# Design QA — 模型厂商图标

## Target

- Source visual truth: `/var/folders/dh/4xyy8_s111dfpk0msplz51_h0000gn/T/codex-clipboard-2433cc17-a06d-4a37-bc1a-1d4c6fcbefa3.png`
- Implementation: `desktop/src/features/chat/model-select.tsx`
- Implementation screenshots:
  - `.build/model-picker-qa/vendor-icons-top-after.png`
  - `.build/model-picker-qa/vendor-icons-bottom-after.png`
- Focused comparison: `.build/model-picker-qa/vendor-icons-comparison.png`
- Viewport: 1280 × 720; picker crop normalized to 386 × 434
- State: dark theme, model picker open, lower model groups visible

## Findings

- No P0/P1/P2 findings remain.
- Brand marks now precede every known model-family heading without changing the original row density, borders, search field, or model typography.
- The implementation reuses the same MIT-licensed LobeHub static SVG library and Agnes brand asset as the referenced sibling project. Unknown families use a neutral icon rather than an incorrect vendor logo.
- Fonts and typography: heading and model text sizes, weights, and monospace model IDs remain unchanged.
- Spacing and layout rhythm: 14 px icons and a 6 px heading gap preserve the existing compact group rhythm.
- Colors and visual tokens: colored brand marks remain legible on the existing dark popover; monochrome marks inherit the foreground color.
- Image quality and asset fidelity: vendor marks are source SVG assets, not approximated drawings or text glyphs.
- Copy and content: provider/family labels and model IDs are unchanged.

## Interaction And Technical Checks

- Model filtering with `deepseek`: passed; the filtered group retains its icon.
- Browser console errors: none.
- `pnpm typecheck`: passed.
- `pnpm build`: passed (existing bundle-size warning only).
- `git diff --check`: passed.

## Comparison History

- Initial source: group headings contained text only.
- Fix: added LobeHub brand SVG mappings for Claude, Codex, OpenAI, Gemini, DeepSeek, Qwen, Kimi, xAI, Meta, MiMo, and SenseNova; reused the sibling project's Agnes asset and added a neutral unknown-family fallback.
- Post-fix evidence: `.build/model-picker-qa/vendor-icons-comparison.png` shows aligned icon + heading pairs with no clipping or density regression.

final result: passed

# Design QA — 首页单贴图浮动与紧凑选择区

## Target

- Source visual truth: `/var/folders/dh/4xyy8_s111dfpk0msplz51_h0000gn/T/codex-clipboard-b1357413-6344-454d-a94d-c7dac5164bb9.png`
- Choose-model implementation: `artifacts/home-simple-float-choose-1012.png`
- Ready-state implementation: `artifacts/home-simple-float-ready.png`
- Full-view comparison: `artifacts/home-simple-float-comparison.png`
- Viewport: 1012 × 780 for the source comparison; 1280 × 720 for the ready-state extension
- State: dark theme, provider configured, no model selected; secondary check with a selected model and an empty conversation

## Findings

- No actionable P0/P1/P2 findings remain.
- Fonts and typography: the requested simplification reduces the selection area to one 18 px semibold prompt and the existing 14 px model control; the surrounding native system typography remains consistent.
- Spacing and layout rhythm: the former four-row title, description, selector, and helper stack is now one centered horizontal row. The source and implementation comparison makes the reduced height and simpler hierarchy directly visible.
- Colors and visual tokens: elliptical guide lines and cyan/orange particles retain the current semantic dark-theme contrast without introducing a new surface or border.
- Image quality and asset fidelity: only the original transparent `body.webp` mascot is rendered. The generated blink/look/wave/signal frames were removed, so there is no pose or scale discontinuity.
- Copy and content: the model-selection state is reduced to `选个模型，开始聊天`; the duplicate model-count description and later-switching helper were removed. The ready state is reduced to `开始新任务` because the chosen model remains visible in the composer.
- The same particle canvas and particles now appear in both the choose-model and ordinary ready/new-conversation states.

## Interaction And Technical Checks

- Seven browser samples over three seconds measured mascot Y positions from 246.4 px to 239.5 px and back, confirming the single raster has a continuous visible float rather than a static pose.
- The model selector resolves uniquely, opens, focuses its combobox, and displays grouped model options: passed.
- Ready-state particle field, mascot, title, project picker, and composer render without horizontal or vertical overflow: passed.
- Reduced-motion mode keeps the static mascot and particle composition while disabling the float and particle movement.
- Browser console warnings/errors: none.
- `pnpm typecheck`: passed.
- `pnpm build`: passed (existing bundle-size warning only).
- `git diff --check`: passed.

## Comparison History

- Source: the highlighted lower section used four vertically stacked rows and felt taller than the mascot treatment.
- Fix: removed multi-frame switching, increased the single-image float amplitude to 8 px with a slight ±0.75° sway, reused the particle composition in the ready state, and collapsed the model prompt and selector into one row.
- Post-fix evidence: `artifacts/home-simple-float-comparison.png` shows the requested density reduction at the same 1012 × 780 viewport; `artifacts/home-simple-float-ready.png` confirms the particle-field extension to ordinary new conversations.

## Follow-up Polish

- No P3 follow-up is required for this scoped simplification.

final result: passed

# Design QA — 首页无边框模型切换器

## Target

- Source visual truth: `/var/folders/dh/4xyy8_s111dfpk0msplz51_h0000gn/T/codex-clipboard-6e7e143f-a513-4d0c-861a-fe49049c7c74.png`
- Implementation screenshot: `artifacts/home-model-select-centered-open.png`
- Full-view comparison: `artifacts/home-model-select-centered-comparison.png`
- Focused comparison: `artifacts/home-model-select-centered-focused.png`
- State: dark theme, no model selected, model menu open above the compact title row
- Surface: rebuilt macOS Tauri development app; the application window is 1320 × 860

## Findings

- No actionable P0/P1/P2 findings remain.
- Fonts and typography: `选个模型，开始聊天` and `选择聊天模型` now share the same 18 px semibold typography and tracking; hierarchy comes only from the model label's cyan color.
- Motion: the model label reuses the existing 1.2 s masked sweep animation. Reduced-motion mode hides the animated overlay while retaining the cyan label.
- Spacing and layout rhythm: the entire title-and-model phrase is one borderless trigger. The title, 8 px inter-part gap, and 16 px up/down icon form one continuous line without the previous small capsule.
- Popover alignment: the full phrase is now the Popover anchor. In the focused comparison, the panel and full trigger have the same horizontal center to within approximately 1 px; the earlier right shift is gone.
- Colors and tokens: the trigger remains transparent in default, hover, focus, and open states. The model label and icon use the existing cyan palette; the menu surface and model-group styling are unchanged.
- Copy and content: the title and placeholder copy are unchanged from the supplied source. The non-prominent composer selector remains unchanged.

## Interaction And Technical Checks

- Clicking anywhere in the combined title trigger opens the model menu above it: passed in the rebuilt Tauri app.
- The menu opens without adding a trigger background or border: passed.
- Search input, grouped models, selected-row treatment, and scrolling remain visibly intact.
- The development process completed without runtime or Vite errors after rebuilding the native app.
- `pnpm typecheck`: passed.
- `pnpm build`: passed (existing bundle-size warning only).

## Comparison History

- Initial source: the title used 18 px semibold text, while the select used smaller 12 px text in a separate grey capsule. The popup was centered on that small select, leaving it visibly right of the full title group.
- Fix: moved the lead title into the prominent model trigger, matched the label typography, added a cyan masked sweep, and made the complete phrase the centered popover anchor.
- Post-fix evidence: `artifacts/home-model-select-centered-focused.png` shows the source and rebuilt implementation side by side; panel and title-group centers now coincide and the select reads as part of the same headline.

final result: passed
