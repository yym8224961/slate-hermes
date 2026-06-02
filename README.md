# Slate（墨笺）

400×300 黑白墨水屏设备项目——把照片、资讯、仪表板推送到墨水屏上，按键翻页，语音对话。仓库涵盖固件、后端 API、Web 管理端，可完全自托管。

![Slate 软件管理、设备同步和墨水屏内容形态总览](readme-hero.png)

## 功能

### 内容类型

每块屏幕上的内容由「内容组」组织，组内可混放两类内容，设备按键翻页轮播：

- **静态图片**：浏览器裁剪、缩放、抖动预览，后端用 sharp 渲染为 1bpp。支持 6 种抖动算法：`threshold`、`bayer4`、`bayer8`、`floyd`、`atkinson`、`sierra`。
- **动态内容**：后端实时拉数据渲染成帧，到点自动刷新。共 9 种：

| 类型 | 说明 |
|------|------|
| 日历（日/月视图） | 农历/公历日历卡片 |
| 天气 | 和风天气 QWeather 实时天气 |
| 历史上的今天 | Wikipedia / 百度百科 |
| 气象预警 | 按省份官方预警 |
| 地震速报 | 全国最新地震 |
| 热榜 | 86 个榜单源（知乎、微博、B站、GitHub、V2EX 等） |
| 信息仪表板 | 自定义数据看板，外部 API POST 推送 |
| 字体测试 | 26 种点阵字体上屏预览 |

### 语音与 AI 对话

- **音频朗读**：日历、天气、历史上的今天等内容可挂一段 PCM 音频，翻到时播放。
- **TTS 合成**：填文案用 OpenAI 兼容 TTS 流式合成，ffmpeg 转 16 kHz mono PCM。
- **AI 语音对话**：按键录音→后端 STT→**Hermes Agent** 对话→TTS 语音回复。Hermes 保有人格（soul.md）和记忆，Slate 是 Hermes Gateway 的一个平台 channel，与 Telegram、微信平级。

### 待办与提醒

- Settings → 待办事项，墨水屏上直接创建和勾选提醒。
- 支持预设短语（开会、回电话、买东西等）快速新建。
- 勾选状态回写到后端，退出时自动同步。

### 设备同步

- **零配置配对**：首次开机 SoftAP + captive portal，屏幕显示 6 位配对码，Web 端绑定。
- **增量同步**：poll 上报 telemetry，按 manifest/ETag 增量下载，命中 304 不重复传。
- **低功耗**：静态帧深睡按需唤醒，动态帧 RTC timer 定时刷新，局刷只更新变化区。

## 技术栈

| 模块 | 技术 |
|------|------|
| firmware | ESP-IDF 5.5.x，ESP32-S3，ZecTrix Note4 V1.0 |
| backend | Bun + NestJS 11 + Fastify + Prisma 7 + MySQL 8 |
| frontend | React 19 + Vite 8 + Tailwind v4 |
| shared | zod schema、动态配置、dither / 图像预处理 |

## 仓库结构

```
slate/
├── backend/          NestJS API、Prisma、渲染、设备协议、Hermes 模块
├── frontend/         React Web 管理端
├── shared/           前后端共享 TypeScript
├── firmware/         ESP-IDF 固件
├── compose.yml       Docker Compose 自托管
├── Dockerfile        生产单镜像
└── entrypoint.sh     容器入口
```

| 模块 | 详细文档 |
|------|---------|
| 后端 API、数据模型、环境变量 | [backend/README.md](backend/README.md) |
| Web 管理端、路由、设计系统 | [frontend/README.md](frontend/README.md) |
| 共享 schema、1bpp 图像管线 | [shared/README.md](shared/README.md) |
| 固件、硬件、GPIO、同步协议 | [firmware/README.md](firmware/README.md) |

## 端到端流程

