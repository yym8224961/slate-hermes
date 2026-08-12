# Codex × OpenCode Go 额度监控实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前 Mac 上交付一个带登录自启菜单栏开关的原生应用，每 5 分钟采集 Codex 与 OpenCode Go 官方额度数据、统一为剩余额度并安全推送到 Slate 自定义 Dashboard。

**Architecture:** 新工具作为独立 Swift Package 放在 `tools/slate-quota-collector/`，同一个可执行文件同时提供短生命周期 collector、AppKit 菜单栏入口和 CLI；菜单栏与定时采集由两个独立用户级 LaunchAgent 管理。小型协议隔离 Codex JSON-RPC、OpenCode HTTPS、钥匙串、文件缓存、Slate ingest、持久开关和 launchctl；纯函数归一化与失败决策先用单元测试固定，再接入真实传输，Slate 模板继续由现有 TypeScript schema 和 1bpp renderer 验证。

**Tech Stack:** Swift 6.2、Swift Package Manager、Foundation、Security、Darwin、AppKit、macOS 13+、Bun test、现有 Slate `DashboardTemplate`/`DynamicFrameRendererService`。

## Global Constraints

- 目标设备固定为 ZecTrix Note4：400 × 300、1bpp、15000 bytes，正文只能使用 y=24..299。
- 最终 A5 模板保持 17 个 block、16px 文本、14px progress、Codex 上/OpenCode Go 下、底部 block 的 `y + h = 300`。
- 所有额度条表达“剩余额度”；`remaining = clamp(100 - used, 0, 100)`，显示整数采用向下取整，不能高估剩余量。
- Codex 只调用同一 macOS 用户的 `codex app-server --stdio` 和 `account/rateLimits/read`；不得读取或复制 `~/.codex/auth.json`，不得创建 thread、发送 prompt 或发起模型请求。
- Codex 只认 `rateLimitsByLimitId.codex`，或 `rateLimits.limitId == "codex"` 的回退值；用 `windowDurationMins == 300/10080` 识别 5 小时/周，不混入 `codex_bengalfox`。
- OpenCode Go 只调用 `GET https://opencode.ai/zen/go/v1/usage`，未知状态、缺字段、非 JSON 与 HTTP 错误全部 fail closed。
- OpenCode Go Key 与完整 Slate capability URL 只存在当前用户登录钥匙串；不得出现在参数、plist、配置、缓存、日志或测试快照中。
- `snapshot-state.json` 以一个原子状态包同时保存已归一化、可公开展示的 provider 快照，以及跨进程失败计数、最近成功/推送时间和脱敏错误码；两部分不会出现跨文件的部分提交。
- 自动采集开关只写入 0600 的 `settings.json`，字段严格为 `schema_version` 和 `automatic_collection_enabled`；手动采集不受开关限制。
- 菜单栏 App 固定安装为 `~/Applications/Slate 额度监控.app`，`LSUIElement=true`，不显示 Dock 图标，并在当前用户登录后自动出现。
- 菜单栏与 collector 使用独立 label：`com.yym8224961.slate-quota-menubar` 和 `com.yym8224961.slate-quota-collector`；关闭 collector 不影响菜单栏。
- collector launchd 固定 `RunAtLoad=true`、`StartInterval=300`；Codex/OpenCode/Slate/整轮超时固定为 20/10/15/45 秒。
- 关闭自动采集先持久写 false，再等待当前锁最多 45 秒后 bootout；恢复时立即采集一次再按 300 秒运行。
- “退出菜单栏”只关闭 UI，不改变自动采集；“立即采集一次”在关闭状态仍可用并争用同一把运行锁。
- 第一版只生成当前用户本机使用的 `.app`，不增加 Developer ID 签名、公证、App Store 或跨 Mac 更新机制。
- 同一轮并发读取两个 provider，随后串行执行决策、缓存和推送；进程锁阻止旧快照覆盖新快照。
- HTTP Slate URL 只允许 localhost、`.local` 或 RFC1918/链路本地地址；其他地址必须使用 HTTPS。
- 不修改 Prisma/MySQL、固件、Hermes、现有认证或 Slate capability 鉴权；当前工作区这些区域的未提交改动全部视为用户所有。
- 所有实现步骤遵循 TDD：先看到目标测试因缺少行为而失败，再写最小实现并跑绿。

---

## 文件与职责

```text
tools/slate-quota-collector/
├── Package.swift                                      # Swift 6 可执行 target 与 test target
├── Sources/SlateQuotaCollector/
│   ├── Command.swift                                  # @main、命令解析和用户可见输出
│   ├── Models.swift                                   # 原始/归一化/推送 Codable 值类型
│   ├── Configuration.swift                            # 非敏感配置、固定路径与原子 JSON 文件
│   ├── QuotaNormalizer.swift                          # 窗口识别、剩余量、阈值、时间和文案
│   ├── CodexRateLimitClient.swift                     # JSON-RPC 编解码与官方 app-server 客户端
│   ├── CodexAppServerTransport.swift                  # 短进程 stdio、超时、正常终止
│   ├── OpenCodeGoUsageClient.swift                    # 官方 usage HTTPS 客户端
│   ├── KeychainStore.swift                            # Security.framework secret 读写
│   ├── RedactingLogger.swift                          # 脱敏错误码和日志输出
│   ├── SanitizedSnapshotCache.swift                   # last-good 与 runtime-state 单包原子持久化
│   ├── FailurePolicy.swift                            # 单源/双源失败、stale、恢复决策
│   ├── RunLock.swift                                  # O_EXCL 锁、PID 存活与陈旧锁恢复
│   ├── SlateIngestClient.swift                        # endpoint 校验、POST、一次短重试
│   ├── CollectorService.swift                         # 并发采集、45 秒协作式 deadline、缓存与推送编排
│   ├── CollectorProcessSupervisor.swift               # Task 12 独立 worker 的 45 秒 wall-clock 硬上限
│   ├── SettingsStore.swift                            # settings.json 严格 schema 与 0600 原子写
│   ├── CollectionScheduleController.swift             # pause/resume、双 job 状态和 scheduled gate
│   ├── MenuBarViewModel.swift                         # 脱敏状态到菜单文案/图标的纯映射
│   ├── MenuBarController.swift                        # NSStatusItem、NSMenu 与异步 action
│   ├── StatusWindowController.swift                   # 原生详细状态小窗口
│   ├── AppBundleInstaller.swift                       # .app/Info.plist/LSUIElement 生成
│   └── LaunchAgentInstaller.swift                     # 双 plist、bootstrap/bootout/status
├── Tests/SlateQuotaCollectorTests/
│   ├── ModelsAndConfigurationTests.swift
│   ├── TestSupport.swift
│   ├── QuotaNormalizerTests.swift
│   ├── CodexRateLimitClientTests.swift
│   ├── CodexAppServerTransportTests.swift
│   ├── OpenCodeGoUsageClientTests.swift
│   ├── SecretCacheAndLoggingTests.swift
│   ├── FailurePolicyTests.swift
│   ├── RunLockTests.swift
│   ├── SlateIngestClientTests.swift
│   ├── CollectorServiceTests.swift
│   ├── CollectionScheduleControllerTests.swift
│   ├── MenuBarViewModelTests.swift
│   ├── MenuBarControllerTests.swift
│   ├── AppBundleInstallerTests.swift
│   └── LaunchAgentInstallerTests.swift
├── Resources/
│   ├── Info.plist.template
│   ├── com.yym8224961.slate-quota-collector.plist.template
│   └── com.yym8224961.slate-quota-menubar.plist.template
├── templates/
│   ├── slate-dashboard-template.json
│   └── initial-data.json
└── README.md

shared/src/dynamic/slate-quota-template.test.ts         # JSON schema/坐标/绑定契约
backend/src/modules/dynamic-content/rendering/
└── slate-quota-dashboard.test.ts                       # 多状态 400×300 1bpp 渲染回归
```

核心接口在任务 1 固定；后续任务不得另造同义类型：

```swift
protocol CodexRateLimitReading: Sendable {
    func read() async throws -> CodexRateLimitsReadResult
}

protocol OpenCodeGoUsageReading: Sendable {
    func read(apiKey: String) async throws -> OpenCodeGoUsageResponse
}

protocol SecretStoring: Sendable {
    func read(account: String) throws -> String
    func write(_ value: String, account: String) throws
}

protocol SlateIngesting: Sendable {
    func push(_ envelope: SlateEnvelope, capabilityURL: URL) async throws -> SlateIngestReceipt
    func readCurrentData(capabilityURL: URL) async throws -> SlateDashboardData
}

protocol SnapshotPersisting: Sendable {
    func loadSnapshot() throws -> CollectorSnapshot
    func saveSnapshot(_ value: CollectorSnapshot) throws
}

```

所有 Swift 测试文件都用与文件同名的 `@Suite struct` 包裹，因此计划中的 `swift test --filter <文件名>` 可稳定命中。代码片段中的 `.fixture`、`.fixtureNow`、`TemporaryDirectory` 和基础 JSON 数据由 `Tests/SlateQuotaCollectorTests/TestSupport.swift` 提供；某个 transport 特有的记录器则定义在首次使用它的测试文件底部，后续测试直接复用，不复制实现。

### Task 1: Swift Package、领域模型与非敏感配置

**Files:**
- Create: `tools/slate-quota-collector/Package.swift`
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/Models.swift`
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/Configuration.swift`
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/Command.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/ModelsAndConfigurationTests.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/TestSupport.swift`

**Interfaces:**
- Consumes: Foundation `Codable`, `Date`, `URL`, `FileManager`。
- Produces: 原始 DTO、`ProviderStatus`、`QuotaWindow`、`CodexDisplaySnapshot`、`OpenCodeGoDisplaySnapshot`、`SlateDashboardData`、`SlateEnvelope`、`CollectorConfiguration`、数据访问五个核心协议；`CollectionScheduleControlling` 在 Task 10 实现。

- [ ] **Step 1: 写领域模型和配置的失败测试**

```swift
import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite struct ModelsAndConfigurationTests {

@Test func envelopeUsesSlateSnakeCaseKeys() throws {
    let data = SlateDashboardData.fixture(generatedAt: Date(timeIntervalSince1970: 0))
    let encoded = try JSONEncoder.slate.encode(SlateEnvelope(data: data))
    let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    #expect(json["version"] as? Int == 1)
    let body = try #require(json["data"] as? [String: Any])
    #expect(body["schema_version"] as? Int == 1)
    #expect(body["opencode_go"] != nil)
}

@Test func configurationRejectsSecretFields() throws {
    let bytes = Data(#"{"schemaVersion":1,"codexExecutablePath":"/usr/local/bin/codex","timezoneIdentifier":"Asia/Shanghai","opencodeGoApiKey":"secret"}"#.utf8)
    #expect(throws: ConfigurationError.self) {
        try CollectorConfiguration.decodeStrict(bytes)
    }
}

@Test func configurationStoreWritesOwnerOnlyFile() throws {
    let root = try TemporaryDirectory()
    let store = ConfigurationStore(applicationSupportURL: root.url)
    try store.save(.fixture)
    let mode = try store.fileMode(at: store.configurationURL)
    #expect(mode & 0o077 == 0)
}
}
```

- [ ] **Step 2: 运行测试并确认因 package/类型不存在而失败**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter ModelsAndConfigurationTests`

