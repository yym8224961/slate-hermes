# Slate Codex × OpenCode Go 额度监控

这是当前 Mac 专用的本地采集器和菜单栏 App。它每 5 分钟从 Codex 官方 App Server 和 OpenCode Go 官方用量接口读取一次额度，归一化为“剩余百分比”，再推送到 Slate 的“额度监控”帧。它不发送模型请求，不创建 Codex thread，也不把两个凭据写入 Slate、NAS、普通配置文件或日志。

## 使用前准备

需要同时满足：

- macOS 13 或更高版本；
- Swift 6.2；
- 当前 macOS 用户已在 Codex / ChatGPT 登录，且同一用户能在终端找到 `codex`；
- 一个有效的 OpenCode Go API Key；
- Slate 中新建“外部数据”后生成的 capability URL。

不要把 API Key 或 capability URL 发到聊天、写进 shell history，也不要放入本 README。`setup` 会在本机终端内无回显读取它们。

Codex 采集同时兼容旧版顶层 `credits` / `planType` 和 Codex CLI 0.144.1 的当前限额结构；当前结构中选中的 `codex` 限额内嵌值优先。采集会话在收到 `account/rateLimits/read` 回应前保持标准输入开启，但仍只发送初始化和限额读取三条方法，不创建 thread 也不发送 prompt。

Codex App Server 以独立进程组运行；采集完成、超时或取消时会清理该组中仍继承管道的辅助进程。主动脱离会话、双重 fork 并转移到其他进程组的后代不在采集器可安全归属的范围内；官方 App Server 不应以此方式后台化。

## 1. 构建 release 版本

在仓库根目录执行：

```bash
rtk swift build --package-path tools/slate-quota-collector -c release
```

成功时 Swift 以 `Build complete!` 结束。后续命令使用：

```text
tools/slate-quota-collector/.build/release/slate-quota-collector
```

## 2. 在 Slate 创建“额度监控”帧

1. 进入目标内容组，新建“外部数据”。
2. 帧名称填“额度监控”。
3. 模板选“自定义模板”，把 [`templates/slate-dashboard-template.json`](templates/slate-dashboard-template.json) 的完整内容粘贴到自定义模板 JSON。
4. 把 [`templates/initial-data.json`](templates/initial-data.json) 的完整内容粘贴到初始数据。
5. 刷新间隔选“5 分钟”。这个选项控制 Slate/设备用已有数据重新渲染或同步，不代替 Mac 采集上游。
6. 创建完成后复制 Slate 生成的 capability URL，只在下一步的无回显提示中输入。

模板为 400 × 300、1bpp，y=0..23 留给设备状态栏。Codex 和 OpenCode Go 纵向排列，共 5 条额度条；Codex 未返回的窗口显示空心条与“未提供”，不冒充 100% 剩余。

## 3. 配置、试运行和安装

以下示例把 release 二进制简写为 `slate-quota-collector`。请使用上面的完整路径执行。

### `setup`

```bash
rtk tools/slate-quota-collector/.build/release/slate-quota-collector setup
```

这一步必须由使用者本人在当前 Mac 终端执行。程序依次要求输入并再次确认 OpenCode Go API Key 和 Slate capability URL；四次输入均不显示字符。它先完成 Codex/OpenCode 只读预检，然后把两个敏感值写入 macOS 钥匙串。成功输出：

```text
配置完成，只读预检通过
```

### `collect --dry-run`

```bash
rtk tools/slate-quota-collector/.build/release/slate-quota-collector collect --dry-run
```

成功时在标准输出写一份 `version: 1` 的脱敏 JSON envelope，不向 Slate POST。若只有一个 provider 失败，仍输出可展示数据，并只在标准错误写类似 `状态：codex=timeout` 的封闭错误码。输出不包含 Key、capability URL、content ID、Authorization 或上游原始错误正文。

### `collect --once`

```bash
rtk tools/slate-quota-collector/.build/release/slate-quota-collector collect --once
```

