import Foundation

enum CodexTaskState: String, Codable, Equatable, Sendable {
    case running
    case turnCompleted = "turn_completed"
    case failed
    case interrupted

    var label: String {
        switch self {
        case .running: "执行中"
        case .turnCompleted: "本轮完成"
        case .failed: "失败"
        case .interrupted: "已中断"
        }
    }

    var priority: Int {
        switch self {
        case .running: 0
        case .failed: 1
        case .interrupted: 2
        case .turnCompleted: 3
        }
    }
}

enum CodexTaskActivityAvailability: String, Codable, Equatable, Sendable {
    case available
    case unavailable
}

struct CodexTaskMetadata: Equatable, Sendable {
    let id: String
    let sessionID: String
    let title: String
    let parentThreadID: String?
}

struct CodexTaskMetadataPage: Equatable, Sendable {
    let tasks: [CodexTaskMetadata]
    let nextCursor: String?
}

struct CodexTaskLifecycleEvent: Codable, Equatable, Sendable {
    let correlationIDs: [String]
    let kind: CodexTaskState
    let observedAt: Date
}

struct CodexTaskRow: Codable, Equatable, Sendable {
    let title: String
    let state: CodexTaskState
    let activityAt: Date
}

struct CodexTaskDisplayRow: Codable, Equatable, Sendable {
    let visible: Bool
    let normalVisible: Bool
    let staleVisible: Bool
    let stateLabel: String
    let title: String

    static let hidden = Self(
        visible: false,
        normalVisible: false,
        staleVisible: false,
        stateLabel: "",
        title: ""
    )
}

struct CodexTaskActivityDisplaySnapshot: Codable, Equatable, Sendable {
    let availability: CodexTaskActivityAvailability
    let stale: Bool
    let row1: CodexTaskDisplayRow
    let row2: CodexTaskDisplayRow
    let row3: CodexTaskDisplayRow
    let hiddenCount: Int
    let hiddenText: String
    let staleLabel: String
    let unavailableTitle: String
    let unavailableDetail: String
    let showUnavailable: Bool
    let showStale: Bool

    var rows: [CodexTaskRow] { storedRows }

    private let storedRows: [CodexTaskRow]

    static let unavailable = Self(
        availability: .unavailable,
        stale: false,
        rows: [],
        hiddenCount: 0
    )

    init(
        availability: CodexTaskActivityAvailability,
        stale: Bool,
        rows: [CodexTaskRow],
        hiddenCount: Int
    ) {
        let visibleRows = Array(rows.prefix(3))
        self.availability = availability
        self.stale = stale
        storedRows = visibleRows
        row1 = Self.displayRow(visibleRows, at: 0, stale: stale)
        row2 = Self.displayRow(visibleRows, at: 1, stale: stale)
        row3 = Self.displayRow(visibleRows, at: 2, stale: stale)
        self.hiddenCount = max(0, hiddenCount)
        hiddenText = hiddenCount > 0 ? "另有 \(hiddenCount) 项" : ""
        staleLabel = stale ? "任务数据可能已过期" : ""
        unavailableTitle = availability == .unavailable ? "状态暂不可用" : ""
        unavailableDetail = availability == .unavailable ? "请检查插件兼容性" : ""
        showUnavailable = availability == .unavailable
        showStale = stale && availability == .available
    }

    func markedStale() -> Self {
        Self(
            availability: availability,
            stale: availability == .available,
            rows: storedRows,
            hiddenCount: hiddenCount
        )
    }

    private static func displayRow(
        _ rows: [CodexTaskRow],
        at index: Int,
        stale: Bool
    ) -> CodexTaskDisplayRow {
        guard rows.indices.contains(index) else { return .hidden }
        return CodexTaskDisplayRow(
            visible: true,
            normalVisible: !stale,
            staleVisible: stale,
            stateLabel: rows[index].state.label,
            title: rows[index].title
        )
    }
}

enum CodexTaskActivityReducer {
    static func reduce(
        metadata: [CodexTaskMetadata],
        events: [CodexTaskLifecycleEvent],
        now: Date
    ) -> CodexTaskActivityDisplaySnapshot {
        let metadataByID = Dictionary(uniqueKeysWithValues: metadata.map { ($0.id, $0) })
        var aliasToID: [String: String] = [:]
        for task in metadata {
            aliasToID[task.id] = task.id
            aliasToID[task.sessionID] = task.id
        }

        var latestByTopLevelID: [String: CodexTaskLifecycleEvent] = [:]
        for event in events {
            for correlation in event.correlationIDs {
                guard var taskID = aliasToID[correlation], metadataByID[taskID] != nil else { continue }
                var visited = Set<String>()
                while let parent = metadataByID[taskID]?.parentThreadID,
                      metadataByID[parent] != nil,
                      visited.insert(taskID).inserted {
                    taskID = parent
                }
                if latestByTopLevelID[taskID].map({ $0.observedAt <= event.observedAt }) ?? true {
                    latestByTopLevelID[taskID] = event
                }
            }
        }

        var rows: [CodexTaskRow] = []
        for task in metadata where task.parentThreadID == nil {
            guard let event = latestByTopLevelID[task.id] else { continue }
            let age = now.timeIntervalSince(event.observedAt)
            guard age >= 0 else { continue }
            if event.kind == .running, age > 120 { continue }
            if event.kind != .running, age > 24 * 60 * 60 { continue }
            rows.append(.init(title: task.title, state: event.kind, activityAt: event.observedAt))
        }
        rows.sort {
            if $0.state.priority != $1.state.priority {
                return $0.state.priority < $1.state.priority
            }
            return $0.activityAt > $1.activityAt
        }
        let hiddenCount = max(0, rows.count - 3)
        return CodexTaskActivityDisplaySnapshot(
            availability: .available,
            stale: false,
            rows: Array(rows.prefix(3)),
            hiddenCount: hiddenCount
        )
    }
}

protocol CodexTaskActivityReading: Sendable {
    func read(now: Date) async throws -> CodexTaskActivityDisplaySnapshot
}

struct UnavailableCodexTaskActivityReader: CodexTaskActivityReading, Sendable {
    func read(now: Date) async throws -> CodexTaskActivityDisplaySnapshot {
        _ = now
        return .unavailable
    }
}
