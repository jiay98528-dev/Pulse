# Pulse — 项目元指令

## 项目标识

实时数据看板，Surface Go Win10 上运行。Tauri v2 + Python Sidecar 架构。

## 技术栈

| 层 | 技术 | 原因 |
|---|---|---|
| UI 壳 | Tauri v2 (Rust + WebView2) | Surface Go 4GB RAM，Tauri 比 Electron 省 100MB+ |
| 前端 | 原生 HTML/CSS/JS + Chart.js | 无框架依赖，轻量，实时图表质量高 |
| 后端 | Python 3.12+ FastAPI + WebSocket | psutil/WMI/Deepseek API 只有 Python 版 |
| 数据采集 | psutil (系统) + WMI (Windows) + aiohttp (API) | 已在 `backend/collectors/` 封装 |
| 数据库 | SQLite (aiosqlite) | 零配置，Deepseek 历史持久化 |
| 通信 | WebSocket (每秒系统 / 每30秒 API) | 实时推送 |
| 图表 | Chart.js 4.x | CDN 加载，硬边折线/柱状/环形图 |

## 项目结构

```
D:\VibeCoding\Pulse\
├── backend/
│   ├── main.py              # FastAPI 入口 + WebSocket + REST
│   ├── config.py             # 配置读写
│   ├── config.json           # 密钥/限额/设备配置
│   ├── database.py           # SQLite 操作
│   └── collectors/
│       ├── system.py         # 本机系统 (psutil + WMI)
│       ├── deepseek.py       # Deepseek API 采集
│       └── wmi_remote.py     # WMI 远程采集
├── frontend/
│   ├── index.html            # 4 Tab 单页应用
│   ├── css/style.css         # 构成主义完整样式
│   └── js/app.js             # WebSocket + 5图表 + UI逻辑
├── src-tauri/                # (待创建) Tauri Rust 工程
├── docs/
│   ├── 交接文档.md            # 完整项目交接详情
│   ├── 错题本.md              # 设计约束 Checklist
│   └── Pulse_构成主义设计系统指南.md
├── PRODUCT.md                # 战略层设计文档
├── DESIGN.md                 # 视觉层设计令牌
├── start_pulse.bat           # Python 纯 Web 启动
└── CLAUDE.md                 # ← 本文件
```

## 关键设计约束

### 视觉（来自错题本，逐项遵守）
1. **不简陋** — 构成主义是精心构造的视觉密度
2. **不浮夸** — 无渐变、无发光、无毛玻璃、无圆滑边框
3. **不赛博** — 1920s 工厂美学，不是 2049 夜店美学
4. 红/黑/白三色系统占 90%+，绿色/黄色仅状态指示
5. 红色永远不作大面积背景
6. 直角优先 (`border-radius: 0`)
7. 硬阴影（`box-shadow` 仅偏移无模糊）
8. 图表最多三色（红/黑/灰 + 必要时黄）
9. 标题 ALL CAPS，等宽字体用于数值

### 硬件约束
- Surface Go: Pentium Gold, 4GB RAM, 10" 屏
- 等效视距 2m → 最小字号 14px, KPI 56px
- 触屏热区 ≥ 44px

### 架构约束
- Python 采集层不变，Tauri 只加壳
- 纯 Web 模式 (`localhost:8080`) 始终可用作为 fallback
- Deepseek API: 官方 endpoint，Key 在 config.json
- 主力机监控通过 WMI 远程（方案待定）

## 核心开发流程

### 启动调试
```bash
# 纯 Web 模式（不需要 Tauri）
cd D:/VibeCoding/Pulse
source venv/Scripts/activate
python backend/main.py
# 浏览器打开 http://localhost:8080

# Tauri 模式（需要先搭壳）
cd D:/VibeCoding/Pulse
cargo tauri dev   # 自动拉起 Python sidecar + WebView
```

### 构建打包
```bash
cargo tauri build  # 产出 .msi 安装包
```

### 典型开发顺序
1. 改前端 → 刷新浏览器即时看效果（纯 Web 模式）
2. 改后端 → 重启 Python 进程
3. 改 Tauri 壳 → `cargo tauri dev`
4. 打包前过错题本 Checklist

## 设计权限

- 新功能 UI/UX 变动前，先读 `PRODUCT.md` 和 `DESIGN.md`
- 读取 `docs/错题本.md` 的"设计约束总结"Checklist，确认新设计不在排除清单中
- 新增失败记录必须写清：问题、根因、教训、排除清单

## 记忆持久化

项目决策记录在 `docs/交接文档.md` 和 `docs/错题本.md`。
关键设计选择（PRODUCT.md / DESIGN.md 中的决策理由）写入 memory 以便跨会话回溯。
