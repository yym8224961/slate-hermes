# Slate × Renewlet 财务看板

这一套内容包含两张 400×300 Slate 自定义 dashboard：

- `Renewlet 本月现金流`：本月实际支出、收入、退款、净现金流和支出前三。
- `Renewlet 最近消费`：最近五笔实际支出，按发生时间倒序展示日期、商户、分类和金额。

只读取 Renewlet 已经发生的 `Transaction`。订阅承诺、预计续费和下次扣款不会混入实际流水。

## 1. 在 Slate 建立两张内容

在同一个内容组内新建两张「外部数据 dashboard」，模板选择「自定义」。

第一张：

- 帧名称：`本月现金流`
- 模板：`templates/monthly-cashflow-template.json`
- 初始数据：`templates/monthly-cashflow-initial-data.json` 中的 `data`

第二张：

- 帧名称：`最近消费`
- 模板：`templates/recent-expenses-template.json`
- 初始数据：`templates/recent-expenses-initial-data.json` 中的 `data`

保存后分别复制两张内容的「数据推送 URL」。只取 URL 中的 `contentId` 配置到任务环境；完整 URL 与 `contentId` 都按能力凭据处理，不要写进仓库或聊天记录。

## 2. Renewlet 数据入口

当前 fnOS 上经过浏览器登录态和 HTTPS 健康检查确认的 Renewlet 地址是：

```text
https://west3.kylecloud.top:3301
```

Slate 地址是：

```text
https://west3.kylecloud.top:3002
```

两个入口都已启用有效 TLS。同步任务会同时拒绝通过公网明文 HTTP 发送 Renewlet Token 或 Slate Content ID。部署在同一台 fnOS 上时也可以改用 Docker 私有网络，但不要为此重建 Renewlet 的 `/pb_data` 或 Slate 的 MySQL 数据。

## 3. 运行配置

任务使用 Renewlet 的只读 `GET /api/hermes/v1/transactions` 按月完整分页读取，并通过 `GET /api/hermes/v1/reporting/exchange-rate-snapshots` 读取 Renewlet 已锁定的当月报表口径，再把两个独立的数据 envelope 推到 Slate。

```text
SLATE_RUN_MODE=job
SLATE_JOB=renewlet-finance-dashboard
SLATE_JOB_INTERVAL_SECONDS=300
SLATE_JOB_TIME_ZONE=Asia/Shanghai
SLATE_API_BASE=http://slate:3001
RENEWLET_BASE=http://web:3000
RENEWLET_HERMES_TOKEN=<dedicated rlh_ token>
RENEWLET_MONTHLY_CONTENT_ID=<monthly content id>
RENEWLET_RECENT_CONTENT_ID=<recent content id>
RENEWLET_REPORTING_CURRENCY=CNY
RENEWLET_ALLOW_REPORT_BASIS_FALLBACK=false
```

`RENEWLET_REPORTING_CURRENCY` 默认 `CNY`。只有当月实际流水包含外币时，月度汇总才读取 Renewlet 的当月锁定快照并折算；全部流水已经是报表币种时无需汇率快照。快照缺失或不覆盖某个币种时，月度页失败并保留上一次成功画面；最近消费页独立更新，仍按各笔原币种显示金额。

`RENEWLET_ALLOW_REPORT_BASIS_FALLBACK` 是迁移开关，默认关闭。只有同时满足以下条件才会读取受保护的 `RENEWLET_REPORT_BASIS_JSON`：开关明确设为 `true`、快照端点明确返回 `404`、配置快照月份与当前报表月份完全一致。鉴权失败、TLS/网络错误、服务端错误或响应契约错误一律不会回退。

### 现场状态（2026-08-30）

west3 线上 Renewlet 尚未切换到包含 Hermes 汇率快照端点的新镜像，因此当前 `2026-08` 运行使用受保护的同月锁定快照迁移配置。新镜像已上传等待 fnOS 管理员切换；在切换完成前，进入新月份后若出现需要折算的外币流水，月度页会失败关闭并保留最后一次正确画面，不会临时抓取或猜测汇率。全部为 CNY 的月份及最近消费页不受该快照阻塞。

