# Design QA — Tietiezhi Download Glass Cards and Text Sweep

- source visual truth: `/Users/tietiezhi/.codex/visualizations/2026/07/18/019f74a2-91b9-79b2-8054-98d9b589d2b7/focus-home/before-download-glass-shine.png`
- implementation desktop: `/Users/tietiezhi/.codex/visualizations/2026/07/18/019f74a2-91b9-79b2-8054-98d9b589d2b7/focus-home/final-download-glass-desktop.png`
- implementation mobile: `/Users/tietiezhi/.codex/visualizations/2026/07/18/019f74a2-91b9-79b2-8054-98d9b589d2b7/focus-home/final-download-glass-mobile.png`
- full-view comparison: `/Users/tietiezhi/.codex/visualizations/2026/07/18/019f74a2-91b9-79b2-8054-98d9b589d2b7/focus-home/compare-download-glass-shine.png`
- viewports: 1280 × 720 desktop; 390 × 844 mobile
- state: GitHub `v0.0.1` data loaded; dark text sweep, page sweep, and star drift active

## Full-view comparison evidence

The side-by-side comparison preserves the selected single-screen hero, title scale, mascot crop, and minimal copy. The shared two-segment dock is replaced by two clearly isolated glass cards with equal visual weight, a 16 px desktop gap, and platform-specific icon tiles.

## Focused region comparison evidence

No extra crop is needed because the 1280 × 720 comparison clearly shows the complete title and download region. Motion sampling captured the title clip path at three distinct positions: approximately -14%, 43%, and 108%, visibly moving the dark-blue diagonal highlight across the solid-white title.

## Required fidelity surfaces

- Fonts and typography: the base `Tietiezhi Desktop` heading remains solid white and unchanged in size, weight, tracking, and wrapping. A separate aria-hidden dark-blue sweep crosses the glyphs without changing the accessible heading.
- Spacing and layout rhythm: the two download cards are independent, equal-width 328 px controls on desktop and stacked 350 × 80 px controls on mobile. Both layouts retain balanced bottom margins and no horizontal overflow.
- Colors and visual tokens: the new cards use 8% white glass, 20% white borders, 40 px backdrop blur, and restrained internal highlights consistent with the dark blue-violet hero.
- Image quality and asset fidelity: Apple and Windows 11 marks are local Simple Icons assets, rendered sharply at 20 px. Existing generated mascot, starfield, and page sweep assets retain their native crop and clarity.
- Copy and content: the minimal homepage copy is unchanged. Each download now adds only a compact format label (`Universal DMG` / `Windows x64`) and platform name.

## Findings

- No actionable P0/P1/P2 findings.
- No remaining P3 polish findings.

## Primary interactions and runtime checks

- macOS and Windows cards resolve to real `v0.0.1` GitHub Release assets.
- Apple and Windows icon assets both load at 150 × 150 intrinsic resolution.
- Both cards compute to `backdrop-filter: blur(40px)`.
- Title sweep clip path changes continuously across sampled frames.
- Desktop and 390 × 844 mobile layouts have no horizontal overflow.
- Browser console contains no warnings or errors.

## Comparison history

- Earlier finding [P1]: the white-on-white title gradient technically animated but was not visibly legible as a sweep.
- Fix: replaced it with a narrow, diagonal dark-blue text layer with a cyan edge glow, clipped and animated across the unchanged white heading.
- Post-fix evidence: three captured frames show the band at distinct positions while the clean final frame shows the heading returning fully white.
- Earlier finding [P2]: both downloads shared one combined dock and lacked platform identity.
- Fix: separated them into two independent frosted-glass cards and added local Apple and Windows 11 icons.
- Post-fix evidence: desktop comparison and mobile capture show clear separation, equal sizing, correct icons, and intact responsive spacing.

## Implementation checklist

- [x] Solid-white title preserved
- [x] Clearly visible dark text sweep added
- [x] Download controls separated into two glass cards
- [x] Apple and Windows platform icons added
- [x] Desktop and mobile verified
- [x] Release links verified
- [x] Console checked

final result: passed
