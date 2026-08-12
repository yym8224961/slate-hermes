import AppKit
import Darwin
import Foundation

enum RequestedCollectionMode: Equatable, Sendable {
    case dryRun
    case pushOnce
}

enum CollectorWorkerMode: String, Equatable, Sendable {
    case dryRun = "dry-run"
    case pushOnce = "push-once"
    case scheduled

    var serviceMode: CollectionMode {
        switch self {
        case .dryRun: .dryRun
        case .pushOnce, .scheduled: .pushOnce
        }
    }
}

enum CLIArguments: Equatable, Sendable {
    case setup
    case collect(RequestedCollectionMode)
    case pause
    case resume
    case installLaunchAgent
    case status
    case uninstallLaunchAgent
    case help
    case menuBar
    case collectScheduled
    case collectWorker(CollectorWorkerMode)

    static let visibleHelp = """
    用法：slate-quota-collector <命令>

      setup                       安全配置本机采集器
      collect --dry-run           采集并显示脱敏数据，不推送
      collect --once              立即采集并推送一次
      pause                       关闭每 5 分钟自动采集
      resume                      开启自动采集并立即运行
      install-launch-agent        安装菜单栏与自动采集
      status                      显示脱敏运行状态
      uninstall-launch-agent      卸载程序，保留配置与历史状态
    """

    init(_ arguments: [String]) throws {
        self = switch arguments {
        case ["setup"]: .setup
        case ["collect", "--dry-run"]: .collect(.dryRun)
        case ["collect", "--once"]: .collect(.pushOnce)
        case ["pause"]: .pause
        case ["resume"]: .resume
        case ["install-launch-agent"]: .installLaunchAgent
        case ["status"]: .status
        case ["uninstall-launch-agent"]: .uninstallLaunchAgent
        case ["--help"], ["-h"], ["help"]: .help
        case ["--menu-bar"]: .menuBar
        case ["collect", "--scheduled"]: .collectScheduled
        case ["collect", "--worker", "dry-run"]: .collectWorker(.dryRun)
        case ["collect", "--worker", "push-once"]: .collectWorker(.pushOnce)
        case ["collect", "--worker", "scheduled"]: .collectWorker(.scheduled)
        default: throw CLIError.invalidArguments
        }
    }
}

enum CLIError: Error, Equatable, Sendable, CustomStringConvertible {
    case invalidArguments
    case configuration
    case setupInput
    case setupMismatch
    case setupPreflight(String)
    case workerTimeout
    case workerFailure

    var publicCode: String {
        switch self {
        case .invalidArguments: "invalid_arguments"
        case .configuration: "configuration_invalid"
        case .setupInput: "setup_input"
        case .setupMismatch: "setup_mismatch"
        case let .setupPreflight(code): MenuBarViewModel.safePublicCode(code)
        case .workerTimeout: "worker_timeout"
        case .workerFailure: "worker_failure"
        }
    }

    var description: String { "CLIError(code: \(publicCode))" }
}

@main
enum Command {
    static func main() async {
        do {
            let command = try CLIArguments(Array(CommandLine.arguments.dropFirst()))
            try await CommandRuntime().run(command)
        } catch let error as CLIError {
            writePublicError(error.publicCode)
            if error == .invalidArguments { print(CLIArguments.visibleHelp) }
            exit(2)
        } catch {
            writePublicError(publicCode(for: error))
            exit(1)
        }
    }

    private static func writePublicError(_ code: String) {
        FileHandle.standardError.write(Data("错误：\(MenuBarViewModel.safePublicCode(code))\n".utf8))
    }

    private static func publicCode(for error: any Error) -> String {
        switch error {
        case let value as CollectorProcessSupervisorError: value.publicCode
        case let value as CollectionScheduleError: value.publicCode
        case let value as SettingsStoreError: value.publicCode
        case let value as InstallerError: value.publicCode
        case let value as LaunchctlError: value.publicCode
        case let value as SnapshotCacheError: value.publicCode
        case let value as CLIError: value.publicCode
        default: "internal_failure"
        }
    }
}

