# PULSE

**实时数据看板** — Surface Go 上的系统监控 + Deepseek API 用量可视化

苏联构成主义视觉风格（红/黑/白·硬边几何·革命能量）

---

## 功能

- **系统监控** — CPU / 内存 / GPU / 磁盘 / 网络 / 温度，每秒刷新
- **Deepseek API 用量** — Token 消耗 / 缓存命中率 / 余额 / 资费，30 秒更新
- **历史趋势** — 7 日/30 日趋势图 + CSV 导入历史数据
- **LAN 远程设备** — 通过 WMI 监控局域网内多台设备
- **配置向导** — 首次启动引导输入 API Key 和限额

## 截图

![Pulse Dashboard](https://via.placeholder.com/800x450?text=Pulse+Dashboard)

## 技术栈

| 层 | 技术 |
|---|---|
| UI 壳 | Tauri v2 (Rust + WebView2) |
| 前端 | 原生 HTML/CSS/JS + Chart.js 4.x |
| 后端 | Python 3.12 + FastAPI + WebSocket |
| 采集 | psutil / WMI / aiohttp |
| 数据库 | SQLite (aiosqlite) |
| 设计 | 苏联构成主义（红 #CC0000 / 黑 #000000 / 白 #FFFFFF） |

## 快速开始

```bash
# 克隆
git clone https://github.com/m1771/Pulse
cd Pulse

# Python 后端
python -m venv venv
source venv/Scripts/activate    # Windows bash
pip install -r backend/requirements.txt
python backend/main.py

# 浏览器打开 http://localhost:8080
```

### Tauri 桌面模式

```bash
# 需要 Rust: https://rustup.rs
cargo tauri dev     # 开发模式
cargo tauri build   # 打包 .msi 安装包
```

## 项目结构

```
Pulse/
├── backend/          # Python FastAPI + 采集器
│   └── collectors/   #   psutil / WMI / Deepseek API
├── frontend/         # HTML / CSS / JS + Chart.js
├── src-tauri/        # Tauri v2 Rust 壳
│   └── scripts/      #   Python sidecar 启动脚本
└── docs/             # 设计系统 / 错题本 / 交接文档
```

## 设计原则

> **热血 · 力量 · 秩序**

- 红/黑/白三色系统占 90%+
- 直角优先（`border-radius: 0`）
- 无渐变 · 无发光 · 无毛玻璃 · 无圆角
- 1920s 工厂美学，不是 2049 夜店美学
- 小屏远距可读（最小 14px，KPI 56px，触屏热区 44px+）

## 硬件适配

Surface Go 第一代（Pentium Gold · 4GB RAM · 10" 屏 · Win10）优化。

---

MIT License
