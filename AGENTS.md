# Pulse — 项目元指令

## 语言偏好

- 默认使用中文进行对话和回复。
- 代码注释可以使用英文，但解释说明使用中文。
- 所有技术说明、错误分析、建议等均使用中文输出。

## 项目标识

Pulse 是运行在 Surface Go Win10 上的实时 AI Telemetry / Operations Surface。架构为 Tauri v2 + Python Sidecar，也必须保留 `localhost:8080` 纯 Web fallback。

## 当前技术栈

| 层 | 技术 | 约束 |
|---|---|---|
| UI 壳 | Tauri v2 (Rust + WebView2) | Surface Go 4GB RAM，优先低内存 |
| 前端 | 原生 HTML/CSS/JS | 不新增 React/Vue，不新增构建链 |
| 图表 | 自研 Canvas telemetry engine | 可保留兼容 shim，但可见图表不依赖 CDN Chart.js |
| 后端 | Python 3.12+ FastAPI + WebSocket | 采集层不随 UI 重构改动 |
| 数据采集 | psutil + WMI + aiohttp | 已在 `backend/collectors/` 封装 |
| 数据库 | SQLite (aiosqlite) | Deepseek 历史持久化 |
| 通信 | WebSocket + REST | 后端 API 兼容不破坏 |

## 项目结构

```
D:\VibeCoding\Pulse\
├── backend/
├── frontend/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── app.js
│       └── telemetry-canvas.js
├── src-tauri/
├── docs/
├── PRODUCT.md
├── DESIGN.md
├── TODO.md
└── AGENTS.md
```

## 当前设计方向

权威设计方向以 `PRODUCT.md`、`DESIGN.md` 和 `docs/UI_REFACTOR_SPEC_GPT5_CODEX_SPARK.md` 为准。

旧“苏维埃构成主义 / 红黑白 / 禁止渐变发光圆角 / Chart.js 默认图表”规则已经废弃。包含这些内容的旧文档只作为 legacy 研究材料，不能作为当前 UI 约束。

当前产品人格：
- 精准：界面像遥测仪器，每个视觉元素服务监控判断。
- 有生命感：数据流、趋势、负载和状态以 Canvas 动效表达。
- 操作级可信：视觉可以次世代，但交互必须成熟、稳定、可回归。

## 关键硬约束

- Surface Go 第一代，Win10，10 英寸屏，4GB RAM。
- 远距扫视：正文最小 14px，关键 KPI 48px 以上。
- 触屏热区不小于 44px。
- 保留纯 Web 模式 `localhost:8080`。
- 不破坏后端 REST/WebSocket API。
- 不引入重量级前端框架或构建链。
- 支持 `prefers-reduced-motion`。
- 长时间运行不能创建重复动画循环或无界历史数组。

## 前端设计 Skill 路由规则

已有界面的审查、改进、打磨、优化、重构：使用 `impeccable`。

从零创建新网页、独立原型、单页展示：使用 `web-design-engineer`。

执行 UI/UX 变动前必须读取：
- `PRODUCT.md`
- `DESIGN.md`
- `docs/UI_REFACTOR_SPEC_GPT5_CODEX_SPARK.md`
- `docs/错题本.md`

## 开发流程

```bash
cd D:/VibeCoding/Pulse
venv/Scripts/python.exe backend/main.py
```

浏览器打开 `http://localhost:8080`。

典型顺序：
1. 文档同步和设计约束检查。
2. 前端 HTML/CSS/JS 修改。
3. 纯 Web 模式验证。
4. Playwright 截图和 Canvas 非空检查。
5. Tauri 壳验证。

## 文档卫生

- 任何新设计决策要同步 `PRODUCT.md`、`DESIGN.md` 或 `docs/UI_REFACTOR_SPEC_GPT5_CODEX_SPARK.md`。
- 历史文档如果保留旧约束，必须在文件顶部标记 `LEGACY`。
- 不允许权威文档之间出现互相冲突的 UI 指令。

## 小模型协作分支工作流

当需要把低风险、重复性高、短平快的任务交给 GPT5.3-Codex-Spark 等小上下文模型执行时，必须使用专用分支隔离。

默认分支：
- `codex/release-blockers-spark-tasks`

基本规则：
- 小模型只在专用分支工作，不直接合并 `main`。
- 每个任务必须是窄范围、可验收、低耦合的单元。
- 单个任务最多阅读 3 个源码文件和 1 个文档文件。
- 单个任务最多修改 2 个源码文件和 1 个测试/文档文件。
- 任务说明必须包含：目标、允许修改文件、禁止修改文件、验收命令、完成后汇报格式。
- 小模型不得执行大范围重构、跨层协议变更、Git 历史整理、版本发布、tag、merge、rebase。
- 小模型不得回滚或覆盖用户已有未提交改动。
- 小模型完成后由主审模型审核，通过后再合并主代码流。

适合交给小模型的任务：
- 单文件 CSS/布局修复。
- 单个 Canvas 或 chart resize 补丁。
- 单接口错误态、空态、离线态文案。
- 单个 smoke test 或 Playwright 验收脚本。
- 单个文档同步任务。
- 明确的构建参数、hidden import、路径解析补齐。

不适合交给小模型的任务：
- 产品方向判断。
- UI 设计体系重写。
- 后端 API wire shape 修改。
- Tauri sidecar、PyInstaller、数据目录三者同时变更。
- 需要理解整个仓库的大型重构。
- 任何无法用 1-2 条命令验收的开放任务。

主审模型职责：
- 分配任务前先确认任务边界和验收命令。
- 审核小模型 diff，重点检查无关改动、重复 RAF、无界数组、隐藏 tab 1x1 canvas、路径硬编码、发行目录写入问题。
- 审核通过后负责整理提交、解决冲突、更新文档、执行完整验收。
