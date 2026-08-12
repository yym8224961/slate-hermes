# Codex × OpenCode Go 额度监控实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前 Mac 上交付一个每 5 分钟采集 Codex 与 OpenCode Go 官方额度数据、统一为剩余额度并安全推送到 Slate 自定义 Dashboard 的原生采集器。

**Architecture:** 新工具作为独立 Swift Package 放在 `tools/slate-quota-collector/`，通过小型协议隔离 Codex JSON-RPC、OpenCode HTTPS、钥匙串、文件缓存、Slate ingest 和 launchd。纯函数归一化与失败决策先用单元测试固定，再接入真实传输；Slate 模板继续由现有 TypeScript schema 和 1bpp renderer 做兼容性验证，不改固件、数据库或 Hermes 链路。

**Tech Stack:** Swift 6.2、Swift Package Manager、Foundation、Security、Darwin、macOS 13+、Bun test、现有 Slate `DashboardTemplate`/`DynamicFrameRendererService`。

## Global Constraints

- 目标设备固定为 ZecTrix Note4：400 × 300、1bpp、15000 bytes，正文只能使用 y=24..299。
- 最终 A5 模板保持 17 个 block、16px 文本、14px progress、Codex 上/OpenCode Go 下、底部 block 的 `y + h = 300`。
- 所有额度条表达“剩余额度”；`remaining = clamp(100 - used, 0, 100)`，显示整数采用向下取整，不能高估剩余量。
- Codex 只调用同一 macOS 用户的 `codex app-server --stdio` 和 `account/rateLimits/read`；不得读取或复制 `~/.codex/auth.json`，不得创建 thread、发送 prompt 或发起模型请求。
- Codex 只认 `rateLimitsByLimitId.codex`，或 `rateLimits.limitId == "codex"` 的回退值；用 `windowDurationMins == 300/10080` 识别 5 小时/周，不混入 `codex_bengalfox`。
- OpenCode Go 只调用 `GET https://opencode.ai/zen/go/v1/usage`，未知状态、缺字段、非 JSON 与 HTTP 错误全部 fail closed。
- OpenCode Go Key 与完整 Slate capability URL 只存在当前用户登录钥匙串；不得出现在参数、plist、配置、缓存、日志或测试快照中。
- `last-good.json` 只保存已归一化、可公开展示的 provider 快照；另用 `runtime-state.json` 保存跨进程失败计数、最近成功/推送时间和脱敏错误码。
- launchd 固定 `RunAtLoad=true`、`StartInterval=300`；Codex/OpenCode/Slate/整轮超时固定为 20/10/15/45 秒。
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
│   ├── SanitizedSnapshotCache.swift                   # last-good 与 runtime-state 原子持久化
│   ├── FailurePolicy.swift                            # 单源/双源失败、stale、恢复决策
│   ├── RunLock.swift                                  # O_EXCL 锁、PID 存活与陈旧锁恢复
│   ├── SlateIngestClient.swift                        # endpoint 校验、POST、一次短重试
│   ├── CollectorService.swift                         # 并发采集、45 秒总限时、缓存与推送编排
│   └── LaunchAgentInstaller.swift                     # 稳定二进制、plist、bootstrap/bootout/status
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
│   └── LaunchAgentInstallerTests.swift
├── Resources/
│   └── com.yym8224961.slate-quota-collector.plist.template
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
    func loadLastGood() throws -> SanitizedLastGood
    func saveLastGood(_ value: SanitizedLastGood) throws
    func loadRuntimeState() throws -> CollectorRuntimeState
    func saveRuntimeState(_ value: CollectorRuntimeState) throws
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
- Produces: 原始 DTO、`ProviderStatus`、`QuotaWindow`、`CodexDisplaySnapshot`、`OpenCodeGoDisplaySnapshot`、`SlateDashboardData`、`SlateEnvelope`、`CollectorConfiguration`、五个核心协议。

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
            linkerSettings: [.linkedFramework("Security")]
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

`SlateDashboardData.CodingKeys` 必须显式把 `opencodeGo` 写成 `opencode_go`；其他字段由 `.convertToSnakeCase` 处理。`JSONEncoder.slate` 使用 ISO-8601 日期；`decodeStrict` 先用 `JSONSerialization` 拒绝允许集合外的顶层 key，再检查 schema=1、时区存在、四个超时严格等于 20/10/15/45。`CodexCredits.balance` 用自定义解码同时接受 JSON number 和十进制字符串，但拒绝非有限数。`ConfigurationStore` 固定使用 `~/Library/Application Support/SlateQuotaCollector/config.json`，临时文件写完、`chmod 0600` 后原子替换。

