import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite struct OpenCodeGoUsageClientTests {
    @Test func requestUsesOfficialEndpointAndBearerHeader() async throws {
        let transport = RecordingHTTPTransport(status: 200, body: Self.validUsage)

        _ = try await OpenCodeGoUsageClient(transport: transport).read(apiKey: "test-go-secret")

        let request = try #require(await transport.lastRequest)
        #expect(request.url?.absoluteString == "https://opencode.ai/zen/go/v1/usage")
        #expect(request.httpMethod == "GET")
        #expect(request.timeoutInterval == 10)
        #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-go-secret")
    }

    @Test func decodesThreeUsageWindows() async throws {
        let result = try await OpenCodeGoUsageClient(
            transport: RecordingHTTPTransport(status: 200, body: Self.validUsage)
        ).read(apiKey: "secret")

        #expect(result.useBalance == false)
        #expect(result.rollingUsage.status == .ok)
        #expect(result.rollingUsage.resetInSec == 600)
        #expect(result.weeklyUsage.usagePercent == 29)
        #expect(result.monthlyUsage.resetInSec == 2_592_000)
    }

    @Test func acceptsSingleRateLimitedWindow() async throws {
        let result = try await OpenCodeGoUsageClient(
            transport: RecordingHTTPTransport(status: 200, body: Self.rateLimitedUsage)
        ).read(apiKey: "secret")

        #expect(result.weeklyUsage.status == .rateLimited)
        #expect(result.monthlyUsage.status == .ok)
    }

    @Test(arguments: [(401, "unauthorized"), (403, "subscription_required"), (429, "rate_limited"), (500, "server_error")])
    func mapsStatusWithoutBody(status: Int, code: String) async {
        let client = OpenCodeGoUsageClient(
            transport: RecordingHTTPTransport(status: status, body: Data("private body".utf8))
        )

        do {
            _ = try await client.read(apiKey: "secret")
            Issue.record("expected OpenCodeGoClientError")
        } catch let error as OpenCodeGoClientError {
            #expect(error.publicCode == code)
            #expect(error.localizedDescription.contains("private body") == false)
            #expect(error.localizedDescription.contains("secret") == false)
        } catch {
            Issue.record("unexpected error type")
        }
    }

    @Test func mapsUnknownHTTPStatusToPublicCode() async {
        let client = OpenCodeGoUsageClient(
            transport: RecordingHTTPTransport(status: 418, body: Data("private body".utf8))
        )

        do {
            _ = try await client.read(apiKey: "secret")
            Issue.record("expected OpenCodeGoClientError")
        } catch let error as OpenCodeGoClientError {
            #expect(error == .http(status: 418))
            #expect(error.publicCode == "http_418")
        } catch {
            Issue.record("unexpected error type")
        }
    }

    @Test func rejectsNonJSONAndMissingMonthlyWindow() async {
        let nonJSONClient = OpenCodeGoUsageClient(
            transport: RecordingHTTPTransport(status: 200, body: Data("not json".utf8))
        )
        let missingWindowClient = OpenCodeGoUsageClient(
            transport: RecordingHTTPTransport(status: 200, body: Self.missingMonthlyUsage)
        )

        await #expect(throws: DecodingError.self) {
            try await nonJSONClient.read(apiKey: "secret")
        }
        await #expect(throws: DecodingError.self) {
            try await missingWindowClient.read(apiKey: "secret")
        }
    }

    @Test func rejectsInvalidWindowValuesAndUnknownWindowStatus() async {
        let negativeResetClient = OpenCodeGoUsageClient(
            transport: RecordingHTTPTransport(status: 200, body: Self.negativeResetUsage)
        )
        let unknownStatusClient = OpenCodeGoUsageClient(
            transport: RecordingHTTPTransport(status: 200, body: Self.unknownStatusUsage)
        )

        await #expect(throws: DecodingError.self) {
            try await negativeResetClient.read(apiKey: "secret")
        }
        await #expect(throws: DecodingError.self) {
            try await unknownStatusClient.read(apiKey: "secret")
        }
    }

    @Test func rejectsNonFiniteUsagePercent() async {
        let client = OpenCodeGoUsageClient(
            transport: RecordingHTTPTransport(status: 200, body: Self.nonFiniteUsagePercent)
        )

        await #expect(throws: DecodingError.self) {
            try await client.read(apiKey: "secret")
        }
    }

    @Test func acceptsExtraResponseFields() async throws {
        let result = try await OpenCodeGoUsageClient(
            transport: RecordingHTTPTransport(status: 200, body: Self.usageWithExtraFields)
        ).read(apiKey: "secret")

        #expect(result.rollingUsage.usagePercent == 19)
    }

    @Test func mapsTimeoutWithoutLeakingCredentials() async {
        let client = OpenCodeGoUsageClient(
            transport: RecordingHTTPTransport(responses: [.failure(URLError(.timedOut))])
        )

        do {
            _ = try await client.read(apiKey: "never-leak-this-key")
            Issue.record("expected timeout")
        } catch let error as OpenCodeGoClientError {
            #expect(error.publicCode == "timeout")
            #expect(error.localizedDescription.contains("never-leak-this-key") == false)
        } catch {
            Issue.record("unexpected error type")
        }
    }

    private static let validUsage = Data(#"""
    {
      "useBalance": false,
      "rollingUsage": { "status": "ok", "resetInSec": 600, "usagePercent": 19 },
      "weeklyUsage": { "status": "ok", "resetInSec": 604800, "usagePercent": 29 },
      "monthlyUsage": { "status": "ok", "resetInSec": 2592000, "usagePercent": 39 }
    }
    """#.utf8)

    private static let rateLimitedUsage = Data(#"""
    {
      "useBalance": true,
      "rollingUsage": { "status": "ok", "resetInSec": 600, "usagePercent": 19 },
      "weeklyUsage": { "status": "rate-limited", "resetInSec": 604800, "usagePercent": 100 },
      "monthlyUsage": { "status": "ok", "resetInSec": 2592000, "usagePercent": 39 }
    }
    """#.utf8)

    private static let missingMonthlyUsage = Data(#"""
    {
      "useBalance": false,
      "rollingUsage": { "status": "ok", "resetInSec": 600, "usagePercent": 19 },
      "weeklyUsage": { "status": "ok", "resetInSec": 604800, "usagePercent": 29 }
    }
    """#.utf8)

    private static let negativeResetUsage = Data(#"""
    {
      "useBalance": false,
      "rollingUsage": { "status": "ok", "resetInSec": -1, "usagePercent": 19 },
      "weeklyUsage": { "status": "ok", "resetInSec": 604800, "usagePercent": 29 },
      "monthlyUsage": { "status": "ok", "resetInSec": 2592000, "usagePercent": 39 }
    }
    """#.utf8)

    private static let unknownStatusUsage = Data(#"""
    {
      "useBalance": false,
      "rollingUsage": { "status": "delayed", "resetInSec": 600, "usagePercent": 19 },
      "weeklyUsage": { "status": "ok", "resetInSec": 604800, "usagePercent": 29 },
      "monthlyUsage": { "status": "ok", "resetInSec": 2592000, "usagePercent": 39 }
    }
    """#.utf8)

    private static let nonFiniteUsagePercent = Data(#"""
    {
      "useBalance": false,
      "rollingUsage": { "status": "ok", "resetInSec": 600, "usagePercent": 1e999 },
      "weeklyUsage": { "status": "ok", "resetInSec": 604800, "usagePercent": 29 },
      "monthlyUsage": { "status": "ok", "resetInSec": 2592000, "usagePercent": 39 }
    }
    """#.utf8)

    private static let usageWithExtraFields = Data(#"""
    {
      "useBalance": false,
      "ignored": "future field",
      "rollingUsage": { "status": "ok", "resetInSec": 600, "usagePercent": 19, "next": true },
      "weeklyUsage": { "status": "ok", "resetInSec": 604800, "usagePercent": 29 },
      "monthlyUsage": { "status": "ok", "resetInSec": 2592000, "usagePercent": 39 }
    }
    """#.utf8)
}