/// Runtime wiring is deliberately kept behind the parser: scheduled gating can
/// finish before any Keychain store, provider client, or worker is constructed.
struct CommandRuntime: Sendable {
    private let paths: InstallationPaths
    private let launchctl: any LaunchctlControlling
    private let executableURL: URL
    private let supervisor: CollectorProcessSupervisor
    private let menuBarHarness: Bool

    init(
        paths: InstallationPaths = .init(),
        launchctl: any LaunchctlControlling = SystemLaunchctlController(),
        executableURL: URL? = nil,
        supervisor: CollectorProcessSupervisor = .init(),
        menuBarHarness: Bool = ProcessInfo.processInfo.environment["SLATE_QUOTA_MENUBAR_TEST_HARNESS"] == "1"
    ) {
        self.paths = paths
        self.launchctl = launchctl
        self.executableURL = executableURL ?? Self.currentExecutableURL()
        self.supervisor = supervisor
        self.menuBarHarness = menuBarHarness
    }

    func run(_ command: CLIArguments) async throws {
        switch command {
        case .help:
            print(CLIArguments.visibleHelp)
        case .setup:
            try await setup()
        case let .collect(mode):
            let workerMode: CollectorWorkerMode = mode == .dryRun ? .dryRun : .pushOnce
            try await supervise(workerMode)
        case .collectScheduled:
            let settings = SettingsStore(applicationSupportURL: paths.applicationSupportURL)
            guard try CollectionScheduleController.shouldRunScheduledCollection(settings: settings) else {
                return
            }
            // This gate deliberately precedes supervisor spawn and every call
            // that can construct Keychain/provider dependencies.
            try await supervise(.scheduled)
        case let .collectWorker(mode):
            try await runWorker(mode)
        case .pause:
            try await scheduleController().pause()
            print("自动采集：已关闭")
        case .resume:
            try await scheduleController().resume()
            print("自动采集：已开启")
        case .installLaunchAgent:
            try await install()
        case .uninstallLaunchAgent:
            try await uninstall()
        case .status:
            try await printStatus()
        case .menuBar:
            await runMenuBar()
        }
    }

    private func setup() async throws {
        let input = try SecretTerminalReader().readSetupValues()
        guard input.openCodeKey == input.confirmedOpenCodeKey,
              input.slateURL == input.confirmedSlateURL else {
            throw CLIError.setupMismatch
        }
        let openCodeKey = input.openCodeKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let slateText = input.slateURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !openCodeKey.isEmpty,
              let slateURL = URL(string: slateText), slateURL.absoluteString == slateText else {
            throw CLIError.setupInput
        }
        do { _ = try SlateEndpointPolicy.validate(slateURL) }
        catch { throw CLIError.setupPreflight("slate_endpoint_invalid") }

        let codexExecutable = try Self.locateCodexExecutable()
        let configuration = CollectorConfiguration(
            schemaVersion: 1,
            codexExecutablePath: codexExecutable.path,
            timezoneIdentifier: "Asia/Shanghai",
            codexTimeoutSeconds: 20,
            openCodeTimeoutSeconds: 10,
            slateTimeoutSeconds: 15,
            overallTimeoutSeconds: 45,
            logLevel: "info",
            keychainService: KeychainStore.requiredService,
            openCodeKeyAccount: "opencode-go-api-key",
            slateURLAccount: "slate-push-url"
        )
        let secrets = KeychainStore(service: configuration.keychainService)
        try secrets.write(openCodeKey, account: configuration.openCodeKeyAccount)
        try secrets.write(slateText, account: configuration.slateURLAccount)
        try ConfigurationStore(applicationSupportURL: paths.applicationSupportURL).save(configuration)

        do { _ = try await CodexRateLimitClient(configuration: configuration).read() }
        catch { throw CLIError.setupPreflight(Self.codexPreflightCode(error)) }
        do { _ = try await OpenCodeGoUsageClient().read(apiKey: openCodeKey) }
        catch { throw CLIError.setupPreflight(Self.openCodePreflightCode(error)) }
        print("配置完成，只读预检通过")
    }