- [ ] **Step 5: 加入仅能显示帮助的命令入口并跑绿**

```swift
@main
enum Command {
    static func main() async {
        if CommandLine.arguments.dropFirst().first == "--help" {
            print("slate-quota-collector setup|collect|install-launch-agent|status|uninstall-launch-agent")
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

`last-good.json` 和 `runtime-state.json` 使用同一原子写工具但分别严格验证 key。禁止出现 `authorization`、`apiKey`、`token`、`pushURL`、`contentId`、`rateLimits`、`rollingUsage` 等原始/敏感 key；加载损坏文件时返回明确的 `cache_corrupt`，不把正文打到日志。

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

### Task 9: 采集编排与 45 秒整轮硬上限

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
    #expect(await events.order == ["codex.start", "opencode.start", "codex.end", "opencode.end", "cache.lastGood", "cache.runtime", "slate.push", "slate.readback"])
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
    #expect(try store.loadRuntimeState().simultaneousFailures == 1)
}

@Test func overallDeadlineCancelsOutstandingWork() async {
    let clock = ManualSuspendingClock()
    let service = CollectorService.hangingFixture(clock: clock, overallTimeout: .milliseconds(50))
    do {
        _ = try await service.collect(mode: .pushOnce)
        Issue.record("expected overall timeout")
    } catch let error as CollectorError {
        #expect(error == .overallTimeout)
    } catch {
        Issue.record("unexpected error type")
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

两个结果分别归一化后交给 `FailurePolicy`。先原子保存更新后的 last-good 和 runtime state，再按 decision 决定是否推送；POST 成功后立即 GET 当前 inner data 并与本轮 `envelope.data` 强相等，成功才设置 `readbackVerified=true` 并更新 `lastPushAt`。POST 或回读失败都不删除 last-good，也不重新请求 provider。`.dryRun` 返回/打印脱敏 envelope，但不读 Slate URL、不推送、不改变 `lastPushAt`。

- [ ] **Step 4: 在最外层加入可取消的 45 秒 deadline**

使用 `withThrowingTaskGroup` 让 work task 与 deadline task 竞争；先完成者取消另一个，deadline 抛 `CollectorError.overallTimeout`。客户端自己的 20/10/15 秒仍保留。测试 clock 可注入，生产使用 `ContinuousClock`。

- [ ] **Step 5: 跑编排、失败和 secret 扫描测试**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter CollectorServiceTests`

Expected: PASS；并发读、单源失败、双源第一次/第二次、push retry、dry-run、总超时和恢复均通过，report 不含 secret。

- [ ] **Step 6: 提交采集编排**

```bash
rtk git add tools/slate-quota-collector/Sources/SlateQuotaCollector/CollectorService.swift tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/CollectorServiceTests.swift
rtk git commit -m "feat(quota): 编排双服务采集与推送"
```

### Task 10: CLI、稳定安装路径与 LaunchAgent

**Files:**
- Modify: `tools/slate-quota-collector/Sources/SlateQuotaCollector/Command.swift`
- Create: `tools/slate-quota-collector/Sources/SlateQuotaCollector/LaunchAgentInstaller.swift`
- Create: `tools/slate-quota-collector/Resources/com.yym8224961.slate-quota-collector.plist.template`
- Create: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/LaunchAgentInstallerTests.swift`

**Interfaces:**
- Consumes: 所有既有组件和当前用户目录。
- Produces: 六个批准命令、稳定二进制路径、launchd plist、`status` 脱敏报告。

- [ ] **Step 1: 写命令解析、plist 和卸载保留数据测试**

```swift
@Test func parsesApprovedCommandsOnly() throws {
    #expect(try CLIArguments(["collect", "--dry-run"]) == .collect(.dryRun))
    #expect(try CLIArguments(["collect", "--once"]) == .collect(.pushOnce))
    #expect(try CLIArguments(["setup"]) == .setup)
    #expect(throws: CLIError.self) { try CLIArguments(["collect", "--api-key", "secret"]) }
}

