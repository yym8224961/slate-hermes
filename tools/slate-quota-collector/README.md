# Slate Codex 额度监控

这是当前 Mac 专用的 Codex 额度采集器和菜单栏 App。它每 5 分钟读取 Codex，再推送到对应的 Slate 内容。界面根据 [BarryBarrywu/codex-zectrix-dashboard](https://github.com/BarryBarrywu/codex-zectrix-dashboard) 移植。

当前本机运行范围是 Codex-only：采集器不读取 OpenCode Go API、不读取其钥匙串项、不生成 `opencode_go` 数据包，也不向旧 OpenCode Go Slate 内容推送。仓库中的旧模板和钥匙串配置仅为可恢复性保留。

## 数据来源和边界

- **Codex 额度**：通过当前用户已登录的 Codex App Server 调用 `account/rateLimits/read`，读取 5 小时/周期窗口及重置额度。不发送 prompt，不创建任务。
- **任务活动**：只读取 Codex 任务标题、父子关系和本机 session 中的生命周期事件。不保存或上传 prompt、response、reasoning、工具输出或项目路径。
- **重置雷达**：最多每小时查询一次 `https://codex-resets.com/api/v1/status`，只保留“最新确认/活跃预测/概率/有效时间”等展示语义。这是第三方公开信号，不是 OpenAI 官方承诺，也不代表某个账户一定会在该时间重置。
- **Slate**：只向使用者自己填入的 capability URL 推送脱敏 Dashboard data。推送后会 GET 回读并校验本轮数据一致性。

capability URL 是可读写凭据，不要发到聊天、写进 shell history 或普通配置文件。`setup` 会在本机终端无回显读取，并存入 macOS 钥匙串。

## 使用前准备

- macOS 13 或更高版本；
- Swift 6.2；
- 当前 macOS 用户已在 Codex / ChatGPT 登录，且终端能找到 `codex`；
- Slate 中新建“外部数据”后生成的 capability URL。

## 1. 构建 release 版本

在仓库根目录执行：

```bash
rtk swift build --package-path tools/slate-quota-collector -c release
```

后续命令使用：

```text
tools/slate-quota-collector/.build/release/slate-quota-collector
```

## 2. 在 Slate 创建 Codex 画面

1. 进入目标内容组，新建“外部数据”。
2. 帧名称填“Codex 额度”。
3. 模板选“自定义模板”，粘贴 [`templates/slate-dashboard-template.json`](templates/slate-dashboard-template.json) 的完整内容。
4. 把 [`templates/initial-data.json`](templates/initial-data.json) 的完整内容粘贴到初始数据。
5. 刷新间隔选“5 分钟”。Slate 的刷新负责设备同步，Mac 采集器也由独立的 5 分钟调度器运行。
6. 创建完成后复制 Slate 生成的 capability URL，只在下一步无回显输入。

模板是 400 × 300、1bpp，并显式启用 `canvas: "full"`：Codex 额度画面从 `y=0` 开始占满墨水屏，设备状态栏不会再覆盖顶部内容，底部也只保留上游原版需要的少量呼吸空间。普通 Slate 模板仍使用默认的 `canvas: "content"` 并保留 24px 状态栏。单额度窗口和双额度窗口都有独立布局分支。

完整画布需要配套使用包含 `device_full_canvas` 支持的新固件；旧固件仍会在顶部绘制状态栏。

## 3. 配置、试运行和安装

下面示例使用 release 二进制的完整路径。

### `setup`

```bash
rtk tools/slate-quota-collector/.build/release/slate-quota-collector setup
```

这一步必须由当前 Mac 用户在真实终端执行。程序只会要求输入两遍 Slate 推送 URL，输入不显示字符。它会先做 Codex 只读额度预检，再将 Slate URL 存入钥匙串。成功输出：

```text
配置完成，只读预检通过
```

### `collect --dry-run`

```bash
rtk tools/slate-quota-collector/.build/release/slate-quota-collector collect --dry-run
```

成功时只输出一份 Codex 脱敏 JSON envelope，不向 Slate POST，且数据中不出现 `opencode_go`。

### `collect --once`

```bash
rtk tools/slate-quota-collector/.build/release/slate-quota-collector collect --once
```

成功时输出一行脱敏证明：

```text
推送成功：id=redacted image_etag=redacted manifest_etag=redacted rendered_at=[实际 ISO 8601 时间] readback_verified=true schema_version=1 codex_status=[实际状态]
```

这表示 Slate GET 回读已与本轮归一化 data 强相等。`id` 和 ETag 固定显示为 `redacted`；不会输出 capability URL、认证信息或上游原始正文。

### `install-launch-agent`

```bash
rtk tools/slate-quota-collector/.build/release/slate-quota-collector install-launch-agent
```

这会安装 `~/Applications/Slate 额度监控.app` 和两个用户级调度项：

- `com.yym8224961.slate-quota-menubar`：登录后自动显示菜单栏 App，无 Dock 图标；
- `com.yym8224961.slate-quota-collector`：安装后立即采集一次，之后每 300 秒调度。

成功输出：

```text
菜单栏与自动采集已安装
```

## 4. 菜单栏开关

- 菜单栏显示 Codex 额度摘要、重置雷达状态和最后推送时间。
- “每 5 分钟自动采集”是可点击开关，状态会跨 App 重启、Mac 重启、注销和重新登录保留。
- 关闭时只停止定时采集；菜单栏依然存在，Slate 当前画面、配置、钥匙串和脱敏缓存都保留。
- 关闭状态下点“立即采集一次”仍会执行一轮，完成后自动开关仍为关闭。
- “立即采集一次”和自动调度共用一把运行锁，不会并发覆盖。
- 点“退出菜单栏”只退出 UI，不会修改开关或停止独立定时采集。

同样可以使用命令行切换：

```bash
rtk tools/slate-quota-collector/.build/release/slate-quota-collector pause
rtk tools/slate-quota-collector/.build/release/slate-quota-collector resume
```

## 5. 查看状态

```bash
rtk tools/slate-quota-collector/.build/release/slate-quota-collector status
```

输出固定为八行：

```text
自动采集：[已开启/已关闭]
菜单栏：[已加载/未加载]
定时采集：[已加载/未加载]
Codex：[脱敏额度摘要]
重置雷达：[脱敏公开信号摘要]
最近成功：[时间/尚无记录]
最近推送：[时间/尚无记录]
错误码：[无/脱敏错误码]
```

`status` 只读本地脱敏快照和调度状态，不请求 Codex、重置雷达或 Slate。

## 6. 故障处理

### `codex_invalid_response`

表示当前 `codex app-server` 响应与采集器支持的限额结构不符。先确认运行调度器的同一 macOS 用户已登录 Codex，再升级 Codex 客户端并重试。错误输出不会包含 App Server 原始正文。

### `slate_endpoint_invalid`

应填写 Slate 在“外部数据”创建完成后生成的 **capability URL**，不是 Slate 首页、NAS 地址或普通页面 URL。该 URL 必须保持创建时的完整形式。

### 重置雷达失效

采集器会显示“雷达信号丢失”，但仍继续采集并推送 Codex 额度和任务状态。如果之前的预测或确认还在自身有效期内，会保留为旧信号；不会把网络失败误报成新的“暂无预测”。

### Slate push 404

通常表示原内容已删除或 capability URL 已失效。在 Slate 重建对应的“外部数据”，然后重新执行 `setup`。

## 7. 轮换 Slate URL

capability URL 泄漏后：

1. 在 Slate 删除旧“外部数据”内容，使旧 URL 失效。
2. 重建内容并粘贴最新模板与初始数据。
3. 重新执行 `setup`，无回显输入 Codex 内容的新 URL。
4. 运行 `collect --dry-run`、`collect --once` 和 `status`，确认新内容回读成功。

## 8. 卸载

```bash
rtk tools/slate-quota-collector/.build/release/slate-quota-collector uninstall-launch-agent
```

这会停止并删除两个调度项、生成的 `.app`、稳定二进制和 plist；不删除钥匙串、配置、开关或脱敏历史。

当前程序只使用 account `slate-push-url`。旧的 `slate-opencode-go-push-url` 和 `opencode-go-api-key` 为可恢复性保留，不会被读取；如果以后明确不需要恢复，可在 macOS“钥匙串访问”中手工核对后删除。

## 9. 验收边界

1. **服务器渲染成功**：Slate POST 生成新的渲染时间和 ETag。
2. **Slate GET 回读一致**：采集器回读 Dashboard data 并确认强相等。
3. **真实 Note4 已显示**：只有设备下一次同步后屏幕实际出现新画面，才能证明实机显示成功。

自动化测试通过不等于真实部署完成。最终验收应分别保留 Slate 回读证明、两次间隔约 5 分钟的自动采集记录、菜单栏开关记录和 Note4 实机照片。

## 10. 第三方授权

界面结构、文案、重置雷达语义和任务归并规则移植自 `codex-zectrix-dashboard`。完整 MIT 声明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 11. 本地分发边界

第一版 `.app` 只供生成它的当前 Mac 和当前用户本地安装。它没有 Developer ID 签名、公证和自动升级机制，不应直接复制到其他 Mac 作为分发包。
