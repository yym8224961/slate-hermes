# slate · 前端 aesthetic（design tokens + 组件语言）

> 本文是 `frontend/` 的视觉宪法。所有页面都按这一套语言落地。

## 调性："Industrial Dashboard"

呼应 e-ink 物理纸感 + 老式控制室面板。**不要**：紫蓝渐变 / Inter/Roboto/Space Grotesk/Arial/Helvetica / 玻璃化 backdrop blur / 大圆角卡片 / pastel 调色板 / 圆形头像 / emoji 图标。

**要**：单色（黑/白/锈红 accent）/ 等宽数字 / 直角/2px 微圆角 / 1px hairline 边框 / 4 的倍数网格 / ALL CAPS 小标题 / 单据/打孔边装饰 / ASCII spinner / 瞬时硬切动效。

## Design Tokens

### 字体

```css
/* Display + 数字 + label：IBM Plex Mono（免费 Google Fonts） */
--font-display: 'IBM Plex Mono', ui-monospace, 'SF Mono', monospace;
/* Body：IBM Plex Sans（同字体集天然成对） */
--font-body: 'IBM Plex Sans', system-ui, sans-serif;

/* Sizes（4 的倍数律动）*/
--text-xs:   12px;   /* 角注 / tick / 次要 meta */
--text-sm:   14px;   /* body 默认 */
--text-base: 16px;   /* form input */
--text-md:   20px;   /* 二级标题 */
--text-lg:   28px;   /* 一级标题 */
--text-xl:   40px;   /* hero 数字（电池百分比这种） */
```

### 配色

```css
--ink:    #0F0F0E;   /* 近黑 / 主前景 / e-ink 黑 */
--paper:  #F5F2EC;   /* 米白纸色 / 主背景 / e-ink 白 */
--rust:   #7C2D12;   /* 锈红 accent / 仅用于关键操作 + 警示 */
--ash:    #A6A09A;   /* 灰 / 禁用 / hairline 较弱时 */
--hairline: #0F0F0E;     /* 1px 边框 = ink */
--hairline-soft: #A6A09A; /* 次要边框 */
```

不用任何蓝/绿/紫，不用渐变，不用 box-shadow。

### 间距 / 圆角 / 边框

```css
/* 间距：4 的倍数 */
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-6: 24px;
--space-8: 32px;
--space-12: 48px;

/* 圆角：直角 + 微圆 */
--radius-0: 0;       /* 卡片 / 表格 / 设备项 */
--radius-2: 2px;     /* 按钮 / input（仅刚硬度调和） */

/* 边框 */
--border-1: 1px solid var(--hairline);
--border-1-soft: 1px solid var(--hairline-soft);
--border-2: 2px solid var(--hairline);  /* 强调标尺 */
```

### 排版语言

- 章节小标题：`text-transform: uppercase; letter-spacing: 0.1em; font-family: var(--font-display); font-size: 12px;`
- 长 label：用方括号包，如 `[DEVICE STATUS]`、`[FRAME LIBRARY]`
- 数字表格：`font-variant-numeric: tabular-nums;` + IBM Plex Mono
- 加粗用 700，不用 600；强调靠加粗+大写+字距，不靠颜色

### 动效

- 无 ease 曲线 fancy 动画。状态变化瞬时硬切。
- Button hover：黑底白字 ↔ 白底黑字 反白（150ms transform: none, color 瞬时切）
- Loading：ASCII spinner `[/]` `[-]` `[\]` `[|]`（120ms 一帧），不要圆形 spinner
- Toast：从顶部 8px 处快闪入（120ms translate）
- 列表入场：staggered 30ms delay，一行一行硬切（不要 fade）

### 装饰元素（这套语言的"指纹"）

1. **刻度尺 header**：每页顶部一条 1px 横线，下面 8px 处用 1px tick 排列模拟毫米刻度
   ```html
   <div class="rule">
     <div class="ticks"><!-- 100 个 1px tick --></div>
   </div>
   ```
