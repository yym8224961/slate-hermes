# slate

E-ink 相框 / 玩具 / 数据看板的三端项目。

> "slate" 在英语世界是 e-ink 设备的通称（reMarkable Slate / Boox Slate）。
> 起源是给 2 岁宝宝做的工程车玩具，长成了"云端推一组 1bpp 帧 + PCM 到 e-ink 设备，本地缓存按键切"的三端系统。

## 三端

```
slate/
├── firmware/    ESP-IDF 工程（设备固件，ESP32-S3 zectrix Note4 4.2" EPD）
├── backend/     Bun + Hono + Prisma + MySQL（API + 1bpp 渲染管线）
├── frontend/    React + Vite + Tailwind + Radix + Motion + TanStack（管理后台，M2.0b 待加）
└── shared/      Zod schema + 类型，前后端共用
```

`firmware/` 是独立的 ESP-IDF 工程；`backend/ + shared/ + frontend/` 是 bun monorepo（根 `package.json` 的 workspaces）。两套构建系统并存，互不干扰。

## 运行（本地）

### Firmware

```bash
source /Users/qiujun/.esp/v5.5.2/esp-idf/export.sh
idf.py -C firmware build
idf.py -C firmware -p /dev/cu.usbmodemXXXX flash monitor
```

target 已固化在 `firmware/sdkconfig.defaults`。

详见 `firmware/README.md`（待补，沿用 Slate M1 阶段的踩坑笔记）。

### Server + DB

只需 bun ≥ 1.3。**MySQL 直连内网测试机**（参考 `quant` 同款，`192.168.31.12:3306`，不跑 docker）。

测试机上一次性建好库:
```sql
CREATE DATABASE slate CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'slate'@'%' IDENTIFIED BY '<your-strong-pwd>';
GRANT ALL ON slate.* TO 'slate'@'%';
FLUSH PRIVILEGES;
```

本地:
```bash
bun install
cp backend/.env.example backend/.env
# 编辑 backend/.env(注意是 backend/ 下不是仓库根):
# DATABASE_URL 改成测试机的真实密码;
# JWT_SECRET / DEVICE_TOKEN_HMAC_KEY / WEBHOOK_API_KEY 改成强随机值
# (生成命令:openssl rand -hex 64)

bun run prisma:generate
bun run prisma:migrate           # 第一次会创建 dev migration
bun run prisma:seed              # 创建默认管理员 admin@example.com / admin123456

bun run dev:backend              # http://localhost:3001
bun run dev:frontend             # http://localhost:5173
```

> .env 放在 `backend/` 而不是仓库根，参考 `quant` 同款做法 —— prisma CLI
> 默认从 cwd(=`backend/`)读 .env，bun runtime 也是；放仓库根的话两个都读不到。

验证：

```bash
curl http://localhost:3001/health
# {"status":"ok",...}

bun run test                     # backend 渲染管线 6 个单测
bun run typecheck                # backend + shared
```

## 通信模型

```
开机 → SoftAP captive portal 配 WiFi+服务端 URL → STA → SNTP 对时
     → GET /v1/devices/{mac}/state（每 60s 轮询，ETag 304 多数零流量）
     → 内容变更时 GET /manifest 增量拉 frame.img + .pcm 到 LittleFS
按键 → HomeScene.NextFrame() 本地命中 → EPD partial refresh + I2S DMA 同步播音
推送 → Web 点"切组" → server 写 PendingAction → 设备 ≤60s 内 poll 看到 → 执行 → ack
离线 → 状态栏 WiFi 变 SLASH，按键照常切本地缓存
```

## API 概览

所有端点统一前缀 `/api/v1/*`,鉴权按端点区分:

### 设备协议（固件,`X-Device-Mac` header）

```
POST /api/v1/devices                      首次/重启都调,幂等(mac in body,无 header)
POST /api/v1/me/poll                      核心轮询:telemetry + state + ack 三合一
PUT  /api/v1/me/group                     选指定组,body {id}
POST /api/v1/me/group/next                cycle 下一组(按 sort_order 环回)
POST /api/v1/me/group/prev                cycle 上一组
```

### 资源（dual-auth: JWT 或 X-Device-Mac，ETag 304）

```
GET /api/v1/groups/:gid/manifest
GET /api/v1/groups/:gid/frames/:idx/image
GET /api/v1/groups/:gid/frames/:idx/audio
```

### Web 管理（`/api/v1/*`，JWT）