Expected: FAIL，报告 `Package.swift`、`SlateDashboardData` 或 `CollectorConfiguration` 尚不存在。

- [ ] **Step 3: 建立无外部依赖的 Swift 6 package**

```swift
// tools/slate-quota-collector/Package.swift
// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "SlateQuotaCollector",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "slate-quota-collector", targets: ["SlateQuotaCollector"])],
    targets: [
        .executableTarget(
            name: "SlateQuotaCollector",
            path: "Sources/SlateQuotaCollector",
            linkerSettings: [.linkedFramework("Security"), .linkedFramework("AppKit")]
        ),
        .testTarget(
            name: "SlateQuotaCollectorTests",
            dependencies: ["SlateQuotaCollector"],
            path: "Tests/SlateQuotaCollectorTests"
        ),
    ]
)
```

- [ ] **Step 4: 实现稳定 JSON 契约和严格配置解码**

```swift
enum ProviderStatus: String, Codable, Sendable {
    case ok, attention, critical, exhausted, stale
    case unauthenticated, unconfigured, unavailable
}

enum ProviderFailure: Error, Equatable, Sendable {
    case timeout
    case unauthenticated
    case unconfigured
    case subscriptionRequired
    case rateLimited
    case server
    case invalidData
    case transport(publicCode: String)
}

struct QuotaWindow: Codable, Equatable, Sendable {
    let label: String
    let remainingPercent: Int
    let valueText: String
    let resetAt: Date?
}

struct SlateEnvelope: Codable, Equatable, Sendable {
    let version = 1
    let data: SlateDashboardData
}

struct CodexRateLimitWindow: Codable, Equatable, Sendable {
    let usedPercent: Double
    let windowDurationMins: Int
    let resetsAt: TimeInterval?
}

struct CodexRateLimit: Codable, Equatable, Sendable {
    let limitId: String?
    let primary: CodexRateLimitWindow?
    let secondary: CodexRateLimitWindow?
}

struct CodexCredits: Codable, Equatable, Sendable {
    let unlimited: Bool
    let balance: Double?
}

struct CodexRateLimitsReadResult: Codable, Equatable, Sendable {
    let rateLimits: CodexRateLimit?
    let rateLimitsByLimitId: [String: CodexRateLimit]
    let credits: CodexCredits?
    let planType: String?
    var selectedCodexLimit: CodexRateLimit? {
        rateLimitsByLimitId["codex"] ?? (rateLimits?.limitId == "codex" ? rateLimits : nil)
    }
}

struct OpenCodeGoUsageResponse: Codable, Equatable, Sendable {
    let useBalance: Bool
    let rollingUsage: OpenCodeGoUsageWindow
    let weeklyUsage: OpenCodeGoUsageWindow
    let monthlyUsage: OpenCodeGoUsageWindow
}

struct OpenCodeGoUsageWindow: Codable, Equatable, Sendable {
    enum Status: String, Codable, Sendable { case ok, rateLimited = "rate-limited" }
    let status: Status
    let resetInSec: Double
    let usagePercent: Double
}

struct CollectorConfiguration: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let codexExecutablePath: String
    let timezoneIdentifier: String
    let codexTimeoutSeconds: Int
    let openCodeTimeoutSeconds: Int
    let slateTimeoutSeconds: Int
    let overallTimeoutSeconds: Int
    let logLevel: String
    let keychainService: String
    let openCodeKeyAccount: String
    let slateURLAccount: String
}
```

`SlateDashboardData.CodingKeys` 必须显式把 `opencodeGo` 写成 `opencode_go`；其他字段由 `.convertToSnakeCase` 处理。`JSONEncoder.slate` 使用 ISO-8601 日期；`decodeStrict` 先用 `JSONSerialization` 拒绝允许集合外的顶层 key，再检查 schema=1、时区存在、四个超时严格等于 20/10/15/45。为保持已批准配置 schema，`overallTimeoutSeconds` 键名保留，但其语义是 Task 9 的协作式 collection deadline；Task 12 的 worker 监督器另行强制相同 45 秒 wall-clock 硬上限。`CodexCredits.balance` 用自定义解码同时接受 JSON number 和十进制字符串，但拒绝非有限数。`ConfigurationStore` 固定使用 `~/Library/Application Support/SlateQuotaCollector/config.json`，临时文件写完、`chmod 0600` 后原子替换。

- [ ] **Step 5: 加入仅能显示帮助的命令入口并跑绿**

```swift
@main
enum Command {
    static func main() async {
        if CommandLine.arguments.dropFirst().first == "--help" {
            print("slate-quota-collector setup|collect|pause|resume|install-launch-agent|status|uninstall-launch-agent")
            return
        }
        print("尚未选择命令；使用 --help 查看用法")
    }
}
```

Run: `rtk swift test --package-path tools/slate-quota-collector --filter ModelsAndConfigurationTests`

Expected: PASS；配置 JSON 中没有 API Key 或 Slate URL 字段，文件权限断言通过。

- [ ] **Step 6: 提交 package 和领域契约**

```bash
rtk git add tools/slate-quota-collector/Package.swift tools/slate-quota-collector/Sources/SlateQuotaCollector/Models.swift tools/slate-quota-collector/Sources/SlateQuotaCollector/Configuration.swift tools/slate-quota-collector/Sources/SlateQuotaCollector/Command.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/ModelsAndConfigurationTests.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/TestSupport.swift
rtk git commit -m "feat(quota): 建立采集器领域契约"
```

### Task 2: 纯函数额度归一化

**Files:**
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/QuotaNormalizer.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/QuotaNormalizerTests.swift`

**Interfaces:**
- Consumes: `CodexRateLimitsReadResult`、`OpenCodeGoUsageResponse`、`ProviderStatus` 和 Task 1 的展示模型。
- Produces: `QuotaNormalizer.codex(_:collectedAt:)`、`QuotaNormalizer.openCodeGo(_:collectedAt:)`、`QuotaNormalizer.staleCodex(from:now:)`、`QuotaNormalizer.staleOpenCodeGo(from:now:)`。

- [ ] **Step 1: 写窗口识别、阈值和时间的失败测试**

```swift
@Test func codexIdentifiesWindowsByDurationAndIgnoresSpark() throws {
    let raw = CodexRateLimitsReadResult.fixture(
        planType: "prolite",
        codexWindows: [.init(usedPercent: 9, windowDurationMins: 10_080, resetsAt: 1_787_090_794)],
        extraLimits: ["codex_bengalfox": .fixture(usedPercent: 99, duration: 300)]
    )
    let value = QuotaNormalizer.shanghai.codex(raw, collectedAt: .fixtureNow)
    #expect(value.rolling.valueText == "未提供")
    #expect(value.rolling.remainingPercent == 0)
    #expect(value.weekly.remainingPercent == 91)
    #expect(value.headerLeft == "CODEX · PROLITE")
}

@Test(arguments: [(79.0, "最低剩余 21%"), (80.0, "注意 · 剩余 20%"), (90.0, "注意 · 剩余 10%"), (91.0, "紧急 · 剩余 9%"), (99.0, "紧急 · 剩余 1%"), (100.0, "已耗尽")])
func remainingThresholds(used: Double, summary: String) {
    #expect(QuotaNormalizer.summary(forUsedPercent: used, serverLimited: false) == summary)
}

@Test func openCodeUsesReceiveTimeForAllThreeResets() throws {
    let raw = OpenCodeGoUsageResponse.fixture(rollingReset: 3600, weeklyReset: 7200, monthlyReset: 10_800)
    let value = QuotaNormalizer.shanghai.openCodeGo(raw, collectedAt: .fixtureNow)
    #expect(value.rolling.resetAt == .fixtureNow.addingTimeInterval(3600))
    #expect(value.footerLeft == "下次重置 08-12 17:30")
}

@Test func serverLimitedWinsOverNonzeroRoundedRemaining() {
    #expect(QuotaNormalizer.summary(forUsedPercent: 99.1, serverLimited: true) == "已耗尽")
}
```

- [ ] **Step 2: 运行测试并确认归一化器不存在**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter QuotaNormalizerTests`

Expected: FAIL，报告 `QuotaNormalizer` 未定义。

- [ ] **Step 3: 实现唯一的数值、文案与时间转换入口**

```swift
struct QuotaNormalizer: Sendable {
    let timeZone: TimeZone

    func remaining(_ used: Double) -> Int {
        Int(floor(max(0, min(100, 100 - used))))
    }

    static func status(remaining: Int, serverLimited: Bool) -> ProviderStatus {
        if serverLimited || remaining == 0 { return .exhausted }
        if remaining <= 9 { return .critical }
        if remaining <= 20 { return .attention }
        return .ok
    }

    static func summary(remaining: Int, serverLimited: Bool) -> String {
        switch status(remaining: remaining, serverLimited: serverLimited) {
        case .exhausted: return "已耗尽"
        case .critical: return "紧急 · 剩余 \(remaining)%"
        case .attention: return "注意 · 剩余 \(remaining)%"
        default: return "最低剩余 \(remaining)%"
        }
    }

    static func summary(forUsedPercent used: Double, serverLimited: Bool) -> String {
        let remaining = Int(floor(max(0, min(100, 100 - used))))
        return summary(remaining: remaining, serverLimited: serverLimited)
    }
}
```

Codex 从选中的 `codex` limit 的 primary/secondary 合并后按 `windowDurationMins` 建字典；缺 300/10080 的窗口生成 `remainingPercent=0,valueText="未提供",resetAt=nil`。服务摘要只在已提供的窗口中取最小值；没有窗口时返回 `status=.unavailable, summaryLabel="无可信数据"`，不能返回“已耗尽”。OpenCode 三个窗口任一未知 status 或缺字段时抛出解码错误，不产生部分假数据。

