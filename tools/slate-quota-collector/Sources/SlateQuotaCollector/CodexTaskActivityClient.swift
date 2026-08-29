import Foundation

struct CodexTaskMetadataClient: Sendable {
    private static let responseID = 3
    private static let timeout: Duration = .seconds(20)
    private static let maximumPages = 100

    private let executableURL: URL
    private let transport: any CodexAppServerTransport

    init(
        executableURL: URL,
        transport: any CodexAppServerTransport = CodexAppServerProcessTransport()
    ) {
        self.executableURL = executableURL
        self.transport = transport
    }

    func read() async throws -> CodexTaskMetadataPage {
        var cursor: String?
        var seenCursors = Set<String>()
        var tasks: [CodexTaskMetadata] = []
        for _ in 0 ..< Self.maximumPages {
            let response = try await transport.request(
                executableURL: executableURL,
                lines: try Self.requestLines(cursor: cursor),
                responseID: Self.responseID,
                timeout: Self.timeout
            )
            let page = try Self.decode(response)
            tasks.append(contentsOf: page.tasks)
            guard let nextCursor = page.nextCursor, !nextCursor.isEmpty else {
                return CodexTaskMetadataPage(tasks: tasks, nextCursor: nil)
            }
            guard seenCursors.insert(nextCursor).inserted else {
                throw CodexClientError.invalidResponse
            }
            cursor = nextCursor
        }
        throw CodexClientError.invalidResponse
    }

