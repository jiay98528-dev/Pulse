# Product

## Register

product

## Users

Pulse 的主要用户是一位在 Surface Go 第一代（Win10，10 英寸屏，4GB RAM）上运行常驻监控面板的开发者。设备通常放在副屏位置，用于开发时远距扫视系统状态、AI API 用量和局域网设备健康度。

使用姿态分为两类：
- 远距扫视：40cm 物理视距，但等效于 27 寸显示器 2m 观看，因此关键数值必须大、清晰、稳定。
- 近距操作：偶尔靠近触屏切换视图、导入 CSV、配置主题、管理 LAN/WMI 设备和插件。

## Product Purpose

Pulse 是一个 AI Telemetry / Next-gen Operations Surface：在低功耗 Windows 平板上持续显示系统、AI API 和局域网设备状态，让用户一眼判断当前运行负载、费用压力和异常趋势。

核心能力：
- 实时监控本机以及未来局域网设备的 CPU、内存、GPU、温度、磁盘、网络、电池和运行时间。
- 展示 Deepseek 及其他 AI Provider 的余额、Token、缓存命中率、费用和历史趋势。
- WebSocket 每秒推送系统数据，AI/费用数据按后端策略刷新。
- 支持 CSV/ZIP 导入补充 AI 用量历史。
- 作为 Tauri 常驻看板运行，同时保留 `localhost:8080` 纯 Web fallback。

成功标准：
- 每天至少看一眼就能判断系统是否健康、费用是否异常、趋势是否值得介入。
- 远距扫视时不需要读小字也能理解关键状态。
- 长时间运行不积压内存，不让 Surface Go 变卡。

## Product Personality

**精准 · 有生命感 · 操作级可信**（Precise, Alive, Operationally Trustworthy）

- **精准**：界面像遥测仪器，不做无意义装饰。每个图层、动效和颜色都必须回答一个监控问题。
- **有生命感**：实时数据不只是数字跳变，而是有节奏的数据流、趋势轨迹、负载脉冲和状态呼吸。
- **操作级可信**：视觉可以次世代，但交互必须像成熟工具。用户需要相信它能在低端设备上稳定运行。

## Anti-references

- **不回到旧构成主义**：旧红黑白、硬边、苏维埃符号和“禁止渐变/发光/圆角”的规则已废弃，仅作为历史资料。
- **不做普通 SaaS 仪表盘**：避免同质化卡片网格、hero 大数字模板、蓝紫渐变和营销式空洞视觉。
- **不做纯赛博噱头**：允许未来感、光层和动态扫描，但它们必须服务数据状态，不允许霓虹夜店式堆砌。
- **不牺牲性能**：任何视觉方案都必须适配 Surface Go 4GB RAM。

## Design Principles

1. **Telemetry first**。界面首先是遥测表面，不是装饰页面。布局按“是否需要立刻判断”而不是数据来源分组。
2. **Motion carries state**。动画只表达数据刷新、趋势变化、告警级别、在线状态或用户操作反馈。
3. **Glanceable hierarchy**。关键状态远距可读，辅助信息近距可读。不要把所有卡片做成同等视觉重量。
4. **Configurable, not chaotic**。首页采用半固定可配置骨架：核心监控区固定，Widget Dock 可增删排序。
5. **Offline resilience**。AI API 不可用时，本地系统数据、缓存历史和明确降级状态仍然可见。
6. **Theme compatibility with a new core**。主题系统升级到 v3，但旧主题要能兼容迁移，不能让用户配置直接失效。

## Accessibility & Inclusion

- Surface Go 远距扫视：正文最小 14px，关键 KPI 默认 48px 以上。
- 触屏热区不小于 44px。
- 状态不能只靠颜色表达，必须配合文本、形状、数值或位置。
- 支持 `prefers-reduced-motion`，关闭非必要动效但保留数据更新。
- 深色默认主题必须达到高对比；主题编辑器不能允许关键文字低对比到不可读。