- [ ] **Step 4: 覆盖 Credits 和余额接续文案**

```swift
#expect(normalizeCredits(.init(unlimited: true, balance: nil)) == "Credits 无限")
#expect(normalizeCredits(.init(unlimited: false, balance: 128.5)) == "Credits 128.50")
#expect(normalizeCredits(nil) == "Credits —")
#expect(normalizeUseBalance(true) == "余额接续 开启")
#expect(normalizeUseBalance(false) == "余额接续 关闭")
```

Run: `rtk swift test --package-path tools/slate-quota-collector --filter QuotaNormalizerTests`

Expected: PASS，21/20/10/9/1/0 边界、跨日/跨月日期和缺失窗口全部通过。

- [ ] **Step 5: 提交归一化器**

```bash
rtk git add tools/slate-quota-collector/Sources/SlateQuotaCollector/QuotaNormalizer.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/QuotaNormalizerTests.swift
rtk git commit -m "feat(quota): 归一化双服务剩余额度"
```

### Task 3: Codex 官方 JSON-RPC 客户端

**Files:**
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/CodexRateLimitClient.swift`
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/CodexAppServerTransport.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/CodexRateLimitClientTests.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/CodexAppServerTransportTests.swift`

**Interfaces:**
- Consumes: `CollectorConfiguration.codexExecutablePath` 和 20 秒超时。
- Produces: `CodexRateLimitReading` 的生产实现、Task 1 原始 DTO 的 JSON-RPC 解码、`CodexAppServerTransport.request(executableURL:lines:responseID:timeout:)`。

- [ ] **Step 1: 写精确握手与响应选择的失败测试**

```swift
@Test func clientSendsOnlyInitializationAndRateLimitRead() async throws {
    let transport = RecordingCodexTransport(response: .fixtureJSONRPC)
    let client = CodexRateLimitClient(executableURL: URL(fileURLWithPath: "/usr/bin/codex"), transport: transport)
    _ = try await client.read()
    #expect(await transport.methods == ["initialize", "initialized", "account/rateLimits/read"])
    #expect(await transport.responseID == 2)
    #expect(await transport.joinedInput.contains("thread/start") == false)
    #expect(await transport.joinedInput.contains("prompt") == false)
}

@Test func decoderPrefersNamedCodexLimit() throws {
    let result = try CodexRateLimitClient.decode(Self.namedAndFallbackFixture)
    #expect(result.selectedCodexLimit?.limitId == "codex")
    #expect(result.selectedCodexLimit?.primary?.windowDurationMins == 10_080)
}

@Test func decoderRejectsFallbackForAnotherLimit() throws {
    let result = try CodexRateLimitClient.decode(Self.sparkOnlyFixture)
    #expect(result.selectedCodexLimit == nil)
}
```

- [ ] **Step 2: 运行测试并确认客户端不存在**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter CodexRateLimitClientTests`

Expected: FAIL，报告 `CodexRateLimitClient` 未定义。

- [ ] **Step 3: 实现固定 JSONL 消息和宽容的通知过滤**

```swift
let lines = [
    #"{"method":"initialize","id":1,"params":{"clientInfo":{"name":"slate_quota_collector","title":"Slate quota collector","version":"1.0.0"}}}"#,
    #"{"method":"initialized","params":{}}"#,
    #"{"method":"account/rateLimits/read","id":2,"params":{}}"#,
].map { Data(($0 + "\n").utf8) }
```

只解码 `id == 2` 的对象；忽略初始化响应、`account/rateLimits/updated` 通知和不相关 stdout 行。若 id=2 含 `error`，抛出只保留 JSON-RPC code 的 `CodexClientError.rpc(code:)`；不得把 error message/data 写入日志。

- [ ] **Step 4: 实现短生命周期 Process 传输并用假可执行文件测试**

```swift
protocol CodexAppServerTransport: Sendable {
    func request(
        executableURL: URL,
        lines: [Data],
        responseID: Int,
        timeout: Duration
    ) async throws -> Data
}
```

生产实现用 `Process` 参数 `app-server --stdio`，stdout/stderr 分别异步排空，写完三行后关闭 stdin；读到 id=2 后先 `terminate()`，1 秒后仍运行才 `kill(SIGKILL)`。20 秒未读到目标响应抛 `CodexClientError.timeout`。测试在临时目录写一个可执行 shell fixture：读取三行、stderr 输出模型目录警告、stdout 输出通知和 id=2 响应；断言警告不导致失败、目标响应可解码、超时会结束子进程。

Run: `rtk swift test --package-path tools/slate-quota-collector --filter Codex`

Expected: PASS；fixture 捕获到的输入只有三条固定消息，stderr 警告被排空但不外泄。

- [ ] **Step 5: 提交 Codex 适配器**

```bash
rtk git add tools/slate-quota-collector/Sources/SlateQuotaCollector/CodexRateLimitClient.swift tools/slate-quota-collector/Sources/SlateQuotaCollector/CodexAppServerTransport.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/CodexRateLimitClientTests.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/CodexAppServerTransportTests.swift
rtk git commit -m "feat(quota): 读取 Codex 官方限额接口"
```

### Task 4: OpenCode Go 官方 HTTPS 客户端

**Files:**
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/OpenCodeGoUsageClient.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/OpenCodeGoUsageClientTests.swift`
- Modify: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/TestSupport.swift`

**Interfaces:**
- Consumes: Keychain 提供的 API Key、10 秒请求超时。
- Produces: `OpenCodeGoUsageReading` 的生产实现、Task 1 原始 DTO 的 HTTPS 解码、`HTTPTransport`、可脱敏的 `OpenCodeGoClientError.code`。

- [ ] **Step 1: 写请求和严格响应的失败测试**

```swift
@Test func requestUsesOfficialEndpointAndBearerHeader() async throws {
    let transport = RecordingHTTPTransport(status: 200, body: Self.validUsage)
    _ = try await OpenCodeGoUsageClient(transport: transport).read(apiKey: "test-go-secret")
    let request = try #require(await transport.lastRequest)
    #expect(request.url?.absoluteString == "https://opencode.ai/zen/go/v1/usage")
    #expect(request.httpMethod == "GET")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-go-secret")
}

@Test(arguments: [(401, "unauthorized"), (403, "subscription_required"), (429, "rate_limited"), (500, "server_error")])
func mapsStatusWithoutBody(status: Int, code: String) async {
    let client = OpenCodeGoUsageClient(transport: StubHTTPTransport(status: status, body: Data("private body".utf8)))
    do {
        _ = try await client.read(apiKey: "secret")
        Issue.record("expected OpenCodeGoClientError")
    } catch let error as OpenCodeGoClientError {
        #expect(error.publicCode == code)
    } catch {
        Issue.record("unexpected error type")
    }
}

@Test func rejectsMissingMonthlyWindowAndUnknownStatus() async {
    await #expect(throws: DecodingError.self) {
        try await OpenCodeGoUsageClient(transport: StubHTTPTransport(status: 200, body: Self.invalidUsage)).read(apiKey: "secret")
    }
}
```

- [ ] **Step 2: 运行测试并确认 HTTP 客户端不存在**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter OpenCodeGoUsageClientTests`

Expected: FAIL，报告 `OpenCodeGoUsageClient` 未定义。

- [ ] **Step 3: 实现 URLSession 传输与状态码映射**

```swift
protocol HTTPTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

var request = URLRequest(url: URL(string: "https://opencode.ai/zen/go/v1/usage")!)
request.httpMethod = "GET"
request.timeoutInterval = 10
request.setValue("application/json", forHTTPHeaderField: "Accept")
request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
let (data, response) = try await transport.data(for: request)
```

在 `TestSupport.swift` 增加可跨测试文件复用的 `actor RecordingHTTPTransport: HTTPTransport`，记录 request 队列、按顺序返回状态/body 或抛出 `URLError`；Task 7 直接复用它验证 Slate POST/GET，不再定义第二份 HTTP fake。

请求设置 `timeoutInterval=10`、`Accept: application/json`、Bearer header。200 才解码；401/403/429/5xx 映射固定公开错误码且丢弃 body；其他状态映射 `http_<status>`。`resetInSec` 必须非负有限数，`usagePercent` 必须是有限数，额外 JSON 字段允许存在。

- [ ] **Step 4: 跑完成功、超时、非 JSON、缺字段和新增字段测试**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter OpenCodeGoUsageClientTests`

Expected: PASS；测试覆盖三窗口、单窗口 rate-limited、401、403、429、5xx、超时、非 JSON、缺字段、未知 status 和额外字段。

- [ ] **Step 5: 提交 OpenCode Go 适配器**

```bash
rtk git add tools/slate-quota-collector/Sources/SlateQuotaCollector/OpenCodeGoUsageClient.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/OpenCodeGoUsageClientTests.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/TestSupport.swift
rtk git commit -m "feat(quota): 读取 OpenCode Go 官方用量接口"
```

### Task 5: 钥匙串、脱敏日志与本地状态存储

**Files:**
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/KeychainStore.swift`
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/RedactingLogger.swift`
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/SanitizedSnapshotCache.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/SecretCacheAndLoggingTests.swift`

**Interfaces:**
- Consumes: Task 1 的 `SecretStoring`、provider 展示模型和固定 Application Support 路径。
- Produces: `KeychainStore`、`RedactingLogger`、`SnapshotPersisting`、`SanitizedLastGood`、`CollectorRuntimeState`。

- [ ] **Step 1: 写 secret 不落盘、不进日志的失败测试**

```swift
@Test func keychainRoundTripUsesServiceAndAccount() throws {
    let backend = RecordingKeychainBackend()
    let store = KeychainStore(service: "com.yym8224961.slate-quota-collector", backend: backend)
    try store.write("go-test-secret", account: "opencode-go-api-key")
    #expect(try store.read(account: "opencode-go-api-key") == "go-test-secret")
    #expect(backend.lastQuery[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlock)
}

@Test func cacheAndLogsNeverContainKnownSecrets() throws {
    let sink = StringLogSink()
    let logger = RedactingLogger(sink: sink, secrets: ["go-test-secret", "https://slate.local/api/v1/contents/secret-id/data"])
    logger.error(code: "push_failed", detail: "Bearer go-test-secret at https://slate.local/api/v1/contents/secret-id/data")
    #expect(sink.output.contains("go-test-secret") == false)
    #expect(sink.output.contains("secret-id") == false)
    #expect(sink.output.contains("push_failed"))
}

@Test func cacheRejectsRawProviderKeys() throws {
    let bytes = Data(#"{"authorization":"Bearer secret","rateLimits":{}}"#.utf8)
    #expect(throws: SnapshotCacheError.self) { try SanitizedLastGood.decodeStrict(bytes) }
}
```