    private func supervise(_ mode: CollectorWorkerMode) async throws {
        let result = try await supervisor.run(
            executableURL: executableURL,
            arguments: ["collect", "--worker", mode.rawValue]
        )
        switch result.outcome {
        case .exited(code: 0): return
        case .timedOut: throw CLIError.workerTimeout
        case .exited, .signaled: throw CLIError.workerFailure
        }
    }

    private func runWorker(_ mode: CollectorWorkerMode) async throws {
        guard let lock = try RunLock.acquire(at: paths.applicationSupportURL) else {
            // launchd or a manual collection already owns the single writer.
            return
        }
        defer { try? lock.release() }

        let configuration = try loadConfiguration()
        let secrets = KeychainStore(service: configuration.keychainService)
        let openCodeKey: String
        let slateURL: String
        do {
            openCodeKey = try secrets.read(account: configuration.openCodeKeyAccount)
            slateURL = try secrets.read(account: configuration.slateURLAccount)
        } catch {
            throw CLIError.configuration
        }
        let snapshots = SanitizedSnapshotCache(
            applicationSupportURL: paths.applicationSupportURL,
            sensitiveValues: [openCodeKey, slateURL]
        )
        let service = CollectorService(
            codex: CodexRateLimitClient(configuration: configuration),
            openCodeGo: OpenCodeGoUsageClient(),
            normalizer: .shanghai,
            secrets: secrets,
            snapshots: snapshots,
            failurePolicy: FailurePolicy(),
            slate: SlateIngestClient(),
            openCodeKeyAccount: configuration.openCodeKeyAccount,
            slateURLAccount: configuration.slateURLAccount
        )
        let report = try await service.collect(mode: mode.serviceMode)
        if mode == .dryRun, let envelope = report.envelope {
            let data = try JSONEncoder.slate.encode(envelope)
            guard let text = String(data: data, encoding: .utf8) else {
                throw CLIError.workerFailure
            }
            print(text)
        }
        if !report.publicErrorCodes.isEmpty {
            let safe = report.publicErrorCodes
                .map { (MenuBarViewModel.safePublicCode($0.key), MenuBarViewModel.safePublicCode($0.value)) }
                .sorted { $0.0 < $1.0 }
                .map { "\($0.0)=\($0.1)" }
                .joined(separator: ",")
            FileHandle.standardError.write(Data("状态：\(safe)\n".utf8))
        }
    }

    private func install() async throws {
        _ = try AppBundleInstaller(paths: paths).install(executableURL: executableURL)
        let artifacts = try LaunchAgentInstaller(paths: paths).installPlists()
        let menuService = "gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)"
        let collectorService = "gui/\(getuid())/\(LaunchAgentInstaller.collectorLabel)"
        try await launchctl.enable(service: menuService)
        try await launchctl.bootstrap(plistURL: artifacts.menuBarPlistURL)
        let enabled = try SettingsStore(applicationSupportURL: paths.applicationSupportURL)
            .load().automaticCollectionEnabled
        if enabled {
            try await launchctl.enable(service: collectorService)
            try await launchctl.bootstrap(plistURL: artifacts.collectorPlistURL)
        } else {
            try await launchctl.disable(service: collectorService)
            try? await launchctl.bootout(service: collectorService)
        }
        print("菜单栏与自动采集已安装")
    }

    private func uninstall() async throws {
        let menuService = "gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)"
        let collectorService = "gui/\(getuid())/\(LaunchAgentInstaller.collectorLabel)"
        try? await launchctl.bootout(service: collectorService)
        try? await launchctl.bootout(service: menuService)
        try LaunchAgentInstaller(paths: paths).removeGeneratedArtifacts()
        print("程序已卸载；钥匙串、配置、开关与历史状态已保留")
    }

