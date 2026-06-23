# PULSE — 项目 TODO

> v1.0: 2026-06-19 (全部完成) | v2.0: 2026-06-21 (M1-M6 全部完成, 发行就绪)
> 最后更新: 2026-06-23 | 当前阶段: v2.1 发行验收完成

---

<details>
<summary>✅ v1.0 全部完成 (5 Phase, 15/15) — 历史参考</summary>

- [x] Phase 1: Git + Memory + 代码扫描
- [x] Phase 2: API + 前端 + 系统数据验证
- [x] Phase 3: Tauri 项目结构 + Sidecar + 系统托盘
- [x] Phase 4: 配置引导 + LAN 设备 + 自定义标题栏
- [x] Phase 5: 错误处理 + 开机自启 + 自动更新

</details>

---

## ✅ v2.0 里程碑 (6 里程碑, 38 任务 — 全部完成)

> 设计权威: `docs/需求规格说明书_v2.0.md` 第七节

| Milestone | 进度 | 状态 |
|-----------|------|------|
| M1 基础重构 | 5/5 ✅ | 完成 |
| M2 仪表盘 + 硬件 | 6/6 ✅ | 完成 |
| M3 分析 + 配置 | 7/7 ✅ | 完成 |
| M4 主题系统 | 6/6 ✅ | 完成 |
| M5 插件 + LAN | 7/7 ✅ | 完成 |
| M6 商店后端 | 5/5 ✅ | 完成 |

### M1 — 基础重构 (5/5) ✅
- [x] 1.1 删除 `/dashboard/usage` 调用及引用
- [x] 1.2 余额采集增加 `granted_balance` / `topped_up_balance`
- [x] 1.3 CSS 变量迁移 — 所有硬编码颜色 → `var(--xxx)`
- [x] 1.4 7→5 Tab 结构调整
- [x] 1.5 系统托盘：关闭到托盘 + 右键退出

### M2 — 仪表盘 + 硬件页 (6/6) ✅
- [x] 2.1 组件墙 — 3尺寸卡片 + 添加/删除
- [x] 2.2 组件拖拽排列 + localStorage 持久化
- [x] 2.3 预设组件：CPU/内存/磁盘/网络/GPU/余额
- [x] 2.4 自适应 AI 区块
- [x] 2.5 硬件页：系统详情重布局
- [x] 2.6 硬件页：LAN 横栏占位

### M3 — 分析页 + 配置页 (7/7) ✅
- [x] 3.1 分析页：拖拽/文件选择器入口 + 汇总 KPI + 4 图表 + 7 列表格
- [x] 3.2 智能格式检测 + 列名适配 + 去重 + ZIP 支持
- [x] 3.3 4图表 + 7列表格 + 筛选器 (日期/模型联动)
- [x] 3.4 对比模式 (双色叠加)
- [x] 3.5 配置页：AI 供应商选择器 (Deepseek/OpenAI/Anthropic)
- [x] 3.6 配置页：自适应系统卡片 (条件隐藏，M5 就绪后启用)
- [x] 3.7 配置页：关于信息卡片 (版本/构建/技术栈/GitHub)

### M4 — 主题系统 (6/6) ✅
- [x] 4.1 ThemeEngine — JSON→CSS变量→图表重绘 (camelCase→kebab转换，Chart.js update)
- [x] 4.2 默认 theme.json (苏维埃构成主义 · 21语义变量令牌)
- [x] 4.3 外观卡片 — 下拉选择 + 实时色块预览
- [x] 4.4 主题市场卡片 — 自适应网格浏览
- [x] 4.5 .pulse-theme 拖入安装 (格式验证 + localStorage缓存 + 刷新列表)
- [x] 4.6 主题编辑器 — 8色取色器 + 3字体 + 3字号滑块 + 实时预览 + 导出

