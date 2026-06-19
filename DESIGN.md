# Design

## Visual Theme

**暗色 · 构成主义 · 工业监控**

物理场景：Surface Go 10寸屏，视距约40cm（等效27寸显示器2m观看），作为开发时的辅助远距扫视屏。深色背景下高对比红白元素，粗重硬边几何。

场景决定答案：工具型产品 + 展示型品牌 → 深色背景（非炫酷目的，而是工业控制台的功能性暗色），让红色数据点像警报灯一样醒目。

## Color

```css
/* 主色板 — 红黑白三色系统，占比 90%+ */
--color-red:       #CC0000;  /* 标题栏、告警、主数据线、楔形装饰 */
--color-black:     #000000;  /* 页面背景、粗边框 */
--color-white:     #FFFFFF;  /* 文字、卡片背景 */

/* 灰色阶 — 层次区分 */
--color-grey-10:   #1A1A1A;  /* 卡片背景（与纯黑微区分） */
--color-grey-30:   #4D4D4D;  /* 次要文字 */
--color-grey-50:   #808080;  /* 分割线、占位符 */
--color-grey-70:   #B3B3B3;  /* 非活跃元素 */
--color-grey-90:   #E6E6E6;  /* 图表网格线 */

/* 功能色 — 状态指示，面积 < 5% */
--color-yellow:    #FFD700;  /* 警告 */
--color-green:     #2D8A2D;  /* 在线/正常 */
--color-blue:      #0044CC;  /* 二级数据线（极少使用） */
```

色彩铁律：
- 红色永远不作大面积背景，仅用于标题栏横条、数据线、告警态、几何装饰
- 黑底白字或白底黑字二选一作为基调，不混合
- 图表最多三色（红、黑、灰）
- Surface Go 小屏等效远距 → 色块面积要足够大，不用细线条区分

## Typography

```css
/* 字体栈 */
--font-display: 'Tektur', 'Bebas Neue', 'Impact', sans-serif;
--font-heading: 'Tektur', 'Bebas Neue', 'Montserrat', sans-serif;
--font-body:    'Montserrat', 'Inter', sans-serif;
--font-mono:    'JetBrains Mono', 'Fira Code', monospace;
```

字体全部来自 Google Fonts（免费，OFL 许可）。

| Token | Size | Use |
|-------|------|-----|
| `--text-xs` | 0.75rem (12px) | 元数据、数据新鲜度标签 |
| `--text-sm` | 0.875rem (14px) | 图表轴标签、事件流 |
| `--text-base` | 1rem (16px) | 卡片辅助文字、导航 |
| `--text-lg` | 1.25rem (20px) | 卡片标题、Tab 标签 |
| `--text-xl` | 1.5rem (24px) | 图表标题、小标题 |
| `--text-2xl` | 2rem (32px) | 大标题、分组标题 |
| `--text-3xl` | 2.5rem (40px) | 看板主标题 |
| `--text-4xl` | 3.5rem (56px) | 关键 KPI 数值 |

排版规则：
- 标题全部大写（ALL CAPS），`letter-spacing: 0.15em–0.2em`
- 字号极端对比（KPI 56px vs 标签 12px，差距 4.6×）
- 所有数值用等宽字体 `JetBrains Mono`，确保数字对齐稳定
- Surface Go 等效远距 → 最小可读字号 14px

## Layout

**12 列 CSS Grid**，卡片不重叠，间距单位 4px。

```
Surface Go 10" (横向 1920×1080 或 1280×800):
┌──────────────────────────────────────────────────┐
│  ┌──────────┬──────────┬──────────┬──────────┐  │  ← 顶栏 Deepseek 概览（余额/今日用量）
│  │  余额     │  今日    │  本周     │  本月     │  │     4 等分卡片
│  └──────────┴──────────┴──────────┴──────────┘  │
│  ┌────────────────────┬─────────────────────────┐│  ← 主体区域（左 6 列 / 右 6 列）
│  │    CPU / 内存       │     Deepseek 趋势图     ││
│  │    实时折线图        │     历史 Token 用量      ││
│  │                     │                         ││
│  ├────────────────────┼─────────────────────────┤│  ← 中间分割
│  │    GPU / 温度       │    分模型 Token 明细     ││
│  │    仪表盘           │     柱状图/环形图        ││
│  ├────────────────────┼─────────────────────────┤│
│  │    磁盘 / 网络      │     缓存命中率 / 资费    ││
│  │    实时速率          │     趋势线              ││
│  └────────────────────┴─────────────────────────┘│
└──────────────────────────────────────────────────┘
```

布局原则：
- 主要指标（CPU/内存、Deepseek 余额）尺寸最大，占左上视觉焦点
- 次要指标（GPU/温度/磁盘）缩小，右下放置
- Z 型扫描路径：左上主数据 → 右上趋势 → 左下状态 → 右下明细
- 卡片间用 2px 白线分隔，无间距留白，构成主义的高密度排版