    private func printStatus() async throws {
        let settings = try SettingsStore(applicationSupportURL: paths.applicationSupportURL).load()
        let menuService = "gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)"
        let collectorService = "gui/\(getuid())/\(LaunchAgentInstaller.collectorLabel)"
        let menuLoaded = await launchctl.isLoaded(service: menuService)
        let collectorLoaded = await launchctl.isLoaded(service: collectorService)
        let snapshot = try SanitizedSnapshotCache(
            applicationSupportURL: paths.applicationSupportURL,
            sensitiveValues: []
        ).loadSnapshot()
        let reader = SnapshotMenuBarStatusReader(snapshots: FixedSnapshot(value: snapshot))
        let display = try reader.readStatus()
        print("自动采集：\(settings.automaticCollectionEnabled ? "已开启" : "已关闭")")
        print("菜单栏：\(menuLoaded ? "已加载" : "未加载")")
        print("定时采集：\(collectorLoaded ? "已加载" : "未加载")")
        print("Codex：\(MenuBarViewModel.safeProviderSummary(display.codexSummary))")
        print("OpenCode Go：\(MenuBarViewModel.safeProviderSummary(display.openCodeGoSummary))")
        print("最近成功：\(display.lastSuccessAt.map { MenuBarViewModel.dateText($0) } ?? "尚无记录")")
        print("最近推送：\(display.lastPushAt.map { MenuBarViewModel.dateText($0) } ?? "尚无记录")")
        let codes = display.publicErrorCodes
            .map { (MenuBarViewModel.safePublicCode($0.key), MenuBarViewModel.safePublicCode($0.value)) }
            .sorted { $0.0 < $1.0 }
            .map { "\($0.0)=\($0.1)" }
            .joined(separator: ",")
        print("错误码：\(codes.isEmpty ? "无" : codes)")
    }

    private func runMenuBar() async {
        let schedule = scheduleController()
        let actions = RuntimeMenuBarActions(
            schedule: schedule,
            executableURL: executableURL,
            supervisor: supervisor
        )
        let statusReader = SnapshotMenuBarStatusReader(
            snapshots: SanitizedSnapshotCache(
                applicationSupportURL: paths.applicationSupportURL,
                sensitiveValues: []
            )
        )
        await MainActor.run {
            let controller = MenuBarController(
                actions: actions,
                schedule: schedule,
                statusReader: statusReader,
                installSystemStatusItem: !menuBarHarness
            )
            if menuBarHarness {
                print("menu_bar_ready")
            } else {
                controller.run()
            }
        }
    }

    private func scheduleController() -> CollectionScheduleController {
        CollectionScheduleController(
            settings: SettingsStore(applicationSupportURL: paths.applicationSupportURL),
            launchctl: launchctl,
            applicationSupportURL: paths.applicationSupportURL,
            collectorPlistURL: paths.collectorPlistURL
        )
    }