- [ ] **Step 2: 运行测试并确认安全存储组件不存在**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter SecretCacheAndLoggingTests`

Expected: FAIL，报告 `KeychainStore`、`RedactingLogger` 和缓存类型未定义。

- [ ] **Step 3: 实现 Security.framework 当前用户钥匙串访问**

`write` 先 `SecItemUpdate`，未找到时 `SecItemAdd`；查询固定 `kSecClassGenericPassword`、service 和 account，并用 `kSecAttrAccessibleAfterFirstUnlock` 允许锁屏后的 LaunchAgent 读取。错误只转换为 `KeychainError(status: OSStatus)`，不得带查询字典或 secret。

```swift
let base: [CFString: Any] = [
    kSecClass: kSecClassGenericPassword,
    kSecAttrService: service,
    kSecAttrAccount: account,
]
```

- [ ] **Step 4: 实现两份原子、0600、严格 schema 的 JSON 状态**

```swift
struct SanitizedLastGood: Codable, Equatable, Sendable {
    let schemaVersion: Int
    var codex: CodexDisplaySnapshot?
    var openCodeGo: OpenCodeGoDisplaySnapshot?
}

struct CollectorRuntimeState: Codable, Equatable, Sendable {
    let schemaVersion: Int
    var codexFailures: Int
    var openCodeGoFailures: Int
    var simultaneousFailures: Int
    var lastSuccessAt: Date?
    var lastPushAt: Date?
    var providerStatuses: [String: ProviderStatus]
    var lastErrorCodes: [String: String]
}
```

`snapshot-state.json` 是单一原子 JSON 状态包，外层、last-good 与 runtime-state 内层都严格验证 key。禁止出现 `authorization`、`apiKey`、`token`、`pushURL`、`contentId`、`rateLimits`、`rollingUsage` 等原始/敏感 key；加载损坏文件时返回明确的 `cache_corrupt`，不把正文打到日志。

- [ ] **Step 5: 跑绿并对生成文件做字节级 secret 扫描**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter SecretCacheAndLoggingTests`

Expected: PASS；临时目录所有文件和 sink 输出均不含测试 Key、Authorization 或完整 capability URL。

- [ ] **Step 6: 提交安全存储组件**

```bash
rtk git add tools/slate-quota-collector/Sources/SlateQuotaCollector/KeychainStore.swift tools/slate-quota-collector/Sources/SlateQuotaCollector/RedactingLogger.swift tools/slate-quota-collector/Sources/SlateQuotaCollector/SanitizedSnapshotCache.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/SecretCacheAndLoggingTests.swift
rtk git commit -m "feat(quota): 安全保存密钥与脱敏快照"
```

### Task 6: 跨轮失败、stale 与恢复策略

**Files:**
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/FailurePolicy.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/FailurePolicyTests.swift`

**Interfaces:**
- Consumes: 两个 `ProviderOutcome`、`SanitizedLastGood`、`CollectorRuntimeState`、当前时间。
- Produces: `FailurePolicy.decide(...) -> CollectionDecision`，其中包含可选 envelope、更新后的缓存/运行状态和 `shouldPush`。

- [ ] **Step 1: 写完整状态机的失败测试**

```swift
@Test func oneProviderFailureKeepsLastGoodAndMarksOnlyThatProviderStale() {
    let decision = FailurePolicy().decide(
        codex: .failure(.timeout),
        openCodeGo: .success(.freshGo),
        lastGood: .bothFresh,
        state: .clean,
        now: .fixtureNow
    )
    #expect(decision.shouldPush)
    #expect(decision.envelope?.data.codex.status == .stale)
    #expect(decision.envelope?.data.codex.rolling.remainingPercent == SanitizedLastGood.bothFresh.codex?.rolling.remainingPercent)
    #expect(decision.envelope?.data.openCodeGo.status == .ok)
}

@Test func firstSimultaneousFailureDoesNotPush() {
    let decision = FailurePolicy().decide(codex: .failure(.timeout), openCodeGo: .failure(.server), lastGood: .bothFresh, state: .clean, now: .fixtureNow)
    #expect(decision.shouldPush == false)
    #expect(decision.envelope == nil)
    #expect(decision.runtimeState.simultaneousFailures == 1)
}

@Test func secondSimultaneousFailurePushesStaleSnapshot() {
    var state = CollectorRuntimeState.clean
    state.simultaneousFailures = 1
    let decision = FailurePolicy().decide(codex: .failure(.timeout), openCodeGo: .failure(.server), lastGood: .bothFresh, state: state, now: .fixtureNow)
    #expect(decision.shouldPush)
    #expect(decision.envelope?.data.codex.status == .stale)
    #expect(decision.envelope?.data.openCodeGo.status == .stale)
}

@Test func noCacheUsesExplicitNoDataInsteadOfExhausted() {
    let decision = FailurePolicy().decide(codex: .failure(.unauthenticated), openCodeGo: .failure(.subscriptionRequired), lastGood: .empty, state: .oneSimultaneousFailure, now: .fixtureNow)
    #expect(decision.envelope?.data.codex.headerLeft == "CODEX · 未登录")
    #expect(decision.envelope?.data.codex.summaryLabel == "无可信数据")
    #expect(decision.envelope?.data.openCodeGo.headerLeft == "OPENCODE GO · 无 Go 订阅")
    #expect(decision.envelope?.data.openCodeGo.summaryLabel == "无可信数据")
}
```

- [ ] **Step 2: 运行测试并确认状态机不存在**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter FailurePolicyTests`

Expected: FAIL，报告 `FailurePolicy` 未定义。

- [ ] **Step 3: 实现无 I/O 的确定性决策**

```swift
enum ProviderOutcome<Value: Sendable>: Sendable {
    case success(Value)
    case failure(ProviderFailure)
}

struct CollectionDecision: Sendable {
    let envelope: SlateEnvelope?
    let shouldPush: Bool
    let lastGood: SanitizedLastGood
    let runtimeState: CollectorRuntimeState
}
```

成功 provider 更新对应 last-good 并把自己的 failure count 清零；失败 provider 有缓存时只改展示状态和文案，保留百分比、`sourceCollectedAt` 和绝对 `resetAt`。缓存年龄 `now - sourceCollectedAt > 600` 时，即使本轮重新组合也必须保持 stale。任一成功会把 `simultaneousFailures` 清零。

- [ ] **Step 4: 覆盖 401、403、恢复和十分钟陈旧边界**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter FailurePolicyTests`

Expected: PASS；覆盖单源失败、双源第一次/第二次失败、无缓存、401、403、9:59/10:01 陈旧和任一源恢复。

- [ ] **Step 5: 提交失败状态机**

```bash
rtk git add tools/slate-quota-collector/Sources/SlateQuotaCollector/FailurePolicy.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/FailurePolicyTests.swift
rtk git commit -m "feat(quota): 固化跨轮失败与恢复语义"
```

### Task 7: Slate ingest、端点策略与单次重试

**Files:**
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/SlateIngestClient.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/SlateIngestClientTests.swift`

**Interfaces:**
- Consumes: `SlateEnvelope`、钥匙串取出的 capability URL、15 秒超时。
- Produces: `SlateIngesting`、`SlateIngestReceipt`、`SlateEndpointPolicy.validate(_:)`，以及不泄漏 URL 的 GET 回读。

- [ ] **Step 1: 写 URL 安全与 POST 契约的失败测试**

```swift
@Test(arguments: [
    "http://127.0.0.1/api/v1/contents/abc/data",
    "http://192.168.1.20/api/v1/contents/abc/data",
    "http://slate.local/api/v1/contents/abc/data",
    "https://slate.example.com/api/v1/contents/abc/data",
])
func acceptsHttpsOrPrivateHttp(_ raw: String) throws {
    #expect(try SlateEndpointPolicy.validate(URL(string: raw)!) != nil)
}

@Test func rejectsPublicPlaintextAndWrongPath() {
    #expect(throws: SlateEndpointError.self) { try SlateEndpointPolicy.validate(URL(string: "http://example.com/api/v1/contents/abc/data")!) }
    #expect(throws: SlateEndpointError.self) { try SlateEndpointPolicy.validate(URL(string: "https://example.com/admin")!) }
}

@Test func postsExactEnvelopeAndDecodesReceipt() async throws {
    let transport = RecordingHTTPTransport(status: 200, body: Self.receipt)
    _ = try await SlateIngestClient(transport: transport).push(.fixture, capabilityURL: Self.privateURL)
    let request = try #require(await transport.lastRequest)
    #expect(request.httpMethod == "POST")
    #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(try JSONDecoder().decode(SlateEnvelope.self, from: request.httpBody!) == .fixture)
}

@Test func readsBackInnerDashboardDataWithoutPrintingCapabilityURL() async throws {
    let transport = RecordingHTTPTransport(status: 200, body: try JSONEncoder.slate.encode(SlateEnvelope.fixture.data))
    let data = try await SlateIngestClient(transport: transport).readCurrentData(capabilityURL: Self.privateURL)
    #expect(data == SlateEnvelope.fixture.data)
    #expect(await transport.lastRequest?.httpMethod == "GET")
}
```

- [ ] **Step 2: 运行测试并确认 Slate 客户端不存在**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter SlateIngestClientTests`

Expected: FAIL，报告 `SlateIngestClient` 未定义。

- [ ] **Step 3: 实现路径、scheme 和地址范围验证**

只接受 path 精确匹配 `/api/v1/contents/<非空 id>/data`，拒绝 query/fragment/userinfo。HTTP host 允许 `localhost`、`.local`、`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、`::1` 和 `fe80::/10`；不对域名做 DNS 解析以免 TOCTOU，普通域名必须 HTTPS。

- [ ] **Step 4: 实现可重试/永久失败分类**

```swift
struct SlateIngestReceipt: Decodable, Equatable, Sendable {
    let id: String
    let imageEtag: String
    let manifestEtag: String
    let renderedAt: Date
}
```