```
POST   /api/v1/auth/sessions              登录 → {token, user}
DELETE /api/v1/auth/sessions/current      登出
GET    /api/v1/auth/me                    whoami

GET    /api/v1/devices?owner=me|none      列设备(默认 me;none = 未认领)
GET    /api/v1/devices/:id                单台详情
PATCH  /api/v1/devices/:id                改 name 和/或 selected_group_id
POST   /api/v1/devices/:id/claim          认领
POST   /api/v1/devices/:id/reboot         入队 reboot action
POST   /api/v1/devices/:id/sync           入队 sync_now action

GET    /api/v1/groups                     列 owner 名下组
POST   /api/v1/groups                     新建(201)
PUT    /api/v1/groups/order               批量重排
GET    /api/v1/groups/:gid                单组详情
PATCH  /api/v1/groups/:gid                改 name / sort_order
DELETE /api/v1/groups/:gid                删组(含 frames + blobs)

GET    /api/v1/groups/:gid/frames         列帧
POST   /api/v1/groups/:gid/frames         multipart 创建,append(image 必填)
PATCH  /api/v1/groups/:gid/frames/:idx    multipart partial(image/audio/caption 任意可选)
DELETE /api/v1/groups/:gid/frames/:idx    删整帧
DELETE /api/v1/groups/:gid/frames/:idx/audio  只清音频留图
PUT    /api/v1/groups/:gid/frames/order   批量重排
```

### 外部 webhook 推送（JWT 或 `X-Api-Key`）

```
POST /api/v1/groups/:gid/frames/:idx/render
```

`source: "png_base64"` 已实现,`markdown` / `html` 留 M2.5。

## 进度

- [x] **M1** 单机离线"工程车玩具"（12 张烧入图 + 按键切车）
- [x] **M1.5.x** EPD 显示延后 / 全刷视觉一致 bug 修复
- [x] **M1.5.5** flush_cb 自动 notify + sliding debounce（为 M2 帧动画/滚动留余地）
- [x] **M2.0a** backend + shared 骨架（Hono + Prisma + sharp 1bpp 渲染管线 + 6 单测）
- [x] **M0** 仓库改名 slate + 三端目录合并（本提交）
- [ ] **M2.0b** frontend（React + Vite + Tailwind + Radix + Motion + TanStack）
- [ ] **M2.1** 设备 WiFi 配网（SoftAP captive portal）+ HTTP + LittleFS
- [ ] **M2.2** 去字体图音 + home_scene 重写 + 状态栏（左 WiFi / 中时间 / 右电池）
- [ ] **M2.3** 音频管线（ES8311 + I2S DMA）
- [ ] **M2.4** Web 推送语义端到端联调
- [ ] **M2.5** 动态看板 webhook（markdown/html 渲 1bpp）

详细规划见 `/Users/qiujun/.claude/plans/sleepy-wibbling-wilkinson.md`。

## 部署（VPS, docker）

镜像走 GHCR（公有仓库公有镜像，VPS 上 `docker pull` 不需登录）：`ghcr.io/qiujun8023/slate:latest`。

backend + frontend 打到**单镜像**里（同域 serve，frontend dist 由 `@fastify/static` 托管，`/api/v1/*` 走 NestJS）。MySQL 直连**内网测试机** `192.168.31.12:3306`（同 `quant`，VPS 不起本地 DB）；blob 文件挂主机 `./blobs/`，cron 每天 `mysqldump + tar` 备份。

VPS 首次起：

```bash
git clone git@github.com:qiujun8023/slate.git
cd slate
cp backend/.env.example .env       # .env 放仓库根(不是 backend/),compose 默认从这读
# 编辑 .env 改 DATABASE_URL / JWT_SECRET / WEBHOOK_API_KEY 为强随机
docker compose up -d
```

升级（master 推 commit → GHCR 镜像自动更新 → VPS 上手动拉）：

```bash
docker compose pull && docker compose up -d
```

容器启动时自动跑 `prisma migrate deploy`，无需手动迁移。

> **首次推完镜像后**需到 GitHub Packages 把 `slate` 镜像可见性手动设为 public（仅一次），之后 VPS 上 `docker pull` 不必登录 GHCR。

## CI / 镜像构建

仓库根 `.github/workflows/`：

- `ci.yml` — PR + push to master：lint-format / typecheck / test / frontend-build 四个并行 job
- `firmware.yml` — push to master 且 `firmware/**` 变化才触发，ESP-IDF 构建后 upload artifact
- `docker.yml` — push to master：buildx 多架构（amd64 + arm64）构建并 push GHCR，标签 `master` / `latest` / `sha-<short>`

镜像构建用仓库根 `Dockerfile`（multi-stage：bun 装依赖 → 跑 prisma generate + vite build → 拷进精简 runner stage），entrypoint 是 `entrypoint.sh`（先 migrate 再启服务）。

## 历史踩坑（Slate M1 阶段笔记）

- **zectrix Note4 是 QIO Flash + Octal PSRAM**，写错 Octal Flash 配置会让 bootloader 卡死 → 拆机救砖。`firmware/sdkconfig.defaults` 里固化的正确组合不要动。
- **拔 USB 不会重启 MCU**，电源拓扑 USB → 充电 IC → 电池 → MCU。唯一可靠硬复位 = 拆机断电池排线 ≥30 秒。esptool 救砖必须 `--before no_reset`。
- **新 sdkconfig 必须先用 hello world 验证**，不能"我相信 sdkconfig 没问题"直接烧 board init + EPD + LVGL 一锤子代码。
- **iot_button callback 绝不能阻塞**，否则后续按键全部丢失。本项目 callback 只 atomically 改 `target_index_`，实际执行由 main task 周期 `TickAndApply` 驱动。
