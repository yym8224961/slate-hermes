# Slate

Slate 是一个面向 400 x 300 黑白墨水屏设备的开源相框 / 信息看板 / 语音玩具项目。仓库同时包含设备固件、后端 API、Web 管理端和前后端共享 schema。

当前形态：

- `firmware/`：ESP-IDF 5.5.x 固件，目标板为 ZecTrix Note4 V1.0（ESP32-S3 + 4.2" EPD + ES8311 音频 + 按键 + 电池）。
- `backend/`：Bun + NestJS 11 + Fastify + Prisma 7 + MySQL 8，负责账号、设备、内容组、内容、动态帧渲染、音频转码和设备同步协议。
- `frontend/`：React 19 + Vite 8 + Tailwind v4 的 Web 管理端。
- `shared/`：前后端共享的 zod schema、动态内容配置、dither 和图像预处理纯函数。

## 仓库结构

```text
slate/
├── backend/        NestJS API、Prisma schema、动态帧/图片/音频渲染
├── frontend/       React Web 管理端
├── shared/         前后端共享 TypeScript 源码
├── firmware/       ESP-IDF 固件工程
├── compose.yml     单机自托管示例，内置 MySQL
├── Dockerfile      生产单镜像：backend + frontend dist
├── entrypoint.sh   容器启动时执行 prisma migrate deploy 后启动 backend
└── package.json    Bun workspace 根配置
```

详细文档：

| 模块 | 文档 |
| --- | --- |
| 后端 API、数据模型、环境变量、部署细节 | [backend/README.md](backend/README.md) |
| Web 管理端、路由、设计系统、数据流 | [frontend/README.md](frontend/README.md) |
| 共享 schema、动态配置、1bpp 图像管线 | [shared/README.md](shared/README.md) |
| 固件、硬件、启动/同步/休眠/语音 | [firmware/README.md](firmware/README.md) |

## 端到端流程

```text
首次开机
  └─ NVS 没有 Wi-Fi/服务端凭据
     └─ 启动 SoftAP + captive portal（Slate-XXXX）
        └─ 用户填写 Wi-Fi 与 backend URL
           └─ 重启后连接 STA、SNTP 对时
              └─ POST /api/v1/devices 注册设备，拿 device_secret + pair_code

设备绑定
  └─ 固件屏幕显示 6 位 pair_code
  └─ Web 管理端输入 pair_code
     └─ 后端 claim 设备，绑定 owner_user_id，并轮换 pair_code

内容管理
  └─ Web 创建内容组和内容
     ├─ 图片内容：浏览器预览裁剪 + shared dither，后端 sharp 渲染 1bpp
     ├─ 音频：上传音频经 ffmpeg 转 16 kHz mono s16le PCM
     ├─ TTS：OpenAI-compatible TTS 流式返回 PCM，再重采样到设备格式
     └─ 动态内容：日历、天气、历史上的今天、气象预警、地震、热榜、dashboard、字体测试

设备同步
  └─ POST /api/v1/devices/current/poll 上报 telemetry
     └─ 收到 DeviceState（绑定状态、当前内容组、manifest etag、可选 current_content）
        └─ manifest 变化时 GET /groups/:gid/manifest
           └─ 增量 GET /contents/:id/image 与 /audio，ETag 命中返回 304
              └─ LittleFS 缓存后本地翻页、局刷 EPD、播放 PCM

低功耗刷新
  └─ 静态帧不定时唤醒
  └─ 动态帧按 next_wake_sec 配 RTC timer
     └─ timer wake 后只刷新当前帧；manifest 变化时回退完整同步
```

HTTP API 统一挂在 `/api/v1` 下，`/healthz` 是唯一不带前缀的健康检查端点。设备鉴权使用 `Authorization: Bearer <device_secret>`，Web 管理使用 JWT。完整端点和鉴权矩阵见 [backend/README.md](backend/README.md)。

## 本地开发

依赖：

- Bun 1.x
- MySQL 8
- ffmpeg（后端处理音频需要；Docker 镜像内已安装）
- ESP-IDF v5.5.x（仅构建固件需要）

启动 MySQL：

```bash
docker run -d --name slate-mysql -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=slate \
  -e MYSQL_USER=slate \
  -e MYSQL_PASSWORD=slate \
  mysql:8
```

安装依赖并初始化数据库：

```bash
bun install
cp backend/.env.example backend/.env
bun run --cwd backend prisma:generate
bun run --cwd backend prisma:migrate
```

运行开发服务：

```bash
bun run dev:backend     # http://localhost:3001
bun run dev:frontend    # http://localhost:5173，Vite proxy /api 与 /healthz 到 :3001
```

首次访问 `http://localhost:5173/register` 注册账号。

本地后端读取 `backend/.env`。根目录 `.env` 只给 Docker Compose 变量替换使用，不会被开发模式的 Nest 后端读取。

## 固件构建

```bash
source $IDF_PATH/export.sh
idf.py -C firmware build
idf.py -C firmware -p <serial> flash monitor
```

target、分区表、Flash/PSRAM 配置已经固化在 `firmware/sdkconfig.defaults`，无需手动 `idf.py set-target`。

## 常用校验

```bash
bun run format:check
bun run lint
bun run typecheck
bun run --cwd backend test
bun run --cwd frontend build
```

说明：

- `format:check` 只覆盖 `ts` / `tsx` / 普通 `json`，不格式化固件 C/C++。
- 后端 typecheck/test 前需要 `prisma generate`，CI 会自动执行。
- 后端测试使用 Bun test；不需要连接真实 MySQL 的测试会使用 dummy `DATABASE_URL`。

## Docker 部署

生产镜像是单镜像：backend 直接运行 TypeScript，frontend 的 `dist/` 由 backend 同域静态托管，API 和 Web 共用一个端口。

```bash
curl -fLO https://raw.githubusercontent.com/qiujun8023/slate/master/compose.yml
curl -fLo .env.example https://raw.githubusercontent.com/qiujun8023/slate/master/.env.example
cp .env.example .env
```

编辑 `.env`：

```bash
openssl rand -hex 32   # 填 MYSQL_PASSWORD
openssl rand -hex 64   # 填 JWT_SECRET
```

启动：

```bash
mkdir -p slate/blobs mysql
sudo chown -R 1000:1000 slate
docker compose up -d
curl -fsS http://localhost:3001/healthz
```

健康后访问 `http://<host>:3001/register` 注册第一个账号。

持久化目录：

| 主机路径 | 容器路径 | 内容 |
| --- | --- | --- |
| `./slate/` | `/data/` | blob 根目录，主要是 `/data/blobs` |
| `./mysql/` | `/var/lib/mysql/` | MySQL datadir |

升级：

```bash
docker compose pull
docker compose up -d
```

镜像 tag：

- `latest` / `master`：master 最新构建
- `sha-<short>`：按 commit 固定版本

## CI

`.github/workflows/` 当前包含：

| 工作流 | 触发 | 内容 |
| --- | --- | --- |
| `ci.yml` | PR、push 到 `master`、手动触发 | format + lint、typecheck、backend test、frontend build |
| `docker.yml` | push 到 `master`、手动触发 | buildx 构建 linux/amd64 + linux/arm64 并推送 GHCR |
| `firmware.yml` | `firmware/**` 变化、手动触发 | ESP-IDF v5.5.2 构建并上传 `slate-full.bin` / `slate-ota.bin` |

## 贡献

欢迎 issue 和 PR。开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