408、429、5xx 和瞬时 `URLError` 等待 1 秒后只重试一次；401、403、404 及其他 4xx 不重试。错误公开值仅含 `slate_http_<status>` 或 `slate_transport_<code>`，不含 URL/body。GET 回读直接把后端返回的 inner `data` 解码为 `SlateDashboardData`。15 秒是每次请求的上限，重试仍受 Task 9 的整轮 45 秒硬上限。

- [ ] **Step 5: 跑绿并验证重试次数**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter SlateIngestClientTests`

Expected: PASS；500→200 发送两次，404 只发送一次，receipt 三个证明字段都被解码，GET 回读与推送 data 可做强相等比较。

- [ ] **Step 6: 提交 Slate 客户端**

```bash
rtk git add tools/slate-quota-collector/Sources/SlateQuotaCollector/SlateIngestClient.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/SlateIngestClientTests.swift
rtk git commit -m "feat(quota): 安全推送 Slate 仪表盘数据"
```

### Task 8: 单实例运行锁

**Files:**
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/RunLock.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/RunLockTests.swift`

**Interfaces:**
- Consumes: Application Support 根目录和当前 PID。
- Produces: `RunLock.acquire(at:pid:isProcessAlive:)` 与释放闭包。

- [ ] **Step 1: 写活锁、陈旧锁和释放测试**

```swift
@Test func activeOwnerMakesThisRunExitSuccessfullyWithoutWork() throws {
    let root = try TemporaryDirectory()
    let first = try RunLock.acquire(at: root.url, pid: 100, isProcessAlive: { $0 == 100 })
    #expect(first != nil)
    let second = try RunLock.acquire(at: root.url, pid: 200, isProcessAlive: { $0 == 100 })
    #expect(second == nil)
}

@Test func staleOwnerIsReplacedAndReleaseRemovesOnlyOwnLock() throws {
    let root = try TemporaryDirectory()
    try RunLock.writeFixture(at: root.url, pid: 100)
    let lease = try #require(RunLock.acquire(at: root.url, pid: 200, isProcessAlive: { _ in false }))
    #expect(try RunLock.readPID(at: root.url) == 200)
    try lease.release()
    #expect(FileManager.default.fileExists(atPath: RunLock.url(in: root.url).path) == false)
}
```

- [ ] **Step 2: 运行测试并确认锁不存在**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter RunLockTests`

Expected: FAIL，报告 `RunLock` 未定义。

- [ ] **Step 3: 用 O_CREAT|O_EXCL 实现原子锁**

锁文件内容固定为 `{"pid":<int>,"started_at":"<iso8601>"}`、权限 0600。`EEXIST` 时读取 PID，用注入函数或生产 `kill(pid, 0)` 判断；活进程返回 `nil`，命令以 0 退出；死进程只删除精确的 `run.lock` 再重试一次。lease 释放前重新读取 PID，只有仍等于自己才删除，避免误删后来实例的锁。

- [ ] **Step 4: 跑并发争用测试**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter RunLockTests`

Expected: PASS；20 个并发 acquire 只有一个获得 lease，陈旧锁可恢复，释放不会删除别人的锁。

- [ ] **Step 5: 提交运行锁**

```bash
rtk git add tools/slate-quota-collector/Sources/SlateQuotaCollector/RunLock.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/RunLockTests.swift
rtk git commit -m "feat(quota): 阻止并发采集覆盖新快照"
```

### Task 9: 采集编排与 45 秒协作式 deadline

**Files:**
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/CollectorService.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/CollectorServiceTests.swift`

**Interfaces:**
- Consumes: 两个 reader、normalizer、secret store、snapshot store、failure policy、Slate ingest 和 clock。
- Produces: `CollectorService.collect(mode:) -> CollectionReport`，mode 为 `.dryRun` 或 `.pushOnce`。

- [ ] **Step 1: 写完整一轮的失败测试**

```swift
@Test func readsProvidersConcurrentlyThenCachesAndPushes() async throws {
    let events = EventRecorder()
    let service = CollectorService.fixture(events: events)
    let report = try await service.collect(mode: .pushOnce)
    #expect(report.pushed)
    #expect(await events.overlapped("codex.read", "opencode.read"))
    #expect(await events.order == ["codex.start", "opencode.start", "codex.end", "opencode.end", "cache.snapshot", "slate.push", "slate.readback", "cache.snapshot"])
}

@Test func dryRunNeverReadsSlateURLOrPushes() async throws {
    let secrets = RecordingSecretStore(values: ["opencode-go-api-key": "key"])
    let slate = RecordingSlateIngest()
    _ = try await CollectorService.fixture(secrets: secrets, slate: slate).collect(mode: .dryRun)
    #expect(secrets.readAccounts.contains("slate-push-url") == false)
    #expect(await slate.pushCount == 0)
}

@Test func firstDualFailurePersistsCounterWithoutPush() async throws {
    let store = InMemorySnapshotStore()
    let report = try await CollectorService.failingFixture(store: store).collect(mode: .pushOnce)
    #expect(report.pushed == false)
    #expect(try store.loadSnapshot().runtimeState.simultaneousFailures == 1)
}

@Test func cooperativeDeadlineCancelsOutstandingWork() async {
    let clock = ManualSuspendingClock()
    let service = CollectorService.hangingFixture(clock: clock, collectionDeadline: .milliseconds(50))
    do {
        _ = try await service.collect(mode: .pushOnce)
        Issue.record("expected cooperative collection deadline")
    } catch let error as CollectorError {
        #expect(error == .collectionDeadlineExceeded)
    } catch {
        Issue.record("unexpected error type")
    }
}

@Test func publishedDeadlinePreventsLatePostStart() async throws {
    for _ in 0..<32 {
        let fixture = DeadlinePublicationFixture(blockBefore: .slatePush)
        let task = Task { try await fixture.service.collect(mode: .pushOnce) }
        await fixture.publishDeadline()
        await fixture.releaseBlockedStage()
        await #expect(throws: CollectorError.collectionDeadlineExceeded) { try await task.value }
        #expect(await fixture.slate.pushCount == 0)
    }
}
```

- [ ] **Step 2: 运行测试并确认编排器不存在**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter CollectorServiceTests`

Expected: FAIL，报告 `CollectorService` 未定义。

- [ ] **Step 3: 实现并发采集和串行决策**

```swift
enum CollectionMode: Sendable { case dryRun, pushOnce }

struct CollectionReport: Sendable {
    let envelope: SlateEnvelope?
    let pushed: Bool
    let receipt: SlateIngestReceipt?
    let readbackVerified: Bool
    let publicErrorCodes: [String: String]
}

async let codexResult = capture { try await codex.read() }
async let goResult = capture { try await openCode.read(apiKey: goKey) }
let (rawCodex, rawGo) = await (codexResult, goResult)
```

两个结果分别归一化后交给 `FailurePolicy`。先把更新后的 last-good 和 runtime state 作为一个原子状态包保存，再按 decision 决定是否推送；POST 成功后立即 GET 当前 inner data 并与本轮 `envelope.data` 强相等，成功才设置 `readbackVerified=true` 并更新 `lastPushAt`。POST 或回读失败都不删除 last-good，也不重新请求 provider。`.dryRun` 返回/打印脱敏 envelope，但不读 Slate URL、不推送、不改变 `lastPushAt`。

- [ ] **Step 4: 在服务内加入可取消的 45 秒协作式 deadline**

使用有所有权的结构化 task group 让 work task 与 deadline task 竞争；先完成者取消另一个，并在 `collect` 返回前 drain 所有 child。`CollectorDeadlineGate` 使用同一线性化锁发布 deadline 和发放一次性 side-effect permit；deadline 发布后不得新开始 push、readback 或最终状态写入。deadline 抛 `CollectorError.collectionDeadlineExceeded`。客户端自己的 20/10/15 秒仍保留。

这一层只是协作式 deadline：它能确保可取消/有界依赖不在返回后继续副作用，但无法强制一个永久忽略取消且卡住的同步 I/O 在墙钟 45 秒返回。真正的 45 秒 wall-clock 硬上限由 Task 12 的独立 worker 进程监督器实施。

- [ ] **Step 5: 跑编排、失败和 secret 扫描测试**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter CollectorServiceTests`

Expected: PASS；并发读、单源失败、双源第一次/第二次、push retry、dry-run、协作式 deadline、deadline 发布后无新副作用、无残留 child 和恢复均通过，report 中 receipt 的 id/image ETag/manifest ETag 都脱敏且不含 secret。Task 12 完成前不得声称端到端 45 秒硬上限已实现。

- [ ] **Step 6: 提交采集编排**

```bash
rtk git add tools/slate-quota-collector/Sources/SlateQuotaCollector/CollectorService.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/CollectorServiceTests.swift
rtk git commit -m "feat(quota): 编排双服务采集与推送"
```

### Task 10: 持久自动采集开关与调度控制器

**Files:**
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/SettingsStore.swift`
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/CollectionScheduleController.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/CollectionScheduleControllerTests.swift`

**Interfaces:**
- Consumes: Task 8 的 `RunLock` 路径、当前 uid、collector plist 路径和注入的 launchctl transport。
- Produces: `CollectorSettings`、`SettingsPersisting`、`AutomaticCollectionStatus`、`CollectionScheduleControlling`、`shouldRunScheduledCollection()`。

- [ ] **Step 1: 写持久开关、pause/resume 顺序和 scheduled gate 的失败测试**

```swift
@Test func settingsDefaultToEnabledAndWriteOwnerOnly() throws {
    let root = try TemporaryDirectory()
    let store = SettingsStore(applicationSupportURL: root.url)
    #expect(try store.load().automaticCollectionEnabled)
    try store.save(.init(schemaVersion: 1, automaticCollectionEnabled: false))
    #expect(try store.load().automaticCollectionEnabled == false)
    #expect(try store.fileMode() & 0o077 == 0)
}

@Test func pausePersistsFalseBeforeWaitingAndBootout() async throws {
    let events = EventRecorder()
    let controller = CollectionScheduleController.fixture(events: events, lockStates: [.held, .released])
    try await controller.pause()
    #expect(await events.order == ["settings.false", "launchctl.disable", "lock.wait", "launchctl.bootout"])
}

@Test func resumePersistsTrueThenEnablesAndBootstraps() async throws {
    let events = EventRecorder()
    try await CollectionScheduleController.fixture(events: events).resume()
    #expect(await events.order == ["settings.true", "launchctl.enable", "launchctl.bootstrap"])
}

