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

final result: passed
