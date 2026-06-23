# PULSE — 改动声明

## 2026-06-23 v3.0 UI Reset

Pulse 前端方向重置为 AI Telemetry / Next-gen Operations Surface。

- 更新 `PRODUCT.md`、`DESIGN.md`、`AGENTS.md` 和 `docs/错题本.md`，废弃旧构成主义视觉约束。
- 新增 `docs/UI_REFACTOR_SPEC_GPT5_CODEX_SPARK.md`，作为 GPT5.3-Codex-Spark 执行规格。
- 新增自研 `TelemetryCanvas` 引擎和本地 `Chart` 兼容 shim，移除可见 Chart.js CDN 依赖。
- 首页布局迁移到 `pulse-ui-layout-v3`，保留 Widget Dock 可配置能力。
- 主题系统升级到 schema v3，并保留旧 token alias 兼容。

### 2026-06-23 Runtime Stabilization

- Dashboard `heroAiCanvas`、`heroSystemCanvas`、`heroFreshnessCanvas`、`dashboardSystemStream`、`dashboardUsageStream`、`dashboardHeatStrip` 接入 `DashboardTelemetryController`，不再空白。
- Tab 激活统一走 `activateTab()`，支持 `?tab=` 和 hash 直达，切换时统一 resize/update 可见图表。
- 首次设置从全局阻塞 overlay 改为可关闭 banner，设置页保留完整 API key 表单。
- AI widgets 在未配置 API key 时保留锁定空态，不再从 Widget Dock 中自动删除。
- 主题市场依赖 8081 独立服务时显示明确离线态，购买/恢复不再静默失败。
- `TelemetryCanvas` 跳过不可见 canvas 的 RAF 渲染和 resize，Chart shim 给普通图表 canvas 填满父容器，修复硬件页 1x1 图表和 CPU 负载动画丢失问题。

---

## LEGACY 2026-06-22 v2.0

---

## 一、项目概述

Pulse 是 Surface Go Win10 上运行的实时数据看板，Tauri v2 + Python Sidecar + 原生 HTML/CSS/JS 架构。v2.0 在 v1.0 基础上完成了 6 个里程碑（38 任务）的全面重构，并经过 ChatGPT 5.5 发行审计和 Claude Code P0~P2 深度修复，当前已达到发行标准。

---

## 二、终审修复清单（Claude Code 执行）

本轮会话共执行 3 轮深度审计，发现 23 项问题（5 P0 + 10 P1 + 8 P2），全部修复。

### 🔴 P0 发行阻断（5 项）

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| 1 | `app.js:855` | `handleMessage()` 未处理 `pair_request`/`pair_success`/`pair_rejected`，LAN 配对流程完全断裂 | 在 switch 中增加 3 个 case，绑定 `#pair-overlay` 弹窗交互 |
| 2 | `main.py:426` | `POST /api/csv/import` 无文件大小限制，`file.read()` 全量入内存 | 增加 `MAX_CSV_SIZE = 50MB` 限制 + `asyncio.Semaphore(3)` 并发控制 |
| 3 | `lib.rs:122-125` | autostart 插件传入 `--minimized` 但 `setup()` 未处理，自动启动总是全屏 | `setup()` 中解析 `--minimized` 标志，调用 `window.hide()` |
| 4 | `pairing.py:46` | 持久信任 PIN 硬编码为 `"0000"`，安全形同虚设 | 改为从 `config.json` 读取，为空时随机生成 6 位数字 |
| 5 | `wmi_remote.py` | `/api/devices/{id}/test` 端点的 `test_connection()` 方法不存在，始终崩溃 | 添加 `test_connection()` 占位方法 + `AttributeError` 优雅降级 |

### 🟡 P1 高优先级（10 项）

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| 6 | `main.py:247` | WebSocket `/ws` 无来源验证，任何本地进程可无限连接 | `accept()` 前检查 `Origin` 标头，非白名单拒绝 (code 4003) |
| 7 | `deepseek.py:59` | API 错误静默 `return None`，用户无感知 | 添加 `print(f"[Deepseek] API error: ...)` 日志 |
| 8 | `database.py:36` | `spending_limits` 表创建但从未使用（废弃表） | 删除 CREATE TABLE 语句 |
| 9 | `config.py:24` | `websocket_port: 8765` 配置从未被读取（死配置） | 删除 |
| 10 | `app.js:31-32` | `costHistory` 和 `balanceHistory` 声明但从未读写 | 删除 |
| 11 | `app.js:2875` | `initDeviceForm()` 查找不存在的 `device-add-btn` | 只保留 `hwAddDeviceBtn` 绑定 |
| 12 | `app.js:627` | GPU 温度类 `.text-hot`/`.text-warm`/`.text-cool` CSS 未定义 | 删除死 classList 调用 |
| 13 | `index.html:379` | 关于卡片显示 `v2.0-m2`，与 CSS/JS 版本号不一致 | 统一为 `v2.0` |
| 14 | `app.js:2457` | `showOfflineMarketplace()` 未使用 `escapeHtml()` | 统一转义 |
| 15 | `config.py:39` | `DEFAULT_CONFIG.copy()` 浅拷贝导致嵌套 `wmi_remote` 字典共享 | 改为 `copy.deepcopy()` |

