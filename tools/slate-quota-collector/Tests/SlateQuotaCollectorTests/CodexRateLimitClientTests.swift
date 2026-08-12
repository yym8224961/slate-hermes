import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite struct CodexRateLimitClientTests {
    @Test func clientSendsOnlyInitializationAndRateLimitRead() async throws {
        let transport = RecordingCodexTransport(response: Self.fixtureJSONRPC)
        let client = CodexRateLimitClient(
            executableURL: URL(fileURLWithPath: "/usr/bin/codex"),
            transport: transport
        )

        _ = try await client.read()

        #expect(await transport.methods == ["initialize", "initialized", "account/rateLimits/read"])
        #expect(await transport.responseID == 2)
        #expect(await transport.joinedInput.contains("thread/start") == false)
        #expect(await transport.joinedInput.contains("prompt") == false)
    }

    @Test func clientUsesConfiguredExecutableAndTwentySecondTimeout() async throws {
        let transport = RecordingCodexTransport(response: Self.fixtureJSONRPC)
        let client = CodexRateLimitClient(configuration: .fixture, transport: transport)

        _ = try await client.read()

        #expect(await transport.executableURL?.path == CollectorConfiguration.fixture.codexExecutablePath)
        #expect(await transport.timeout == .seconds(20))
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

    @Test func decoderExposesOnlyTargetRPCErrorCode() throws {
        let sensitive = Data(#"{"id":2,"error":{"code":-32000,"message":"private model path","data":{"token":"secret"}}}"#.utf8)

        #expect(throws: CodexClientError.rpc(code: -32_000)) {
            try CodexRateLimitClient.decode(sensitive)
        }
    }

    private static let fixtureJSONRPC = Data(#"{"id":2,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":20,"windowDurationMins":300,"resetsAt":1900000000}},"rateLimitsByLimitId":{},"credits":{"unlimited":false,"balance":"12.50"},"planType":"pro"}}"#.utf8)

    private static let namedAndFallbackFixture = Data(#"{"id":2,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":10,"windowDurationMins":300,"resetsAt":1900000000}},"rateLimitsByLimitId":{"codex":{"limitId":"codex","primary":{"usedPercent":30,"windowDurationMins":10080,"resetsAt":1900000000}}},"credits":null,"planType":"pro"}}"#.utf8)

    private static let sparkOnlyFixture = Data(#"{"id":2,"result":{"rateLimits":{"limitId":"spark","primary":{"usedPercent":10,"windowDurationMins":300,"resetsAt":1900000000}},"rateLimitsByLimitId":{"spark":{"limitId":"spark","primary":{"usedPercent":20,"windowDurationMins":10080,"resetsAt":1900000000}}},"credits":null,"planType":"free"}}"#.utf8)
}

private actor RecordingCodexTransport: CodexAppServerTransport {
    private let response: Data
    private(set) var methods: [String] = []
    private(set) var responseID: Int?
    private(set) var joinedInput = ""
    private(set) var executableURL: URL?
    private(set) var timeout: Duration?

    init(response: Data) {
        self.response = response
    }

    func request(
        executableURL: URL,
        lines: [Data],
        responseID: Int,
        timeout: Duration
    ) async throws -> Data {
        self.executableURL = executableURL
        self.timeout = timeout
        self.responseID = responseID
        joinedInput = lines.compactMap { String(data: $0, encoding: .utf8) }.joined()
        methods = lines.compactMap { data in
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return nil
            }
            return object["method"] as? String
        }
        return response
    }
}
