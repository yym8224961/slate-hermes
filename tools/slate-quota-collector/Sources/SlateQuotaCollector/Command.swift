import AppKit
import Darwin
import Foundation
import Security

enum RequestedCollectionMode: Equatable, Sendable {
    case dryRun
    case pushOnce
}

enum CollectorWorkerMode: String, Equatable, Sendable {
    case dryRun = "dry-run"
    case pushOnce = "push-once"
    case pushOnceWithProof = "push-once-with-proof"
    case scheduled

    var serviceMode: CollectionMode {
        switch self {
        case .dryRun: .dryRun
        case .pushOnce, .pushOnceWithProof, .scheduled: .pushOnce
        }
    }
}

enum CLIArguments: Equatable, Sendable {
    case setup
    case setupOpenCodeGo
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
      setup-opencode-go           安全配置独立 OpenCode Go 监控
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
        case ["setup-opencode-go"]: .setupOpenCodeGo
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
        case ["collect", "--worker", "push-once-with-proof"]:
            .collectWorker(.pushOnceWithProof)
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
    case workerAuthorization
    case setupRollback
    case setupExistingItem

    var publicCode: String {
        switch self {
        case .invalidArguments: "invalid_arguments"
        case .configuration: "configuration_invalid"
        case .setupInput: "setup_input"
        case .setupMismatch: "setup_mismatch"
        case let .setupPreflight(code): MenuBarViewModel.safePublicCode(code)
        case .workerTimeout: "worker_timeout"
        case .workerFailure: "worker_failure"
        case .workerAuthorization: "worker_authorization"
        case .setupRollback: "setup_rollback"
        case .setupExistingItem: "setup_existing_item"
        }
    }

    var description: String { "CLIError(code: \(publicCode))" }
}

enum PushOnceProofFormatter {
    static func render(_ report: CollectionReport) -> String? {
        guard report.pushed,
              report.readbackVerified,
              let receipt = report.receipt,
              receipt.id == "redacted",
              receipt.imageEtag == "redacted",
              receipt.manifestEtag == "redacted",
              let envelope = report.envelope else {
            return nil
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        var proof = "推送成功：id=redacted image_etag=redacted manifest_etag=redacted "
            + "rendered_at=\(formatter.string(from: receipt.renderedAt)) "
            + "readback_verified=true schema_version=\(envelope.data.schemaVersion) "
            + "codex_status=\(envelope.data.codex.status.rawValue)"
        if envelope.data.includesOpenCodeGo {
            proof += " opencode_go_status=\(envelope.data.opencodeGo.status.rawValue)"
        }
        return proof
    }
}

enum OpenCodeGoPushOnceProofFormatter {
    static func render(_ report: OpenCodeGoCollectionReport) -> String? {
        guard report.pushed,
              report.readbackVerified,
              let receipt = report.receipt,
              receipt.id == "redacted",
              receipt.imageEtag == "redacted",
              receipt.manifestEtag == "redacted",
              let envelope = report.envelope else {
            return nil
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return "OpenCode Go 推送成功：id=redacted image_etag=redacted manifest_etag=redacted "
            + "rendered_at=\(formatter.string(from: receipt.renderedAt)) "
            + "readback_verified=true schema_version=\(envelope.data.schemaVersion) "
            + "opencode_go_status=\(envelope.data.opencodeGo.status.rawValue)"
    }
}

enum CollectionPublicStatusFormatter {
    static func render(_ publicErrorCodes: [String: String]) -> String? {
        guard !publicErrorCodes.isEmpty else { return nil }
        let safe = publicErrorCodes
            .map { (MenuBarViewModel.safePublicCode($0.key), MenuBarViewModel.safePublicCode($0.value)) }
            .sorted { $0.0 < $1.0 }
            .map { "\($0.0)=\($0.1)" }
            .joined(separator: ",")
        return "状态：\(safe)"
    }
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
        case let value as CollectorError: value.publicCode
        case let value as CLIError: value.publicCode
        default: "internal_failure"
        }
    }
}

/// Runtime wiring is deliberately kept behind the parser: scheduled gating can
/// finish before any Keychain store, provider client, or worker is constructed.
private struct LaunchdInstallationGeneration: Equatable, Sendable {
    let menu: LaunchdJobGeneration
    let collector: LaunchdJobGeneration
}

struct CommandRuntime: Sendable {
    private let paths: InstallationPaths
    private let launchctl: any InstallationLaunchctlControlling
    private let executableURL: URL
    private let supervisor: CollectorProcessSupervisor
    private let menuBarHarness: Bool
    private let setupInput: @Sendable () throws -> SetupValues
    private let openCodeSetupInput: @Sendable (Bool) throws -> OpenCodeGoSetupValues
    private let codexLocator: @Sendable () throws -> URL
    private let setupPreflight: @Sendable (CollectorConfiguration, String) async throws -> Void
    private let openCodeSetupPreflight: @Sendable (String) async throws -> Void
    private let readExistingOpenCodeKey: @Sendable (CollectorConfiguration) -> String?
    private let readExistingCodexSlateURL: @Sendable (CollectorConfiguration) throws -> String
    private let setupPersistence: any SetupPersisting
    private let openCodeSetupPersistence: any OpenCodeGoSetupPersisting

