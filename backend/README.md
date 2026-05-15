# Slate / Backend

NestJS 11（Fastify）+ Prisma 7 + MySQL 8 服务端。单个进程同时承担：

1. **Web 管理 API** —— frontend 用，JWT 鉴权
2. **设备协议** —— firmware 用，`Authorization: Bearer <device_secret>` 鉴权
3. **资源下发** —— frontend 预览与 firmware 同步共用同一组端点（dual-auth + ETag/304）
4. **生产部署托管 frontend dist** —— `@fastify/static` + SPA fallback

## 技术栈

| 层 | 选型 |
|---|---|
| Runtime | Bun 1.x（**不预编译**，`bun run src/main.ts` 直跑 TS） |
| HTTP | Fastify 5 + `@nestjs/platform-fastify` |
| ORM | Prisma 7 + `@prisma/adapter-mariadb`（直连 MySQL，不走 Prisma engine） |
| 校验 | zod 4（自实现 `ZodValidationPipe` 挂 APP_PIPE） |
| 日志 | nestjs-pino + pino-pretty（单行输出） |
| 图像 | sharp 0.34（→ 1bpp packed） |
| 鉴权 | bcryptjs 密码 + jsonwebtoken JWT |

## 目录

```
src/
├── main.ts                  bootstrap：Fastify + 全局 prefix /api/v1 + SPA fallback
├── app.module.ts            装载所有 module 与 4 个 APP_* provider
├── infra/
│   ├── config/              env.schema.ts（zod 校验）→ AppConfig
│   ├── logger/              pino + nestjs-pino
│   ├── prisma/              PrismaService（MariaDB adapter）
│   └── blob/                BlobService：{BLOB_DIR}/{groupId}/{contentId}.{img,pcm}
├── common/
│   ├── decorators/          @Public / @CurrentUser / @CurrentDevice
│   ├── guards/              JwtAuthGuard / DeviceAuthGuard / JwtOrDeviceAuthGuard
│   ├── pipes/               ZodValidationPipe（DTO 上挂 static schema = *Request）
│   ├── filters/             AppExceptionFilter：统一错误 envelope
│   ├── interceptors/        RequestIdInterceptor：每请求一个 reqId 串日志
│   ├── etag/                computeETag + respondWithEtag（304 策略）
│   └── errors/              AppError 体系（NotFound / Forbidden / Validation / Conflict / Auth）
└── modules/
    ├── auth/                POST /users 注册、POST /sessions 登录、GET /me
    ├── users/               用户表 CRUD + bcrypt 哈希
    ├── devices/             两个 controller：protocol（/me/* 与 /devices/register）+ admin（/devices）
    ├── groups/              /groups CRUD + cycle（next/prev）+ 设备绑组
    ├── contents/            /groups/:gid/contents + manifest + multipart 解析
    ├── widgets/             动态内容 provider + scheduler + 渲染流水线
    ├── device-renderer/     设备同源 400×300 1bpp 动态内容渲染器
    ├── render/              sharp 管线 + 内存与磁盘双层缓存
    ├── audio/               ffmpeg 转 16 kHz mono s16le PCM（容器内自带 ffmpeg）
    └── health/              GET /healthz（不挂 /api/v1，docker HEALTHCHECK 用）
prisma/
├── schema.prisma            4 个 model：User / Device / Group / Content
└── migrations/              prisma migrate dev 自动管
```

## 数据模型

```
User    id(cuid) email(unique) username(unique) password(bcrypt)
          └ owns ──► Device.ownerUserId
          └ owns ──► Group.ownerUserId

Device  id mac(unique) secret_hash(sha256) pair_code(unique, 6 位 [A-Z2-9])
        name? owner_user_id? selected_group_id? sort_order
        last_seen_at? battery_pct? rssi_dbm? fw_version?

Group   id name etag owner_user_id? sort_order
        └ contents: Content[]（cascade delete）

Content id (group_id, sort_order) unique 复合键
        caption? kind image_etag image_size audio_etag? audio_size?
        dynamic_type? dynamic_config? dynamic_data? dynamic_* metadata
```

关键约束：

- **Device.mac** unique，物理重置后凭 mac 重新走 `POST /devices/register` 拿回新的 `device_secret + pair_code`，实现「物理控制权 = 数字所有权」
- **Device.secret_hash** = `sha256(device_secret)`，明文 secret 仅注册响应里返回一次，固件 NVS 持久化；丢了只能工厂重置
- **Group.etag** = 所有 content etag 与标题拼接后 hash，便于固件 manifest 304
- **Content** 唯一键 `(group_id, sort_order)`，删/重排时整组重写 sort_order