@Test func launchAgentUsesStableAbsolutePathsAndFiveMinutes() throws {
    let plist = try LaunchAgentInstaller.renderPlist(executable: Self.installedBinary)
    #expect(plist["Label"] as? String == "com.yym8224961.slate-quota-collector")
    #expect(plist["RunAtLoad"] as? Bool == true)
    #expect(plist["StartInterval"] as? Int == 300)
    #expect(plist.description.contains("$PATH") == false)
}

@Test func uninstallKeepsKeychainAndCache() throws {
    let fs = RecordingInstallerFileSystem()
    try LaunchAgentInstaller(fileSystem: fs, launchctl: StubLaunchctl()).uninstall()
    #expect(fs.removed.contains(Self.plistURL))
    #expect(fs.removed.contains(Self.lastGoodURL) == false)
    #expect(fs.keychainDeleteCount == 0)
}

@Test func auditedResourceMatchesEmbeddedTemplate() throws {
    let resource = try String(contentsOf: Self.resourceTemplateURL, encoding: .utf8)
    #expect(resource == LaunchAgentInstaller.plistTemplate)
}
```

- [ ] **Step 2: 运行测试并确认命令与安装器行为缺失**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter LaunchAgentInstallerTests`

Expected: FAIL，报告 `CLIArguments` 或 `LaunchAgentInstaller` 未定义。

- [ ] **Step 3: 实现 setup 的无回显输入和只读预检**

`setup` 用 `termios` 临时关闭 echo，从 stdin 读取两次 OpenCode Key 和两次 Slate URL并做相等校验；不允许 secret 命令参数。用 `/usr/bin/which codex` 定位后调用 `realpath` 保存绝对路径，写配置与钥匙串，再各做一次 Codex/OpenCode 只读预检和 Slate URL 本地校验；预检失败保留已写配置并只显示脱敏 code，方便修复后重跑。

```text
OpenCode Go API Key（输入不会显示）：
再次输入 OpenCode Go API Key：
Slate 推送 URL（输入不会显示）：
再次输入 Slate 推送 URL：
```

- [ ] **Step 4: 实现 collect、status 与稳定二进制安装**

`LaunchAgentInstaller.swift` 内嵌与 Resources 文件逐字一致的 XML 模板，使安装后的单文件二进制不依赖源码目录；`Resources/com.yym8224961.slate-quota-collector.plist.template` 是供人工审计和打包复用的同源副本，测试强制两者一致。`install-launch-agent` 把当前 release 可执行文件原子复制到 `~/Library/Application Support/SlateQuotaCollector/bin/slate-quota-collector`，权限 0700；把模板替换成绝对 binary/log path 后写 `~/Library/LaunchAgents/com.yym8224961.slate-quota-collector.plist`，再执行 `launchctl bootout gui/<uid>/<label>`（不存在可忽略）和 `launchctl bootstrap gui/<uid> <plist>`。标准输出/错误分别写 Application Support 下 0600 日志文件。

plist 模板固定包含：

```xml
<key>Label</key><string>com.yym8224961.slate-quota-collector</string>
<key>ProgramArguments</key>
<array><string>__EXECUTABLE__</string><string>collect</string><string>--once</string></array>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>300</integer>
<key>ProcessType</key><string>Background</string>
```

`status` 只读 runtime-state 和 `launchctl print gui/<uid>/<label>` 的退出码，显示最近成功/推送时间、provider status、脱敏错误码和 loaded/not loaded。`uninstall-launch-agent` 只 bootout 并删除 plist，保留 binary、配置、钥匙串、缓存。

- [ ] **Step 5: 运行 CLI/installer 测试与 release build**

Run: `rtk swift test --package-path tools/slate-quota-collector --filter LaunchAgentInstallerTests`

Run: `rtk swift build --package-path tools/slate-quota-collector -c release`

Expected: PASS；release 可执行文件存在，`--help` 只列出批准的六个命令，plist 不含 secret 或相对路径。

- [ ] **Step 6: 提交 CLI 与 LaunchAgent**

```bash
rtk git add tools/slate-quota-collector/Sources/SlateQuotaCollector/Command.swift tools/slate-quota-collector/Sources/SlateQuotaCollector/LaunchAgentInstaller.swift tools/slate-quota-collector/Resources/com.yym8224961.slate-quota-collector.plist.template tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/LaunchAgentInstallerTests.swift
rtk git commit -m "feat(quota): 安装五分钟 LaunchAgent"
```

### Task 11: Slate A5 模板、初始数据与渲染回归

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

### Task 12: 使用说明、全套自动化验证与真实安装检查点

