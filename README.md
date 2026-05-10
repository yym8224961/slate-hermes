# slate · 墨笺

E-ink 相框 / 玩具 / 数据看板的三端项目。

## 三端

```
slate/
├── firmware/    ESP-IDF 工程，设备固件（ESP32-S3，4.2" 黑白 EPD）
├── backend/     Bun + NestJS（Fastify）+ Prisma + MySQL，API 与 1bpp 渲染管线
├── frontend/    React 19 + Vite + Tailwind v4 + Radix + dnd-kit + TanStack，管理后台
└── shared/      Zod schema 与 1bpp dither 纯函数，前后端共用
```

`firmware/` 是独立 ESP-IDF 工程；`backend/ + frontend/ + shared/` 是 Bun monorepo（根 `package.json` 的 `workspaces`）。两套构建系统并存互不干扰。

各端的详细文档在各自目录的 `README.md`：

| 端 | 文档 |
|---|---|
| 设备固件与硬件参考（pinout / 电源 / EPD / 音频 / RTC / NFC） | [`firmware/README.md`](firmware/README.md) |
| 服务端架构、API、数据模型、渲染管线、鉴权 | [`backend/README.md`](backend/README.md) |
| 前端设计语言、路由、组件、TanStack Query 用法 | [`frontend/README.md`](frontend/README.md) |
| 共享 zod schema、6 种 dither 算法、预处理管线 | [`shared/README.md`](shared/README.md) |

## 通信总览

```
开机
 └─► 若 NVS 无凭据 → SoftAP captive portal「Slate-XXXX」配 WiFi 与服务端 URL
 └─► STA → SNTP 对时 → POST /api/v1/devices（register，幂等）
 └─► SyncService 周期 POST /api/v1/me/poll
        ├ 上报 telemetry（battery / rssi / fw_version / current_group / current_frame_seq）
        └ 拿 DeviceState{device, group:{etag, frame_count, ...}, poll_interval_s}

内容变更
 └─► group_etag 变 → GET /manifest（If-None-Match，命中 304 多数零流量）
                  → 增量拉缺失的 frames/:seq/image + .pcm 写 LittleFS

按键翻页
 └─► FrameScene 本地命中 cache → EPD partial refresh + I2S DMA 同步播音

Web 推送
 └─► 前端「切组」→ PATCH /api/v1/devices/:id（selected_group_id）
                → 设备下次 poll 看到 group 变了 → 重拉 manifest → 切显示

外部 webhook
 └─► POST /api/v1/groups/:gid/frames/:seq/render（X-Api-Key）
        body {source: 'png_base64'|'markdown'|'html', content, mode?, threshold?}
```

API 全部挂在 `/api/v1` 下，`/healthz` 不带前缀。鉴权按端点区分（JWT / `X-Device-Mac` / `X-Api-Key` / dual-auth），完整矩阵见 [`backend/README.md`](backend/README.md)。

## 本地开发

需要 Bun ≥ 1.3 与一个可达的 MySQL 8 实例。最简起一个本地 MySQL：

```bash
docker run -d --name slate-mysql -p 3306:3306 \
  -e MYSQL_DATABASE=slate \
  -e MYSQL_USER=slate \
  -e MYSQL_PASSWORD=slate \
  -e MYSQL_RANDOM_ROOT_PASSWORD=yes \
  mysql:8
```

仓库根：

```bash
bun install
cp backend/.env.example backend/.env       # 改 DATABASE_URL / JWT_SECRET / WEBHOOK_API_KEY
bun run --cwd backend prisma:generate
bun run --cwd backend prisma:migrate       # 第一次会创建 dev migration

bun run dev:backend                         # http://localhost:3001
bun run dev:frontend                        # http://localhost:5173（proxy /api → :3001）
```

首次启动后访问 `http://localhost:5173/register` 注册第一个账号。

`.env` 必须放在 `backend/` 目录而非仓库根 —— Prisma CLI 与 Bun runtime 都从 cwd 读取。docker 部署不依赖此文件，配置直接内联在 `compose.yml` 的 `environment:`。

### 固件

```bash
source $IDF_PATH/export.sh                  # ESP-IDF v5.5.x
idf.py -C firmware build
idf.py -C firmware -p <serial> flash monitor
```

target 已固化在 `firmware/sdkconfig.defaults`。

## 全仓 lint / typecheck / test

```bash
bun run format:check
bun run lint                                # frontend + backend，eslint --max-warnings 0
bun run typecheck                           # frontend + backend，tsc --noEmit
bun run --cwd backend test
bun run --cwd frontend build
```

## 部署（docker）

backend 与 frontend 打到**单镜像**里（同域 serve，frontend dist 由 `@fastify/static` 托管，`/api/v1/*` 走 NestJS）。仓库根 `compose.yml` 是开箱即用样例（自带 MySQL）；生产部署若用外部 MySQL 或反代，可在此基础上改造。

镜像走 GHCR，公有镜像无需登录即可 pull：

```
ghcr.io/qiujun8023/slate:latest
```

首次部署：

```bash
git clone <repo-url>
cd slate
$EDITOR compose.yml                         # 把 JWT_SECRET / WEBHOOK_API_KEY 占位符
                                            # 换成 openssl rand -hex 32 生成的真值
docker compose up -d
```

升级（master 推 commit → GHCR 自动重建 → 服务器手动拉）：

```bash
docker compose pull && docker compose up -d
```

容器启动 `entrypoint.sh` 自动执行 `prisma migrate deploy`，无需手动迁移。首次部署后访问站点 `/register` 创建第一个账号。

持久化目录（compose 启动后在 cwd 自动创建）：

| 主机路径 | 容器路径 | 说明 |
|---|---|---|
| `./slate/blobs/` | `/data/blobs/` | frame image 与 audio |
| `./mysql/` | `/var/lib/mysql/` | MySQL datadir |

建议每天 `mysqldump + tar ./slate/blobs` 备份。

## CI

`.github/workflows/`：

| 工作流 | 触发 | 内容 |
|---|---|---|
| `ci.yml` | PR / push to master | lint-format / typecheck / backend test / frontend build 四个并行 job |
| `firmware.yml` | push to master 且 `firmware/**` 变化 | ESP-IDF 构建后 upload `slate-full.bin` 与 `slate-ota.bin` artifact |
| `docker.yml` | push to master | buildx 多架构（amd64 + arm64）→ push GHCR，标签 `master` / `latest` / `sha-<short>` |

镜像构建用仓库根 `Dockerfile`（multi-stage：bun 装依赖 → prisma generate + vite build → 拷进精简 runner stage），entrypoint 是 `entrypoint.sh`（先 migrate 再启服务）。
