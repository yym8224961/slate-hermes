import Darwin
import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite(.serialized) struct CodexAppServerTransportTests {
    @Test func transportDrainsWarningsAndSelectsOnlyTargetResponse() async throws {
        let root = try TemporaryDirectory()
        let capturedInput = root.url.appendingPathComponent("stdin.jsonl")
        let capturedArguments = root.url.appendingPathComponent("arguments.txt")
        let pidFile = root.url.appendingPathComponent("pid.txt")
        let executable = try makeExecutable(
            in: root.url,
            named: "fake-codex",
            script: """
            #!/bin/sh
            printf '%s\n' "$$" > '\(pidFile.path)'
            printf '%s\n' "$@" > '\(capturedArguments.path)'
            : > '\(capturedInput.path)'
            count=0
            while [ "$count" -lt 3 ]; do
                IFS= read -r line || exit 20
                printf '%s\n' "$line" >> '\(capturedInput.path)'
                count=$((count + 1))
            done
            printf '%s\n' 'warning: model directory is private' >&2
            printf '%s\n' 'unrelated stdout' \
                '{"id":1,"result":{}}' \
                '{"method":"account/rateLimits/updated","params":{"private":"ignore"}}' \
                '{"id":2.5,"result":{"rateLimits":{"limitId":"codex"},"rateLimitsByLimitId":{},"credits":null,"planType":"wrong"}}' \
                '{"id":2,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1900000000}},"rateLimitsByLimitId":{},"credits":null,"planType":"pro"}}'
            while :; do sleep 1; done
            """
        )
        let lines = Self.requestLines
        let transport = CodexAppServerProcessTransport()
        let startedAt = ContinuousClock.now

        let response = try await transport.request(
            executableURL: executable,
            lines: lines,
            responseID: 2,
            timeout: .seconds(5)
        )
        let elapsed = ContinuousClock.now - startedAt

        let decoded = try CodexRateLimitClient.decode(response)
        #expect(decoded.selectedCodexLimit?.primary?.usedPercent == 25)
        #expect(try String(contentsOf: capturedArguments, encoding: .utf8) == "app-server\n--stdio\n")
        #expect(try Data(contentsOf: capturedInput) == lines.reduce(into: Data(), { $0.append($1) }))
        let pidText = try String(contentsOf: pidFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let pid = try #require(pid_t(pidText))
        let stillRunning = kill(pid, 0) == 0
        if stillRunning { _ = kill(pid, SIGKILL) }
        #expect(stillRunning == false)
        #expect(elapsed < .seconds(4))
    }

    @Test func timeoutEndsChildProcess() async throws {
        let root = try TemporaryDirectory()
        let pidFile = root.url.appendingPathComponent("pid.txt")
        let executable = try makeExecutable(
            in: root.url,
            named: "hanging-codex",
            script: """
            #!/bin/sh
            printf '%s\n' "$$" > '\(pidFile.path)'
            trap '' TERM
            while :; do sleep 1; done
            """
        )
        let transport = CodexAppServerProcessTransport()

        await #expect(throws: CodexClientError.timeout) {
            try await transport.request(
                executableURL: executable,
                lines: Self.requestLines,
                responseID: 2,
                timeout: .seconds(1)
            )
        }

        let pidText = try String(contentsOf: pidFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let pid = try #require(pid_t(pidText))
        #expect(kill(pid, 0) == -1)
        #expect(errno == ESRCH)
    }

    private static let requestLines = [
        Data("{\"method\":\"initialize\",\"id\":1}\n".utf8),
        Data("{\"method\":\"initialized\"}\n".utf8),
        Data("{\"method\":\"account/rateLimits/read\",\"id\":2}\n".utf8),
    ]

    private func makeExecutable(in directory: URL, named name: String, script: String) throws -> URL {
        let url = directory.appendingPathComponent(name)
        try Data(script.utf8).write(to: url, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        return url
    }
}
