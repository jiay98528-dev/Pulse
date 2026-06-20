# CSV ZIP 自动导入方案

> 创建: 2026-06-20 | 状态: 📋 待开发
> 解决: KNOWN-002 — Deepseek 无公开用量监控 API

---

## 一、背景

### 问题

Deepseek 公开 API 仅 4 个端点，不包含 Token 用量聚合查询。Pulse 需要展示跨终端的 Token 消耗趋势、缓存命中率、分模型用量。

### 约束

- 多终端共用一个 API Key，调用链路不统一（Claude Code / VS Code / Web），无法在调用端拦截 usage 字段
- 无法部署局域网 API 代理
- 不能依赖前台浏览器自动化（需后台无人值守运行）

### 方案

**定时调 Deepseek Web 控制台的后端 API（`/dashboard/usage`），获取用量 CSV zip 压缩包，自动解压解析，同步到本地 SQLite。**

---

## 二、数据源

### 端点

```
GET https://api.deepseek.com/dashboard/usage?from=<unix_ts>&to=<unix_ts>
Authorization: Bearer sk-xxxx
```

- 鉴权方式：API Key（与公开 API 一致，非 Session Cookie）
- 频率：每 1-2 小时一次
- 返回格式：**ZIP 压缩包**，内含 2 个 CSV 文件

### ZIP 内文件结构（预期）

```
usage_export_2026-06-15_2026-06-20.zip
├── amount.csv       # 用量明细 — token 数量 + 费用
└── detail.csv       # 费用明细 — 按 API Key 拆分
```

### CSV 字段（预期）

**amount.csv — 用量明细：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `date` | str | 日期 (YYYY-MM-DD) |
| `model` | str | 模型名 (deepseek-v4-flash / deepseek-v4-pro 等) |
| `api_key_name` | str | API Key 名称/别名 |
| `input_tokens` | int | 输入 token 数（不含缓存命中） |
| `output_tokens` | int | 输出 token 数 |
| `cached_input_tokens` | int | 缓存命中 token 数 |
| `total_tokens` | int | 总 token 数 |
| `cost` | float | 费用 (CNY/USD) |

**detail.csv — 费用明细：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `date` | str | 日期 |
| `api_key_name` | str | API Key 名称 |
| `model` | str | 模型名 |
| `input_cost` | float | 输入费用 |
| `output_cost` | float | 输出费用 |
| `total_cost` | float | 总费用 |
| `currency` | str | 币种 |

> ⚠️ 以上字段结构基于 Web 控制台导出格式推测。实际开发时需用真实数据验证并适配。

---

## 三、技术实现

### 新增模块：`backend/collectors/deepseek_csv.py`

```
backend/collectors/deepseek_csv.py
  ├── class DeepseekCSVCollector
  │   ├── fetch_zip(from_ts, to_ts) → bytes          # 下载 zip
  │   ├── extract_csvs(zip_bytes) → dict[str, BytesIO] # 解压
  │   ├── parse_amount_csv(csv_text) → list[dict]     # 解析用量
  │   ├── parse_detail_csv(csv_text) → list[dict]     # 解析费用
  │   ├── deduplicate(records, existing_ids) → list   # 去重
  │   └── sync_to_db(records) → int                   # 同步 SQLite
```

### 数据流

```
collect_deepseek_loop() — 每 1-2 小时触发
  │
  ├── 1. fetch_zip()
  │      GET /dashboard/usage?from=X&to=Y
  │      → 返回 zip bytes
  │
  ├── 2. extract_csvs()
  │      zipfile.ZipFile(io.BytesIO(zip_bytes))
  │      → 读取 amount.csv + detail.csv
  │
  ├── 3. parse CSV
  │      csv.DictReader → 字段映射 + 标准化
  │      → [{date, model, input_tokens, ...}, ...]
  │
  ├── 4. deduplicate
  │      以 (date, model) 组合去重
  │      → 只插入未入库的记录
  │
  ├── 5. sync_to_db()
  │      INSERT INTO deepseek_usage
  │      → 返回新导入条数
  │
  └── 6. broadcast()
         通知前端数据已更新
```

### 时间窗口策略

```
首次获取: 最近 30 天全量
后续增量: 上次同步时间 → now
去重策略: INSERT OR IGNORE（基于 date + model 唯一约束）
```

### 频率控制

```python
# 循环内
last_sync = datetime.min
SYNC_INTERVAL = timedelta(hours=1)

if now - last_sync >= SYNC_INTERVAL:
    collector.fetch_and_sync()
    last_sync = now
```

---

## 四、数据库适配

### 现有表结构（无需修改）

```sql
-- backend/database.py 已定义
CREATE TABLE IF NOT EXISTS deepseek_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cached_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    cost REAL DEFAULT 0.0
);
```

`cached_tokens` 字段已存在，对应 CSV 中的 `cached_input_tokens` — **缓存命中/非命中区分直接可存储。**

### 建议新增索引

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_date_model
ON deepseek_usage(date(timestamp), model);
```

用于去重。

---

## 五、降级策略

| 场景 | Pulse 行为 |
|------|-----------|
| `/dashboard/usage` 返回 200 | 正常解析 + 同步 |
| 返回 401/403 | 日志告警 "API Key 权限不足"，继续尝试 |
| 返回 404 | **端点已下线** → 停止调用，降级为纯余额监控 |
| 返回非 zip 格式 | 日志告警 "格式变更"，跳过本次同步 |
| CSV 字段不匹配 | 解析失败 → 不写入 DB → 日志记录差异字段 |
| 连续 3 次失败 | 发送 WebSocket 告警到前端 |
| 网络超时 | 指数退避重试，最多 3 次 |

**最差情况：** 当 `/dashboard/usage` 彻底不可用时，Pulse 仍正常运行 — Token 用量图表显示 SQLite 中有缓存的最后一批数据，余额面板继续实时更新，用户可通过 CSV 手动导入补充。

---

## 六、待确认事项

| 事项 | 优先级 | 确认方式 |
|------|--------|----------|
| zip 内 CSV 的准确字段名和格式 | P0 | 用真实 API Key 调一次 `/dashboard/usage` 看响应 |
| 是否有缓存命中标识字段 | P0 | 同上 — 看 CSV 中是否有 `cached_input_tokens` 或类似列 |
| 时间窗口上限（最多能查多少天？） | P1 | 同上 |
| Deepseek 官方是否计划公开此端点 | P2 | 问客服 |

---

## 七、相关文档

- `docs/错题本.md` — KNOWN-002
- `docs/交接文档.md` — 数据采集流程图
- `backend/collectors/deepseek.py` — 当前采集器
- `backend/database.py` — deepseek_usage 表结构
- [Deepseek API Docs](https://api-docs.deepseek.com) — 公开 API 参考
