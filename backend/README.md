# slate / backend

NestJS 11（Fastify）+ Prisma + MySQL 服务端。同时承担：

1. **Web 管理 API**（JWT）—— frontend 用
2. **设备协议**（`X-Device-Mac` header）—— firmware 用
3. **资源下发**（dual-auth + ETag/304）—— frontend 预览与 firmware 增量同步共用同一组端点
4. **生产部署托管 frontend dist**（`@fastify/static` + SPA fallback）

技术栈：Bun runtime、Fastify、`@nestjs/platform-fastify`、自实现 `ZodValidationPipe`、`nestjs-pino` 日志、Prisma 7（`@prisma/adapter-mariadb`）直连 MySQL、`sharp` 渲染图片、`bcryptjs` 密码、`jsonwebtoken` JWT。

## 目录

```
src/
├── main.ts                 bootstrap：Fastify + 全局 prefix /api/v1 + SPA fallback
├── app.module.ts           注册所有 module 与 4 个全局 provider（filter / interceptor / pipe / guard）
├── infra/
│   ├── config/             zod 校验过的环境变量（env.schema.ts）→ AppConfig
│   ├── logger/             pino + nestjs-pino，dev 模式 pino-pretty
│   ├── prisma/             PrismaService（MariaDB adapter）
│   └── blob/               BlobService：{BLOB_DIR}/{groupId}/{seq}.{img,pcm}
├── common/
│   ├── decorators/         @Public / @CurrentUser / @CurrentDevice
│   ├── guards/             JwtAuthGuard / DeviceAuthGuard / JwtOrDevice / JwtOrApiKey
│   ├── pipes/              ZodValidationPipe（挂 APP_PIPE，所有 DTO 自动校验）
│   ├── filters/            AppExceptionFilter：统一错误 envelope
│   ├── interceptors/       RequestIdInterceptor：每请求一个 reqId 串日志
│   ├── etag/               computeETag + respondWithEtag（304 策略）
│   └── errors/             AppError 体系（NotFound / Forbidden / Validation / Conflict）
└── modules/
    ├── auth/               POST /users 注册、POST /sessions 登录 → JWT、GET /me
    ├── users/              用户注册（写库 + bcrypt hash）
    ├── devices/            两个 controller：protocol（/me/*）与 admin（/devices/*）
    ├── groups/             /groups CRUD + cycle（next/prev）+ setDeviceGroup
    ├── frames/             /groups/:gid/frames + manifest + multipart + render
    ├── render/             sharp pipeline + 内存与磁盘缓存（blobs/render-cache/）
    ├── audio/              ffmpeg 转 16k mono s16le PCM（可选，无 ffmpeg 则报错）
    └── health/             GET /healthz（不挂 v1 prefix，docker HEALTHCHECK 用）
prisma/
├── schema.prisma           4 个 model：User / Device / Group / Frame
└── migrations/             prisma migrate dev 自动管
```

## 数据模型（`prisma/schema.prisma`）

```
User    id(cuid) email(unique) password(bcrypt) ─┐
                                                  ├─ owns ──> Device.ownerUserId
                                                  └─ owns ──> Group.ownerUserId
Device  id mac(unique) name selectedGroupId(?)─────────┐
        sortOrder lastSeenAt batteryPct rssiDbm fwVersion
                                                       ↓
Group   id name etag kind(static|dynamic) sortOrder ──┘
        └── frames: Frame[]
Frame   (groupId, sortOrder) unique 复合键
        caption imageEtag audioEtag(?) imageSize audioSize(?)
```

设备表的 `mac` 唯一，注册端点 `POST /devices` 是 upsert，固件每次 boot 都会调但是幂等。

## API 全景（前缀 `/api/v1`，`/healthz` 不带前缀）

### 公开

```
POST   /api/v1/users                  注册，body {email, password} → {token, user}
POST   /api/v1/sessions               登录，body {email, password} → {token, user}
GET    /healthz                       {status:'ok',ts}
```

