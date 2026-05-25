# Slate / Frontend

Web 管理端：登录后管理「设备 ↔ 相册 ↔ 内容」三级关系，把图片内容、动态内容、音频和标题推到 backend，由 backend 转给设备。

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | React 19 + React Router v7 |
| 构建 | Vite 8 |
| 样式 | Tailwind v4（`@theme` token） |
| 组件原语 | Radix UI（Dialog / DropdownMenu / Select / Toast） |
| 拖拽 | dnd-kit（core + sortable + utilities） |
| 数据 | TanStack Query 5 + axios |
| 图标 | lucide-react |
| 上传 | react-dropzone |

## 设计系统 Mono Press

报刊编辑风格：宋体做标题与中文锚点，Plex Sans/Mono 做 UI 与技术细节，零圆角、薄发丝线分割。

完整 token 在 `src/styles/global.css` 的 `@theme` 区。

### 字体

| token | 栈 | 用途 |
|---|---|---|
| `--font-serif` | Noto Serif SC → Source Han Serif SC → Songti SC → STSong → Georgia | 中英文标题；正文锚点 |
| `--font-sans` | IBM Plex Sans → Helvetica Neue → Helvetica → Arial | UI 默认 |
| `--font-mono` | IBM Plex Mono → JetBrains Mono → ui-monospace | 代码 / 数字 |

### 配色

| token | 色值 | 用途 |
|---|---|---|
| `--color-paper` | `#f5f3ed` | 纸本底色 |
| `--color-cream` | `#efebe1` | 卡片二级背景 |
| `--color-cream-deep` | `#e6e1d4` | hover / 分组背景 |
| `--color-ink` | `#14110d` | 主色墨黑 |
| `--color-stone` | `#6b665d` | 次要文字（mute） |
| `--color-stone-light` | `#a39d92` | 弱化文字（dim） |
| `--color-line` | `#d8d2bf` | 浅 hairline |
| `--color-clay` | `#a8281c` | 砖红，**仅** 用于危险 / 低电量 / 错误 |

不用蓝紫；不用灰阶 fill；clay 是唯一警示色，正常态绝不出现。

### 形态

- **圆角全部 0px**（`--radius-*` 全部置 0），通过 `global.css` 顶层选择器把 Tailwind utility 的 radius 强制覆写为 0（排除 Radix 弹层避免破样式）。
- **边框**：卡片用 1px ink 墨线（`.craft-card`）；分割用 hairline `--color-line` 或多层 rule（`DoubleRule`）。
- **阴影**：仅 dialog / dropdown / drag，无模糊浮起。dialog 阴影 `4px 4px 0 rgba(20,17,13,0.12)` 偏移直角硬阴影。
- **焦点环**：`outline: 2px solid var(--color-ink)` + 2px offset，无 blur。

## 结构

```
src/
├── app/
│   ├── main.tsx        入口：BrowserRouter + QueryClientProvider + Auth/Toast/Confirm Provider
│   └── App.tsx         路由表（Login / Register / Dashboard / GroupDetail / content editors）
├── styles/global.css   Tailwind v4 + Mono Press tokens + .craft-* primitives
├── lib/
│   ├── api.ts          axios 实例：baseURL '/', auto Bearer JWT, 401 跳 /login
│   ├── api-error.ts    解包 ApiErrorEnvelope
│   ├── cities.ts       天气动态内容城市列表与搜索数据
│   ├── cn.ts           tailwind-merge 包装
│   ├── colors.ts       从 token 派生的语义色
│   ├── dnd.ts          useDndOrder：dnd-kit + 乐观更新 + 后端 reorder mutation
│   ├── format.ts       isOnline / timeAgo / rssiLabel / formatBytes / normalizeMac / normalizePairCode
│   ├── hooks.ts        通用 hooks
│   ├── image.ts        1bpp blob → ImageData
│   └── styles.ts       共用 className 片段（dialogContentCls / dialogOverlayCls 等）
├── pages/
│   ├── auth/           LoginPage / RegisterPage
│   ├── dashboard/      DashboardPage：首页设备 grid + 相册 grid；/devices/:did deep link
│   ├── groups/         GroupDetailPage：内容列表 + 操作
│   └── contents/       ContentNewPage / ImageContentEditorPage / DynamicContentEditorPage
├── components/
│   ├── layout/         Layout / AuthLayout / RequireAuth / Section
│   ├── ui/             Button / Input / Select / DialogHeader / EmptyState / FormSection / IconBlock 等原语
│   └── feedback/       Toast + Confirm Provider：useToast() / await confirm()
└── features/
    ├── auth/           AuthProvider + useAuth + 登录注册 query hooks
    ├── devices/        设备卡片、绑定弹窗、详情弹窗与 device queries
    ├── groups/         相册卡片、新建弹窗与 group queries
    ├── contents/       内容卡片、新建编辑器、图片编辑器、音频预览与 content queries
    │   └── components/image-editor/
    │       ├── ImageDropzone.tsx
    │       ├── AudioDropzone.tsx
    │       ├── DitherControls.tsx
    │       └── PreviewCanvas.tsx
    └── dynamic-content/ 动态内容配置表单、类型选择、默认配置与状态栏标题
```

