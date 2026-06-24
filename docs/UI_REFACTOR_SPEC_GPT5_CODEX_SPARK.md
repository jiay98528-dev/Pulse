# GaugePane / Pulse 全应用前端重构执行规格

## 目标

把历史 Pulse 项目重构为对外品牌 GaugePane / 仪窗的 AI Telemetry / Next-gen Operations Surface。执行者是 GPT5.3-Codex-Spark 或同级 Codex agent，目标是实际修改代码和文档，而不是只做概念稿。

本规格是当前 UI 重构的最高优先级说明。若本文件与旧调研、旧需求或旧设计指南冲突，以本文件、`PRODUCT.md`、`DESIGN.md` 为准。

## 已确认决策

- 彻底重置旧视觉系统。
- 覆盖全应用：仪表盘、硬件、分析、设置、插件、所有 overlay/modal/drawer/toast/empty/loading/error。
- 首页采用半固定可配置骨架：固定 Telemetry Hero 与核心面板，可配置 Widget Dock 保留。
- 可见动态图表使用自研 Canvas telemetry engine，不依赖 CDN Chart.js。
- 主题系统保留并升级兼容，主题 schema 升到 v3。
- 首次启动必须有可跳过、可重开的欢迎页。
- 主题和插件必须作为一级导航功能，不得藏在设置页深处。
- 内置主题市场和 5 个官方主题是发行前门禁。
- 性能采用自适应帧率：高性能 60fps，Surface Go 默认 24-30fps，隐藏页面暂停。
- 不新增 React/Vue，不新增构建链，不改 Python 采集层和后端 API。

## 文档同步要求

执行 UI 重构时必须同步：

- `PRODUCT.md`
- `DESIGN.md`
- `AGENTS.md`
- `docs/错题本.md`
- `docs/交接文档.md`
- `docs/项目全景总结.md`
- `TODO.md`
- `CHANGELOG.md`

旧文档如果继续包含“构成主义、苏维埃、红色永远、无渐变、无发光、红/黑/白三色、Chart.js 4.x”等旧约束，必须在文件顶部标记 `LEGACY`，或删除/改写这些约束。

## 前端架构

### App Shell

统一为 operations surface：

- 顶栏显示 GaugePane / 仪窗 或兼容历史 PULSE 标识、当前 tab、连接状态、最后刷新时间。
- 主体使用 `.ops-shell`、`.ops-topbar`、`.main` 和 `.tab-content` 统一页面节奏。
- 所有 tab 都使用同一组件词汇，不允许每页独立发明按钮、表单、卡片和弹窗风格。
- 一级导航固定为：仪表盘 / 硬件 / 分析 / 主题 / 插件 / 设置。

### Welcome

- 首次启动自动展示欢迎页，状态键为 `gaugepane-welcome-v1-seen`。
- 欢迎页必须可跳过，设置页必须可重新打开。
- 欢迎页说明本地系统仪表、AI/DeepSeek/Codex 配置、局域网多设备监看、主题市场和插件能力。
- 固定 CTA：进入仪表盘、配置 AI、打开主题、查看插件、稍后再说。
- 欢迎页不得成为长期全局遮罩，不得伪造配置完成状态。

### Dashboard

Dashboard 必须包含：

- `telemetry-hero`：固定首屏遥测带，显示 AI 余额、系统负载、数据新鲜度、最近告警。
- `telemetry-panel-grid`：系统、AI、网络/设备等核心面板。
- `widget-dock`：保留可配置 widget 增删排序和尺寸控制。

`WidgetEngine` 保留，但布局键迁移：

- 新键：`pulse-ui-layout-v3`
- 旧键：`pulse-widget-layout` 只做一次兼容导入

### Hardware / Analysis / Themes / Plugins / Settings

- Hardware：保留 LAN 设备条、设备抽屉和各硬件指标，但图表统一改为 Canvas。
- Analysis：CSV 导入、筛选、表格、历史趋势保留；历史图表改为 `usageStream` 和 `costCache`。
- Themes：一级页面，承载本地主题切换、主题市场、导入导出、主题编辑器和热更新状态。
- Plugins：保留启停、LAN 配对、共享指标配置。
- Settings：保留 provider 配置、Codex 状态、自启、通用设置、欢迎页重开入口和关于；主题功能不得只存在于 Settings。