## Components

### 卡片（Card）
```css
.card {
  background: #1A1A1A;
  border: 2px solid #FFFFFF;
  border-radius: 0;          /* 直角 */
  box-shadow: 4px 4px 0 #CC0000;  /* 红色硬阴影 */
  padding: 16px;
}
```

### 标题栏（Header Bar）
```css
.header-bar {
  background: #CC0000;
  padding: 8px 16px;
  font-family: 'Tektur', sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  clip-path: polygon(0 0, 100% 0, 98% 100%, 0 100%);  /* 右侧斜切 */
}
```

### KPI 数值
```css
.kpi-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: var(--text-4xl);    /* 56px */
  font-weight: 700;
  line-height: 0.9;
  letter-spacing: 0.05em;
}
```

### 状态指示器
```css
.status-dot {
  width: 12px;
  height: 12px;
  border-radius: 0;             /* 方形点，构成主义风格 */
  background: var(--color-green);  /* 或 red / grey */
}

/* 告警状态的红色楔形替代圆点 */
.status-wedge {
  width: 0; height: 0;
  border-left: 12px solid #CC0000;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
}
```

### 装饰元素
- 红色斜线（`clip-path` 对角切割）：用于分割区块、指示趋势方向
- 红色楔形标记（异常）：替代传统感叹号图标
- 五角星（健康/优秀）：`★` unicode 字符
- 齿轮（设置/系统）：SVG inline

### 交互状态
```css
/* 悬停抬起效果 */
.card:hover {
  transform: translateY(-2px);
  box-shadow: 6px 6px 0 #CC0000;
}

/* 点击按压 */
.card:active {
  transform: translateY(1px);
  box-shadow: 2px 2px 0 #990000;
}

/* Tab 选中态 */
.tab.active {
  border-bottom: 3px solid #CC0000;
}
```

## Motion

- 实时数据更新使用 **steps(4) 机械步进缓动**：`animation: pulse-data 1s steps(4) infinite`
- 页面切换无过渡动画，瞬间切换（构成主义的"革命性突变"）
- 数值变化时数字向上滚动替换（类似机械计数器）
- 无闪烁、无渐变过渡、无弹性动画
- 所有动画时长 ≤ 300ms

### Token 定义
```css
:root {
  --ease-steps: steps(4);
  --duration-fast: 100ms;
  --duration-normal: 200ms;
  --duration-slow: 300ms;
}
```

## Spacing

间距单位：**4px**（构成主义的工业模块化）

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 24px;
--space-6: 32px;
--space-7: 48px;
--space-8: 64px;
```

卡片间距：`gap: 8px`（12 列网格）
卡片内边距：`16px`

## Data Visualization

### 实时折线图（CPU/内存/Token 趋势）
```javascript
// Chart.js 配置 — 构成主义风格
{
  color: '#FFFFFF',          // 标签白色
  borderColor: '#CC0000',    // 数据线红色
  backgroundColor: 'transparent',  // 无填充
  borderWidth: 3,            // 粗线
  tension: 0,                // 硬边折线，无圆滑
  pointRadius: 0,            // 无数据点
  grid: { color: '#2A2A2A' },   // 硬边深灰网格
  scales: { ticks: { font: { family: 'JetBrains Mono' } } }
}
```

### 环形图（GPU/磁盘使用率）
- 无渐变，纯色填充
- 圆弧两端平头（非圆角）
- 中心数值用 `--text-3xl` 等宽粗体

### 柱状图（分模型 Token 用量）
- 柱子宽度固定，间隙小
- 红色柱 + 白/灰标签
- 无圆角柱

### 单位图（ISOTYPE 风格，CSV 历史汇总）
- 重复五角星/方块表示数量
- 每个符号 = 固定单位（如 10 万 Token）
- 致敬 IZOSTAT 1930s 统计画报

## Shadows

硬阴影（Neo-Brutalism / 构成主义风格）：

```css
--shadow-sm: 2px 2px 0 #000000;
--shadow-md: 4px 4px 0 #CC0000;
--shadow-lg: 6px 6px 0 #CC0000;
```

无模糊半径（`blur-radius: 0`），纯偏移硬阴影。这是从构成主义的"几何块堆叠"语言中提取的。

## Borders

```css
--border-thin: 1px solid #FFFFFF;
--border-thick: 2px solid #FFFFFF;
--border-red: 2px solid #CC0000;
```

所有 border-radius 均为 0，直角是构成主义的核心标识。

## Breakpoints

| Breakpoint | Target | Layout |
|------------|--------|--------|
| >= 1400px | 外接大屏 / 桌面 | 12 列全宽 |
| 960–1399px | 平板横屏 | 8 列 |
| 600–959px | 平板竖屏 / 小屏 | 6 列，图表堆叠 |
| < 600px | 手机（不优先支持） | 4 列，关键指标优先 |

Surface Go 默认断点：1280×800 以下使用 8 列布局。
