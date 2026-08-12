# Codex × OpenCode Go 额度监控设计

日期：2026-08-12  
状态：设计已确认，等待用户审阅书面规格  
目标设备：ZecTrix Note4，400 × 300，1bpp  
目标部署：Slate 运行在 fnOS NAS；额度采集器运行在当前 Mac

## 1. 目标

为 Slate 增加一个自定义 Dashboard 帧，在同一块墨水屏上持续展示：

- Codex 当前套餐、服务状态、可获得的额度窗口、剩余百分比、重置时间和 Credits；
- OpenCode Go 的 5 小时、周、月剩余额度与重置时间；
- OpenCode Go 的余额接续状态；
- 单个数据源失败、未登录、未配置、限流或数据过期时的可信状态。

所有额度条统一表示“剩余额度”：条越长，可用额度越多。监控不得通过发送模型请求来探测额度，也不得把 Codex 或 OpenCode Go 的登录凭据复制到 Slate、NAS、模板数据或日志中。

## 2. 已确认的产品决策

### 2.1 版式

采用用户确认的 A5 方案：

- 两个服务纵向排列，Codex 在上，OpenCode Go 在下；
- 每个服务使用完整 400px 宽度；
- 顶部 24px 由固件状态栏占用，标题为“额度监控”并由固件按 x=200 几何居中；
- 模板正文从 y=24 开始，最后一行延伸至 y=300，不额外保留视觉底边；
- 所有模板可控文字使用当前模板支持的最大字号 16px；
- progress 的 `label_font_size` 和 `value_font_size` 都为 16，`bar_height` 为 14；
- 删除采集周期、数据新鲜度等小字页脚；
- 保留 Codex Credits 和 OpenCode Go“余额接续 开启/关闭”。

曾比较但未采用的方向：

- 左右双列：跨服务比较直接，但两栏宽度导致文字和额度条过小；
- 风险优先：远看最快，但会丢失具体窗口和重置时间；
- 初版上下分区：阅读方向正确，但字号、行距和底部留白未达到要求。

### 2.2 采集位置

采集器运行在当前 Mac，并由 `launchd` 每 5 分钟触发：

- 不要求终端、Codex App 或 OpenCode TUI 持续打开；
- 作为用户级 LaunchAgent，只在该 macOS 用户已登录时运行；锁屏不影响，注销、关机和休眠会暂停；
- Mac 休眠或关机时暂停采集；恢复后由后续调度继续；
- 不在 NAS 上复制或建立第二份 Codex 登录；
- 不把 OpenCode Go API Key 放进 Slate 主服务、MySQL、Docker 环境或 Dashboard 数据；
- 第一版不追求 Mac 离线时的 24 小时连续采集。

## 3. 系统边界与数据流

```text
Mac launchd（每 300 秒）
        │
        └── SlateQuotaCollector（原生 macOS 可执行文件）
              ├── CodexAdapter
              │     └── codex app-server --stdio
              │           └── account/rateLimits/read
              ├── OpenCodeGoAdapter
              │     └── GET https://opencode.ai/zen/go/v1/usage
              ├── Normalizer
              │     ├── 统一为“剩余百分比”
              │     ├── 转换绝对重置时间
              │     └── 合并 last-known-good
              ├── SanitizedCache
              │     └── 只保存可显示的脱敏快照
              └── SlateIngestClient
                    └── POST /api/v1/contents/:contentId/data
                                │
                                ├── Slate 立即渲染 400×300 1bpp
                                ├── 更新 image/content/manifest ETag
                                └── 设备下次同步时显示
```

采集器使用 Swift 6 原生编译，依赖 macOS Foundation 与 Security framework，不要求另外安装 Node、Bun、Python 或常驻容器。项目放置在：

```text
tools/slate-quota-collector/
├── Package.swift
├── Sources/SlateQuotaCollector/
│   ├── Command.swift
│   ├── CodexRateLimitClient.swift
│   ├── OpenCodeGoUsageClient.swift
│   ├── QuotaNormalizer.swift
│   ├── KeychainStore.swift
│   ├── SanitizedSnapshotCache.swift
│   └── SlateIngestClient.swift
├── Tests/SlateQuotaCollectorTests/
├── Resources/
│   └── com.yym8224961.slate-quota-collector.plist.template
├── templates/
│   ├── slate-dashboard-template.json
│   └── initial-data.json
└── README.md
```