@Test func disabledScheduledGateReturnsBeforeCollectorConstruction() throws {
    let store = StubSettingsStore(enabled: false)
    #expect(try CollectionScheduleController.shouldRunScheduledCollection(settings: store) == false)
}
```

- [ ] **Step 2: 运行测试并确认调度类型不存在**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter CollectionScheduleControllerTests`

Expected: FAIL，报告 `SettingsStore` 或 `CollectionScheduleController` 未定义。

- [ ] **Step 3: 实现严格 settings schema 与调度协议**

```swift
struct CollectorSettings: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let automaticCollectionEnabled: Bool
}

protocol SettingsPersisting: Sendable {
    func load() throws -> CollectorSettings
    func save(_ value: CollectorSettings) throws
}

protocol LaunchctlControlling: Sendable {
    func disable(service: String) async throws
    func enable(service: String) async throws
    func bootstrap(plistURL: URL) async throws
    func bootout(service: String) async throws
    func isLoaded(service: String) async -> Bool
}

enum AutomaticCollectionStatus: Equatable, Sendable {
    case enabledLoaded
    case enabledNotLoaded
    case disabled
    case transitioning(String)
}

protocol CollectionScheduleControlling: Sendable {
    func status() async throws -> AutomaticCollectionStatus
    func pause() async throws
    func resume() async throws
}
```

`SettingsStore` 固定读写 `settings.json`，缺文件返回 enabled=true；额外 key、schema 非 1、非布尔值全部拒绝。原子临时文件与目标文件均 0600。

- [ ] **Step 4: 实现不强杀当前轮的 pause 和立即运行的 resume**

`pause()` 先保存 false，再执行 `launchctl disable gui/<uid>/com.yym8224961.slate-quota-collector`，每 250ms 检查 `run.lock`，最多等待 45 秒，最后 bootout collector service。因为 scheduled gate 在构造 Keychain/provider client 之前读 false，等待期间的新触发只启动短进程并立即成功退出。`resume()` 保存 true、enable service、bootstrap collector plist；plist 的 RunAtLoad 触发一次即时采集。

Run: `rtk swift test --package-path tools/slate-quota-collector --filter CollectionScheduleControllerTests`

Expected: PASS；关闭顺序、45 秒上限、无锁快速路径、重复 pause/resume 幂等和 scheduled gate 全部通过。

- [ ] **Step 5: 提交持久开关与调度控制器**

```bash
rtk git add tools/slate-quota-collector/Sources/SlateQuotaCollector/SettingsStore.swift tools/slate-quota-collector/Sources/SlateQuotaCollector/CollectionScheduleController.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/CollectionScheduleControllerTests.swift
rtk git commit -m "feat(quota): 增加持久自动采集开关"
```

### Task 11: 原生菜单栏 App 与脱敏状态窗口

**Files:**
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/MenuBarViewModel.swift`
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/MenuBarController.swift`
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/StatusWindowController.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/MenuBarViewModelTests.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/MenuBarControllerTests.swift`

**Interfaces:**
- Consumes: `CollectionScheduleControlling`、Task 5 的脱敏 last-good/runtime state、Task 9 的手动 `collect(.pushOnce)` 入口。
- Produces: `MenuBarPresentation`、`MenuBarActionHandling`、`@MainActor MenuBarController.run()` 和原生详细状态窗口。

- [ ] **Step 1: 写图标、菜单文案和退出语义的失败测试**

```swift
@Test func enabledPresentationUsesChartIconAndCheckedToggle() {
    let value = MenuBarViewModel().presentation(snapshot: .healthy, schedule: .enabledLoaded, busy: nil)
    #expect(value.iconSystemName == "chart.bar.fill")
    #expect(value.automaticCollectionChecked)
    #expect(value.codexLine == "正常 · 剩余 91%")
    #expect(value.openCodeGoLine == "注意 · 剩余 18%")
}

@Test func pausedAndErrorIconsDoNotDependOnColor() {
    #expect(MenuBarViewModel().presentation(snapshot: .healthy, schedule: .disabled, busy: nil).iconSystemName == "pause.circle")
    #expect(MenuBarViewModel().presentation(snapshot: .providerError, schedule: .enabledLoaded, busy: nil).iconSystemName == "exclamationmark.triangle")
}

@MainActor @Test func menuContainsApprovedItemsAndQuitDoesNotPause() async throws {
    let actions = RecordingMenuBarActions()
    let controller = MenuBarController(actions: actions, statusReader: .fixture)
    controller.refresh()
    #expect(controller.menuTitles == ["Slate 额度监控", "每 5 分钟自动采集", "立即采集一次", "Codex", "OpenCode Go", "最后推送", "查看详细状态", "退出菜单栏"])
    controller.perform(.quitMenuBar)
    #expect(await actions.pauseCount == 0)
    #expect(await actions.quitCount == 1)
}
```

- [ ] **Step 2: 运行测试并确认菜单栏类型不存在**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter MenuBar`

Expected: FAIL，报告 `MenuBarViewModel` 或 `MenuBarController` 未定义。

- [ ] **Step 3: 实现纯展示模型和无 secret 状态读取**

```swift
struct MenuBarPresentation: Equatable, Sendable {
    let iconSystemName: String
    let automaticCollectionChecked: Bool
    let automaticCollectionTitle: String
    let codexLine: String
    let openCodeGoLine: String
    let lastPushLine: String
    let busyLine: String?
}

enum MenuBarAction: Sendable {
    case toggleAutomaticCollection
    case collectOnce
    case showDetailedStatus
    case quitMenuBar
}

struct MenuBarStatusSnapshot: Equatable, Sendable {
    let codexSummary: String
    let openCodeGoSummary: String
    let lastSuccessAt: Date?
    let lastPushAt: Date?
    let publicErrorCodes: [String: String]
}

protocol MenuBarStatusReading: Sendable {
    func readStatus() throws -> MenuBarStatusSnapshot
}

protocol MenuBarActionHandling: Sendable {
    func pause() async throws
    func resume() async throws
    func collectOnce() async throws
    @MainActor func showDetailedStatus()
    @MainActor func quitMenuBar()
}
```

ViewModel 只读取展示 snapshot、schedule status 和 busy 状态，不持有 `SecretStoring`。provider 行使用已有 summary/status；没有可信数据时显示“无可信数据”，不得把 0% 误写成已耗尽。

- [ ] **Step 4: 实现 NSStatusItem、异步 action 和详细状态 NSPanel**

`MenuBarController` 标记 `@MainActor`，创建 `NSStatusBar.system.statusItem` 和 `NSMenu`。toggle/pause/resume/collect 在 detached Task 中执行，主线程只更新“正在关闭”“正在开启”“正在采集”；期间禁用重复 action但菜单继续响应。`StatusWindowController` 的 NSPanel 固定显示自动采集状态、两个 provider 状态、最近成功/推送时间和脱敏错误码；不显示配置路径、URL、contentId 或 raw error。Quit 调用 `NSApplication.shared.terminate(nil)`，绝不调用 pause。

Run: `rtk swift test --package-path tools/slate-quota-collector --filter MenuBar`

Expected: PASS；健康/暂停/错误/无数据/busy 文案、菜单项顺序、异步禁用和退出不暂停均通过。

- [ ] **Step 5: 提交菜单栏 App 控制器**

```bash
rtk git add tools/slate-quota-collector/Sources/SlateQuotaCollector/MenuBarViewModel.swift tools/slate-quota-collector/Sources/SlateQuotaCollector/MenuBarController.swift tools/slate-quota-collector/Sources/SlateQuotaCollector/StatusWindowController.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/MenuBarViewModelTests.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/MenuBarControllerTests.swift
rtk git commit -m "feat(quota): 增加原生菜单栏控制界面"
```

### Task 12: CLI、App bundle 与双 LaunchAgent 安装

**Files:**
- Modify: `tools/slate-quota-collector/Sources/SlateQuotaCollector/Command.swift`
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/AppBundleInstaller.swift`
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/LaunchAgentInstaller.swift`
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/CollectorProcessSupervisor.swift`
- Create: `tools/slate-quota-collector/Resources/Info.plist.template`
- Create: `tools/slate-quota-collector/Resources/com.yym8224961.slate-quota-collector.plist.template`
- Create: `tools/slate-quota-collector/Resources/com.yym8224961.slate-quota-menubar.plist.template`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/AppBundleInstallerTests.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/LaunchAgentInstallerTests.swift`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/CollectorProcessSupervisorTests.swift`

**Interfaces:**
- Consumes: Tasks 1–11 全部组件和当前用户目录。
- Produces: 八个用户命令、菜单栏/调度/worker 内部入口、稳定 collector binary、`Slate 额度监控.app`、双 plist、脱敏 `status` 和独立 worker 进程的 45 秒硬监督器。

- [ ] **Step 1: 写命令解析、App bundle 和双 plist 的失败测试**

```swift
@Test func parsesApprovedAndInternalCommandsWithoutSecretArguments() throws {
    #expect(try CLIArguments(["collect", "--dry-run"]) == .collect(.dryRun))
    #expect(try CLIArguments(["collect", "--once"]) == .collect(.pushOnce))
    #expect(try CLIArguments(["collect", "--scheduled"]) == .collectScheduled)
    #expect(try CLIArguments(["--menu-bar"]) == .menuBar)
    #expect(try CLIArguments(["pause"]) == .pause)
    #expect(try CLIArguments(["resume"]) == .resume)
    #expect(throws: CLIError.self) { try CLIArguments(["collect", "--api-key", "secret"]) }
}

@Test func appBundleIsAgentOnlyAndUsesAbsoluteExecutable() throws {
    let bundle = try AppBundleInstaller(fileSystem: .recording).build(executable: Self.releaseBinary)
    #expect(bundle.url.path == NSString(string: "~/Applications/Slate 额度监控.app").expandingTildeInPath)
    #expect(bundle.info["CFBundleIdentifier"] as? String == "com.yym8224961.slate-quota-menubar")
    #expect(bundle.info["LSUIElement"] as? Bool == true)
    #expect(bundle.info["CFBundleExecutable"] as? String == "slate-quota-collector")
}

@Test func installsIndependentMenuBarAndCollectorJobs() throws {
    let plists = try LaunchAgentInstaller.renderPlists(paths: .fixture)
    #expect(plists.menuBar["Label"] as? String == "com.yym8224961.slate-quota-menubar")
    #expect(plists.menuBar["RunAtLoad"] as? Bool == true)
    #expect(plists.menuBar["StartInterval"] == nil)
    #expect(plists.collector["Label"] as? String == "com.yym8224961.slate-quota-collector")
    #expect(plists.collector["StartInterval"] as? Int == 300)
    #expect((plists.collector["ProgramArguments"] as? [String])?.suffix(2) == ["collect", "--scheduled"])
}