    init(
        paths: InstallationPaths = .init(),
        launchctl: any InstallationLaunchctlControlling = SystemLaunchctlController(),
        executableURL: URL? = nil,
        supervisor: CollectorProcessSupervisor = .init(),
        menuBarHarness: Bool = ProcessInfo.processInfo.environment["SLATE_QUOTA_MENUBAR_TEST_HARNESS"] == "1",
        setupInput: @escaping @Sendable () throws -> SetupValues = {
            try SecretTerminalReader().readSetupValues()
        },
        openCodeSetupInput: @escaping @Sendable (Bool) throws -> OpenCodeGoSetupValues = {
            try SecretTerminalReader().readOpenCodeGoSetupValues(hasExistingKey: $0)
        },
        codexLocator: @escaping @Sendable () throws -> URL = CommandRuntime.locateCodexExecutable,
        setupPreflight: @escaping @Sendable (CollectorConfiguration, String) async throws -> Void = {
            configuration, _ in
            do { _ = try await CodexRateLimitClient(configuration: configuration).read() }
            catch { throw CLIError.setupPreflight(CommandRuntime.codexPreflightCode(error)) }
        },
        openCodeSetupPreflight: @escaping @Sendable (String) async throws -> Void = { key in
            do { _ = try await OpenCodeGoUsageClient().read(apiKey: key) }
            catch { throw CLIError.setupPreflight(CommandRuntime.openCodePreflightCode(error)) }
        },
        readExistingOpenCodeKey: @escaping @Sendable (CollectorConfiguration) -> String? = {
            try? KeychainStore(service: $0.keychainService).read(account: $0.openCodeKeyAccount)
        },
        readExistingCodexSlateURL: @escaping @Sendable (CollectorConfiguration) throws -> String = {
            try KeychainStore(service: $0.keychainService).read(account: $0.slateURLAccount)
        },
        setupPersistence: (any SetupPersisting)? = nil,
        openCodeSetupPersistence: (any OpenCodeGoSetupPersisting)? = nil
    ) {
        self.paths = paths
        self.launchctl = launchctl
        self.executableURL = executableURL ?? Self.currentExecutableURL()
        self.supervisor = supervisor
        self.menuBarHarness = menuBarHarness
        self.setupInput = setupInput
        self.openCodeSetupInput = openCodeSetupInput
        self.codexLocator = codexLocator
        self.setupPreflight = setupPreflight
        self.openCodeSetupPreflight = openCodeSetupPreflight
        self.readExistingOpenCodeKey = readExistingOpenCodeKey
        self.readExistingCodexSlateURL = readExistingCodexSlateURL
        self.setupPersistence = setupPersistence ?? TransactionalSetupPersistence(
            backend: SystemSetupMutationBackend(applicationSupportURL: paths.applicationSupportURL)
        )
        self.openCodeSetupPersistence = openCodeSetupPersistence
            ?? TransactionalOpenCodeGoSetupPersistence(
                backend: SystemSetupMutationBackend(applicationSupportURL: paths.applicationSupportURL)
            )
    }