模块边界：

- `CodexRateLimitClient` 只负责官方 JSON-RPC 会话和原始响应解码；
- `OpenCodeGoUsageClient` 只负责官方 HTTPS 接口、状态码和响应解码；
- `QuotaNormalizer` 是唯一处理窗口识别、百分比、阈值、时间和显示文案的模块；
- `KeychainStore` 是唯一读取敏感配置的模块；
- `SanitizedSnapshotCache` 拒绝保存任何未归一化的上游响应；
- `SlateIngestClient` 只接受已经通过 schema 校验的展示 payload。

## 4. 真实数据源

### 4.1 Codex

每次采集启动一个短生命周期的：

```text
codex app-server --stdio
```

通过 JSONL 完成初始化并读取：

```json
{"method":"initialize","id":1,"params":{"clientInfo":{"name":"slate_quota_collector","title":"Slate quota collector","version":"1.0.0"}}}
{"method":"initialized","params":{}}
{"method":"account/rateLimits/read","id":2,"params":{}}
```

规则：

- 必须在拥有当前 Codex ChatGPT 登录状态的同一 macOS 用户下运行；
- 采集器不直接读取、复制、解析或上传 `~/.codex/auth.json`；
- 不调用模型，不创建 thread，不发送 prompt；
- 优先读取 `rateLimitsByLimitId.codex`；不存在时，仅在 `rateLimits.limitId == "codex"` 时回退到 `rateLimits`；
- 不把 `codex_bengalfox` 等独立模型额度混入 Codex 主额度；
- 使用 `windowDurationMins` 识别窗口，而不是假设 `primary` 永远是 5 小时；
- `300` 分钟映射为 5 小时窗口，`10080` 分钟映射为周窗口；
- 后端没有返回某个窗口时显示“未提供”，不能显示为 100% 剩余；
- `remainingPercent = clamp(100 - usedPercent, 0, 100)`；
- `resetsAt` 是 Unix 秒时间戳，转换成 `Asia/Shanghai` 的 `MM-dd HH:mm`；
- `rateLimitReachedType` 表示触顶时，服务端状态优先于本地百分比判断；
- Credits：`unlimited == true` 显示 `Credits 无限`；存在数值余额时保留两位小数；不可用时显示 `Credits —`。

短生命周期 App Server 在收到目标响应后立即正常终止；单次读取超时为 20 秒。stderr 中的模型目录、插件目录刷新警告不得被当成额度失败，只有目标 JSON-RPC 请求失败或超时才算失败。

### 4.2 OpenCode Go

调用官方接口：

```http
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OpenCode Go API Key>
```

响应窗口：

- `rollingUsage`：5 小时；
- `weeklyUsage`：周；
- `monthlyUsage`：月。

每个窗口使用：

- `remainingPercent = clamp(100 - usagePercent, 0, 100)`；
- `resetAt = responseReceivedAt + resetInSec`；
- `status == "rate-limited"` 时直接标记“已耗尽”；
- `useBalance` 显示为 `余额接续 开启` 或 `余额接续 关闭`。

OpenCode Go 当前计划的 `$12 / 5 小时`、`$30 / 周`、`$60 / 月`属于计划说明，不作为实时金额展示。API 只提供百分比、重置倒计时与状态，因此不能从接口虚构已经消费或剩余的美元金额。

该接口发布时间较新。采集器必须把非 JSON、字段缺失、超时和未知状态视为数据源失败，不得以 0% 使用量或 100% 剩余额度降级。

## 5. Slate 自定义模板

### 5.1 状态栏

自定义模板不绘制 y=0..23 的状态栏。创建内容时设置：

```text
帧名称：额度监控
```

固件使用真实 Wi-Fi、电量状态和 `device_status_bar_text` 绘制状态栏，并将标题按屏幕中心对齐。因此，不需要修改模板坐标或在帧图片中重复绘制顶栏。

### 5.2 最终模板 JSON