    private func loadConfiguration() throws -> CollectorConfiguration {
        let url = ConfigurationStore(applicationSupportURL: paths.applicationSupportURL).configurationURL
        let descriptor = open(url.path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw CLIError.configuration }
        defer { _ = close(descriptor) }
        var status = stat()
        guard fstat(descriptor, &status) == 0,
              status.st_mode & S_IFMT == S_IFREG,
              status.st_uid == getuid(),
              status.st_mode & 0o777 == 0o600,
              status.st_size >= 0, status.st_size <= 64 * 1_024 else {
            throw CLIError.configuration
        }
        var data = Data(count: Int(status.st_size))
        let count = data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return 0 }
            return Darwin.read(descriptor, base, bytes.count)
        }
        guard count == data.count else { throw CLIError.configuration }
        do { return try CollectorConfiguration.decodeStrict(data) }
        catch { throw CLIError.configuration }
    }

    private static func currentExecutableURL() -> URL {
        var size: UInt32 = 0
        _NSGetExecutablePath(nil, &size)
        var buffer = [CChar](repeating: 0, count: Int(size))
        guard _NSGetExecutablePath(&buffer, &size) == 0 else {
            return URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        }
        let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        return URL(fileURLWithPath: String(decoding: bytes, as: UTF8.self)).resolvingSymlinksInPath()
    }

    private static func locateCodexExecutable() throws -> URL {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        process.arguments = ["codex"]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() }
        catch { throw CLIError.setupPreflight("codex_not_found") }
        process.waitUntilExit()
        guard process.terminationStatus == 0,
              let path = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !path.isEmpty else {
            throw CLIError.setupPreflight("codex_not_found")
        }
        guard let resolvedPointer = realpath(path, nil) else {
            throw CLIError.setupPreflight("codex_not_executable")
        }
        defer { free(resolvedPointer) }
        let bytes = UnsafeRawPointer(resolvedPointer).assumingMemoryBound(to: UInt8.self)
        let resolved = URL(fileURLWithPath: String(decodingCString: bytes, as: UTF8.self))
        guard resolved.path.hasPrefix("/"), access(resolved.path, X_OK) == 0 else {
            throw CLIError.setupPreflight("codex_not_executable")
        }
        return resolved
    }

    private static func codexPreflightCode(_ error: any Error) -> String {
        switch error as? CodexClientError {
        case .rpc: "codex_unauthenticated"
        case .timeout: "codex_timeout"
        case .invalidResponse: "codex_invalid_response"
        case .launchFailed: "codex_launch_failed"
        case .inputFailed: "codex_input_failed"
        case nil: "codex_preflight_failed"
        }
    }

    private static func openCodePreflightCode(_ error: any Error) -> String {
        switch error as? OpenCodeGoClientError {
        case .unauthorized: "opencode_unauthorized"
        case .subscriptionRequired: "opencode_subscription_required"
        case .rateLimited: "opencode_rate_limited"
        case .server: "opencode_server"
        case .timeout: "opencode_timeout"
        case .transport: "opencode_transport"
        case .http: "opencode_http"
        case nil: "opencode_preflight_failed"
        }
    }
}

private struct SetupValues {
    let openCodeKey: String
    let confirmedOpenCodeKey: String
    let slateURL: String
    let confirmedSlateURL: String
}

private struct SecretTerminalReader {
    func readSetupValues() throws -> SetupValues {
        guard isatty(STDIN_FILENO) == 1 else { throw CLIError.setupInput }
        var original = termios()
        guard tcgetattr(STDIN_FILENO, &original) == 0 else { throw CLIError.setupInput }
        var hidden = original
        hidden.c_lflag &= ~tcflag_t(ECHO)
        guard tcsetattr(STDIN_FILENO, TCSAFLUSH, &hidden) == 0 else {
            throw CLIError.setupInput
        }
        defer {
            _ = tcsetattr(STDIN_FILENO, TCSAFLUSH, &original)
            print("")
        }
        return SetupValues(
            openCodeKey: try read("OpenCode Go API Key（输入不会显示）："),
            confirmedOpenCodeKey: try read("再次输入 OpenCode Go API Key："),
            slateURL: try read("Slate 推送 URL（输入不会显示）："),
            confirmedSlateURL: try read("再次输入 Slate 推送 URL：")
        )
    }

    private func read(_ prompt: String) throws -> String {
        print(prompt, terminator: "")
        fflush(stdout)
        guard let value = readLine(strippingNewline: true) else { throw CLIError.setupInput }
        print("")
        return value
    }
}

private struct FixedSnapshot: SnapshotPersisting, Sendable {
    let value: CollectorSnapshot
    func loadSnapshot() throws -> CollectorSnapshot { value }
    func saveSnapshot(_: CollectorSnapshot) throws {}
}

private struct RuntimeMenuBarActions: MenuBarActionHandling, Sendable {
    let schedule: any CollectionScheduleControlling
    let executableURL: URL
    let supervisor: CollectorProcessSupervisor

    func pause() async throws { try await schedule.pause() }
    func resume() async throws { try await schedule.resume() }
    func collectOnce() async throws {
        let result = try await supervisor.run(
            executableURL: executableURL,
            arguments: ["collect", "--worker", CollectorWorkerMode.pushOnce.rawValue]
        )
        switch result.outcome {
        case .exited(code: 0): return
        case .timedOut: throw CLIError.workerTimeout
        case .exited, .signaled: throw CLIError.workerFailure
        }
    }
}