@Test func hardSupervisorTerminatesAnUncooperativeWorker() async throws {
    let worker = RealFixtureWorker(ignoreTERM: true, writeLateMarker: true)
    let supervisor = CollectorProcessSupervisor(
        wallClockLimit: .milliseconds(100),
        terminationGrace: .milliseconds(50)
    )
    let result = try await supervisor.run(worker)
    #expect(result == .timedOut)
    #expect(worker.processIsAlive == false)
    try await Task.sleep(for: .milliseconds(200))
    #expect(worker.lateMarkerExists == false)
}
```

- [ ] **Step 2: 运行测试并确认安装类型不存在**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter 'AppBundleInstallerTests|LaunchAgentInstallerTests'`

Expected: FAIL，报告 `AppBundleInstaller` 或双 plist 安装行为不存在。

- [ ] **Step 3: 实现 setup 的无回显输入和只读预检**

`setup` 用 `termios` 关闭 echo，分别两次读取并校验 OpenCode Key 与 Slate URL；不允许 secret 参数。用 `/usr/bin/which codex` + `realpath` 保存绝对路径，写配置/钥匙串，再做 Codex/OpenCode 只读预检和 Slate URL 本地验证。预检失败只输出脱敏 code。

```text
OpenCode Go API Key（输入不会显示）：
再次输入 OpenCode Go API Key：
Slate 推送 URL（输入不会显示）：
再次输入 Slate 推送 URL：
```

- [ ] **Step 4: 生成本机 `.app`、稳定 binary 和两个审计可读 plist**

Info.plist 固定包含 `CFBundlePackageType=APPL`、`CFBundleIdentifier=com.yym8224961.slate-quota-menubar`、`CFBundleName=Slate 额度监控`、`CFBundleExecutable=slate-quota-collector`、`LSUIElement=true`、`LSMinimumSystemVersion=13.0`。同一 release binary 分别复制到 `.app/Contents/MacOS/` 和 Application Support `bin/`，权限 0700；三个模板的内嵌字符串与 Resources 文件逐字测试一致。

collector plist 使用 `collect --scheduled`、RunAtLoad 和 StartInterval 300；menu bar plist 使用 app binary `--menu-bar`、RunAtLoad，无 StartInterval/KeepAlive。所有路径绝对化，日志文件 0600，不出现 Key、Slate URL 或 contentId。

- [ ] **Step 5: 接线 worker 进程硬监督、用户命令、内部入口、安装与卸载**

可见帮助只列出 `setup`、`collect --dry-run`、`collect --once`、`pause`、`resume`、`install-launch-agent`、`status`、`uninstall-launch-agent`。`collect --scheduled`、`collect --once` 和 `collect --dry-run` 的父进程只负责 gate/监督，通过无 secret 参数的内部 `collect --worker <mode>` 启动同一稳定 binary 的独立 worker。worker 在内部获取 `RunLock`并执行 Task 9 采集。

`CollectorProcessSupervisor` 从 worker 成功 spawn 起计时 45 秒；到期先发 TERM，等待 2 秒 grace，未退出则发 KILL，然后必须 `waitpid`/等价 API 确认 worker 死亡才返回脱敏 `worker_timeout`。进程死亡后旧轮不可能再发生网络或文件副作用；下一轮按 Task 8 安全恢复已死 PID 的 lock 记录。真实子进程测试必须覆盖正常退出、TERM 退出、忽略 TERM 后 KILL、超时后无 late marker/无存活 PID，以及 worker 持有 RunLock 时被终止后下轮可恢复。

`collect --scheduled` 在 spawn worker 前调用 Task 10 gate；`--menu-bar` 运行 `NSApplication` 与 Task 11 controller。安装先生成 app/binary/plists，再 bootstrap menu bar，按 settings 决定是否 bootstrap collector。卸载 bootout/删除两个 plist、`.app` 和稳定 binary，但保留 Keychain、config、settings 和 `snapshot-state.json` 脱敏状态包。

`status` 只显示自动采集开关、menu bar/collector loaded 状态、最近成功/推送、provider 状态和脱敏错误码。

- [ ] **Step 6: 运行 CLI、bundle、plist 和 release build 验证**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter 'AppBundleInstallerTests|LaunchAgentInstallerTests'`

Run: `rtk swift test --package-path tools/slate-quota-collector --filter CollectorProcessSupervisorTests`

Run: `rtk swift build --package-path tools/slate-quota-collector -c release`

Expected: PASS；App bundle 通过 property-list 解码，两个 agent 可独立 loaded/disabled，帮助无内部入口和 secret 参数，release binary 可启动 `--menu-bar` 测试 harness；真实 worker 超时测试证明 45 秒生产上限、TERM→grace→KILL、子进程已回收且不会产生超时后副作用。只有完成本步后才可称为端到端 45 秒硬上限。

- [ ] **Step 7: 提交 CLI、App bundle 与双 LaunchAgent**

```bash
rtk git add tools/slate-quota-collector/Sources/SlateQuotaCollector/Command.swift tools/slate-quota-collector/Sources/SlateQuotaCollector/AppBundleInstaller.swift tools/slate-quota-collector/Sources/SlateQuotaCollector/LaunchAgentInstaller.swift tools/slate-quota-collector/Sources/SlateQuotaCollector/CollectorProcessSupervisor.swift tools/slate-quota-collector/Resources/Info.plist.template tools/slate-quota-collector/Resources/com.yym8224961.slate-quota-collector.plist.template tools/slate-quota-collector/Resources/com.yym8224961.slate-quota-menubar.plist.template tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/AppBundleInstallerTests.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/LaunchAgentInstallerTests.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/CollectorProcessSupervisorTests.swift
rtk git commit -m "feat(quota): 安装菜单栏 App 与双 LaunchAgent"
```

### Task 13: Slate A5 模板、初始数据与渲染回归

**Files:**
- Create: `tools/slate-quota-collector/templates/slate-dashboard-template.json`
- Create: `tools/slate-quota-collector/templates/initial-data.json`
- Create: `shared/src/dynamic/slate-quota-template.test.ts`
- Create: `backend/src/modules/dynamic-content/rendering/slate-quota-dashboard.test.ts`

**Interfaces:**
- Consumes: 批准规格第 5.2/6 节的精确 JSON、现有 `DashboardTemplate` 和 `DynamicFrameRendererService`。
- Produces: 可直接粘贴的模板/初始数据及七种状态的 1bpp 回归证明。

- [ ] **Step 1: 写 schema、绑定和底部坐标的失败测试**

```ts
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DashboardTemplate } from './templates';

const template = JSON.parse(readFileSync(new URL('../../../tools/slate-quota-collector/templates/slate-dashboard-template.json', import.meta.url), 'utf8'));
const initial = JSON.parse(readFileSync(new URL('../../../tools/slate-quota-collector/templates/initial-data.json', import.meta.url), 'utf8'));