以下内容直接粘贴到 Slate 的“自定义模板 JSON”输入框，不需要再包 `type/template/kind`：

```json
{
  "version": 1,
  "name": "Codex · OpenCode Go 额度监控",
  "blocks": [
    { "type": "rect", "x": 0, "y": 24, "w": 400, "h": 28, "stroke": false, "fill": "black" },
    { "type": "text", "x": 12, "y": 30, "w": 210, "h": 18, "value": "{codex.header_left}", "font_size": 16, "color": "white" },
    { "type": "text", "x": 224, "y": 30, "w": 164, "h": 18, "value": "{codex.summary_label}", "font_size": 16, "align": "right", "color": "white" },

    { "type": "progress", "x": 12, "y": 55, "w": 376, "h": 38, "label": "{codex.rolling.label}", "percentage": "{codex.rolling.remaining_percent}", "value_text": "{codex.rolling.value_text}", "label_font_size": 16, "value_font_size": 16, "bar_height": 14 },
    { "type": "progress", "x": 12, "y": 93, "w": 376, "h": 38, "label": "{codex.weekly.label}", "percentage": "{codex.weekly.remaining_percent}", "value_text": "{codex.weekly.value_text}", "label_font_size": 16, "value_font_size": 16, "bar_height": 14 },
    { "type": "line", "x1": 12, "y1": 134, "x2": 388, "y2": 134, "style": "solid" },
    { "type": "text", "x": 12, "y": 139, "w": 210, "h": 18, "value": "{codex.footer_left}", "font_size": 16 },
    { "type": "text", "x": 230, "y": 139, "w": 158, "h": 18, "value": "{codex.footer_right}", "font_size": 16, "align": "right" },

    { "type": "rect", "x": 0, "y": 158, "w": 400, "h": 28, "stroke": false, "fill": "black" },
    { "type": "text", "x": 12, "y": 164, "w": 210, "h": 18, "value": "{opencode_go.header_left}", "font_size": 16, "color": "white" },
    { "type": "text", "x": 224, "y": 164, "w": 164, "h": 18, "value": "{opencode_go.summary_label}", "font_size": 16, "align": "right", "color": "white" },

    { "type": "progress", "x": 12, "y": 189, "w": 376, "h": 31, "label": "{opencode_go.rolling.label}", "percentage": "{opencode_go.rolling.remaining_percent}", "value_text": "{opencode_go.rolling.value_text}", "label_font_size": 16, "value_font_size": 16, "bar_height": 14 },
    { "type": "progress", "x": 12, "y": 220, "w": 376, "h": 31, "label": "{opencode_go.weekly.label}", "percentage": "{opencode_go.weekly.remaining_percent}", "value_text": "{opencode_go.weekly.value_text}", "label_font_size": 16, "value_font_size": 16, "bar_height": 14 },
    { "type": "progress", "x": 12, "y": 251, "w": 376, "h": 31, "label": "{opencode_go.monthly.label}", "percentage": "{opencode_go.monthly.remaining_percent}", "value_text": "{opencode_go.monthly.value_text}", "label_font_size": 16, "value_font_size": 16, "bar_height": 14 },
    { "type": "line", "x1": 12, "y1": 282, "x2": 388, "y2": 282, "style": "solid" },
    { "type": "text", "x": 12, "y": 283, "w": 210, "h": 17, "value": "{opencode_go.footer_left}", "font_size": 16 },
    { "type": "text", "x": 230, "y": 283, "w": 158, "h": 17, "value": "{opencode_go.footer_right}", "font_size": 16, "align": "right" }
  ]
}
```

共 17 个 block，低于模板上限 32；所有 rect 均满足 `x + w <= 400` 和 `y + h <= 300`。最后两个 text block 的 `y + h` 正好为 300，不额外保留底边。

当前 progress renderer 不支持根据数据动态绘制斜线填充。Codex 某个窗口缺失时，实际 Slate 帧显示为空心额度条和“未提供”，不伪造百分比。若以后要求斜线占位，需要单独扩展 Dashboard renderer，不属于第一版范围。

## 6. 归一化推送契约

Slate 接收：