## 路由

| path | 组件 | 说明 |
|---|---|---|
| `/login` | `LoginPage` | 邮箱 / 用户名 + 密码，POST /sessions → token 入 localStorage |
| `/register` | `RegisterPage` | 邮箱 + 用户名 + 密码注册 |
| `/` | `DashboardPage` | 总览：设备 grid + 相册 grid |
| `/devices/:did` | `DashboardPage` | deep link，自动打开对应 `DeviceModal`，关闭时 `navigate('/')` 回首页 |
| `/groups/:gid` | `GroupDetailPage` | 单相册内容列表 + 重排 + 编辑入口 |
| `/groups/:gid/contents/new` | `ContentNewPage` | 统一新建入口：图片 + 动态内容 |
| `/groups/:gid/contents/image/:contentId/edit` | `ImageContentEditorPage` | 编辑图片内容 |
| `/groups/:gid/contents/dynamic/:contentId/edit` | `DynamicContentEditorPage` | 编辑动态内容 |
| 其它 | `<Navigate to="/" />` | |

> 故意没有独立 `/groups` 列表页 —— Dashboard 已经是入口；独立 `DeviceDetail` 路由也不留，统一走 Dashboard 上的 Modal。

## 数据流

- **状态管理**：TanStack Query 一把梭。服务端态按 feature 放在 `features/*/queries.ts`，组件只调 `useDevices()` / `useGroups()` / `useGroupContents(gid)` 这类 hook。mutation 在 `onSuccess` 里 `invalidateQueries` 触发 refetch。
- **缓存策略**：`staleTime: 30s`，`refetchOnWindowFocus: false`（避免 e-ink 调试频繁请求）。设备列表 `refetchInterval: 30s` 保持 `last_seen_at` 新鲜。
- **content binary**：`useContentImage(contentId, etag)` 的 queryKey 带 etag，`staleTime: Infinity` —— etag 不变就永远不重拉，跟设备端 ETag/304 行为一致。

## API 客户端

`lib/api.ts` 的 axios 实例：

- `baseURL: '/'`；dev 时 Vite 反代 `/api` 与 `/healthz` 到 `:3001`，prod 同域。
- request 拦截器读 `localStorage.getItem('slate_jwt')` 自动补 `Authorization: Bearer`。
- response 拦截器 401 时清 token + `window.location.href = '/login'`（不在 `/login` 时才跳，避免登录页 401 自循环）。

错误体走 backend 的 `ApiErrorEnvelope`：`{error, message, detail?, requestId?}`。toast 直接展示 `message`。

## 类型来源 = `shared`

vite alias `shared` → `../shared/src`，所有 DTO 与 response 类型 import 自 `shared`：

```ts
import type { DeviceSummaryT, ContentMutationResponseT, ManifestResponseT } from 'shared';
```

预览阶段也直接调 `shared` 的纯函数：

```ts
import { rgbaToGray, autoInvert, autoContrast, ditherToBinary } from 'shared';
```

`PreviewCanvas` 跟 backend `ImageRendererService` 走同一套 5 步管线（解码 → 灰度 → autoInvert → autoContrast → dither），这就是预览与设备显示「所见即所得」的根据。

## Vite chunk 策略

`vite.config.ts` 的 `manualChunks` 按变更频率分四块独立缓存，业务代码改动只 invalidate `app` chunk：

| chunk | 包 |
|---|---|
| `react-vendor` | react, react-dom, react-router-dom, scheduler |
| `radix-vendor` | `@radix-ui/*` |
| `dnd-vendor` | `@dnd-kit/*` |
| `lucide-vendor` | lucide-react |

## 本地开发

```bash
bun install
bun run dev:frontend                        # http://localhost:5173
bun run --cwd frontend lint
bun run --cwd frontend typecheck
bun run --cwd frontend build                # 出 dist/
```

dev 需 `bun run dev:backend` 同时跑（Vite proxy `/api → :3001`）。生产环境 `dist/` 直接由 backend 的 `@fastify/static` 同域托管，SPA fallback 在 `backend/src/main.ts` 的 `onSend` hook 里。
