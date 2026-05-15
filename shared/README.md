# Slate / Shared

前后端共用的 zod schema、运行时常量、1bpp 渲染纯函数。

`backend/` 与 `frontend/` 都直接 `import { ... } from 'shared'` 消费 `src/` 下的 TS 源码（vite alias + tsconfig path 都指向 `../shared/src`，**不出 build 产物**）—— 保证两端永远对得上同一份字段名、同一份枚举、同一份 dither 算法。

## 结构

```
src/
├── index.ts         barrel，re-export 下面所有
├── api.ts           顶层常量（API_PREFIX / FRAME_* / AUDIO_*）+ Web 鉴权 schema（Login / Register / Error envelope）
├── types/
│   ├── device.ts    设备协议：register / poll / state / cycle 的 zod schema
│   ├── group.ts     group CRUD 与 reorder
│   ├── content.ts   content manifest / mutation / preview schema
│   └── dynamic.ts   动态内容 config / ingest schema
├── dither.ts        6 种 1bpp 抖动算法（纯 TS，无 sharp 依赖）
└── preprocess.ts    dither 前的灰度预处理（前后端必须按同一顺序调）
```

## 关键常量（`api.ts`）

| 常量 | 值 | 说明 |
|---|---|---|
| `API_PREFIX` | `/api/v1` | 所有 HTTP 端点的前缀（`/healthz` 例外） |
| `FRAME_WIDTH × FRAME_HEIGHT` | 400 × 300 | 4.2 英寸黑白 EPD 像素 |
| `FRAME_BYTES` | 15000 | 1bpp packed 整帧字节 |
| `BW_THRESHOLD_DEFAULT` | 128 | sharp 管线默认阈值（与固件 `bw_threshold_=200` 是两套独立通路，不联动） |
| `AUDIO_SAMPLE_RATE` | 16000 | `.pcm` 采样率 |
| `AUDIO_BITS_PER_SAMPLE` | 16 | 16-bit signed little-endian |
| `AUDIO_CHANNELS` | 1 | 单声道 |

## 设备鉴权约定

- 注册：`POST /api/v1/devices/register`，无鉴权，body `{mac}`；同 mac 二次进来一律走 reset 路径（清 owner、清相册、轮换 secret + pair_code）。
- 注册响应一次性下发 `device_secret`（64 字符 hex），固件 NVS 持久化，DB 只存 `sha256(secret)`。
- 后续受保护端点全部 `Authorization: Bearer <device_secret>`。

## Schema 命名约定

每个端点对应一个 zod schema + 一个 `*T` 类型别名：

```ts
export const PollRequest = z.object({ telemetry: z.object({...}).optional() });
export type  PollRequestT = z.infer<typeof PollRequest>;
```

backend 的 `ZodValidationPipe` 通过 DTO 上的 `static schema = *Request` 校验入参；frontend 的 axios 把 `*Response` / `*Summary` 当返回值类型。

## Dither 算法（`dither.ts`）

6 种 1bpp 抖动模式：

| `DitherMode` | UI 标签 | 用途 |
|---|---|---|
| `threshold` | 线稿 · 纯黑白 | 简笔画 / icon / 二值素材 |
| `bayer4` | 网点 · 粗 | Bayer 4×4，复古海报感 |
| `bayer8` | 网点 · 细 | Bayer 8×8，点阵更细 |
| `floyd` | 照片 · 推荐 | Floyd-Steinberg，颗粒细腻（UI 默认） |
| `atkinson` | 照片 · 高对比 | Atkinson，亮的更亮（老 Mac 风） |
| `sierra` | 照片 · 柔和 | Sierra Lite，接近 FS 但更轻 |

- `API_DEFAULT_DITHER_MODE = 'threshold'` —— API 默认值，旧调用方不传时不破坏向后兼容
- `DEFAULT_DITHER_MODE = 'floyd'` —— 新建帧的 UI 默认

`ditherTo1bpp(gray, w, h, opts) → Uint8Array`：MSB-first，bit=1 为白 / bit=0 为黑，与 firmware `epd_ssd1683.cc` 的字节序对齐。`ditherToBinary` 输出每像素 0/255 的灰度，前端 `<canvas>` `putImageData` 直接画。

## 预处理管线（`preprocess.ts`）

backend `RenderService` 与 frontend `PreviewCanvas` 必须按同一顺序调：

1. **解码到 RGBA** —— 浏览器 `ImageData` 或 sharp `.raw()`
2. **`rgbaToGray`** —— Rec.709 系数（0.2126 / 0.7152 / 0.0722），与 sharp `.grayscale()` 同步
3. **`autoInvert`** —— 四角内一格的均值若 < 128 视为黑底图，整体翻成白底
4. **`autoContrast`**（cutoff = 1）—— 等价 PIL `ImageOps.autocontrast`，去两端 cutoff%
5. **`ditherTo*`** —— 见上

任一步前后端不一致都会导致预览与设备显示对不上。

## 用法

backend：

```ts
import { API_PREFIX, ManifestResponse, ditherTo1bpp } from 'shared';
```

frontend：

```ts
import type { DeviceSummaryT, ContentMutationResponseT } from 'shared';
import { rgbaToGray, autoInvert, autoContrast, ditherToBinary } from 'shared';
```

`shared/package.json` 的 `scripts.build` 仅供 typecheck，运行期不出 dist。
