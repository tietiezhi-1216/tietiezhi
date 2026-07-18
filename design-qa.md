# Design QA — Tietiezhi Desktop 文字扫光可见性修复

- source visual truth: `/Users/tietiezhi/.codex/visualizations/2026/07/18/019f74a2-91b9-79b2-8054-98d9b589d2b7/release-polish-visible/before-sweep-too-subtle.png`
- implementation desktop: `/Users/tietiezhi/.codex/visualizations/2026/07/18/019f74a2-91b9-79b2-8054-98d9b589d2b7/release-polish-visible/after-sweep-visible-desktop.png`
- implementation mobile: `/Users/tietiezhi/.codex/visualizations/2026/07/18/019f74a2-91b9-79b2-8054-98d9b589d2b7/release-polish-visible/after-sweep-visible-mobile.png`
- focused comparison: `/Users/tietiezhi/.codex/visualizations/2026/07/18/019f74a2-91b9-79b2-8054-98d9b589d2b7/release-polish-visible/compare-text-sweep-before-after.png`
- viewport: 1280 × 720 desktop; 390 × 844 mobile
- state: `v0.0.1`, title sweep sampled at approximately 71% background position

## Full-view comparison evidence

页面布局、标题尺寸、星空、角色图与下载卡片均保持不变。修复后只有文字内部出现青白紫高光，不产生深色遮挡。

## Focused region comparison evidence

组合对照图上半部分为修复前：动画层计算颜色为白色，整段标题没有可辨认的扫光。下半部分为修复后：`Tietiezhi` 中部出现清晰、连续且羽化的青白紫光带，底层白字仍保持完整。

## Findings

- No actionable P0/P1/P2 findings.

## Comparison history

- Earlier finding [P1]: `theme.colors` 覆盖了 Tailwind 默认颜色，却没有保留 `transparent`，导致 `text-transparent` 工具类未生成；动画位置持续变化，但覆盖层仍为纯白。
- Fix: 在项目颜色令牌中恢复 `transparent: "transparent"` 并重新生成 Tailwind CSS。
- Post-fix evidence: 浏览器计算颜色从 `rgb(255, 255, 255)` 变为 `rgba(0, 0, 0, 0)`；桌面与移动截图均能看到文字内的青白紫扫光。

## Runtime checks

- Desktop title: 656.14 × 80 px; no horizontal overflow.
- Mobile title: 275.48 × 33.59 px; no horizontal overflow.
- Animation name remains `title-shine` and background position changes over time.
- `text-transparent` is present in the generated CSS.
- Existing reduced-motion behavior remains intact.

final result: passed