    func run(_ command: CLIArguments) async throws {
        switch command {
        case .help:
            print(CLIArguments.visibleHelp)
        case .setup:
            try await setup()
        case .setupOpenCodeGo:
            try await setupOpenCodeGo()
        case let .collect(mode):
            let workerMode: CollectorWorkerMode = mode == .dryRun ? .dryRun : .pushOnceWithProof
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
        let input = try setupInput()
        guard input.slateURL == input.confirmedSlateURL else {
            throw CLIError.setupMismatch
        }
        let slateText = input.slateURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let slateURL = URL(string: slateText), slateURL.absoluteString == slateText else {
            throw CLIError.setupInput
        }
        do { _ = try SlateEndpointPolicy.validate(slateURL) }
        catch { throw CLIError.setupPreflight("slate_endpoint_invalid") }
        let codexExecutable = try codexLocator()
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
        try await setupPreflight(configuration, "")
        do {
            try setupPersistence.commitCodexOnly(
                configuration: configuration,
                slateURL: slateText
            )
        } catch SetupTransactionError.rollback {
            throw CLIError.setupRollback
        } catch CLIError.setupExistingItem {
            throw CLIError.setupExistingItem
        } catch {
            throw CLIError.configuration
        }
        print("配置完成，只读预检通过")
    }

    private func supervise(_ mode: CollectorWorkerMode) async throws {
        let result = try await supervisor.run(
            executableURL: executableURL,
            arguments: ["collect", "--worker", mode.rawValue],
            inheritedWorkerMode: mode.rawValue
        )
        switch result.outcome {
        case .exited(code: 0): return
        case .timedOut: throw CLIError.workerTimeout
        case .exited, .signaled: throw CLIError.workerFailure
        }
    }

    private func setupOpenCodeGo() async throws {
        let configuration = try loadConfiguration()
        let existingKey = readExistingOpenCodeKey(configuration)
        let input = try openCodeSetupInput(existingKey != nil)
        guard input.slateURL == input.confirmedSlateURL,
              input.openCodeKey == input.confirmedOpenCodeKey else {
            throw CLIError.setupMismatch
        }

        let slateText = input.slateURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let slateURL = URL(string: slateText), slateURL.absoluteString == slateText else {
            throw CLIError.setupInput
        }
        do { _ = try SlateEndpointPolicy.validate(slateURL) }
        catch { throw CLIError.setupPreflight("slate_endpoint_invalid") }
        let codexSlateText: String
        do {
            codexSlateText = try readExistingCodexSlateURL(configuration)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            throw CLIError.configuration
        }
        guard slateText != codexSlateText else {
            throw CLIError.setupPreflight("slate_endpoint_conflict")
        }

        let enteredKey = input.openCodeKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveKey = enteredKey.isEmpty ? existingKey : enteredKey
        guard let effectiveKey, !effectiveKey.isEmpty else { throw CLIError.setupInput }
        try await openCodeSetupPreflight(effectiveKey)

        do {
            try openCodeSetupPersistence.commit(
                service: configuration.keychainService,
                apiKeyAccount: configuration.openCodeKeyAccount,
                slateURLAccount: OpenCodeGoMonitorConfiguration.slateURLAccount,
                apiKey: enteredKey.isEmpty ? nil : effectiveKey,
                slateURL: slateText
            )
        } catch SetupTransactionError.rollback {
            throw CLIError.setupRollback
        } catch CLIError.setupExistingItem {
            throw CLIError.setupExistingItem
        } catch {
            throw CLIError.configuration
        }
        print("OpenCode Go 配置完成，只读预检通过")
    }

    private func runWorker(_ mode: CollectorWorkerMode) async throws {
        do { try WorkerParentAuthorization.consume(expectedMode: mode.rawValue) }
        catch { throw CLIError.workerAuthorization }
        guard let lock = try RunLock.acquire(at: paths.applicationSupportURL) else {
            // launchd or a manual collection already owns the single writer.
            return
        }
        defer { try? lock.release() }

        let configuration = try loadConfiguration()
        let secrets = KeychainStore(service: configuration.keychainService)
        let slateURL: String
        do {
            slateURL = try secrets.read(account: configuration.slateURLAccount)
        } catch {
            throw CLIError.configuration
        }
        let openCodeKey = try optionalSecret(
            secrets,
            account: configuration.openCodeKeyAccount
        )
        let openCodeSlateURL = try optionalSecret(
            secrets,
            account: OpenCodeGoMonitorConfiguration.slateURLAccount
        )
        let snapshots = SanitizedSnapshotCache(
            applicationSupportURL: paths.applicationSupportURL,
            sensitiveValues: RuntimeSensitiveValues.values(
                codexSlateURL: slateURL,
                openCodeKey: openCodeKey,
                openCodeSlateURL: openCodeSlateURL
            )
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
            slateURLAccount: configuration.slateURLAccount,
            codexTaskActivity: CodexTaskActivityClient(
                executableURL: URL(fileURLWithPath: configuration.codexExecutablePath)
            ),
            resetRadar: ResetRadarClient(),
            includeOpenCodeGo: false
        )
        let report = try await service.collect(mode: mode.serviceMode)
        let openCodeReport = try await OpenCodeGoCollectorService(
            openCodeGo: OpenCodeGoUsageClient(),
            normalizer: .shanghai,
            secrets: secrets,
            snapshots: snapshots,
            slate: SlateIngestClient(),
            openCodeKeyAccount: configuration.openCodeKeyAccount,
            slateURLAccount: OpenCodeGoMonitorConfiguration.slateURLAccount
        ).collect(mode: mode.serviceMode)
        if mode == .dryRun {
            for encoded in [
                try report.envelope.map { try JSONEncoder.slate.encode($0) },
                try openCodeReport.envelope.map { try JSONEncoder.slate.encode($0) },
            ].compactMap({ $0 }) {
                guard let text = String(data: encoded, encoding: .utf8) else {
                    throw CLIError.workerFailure
                }
                print(text)
            }
        }
        if mode == .pushOnceWithProof, let proof = PushOnceProofFormatter.render(report) {
            print(proof)
        }
        if mode == .pushOnceWithProof,
           let proof = OpenCodeGoPushOnceProofFormatter.render(openCodeReport) {
            print(proof)
        }
        var publicCodes = report.publicErrorCodes
        openCodeReport.publicErrorCodes.forEach { publicCodes[$0.key] = $0.value }
        if let status = CollectionPublicStatusFormatter.render(publicCodes) {
            FileHandle.standardError.write(Data("\(status)\n".utf8))
        }
        guard CollectionWorkerCompletionPolicy.accepts(
            mode: mode,
            codexReadbackVerified: report.readbackVerified,
            openCodeReadbackVerified: openCodeReport.readbackVerified
        ) else {
            throw CLIError.workerFailure
        }
    }

    private func optionalSecret(_ store: KeychainStore, account: String) throws -> String? {
        do {
            let value = try store.read(account: account)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? nil : value
        } catch let error as KeychainError where error.status == errSecItemNotFound {
            return nil
        } catch {
            throw CLIError.configuration
        }
    }

    private func install() async throws {
        let menuService = "gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)"
        let collectorService = "gui/\(getuid())/\(LaunchAgentInstaller.collectorLabel)"
        let appInstaller = AppBundleInstaller(paths: paths)
        let launchAgentInstaller = LaunchAgentInstaller(paths: paths)
        let previousApp = try appInstaller.captureGeneration()
        let previousAgents = try launchAgentInstaller.captureGeneration()
        let previousLaunchd = try await captureLaunchdGeneration(
            menuService: menuService, collectorService: collectorService
        )
        do {
            // A loaded old generation must be deliberately removed before its
            // replacement plist is published. Otherwise bootstrap can report
            // success merely because launchd still owns the old program.
            if previousLaunchd.collector.loaded {
                try await launchctl.bootout(service: collectorService)
            }
            if previousLaunchd.menu.loaded {
                try await launchctl.bootout(service: menuService)
            }
            _ = try appInstaller.install(executableURL: executableURL)
            let artifacts = try launchAgentInstaller.installPlists()
            try await launchctl.enable(service: menuService)
            try await launchctl.bootstrap(plistURL: artifacts.menuBarPlistURL)
            let enabled = try SettingsStore(applicationSupportURL: paths.applicationSupportURL)
                .load().automaticCollectionEnabled
            if enabled {
                try await launchctl.enable(service: collectorService)
                try await launchctl.bootstrap(plistURL: artifacts.collectorPlistURL)
            } else {
                try await launchctl.disable(service: collectorService)
                try await launchctl.bootout(service: collectorService)
            }
            let installed = try await captureLaunchdGeneration(
                menuService: menuService, collectorService: collectorService
            )
            let expected = LaunchdInstallationGeneration(
                menu: .init(loaded: true, disabledOverride: false),
                collector: .init(loaded: enabled, disabledOverride: !enabled)
            )
            guard installed == expected else { throw LaunchctlError.transport }
        } catch let forwardError {
            let rollbackSucceeded = await restoreInstallationGeneration(
                previousLaunchd,
                previousApp: previousApp,
                previousAgents: previousAgents,
                appInstaller: appInstaller,
                launchAgentInstaller: launchAgentInstaller,
                menuService: menuService,
                collectorService: collectorService
            )
            guard rollbackSucceeded else {
                throw LaunchctlError.rollback
            }
            throw forwardError
        }
        print("菜单栏与自动采集已安装")
    }

    private func uninstall() async throws {
        let menuService = "gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)"
        let collectorService = "gui/\(getuid())/\(LaunchAgentInstaller.collectorLabel)"
        let appInstaller = AppBundleInstaller(paths: paths)
        let launchAgentInstaller = LaunchAgentInstaller(paths: paths)
        let previousApp = try appInstaller.captureGeneration()
        let previousAgents = try launchAgentInstaller.captureGeneration()
        let previousLaunchd = try await captureLaunchdGeneration(
            menuService: menuService, collectorService: collectorService
        )
        var stopped = true
        do { try await launchctl.bootout(service: collectorService) }
        catch { stopped = false }
        do { try await launchctl.bootout(service: menuService) }
        catch { stopped = false }
        do {
            let current = try await captureLaunchdGeneration(
                menuService: menuService, collectorService: collectorService
            )
            let expectedStopped = LaunchdInstallationGeneration(
                menu: .init(
                    loaded: false,
                    disabledOverride: previousLaunchd.menu.disabledOverride
                ),
                collector: .init(
                    loaded: false,
                    disabledOverride: previousLaunchd.collector.disabledOverride
                )
            )
            if current != expectedStopped { stopped = false }
        } catch { stopped = false }
        guard stopped else {
            guard await restoreLaunchdGeneration(
                previousLaunchd, menuService: menuService, collectorService: collectorService
            ) else { throw LaunchctlError.rollback }
            throw LaunchctlError.transport
        }
        do {
            try launchAgentInstaller.removeGeneratedArtifacts()
        } catch let forwardError {
            var restored = true
            do { try launchAgentInstaller.restore(previousAgents) }
            catch { restored = false }
            do { try appInstaller.restore(previousApp) }
            catch { restored = false }
            if await !restoreLaunchdGeneration(
                previousLaunchd, menuService: menuService, collectorService: collectorService
            ) { restored = false }
            guard restored else { throw LaunchctlError.rollback }
            throw forwardError
        }
        print("程序已卸载；钥匙串、配置、开关与历史状态已保留")
    }

    private func captureLaunchdGeneration(
        menuService: String,
        collectorService: String
    ) async throws -> LaunchdInstallationGeneration {
        let menu = try await launchctl.installationState(service: menuService)
        let collector = try await launchctl.installationState(service: collectorService)
        return LaunchdInstallationGeneration(menu: menu, collector: collector)
    }

    /// Every rollback component is attempted even when an earlier operation
    /// fails. Callers receive only a closed rollback code, never launchctl text.
    private func restoreInstallationGeneration(
        _ generation: LaunchdInstallationGeneration,
        previousApp: AppBundleGeneration,
        previousAgents: LaunchAgentGeneration,
        appInstaller: AppBundleInstaller,
        launchAgentInstaller: LaunchAgentInstaller,
        menuService: String,
        collectorService: String
    ) async -> Bool {
        var restored = true
        do { try await launchctl.bootout(service: collectorService) }
        catch { restored = false }
        do { try await launchctl.bootout(service: menuService) }
        catch { restored = false }
        do { try launchAgentInstaller.restore(previousAgents) }
        catch { restored = false }
        do { try appInstaller.restore(previousApp) }
        catch { restored = false }
        if await !restoreLaunchdGeneration(
            generation, menuService: menuService, collectorService: collectorService
        ) { restored = false }
        return restored
    }

    private func restoreLaunchdGeneration(
        _ generation: LaunchdInstallationGeneration,
        menuService: String,
        collectorService: String
    ) async -> Bool {
        var restored = true
        await applyLaunchdGeneration(
            generation,
            menuService: menuService,
            collectorService: collectorService,
            succeeded: &restored
        )
        let firstPassExact: Bool
        do {
            firstPassExact = try await captureLaunchdGeneration(
                menuService: menuService, collectorService: collectorService
            ) == generation
        } catch {
            restored = false
            firstPassExact = false
        }
        if !firstPassExact {
            // An individual launchctl transport can fail after changing state
            // or before doing so. Repeat the complete idempotent restoration,
            // while preserving the fact that rollback encountered a failure.
            await applyLaunchdGeneration(
                generation,
                menuService: menuService,
                collectorService: collectorService,
                succeeded: &restored
            )
        }
        do {
            let current = try await captureLaunchdGeneration(
                menuService: menuService, collectorService: collectorService
            )
            if current != generation { restored = false }
        } catch { restored = false }
        return restored
    }

    private func applyLaunchdGeneration(
        _ generation: LaunchdInstallationGeneration,
        menuService: String,
        collectorService: String,
        succeeded: inout Bool
    ) async {
        if await !restoreLaunchdJob(
            generation.menu, service: menuService, plistURL: paths.menuBarPlistURL
        ) { succeeded = false }
        if await !restoreLaunchdJob(
            generation.collector,
            service: collectorService,
            plistURL: paths.collectorPlistURL
        ) { succeeded = false }
    }

    private func restoreLaunchdJob(
        _ generation: LaunchdJobGeneration,
        service: String,
        plistURL: URL
    ) async -> Bool {
        var restored = true
        if generation.loaded {
            // launchd may refuse to bootstrap a disabled label. Temporarily
            // enable it, load the exact plist, then restore the disabled bit.
            do { try await launchctl.enable(service: service) }
            catch { restored = false }
            do { try await launchctl.bootstrap(plistURL: plistURL) }
            catch { restored = false }
            if generation.disabledOverride {
                do { try await launchctl.disable(service: service) }
                catch { restored = false }
            }
        } else {
            do { try await launchctl.bootout(service: service) }
            catch { restored = false }
            do {
                if generation.disabledOverride {
                    try await launchctl.disable(service: service)
                } else {
                    try await launchctl.enable(service: service)
                }
            } catch { restored = false }
        }
        return restored
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
        print("重置雷达：\(MenuBarViewModel.safeRadarSummary(display.resetRadarSummary))")
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
            executableURL: menuBarWorkerExecutableURL,
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

    var menuBarWorkerExecutableURL: URL { paths.stableExecutableURL }

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
        var status = stat()
        guard resolved.path.hasPrefix("/"),
              lstat(resolved.path, &status) == 0,
              status.st_mode & S_IFMT == S_IFREG,
              access(resolved.path, R_OK | X_OK) == 0 else {
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

    static func openCodePreflightCode(_ error: any Error) -> String {
        switch error as? OpenCodeGoClientError {
        case .unauthorized: "opencode_unauthorized"
        case .subscriptionRequired: "opencode_subscription_required"
        case .rateLimited: "opencode_rate_limited"
        case .server: "opencode_server"
        case .timeout: "opencode_timeout"
        case .transport: "opencode_transport"
        case .invalidResponse: "opencode_invalid_response"
        case .http: "opencode_http"
        case nil: "opencode_preflight_failed"
        }
    }
}

struct SetupValues: Equatable, Sendable {
    let openCodeKey: String
    let confirmedOpenCodeKey: String
    let slateURL: String
    let confirmedSlateURL: String
}

struct OpenCodeGoSetupValues: Equatable, Sendable {
    let openCodeKey: String
    let confirmedOpenCodeKey: String
    let slateURL: String
    let confirmedSlateURL: String
}

enum OpenCodeGoMonitorConfiguration {
    static let slateURLAccount = "slate-opencode-go-push-url"
}

enum RuntimeSensitiveValues {
    static func values(
        codexSlateURL: String,
        openCodeKey: String?,
        openCodeSlateURL: String?
    ) -> [String] {
        [codexSlateURL, openCodeKey, openCodeSlateURL]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
}

enum CollectionWorkerCompletionPolicy {
    static func accepts(
        mode: CollectorWorkerMode,
        codexReadbackVerified: Bool,
        openCodeReadbackVerified: Bool
    ) -> Bool {
        if mode == .dryRun { return true }
        return codexReadbackVerified && openCodeReadbackVerified
    }
}

struct SetupSecretAttributes: Equatable, Sendable {
    let data: Data
    let accessible: String?
    let accessGroup: String?
    let synchronizable: Bool?
    let generic: Data?
    let label: String?
    let comment: String?
}

enum SetupSecretState: Equatable, Sendable {
    case absent
    case item(SetupSecretAttributes)
}

enum SetupConfigurationState: Equatable, Sendable {
    case absent
    case file(data: Data, mode: mode_t)
}

struct SetupGeneration: Equatable, Sendable {
    let openCodeKey: SetupSecretState
    let slateURL: SetupSecretState
    let configuration: SetupConfigurationState
}

enum SetupTransactionError: Error, Equatable, Sendable { case rollback }

protocol SetupPersisting: Sendable {
    func commit(
        configuration: CollectorConfiguration,
        openCodeKey: String,
        slateURL: String
    ) throws
    func commitCodexOnly(
        configuration: CollectorConfiguration,
        slateURL: String
    ) throws
}

protocol OpenCodeGoSetupPersisting: Sendable {
    func commit(
        service: String,
        apiKeyAccount: String,
        slateURLAccount: String,
        apiKey: String?,
        slateURL: String
    ) throws
}

protocol SetupMutationBacking: Sendable {
    func readSecret(service: String, account: String) throws -> SetupSecretState
    func writeSecretValue(_ value: String, service: String, account: String) throws
    func restoreSecret(_ state: SetupSecretState, service: String, account: String) throws
    func readConfiguration() throws -> SetupConfigurationState
    func writeConfiguration(_ data: Data) throws
    func restoreConfiguration(_ state: SetupConfigurationState) throws
}

/// Narrow low-level seam around Security.framework. Tests exercise the exact
/// production query/add/update/delete dictionaries without touching a user's
/// real Keychain.
protocol SetupSecurityItemBacking: Sendable {
    func copyMatching(_ query: [CFString: Any]) -> (OSStatus, Any?)
    func update(_ query: [CFString: Any], attributes: [CFString: Any]) -> OSStatus
    func add(_ item: [CFString: Any]) -> OSStatus
    func delete(_ query: [CFString: Any]) -> OSStatus
}

struct SystemSetupSecurityItemBackend: SetupSecurityItemBacking, Sendable {
    func copyMatching(_ query: [CFString: Any]) -> (OSStatus, Any?) {
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result)
    }

    func update(_ query: [CFString: Any], attributes: [CFString: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    func add(_ item: [CFString: Any]) -> OSStatus {
        SecItemAdd(item as CFDictionary, nil)
    }

    func delete(_ query: [CFString: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}

struct TransactionalSetupPersistence: SetupPersisting, Sendable {
    let backend: any SetupMutationBacking

    func commit(
        configuration: CollectorConfiguration,
        openCodeKey: String,
        slateURL: String
    ) throws {
        let previous = try SetupGeneration(
            openCodeKey: backend.readSecret(
                service: configuration.keychainService,
                account: configuration.openCodeKeyAccount
            ),
            slateURL: backend.readSecret(
                service: configuration.keychainService,
                account: configuration.slateURLAccount
            ),
            configuration: backend.readConfiguration()
        )
        do {
            try backend.writeSecretValue(
                openCodeKey,
                service: configuration.keychainService,
                account: configuration.openCodeKeyAccount
            )
            try backend.writeSecretValue(
                slateURL,
                service: configuration.keychainService,
                account: configuration.slateURLAccount
            )
            try backend.writeConfiguration(JSONEncoder().encode(configuration))
        } catch {
            var rollbackFailed = false
            do {
                try backend.restoreSecret(
                    previous.openCodeKey,
                    service: configuration.keychainService,
                    account: configuration.openCodeKeyAccount
                )
            } catch { rollbackFailed = true }
            do {
                try backend.restoreSecret(
                    previous.slateURL,
                    service: configuration.keychainService,
                    account: configuration.slateURLAccount
                )
            } catch { rollbackFailed = true }
            do { try backend.restoreConfiguration(previous.configuration) }
            catch { rollbackFailed = true }
            if rollbackFailed { throw SetupTransactionError.rollback }
            throw error
        }
    }

    func commitCodexOnly(
        configuration: CollectorConfiguration,
        slateURL: String
    ) throws {
        let previousSlate = try backend.readSecret(
            service: configuration.keychainService,
            account: configuration.slateURLAccount
        )
        let previousConfiguration = try backend.readConfiguration()
        do {
            try backend.writeSecretValue(
                slateURL,
                service: configuration.keychainService,
                account: configuration.slateURLAccount
            )
            try backend.writeConfiguration(JSONEncoder().encode(configuration))
        } catch {
            var rollbackFailed = false
            do {
                try backend.restoreSecret(
                    previousSlate,
                    service: configuration.keychainService,
                    account: configuration.slateURLAccount
                )
            } catch { rollbackFailed = true }
            do { try backend.restoreConfiguration(previousConfiguration) }
            catch { rollbackFailed = true }
            if rollbackFailed { throw SetupTransactionError.rollback }
            throw error
        }
    }
}

struct TransactionalOpenCodeGoSetupPersistence: OpenCodeGoSetupPersisting, Sendable {
    let backend: any SetupMutationBacking

    func commit(
        service: String,
        apiKeyAccount: String,
        slateURLAccount: String,
        apiKey: String?,
        slateURL: String
    ) throws {
        let previousKey = try apiKey.map { _ in
            try backend.readSecret(service: service, account: apiKeyAccount)
        }
        let previousSlate = try backend.readSecret(service: service, account: slateURLAccount)
        do {
            if let apiKey {
                try backend.writeSecretValue(apiKey, service: service, account: apiKeyAccount)
            }
            try backend.writeSecretValue(slateURL, service: service, account: slateURLAccount)
        } catch {
            var rollbackFailed = false
            if let previousKey {
                do {
                    try backend.restoreSecret(
                        previousKey,
                        service: service,
                        account: apiKeyAccount
                    )
                } catch { rollbackFailed = true }
            }
            do {
                try backend.restoreSecret(
                    previousSlate,
                    service: service,
                    account: slateURLAccount
                )
            } catch { rollbackFailed = true }
            if rollbackFailed { throw SetupTransactionError.rollback }
            throw error
        }
    }
}

struct SystemSetupMutationBackend: SetupMutationBacking, Sendable {
    let configurationStore: ConfigurationStore
    let security: any SetupSecurityItemBacking
    let expectedAccessGroup: String?

    init(
        applicationSupportURL: URL,
        security: any SetupSecurityItemBacking = SystemSetupSecurityItemBackend(),
        expectedAccessGroup: String? = SystemSetupMutationBackend.defaultAccessGroup()
    ) {
        configurationStore = ConfigurationStore(applicationSupportURL: applicationSupportURL)
        self.security = security
        self.expectedAccessGroup = expectedAccessGroup
    }

    func readSecret(service: String, account: String) throws -> SetupSecretState {
        let metadataQuery: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecAttrSynchronizable: kSecAttrSynchronizableAny,
            kSecReturnAttributes: true,
            kSecMatchLimit: kSecMatchLimitAll,
        ]
        let (status, result) = security.copyMatching(metadataQuery)
        if status == errSecItemNotFound { return .absent }
        guard status == errSecSuccess else {
            throw KeychainError(status: status == errSecSuccess ? errSecDecode : status)
        }
        guard let items = result as? [[CFString: Any]], items.count == 1,
              let metadata = items.first else {
            throw CLIError.setupExistingItem
        }
        try validateCanonicalSecretMetadata(
            metadata, expectedService: service, expectedAccount: account
        )

        // Apple explicitly rejects kSecReturnData together with
        // kSecMatchLimitAll for password items. First prove that exactly one
        // canonical generation exists using attributes only, then read that
        // one item's value with kSecMatchLimitOne.
        var valueQuery = metadataQuery
        valueQuery[kSecReturnData] = true
        valueQuery[kSecMatchLimit] = kSecMatchLimitOne
        let (valueStatus, valueResult) = security.copyMatching(valueQuery)
        guard valueStatus == errSecSuccess,
              let attributes = valueResult as? [CFString: Any] else {
            throw KeychainError(
                status: valueStatus == errSecSuccess ? errSecDecode : valueStatus
            )
        }
        return try canonicalSecret(
            attributes, expectedService: service, expectedAccount: account
        )
    }

    private func validateCanonicalSecretMetadata(
        _ attributes: [CFString: Any],
        expectedService: String,
        expectedAccount: String
    ) throws {
        let allowedKeys: Set<String> = [
            kSecClass, kSecAttrService, kSecAttrAccount,
            kSecAttrAccessible, kSecAttrSynchronizable, kSecAttrAccessGroup,
            kSecAttrCreationDate, kSecAttrModificationDate, kSecAttrLabel,
        ].map { $0 as String }.reduce(into: Set<String>()) { $0.insert($1) }
        let accessible = attributes[kSecAttrAccessible] as? String
        let label = attributes[kSecAttrLabel] as? String
        guard attributes.keys.allSatisfy({ allowedKeys.contains($0 as String) }),
              attributes[kSecClass] as? String == kSecClassGenericPassword as String,
              attributes[kSecAttrService] as? String == expectedService,
              attributes[kSecAttrAccount] as? String == expectedAccount,
              accessible == nil
                || accessible == kSecAttrAccessibleAfterFirstUnlock as String,
              ((attributes[kSecAttrSynchronizable] as? NSNumber)?.boolValue ?? false) == false,
              attributes[kSecAttrAccessGroup] as? String == expectedAccessGroup,
              label == nil || label == expectedService else {
            throw CLIError.setupExistingItem
        }
    }

    private func canonicalSecret(
        _ attributes: [CFString: Any],
        expectedService: String,
        expectedAccount: String
    ) throws -> SetupSecretState {
        // Creation/modification timestamps are normal read-only Security
        // metadata. They are deliberately ignored because SecItemAdd does not
        // accept them. Every other accepted key is part of the exact add
        // dictionary below; unknown or policy-bearing attributes fail closed.
        let allowedKeys: Set<String> = [
            kSecClass, kSecAttrService, kSecAttrAccount, kSecValueData,
            kSecAttrAccessible, kSecAttrSynchronizable, kSecAttrAccessGroup,
            kSecAttrCreationDate, kSecAttrModificationDate, kSecAttrLabel,
        ].map { $0 as String }.reduce(into: Set<String>()) { $0.insert($1) }
        let accessible = attributes[kSecAttrAccessible] as? String
        let label = attributes[kSecAttrLabel] as? String
        guard attributes.keys.allSatisfy({ allowedKeys.contains($0 as String) }),
              attributes[kSecClass] as? String == kSecClassGenericPassword as String,
              attributes[kSecAttrService] as? String == expectedService,
              attributes[kSecAttrAccount] as? String == expectedAccount,
              let data = attributes[kSecValueData] as? Data,
              String(data: data, encoding: .utf8) != nil,
              accessible == nil
                || accessible == kSecAttrAccessibleAfterFirstUnlock as String,
              label == nil || label == expectedService else {
            throw CLIError.setupExistingItem
        }
        let synchronizable = (attributes[kSecAttrSynchronizable] as? NSNumber)?.boolValue ?? false
        guard synchronizable == false else { throw CLIError.setupExistingItem }
        let accessGroup = attributes[kSecAttrAccessGroup] as? String
        if accessGroup != expectedAccessGroup {
            throw CLIError.setupExistingItem
        }
        return .item(SetupSecretAttributes(
            data: data,
            accessible: accessible,
            accessGroup: accessGroup,
            synchronizable: false,
            generic: nil,
            label: label,
            comment: nil
        ))
    }

    private static func defaultAccessGroup() -> String? {
        guard let task = SecTaskCreateFromSelf(nil) else { return nil }
        return SecTaskCopyValueForEntitlement(
            task, "application-identifier" as CFString, nil
        ) as? String
    }

    func writeSecretValue(_ value: String, service: String, account: String) throws {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecAttrSynchronizable: kSecAttrSynchronizableAny,
        ]
        let updateValues: [CFString: Any] = [
            kSecValueData: Data(value.utf8),
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let update = security.update(query, attributes: updateValues)
        switch update {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var item: [CFString: Any] = [
                kSecClass: kSecClassGenericPassword,
                kSecAttrService: service,
                kSecAttrAccount: account,
                kSecAttrSynchronizable: false,
            ]
            updateValues.forEach { item[$0.key] = $0.value }
            let add = security.add(item)
            guard add == errSecSuccess else { throw KeychainError(status: add) }
        default:
            throw KeychainError(status: update)
        }
    }

    func restoreSecret(_ state: SetupSecretState, service: String, account: String) throws {
        let deleteQuery: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecAttrSynchronizable: kSecAttrSynchronizableAny,
        ]
        let delete = security.delete(deleteQuery)
        guard delete == errSecSuccess || delete == errSecItemNotFound else {
            throw KeychainError(status: delete)
        }
        switch state {
        case .absent:
            return
        case let .item(snapshot):
            // Keychain access groups and synchronizable identity are not
            // generally mutable. Delete every forward-generation variant,
            // then recreate the captured item with its original attributes.
            var item: [CFString: Any] = [
                kSecClass: kSecClassGenericPassword,
                kSecAttrService: service,
                kSecAttrAccount: account,
                kSecValueData: snapshot.data,
            ]
            if let value = snapshot.accessible { item[kSecAttrAccessible] = value }
            if let value = snapshot.synchronizable { item[kSecAttrSynchronizable] = value }
            if let value = snapshot.generic { item[kSecAttrGeneric] = value }
            if let value = snapshot.label { item[kSecAttrLabel] = value }
            if let value = snapshot.comment { item[kSecAttrComment] = value }
            if let value = snapshot.accessGroup { item[kSecAttrAccessGroup] = value }
            let add = security.add(item)
            guard add == errSecSuccess else { throw KeychainError(status: add) }
        }
    }

    func readConfiguration() throws -> SetupConfigurationState {
        let url = configurationStore.configurationURL
        let descriptor = open(url.path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        if descriptor < 0, errno == ENOENT { return .absent }
        guard descriptor >= 0 else { throw CLIError.configuration }
        defer { _ = close(descriptor) }
        var status = stat()
        guard fstat(descriptor, &status) == 0,
              status.st_mode & S_IFMT == S_IFREG,
              status.st_uid == getuid(),
              status.st_size >= 0,
              status.st_size <= 64 * 1_024 else {
            throw CLIError.configuration
        }
        var data = Data(count: Int(status.st_size))
        let count = data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return 0 }
            return Darwin.read(descriptor, base, bytes.count)
        }
        guard count == data.count else { throw CLIError.configuration }
        return .file(data: data, mode: status.st_mode & 0o777)
    }

    func writeConfiguration(_ data: Data) throws {
        try writeConfigurationBytes(data, mode: 0o600)
    }

    func restoreConfiguration(_ state: SetupConfigurationState) throws {
        switch state {
        case .absent:
            try deleteConfiguration()
        case let .file(data, mode):
            try writeConfigurationBytes(data, mode: mode)
        }
    }

    private func writeConfigurationBytes(_ data: Data, mode: mode_t) throws {
        let url = configurationStore.configurationURL
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        var existing = stat()
        if lstat(url.path, &existing) == 0 {
            guard existing.st_mode & S_IFMT == S_IFREG,
                  existing.st_uid == getuid() else {
                throw CLIError.configuration
            }
        } else if errno != ENOENT {
            throw CLIError.configuration
        }
        let temporary = directory.appendingPathComponent(".setup-\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        do {
            try data.write(to: temporary, options: .withoutOverwriting)
            try FileManager.default.setAttributes(
                [.posixPermissions: Int(mode)], ofItemAtPath: temporary.path
            )
            if lstat(url.path, &existing) == 0 {
                _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
            } else {
                try FileManager.default.moveItem(at: temporary, to: url)
            }
            let published = open(url.path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
            guard published >= 0 else { throw CLIError.configuration }
            defer { _ = close(published) }
            var status = stat()
            guard fstat(published, &status) == 0,
                  status.st_mode & S_IFMT == S_IFREG,
                  status.st_uid == getuid(),
                  fchmod(published, mode) == 0 else {
                throw CLIError.configuration
            }
        } catch {
            throw CLIError.configuration
        }
    }

    func deleteConfiguration() throws {
        let url = configurationStore.configurationURL
        var status = stat()
        guard lstat(url.path, &status) == 0 else {
            if errno == ENOENT { return }
            throw CLIError.configuration
        }
        guard status.st_mode & S_IFMT == S_IFREG, status.st_uid == getuid() else {
            throw CLIError.configuration
        }
        do { try FileManager.default.removeItem(at: url) }
        catch { throw CLIError.configuration }
    }
}

private nonisolated(unsafe) var setupTerminalDescriptor: Int32 = -1
private nonisolated(unsafe) var setupTerminalOriginalState = termios()
private nonisolated(unsafe) var setupPreviousInterruptAction = sigaction()
private nonisolated(unsafe) var setupPreviousTerminateAction = sigaction()
private nonisolated(unsafe) var setupPreviousHangupAction = sigaction()

// Swift imports Darwin's `struct sigaction` and `sigaction(2)` under the
// same spelling. Give the C symbol an unambiguous Swift name so the complete
// action (handler, mask, and flags) can be snapshotted and restored verbatim.
@_silgen_name("sigaction")
private func setupSigaction(
    _ signalNumber: Int32,
    _ action: UnsafePointer<sigaction>?,
    _ previousAction: UnsafeMutablePointer<sigaction>?
) -> Int32

@_cdecl("slateQuotaRestoreTerminalAndReraise")
private func restoreSetupTerminalAndReraise(_ signalNumber: Int32) {
    if setupTerminalDescriptor >= 0 {
        _ = tcsetattr(setupTerminalDescriptor, TCSANOW, &setupTerminalOriginalState)
    }
    _ = setupSigaction(SIGINT, &setupPreviousInterruptAction, nil)
    _ = setupSigaction(SIGTERM, &setupPreviousTerminateAction, nil)
    _ = setupSigaction(SIGHUP, &setupPreviousHangupAction, nil)
    setupTerminalDescriptor = -1
    _ = Darwin.kill(getpid(), signalNumber)
}

private struct SecretTerminalReader {
    func readSetupValues() throws -> SetupValues {
        try withHiddenInput {
            SetupValues(
                openCodeKey: "",
                confirmedOpenCodeKey: "",
                slateURL: try read("Slate 推送 URL（输入不会显示）："),
                confirmedSlateURL: try read("再次输入 Slate 推送 URL：")
            )
        }
    }

    func readOpenCodeGoSetupValues(hasExistingKey: Bool) throws -> OpenCodeGoSetupValues {
        try withHiddenInput {
            let keyPrompt = hasExistingKey
                ? "OpenCode Go API Key（留空则保留现有值）："
                : "OpenCode Go API Key："
            let confirmationPrompt = hasExistingKey
                ? "再次输入 API Key（继续留空则保留现有值）："
                : "再次输入 OpenCode Go API Key："
            return OpenCodeGoSetupValues(
                openCodeKey: try read(keyPrompt),
                confirmedOpenCodeKey: try read(confirmationPrompt),
                slateURL: try read("OpenCode Go 的 Slate 推送 URL："),
                confirmedSlateURL: try read("再次输入 Slate 推送 URL：")
            )
        }
    }

    private func withHiddenInput<T>(_ body: () throws -> T) throws -> T {
        guard isatty(STDIN_FILENO) == 1 else { throw CLIError.setupInput }
        var original = termios()
        guard tcgetattr(STDIN_FILENO, &original) == 0 else { throw CLIError.setupInput }
        setupTerminalDescriptor = STDIN_FILENO
        setupTerminalOriginalState = original
        var hiddenAction = sigaction()
        sigemptyset(&hiddenAction.sa_mask)
        hiddenAction.sa_flags = 0
        hiddenAction.__sigaction_u.__sa_handler = restoreSetupTerminalAndReraise
        guard setupSigaction(SIGINT, nil, &setupPreviousInterruptAction) == 0,
              setupSigaction(SIGTERM, nil, &setupPreviousTerminateAction) == 0,
              setupSigaction(SIGHUP, nil, &setupPreviousHangupAction) == 0 else {
            setupTerminalDescriptor = -1
            throw CLIError.setupInput
        }
        guard setupSigaction(SIGINT, &hiddenAction, nil) == 0 else {
            setupTerminalDescriptor = -1
            throw CLIError.setupInput
        }
        guard setupSigaction(SIGTERM, &hiddenAction, nil) == 0 else {
            _ = setupSigaction(SIGINT, &setupPreviousInterruptAction, nil)
            setupTerminalDescriptor = -1
            throw CLIError.setupInput
        }
        guard setupSigaction(SIGHUP, &hiddenAction, nil) == 0 else {
            _ = setupSigaction(SIGTERM, &setupPreviousTerminateAction, nil)
            _ = setupSigaction(SIGINT, &setupPreviousInterruptAction, nil)
            setupTerminalDescriptor = -1
            throw CLIError.setupInput
        }
        var hidden = original
        hidden.c_lflag &= ~tcflag_t(ECHO)
        guard tcsetattr(STDIN_FILENO, TCSAFLUSH, &hidden) == 0 else {
            _ = setupSigaction(SIGINT, &setupPreviousInterruptAction, nil)
            _ = setupSigaction(SIGTERM, &setupPreviousTerminateAction, nil)
            _ = setupSigaction(SIGHUP, &setupPreviousHangupAction, nil)
            setupTerminalDescriptor = -1
            throw CLIError.setupInput
        }
        defer {
            _ = tcsetattr(STDIN_FILENO, TCSAFLUSH, &original)
            _ = setupSigaction(SIGINT, &setupPreviousInterruptAction, nil)
            _ = setupSigaction(SIGTERM, &setupPreviousTerminateAction, nil)
            _ = setupSigaction(SIGHUP, &setupPreviousHangupAction, nil)
            setupTerminalDescriptor = -1
            print("")
        }
        return try body()
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

final class RuntimeMenuBarActions: MenuBarActionHandling, @unchecked Sendable {
    typealias CollectOperation = @Sendable () async throws -> Void
    typealias MainActorOperation = @MainActor @Sendable () -> Void

    private let schedule: any CollectionScheduleControlling
    private let collectOperation: CollectOperation
    private let quitOperation: MainActorOperation
    private let busyFeedback: MainActorOperation
    private let stateLock = NSLock()
    private var collectionIsActive = false

    init(
        schedule: any CollectionScheduleControlling,
        executableURL: URL,
        supervisor: CollectorProcessSupervisor,
        quitOperation: @escaping MainActorOperation = { NSApplication.shared.terminate(nil) },
        busyFeedback: @escaping MainActorOperation = { NSSound.beep() }
    ) {
        self.schedule = schedule
        self.quitOperation = quitOperation
        self.busyFeedback = busyFeedback
        collectOperation = {
            let result = try await supervisor.run(
                executableURL: executableURL,
                arguments: ["collect", "--worker", CollectorWorkerMode.pushOnce.rawValue],
                inheritedWorkerMode: CollectorWorkerMode.pushOnce.rawValue
            )
            switch result.outcome {
            case .exited(code: 0): return
            case .timedOut: throw CLIError.workerTimeout
            case .exited, .signaled: throw CLIError.workerFailure
            }
        }
    }

    init(
        schedule: any CollectionScheduleControlling,
        collectOperation: @escaping CollectOperation,
        quitOperation: @escaping MainActorOperation,
        busyFeedback: @escaping MainActorOperation = {}
    ) {
        self.schedule = schedule
        self.collectOperation = collectOperation
        self.quitOperation = quitOperation
        self.busyFeedback = busyFeedback
    }

    func pause() async throws { try await schedule.pause() }
    func resume() async throws { try await schedule.resume() }

    func collectOnce() async throws {
        guard beginCollection() else { throw CLIError.workerFailure }
        defer { endCollection() }
        try await collectOperation()
    }

    @MainActor func quitMenuBar() {
        stateLock.lock()
        let isBusy = collectionIsActive
        stateLock.unlock()
        if isBusy {
            busyFeedback()
        } else {
            quitOperation()
        }
    }

    private func beginCollection() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard !collectionIsActive else { return false }
        collectionIsActive = true
        return true
    }

    private func endCollection() {
        stateLock.lock()
        collectionIsActive = false
        stateLock.unlock()
    }
}