2. **打孔边**：列表项左右两侧 4px×4px 圆点 hairline，模仿单据
3. **方括号 label**：`[BATTERY]` `[RSSI]` `[FW VER]` 等所有 metadata 都加方括号
4. **章节分割**：粗细线交错（2px + 1px），不用空白

## 关键组件 mockup

### 1. Login

```
┌──────────────────────────────────────────────────────────────┐
│ ─────  rule with mm ticks  ───────────────────────────────── │
│                                                              │
│   [SLATE]                                                    │
│                                                              │
│   ━━━━ AUTHENTICATE ━━━━                                     │
│                                                              │
│   ┌──────────────────────────────────┐                       │
│   │ EMAIL                            │                       │
│   │ admin@example.com                │  ← 1px hairline,      │
│   └──────────────────────────────────┘    label 在 input 内   │
│                                            top 4px           │
│   ┌──────────────────────────────────┐                       │
│   │ PASSWORD                         │                       │
│   │ ••••••••                         │                       │
│   └──────────────────────────────────┘                       │
│                                                              │
│   ┌────────────────────┐                                     │
│   │   ENTER  [⏎]       │   ← 黑底白字按钮，hover 反白         │
│   └────────────────────┘                                     │
│                                                              │
│   v0.1.0 · slate.example.com                                 │
└──────────────────────────────────────────────────────────────┘
```

### 2. Dashboard / 设备列表

```
┌──────────────────────────────────────────────────────────────┐
│ [SLATE]                                          [LOGOUT]    │
│ ──────────────────────────────────────────────────────────── │
│ ︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙ mm ticks ︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙ │
│                                                              │
│ ━━━━ DEVICES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ [+ CLAIM]  ━ │
│                                                              │
│  •  MAC                NAME       GROUP    BATT  RSSI  SEEN •│
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│  •  AA:BB:..:01        客厅相框    挖掘机   88%   -54  3m前  •│
│  •  AA:BB:..:02        书房        天气     43%   -71  1h前  •│
│  •  AA:BB:..:03        --          --       --    --   离线  •│
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                              │
│ ━━━━ GROUPS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ [+ NEW]    ━ │
│  •  NAME            KIND      FRAMES   ETAG (8)              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│  •  工程车系列     STATIC     12       a1b2c3d4              │
│  •  天气看板       DYNAMIC    1        ef901234              │
└──────────────────────────────────────────────────────────────┘
```

设备/组每行都用 `•` 打孔边装饰，`━` 粗线分组，`─` 细线分行。

### 3. Group detail / 帧上传

```
┌──────────────────────────────────────────────────────────────┐
│ [SLATE]  /  GROUPS  /  工程车系列                [LOGOUT]   │
│ ──────────────────────────────────────────────────────────── │
│ ︙︙︙ mm ticks ︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙︙ │
│                                                              │
│ [GROUP]   工程车系列                                          │
│ [KIND]    STATIC                                             │
│ [ETAG]    a1b2c3d4...                                        │
│ [FRAMES]  12                                                 │
│                                                              │
│ ━━━━ UPLOAD NEW FRAME ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                              │
│ ┌──────────────────────────┐   ┌──────────────────────────┐ │
│ │  +  DROP IMAGE           │   │  PREVIEW (1bpp)          │ │
│ │     OR CLICK             │   │  400×300                 │ │
│ │                          │   │  [canvas threshold→]     │ │
│ └──────────────────────────┘   └──────────────────────────┘ │
│ THRESHOLD  ─────●──────  128  /255                            │
│                                                              │
│ ┌──────────────────────────┐                                  │
│ │  + ATTACH AUDIO (.pcm)   │  IDX  [_____]  ← 留空 = 追加   │
│ └──────────────────────────┘                                  │
│                                                              │
│ ┌────────────────────┐                                       │
│ │   UPLOAD  [↑]      │                                       │
│ └────────────────────┘                                       │
│                                                              │
│ ━━━━ EXISTING FRAMES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│  IDX  THUMB(40×30)   IMAGE_ETAG  AUDIO_ETAG  SIZE             │
│ ──────────────────────────────────────────────────────────── │
│  00   [▤▤▤]          a1b2c3d4    ef901234    15000            │
│  01   [▤▤▤]          5e6f7890    xy123456    15000            │
│ ...                                                          │
└──────────────────────────────────────────────────────────────┘
```

