# Pulse — 项目元指令

> 当前版本: v2.0-m4 | 最高设计权威: docs/需求规格说明书_v2.0.md | M1 ✅ M2 ✅ M3 ✅ M4 ✅ M5~6 ⏳

## 项目标识

实时数据看板，Surface Go Win10 上运行。Tauri v2 + Python Sidecar 架构。
**v2.0 重构目标：** 5 Tab SPA + 可配置组件墙仪表盘 + 模块化主题系统 + 插件架构。

## 技术栈

| 层 | 技术 | 原因 |
|---|---|---|
| UI 壳 | Tauri v2 (Rust + WebView2) | Surface Go 4GB RAM，Tauri 比 Electron 省 100MB+ |
| 前端 | 原生 HTML/CSS/JS + Chart.js | 无框架依赖，轻量，实时图表质量高 |
| 后端 | Python 3.12+ FastAPI + WebSocket | psutil/WMI/Deepseek API 只有 Python 版 |
| 数据采集 | psutil (系统) + WMI (Windows) + aiohttp (API) | 已在 `backend/collectors/` 封装 |
| 数据库 | SQLite (aiosqlite) | 零配置，Deepseek 历史 + 设备配置持久化 |
| 通信 | WebSocket (每秒系统 / 每30秒余额) | 实时推送 |
| 图表 | Chart.js 4.x | CDN 加载，主题可配色 |
| 主题 | CSS 变量注入 + 热插拔 | < 50ms 切换，支持社区二创 |

## 项目结构

```
D:\VibeCoding\Pulse\
├── backend/
│   ├── main.py              # FastAPI 入口 + WebSocket + REST
│   ├── config.py             # 配置读写
│   ├── config.json           # 密钥/限额/设备配置 (gitignored)
│   ├── database.py           # SQLite CRUD
│   ├── requirements.txt      # Python 依赖
│   ├── collectors/
│   │   ├── system.py         # 本机系统 (psutil + WMI)
│   │   ├── deepseek.py       # Deepseek 余额采集
│   │   └── wmi_remote.py     # WMI 远程采集 (待废弃→插件)
│   └── plugins/              # (v2.0 新增) 插件目录
│       └── base.py           # PluginBase 基类
├── frontend/
│   ├── index.html            # 5 Tab SPA
│   ├── css/style.css         # CSS变量驱动，主题化
│   └── js/app.js             # WebSocket + Charts + ThemeEngine
├── src-tauri/                # Tauri v2 Rust 工程
│   ├── Cargo.toml            # tray-icon + autostart + updater + shell
│   ├── tauri.conf.json       # 无边框窗口 + 自动更新配置
│   ├── src/main.rs           # Tauri 入口
│   ├── src/lib.rs            # Sidecar启动 + 系统托盘 + 插件注册
│   ├── capabilities/default.json
│   └── scripts/              # start-backend.bat/.sh
├── docs/
│   ├── 需求规格说明书_v2.0.md  # 🔴 最高设计权威 — 所有冲突以本文档为准
│   ├── 项目全景总结.md          # 跨会话接力用
│   ├── CSV_ZIP自动导入方案.md   # Token采集方案 (已搁置，改为手动导入)
│   ├── 交接文档.md              # v1.0 状态记录 (已被v2.0取代)
│   ├── 错题本.md                # 设计约束 Checklist + 已知问题 + API审查
│   ├── Pulse_构成主义设计系统指南.md
│   └── 设计调研_看板布局模式.md
├── PRODUCT.md                # 战略层 (部分被v2.0取代)
├── DESIGN.md                 # 视觉层 (现为默认主题令牌)
├── TODO.md                   # 完成状态跟踪
├── start_pulse.bat           # Python 纯 Web 启动
└── CLAUDE.md                 # ← 本文件
```

## v2.0 Tab 结构 (5 Tab)

| Tab | 定位 | 说明 |
|-----|------|------|
| **仪表盘** | 远距扫视首页 | 可配置KPI组件墙 (3尺寸+拖拽)，自适应AI区块 |
| **硬件** | 靠近细看 | 系统详情 + LAN设备横栏(需配对) |
| **分析** | CSV数据分析 | 拖入zip→智能解析→表格+4图表+对比模式 |
| **配置** | 设置与外观 | AI供应商/系统/外观/主题市场/关于 (自适应卡片) |
| **插件** | 扩展管理 | 极简卡片列表 + LAN监控/Token采集等 |

## 关键设计约束

### 视觉
- v2.0 支持主题热插拔。**苏维埃构成主义为默认主题，非唯一主题。**
- 默认主题的设计约束（来自错题本）仍适用于所有官方主题：
  1. 不简陋 / 不浮夸 / 不赛博
  2. 直角优先 (`border-radius: 0`)
  3. 硬阴影（`box-shadow` 仅偏移无模糊）
  4. 图表最多三色
  5. 标题 ALL CAPS，等宽字体用于数值