## API 全景

所有端点挂在 `/api/v1` 下，**例外**：`/healthz` 不带前缀（docker HEALTHCHECK 用）。

### 公开

```
POST   /api/v1/users                 注册，body {email, username, password} → {token, user}
POST   /api/v1/sessions              登录，body {identifier, password} → {token, user}
                                     identifier 支持邮箱或用户名（含 @ 视为邮箱）
GET    /healthz                      {status:'ok', ts}
```

### Web 管理（`Authorization: Bearer <jwt>`）

```
GET    /api/v1/me                              whoami {id, email, username}
DELETE /api/v1/sessions/current                占位 logout（JWT 无服务端状态）

GET    /api/v1/devices?owner=me|none           列设备；none = 列未认领（管理用）
PUT    /api/v1/devices/order                   拖拽重排，body {order: id[]}
POST   /api/v1/devices/claim-by-pair-code      用 6 位 pair_code 认领，body {code}
GET    /api/v1/devices/:id                     单台 summary
PATCH  /api/v1/devices/:id                     改 name 与 / 或 selected_group_id
DELETE /api/v1/devices/:id/binding             解绑（owner 置 null + 轮换 pair_code）

GET    /api/v1/groups                          owner 的相册
POST   /api/v1/groups                          新建（201）
PUT    /api/v1/groups/order                    批量重排（须在 :gid 之前注册）
GET    /api/v1/groups/:gid
PATCH  /api/v1/groups/:gid                     改 name / sort_order
DELETE /api/v1/groups/:gid                     删相册（cascade 删 contents + blobs）

GET    /api/v1/groups/:gid/contents                内容列表
POST   /api/v1/groups/:gid/contents/image          multipart 创建图片内容，append 到末尾（image 必填）
POST   /api/v1/groups/:gid/contents/dynamic        JSON 创建动态内容
PUT    /api/v1/groups/:gid/contents/order          批量重排
PATCH  /api/v1/contents/:contentId                 multipart 更新图片/音频/标题，或 JSON 更新标题/动态配置
DELETE /api/v1/contents/:contentId                 删除内容
DELETE /api/v1/contents/:contentId/audio           只清音频留图
GET    /api/v1/contents/:contentId/dynamic         读取动态内容配置
POST   /api/v1/contents/:contentId/refresh         手动刷新动态内容
POST   /api/v1/contents/:contentId/data            dashboard 动态内容外部数据推送
POST   /api/v1/contents/preview                    创建模式动态内容预览
POST   /api/v1/contents/:contentId/preview         编辑模式动态内容预览
```

### 资源下发（dual-auth：JWT 或 device_secret，所有端点带 ETag/304）

```
GET /api/v1/groups/:gid/manifest                  {group, contents[]}
GET /api/v1/contents/:contentId                   单个 content summary
GET /api/v1/contents/:contentId/image             15000 字节 1bpp packed
GET /api/v1/contents/:contentId/audio             16 kHz mono s16le raw PCM
```

### 设备协议（`Authorization: Bearer <device_secret>`，除 register 外）

```
POST /api/v1/devices/register             无鉴权，body {mac} → {device_id, device_secret, pair_code, reclaimed, server_time}
                                          同 mac 二次进来一律走 reset 路径（清 owner、清相册、轮换 secret + pair_code）
POST /api/v1/me/poll                      body {telemetry?} → DeviceState
PUT  /api/v1/me/group                     body {id} → DeviceState
POST /api/v1/me/group/next                环回切下一组 → DeviceState
POST /api/v1/me/group/prev                环回切上一组 → DeviceState
```

`DeviceState`：

```ts
{
  device: { id, mac, name, bound, pair_code: string|null, server_time },
  group:  { id, etag, name, content_count, sort_order, position: {current, total} } | null
}
```

`pair_code` 仅在 `bound=false` 时返回；`group=null` 表示用户尚未给该设备分配相册。

## 鉴权矩阵

`JwtAuthGuard` 是 `APP_GUARD` 全局生效，默认所有端点都需要 JWT。例外通过装饰器 + 局部 guard 实现：

