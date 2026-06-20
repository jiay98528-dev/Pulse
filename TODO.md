# PULSE — 项目 TODO

> v1.0: 2026-06-19 (全部完成) | v2.0: 2026-06-20 (设计完成，待开发)

---

## ✅ v1.0 全部完成 (5 Phase, 15/15)

<details>
<summary>点击展开 v1.0 历史</summary>

- [x] Phase 1: Git + Memory + 代码扫描
- [x] Phase 2: API + 前端 + 系统数据验证
- [x] Phase 3: Tauri 项目结构 + Sidecar + 系统托盘
- [x] Phase 4: 配置引导 + LAN 设备 + 自定义标题栏
- [x] Phase 5: 错误处理 + 开机自启 + 自动更新

</details>

---

## ⏳ v2.0 里程碑 (设计完成 — 6 里程碑, 38 任务)

> 详情: `docs/需求规格说明书_v2.0.md` 第七节

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