**Files:**
- Create: `tools/slate-quota-collector/README.md`
- Modify: `tools/slate-quota-collector/Tests/SlateQuotaCollectorTests/CollectorServiceTests.swift`

**Interfaces:**
- Consumes: Tasks 1–11 的最终命令、路径、错误码和模板文件。
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
    #expect(report.receipt?.imageEtag == "image-etag-2")
    #expect(report.receipt?.manifestEtag == "manifest-etag-2")
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
4. `setup`、`collect --dry-run`、`collect --once`、`install-launch-agent`、`status`、`uninstall-launch-agent` 的预期输出；
5. 锁屏/休眠/注销语义，10 分钟 stale 规则；
6. 401、403、Codex 未登录、push 404、双源失败的处理；
7. capability URL 泄漏后删除旧 Slate 内容并重建的轮换流程；
8. 卸载不删除钥匙串/缓存，以及用“钥匙串访问”App手工删除两个 account 的明确步骤；
9. 服务器渲染成功、Slate GET 回读和真实 Note4 下一次同步显示是三个不同证明面。

- [ ] **Step 5: 运行全套静态和自动化验证**

Run: `rtk swift test --package-path tools/slate-quota-collector`

Run: `rtk swift build --package-path tools/slate-quota-collector -c release`

Run: `rtk bun test shared/src/dynamic/slate-quota-template.test.ts backend/src/modules/dynamic-content/rendering/slate-quota-dashboard.test.ts`

Run: `rtk bun run --cwd shared typecheck`

Run: `rtk git diff --check`

Expected: 所有命令成功；Swift 测试包含真实短进程 fixture 和 fake HTTP 全链路；TypeScript schema/renderer 无回归；diff 无空白错误。

- [ ] **Step 6: 扫描仓库交付物中的 secret 和越界改动**

Run: `rtk grep -n -i 'authorization\|bearer \|opencode.*api.*key.*[:=]\|/api/v1/contents/[A-Za-z0-9_-]\{10,\}/data' tools/slate-quota-collector docs/superpowers/plans/2026-08-12-codex-opencode-go-quota-monitor.md`

Expected: 只命中说明文字、测试假值和固定字段名，不出现真实 Key、真实 contentId 或真实完整 URL。

Run: `rtk git diff --name-only HEAD~11`

Expected: 只包含本计划列出的 `tools/slate-quota-collector/`、两个新测试文件和文档；不包含 Prisma、Hermes、固件或插件文件。

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

Expected: LaunchAgent loaded；先由 RunAtLoad 完成一次，再在 300 秒后完成第二次，两个 `lastPushAt` 间隔约 5 分钟；每次都有新 `rendered_at`/ETag 或明确的服务端去重行为。等待期间每 60 秒可读一次 `status`，不额外请求 provider。

- [ ] **Step 11: 在 Web 预览与真实 Note4 做最终视觉验收**

Web 预览和设备均确认：状态栏“额度监控”几何居中；Codex/OpenCode Go 纵排；5 条额度条字号和间距符合 A5；Codex 缺失窗口显示空心“未提供”；“余额接续 开启/关闭”保留；底部没有采集周期小字和额外留白。记录服务器 ETag、设备同步时间和一张真实屏幕照片，明确区分服务器渲染与设备显示证明。

## 自审结果

- **规格覆盖：** Tasks 2–4 覆盖两个官方数据源与全部窗口语义；Tasks 5–9 覆盖密钥、缓存、失败、锁、超时、重试和调度；Task 10 覆盖六个 CLI 命令；Task 11 覆盖最终 A5 模板与 1bpp 渲染；Task 12 覆盖真实安装和三层证明。
- **实现补充：** 新增独立 `runtime-state.json`，解决 launchd 每轮新进程无法仅靠内存识别“连续第二次双源失败”的问题；它不改变批准的凭据边界。
- **范围检查：** 单一子项目即可独立构建、测试、安装和卸载；现有 backend 只新增隔离的 renderer 测试，不修改生产服务。
- **类型一致性：** 所有后续任务沿用文件职责章节的五个协议、`SlateEnvelope`、`SanitizedLastGood`、`CollectorRuntimeState`、`CollectionDecision` 和 `CollectionReport`，没有平行命名。
- **完成边界：** 自动化通过不等于真实部署完成；只有 Task 12 的真实只读 provider、Slate ETag/GET、两次 LaunchAgent 和 Note4 实机证明全部取得后才称为完成。