```http
POST /api/v1/contents/:contentId/data
Content-Type: application/json
```

payload：

```json
{
  "version": 1,
  "data": {
    "schema_version": 1,
    "generated_at": "2026-08-12T08:30:00Z",
    "codex": {
      "status": "ok",
      "source_collected_at": "2026-08-12T08:30:00Z",
      "header_left": "CODEX · PROLITE",
      "summary_label": "最低剩余 90%",
      "rolling": {
        "label": "5 小时",
        "remaining_percent": 0,
        "value_text": "未提供",
        "reset_at": null
      },
      "weekly": {
        "label": "本周",
        "remaining_percent": 90,
        "value_text": "剩余 90%",
        "reset_at": "2026-08-19T06:06:00+08:00"
      },
      "footer_left": "周重置 08-19 06:06",
      "footer_right": "Credits 128.50"
    },
    "opencode_go": {
      "status": "ok",
      "source_collected_at": "2026-08-12T08:30:00Z",
      "header_left": "OPENCODE GO",
      "summary_label": "最低剩余 71%",
      "rolling": {
        "label": "5 小时",
        "remaining_percent": 81,
        "value_text": "剩余 81%",
        "reset_at": "2026-08-12T18:30:00+08:00"
      },
      "weekly": {
        "label": "本周",
        "remaining_percent": 71,
        "value_text": "剩余 71%",
        "reset_at": "2026-08-16T10:00:00+08:00"
      },
      "monthly": {
        "label": "本月",
        "remaining_percent": 75,
        "value_text": "剩余 75%",
        "reset_at": "2026-09-01T00:00:00+08:00"
      },
      "footer_left": "下次重置 08-12 18:30",
      "footer_right": "余额接续 关闭"
    }
  }
}
```

示例数值仅为测试夹具，不代表实际账户。

状态枚举：

```text
ok
attention
critical
exhausted
stale
unauthenticated
unconfigured
unavailable
```

显示阈值按“剩余百分比”计算：

- `> 20%`：`最低剩余 N%`；
- `10%..20%`：`注意 · 剩余 N%`；
- `1%..9%`：`紧急 · 剩余 N%`；
- `0%` 或服务端判定触顶：`已耗尽`。

对状态栏式的黑白帧，不依赖颜色表达告警；状态必须写进 16px 文本。

## 7. 密钥、权限与存储

### 7.1 macOS 钥匙串

敏感值使用 Security framework 写入当前用户的登录钥匙串：

```text
service=com.yym8224961.slate-quota-collector
account=opencode-go-api-key

service=com.yym8224961.slate-quota-collector
account=slate-push-url
```

安装程序使用无回显输入，不把 secret 放进命令参数、shell history、launchd plist 或普通配置文件。采集器日志不得输出：

- OpenCode Go API Key；
- 完整 Slate capability URL 或 contentId；
- Codex access/refresh token；
- Authorization header；
- 上游原始错误正文；
- 邮箱、用户 ID、组织 ID；
- 未脱敏的原始响应。

Slate 推送 URL 同时允许公开 GET 当前 Dashboard 数据，并把 contentId 当作读写凭证。泄漏后的轮换方式是删除原内容并重建。访问 Slate/反向代理日志的权限等同于访问推送凭证；生产部署应限制日志读取。Mac 到 NAS 不得通过公网明文 HTTP 传输；优先使用 HTTPS 或受控 VPN，可信局域网 HTTP 需要明确接受 capability 泄漏风险。

### 7.2 本地非敏感配置

```text
~/Library/Application Support/SlateQuotaCollector/config.json
```

只保存：

- Codex 可执行文件的绝对路径；
- 时区 `Asia/Shanghai`；
- 超时与日志级别；
- 钥匙串 service/account 名称；
- schema 版本。

不保存实际 Key 或 URL。

### 7.3 last-known-good

```text
~/Library/Application Support/SlateQuotaCollector/last-good.json
```

权限为当前用户可读写。文件只包含上一份已经归一化、允许显示在墨水屏和公开 Dashboard GET 中的 payload。禁止缓存原始 Codex/OpenCode 响应。

## 8. 调度、并发与超时

launchd job：