### M5 — 插件架构 + LAN 插件 (7/7) ✅
- [x] 5.1 PluginBase 基类 + 插件发现 (PluginManager + 动态导入)
- [x] 5.2 插件页 UI — 卡片列表 + 开关 (enable/disable REST API)
- [x] 5.3 LAN 插件：UDP 广播发现 (UDP listener + discovery.py)
- [x] 5.4 LAN 插件：WebSocket 配对 + 弹窗授权 (PairingManager + overlay弹窗)
- [x] 5.5 LAN 插件：指标选择器 + 持久信任 (PIN验证 + 共享指标开关)
- [x] 5.6 硬件页设备横栏 — 水平卡片 + KPI显示 + 抽屉详情
- [x] 5.7 开机自启 + 自动重连主控端 (ReconnectManager + 配置UI)

### M6 — 商店后端 (5/5) ✅
- [x] 6.1 FastAPI 商店 + SQLite (独立端口8081, themes/purchases/verification_codes三表)
- [x] 6.2 微信/支付宝商户对接 (模拟支付+QR码+15秒自动确认+Webhook签名)
- [x] 6.3 邮箱验证码 (6位数字+3分钟有效期+debug模式+恢复已购)
- [x] 6.4 社区 GitHub PR 自动校验 Action (theme.json格式+文件大小<500KB)
- [x] 6.5 Pulse 前端对接 (市场网格+主题详情+购买流程+恢复已购+自动安装)

---

## ✅ 发行前审计与修复 (2026-06-21)

### ChatGPT 5.5 发行审计修复
- [x] CORS 安全加固 (白名单源 + 非本地 Origin 写入拒绝)
- [x] 路径穿越防护 (双重防御: .. 检测 + resolve.relative_to)
- [x] HTTP 默认监听 127.0.0.1 (可配置)
- [x] 静态文件编码穿越返回 404
- [x] API Key 空值不清空已有配置
- [x] 按钮触屏热区 ≥ 44px (Surface Go 约束)
- [x] Tauri 打包修复 (图标生成 + updater 移除 + autostart 适配)
- [x] 商店后端安全加固 (默认本机监听 + CORS 白名单 + 模拟支付/调试关闭)

### P0~P2 发行阻断修复
- [x] P0: handleMessage() 增加 pair_request/pair_success/pair_rejected 消息处理
- [x] P0: CSV 导入 50MB 上限 + asyncio.Semaphore(3) 并发控制
- [x] P0: autostart --minimized 标志处理 (setup() 调用 window.hide())
- [x] P0: 持久信任 PIN 从硬编码 0000 改为配置随机生成 6 位
- [x] P1: WebSocket /ws 增加 Origin 来源验证
- [x] P1: Deepseek API 错误日志 + 废弃表/配置清理 + 死变量删除
- [x] P2: 密钥掩码 + webhook 幂等 + timeout 上限 + escapeHtml + utcnow 迁移 + IP 索引 + CSP 收紧

### 验收改进 (用户反馈)
- [x] Deepseek ZIP 双 CSV 导入 (utc_date 映射 + amount CSV 透视 + 去重覆盖)
- [x] 费用限额告警 (WebSocket 推送 today_cost/month_cost, 超限红色横幅)
- [x] 分析页数据来源标记 (导入文件名 + 时间)
- [x] 主题市场独立弹窗 (配置页 → 浏览全部主题 → 720px 弹窗网格)
- [x] LAN 扫描可视化窗口 (硬件页 → 扫描局域网 → 5 秒倒计时 + 设备列表 + 配对)

---

## ✅ v2.1 发行验收完成 (2026-06-23)

- [x] 插件页 LAN 插件卡片增强: 已配对设备列表 + 指标配置入口
- [x] 分析页数据来源列: 每行标注导入文件名/时间
- [x] 仪表盘 WidgetEngine 统计图表增强: KPI 环形图 + 内存饼图 + 磁盘柱状图
- [x] 硬件页 LAN 设备抽屉详情: 点击设备卡片展开完整指标图表
- [x] 浏览器 E2E: Dashboard / Analysis ZIP / Plugins LAN / Hardware LAN drawer / 800px 视口闭环
- [x] 发行许可与敏感信息审计: Python/Rust 依赖许可证、密钥扫描、gitignored 本机配置检查
