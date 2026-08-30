import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite struct CodexTaskActivityTests {
    private let now = Date(timeIntervalSince1970: 1_788_003_600)

    @Test func threadListAcceptsAdditiveFieldsAndSkipsUnsupportedRows() throws {
        let data = Data(#"{"id":3,"result":{"data":[{"id":"parent","sessionId":"session-parent","name":"严格移植 Slate UI","parentThreadId":null,"source":"appServer","future":"ignored"},{"id":"child","sessionId":"session-child","name":"检查测试","parentThreadId":"parent","source":{"subAgent":"review"}},{"future":"unsupported"}],"nextCursor":"cursor-2","additive":true}}"#.utf8)

        let page = try CodexTaskMetadataClient.decode(data)

        #expect(page.tasks.count == 2)
        #expect(page.tasks[0].title == "严格移植 Slate UI")
        #expect(page.tasks[1].parentThreadID == "parent")
        #expect(page.nextCursor == "cursor-2")
    }

    @Test func threadListRejectsNonemptyEntirelyUnsupportedPage() {
        let data = Data(#"{"id":3,"result":{"data":[{"future":"unsupported"}],"nextCursor":null}}"#.utf8)
        #expect(throws: CodexClientError.invalidResponse) {
            try CodexTaskMetadataClient.decode(data)
        }
    }

    @Test func threadListReadsEveryPageSoLateParentsAreAvailable() async throws {
        let transport = PaginatedTaskTransport(responses: [
            Data(#"{"id":3,"result":{"data":[{"id":"child","sessionId":"session-child","name":"子任务","parentThreadId":"parent","source":{"subAgent":"review"}}],"nextCursor":"cursor-2"}}"#.utf8),
            Data(#"{"id":3,"result":{"data":[{"id":"parent","sessionId":"session-parent","name":"主任务","parentThreadId":null,"source":"appServer"}],"nextCursor":null}}"#.utf8),
        ])
        let client = CodexTaskMetadataClient(
            executableURL: URL(fileURLWithPath: "/usr/bin/codex"),
            transport: transport
        )

        let page = try await client.read()

        #expect(page.tasks.map(\.id) == ["child", "parent"])
        #expect(page.nextCursor == nil)
        #expect(await transport.cursors == [nil, "cursor-2"])
    }

    @Test func rolloutParserKeepsOnlyLifecycleSemantics() throws {
        let text = """
        {malformed PRIVATE_PROMPT}
        {"type":"event_msg","payload":{"type":"task_started","started_at":1788003000,"message":"PRIVATE_PROMPT"}}
        {"type":"session_meta","payload":{"id":"parent","session_id":"session-parent","cwd":"PRIVATE_PATH"}}
        {"type":"event_msg","payload":{"type":"task_started","started_at":1788003010,"message":"PRIVATE_PROMPT"}}
        {"type":"event_msg","payload":{"type":"agent_message","message":"PRIVATE_RESPONSE"}}
        {"type":"event_msg","payload":{"type":"task_complete","completed_at":1788003020,"error":{"message":"PRIVATE_ERROR"}}}
        """

        let events = CodexRolloutParser.parse(Data(text.utf8))

        #expect(events == [
            .init(correlationIDs: ["parent", "session-parent"], kind: .running, observedAt: Date(timeIntervalSince1970: 1_788_003_010)),
            .init(correlationIDs: ["parent", "session-parent"], kind: .failed, observedAt: Date(timeIntervalSince1970: 1_788_003_020)),
        ])
        let encoded = try JSONEncoder().encode(events)
        let persisted = try #require(String(data: encoded, encoding: .utf8))
        for privateValue in ["PRIVATE_PROMPT", "PRIVATE_PATH", "PRIVATE_RESPONSE", "PRIVATE_ERROR"] {
            #expect(persisted.contains(privateValue) == false)
        }
    }

    @Test func rolloutParserTreatsExplicitNullErrorAsSuccessfulCompletion() {
        let text = """
        {"type":"session_meta","payload":{"id":"parent"}}
        {"type":"event_msg","payload":{"type":"task_complete","completed_at":1788003020,"error":null}}
        """

        let events = CodexRolloutParser.parse(Data(text.utf8))

        #expect(events == [
            .init(
                correlationIDs: ["parent"],
                kind: .turnCompleted,
                observedAt: Date(timeIntervalSince1970: 1_788_003_020)
            ),
        ])
    }

    @Test func rolloutObserverBoundsLargeFilesToMetadataPrefixAndRecentTail() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let sessions = root.appendingPathComponent("sessions", isDirectory: true)
        try FileManager.default.createDirectory(at: sessions, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let rollout = sessions.appendingPathComponent("rollout-bounded.jsonl")
        var contents = Data(#"{"type":"session_meta","payload":{"id":"parent"}}"#.utf8)
        contents.append(0x0A)
        contents.append(Data(repeating: UInt8(ascii: "x"), count: 96))
        contents.append(0x0A)
        contents.append(Data(#"{"type":"event_msg","payload":{"type":"task_complete","completed_at":1788003010,"error":null}}"#.utf8))
        contents.append(0x0A)
        contents.append(Data(repeating: UInt8(ascii: "y"), count: 256))
        contents.append(0x0A)
        contents.append(Data(#"{"type":"event_msg","payload":{"type":"task_started","started_at":1788003020}}"#.utf8))
        contents.append(0x0A)
        try contents.write(to: rollout, options: .atomic)

        let observer = ReadonlyCodexRolloutObserver(
            codexHome: root,
            maximumCandidateFiles: 8,
            prefixBytes: 64,
            tailBytes: 128,
            maximumLineBytes: 128
        )

        let events = try observer.observe(now: now)

        #expect(events == [
            .init(
                correlationIDs: ["parent"],
                kind: .running,
                observedAt: Date(timeIntervalSince1970: 1_788_003_020)
            ),
        ])
    }

    @Test func reducerMapsChildActivityToParentAndSortsLikeUpstream() {
        let metadata = [
            CodexTaskMetadata(id: "running", sessionID: "running-session", title: "执行中的任务", parentThreadID: nil),
            CodexTaskMetadata(id: "failed", sessionID: "failed-session", title: "失败的任务", parentThreadID: nil),
            CodexTaskMetadata(id: "interrupted", sessionID: "interrupted-session", title: "中断的任务", parentThreadID: nil),
            CodexTaskMetadata(id: "complete", sessionID: "complete-session", title: "完成的任务", parentThreadID: nil),
            CodexTaskMetadata(id: "child", sessionID: "child-session", title: "子任务", parentThreadID: "failed"),
            CodexTaskMetadata(id: "old-running", sessionID: "old-running-session", title: "超时执行中", parentThreadID: nil),
        ]
        let events = [
            CodexTaskLifecycleEvent(correlationIDs: ["running"], kind: .running, observedAt: now.addingTimeInterval(-119)),
            CodexTaskLifecycleEvent(correlationIDs: ["child"], kind: .failed, observedAt: now.addingTimeInterval(-20)),
            CodexTaskLifecycleEvent(correlationIDs: ["interrupted"], kind: .interrupted, observedAt: now.addingTimeInterval(-10)),
            CodexTaskLifecycleEvent(correlationIDs: ["complete"], kind: .turnCompleted, observedAt: now.addingTimeInterval(-5)),
            CodexTaskLifecycleEvent(correlationIDs: ["old-running"], kind: .running, observedAt: now.addingTimeInterval(-121)),
        ]

        let result = CodexTaskActivityReducer.reduce(metadata: metadata, events: events, now: now)

        #expect(result.rows.map(\.state) == [.running, .failed, .interrupted])
        #expect(result.rows.map(\.title) == ["执行中的任务", "失败的任务", "中断的任务"])
        #expect(result.hiddenCount == 1)
        #expect(result.row1.stateLabel == "执行中")
        #expect(result.row2.stateLabel == "失败")
        #expect(result.row3.stateLabel == "已中断")
        #expect(result.hiddenText == "另有 1 项")
    }

    @Test func reducerMarksUnavailableAndStaleWithoutInventingTasks() {
        #expect(CodexTaskActivityDisplaySnapshot.unavailable.availability == .unavailable)
        #expect(CodexTaskActivityDisplaySnapshot.unavailable.row1.visible == false)

        let cached = CodexTaskActivityDisplaySnapshot(
            availability: .available,
            stale: false,
            rows: [.init(title: "上次任务", state: .turnCompleted, activityAt: now)],
            hiddenCount: 0
        )
        let stale = cached.markedStale()
        #expect(stale.stale)
        #expect(stale.row1.title == "上次任务")
        #expect(stale.staleLabel == "任务数据可能已过期")
    }
}

private actor PaginatedTaskTransport: CodexAppServerTransport {
    private var responses: [Data]
    private(set) var cursors: [String?] = []

    init(responses: [Data]) {
        self.responses = responses
    }

    func request(
        executableURL _: URL,
        lines: [Data],
        responseID _: Int,
        timeout _: Duration
    ) async throws -> Data {
        guard let request = lines.last,
              let object = try? JSONSerialization.jsonObject(with: request) as? [String: Any],
              let params = object["params"] as? [String: Any],
              !responses.isEmpty else {
            throw CodexClientError.invalidResponse
        }
        let rawCursor = params["cursor"]
        cursors.append(rawCursor is NSNull ? nil : rawCursor as? String)
        return responses.removeFirst()
    }
}