成功时输出一行固定的脱敏证明，其中时间和两个 provider 状态来自本轮实际结果：

```text
推送成功：id=redacted image_etag=redacted manifest_etag=redacted rendered_at=[实际 ISO 8601 时间] readback_verified=true schema_version=1 codex_status=[实际状态] opencode_go_status=[实际状态]
```

这行证明表示程序已在返回前完成 Slate GET 回读，且回读 payload 与本轮归一化 data 一致。`id` 和两个 ETag 始终固定显示为 `redacted`；capability URL、content ID、原始 ETag、Authorization 和上游原始正文都不会打印。如 provider 或 Slate 失败，只会写封闭错误码。菜单栏“立即采集一次”和定时采集仍保持静默，不把这条交互证明写入后台日志。

### `pause`

```bash
rtk tools/slate-quota-collector/.build/release/slate-quota-collector pause
```

成功输出：

```text
自动采集：已关闭
```

关闭状态会持久化；菜单栏 App、钥匙串、配置、脱敏快照和 Slate 当前画面全部保留。

### `resume`

```bash
rtk tools/slate-quota-collector/.build/release/slate-quota-collector resume
```

成功输出：

```text
自动采集：已开启
```

collector LaunchAgent 会立即加载并执行一轮，之后每 300 秒触发。

### `install-launch-agent`

```bash
rtk tools/slate-quota-collector/.build/release/slate-quota-collector install-launch-agent
```

成功输出：

```text
菜单栏与自动采集已安装
```

命令安装 `~/Applications/Slate 额度监控.app`，并安装两个独立用户级 LaunchAgent：

- `com.yym8224961.slate-quota-menubar`：登录后自动显示菜单栏 App，无 Dock 图标；
- `com.yym8224961.slate-quota-collector`：`RunAtLoad` 立即运行，然后以 `StartInterval=300` 调度。

### `status`

```bash
rtk tools/slate-quota-collector/.build/release/slate-quota-collector status
```

输出固定为以下八行，方括号代表当前机器的脱敏状态：

```text
自动采集：[已开启/已关闭]
菜单栏：[已加载/未加载]
定时采集：[已加载/未加载]
Codex：[脱敏 provider 摘要]
OpenCode Go：[脱敏 provider 摘要]
最近成功：[时间/尚无记录]
最近推送：[时间/尚无记录]
错误码：[无/脱敏错误码]
```

`status` 只读本地脱敏状态和 launchd 状态，不请求 provider。

### `uninstall-launch-agent`

```bash
rtk tools/slate-quota-collector/.build/release/slate-quota-collector uninstall-launch-agent
```

成功输出：

```text
程序已卸载；钥匙串、配置、开关与历史状态已保留
```

它停止并删除两个 LaunchAgent、生成的 `.app`、稳定二进制和两个 plist；不删除钥匙串、配置、开关或 `snapshot-state.json`。

## 4. 菜单栏开关和运行语义

- 登录当前 macOS 用户后，菜单栏 App 由自己的 LaunchAgent 自动出现。
- “每 5 分钟自动采集”开关的状态会跨 App 重启、Mac 重启、注销和重新登录保留。
- 关闭时 collector LaunchAgent 会被 disable/bootout，但菜单栏仍在。关闭状态点“立即采集一次”仍会执行一轮，完成后开关仍为关闭。
- “立即采集一次”和自动调度共用同一把运行锁，不会并发覆盖。
- 点“退出菜单栏”只退出 UI，不修改开关，也不停止独立 collector LaunchAgent。下次登录时 UI 会再次出现。
- 锁屏不停止用户级 LaunchAgent；休眠、关机或注销期间暂停采集。唤醒后等待 launchd 后续调度，不补跑历史轮次。
- 安装器和验证程序不会擅自注销当前用户。如要验证“登录后自动出现”，由用户选择方便的时间手工注销并重新登录。
- 任一快照的 `source_collected_at` 超过 10 分钟时，再展示必须标记为 `stale`，不冒充当前数据。

