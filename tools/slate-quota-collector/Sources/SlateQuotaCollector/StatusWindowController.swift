import AppKit
import Foundation

@MainActor
final class StatusWindowController {
    private let shouldCreatePanel: Bool
    private var panel: NSPanel?
    private var textLabel: NSTextField?
    private(set) var renderedText = ""

    init(createPanel: Bool = true) {
        shouldCreatePanel = createPanel
    }

    func show(snapshot: MenuBarStatusSnapshot, schedule: AutomaticCollectionStatus) {
        renderedText = Self.detailText(snapshot: snapshot, schedule: schedule)
        guard shouldCreatePanel else { return }
        ensurePanel()
        textLabel?.stringValue = renderedText
        panel?.center()
        panel?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    static func detailText(
        snapshot: MenuBarStatusSnapshot,
        schedule: AutomaticCollectionStatus
    ) -> String {
        let automaticText: String
        switch schedule {
        case .enabledLoaded: automaticText = "已开启"
        case .enabledNotLoaded: automaticText = "已开启（等待加载）"
        case .disabled: automaticText = "已关闭"
        case let .transitioning(label):
            automaticText = MenuBarViewModel.safePublicTransition(label)
        }

        let successText = snapshot.lastSuccessAt.map { MenuBarViewModel.dateText($0) } ?? "尚无记录"
        let pushText = snapshot.lastPushAt.map { MenuBarViewModel.dateText($0) } ?? "尚无记录"
        var lines = [
            "Slate 额度监控",
            "",
            "自动采集：\(automaticText)",
            "Codex：\(MenuBarViewModel.safeProviderSummary(snapshot.codexSummary))",
            "OpenCode Go：\(MenuBarViewModel.safeProviderSummary(snapshot.openCodeGoSummary))",
            "最近成功：\(successText)",
            "最近推送：\(pushText)",
            "",
            "错误码：",
        ]
        if snapshot.publicErrorCodes.isEmpty {
            lines.append("无")
        } else {
            for (provider, code) in snapshot.publicErrorCodes.sorted(by: { $0.key < $1.key }) {
                lines.append("\(Self.safeProviderName(provider))：\(MenuBarViewModel.safePublicCode(code))")
            }
        }
        return lines.joined(separator: "\n")
    }

    private static func safeProviderName(_ value: String) -> String {
        switch value {
        case "codex": "codex"
        case "opencode_go": "opencode_go"
        case "slate": "slate"
        case "cache": "cache"
        case "schedule": "schedule"
        default: "collector"
        }
    }

    private func ensurePanel() {
        guard panel == nil else { return }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 340),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        panel.title = "Slate 额度监控"
        panel.isReleasedWhenClosed = false
        panel.level = .floating

        let label = NSTextField(wrappingLabelWithString: renderedText)
        label.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        label.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView?.addSubview(label)
        if let contentView = panel.contentView {
            NSLayoutConstraint.activate([
                label.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 24),
                label.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -24),
                label.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 24),
                label.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -24),
            ])
        }
        self.panel = panel
        textLabel = label
    }
}

private extension MenuBarViewModel {
    static func safePublicTransition(_ value: String) -> String {
        switch value {
        case "正在关闭": "正在关闭"
        case "正在开启": "正在开启"
        default: "正在切换"
        }
    }
}