```
首次开机
  └─ NVS 无凭据 → SoftAP captive portal (Slate-XXXX)
     └─ 填 Wi-Fi 与后端 URL → 重启 → STA 连接 + SNTP 对时
        └─ POST /api/v1/devices 注册 → 获取 device_secret + pair_code

设备绑定
  └─ 屏幕显示 6 位 pair_code → Web 输入 → 后端 claim 设备

内容管理
  └─ Web 创建内容组和内容
     ├─ 图片：裁剪 → dither → 1bpp 渲染
     ├─ 音频：上传 → ffmpeg 转 16kHz mono PCM
     ├─ TTS：OpenAI TTS → 重采样到设备格式
     └─ 动态内容：实时拉取 → 按调度渲染

设备同步
  └─ POST /devices/current/poll → 上报 telemetry
     └─ manifest 变化 → GET /groups/:gid/manifest → 增量下载
        └─ ETag 304 → LittleFS 缓存 → 本地翻页

AI 语音对话
  └─ ENTER 双击 → HermesScene
     └─ 按键录音 → PCM → POST /api/v1/hermes/chat
        └─ 后端 STT → Hermes Agent (长轮询) → TTS
           └─ 墨水屏显示文字 + 播放语音

低功耗刷新
  └─ 静态帧不定时唤醒 → 动态帧 RTC timer → 局刷
```

HTTP API 统一挂在 `/api/v1`，设备鉴权用 `Authorization: Bearer <device_secret>`，Web 管理用 JWT。

## 本地开发

```bash
# 依赖
Bun 1.x + MySQL 8 + ffmpeg + ESP-IDF v5.5.x（仅固件）

# MySQL
docker run -d --name slate-mysql -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=slate \
  -e MYSQL_USER=slate -e MYSQL_PASSWORD=slate mysql:8

# 初始化
bun install
cp backend/.env.example backend/.env
bun run --cwd backend prisma:generate
bun run --cwd backend prisma:migrate

# 启动
bun run dev:backend     # http://localhost:3001
bun run dev:frontend    # http://localhost:5173
```

首次访问 `http://localhost:5173/register` 注册账号。

## 固件构建

```bash
source $IDF_PATH/export.sh
idf.py -C firmware build
idf.py -C firmware -p <serial> flash monitor
```

## Docker 部署

编辑 `.env`，填入以下必填密钥（不能有空格或引号）：

```
MYSQL_PASSWORD=change_me
JWT_SECRET=change_me_at_least_32_chars
```

```bash
mkdir -p slate/blobs mysql
sudo chown -R 1000:1000 slate
docker compose up -d
curl http://localhost:3001/healthz
```

访问 `http://<host>:3001/register` 注册账号。

## Hermes Agent 集成

Slate 墨水屏可作为 [Hermes Agent](https://github.com/nousresearch/hermes-agent) 的一个平台 channel。

**架构：**

```
ESP32 → NAS后端 (STT+队列) → SlateAdapter (轮询) → Hermes Agent (soul.md)
                                                 ↑ 人格/记忆/工具
```

**启用：**

1. 将 `plugins/platforms/slate/` 放到 `~/.hermes/hermes-agent/plugins/platforms/slate/`
2. 设置环境变量 `SLATE_BACKEND=https://你的NAS:3001`
3. 重启 Hermes Gateway：`hermes gateway stop && sleep 2 && hermes gateway start`

Gateway 启动后自动轮询 NAS 后端，处理墨水屏发来的语音消息。

## CI

| 工作流 | 触发 | 内容 |
|--------|------|------|
| `ci.yml` | PR/push master | format+lint, typecheck, test, build |
| `docker.yml` | push master | buildx linux/amd64+arm64 → GHCR |
| `firmware.yml` | firmware/** 变化 | ESP-IDF 构建 slate-full.bin |
| `release.yml` | push vX.Y.Z tag | 发版 Docker + 固件 |

## 版本与贡献

稳定版本见 GitHub Releases。开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```bash
git tag -a v0.2.0
git push origin v0.2.0
```