describe('Slate quota custom template', () => {
  it('keeps the approved A5 geometry', () => {
    expect(DashboardTemplate.parse(template).blocks).toHaveLength(17);
    expect(template.blocks.filter((b: { type: string }) => b.type === 'progress')).toHaveLength(5);
    expect(template.blocks.filter((b: { type: string }) => b.type === 'progress').every((b: { bar_height: number; label_font_size: number; value_font_size: number }) => b.bar_height === 14 && b.label_font_size === 16 && b.value_font_size === 16)).toBe(true);
    expect(Math.max(...template.blocks.filter((b: { y?: number; h?: number }) => b.y !== undefined).map((b: { y: number; h: number }) => b.y + b.h))).toBe(300);
  });

  it('ships a valid Slate ingest envelope', () => {
    expect(initial.version).toBe(1);
    expect(initial.data.schema_version).toBe(1);
    expect(initial.data.codex.rolling.value_text).toBe('未提供');
    expect(initial.data.opencode_go.monthly.remaining_percent).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: 运行测试并确认 JSON 文件缺失**

Run: `rtk bun test shared/src/dynamic/slate-quota-template.test.ts`

Expected: FAIL，报告两个模板 JSON 文件不存在。

- [ ] **Step 3: 原样落地批准模板与初始 envelope**

`slate-dashboard-template.json` 必须逐字段复制批准规格第 5.2 节；`initial-data.json` 必须使用第 6 节 envelope，并在文件顶部保持唯一顶层 `version` 和 `data`。不能加入采集周期、数据新鲜度小字或额外底边。

- [ ] **Step 4: 写多状态 renderer 失败测试**

```ts
it.each(['normal', 'attention', 'exhausted', 'missing-codex-window', 'long-plan', 'single-stale', 'both-empty'])('renders %s as 400x300 1bpp', async (fixtureName) => {
  const data = fixtures[fixtureName];
  const frame = await renderer.render({
    type: 'dashboard',
    frameName: '额度监控',
    config: { type: 'dashboard', template: { kind: 'custom', template } },
    data,
    renderedAt: new Date('2026-08-12T08:30:00Z'),
  });
  expect(frame.byteLength).toBe(15_000);
  expect(countBlack(frame, 0, 24, 400, 276)).toBeGreaterThan(500);
});

it('draws more remaining bar pixels for 81 percent than 21 percent', async () => {
  const high = await renderWithRollingRemaining(81);
  const low = await renderWithRollingRemaining(21);
  expect(countBlack(high, 100, 189, 210, 31)).toBeGreaterThan(countBlack(low, 100, 189, 210, 31));
});
```

七份 fixture 都由 `initial.data` 深拷贝后明确覆写字段；`missing-codex-window` 固定 `remaining_percent=0,value_text="未提供"`，`both-empty` 固定 summary `无可信数据`，用断言阻止错误路径出现 `100`。

- [ ] **Step 5: 跑 schema 与 renderer 回归**

Run: `rtk bun test shared/src/dynamic/slate-quota-template.test.ts backend/src/modules/dynamic-content/rendering/slate-quota-dashboard.test.ts`

Expected: PASS；所有输出 15000 bytes，剩余额度越多黑色填充越长，缺失窗口为空心且不显示 100%。

- [ ] **Step 6: 提交模板和渲染证明**

```bash
rtk git add tools/slate-quota-collector/templates/slate-dashboard-template.json tools/slate-quota-collector/templates/initial-data.json shared/src/dynamic/slate-quota-template.test.ts backend/src/modules/dynamic-content/rendering/slate-quota-dashboard.test.ts
rtk git commit -m "feat(quota): 交付双服务 A5 额度模板"
```

### Task 14: 使用说明、全套自动化验证与真实安装检查点

**Files:**
- Create: `tools/slate-quota-collector/README.md`
- Modify: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/CollectorServiceTests.swift`

**Interfaces:**
- Consumes: Tasks 1–13 的最终命令、菜单栏 App、路径、错误码和模板文件。
- Produces: 从 Slate 建帧到 Mac 安装、验证、轮换、卸载的中文运行手册，以及全链路 fake transport 测试。

- [ ] **Step 1: 写端到端 fake transport 失败测试**

```swift
@Test func endToEndFakeRoundTripProducesPublicSlateEnvelope() async throws {
    let fixture = EndToEndFixture(
        codexJSONRPC: .weeklyOnlyWithCredits,
        openCodeHTTP: .threeWindows,
        slateHTTP: .successReceipt
    )
    let report = try await fixture.service.collect(mode: .pushOnce)
    #expect(report.receipt?.id == "redacted")
    #expect(report.receipt?.imageEtag == "redacted")
    #expect(report.receipt?.manifestEtag == "redacted")
    #expect(report.readbackVerified)
    let pushed = try #require(await fixture.slate.lastEnvelope)
    #expect(pushed.data.codex.rolling.valueText == "未提供")
    #expect(pushed.data.codex.weekly.remainingPercent == 91)
    #expect(pushed.data.openCodeGo.rolling.remainingPercent == 81)
    #expect(await fixture.allCapturedBytes.range(of: Data("go-test-secret".utf8)) == nil)
}
```

- [ ] **Step 2: 运行测试并确认端到端 fixture 尚未组成**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter endToEndFakeRoundTripProducesPublicSlateEnvelope`

Expected: FAIL，报告 `EndToEndFixture` 未定义。

- [ ] **Step 3: 组装已有 fake transports，不增加生产分支**

测试 fixture 使用 Task 3 的假 Codex stdio、Task 4/7 的记录型 HTTP transport、内存钥匙串和临时缓存目录，完整走 `CollectorService`；分别再加 500→200 Slate retry、Codex timeout + Go 成功、双源连续第二次失败三个端到端用例。

- [ ] **Step 4: 编写中文 README 的精确操作顺序**

README 必须包含：

1. 要求 macOS 13+、Swift 6.2、同用户 Codex ChatGPT 登录、OpenCode Go API Key、Slate capability URL；
2. release build 命令；
3. Slate 新建“外部数据”、帧名“额度监控”、5 分钟刷新、粘贴两个 JSON 文件；
4. `setup`、`collect --dry-run`、`collect --once`、`pause`、`resume`、`install-launch-agent`、`status`、`uninstall-launch-agent` 的预期输出；
5. 锁屏/休眠/注销语义，10 分钟 stale 规则；
6. 401、403、Codex 未登录、push 404、双源失败的处理；
7. capability URL 泄漏后删除旧 Slate 内容并重建的轮换流程；
8. 卸载不删除钥匙串/缓存，以及用“钥匙串访问”App手工删除两个 account 的明确步骤；
9. 服务器渲染成功、Slate GET 回读和真实 Note4 下一次同步显示是三个不同证明面；
10. 菜单栏登录自启、开关持久化、关闭状态手动采集、退出 UI 不停采集和双 LaunchAgent 的操作说明；
11. 第一版 `.app` 仅供当前 Mac 本地安装，未做 Developer ID 签名、公证或跨 Mac 分发。

- [ ] **Step 5: 运行全套静态和自动化验证**

Run: `rtk swift test --package-path tools/slate-quota-collector`

Run: `rtk swift build --package-path tools/slate-quota-collector -c release`

Run: `rtk plutil -lint tools/slate-quota-collector/Resources/Info.plist.template tools/slate-quota-collector/Resources/com.yym8224961.slate-quota-collector.plist.template tools/slate-quota-collector/Resources/com.yym8224961.slate-quota-menubar.plist.template`

Run: `rtk bun test shared/src/dynamic/slate-quota-template.test.ts backend/src/modules/dynamic-content/rendering/slate-quota-dashboard.test.ts`

Run: `rtk bun run --cwd shared typecheck`

Run: `rtk git diff --check`

Expected: 所有命令成功；Swift 测试包含真实短进程 fixture、fake HTTP 全链路和菜单栏/双 agent 测试；三个 plist 合法；TypeScript schema/renderer 无回归；diff 无空白错误。

- [ ] **Step 6: 扫描仓库交付物中的 secret 和越界改动**

Run: `rtk grep -n -i 'authorization\|bearer \|opencode.*api.*key.*[:=]\|/api/v1/contents/[A-Za-z0-9_-]\{10,\}/data' tools/slate-quota-collector docs/superpowers/plans/2026-08-12-codex-opencode-go-quota-monitor.md`

Expected: 只命中说明文字、测试假值和固定字段名，不出现真实 Key、真实 contentId 或真实完整 URL。

Run: `rtk git diff --name-only HEAD~13`

Expected: 只包含本计划列出的 `tools/slate-quota-collector/`、两个新 TypeScript 测试文件和文档；不包含 Prisma、Hermes、固件或插件文件。

- [ ] **Step 7: 提交 README 与端到端测试**

```bash
rtk git add tools/slate-quota-collector/README.md tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/CollectorServiceTests.swift
rtk git commit -m "docs(quota): 补齐安装与验证手册"
```

- [ ] **Step 8: 到真实凭据检查点时让用户本人无回显输入**

Run: `rtk tools/slate-quota-collector/.build/release/slate-quota-collector setup`

Expected: 用户本人在本机输入 Key/URL；终端不回显，配置文件和日志不包含 secret，两个只读 provider 预检均报告成功。执行代理不得让用户把 Key 或 URL发送到聊天。

- [ ] **Step 9: 真实只读采集与 Slate 回读**

Run: `rtk tools/slate-quota-collector/.build/release/slate-quota-collector collect --dry-run`

Expected: 输出脱敏 envelope；Codex 至少出现官方返回的一个主额度窗口，缺失窗口显示“未提供”；没有 thread/prompt/model request。

Run: `rtk tools/slate-quota-collector/.build/release/slate-quota-collector collect --once`

Expected: 显示脱敏 `id`、`image_etag`、`manifest_etag`、`rendered_at` 成功摘要，不显示 capability URL。

采集器随后以钥匙串 URL执行 GET 回读，只输出 `readback verified`、schema version 和 provider status；不得打印 URL。回读 payload 必须等于本轮归一化 data，且 secret 扫描为空。

- [ ] **Step 10: 安装并验证两次约五分钟的自动运行**

Run: `rtk tools/slate-quota-collector/.build/release/slate-quota-collector install-launch-agent`

Run: `rtk tools/slate-quota-collector/.build/release/slate-quota-collector status`

Expected: menu bar 与 collector 两个 LaunchAgent loaded，`~/Applications/Slate 额度监控.app` 的 Info.plist 显示 `LSUIElement=true`；菜单栏图标出现且无 Dock 图标。collector 先由 RunAtLoad 完成一次，再在 300 秒后完成第二次，两个 `lastPushAt` 间隔约 5 分钟；每次都有新 `rendered_at`/ETag 或明确的服务端去重行为。等待期间每 60 秒可读一次 `status`，不额外请求 provider。

- [ ] **Step 11: 验证菜单栏开关、手动采集与恢复**

在菜单栏关闭“每 5 分钟自动采集”，确认图标变为 `pause.circle`、菜单栏仍存在、`status` 显示 disabled；等待超过 5 分钟，`lastPushAt` 不变化且日志没有 provider 请求。关闭状态点击“立即采集一次”，确认只新增一轮并保持 disabled。再从菜单栏恢复，确认立即采集一次并重新进入 300 秒调度。点击“退出菜单栏”后确认 collector 开关/loaded 状态不变；重新启动 `.app` 恢复图标。

- [ ] **Step 12: 验证登录自启而不擅自注销用户**

自动化先验证 menu bar plist 的 RunAtLoad、绝对 app executable、无 StartInterval/KeepAlive 和独立 label。真实“注销并重新登录”会中断当前桌面会话，执行代理不得自行触发；在最终交付时请用户选择方便的时间手动重新登录，随后回读 menu bar job 和 settings，确认图标自动出现且开关保持注销前状态。

- [ ] **Step 13: 在 Web 预览与真实 Note4 做最终视觉验收**

Web 预览和设备均确认：状态栏“额度监控”几何居中；Codex/OpenCode Go 纵排；5 条额度条字号和间距符合 A5；Codex 缺失窗口显示空心“未提供”；“余额接续 开启/关闭”保留；底部没有采集周期小字和额外留白。记录服务器 ETag、设备同步时间和一张真实屏幕照片，明确区分服务器渲染与设备显示证明。

## 自审结果

- **规格覆盖：** Tasks 2–4 覆盖两个官方数据源与全部窗口语义；Tasks 5–9 覆盖密钥、缓存、失败、锁、超时、重试和采集编排；Task 10 覆盖持久开关与 scheduled gate；Task 11 覆盖菜单栏/详细状态 UI；Task 12 覆盖八个用户命令、`.app` 与双 LaunchAgent；Task 13 覆盖最终 A5 模板与 1bpp 渲染；Task 14 覆盖真实安装、开关和三层证明。
- **实现补充：** `snapshot-state.json` 内嵌 runtime state，解决 launchd 每轮新进程无法仅靠内存识别“连续第二次双源失败”的问题；它与 last-good 同包原子发布，不改变批准的凭据边界。
- **范围检查：** 菜单栏与采集核心仍是同一 Swift Package/二进制的两个入口，不引入 XPC、App Store、公证或独立前端；现有 backend 只新增隔离的 renderer 测试，不修改生产服务。
- **类型一致性：** 所有后续任务沿用 `SlateEnvelope`、`SanitizedLastGood`、`CollectorRuntimeState`、`CollectionDecision`、`CollectionReport`、`CollectorSettings`、`AutomaticCollectionStatus` 和 `CollectionScheduleControlling`，菜单栏/CLI 共用一套 schedule 逻辑。
- **完成边界：** 自动化通过不等于真实部署完成；只有 Task 14 的真实只读 provider、Slate ETag/GET、双 LaunchAgent、菜单开关、两次五分钟采集和 Note4 实机证明全部取得后才称为完成。注销/登录证明需要用户在方便时手动配合，代理不会自行中断桌面会话。
