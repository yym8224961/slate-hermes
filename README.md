# Slate · 墨笺

开源的 e-ink 相框 / 玩具 / 数据看板。三端构成：

- **firmware** — ESP32-S3 固件，4.2 英寸黑白墨水屏 + 单声道喇叭 + 4 颗按键 + 单节锂电池
- **backend** — Bun + NestJS（Fastify）+ Prisma + MySQL，API 与 1bpp 渲染管线
- **frontend** — React 19 + Vite + Tailwind v4 + Radix + dnd-kit + TanStack Query，Web 管理端

## 仓库结构

```
slate/
├── firmware/    ESP-IDF 5.5.x 工程（独立构建系统）
├── backend/     ┐
├── frontend/    ├ Bun monorepo（根 package.json 的 workspaces）
├── shared/      ┘ 前后端共用的 zod schema 与 1bpp 纯函数
├── compose.yml  单机 docker 部署样例（自带 MySQL）
├── Dockerfile   生产镜像：backend + frontend dist 同一镜像
└── entrypoint.sh 启动脚本：先 prisma migrate deploy 再起服务
```

各端详细文档：

| 端 | 文档 |
|---|---|
| 设备固件、硬件参考 | [firmware/README.md](firmware/README.md) |
| 服务端架构、API、鉴权 | [backend/README.md](backend/README.md) |
| Web 管理端、设计系统 | [frontend/README.md](frontend/README.md) |
| 前后端共用的 zod schema 与 dither | [shared/README.md](shared/README.md) |

## 工作流总览

```
开机
 └─ NVS 无凭据 → SoftAP captive portal「Slate-XXXX」配 Wi-Fi 与服务端 URL
 └─ STA → SNTP 对时 → POST /api/v1/devices/register（无鉴权）
                     ← 一次性下发 device_secret + pair_code
 └─ NVS 写 device_secret（明文，固件唯一持有）
 └─ SyncService 周期 POST /api/v1/me/poll（Authorization: Bearer <device_secret>）
       ├ 上报 telemetry（battery / rssi / fw_version / current_group / current_frame_seq）
       └ 拿 DeviceState{device, group:{etag, content_count, ...}}

设备绑定
 └─ 屏幕显示 pair_code（6 位 [A-Z2-9]）
 └─ 用户在 Web 端输入 pair_code → 后端 claim → 立即轮换 pair_code（防截图复用）

内容下发
 └─ group_etag 变 → GET /manifest（If-None-Match，命中 304 零流量）
                 → 增量拉缺失的 400x300 1bpp image / audio 写 LittleFS

按键翻页
 └─ FrameScene 本地命中 cache → EPD partial refresh + I²S DMA 同步播音

Web 推送切组
 └─ 前端 PATCH /api/v1/devices/:id（selected_group_id）
        → 设备下次 poll 看到 group 变了 → 重拉 manifest → 切显示
```

