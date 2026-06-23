# Design

## Visual Theme

**AI Telemetry · Dark Operations Surface · Living Canvas**

物理场景：Surface Go 10 寸屏放在开发者侧边，环境光从白天办公到夜间弱光都有。界面需要在远距扫视时像一块稳定的遥测仪器，在近距操作时像成熟的桌面工具。

主题方向：深色操作台、低噪声背景、分层光感、Canvas 数据流、克制但明确的状态色。旧构成主义视觉规则已废弃，不再约束新实现。

## Color

新默认主题使用 OKLCH 语义 token。允许柔和光感、局部渐变和圆角，但必须服务信息层级与状态表达。

```css
:root {
  --surface-base: oklch(14% 0.015 250);
  --surface-panel: oklch(19% 0.018 250);
  --surface-panel-2: oklch(23% 0.022 250);
  --surface-elevated: oklch(28% 0.025 250);
  --surface-line: oklch(38% 0.035 250);

  --text-primary: oklch(93% 0.008 250);
  --text-secondary: oklch(73% 0.018 250);
  --text-muted: oklch(58% 0.02 250);

  --signal-primary: oklch(72% 0.16 205);
  --signal-ai: oklch(76% 0.17 305);
  --signal-system: oklch(74% 0.15 155);
  --signal-warn: oklch(82% 0.16 85);
  --signal-danger: oklch(66% 0.2 25);

  --chart-grid: oklch(32% 0.025 250 / 0.7);
  --chart-glow: oklch(72% 0.16 205 / 0.26);
}
```

Legacy aliases must remain for old code and old themes:

```css
--color-red: var(--signal-danger);
--color-black: var(--surface-base);
--color-white: var(--text-primary);
--color-grey-10: var(--surface-panel);
--color-grey-30: var(--surface-line);
--color-grey-50: var(--text-muted);
--color-grey-70: var(--text-secondary);
--color-yellow: var(--signal-warn);
--color-green: var(--signal-system);
```

## Typography

Use one modern UI family for product surfaces and one mono family for numbers.

```css
--font-ui: "Inter", "Segoe UI", system-ui, sans-serif;
--font-mono: "JetBrains Mono", "Cascadia Mono", monospace;
--font-display: "Tektur", "Inter", system-ui, sans-serif;
```

Rules:
- Product labels, buttons and forms use `--font-ui`.
- Numeric telemetry uses `--font-mono`.
- Display font is reserved for app brand, major telemetry headings and splash/setup moments.
- Fixed rem scale, no viewport-scaled font sizes.
- Minimum body text is 14px; key dashboard values are 48px to 72px.

## Layout

The primary dashboard is semi-fixed and configurable.

1. **Command Top Bar**: app identity, connection health, active view, global actions.
2. **Telemetry Hero Band**: fixed, always visible on dashboard. Shows system load, AI spend pressure, freshness and last alert.
3. **Core Panels**: fixed zones for system stream, AI usage stream and device health.
4. **Widget Dock**: configurable widgets with add/remove/reorder and size controls.
5. **Detail Surfaces**: hardware, analysis, settings and plugins use the same shell and component vocabulary.

Breakpoints:
- `>= 1400px`: dense 12-column operations surface.
- `960-1399px`: Surface Go landscape, 8-column dashboard with compact hero.
- `600-959px`: stacked panels, no horizontal overflow.
- `< 600px`: emergency support only, key status first.

## Components

Core component vocabulary:
- `ops-shell`: full app shell with layered dark background.
- `ops-topbar`: navigation and connection state.
- `telemetry-hero`: fixed dashboard command band.
- `telemetry-panel`: high-value data surface with title, status, metric and canvas.
- `widget-dock`: configurable widget area.
- `control-panel`: settings/plugin/form surface.
- `overlay-content`: modal/drawer body using the same token system.

Component rules:
- Cards may use 8px to 14px radius and thin borders.
- Elevation uses background, border alpha and small shadows; no heavy floating card stacks.
- Buttons have default, hover, focus, active, disabled and loading states.
- Empty states explain what the user can do next.
- Loading uses skeleton or inline status, not isolated spinners unless content size is unknown.

## Canvas Data Visualization

Chart.js is replaced by a local Canvas telemetry engine. The visible product UI must not depend on CDN Chart.js.

Global interface:

```javascript
TelemetryCanvas.create(canvas, {
  type: "sparkline" | "radial" | "barMatrix" | "heatStrip" | "usageStream" | "costCache",
  labels: [],
  datasets: [],
  options: {}
});
```

Instance methods:
- `setData(data)`
- `setState(state)`
- `resize()`
- `destroy()`
- `setQuality("low" | "balanced" | "high")`

Visualization rules:
- Sparkline: live traces with subtle trail, freshness marker and threshold band.
- Radial: load ring with center value and warning zone.
- Bar matrix: dense categorical values, suitable for CPU cores, disk partitions and models.
- Heat strip: compact history/state intensity over time.
- Usage stream: AI Token/cost timeline with cached/non-cached distinction.
- Cost/cache composite: cost line plus cache ratio surface.

## Motion

Motion budget is adaptive:
- High capability: up to 60fps.
- Surface Go/default: 24 to 30fps.
- Hidden tab: pause animation loop; cache newest data only.
- Reduced motion: disable scanlines, pulses and interpolation.

Allowed motion:
- Data interpolation on new samples.
- Freshness pulse when a data packet arrives.
- Threshold transitions for warning/error.
- Panel reveal only when changing view or opening drawers.

Forbidden motion:
- Infinite decorative animation unrelated to data.
- Layout-shifting animation.
- Fast flashing or strobing.

## Theme Schema v3

Theme payloads support:

```json
{
  "schemaVersion": 3,
  "tokens": {
    "surface": {},
    "text": {},
    "signal": {},
    "chart": {},
    "motion": {},
    "canvas": {}
  },
  "legacyTokens": {}
}
```

Migration:
- v1/v2 themes are accepted.
- Missing v3 token groups are filled from the default theme.
- Old CSS variables remain as aliases.
- UI marks migrated themes as `legacy-compatible`.

## Performance

- Canvas DPR cap: 1.5 on Surface Go/default, 2 on high quality.
- Realtime history cap: 120 to 180 points.
- Long-running dashboard must not create duplicate animation loops when switching tabs.
- Canvas instances inside hidden tabs or 1x1 layouts must not participate in RAF rendering or final resize.
- Chart-compatible shim is a migration layer only; shimmed canvases must fill their parent container and recover on tab activation.
- Destroy canvas instances when widgets are removed.
- Use `ResizeObserver` for canvas resize and disconnect it on destroy.