| 端点类 | 装饰器组合 | 实际 guard |
|---|---|---|
| Web 管理 | （默认） | JwtAuthGuard |
| 资源下发 | `@Public()` + `@UseGuards(JwtOrDeviceAuthGuard)` | JWT 或 device_secret |
| 设备 `/me/*` | `@Public()` + `@UseGuards(DeviceAuthGuard)` | device_secret |
| 设备 register | `@Public()` | 无（mac 在 body 里） |
| `/healthz` | `@Public()` | 无 |

设备 secret 提取规则：`Authorization: Bearer <64 字符 hex>`。非 64 字符 hex 直接被 reject（保证 dual-auth guard 里 JWT 三段 base64 与 device_secret hex 两条路径不会互相误识别）。

## Blob 与渲染缓存

```
{BLOB_DIR}/                 默认 ./blobs（dev）或 /data/blobs（docker）
├── {groupId}/{contentId}.img       1bpp packed，15000 字节
├── {groupId}/{contentId}.pcm       16 kHz mono s16le raw PCM
└── render-cache/{key0..2}/{key}.bin
                                    sharp 渲染产物 key = sha1(sourceEtag|w|h|threshold|mode|...)
                                    两层 hex 前缀分桶避免单目录爆 inode
```

ETag 算法：`computeETag(buf) = sha256(buf).slice(0, 16)`。manifest 的 `group.etag` 会随内容图片、音频或标题变化而更新。

## 渲染管线（`RenderService`）

接受任意 PNG / JPG / WebP，按以下顺序产出 1bpp packed：

1. `sharp(input).flatten({white bg}).resize(400, 300, {fit: letterbox?'contain':'cover'}).grayscale().raw()`
2. `shared.autoInvert` —— 四角自适应反相
3. `shared.autoContrast(cutoff=1)` —— 拉对比
4. `shared.ditherTo1bpp(mode, threshold)` —— 6 种算法，见 [shared/README.md](../shared/README.md#dither-算法)

输出字节序与 firmware `epd_ssd1683.cc` 对齐：MSB-first，bit=1 为白 / bit=0 为黑。前端图片内容编辑器用同一份 `shared.preprocess + shared.dither` 在浏览器里预览，确保所见即所得。

`render-cache.service.ts` 在内存里做 `inFlight` 去重并落盘 sha1 keyed cache，同 key 并发只跑一次 sharp。

## 环境变量

通过 `infra/config/env.schema.ts` 的 zod 校验；缺必填或格式错时启动直接挂。

| key | 默认 | 备注 |
|---|---|---|
| `NODE_ENV` | `development` | `development` / `production` / `test` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `PORT` | `3001` | |
| `DATABASE_URL` | —— | 必填，`mysql://user:pwd@host:3306/db` |
| `JWT_SECRET` | —— | 必填，≥ 16 字符，建议 `openssl rand -hex 64` |
| `JWT_EXPIRATION` | `7d` | |
| `BLOB_DIR` | `./blobs` | docker 镜像内固定 `/data/blobs` |
| `QWEATHER_API_KEY` | —— | 可选，天气动态帧使用；从 QWeather 控制台创建 API KEY |
| `QWEATHER_API_HOST` | —— | 可选，天气动态帧使用；从 QWeather 控制台「设置」复制 API Host，需带 `https://` |

本地开发：放 `backend/.env`（**不是仓库根**，Prisma CLI 与 Bun runtime 都从 cwd 读取）。docker 部署：所有值内联在 `compose.yml` 的 `environment:`，不依赖 `.env`。

动态内容的外部数据会在 provider 内存中做缓存和并发去重：天气实时/三日预报缓存 10 分钟，QWeather 城市 ID 查询缓存 24 小时；「历史上的今天」按时区和日期缓存 24 小时。渲染失败时会优先回退到上次已落库的数据，避免设备端显示空白。

## 本地开发

```bash
bun install
cp backend/.env.example backend/.env       # 改 DATABASE_URL / JWT_SECRET
bun run --cwd backend prisma:generate
bun run --cwd backend prisma:migrate       # 首次会创建 dev migration

bun run dev:backend                         # http://localhost:3001
```

第一个账号通过 frontend `/register` 注册，或直接 `curl`：

```bash
curl -X POST http://localhost:3001/api/v1/users \
  -H 'content-type: application/json' \
  -d '{"email":"...","username":"...","password":"..."}'
```

## 测试

```bash
bun run --cwd backend test
```

当前覆盖 `render.service.test.ts` —— sharp 管线端到端：输入 PNG，输出 15000 字节 1bpp packed，比对预期 hash。