### 4. Device detail / 推送动作

```
┌──────────────────────────────────────────────────────────────┐
│ [SLATE]  /  DEVICES  /  客厅相框                 [LOGOUT]   │
│ ──────────────────────────────────────────────────────────── │
│                                                              │
│ [MAC]      AA:BB:CC:DD:EE:01                                 │
│ [TOKEN]    sk_*** *** *** *** [REVEAL]                       │
│ [GROUP]    工程车系列                                          │
│ [BATT]     ▌▌▌▌▌▌▌▌    88%                                   │
│ [RSSI]     -54 dBm  ▌▌▌▌▌                                    │
│ [FW]       0.1.0                                             │
│ [SEEN]     3 minutes ago                                     │
│                                                              │
│ ━━━━ PUSH ACTION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                              │
│  SWITCH GROUP TO:                                            │
│  ┌───────────────────┐  ┌─────────────────────┐              │
│  │ 工程车系列      ▼ │  │   PUSH NOW [▶]      │              │
│  └───────────────────┘  └─────────────────────┘              │
│                                                              │
│  ┌─────────────────────┐  ┌─────────────────────┐            │
│  │   SYNC NOW [⟳]      │  │   REBOOT [⏻]   ★⚠ │ ← 锈红警示  │
│  └─────────────────────┘  └─────────────────────┘            │
│                                                              │
│ ━━━━ PENDING ACTIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│  ID            KIND          QUEUED       ACK                │
│ ──────────────────────────────────────────────────────────── │
│  cm5xy...      switch_group  3m ago       ✓ 1m ago           │
│  cm4ab...      reboot        20m ago      ✓ 19m ago          │
└──────────────────────────────────────────────────────────────┘
```

## Tailwind config 落地

`frontend/tailwind.config.ts` 把上面 tokens 翻译成 Tailwind theme：

```ts
export default {
  theme: {
    fontFamily: {
      mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
    },
    colors: {
      ink: '#0F0F0E',
      paper: '#F5F2EC',
      rust: '#7C2D12',
      ash: '#A6A09A',
    },
    borderRadius: {
      none: '0',
      sm: '2px',
    },
    extend: {
      letterSpacing: { wide: '0.1em' },
      borderWidth: { hairline: '1px' },
    },
  },
}
```

## 字体加载

`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&family=IBM+Plex+Sans:wght@400;500;700&display=swap">`

正式部署可下载 woff2 自托管，避免 Google Fonts CDN 在中国大陆抖动。

## 反复检查清单

落代码时按这清单 self-review：
- [ ] 没用 Inter / Roboto / Space Grotesk / Arial / Helvetica
- [ ] 没紫色 / 蓝色 / 绿色 / 渐变 / 玻璃化
- [ ] 没 box-shadow，深度只用 hairline 边框做
- [ ] 圆角只在按钮/input 用 2px，其它直角
- [ ] 数字栏目都是 IBM Plex Mono + tabular-nums
- [ ] 章节标题都 ALL CAPS + letter-spacing 0.1em
- [ ] metadata label 都用 `[XXX]` 方括号
- [ ] 间距全部是 4 的倍数
- [ ] Loading 用 ASCII spinner，不用圆圈 spinner
- [ ] 设备/组列表行用粗细线分组 + 打孔边 `•`
- [ ] hover 是反白，不是 opacity / lighten