```text
label: com.yym8224961.slate-quota-collector
RunAtLoad: true
StartInterval: 300
```

安装时解析并写入 collector 可执行文件和 Codex CLI 的绝对路径，避免依赖 launchd 的精简 PATH。每轮同时读取两个 provider，随后串行执行 normalize、cache 和 push。

超时：

- Codex App Server：20 秒；
- OpenCode Go HTTPS：10 秒；
- Slate POST：15 秒；
- 整轮硬上限：45 秒。

launchd 不应启动同一个 job 的第二个并发实例；collector 仍以原子创建的本地锁做第二层保护。发现正在运行的有效实例时本轮退出成功；发现无对应进程的陈旧锁时清理后继续。只有一个 collector 实例可以写同一个 Slate frame，避免较旧快照覆盖较新快照。

## 9. 失败与恢复语义

### 9.1 单数据源失败

若该 provider 有 last-known-good：

- 保留上次可信百分比和绝对重置时间；
- `status = stale`；
- header 使用 `CODEX · 数据过期` 或 `OPENCODE GO · 数据过期`；
- summary 使用 `最后可信 N%`；
- 另一个 provider 继续使用当前数据；
- 推送组合后的快照。

若没有 last-known-good：

- Codex 无登录显示 `CODEX · 未登录`；
- OpenCode 401 显示 `OPENCODE GO · 未配置`；
- OpenCode 403 显示 `OPENCODE GO · 无 Go 订阅`；
- 所有无法确认的窗口使用 `remaining_percent = 0` 仅用于空心条，并以 `value_text = 未提供` 明确覆盖语义；
- summary 显示 `无可信数据`，不能显示“已耗尽”。

### 9.2 两个数据源同时失败

- 第一次同时失败：不向 Slate 推送，保留设备现有帧；
- 连续第二次同时失败：使用 last-known-good 构造双 provider `数据过期` 快照并推送；
- 没有任何 last-known-good 时推送双 provider `无可信数据`；
- 下一次任一 provider 成功后立即恢复其正常状态并清零该 provider 的连续失败计数。

### 9.3 推送失败

- 不删除 last-known-good；
- 不重复登录上游；
- 当前轮最多在短退避后重试一次 Slate POST；
- 401/404 等永久错误不进行无限重试，记录脱敏错误码并等待人工重新配置；
- 下一轮 launchd 调度正常继续。

### 9.4 Mac 休眠

休眠期间不承诺采集。唤醒后等待 launchd 下一次触发；不通过补跑多轮请求追赶历史数据。由于每个 provider 保存 `source_collected_at`，采集器会在重新推送前判断快照年龄；超过 10 分钟的旧值必须标记 `stale`。

## 10. 创建与安装流程

### 10.1 Slate 中创建帧

1. 在目标内容组中新建“外部数据”；
2. 帧名称填“额度监控”；
3. 模板选择“自定义模板”；
4. 刷新间隔选择 5 分钟。该间隔只控制 Slate/设备用现有数据重渲染或同步，不负责采集上游；
5. 粘贴第 5.2 节模板；
6. 粘贴随工具提供的 `initial-data.json`；
7. 创建后复制 `POST /api/v1/contents/:contentId/data` 推送 URL。

### 10.2 Mac 采集器

CLI 需要以下命令：

```text
slate-quota-collector setup
slate-quota-collector collect --dry-run
slate-quota-collector collect --once
slate-quota-collector install-launch-agent
slate-quota-collector status
slate-quota-collector uninstall-launch-agent
```

- `setup`：无回显收集 OpenCode Go Key 与 Slate URL，写入钥匙串，定位 Codex CLI，做只读账户与端点预检；
- `--dry-run`：读取两个 provider，输出脱敏后的 payload，不 POST；
- `--once`：采集并执行一次真实 Slate POST；
- `install-launch-agent`：安装并加载每 300 秒运行的用户级 LaunchAgent；
- `status`：只显示最近一次成功时间、各 provider 状态、LaunchAgent 状态和脱敏错误码；
- `uninstall-launch-agent`：停止并移除 LaunchAgent，不自动删除钥匙串或 last-known-good；清除数据需要单独显式命令。