所有 HTTP 端点挂在 `/api/v1` 下，`/healthz` 不带前缀。鉴权矩阵见 [backend/README.md](backend/README.md#鉴权矩阵)。

## 本地开发

依赖：

- Bun ≥ 1.3
- MySQL 8
- ESP-IDF v5.5.x

最简起一个本地 MySQL：

```bash
docker run -d --name slate-mysql -p 3306:3306 \
  -e MYSQL_DATABASE=slate \
  -e MYSQL_USER=slate -e MYSQL_PASSWORD=slate \
  -e MYSQL_RANDOM_ROOT_PASSWORD=yes \
  mysql:8
```

仓库根：

```bash
bun install
cp backend/.env.example backend/.env       # 改 DATABASE_URL / JWT_SECRET
bun run --cwd backend prisma:generate
bun run --cwd backend prisma:migrate       # 首次会创建 dev migration

bun run dev:backend                         # http://localhost:3001
bun run dev:frontend                        # http://localhost:5173（proxy /api → :3001）
```

首次启动后访问 `http://localhost:5173/register` 注册第一个账号。

> `.env` 必须放在 `backend/` 目录而非仓库根 —— Prisma CLI 与 Bun runtime 都从 cwd 读取。docker 部署不依赖此文件，所有配置内联在 `compose.yml`。

### 固件

```bash
source $IDF_PATH/export.sh                  # ESP-IDF v5.5.x
idf.py -C firmware build
idf.py -C firmware -p <serial> flash monitor
```

target 已固化在 `firmware/sdkconfig.defaults`，无需 `set-target`。

## 校验

```bash
bun run format:check
bun run lint                                # ESLint，零 warning
bun run typecheck                           # tsc --noEmit
bun run --cwd backend test                  # render pipeline 单测
bun run --cwd frontend build                # 出 dist
```

`format:check` 只跑 Prettier，覆盖 `ts` / `tsx` / 普通 `json`；固件 C/C++ 不在根格式化链路里。固件若手动跑 `clang-format`，`firmware/.clang-format-ignore` 已排除 `build/`、`managed_components/`、`main/generated/` 和本地第三方字体组件。

## 部署

backend 与 frontend 打到**单镜像**：frontend dist 由 `@fastify/static` 同域托管，`/api/v1/*` 走 NestJS。镜像走 GHCR 公有源（`ghcr.io/qiujun8023/slate:latest`），无需登录即可 pull。

部署不需要 clone 整个仓库，只要一个 `compose.yml` 就够了。

### 首次部署

```bash
# 1. 拿 compose 样例（自带 MySQL）
curl -fLO https://raw.githubusercontent.com/qiujun8023/slate/master/compose.yml

# 2. 生成两条 secret，填进 compose.yml
openssl rand -hex 32                        # → 替换 JWT_SECRET 占位符
openssl rand -hex 32                        # → 替换 MYSQL_PASSWORD 占位符
                                            # MySQL 密码改了同时改 3 处：
                                            #   - MYSQL_PASSWORD
                                            #   - DATABASE_URL 里 slate:slate 的第二个 slate
                                            #   - healthcheck 的 -pslate

# 3. 创建数据目录并授权给容器用户（uid/gid 1000:1000）
mkdir -p slate/blobs mysql
sudo chown -R 1000:1000 slate

# 4. 启动
docker compose up -d
```

容器 `entrypoint.sh` 会自动跑 `prisma migrate deploy`，首次启动即建表。

### 验证 + 创建账号

```bash
curl -fsS http://localhost:3001/healthz     # {"status":"ok","ts":"..."}
```

健康后浏览器访问 `http://<host>:3001/register` 注册第一个账号。

### 数据持久化

| 主机路径 | 容器路径 | 内容 | 备份 |
|---|---|---|---|
| `./slate/blobs/` | `/data/blobs/` | frame assets（image/audio 等） | `tar` |
| `./mysql/` | `/var/lib/mysql/` | MySQL datadir | `mysqldump` |

建议每天定时 `mysqldump + tar ./slate/blobs`。

### 升级

master 推 commit → GHCR 自动重建 → 服务器手动拉：

```bash
docker compose pull && docker compose up -d
```

镜像 tag：`latest`（= master 最新）、`master`、`sha-<short>`（按 commit 锁定）。

## CI

`.github/workflows/`：

| 工作流 | 触发 | 内容 |
|---|---|---|
| `ci.yml` | PR / push to master | lint + format / typecheck / backend test / frontend build 四 job 并行 |
| `firmware.yml` | push to master 且 `firmware/**` 变化 | ESP-IDF v5.5.2 构建 → 上传 `slate-full.bin` 与 `slate-ota.bin` artifact |
| `docker.yml` | push to master | buildx 多架构（linux/amd64 + linux/arm64）→ push GHCR，tag `master` / `latest` / `sha-<short>` |

## 贡献

欢迎 issue 与 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。
