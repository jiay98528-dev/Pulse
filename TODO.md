# PULSE — 项目 TODO 清单

> 创建: 2026-06-19 | 项目迁移后基础设施启动

---

## Phase 1: 基础设施 ⚡

- [x] Git 仓库初始化 + .gitignore
- [x] Memory 持久化建立（用户画像 / 项目架构 / 设计约束 / 工作偏好）
- [x] 代码扫描修复（lifespan 警告、错误处理、未使用导入）

## Phase 2: 运行验证 🔍

- [x] 启动后端验证（Python FastAPI 正常启动）
- [x] 前端访问确认（localhost:8080 可访问）

## Phase 3: Tauri 壳搭建 🏗️

- [x] src-tauri/ 项目初始化（Cargo.toml + tauri.conf.json + main.rs）
- [ ] Python Sidecar 整合（Tauri 自动拉起后端）
- [ ] 系统托盘 + 全局快捷键

## Phase 4: 功能增强 🚀

- [ ] 首次启动配置引导（API Key 设置页）
- [ ] LAN 设备管理 UI（模块化配置远程设备监控）
- [ ] 无边框窗口 + 自定义标题栏（构成主义风格窗口 chrome）

## Phase 5: 生产打磨 🔧

- [ ] 错误处理 + 边缘状态（网络断开 / API 不可用 / 数据空洞 UI 降级）
- [ ] 开机自启（tauri-plugin-autostart）
- [ ] 自动更新机制（tauri-plugin-updater）

---

## 完成状态

| Phase | 进度 | 状态 |
|-------|------|------|
| Phase 1: 基础设施 | 3/3 | ✅ 完成 |
| Phase 2: 运行验证 | 2/2 | ✅ 完成 |
| Phase 3: Tauri 壳 | 1/3 | ⏳ 执行中 |
| Phase 4: 功能增强 | 0/3 | ⏳ 待开始 |
| Phase 5: 生产打磨 | 0/3 | ⏳ 待开始 |
