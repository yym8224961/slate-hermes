import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite struct OpenCodeGoUsageClientTests {
    @Test func requestUsesOfficialEndpointAndBearerHeader() async throws {
        let transport = RecordingHTTPTransport(status: 200, body: Self.officialUsage)

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
            transport: RecordingHTTPTransport(status: 200, body: Self.officialUsage)
        ).read(apiKey: "secret")

        #expect(result.rollingUsage.status == .ok)
        #expect(result.rollingUsage.resetAt == Date(timeIntervalSince1970: 1_788_083_258.287))
        #expect(result.weeklyUsage.usagePercent == 29)
        #expect(result.monthlyUsage.resetAt == Date(timeIntervalSince1970: 1_790_227_561.287))
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

        await #expect(throws: OpenCodeGoClientError.invalidResponse) {
            try await nonJSONClient.read(apiKey: "secret")
        }
        await #expect(throws: OpenCodeGoClientError.invalidResponse) {
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

        await #expect(throws: OpenCodeGoClientError.invalidResponse) {
            try await negativeResetClient.read(apiKey: "secret")
        }
        await #expect(throws: OpenCodeGoClientError.invalidResponse) {
            try await unknownStatusClient.read(apiKey: "secret")
        }
    }

    @Test func rejectsNonFiniteUsagePercent() async {
        let client = OpenCodeGoUsageClient(
            transport: RecordingHTTPTransport(status: 200, body: Self.nonFiniteUsagePercent)
        )

        await #expect(throws: OpenCodeGoClientError.invalidResponse) {
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

    private static let officialUsage = Data(#"""
    {
      "usage": {
        "rolling": { "status": "ok", "percent": 19, "resetsAt": "2026-08-30T09:47:38.287Z" },
        "weekly": { "status": "ok", "percent": 29, "resetsAt": "2026-08-31T00:00:00.287Z" },
        "monthly": { "status": "ok", "percent": 39, "resetsAt": "2026-09-24T05:26:01.287Z" }
      }
    }
    """#.utf8)

    private static let rateLimitedUsage = Data(#"""
    {
      "usage": {
        "rolling": { "status": "ok", "percent": 19, "resetsAt": "2026-08-30T09:47:38Z" },
        "weekly": { "status": "rate-limited", "percent": 100, "resetsAt": "2026-08-31T00:00:00Z" },
        "monthly": { "status": "ok", "percent": 39, "resetsAt": "2026-09-24T05:26:01Z" }
      }
    }
    """#.utf8)

    private static let missingMonthlyUsage = Data(#"""
    {
      "usage": {
        "rolling": { "status": "ok", "percent": 19, "resetsAt": "2026-08-30T09:47:38Z" },
        "weekly": { "status": "ok", "percent": 29, "resetsAt": "2026-08-31T00:00:00Z" }
      }
    }
    """#.utf8)

    private static let negativeResetUsage = Data(#"""
    {
      "usage": {
        "rolling": { "status": "ok", "percent": 19, "resetsAt": "not-a-date" },
        "weekly": { "status": "ok", "percent": 29, "resetsAt": "2026-08-31T00:00:00Z" },
        "monthly": { "status": "ok", "percent": 39, "resetsAt": "2026-09-24T05:26:01Z" }
      }
    }
    """#.utf8)

    private static let unknownStatusUsage = Data(#"""
    {
      "usage": {
        "rolling": { "status": "delayed", "percent": 19, "resetsAt": "2026-08-30T09:47:38Z" },
        "weekly": { "status": "ok", "percent": 29, "resetsAt": "2026-08-31T00:00:00Z" },
        "monthly": { "status": "ok", "percent": 39, "resetsAt": "2026-09-24T05:26:01Z" }
      }
    }
    """#.utf8)

    private static let nonFiniteUsagePercent = Data(#"""
    {
      "usage": {
        "rolling": { "status": "ok", "percent": 1e999, "resetsAt": "2026-08-30T09:47:38Z" },
        "weekly": { "status": "ok", "percent": 29, "resetsAt": "2026-08-31T00:00:00Z" },
        "monthly": { "status": "ok", "percent": 39, "resetsAt": "2026-09-24T05:26:01Z" }
      }
    }
    """#.utf8)

    private static let usageWithExtraFields = Data(#"""
    {
      "ignored": "future field",
      "usage": {
        "rolling": { "status": "ok", "percent": 19, "resetsAt": "2026-08-30T09:47:38Z", "next": true },
        "weekly": { "status": "ok", "percent": 29, "resetsAt": "2026-08-31T00:00:00Z" },
        "monthly": { "status": "ok", "percent": 39, "resetsAt": "2026-09-24T05:26:01Z" }
      }
    }
    """#.utf8)
}