## 11. 验证与验收

### 11.1 模板验证

- 用 shared `DashboardTemplate.safeParse` 验证最终 JSON；
- 使用正常、低额度、已耗尽、窗口缺失、超长套餐名、单源 stale 和双源无数据夹具渲染；
- 每个输出必须为 400 × 300、15000 bytes、1bpp；
- 所有 block 坐标在范围内，block 数量不超过 32；
- 视觉 QA：16px 文字无裁切，额度条间距达到 A5，状态栏标题实际居中，正文底部无多余页脚和留白；
- 进度条全部表示剩余百分比，任何错误路径不得显示虚假的 100% 剩余。

### 11.2 Collector 单元测试

- Codex：窗口顺序变化、仅周窗口、双窗口、独立 Spark limit、缺失字段、触顶状态、Credits 无限/数值/缺失；
- OpenCode：三窗口正常、单窗口 rate-limited、401、403、429、5xx、超时、非 JSON、新字段与缺字段；
- 时间：`resetInSec` 与 Unix timestamp 转 `Asia/Shanghai`，跨天、跨月、夏令时无误；
- 阈值：21%、20%、10%、9%、1%、0%；
- last-known-good：单源失败、双源第一次失败、双源连续第二次失败、恢复；
- secret redaction：日志、错误和缓存中不出现测试 Key、Authorization 或完整 Slate URL。

### 11.3 集成验证

- 用假 Codex App Server、假 OpenCode API 和假 Slate ingest server 跑完整一轮；
- 验证并发读取、总超时、单次 Slate 重试和锁；
- 本机执行一次真实 `account/rateLimits/read`，确认不创建 thread、不发送模型请求；
- 使用用户提供的 OpenCode Go Key 做一次真实 read-only usage 调用；
- `collect --dry-run` 的 payload 通过 schema；
- `collect --once` 后读取 Slate `GET .../data`，确认数据与模板一致且不存在 secret；
- 检查 Slate POST 返回新的 `image_etag`、`manifest_etag` 和 `rendered_at`；
- 在 Web 预览和真实 Note4 上分别验证一帧，区分“服务器已渲染”与“设备已在下一次同步显示”。

### 11.4 完成标准

只有同时满足以下条件才可称为完成：

- A5 模板通过 schema 与多状态渲染 QA；
- 两个真实数据源各取得一次只读成功响应；
- Mac 钥匙串中存在两个所需 secret，普通配置和日志中不存在 secret；
- LaunchAgent 已安装，连续完成至少两次间隔约 5 分钟的自动推送；
- Slate 当前数据、渲染 ETag 与真实设备显示均得到回读或实机证明；
- 模拟单源失败不会归零，模拟双源失败符合第 9 节；
- 不修改 Slate 固件、主服务凭据模型、MySQL schema 或现有 Hermes 链路。

## 12. 不在第一版范围内

- NAS 侧 Codex 登录或 24 小时常驻采集；
- 复制 Mac 的 Codex auth 文件到 NAS；
- 通过模型请求、聊天消息或 token 数反推剩余额度；
- 监控 Spark 等独立模型额度；
- 修改 Slate capability URL 的鉴权方式；
- 修改固件状态栏布局；
- 新增 20px/24px 字库或模板字体选项；
- 给缺失窗口动态绘制斜线 progress；
- 采集或展示邮箱、组织、原始账单明细、prompt、会话或模型使用内容；
- Mac 休眠期间补齐历史快照。

## 13. 风险与后续

- OpenCode Go usage API 较新，字段变化必须 fail closed：保留可信旧数据并显示过期，而不是猜测；
- Codex 后端可能只返回一个窗口或改变可见窗口，collector 必须继续以 `windowDurationMins` 识别；
- Slate capability URL 同时可读写，未来若做平台级硬化，应增加独立 ingest token、日志 URL 脱敏和凭证轮换；
- 如果用户以后要求 Mac 离线仍连续采集，应另开 NAS collector 设计，不在当前工具中静默扩展凭据边界；
- 如果 16px 仍不够大，只能减少字段或为 Slate renderer 增加新的字体资产，不能通过当前模板 JSON继续放大。