    private static func requestLines(cursor: String?) throws -> [Data] {
        let cursorValue: Any
        if let cursor {
            cursorValue = cursor
        } else {
            cursorValue = NSNull()
        }
        let initialize: [String: Any] = [
            "method": "initialize",
            "id": 1,
            "params": [
                "clientInfo": [
                    "name": "slate_quota_collector",
                    "title": "Slate quota collector",
                    "version": "1.0.0",
                ],
            ],
        ]
        let initialized: [String: Any] = ["method": "initialized", "params": [:]]
        let list: [String: Any] = [
            "method": "thread/list",
            "id": responseID,
            "params": [
                "cursor": cursorValue,
                "limit": 100,
                "sortKey": "updated_at",
                "sortDirection": "desc",
                "archived": false,
                "sourceKinds": [
                    "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
                    "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
                ],
                "useStateDbOnly": true,
            ],
        ]
        do {
            return try [initialize, initialized, list].map {
                var data = try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys])
                data.append(0x0A)
                return data
            }
        } catch {
            throw CodexClientError.invalidResponse
        }
    }

    static func decode(_ data: Data) throws -> CodexTaskMetadataPage {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["id"] as? NSNumber)?.intValue == responseID,
              root["error"] == nil,
              let result = root["result"] as? [String: Any],
              let records = result["data"] as? [Any] else {
            throw CodexClientError.invalidResponse
        }
        let tasks = records.compactMap(Self.decodeTask)
        guard records.isEmpty || !tasks.isEmpty else { throw CodexClientError.invalidResponse }
        let nextCursor = result["nextCursor"] as? String
        return CodexTaskMetadataPage(tasks: tasks, nextCursor: nextCursor)
    }

    private static func decodeTask(_ raw: Any) -> CodexTaskMetadata? {
        guard let task = raw as? [String: Any],
              let id = task["id"] as? String, !id.isEmpty,
              let sessionID = task["sessionId"] as? String, !sessionID.isEmpty,
              let name = (task["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !name.isEmpty,
              isRecognizedSource(task["source"]) else { return nil }
        let parent = (task["parentThreadId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return CodexTaskMetadata(id: id, sessionID: sessionID, title: name, parentThreadID: parent)
    }

    private static func isRecognizedSource(_ raw: Any?) -> Bool {
        if let source = raw as? String {
            return ["cli", "vscode", "exec", "appServer", "unknown"].contains(source)
        }
        guard let source = raw as? [String: Any] else { return false }
        return source["custom"] is String || source["subAgent"] != nil
    }
}

enum CodexRolloutParser {
    static func parse(_ data: Data) -> [CodexTaskLifecycleEvent] {
        var correlations: [String] = []
        var events: [CodexTaskLifecycleEvent] = []
        for line in data.split(separator: 0x0A) {
            parseLine(Data(line), correlations: &correlations, events: &events)
        }
        return events
    }

    static func parseLine(
        _ data: Data,
        correlations: inout [String],
        events: inout [CodexTaskLifecycleEvent]
    ) {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let envelopeType = root["type"] as? String,
              let payload = root["payload"] as? [String: Any] else { return }
        if envelopeType == "session_meta" {
            for key in ["id", "session_id"] {
                if let value = payload[key] as? String, !value.isEmpty, !correlations.contains(value) {
                    correlations.append(value)
                }
            }
            return
        }
        guard envelopeType == "event_msg", !correlations.isEmpty,
              let payloadType = payload["type"] as? String else { return }

        let kind: CodexTaskState
        let timestampKey: String
        switch payloadType {
        case "task_started":
            kind = .running
            timestampKey = "started_at"
        case "task_complete":
            let error = payload["error"]
            kind = error == nil || error is NSNull ? .turnCompleted : .failed
            timestampKey = "completed_at"
        case "turn_aborted" where payload["reason"] as? String == "interrupted":
            kind = .interrupted
            timestampKey = "completed_at"
        default:
            return
        }
        guard let observedAt = date(payload[timestampKey]) else { return }
        events.append(.init(correlationIDs: correlations, kind: kind, observedAt: observedAt))
    }

    private static func date(_ raw: Any?) -> Date? {
        if let number = raw as? NSNumber {
            return Date(timeIntervalSince1970: number.doubleValue)
        }
        guard let text = raw as? String else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let value = fractional.date(from: text) { return value }
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        return ordinary.date(from: text)
    }
}

struct ReadonlyCodexRolloutObserver: Sendable {
    private static let lookback: TimeInterval = 24 * 60 * 60
    private let codexHome: URL

    init(codexHome: URL) {
        self.codexHome = codexHome
    }

    func observe(now: Date) throws -> [CodexTaskLifecycleEvent] {
        let sessions = codexHome.appendingPathComponent("sessions", isDirectory: true)
        let properties: [URLResourceKey] = [
            .isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .contentModificationDateKey,
        ]
        guard let enumerator = FileManager.default.enumerator(
            at: sessions,
            includingPropertiesForKeys: properties,
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else {
            throw CodexClientError.invalidResponse
        }

        var paths: [URL] = []
        for case let url as URL in enumerator {
            let values = try url.resourceValues(forKeys: Set(properties))
            if values.isSymbolicLink == true {
                if values.isDirectory == true { enumerator.skipDescendants() }
                continue
            }
            guard values.isRegularFile == true,
                  url.lastPathComponent.hasPrefix("rollout-"),
                  url.pathExtension == "jsonl",
                  let modifiedAt = values.contentModificationDate,
                  now.timeIntervalSince(modifiedAt) <= Self.lookback else { continue }
            paths.append(url)
        }
        paths.sort { $0.path < $1.path }
        return try paths.flatMap(Self.readEvents)
    }

    private static func readEvents(_ url: URL) throws -> [CodexTaskLifecycleEvent] {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var buffer = Data()
        var correlations: [String] = []
        var events: [CodexTaskLifecycleEvent] = []
        while let chunk = try handle.read(upToCount: 64 * 1_024), !chunk.isEmpty {
            buffer.append(chunk)
            while let newline = buffer.firstIndex(of: 0x0A) {
                CodexRolloutParser.parseLine(
                    Data(buffer[..<newline]),
                    correlations: &correlations,
                    events: &events
                )
                buffer.removeSubrange(...newline)
            }
        }
        if !buffer.isEmpty {
            CodexRolloutParser.parseLine(
                buffer,
                correlations: &correlations,
                events: &events
            )
        }
        return events
    }
}

struct CodexTaskActivityClient: CodexTaskActivityReading, Sendable {
    private let metadata: CodexTaskMetadataClient
    private let rollouts: ReadonlyCodexRolloutObserver

    init(
        executableURL: URL,
        codexHome: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex", isDirectory: true),
        transport: any CodexAppServerTransport = CodexAppServerProcessTransport()
    ) {
        metadata = CodexTaskMetadataClient(executableURL: executableURL, transport: transport)
        rollouts = ReadonlyCodexRolloutObserver(codexHome: codexHome)
    }

    func read(now: Date) async throws -> CodexTaskActivityDisplaySnapshot {
        let page = try await metadata.read()
        let events = try rollouts.observe(now: now)
        return CodexTaskActivityReducer.reduce(metadata: page.tasks, events: events, now: now)
    }
}