### 🟢 P2 一般问题（8 项）

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| 16 | `main.py:333` | API Key 掩码对短密钥（9-11 字符）只掩 1-3 字符 | 统一 `key[:4] + "..." + key[-4:]` |
| 17 | `store/server.py:371` | Webhook 重放可虚增主题下载量 | 下载增量改为 `WHERE status='pending'` 条件保护 |
| 18 | `database.py` | `lan_paired_devices.ip` 列缺少索引 | `CREATE INDEX idx_lan_paired_ip` |
| 19 | `main.py:607` | `/api/lan/discover` timeout 参数无上限 | 增加 `min(float(timeout), 30.0)` 上限 |
| 20 | `store/server.py` | 6 处使用已弃用 `datetime.utcnow()` | 全部改为 `datetime.now(timezone.utc)` |
| 21 | `tauri.conf.json` | CSP `script-src` 包含 `cdn.jsdelivr.net` 全站 | 收紧为 `cdn.jsdelivr.net/npm/chart.js@4.4` 特定路径 |
| 22 | `main.py:281` | `startup_time` 在模块级别设置，非 lifespan 内 | 迁移至 `lifespan` 函数内 |
| 23 | `store/server.py` | `simulate_payment_loop` task 未跟踪，shutdown 警告 | 存储 task 引用，在 `yield` 后取消 |

---

## 三、验收改进（用户反馈）

| # | 需求 | 实现 |
|---|------|------|
| 1 | Deepseek ZIP 上传失败 | 新增 `utc_date` 列名映射 + `_pivot_deepseek_amount_df` 透视函数 + cost-only CSV 容错 + 双 CSV 去重覆盖（token 数据 UPDATE 而非 SKIP） |
| 2 | 费用限额不告警 | 后端 WebSocket 推送 `today_cost`/`month_cost`，前端超限显示红色横幅 + KPI 变红 |
| 3 | Token 数据来源不明 | 分析页新增 `#analysis-data-source` 元素，导入成功后显示文件名+时间 |
| 4 | 主题市场无独立入口 | 配置页 → "浏览全部主题" 按钮 → 720px 弹窗网格，完整展示所有主题 |
| 5 | LAN 扫描无可视化 | 硬件页 → "扫描局域网" 按钮 → 5 秒倒计时弹窗 + 设备列表 + 配对入口 |

---

## 四、安全加固（ChatGPT 5.5 审计 + Claude Code 补充）

| 层面 | 措施 |
|------|------|
| CORS | `allow_origins` 限制为 5 个白名单源（127.0.0.1:8080, localhost:8080, tauri.localhost 等） |
| 路径穿越 | 双重防护：字符串 `..` 检测 + `resolve().relative_to()` 边界校验 |
| 跨域写入 | `reject_untrusted_write_origins` 中间件：非本地 Origin 写操作 → 403 |
| 监听地址 | 默认 `127.0.0.1`（可配置），不使用 `0.0.0.0` |
| 配置安全 | 空 API Key 不清空已有配置；`wmi_remote` 类型验证（非 dict → 400） |
| 静态文件 | 编码穿越（`/%2e%2e/`）→ 404；未知扩展名文件 → 404 |
| 商店安全 | 默认本机监听；CORS 白名单；模拟支付/调试验证码需环境变量显式开启 |
| Tauri CSP | `script-src` 收紧到 `chart.js@4.4` 特定路径；`updater` 完整移除 |

---

## 五、文档更新

| 文档 | 更新内容 |
|------|----------|
| `TODO.md` | +发行审计章节 +P0修复章节 +验收改进章节 +v2.1 规划，移除所有 ⏳ 标记 |
| `CLAUDE.md` | 版本号 v2.0 + 项目结构更新 (store/plugins) + Post-M6 新功能列表 |
| `docs/项目全景总结.md` | 日期更新 + API 端点清单修正（实际路径对齐代码）+ Git 历史更新 |
| `docs/需求规格说明书_v2.0.md` | 新增 §7.x v2.0 发行前改进（5 项需求规范） |
| `CHANGELOG.md` | ← 本文件 |

---

## 六、技术栈验证

| 层 | 状态 | 验证方式 |
|----|------|----------|
| Python 后端 | ✅ | `python -m compileall backend store` |
| 前端 JS | ✅ | `node --check frontend/js/app.js` |
| Tauri 壳 | ✅ | `cargo check` (0 错误, 0 警告) |
| API 端点 | ✅ | `/api/health` 200, `/api/plugins` 正常, CSV/ZIP 导入成功 |
| 安全阻断 | ✅ | 路径穿越 404, 恶意 Origin 写入 403, 空 Key 不清空 |

---

## 七、已知限制

1. **LAN 扫描**: UDP 广播发现需局域网环境验证，单机开发时 `/api/lan/discover` 返回空列表
2. **商店后端**: 支付/邮箱验证完整实现，但模拟支付默认关闭，需设置 `PULSE_STORE_SIMULATED_PAYMENTS=1` 测试
3. **Tauri 自动更新**: updater 插件已移除（无签名密钥），后续需配置发布端点后恢复
4. **WMI 测试**: `test_connection()` 为占位实现，实时 WMI 远程采集待 LAN 插件完善

---

*本文件由 Claude Code 自动生成，记录 Pulse v2.0 发行前全部改动。*
*最后更新: 2026-06-22*