## Canvas Telemetry Engine

新增 `frontend/js/telemetry-canvas.js`。

全局接口：

```javascript
TelemetryCanvas.create(canvas, config)
```

实例方法：

```javascript
setData(data)
setState(state)
resize()
destroy()
setQuality(quality)
```

支持类型：

- `sparkline`
- `radial`
- `barMatrix`
- `heatStrip`
- `usageStream`
- `costCache`

兼容要求：

- 在迁移阶段可提供 `Chart` 兼容 shim，让旧 `new Chart(...)` 调用映射到 `TelemetryCanvas`。
- 最终 `index.html` 不加载 Chart.js CDN。
- Canvas 实例必须支持 `chart.data` 直接修改和 `chart.update('none')`，避免一次性重写所有业务数据函数。

性能要求：

- 自动检测设备能力并选择 `low`、`balanced`、`high`。
- `prefers-reduced-motion` 时禁用装饰性扫描和插值。
- 页面隐藏时停止 RAF。
- 隐藏 tab 或尺寸为 1x1 的 Canvas 不参与 RAF 渲染，不把隐藏布局尺寸写成最终尺寸。
- 兼容 shim 创建的普通图表 Canvas 必须填满父容器，tab 激活时必须 resize/update。
- DPR cap：低端 1.5，高端 2。
- 历史点默认 120-180，不能无限增长。

## Theme Schema v3

新增 token 组：

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

兼容策略：

- v1/v2 主题导入后自动补齐 v3 token。
- 默认主题为 `builtin-telemetry-ops`。
- 旧 `builtin-constructivist` 仅保留为 legacy-compatible。
- 旧 CSS token alias 必须保留，防止旧代码和旧主题失效。

### Theme Marketplace Gate

- 主题市场默认位于“主题”一级页面，可辅以详情弹窗或大弹窗浏览。
- 必须支持筛选：全部、官方、社区、本地、已安装；Preview 至少支持官方、社区、本地。
- Preview 版本可没有真实下载服务器和支付闭环，但必须能切换本地主题、展示市场结构并显示在线市场离线态。
- Stable 版本必须支持在线主题列表、下载或购买、主题详情和恢复已购，失败时必须有明确错误态。
- 主题市场 8081 未运行时必须显示“在线市场离线，本地主题仍可使用”。
- 发行前至少预置 5 个完全不同的官方 schema v3 主题：`gauge-ops`、`frost-console`、`amber-terminal`、`graphite-studio`、`aurora-desk`。`constructivist` 仅作 legacy 兼容，不计入。

## 验收标准

- `rg "Chart.js CDN|cdn.jsdelivr.net/npm/chart.js" frontend/index.html` 无结果。
- `window.TelemetryCanvas` 存在，`window.Chart` 如存在必须来自本地 shim。
- dashboard、hardware、analysis 的 canvas 非空并随数据更新。
- 切换 tab 不创建重复动画循环。
- 直接访问 `/?tab=hardware`、`/?tab=analysis` 或 hash 路径必须激活对应页面。
- 未配置 API key 时 AI widgets 保留锁定空态，不能从布局中静默消失。
- 主题商店 8081 未运行时显示离线态，不能表现为空白或按钮静默失败。
- 主题导入导出仍可用，导出主题带 `schemaVersion: 3`。
- 首次欢迎页可跳过、可重开，并包含固定 CTA。
- 直接访问主题和插件 tab 必须有效。
- 主题一级页必须能在 Preview 门禁下完成本地主题切换和分类筛选。
- 发行前至少 5 个官方主题可本地切换，legacy constructivist 不计入。
- 1280x800、960x600、1400x900 截图无明显遮挡、溢出或空白主图表。
- 首次设置、配置保存、CSV 导入、插件启停、LAN 扫描、设备弹窗仍可用。

## 禁止事项

- 不引入 React/Vue/ECharts/uPlot。
- 不修改后端 API wire shape。
- 不让旧构成主义文档继续作为当前权威规范。
- 不用无限 RAF 或无限历史数组。
- 不把动态图表降级为静态数字卡片。
- 不把欢迎页做成无法关闭的全局遮罩。
- 不把主题功能藏回设置页深处。
- 不把插件隐藏成只有启用后才可见的高级功能。