## 5. 故障处理

### OpenCode Go 401

表示 Key 无效或未配置。画面显示“OPENCODE GO · 未配置”；重新执行 `setup` 并在本机无回显输入新 Key。不要把 Key 发到聊天。

### OpenCode Go 403

表示当前 Key 没有 Go 订阅权限。画面显示“OPENCODE GO · 无 Go 订阅”。先在 OpenCode 账户端确认订阅，不要把 403 当成 100% 剩余。

### Codex 未登录

必须以运行 LaunchAgent 的同一 macOS 用户完成 Codex / ChatGPT 登录。无可信旧数据时画面显示“CODEX · 未登录”；有旧数据时保留上次百分比并标记“数据过期”。采集器不读取、复制或上传 Codex 认证文件。

### Slate push 404

通常表示原内容已删除或 capability URL 已失效。404 是永久错误，当前轮不无限重试。在 Slate 重建“额度监控”内容，再重新执行 `setup` 存入新 URL。

### 两个数据源都失败

- 第一次同时失败：不推送，Slate 和设备保留原画面。
- 连续第二次同时失败：有 last-known-good 时推送双 provider “数据过期”；从未成功过时推送双 provider “无可信数据”。
- 任一 provider 恢复后，它立即回到当前数据，并清零对应连续失败计数。

## 6. capability URL 泄漏后的轮换

capability URL 同时是读写凭证，不能只修改本地文件来轮换。泄漏后：

1. 在 Slate 删除旧的“额度监控”内容，使旧 URL 失效。
2. 按本 README 的 Slate 步骤重建内容，重新粘贴模板和初始数据。
3. 复制新 capability URL，在本机重新执行 `setup` 无回显存入。
4. 运行 `collect --dry-run`，再运行 `collect --once` 与 `status`；确认新内容回读成功后才结束处理。
5. 检查 Slate/反向代理访问日志的读取权限，因为能看到 URL 即等同于拿到凭证。

## 7. 卸载后手工删除钥匙串

`uninstall-launch-agent` 故意保留凭据和历史，便于重装恢复。如果要完全删除两个凭据：

1. 打开 macOS “钥匙串访问” App，选择当前用户的“登录”钥匙串。
2. 搜索 service `com.yym8224961.slate-quota-collector`。
3. 核对并删除 account `opencode-go-api-key`。
4. 核对并删除 account `slate-push-url`。
5. 不要删除其他 service/account 的项目。

非敏感配置、开关和脱敏历史位于 `~/Library/Application Support/SlateQuotaCollector/`；若也要删除，应先确认不再需要 last-known-good，再由用户手工处理。

## 8. 不要混淆三个验收证明面

1. **服务器渲染成功**：Slate POST 完成渲染，服务器生成新的渲染时间和 ETag。这只证明服务器产物存在。
2. **Slate GET 回读一致**：采集器立即 GET 当前 Dashboard data，并与本轮归一化数据做强相等比较。这证明 Slate 存的数据正确，不证明设备已同步。
3. **真实 Note4 已显示**：只有 Note4 下一次同步后，实机屏幕实际出现新画面，才能证明设备显示成功。最终验收应分别记录服务器 ETag、设备同步时间和一张真实屏幕照片。

自动化测试通过不等于真实部署完成。只有真实 provider 只读请求、Slate 渲染与 GET 回读、双 LaunchAgent、菜单栏开关、两次约 5 分钟的自动采集和 Note4 实机显示都取得证明后，才能称为完成。

## 9. 本地分发边界

第一版 `.app` 只供生成它的当前 Mac 和当前用户本地安装。它没有 Developer ID 签名，没有公证，也不是面向其他 Mac 的分发包。不要复制这个 `.app` 到其他 Mac 直接运行；跨 Mac 分发需要另行完成签名、公证和升级机制。