### Web 管理（`Authorization: Bearer <jwt>`）

```
GET    /api/v1/me                     whoami {id, email}
DELETE /api/v1/sessions/current       占位 logout（JWT 无服务端状态）

GET    /api/v1/devices?owner=me|none  列设备（默认 me；none = 未认领）
POST   /api/v1/devices/claim-by-mac   按 MAC 认领或预绑定
PUT    /api/v1/devices/order          拖拽重排，body {order: id[]}
GET    /api/v1/devices/:id            单台
PATCH  /api/v1/devices/:id            改 name 与 / 或 selected_group_id
DELETE /api/v1/devices/:id            解绑（把 owner 置 null，不删硬件记录）
POST   /api/v1/devices/:id/claim      认领指定设备 id

GET    /api/v1/groups                 owner 的组
POST   /api/v1/groups                 新建（201）
PUT    /api/v1/groups/order           批量重排（必须排在 :gid 之前）
GET    /api/v1/groups/:gid
PATCH  /api/v1/groups/:gid            改 name / sort_order
DELETE /api/v1/groups/:gid            删组（级联 frames 与 blobs）

POST   /api/v1/groups/:gid/frames                    multipart 创建，append（image 必填）
PUT    /api/v1/groups/:gid/frames/order              批量重排
PATCH  /api/v1/groups/:gid/frames/:seq               multipart partial 或 JSON 改 caption
DELETE /api/v1/groups/:gid/frames/:seq               删整帧
DELETE /api/v1/groups/:gid/frames/:seq/audio         只清音频留图
```

### 资源下发（dual-auth：JWT 或 `X-Device-Mac`，所有端点带 ETag/304）

```
GET /api/v1/groups/:gid/manifest                  {group_etag, frames:[...], default_frame_seq}
GET /api/v1/groups/:gid/frames                    数组形式，与 manifest 等价
GET /api/v1/groups/:gid/frames/:seq               单帧 summary
GET /api/v1/groups/:gid/frames/:seq/image         15000 字节 1bpp packed
GET /api/v1/groups/:gid/frames/:seq/audio         16k mono s16le PCM
```

### 设备协议（`X-Device-Mac` header，`/me/*`）

```
POST /api/v1/devices                    register，body {mac, name?}，无 header（mac in body）
POST /api/v1/me/poll                    主轮询：body {telemetry?} → DeviceState
PUT  /api/v1/me/group                   选指定组，body {id} → DeviceState
POST /api/v1/me/group/next              环回切下一组 → DeviceState
POST /api/v1/me/group/prev              环回切上一组 → DeviceState
```

`DeviceState` 包含 `device.{id, mac, name, server_time}` + `group.{id, etag, frame_count, default_frame_seq, position{current, total}}`。`group` 为 `null` 表示未选。

### Webhook 推送（JWT）

```
POST /api/v1/groups/:gid/frames/:seq/render
     body { source: 'png_base64'|'markdown'|'html', content, threshold?, mode? }
```

`source: 'png_base64'` 已实现（PNG 走 sharp 管线 → 1bpp 写入帧）；`markdown` 与 `html` 留待后续。

## 鉴权矩阵

`JwtAuthGuard` 是 `APP_GUARD` 全局生效，默认所有端点都需要 JWT。例外靠 `@Public()`：

| 端点类 | 装饰器 | 真正的 guard |
|---|---|---|
| Web 管理 | （默认） | `JwtAuthGuard` |
| 资源下发 | `@Public()` + `@UseGuards(JwtOrDeviceAuthGuard)` | JWT 或 `X-Device-Mac` |
| 设备 `/me/*` | `@Public()` + `@UseGuards(DeviceAuthGuard)` | `X-Device-Mac` |
| 设备 register | `@Public()` | 无（mac 在 body 里） |
| webhook render | （默认） | `JwtAuthGuard` |
| `/healthz` | `@Public()` | 无 |