## 4. fnOS 用户级定时部署

现场 SSH 用户不能直接管理 Docker，但可以写入 Slate 的现有数据目录，并且系统提供用户级 `crontab`。因此推荐把一次性同步入口打包为 Bun 程序，并配套固定版本的 Linux x64 Bun 运行时，放入：

```text
/vol1/1000/Docker/slate-ready/data/renewlet-finance-sync/
```

目录内包含：

- `renewlet-finance-bun`：固定版本的 Linux x64 Bun 运行时。
- `renewlet-finance-sync.js`：由 `backend/scripts/renewlet-finance-once.ts` 打包出的单文件程序。
- `renewlet-finance-sync.sh`：加载环境、限制日志为 1 MiB、使用 `flock` 防止任务重叠。
- `finance.env`：权限必须为 `0600`，只在 NAS 上保存 Token 和两个 Content ID。

`finance.env.example` 给出了现场配置。启动脚本会在 source 之前检查 `finance.env` 的 group/world 权限，非私有权限会直接拒绝运行。不要把真实 `finance.env`、Token 或 Content ID 提交到仓库。

用户级定时任务：

```cron
*/5 * * * * /vol1/1000/Docker/slate-ready/data/renewlet-finance-sync/renewlet-finance-sync.sh
```

安装定时任务前先直接运行一次脚本，确认 Renewlet GET、两个 Slate POST 和两个 GET 回读全部成功。定时任务安装后再次读取 `crontab -l`，并观察下一轮日志和两张页面的更新时间。

## 5. fnOS Compose sidecar 备选

把下面的服务加入 Slate 部署现场的 Compose，并让它同时加入 Slate 默认网络与 Renewlet 的外部网络。能力 ID 和 Token 放在部署现场环境变量中，不要直接写入 Compose 文件。

```yaml
services:
  slate-renewlet-finance:
    image: <与 slate 服务相同的镜像>
    restart: unless-stopped
    environment:
      SLATE_RUN_MODE: job
      SLATE_JOB: renewlet-finance-dashboard
      SLATE_JOB_INTERVAL_SECONDS: '300'
      SLATE_JOB_TIME_ZONE: Asia/Shanghai
      SLATE_API_BASE: http://slate:3001
      RENEWLET_BASE: http://web:3000
      RENEWLET_HERMES_TOKEN: ${RENEWLET_HERMES_TOKEN}
      RENEWLET_MONTHLY_CONTENT_ID: ${RENEWLET_MONTHLY_CONTENT_ID}
      RENEWLET_RECENT_CONTENT_ID: ${RENEWLET_RECENT_CONTENT_ID}
      RENEWLET_REPORTING_CURRENCY: CNY
    networks:
      - default
      - renewlet

networks:
  renewlet:
    external: true
    name: renewlet-hermes_default
```

部署前先在 fnOS 上确认实际 Renewlet Compose 网络名和 `web` 服务别名没有变化。不要为了接入 sidecar 删除或重建 Renewlet 的 `/pb_data`，也不要删除 Slate 的 MySQL/数据目录。

## 6. 验收

先单次运行：

```bash
SLATE_JOB=renewlet-finance-dashboard SLATE_JOB_RUN_ONCE=1 bun run scripts/job-runner.ts
```

完成验收需要同时满足：

1. Renewlet 返回当月全部分页、最近五笔支出和当月锁定汇率快照。
2. 两个 Slate POST 都成功。
3. 再分别 GET 两个 Slate `/data` 地址，读回的 `version: 1` 和 `data` 与本轮投影一致。
4. Slate 编辑器预览显示两张完整 400×300 画面；实体设备只有在用户将设备切换到“财务”分组后才纳入验收。
5. 月度净现金流等于 `收入 + 退款 - 支出`，外币折算和锁定汇率日期与 Renewlet 一致。

任务失败时不会用空数据覆盖上一张成功画面；先排查 Renewlet 连接、Token、分页或 Slate 推送，再恢复周期运行。