- 社区主题可自由设计，不强制遵循构成主义约束
- 所有主题变量通过 CSS 自定义属性驱动，不硬编码颜色

### 硬件约束
- Surface Go: Pentium Gold, 4GB RAM, 10" 屏
- 等效视距 2m → 最小字号 14px, KPI 56px
- 触屏热区 ≥ 44px

### 架构约束
- Python 采集层不变，Tauri 只加壳
- 纯 Web 模式 (`localhost:8080`) 始终可用作为 fallback
- Deepseek API: 公开端点仅 `/user/balance` (余额)。**不再使用 `/dashboard/usage`（已确认404下线）**
- Token 用量改为手动 CSV 导入分析
- LAN 设备监控通过插件实现 (Pulse 即 Agent，UDP 发现 + WebSocket 推送)
- 主题通过 CSS 变量注入，不使用完整 CSS 替换
- 插件架构: PluginBase 基类 + 前端管理面板

### 发行与运营
- Pulse 本体: GitHub Releases + 个人官网 (免费开源)
- 主题市场: 香港服务器 FastAPI + SQLite (官方付费 + 社区免费)
- 支付: 微信/支付宝商户版 (大陆营业执照)
- 许可: 邮箱验证，无 License Key
- 社区主题: GitHub PR → Action 自动校验 → 人工抽检 → 上架

## 核心开发流程

### 启动调试
```bash
# 纯 Web 模式（不需要 Tauri）
cd D:/VibeCoding/Pulse
source venv/Scripts/activate
python backend/main.py
# 浏览器打开 http://localhost:8080

# Tauri 模式
cd D:/VibeCoding/Pulse
cargo tauri dev
```

### 典型开发顺序（v2.0）
1. 改前端 → 刷新浏览器即时看效果（纯 Web 模式）
2. 改后端 → 重启 Python 进程
3. 改 Tauri 壳 → `cargo tauri dev`
4. **需求/设计冲突 → 查阅 `docs/需求规格说明书_v2.0.md`**
5. 新功能 UI/UX → 先读规格书确认设计意图
6. 打包前过错题本 Checklist

## 设计权限与冲突解决

### 最高优先级
- 🔴 **`docs/需求规格说明书_v2.0.md` 是所有设计冲突的最高裁决依据**
- 以下文档已被 v2.0 取代或部分覆盖：
  - `docs/交接文档.md` — v1.0 状态，仅作历史参考
  - `PRODUCT.md` / `DESIGN.md` — 部分内容已被主题系统覆盖
  - `docs/CSV_ZIP自动导入方案.md` — 自动下载方案已搁置

### 开发前置检查
- 新功能 UI/UX 变动前，先读 `docs/需求规格说明书_v2.0.md` 确认规格
- 新设计需对照 `docs/错题本.md` 的"设计约束总结" Checklist
- 主题相关开发需理解 CSS 变量注入机制 (规格书 5.1~5.3)
- 新增失败记录必须写清：问题、根因、教训、排除清单

## 文档索引

| 文档 | 用途 | 优先级 |
|------|------|--------|
| `docs/需求规格说明书_v2.0.md` | **最高设计权威 — 所有冲突以此为准** | 🔴 P0 |
| `docs/项目全景总结.md` | 跨会话接力用，新会话快速了解全貌 | 🟡 P1 |
| `docs/错题本.md` | 设计约束 Checklist + 已知问题 + API审查记录 | 🟡 P1 |
| `docs/CSV_ZIP自动导入方案.md` | Token 自动采集方案 (已搁置，架构参考) | ⚪ 参考 |
| `docs/交接文档.md` | v1.0 完成状态 (历史参考，非权威) | ⚪ 历史 |
| `docs/Pulse_构成主义设计系统指南.md` | 默认主题设计参考 | ⚪ 参考 |
| `docs/设计调研_看板布局模式.md` | 布局调研背景 | ⚪ 参考 |
| `PRODUCT.md` | v1.0 战略层 (部分被 v2.0 覆盖) | ⚪ 参考 |
| `DESIGN.md` | v1.0 视觉层 (现为默认主题令牌) | ⚪ 参考 |
| `TODO.md` | 完成状态跟踪 | ⚪ 参考 |

## 记忆持久化

项目决策记录在 `docs/需求规格说明书_v2.0.md` 和 `docs/错题本.md`。
关键设计选择写入 memory 以便跨会话回溯: `~/.claude/projects/D--VibeCoding-Pulse/memory/`
