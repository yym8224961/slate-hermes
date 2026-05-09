# slate / frontend

React 19 + Vite 8 + Tailwind v4 + Radix + dnd-kit + TanStack Query 的管理后台。登录后管理「设备 ↔ 内容组（group）↔ 帧（frame）」三级关系，并把图 / 音 / caption 推到 backend，由 backend 转给设备。

## 设计语言：soft-craft

家庭手账与便签纸的视觉语言，不是 fintech 风也不是工业控制台风。

- **字体**：中文 [霞鹜文楷屏幕版](https://github.com/lxgw/LxgwWenkaiScreen)（jsdelivr CDN），英文 [Fraunces](https://fonts.google.com/specimen/Fraunces) display + [DM Sans](https://fonts.google.com/specimen/DM+Sans) 正文，等宽 JetBrains Mono。不用 Inter / Roboto / Helvetica。
- **配色**：奶油纸 `#faf6ef` + 暖墨棕 `#3d2817` + 砖红 `#b85436` + 鹅黄 `#e8b86d` + 苔绿 `#6b8e4e`（在线状态）。不用蓝 / 紫，不用灰阶。
- **形状**：大圆角（14 / 22 / 28 px）、暖色软边框 `#e2d8c4`、hover 微浮（`translateY(-2px)` + soft shadow）。
- **装饰**：手绘感波浪分割（`.wave-divider` SVG repeat-x）替代 hairline；心跳点 loading（`.heart-dot`）替代 spinner；中文标题用 `.font-kai` 楷书。

完整 token 在 `src/styles/global.css` 的 `@theme` 区，由 Tailwind v4 直接读。

## 结构

```
src/
├── main.tsx           入口：BrowserRouter + QueryClientProvider + Auth/Toast/Confirm Provider
├── App.tsx            路由表（仅 3 条：Login / Dashboard / GroupDetail）
├── styles/global.css  Tailwind v4 + design tokens（@theme）+ soft-craft primitives
├── lib/
│   ├── api.ts         axios 实例：baseURL '/'、auto Bearer JWT、401 跳 /login
│   ├── auth.tsx       AuthProvider + useAuth（token / login / logout）
│   ├── queries.ts     全部 useQuery / useMutation hooks（devices / groups / frames）
│   ├── format.ts      isOnline / timeAgo / rssiLabel / greeting / formatBytes
│   ├── dnd.ts         useDndOrder：dnd-kit + 乐观更新 + 后端 reorder mutation
│   ├── styles.ts      共用 className 片段
│   └── cn.ts          clsx-style 合并
├── routes/
│   ├── Login.tsx      左侧大色块 + 楷书欢迎语，右侧表单
│   ├── Dashboard.tsx  首页：设备 grid + 内容组 grid。/devices/:did 是 deep link
│   └── GroupDetail.tsx /groups/:gid 帧管理（列表 + dropzone + FrameEditor）
└── components/
    ├── Layout.tsx              header（logo + 用户菜单）
    ├── RequireAuth.tsx         路由守卫，无 token 跳 /login
    ├── Section.tsx             页内分块 + 楷书标题 + wave-divider
    ├── Card.tsx                通用卡片（圆角 + 奶米底 + hover 浮起）
    ├── Button.tsx              5 种 variant（primary / outline / soft / danger / link）
    ├── Input.tsx               label-on-top input + 错误提示
    ├── Select.tsx              Radix Select 包装
    ├── Spinner.tsx             心跳点 loading
    ├── Toast.tsx + Confirm.tsx Provider 风格，window.toast() / await confirm()
    ├── EmptyState.tsx          缺省态（图标 + 楷书提示 + CTA）
    ├── IconBlock.tsx           大色块 logo / 图标方块
    ├── DeviceModal.tsx         设备详情：在线 / 电池 / RSSI / 固件 + 切组 + 解绑
    ├── AddDeviceDialog.tsx     按 MAC 认领设备的对话框
    ├── FrameCard.tsx           组详情里的帧卡（thumb + caption + 操作）
    ├── FrameEditor.tsx         帧上传 / 编辑壳，组合下面 frame-editor/* 4 个组件
    ├── frame-editor/
    │   ├── ImageDropzone.tsx   react-dropzone 拖入图片
    │   ├── AudioDropzone.tsx   拖入音频（传给 backend ffmpeg 转 PCM）
    │   ├── DitherControls.tsx  阈值滑块 + 6 种 dither 模式（shared.DITHER_INFO）
    │   └── PreviewCanvas.tsx   <canvas> 用 shared 的同一套 preprocess + dither 出预览
    ├── AudioPlayPreview.tsx    .pcm raw 解码后 Web Audio 播
    └── StatusBarOverlay.tsx    设备 frame 预览顶部的状态栏 mock
```

## 路由

| path | 组件 | 说明 |
|---|---|---|
| `/login` | `Login` | 邮箱 + 密码，POST /sessions → token 入 localStorage |
| `/` | `Dashboard` | 总览：设备 grid + 内容组 grid |
| `/devices/:did` | `Dashboard` | deep link，自动打开对应 `DeviceModal`，关闭时 navigate('/') 回首页 |
| `/groups/:gid` | `GroupDetail` | 帧管理：列表 + 上传 + 重排 + 编辑 caption / audio |
| 其它 | `<Navigate to="/">` | |

`/groups` 列表页**故意不存在** —— 总览页本身就是入口。独立 `DeviceDetail` 路由也已删（统一走 modal）。

## 数据流

- **状态管理**：TanStack Query 一把梭。所有服务端态在 `lib/queries.ts`，组件只调 `useDevices()` / `useGroups()` / `useGroupFrames(gid)` 这种 hook。mutation 在 `onSuccess` 里 `invalidateQueries` 触发 refetch。
- **缓存策略**：`staleTime: 30s`、`refetchOnWindowFocus: false`（避免 e-ink 调试时频繁请求）。设备列表 `refetchInterval: 30s` 保持 lastSeenAt 新鲜。
- **frame binary**：`useFrameImage(gid, seq, etag)` 的 queryKey 包含 etag，`staleTime: Infinity` —— etag 不变就永远不重拉，跟设备端 ETag/304 行为一致。

## API 客户端

`lib/api.ts` 的 axios 实例：

- `baseURL: '/'`，dev 时 vite 反代 `/api` 与 `/healthz` 到 `:3001`，prod 同域。
- request 拦截器读 `localStorage.getItem('slate_jwt')` 自动补 `Authorization: Bearer`。
- response 拦截器在 401 时清 token + `window.location.href = '/login'`，避免 SPA history 残留。

错误体走 backend 的 `ApiErrorEnvelope`：`{error, message, detail?, requestId?}`。toast 直接展示 `message`。

## 类型来源 = `shared`

vite alias `shared` → `../shared/src`，所有 DTO 与 response 类型 import 自 `shared`：

```ts
import type { DeviceSummaryT, FrameMutationResponseT, ManifestResponseT } from 'shared';
```

预览阶段也直接调 `shared` 的纯函数：

```ts
import { rgbaToGray, autoInvert, autoContrast, ditherToBinary } from 'shared';
```

`FrameEditor` 的 `PreviewCanvas` 跟 backend `RenderService` 走的是同一套 5 步管线（解码 → 灰度 → autoInvert → autoContrast → dither）。这就是预览跟设备显示「所见即所得」的根据。

## 本地开发

```bash
bun install
bun run dev:frontend                        # http://localhost:5173，proxy /api → :3001
bun run --cwd frontend lint
bun run --cwd frontend typecheck
bun run --cwd frontend build                # → dist/，生产由 backend fastify-static 托管
```

dev 需要 `bun run dev:backend` 同时跑。生产单镜像里 `dist/` 直接由 backend 同域 serve，SPA fallback 在 `backend/src/main.ts` 的 onSend hook 里。

## CSS 与类名约定

- 颜色 / 圆角 / 字体只走 `@theme` token，不写裸十六进制。
- 卡片用 `.craft-card` 或 `.craft-card-danger`（破坏性操作染砖红 hover）。
- 所有按钮走 `<Button>` 组件，避免一处一种 hover。
- 中文标题加 `.font-kai`，英文标题加 `.font-serif`，等宽数字加 `.font-mono`。
- 入场动画用 `.fade-up` + `.fade-up-{1..4}` stagger。