## Blob 与渲染缓存

```
{BLOB_DIR}/                 默认 ./blobs/（开发）或 /data/blobs/（docker）
├── {groupId}/{seq}.img     1bpp packed，15000 字节
├── {groupId}/{seq}.pcm     16k mono s16le PCM
└── render-cache/{key0..2}/{key}.bin
                            sharp 渲染产物，key = sha1(sourceEtag|w|h|threshold|mode|...)
                            两层 hex 前缀分桶避免单目录爆 inode
                            atime 老于 N 天可手动 gc
```

ETag 算法：`computeETag(buf) = sha256(buf).slice(0, 16)`。manifest 的 `group_etag` 是所有 frame etag 拼接后再 hash。

## 渲染管线（`RenderService`）

接受任意 PNG / JPG / WebP，按以下步骤写出 1bpp packed：

1. `sharp(input).flatten({white bg}).resize(W, H, {fit: letterbox?'contain':'cover'}).grayscale().raw()`
2. `shared.autoInvert` —— 四角自适应反相
3. `shared.autoContrast(cutoff=1)` —— 拉对比
4. `shared.ditherTo1bpp(mode, threshold)` —— 见 [`shared/README.md`](../shared/README.md)

输出与 firmware `epd_ssd1683.cc` 的字节序对齐。前端 `FrameEditor` 用同一套 `shared.preprocess` + `shared.dither` 在浏览器里预览，确保所见即所得。

`render-cache.service.ts` 在内存里做 `inFlight` 去重并落盘 sha1 keyed cache，同 key 并发只跑一次 sharp。

## 环境变量

本地开发：放 `backend/.env`（**不是仓库根**），Prisma CLI 与 Bun runtime 都从 cwd 读取。docker 部署：所有值内联在 `compose.yml` 的 `environment:`，不依赖 `.env` 文件。

env 用 `infra/config/env.schema.ts` 的 zod 校验；缺必填或格式错时启动直接挂。

| key | 默认 | 备注 |
|---|---|---|
| `NODE_ENV` | `development` | `development` / `production` / `test` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `PORT` | 3001 | |
| `DATABASE_URL` | —— | 必填，`mysql://user:pwd@host:3306/db` |
| `JWT_SECRET` | —— | 必填，≥ 16 字符；`openssl rand -hex 64` 生成 |
| `JWT_EXPIRATION` | `7d` | |
| `BLOB_DIR` | `./blobs` | docker 镜像内固定 `/data/blobs` |

## 本地开发

仓库根：

```bash
bun install
cp backend/.env.example backend/.env       # 改 DATABASE_URL / JWT_SECRET
bun run --cwd backend prisma:generate
bun run --cwd backend prisma:migrate       # 第一次会创建 dev migration

bun run dev:backend                         # http://localhost:3001
```

第一个账号通过 frontend `/register` 页面注册，或直接 `curl -X POST http://localhost:3001/api/v1/users -H 'content-type: application/json' -d '{"email":"...","password":"..."}'`。

验证：

```bash
curl http://localhost:3001/healthz          # {"status":"ok","ts":"..."}
bun run --cwd backend test                  # 渲染管线单测
bun run --cwd backend typecheck
```

## 测试

`bun test` 跑完所有 `*.test.ts`。当前覆盖 `render.service.test.ts` —— sharp 管线端到端（输入 PNG，输出 15000 字节 1bpp packed，比对预期 hash）。

## 部署

镜像构建在仓库根 `Dockerfile`（multi-stage：bun 装依赖 → prisma generate + vite build → 拷进精简 runner stage）。`entrypoint.sh` 进入 `/app/backend` 后跑 `prisma migrate deploy` 再启服务。frontend dist 由 `@fastify/static` 在同域托管，`/api/*` 走 NestJS。具体 docker compose 与 GHCR 流程见仓库根 README。

部署后第一个账号通过站点 `/register` 注册即可，无需进容器手动建用户。
