import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite struct ResetRadarTests {
    private let now = Date(timeIntervalSince1970: 1_787_536_800)

    @Test func newerWatchWinsOverConfirmationAndPersistsOnlyDisplaySemantics() throws {
        let parsed = try ResetRadarParser.parse(Data(status(
            latestReset: #"{"reset_type":"banked","announced_at":"2026-08-24T00:00:00Z","text":"SECRET_RESET_TEXT","source":{"url":"SECRET_RESET_URL"}}"#,
            activeWatch: #"{"level":"strong","reset_chance_percent":70,"forecast_window":"today 12:00-15:00 UTC","observed_at":"2026-08-24T01:00:00Z","expires_at":"2026-08-24T03:00:00Z","text":"SECRET_WATCH_TEXT","source":{"url":"SECRET_WATCH_URL"}}"#
        ).utf8))

        #expect(parsed.hasInvalidCapability == false)
        let resolution = ResetRadarStateMachine.resolve(
            cache: .empty,
            fetch: .modified(parsed),
            now: now
        )

        #expect(resolution.display.status == .activeWatch)
        #expect(resolution.display.headline == "活跃预测")
        #expect(resolution.display.shortLabel == "雷达 70%")
        #expect(resolution.display.detail == "today 12:00-15:00 UTC")
        #expect(resolution.display.resetChancePercent == 70)
        #expect(resolution.display.stale == false)
        #expect(resolution.publicErrorCode == nil)
        #expect(ResetRadarStateMachine.shouldFetch(cache: resolution.cache, now: now.addingTimeInterval(3_599)) == false)
        #expect(ResetRadarStateMachine.shouldFetch(cache: resolution.cache, now: now.addingTimeInterval(3_600)))

        let persisted = try JSONEncoder().encode(resolution.cache)
        let text = try #require(String(data: persisted, encoding: .utf8))
        for forbidden in [
            "SECRET_RESET_TEXT", "SECRET_RESET_URL", "SECRET_WATCH_TEXT",
            "SECRET_WATCH_URL", "SECRET_STATS", "SECRET_GENERATED", "SECRET_ADDITIVE",
        ] {
            #expect(text.contains(forbidden) == false)
        }
    }

    @Test func watchCannotOverrideANewerConfirmationAndConfirmationExpiresAt24Hours() throws {
        let parsed = try ResetRadarParser.parse(Data(status(
            latestReset: #"{"reset_type":"regular","announced_at":"2026-08-24T01:00:00Z"}"#,
            activeWatch: #"{"level":"strong","reset_chance_percent":70,"forecast_window":"soon","observed_at":"2026-08-24T00:30:00Z","expires_at":"2026-08-24T03:00:00Z"}"#
        ).utf8))
        let accepted = ResetRadarStateMachine.resolve(cache: .empty, fetch: .modified(parsed), now: now)

        #expect(accepted.display.status == .confirmedRegular)
        #expect(accepted.display.shortLabel == "雷达 已重置")

        let expired = ResetRadarStateMachine.resolve(
            cache: accepted.cache,
            fetch: nil,
            now: Date(timeIntervalSince1970: 1_787_533_200 + 24 * 60 * 60)
        )
        #expect(expired.display.status == .unavailable)

        let stillFresh = ResetRadarStateMachine.resolve(
            cache: accepted.cache,
            fetch: nil,
            now: Date(timeIntervalSince1970: 1_787_533_200 + 24 * 60 * 60 - 1)
        )
        #expect(stillFresh.display.status == .confirmedRegular)
    }

    @Test func explicitNoWatchIsFreshForTwoHoursButInvalidWatchIsNeverNoWatch() throws {
        let noWatch = try ResetRadarParser.parse(Data(status(
            latestReset: "null",
            activeWatch: "null"
        ).utf8))
        let accepted = ResetRadarStateMachine.resolve(cache: .empty, fetch: .modified(noWatch), now: now)
        #expect(accepted.display.status == .noActiveWatch)
        #expect(accepted.display.shortLabel == "雷达 无预测")

        let boundary = ResetRadarStateMachine.resolve(
            cache: accepted.cache,
            fetch: nil,
            now: now.addingTimeInterval(2 * 60 * 60)
        )
        #expect(boundary.display.status == .noActiveWatch)

        let expired = ResetRadarStateMachine.resolve(
            cache: accepted.cache,
            fetch: nil,
            now: now.addingTimeInterval(2 * 60 * 60 + 1)
        )
        #expect(expired.display.status == .unavailable)

        let invalid = try ResetRadarParser.parse(Data(status(
            latestReset: "null",
            activeWatch: #"{"level":"strong","reset_chance_percent":101,"forecast_window":"soon","observed_at":"2026-08-24T01:00:00Z","expires_at":"2026-08-24T03:00:00Z"}"#
        ).utf8))
        #expect(invalid.hasInvalidCapability)
        let invalidResolution = ResetRadarStateMachine.resolve(
            cache: .empty,
            fetch: .modified(invalid),
            now: now
        )
        #expect(invalidResolution.display.status == .unavailable)
        #expect(invalidResolution.publicErrorCode == "invalid_response")
    }

    @Test func failedRefreshKeepsEligibleEvidenceStaleAndUsesAtLeastHourlyBackoff() throws {
        let watch = try ResetRadarParser.parse(Data(status(
            latestReset: "null",
            activeWatch: #"{"level":"elevated","reset_chance_percent":null,"forecast_window":"today 12:00-15:00 UTC","observed_at":"2026-08-24T01:00:00Z","expires_at":"2026-08-24T03:00:00Z"}"#
        ).utf8))
        let accepted = ResetRadarStateMachine.resolve(cache: .empty, fetch: .modified(watch), now: now)
        let failedAt = now.addingTimeInterval(3_599)

        let failed = ResetRadarStateMachine.resolve(
            cache: accepted.cache,
            fetch: .failed(reason: .rateLimited, retryAfterSeconds: 7_200),
            now: failedAt
        )

        #expect(failed.display.status == .activeWatch)
        #expect(failed.display.stale)
        #expect(failed.publicErrorCode == "rate_limited")
        #expect(failed.cache.nextFetchAt == failedAt.addingTimeInterval(7_200))
    }

    @Test func notModifiedRefreshesNoWatchAndClearsAWatchFailure() throws {
        let noWatch = try ResetRadarParser.parse(Data(status(
            latestReset: "null",
            activeWatch: "null"
        ).utf8))
        let acceptedNoWatch = ResetRadarStateMachine.resolve(
            cache: .empty,
            fetch: .modified(noWatch),
            now: now
        )
        let confirmedNoWatch = ResetRadarStateMachine.resolve(
            cache: acceptedNoWatch.cache,
            fetch: .notModified,
            now: now.addingTimeInterval(3_600)
        )

        #expect(confirmedNoWatch.display.status == .noActiveWatch)
        #expect(confirmedNoWatch.cache.noWatchFreshUntil == now.addingTimeInterval(3 * 60 * 60))
        #expect(confirmedNoWatch.cache.nextFetchAt == now.addingTimeInterval(2 * 60 * 60))
        #expect(confirmedNoWatch.cache.latestRequestFailed == false)

        let watch = try ResetRadarParser.parse(Data(status(
            latestReset: "null",
            activeWatch: #"{"level":"strong","reset_chance_percent":70,"forecast_window":"soon","observed_at":"2026-08-24T01:00:00Z","expires_at":"2026-08-24T03:00:00Z"}"#
        ).utf8))
        let acceptedWatch = ResetRadarStateMachine.resolve(
            cache: .empty,
            fetch: .modified(watch),
            now: now
        )
        let failedWatch = ResetRadarStateMachine.resolve(
            cache: acceptedWatch.cache,
            fetch: .failed(reason: .network, retryAfterSeconds: nil),
            now: now.addingTimeInterval(60)
        )
        #expect(failedWatch.display.stale)

        let confirmedWatch = ResetRadarStateMachine.resolve(
            cache: failedWatch.cache,
            fetch: .notModified,
            now: now.addingTimeInterval(120)
        )
        #expect(confirmedWatch.display.status == .activeWatch)
        #expect(confirmedWatch.display.stale == false)
    }

    @Test func parserKeepsIndependentValidEvidenceAndAcceptsLongForecasts() throws {
        let longForecast = String(repeating: "forecast ", count: 80)
        let parsed = try ResetRadarParser.parse(Data(status(
            latestReset: #"{"reset_type":"future_kind","announced_at":"2026-08-24T01:00:00Z"}"#,
            activeWatch: #"{"level":"strong","reset_chance_percent":1,"forecast_window":"\#(longForecast)","observed_at":"2026-08-24T01:30:00Z","expires_at":"2026-08-24T03:00:00Z"}"#
        ).utf8))

        #expect(parsed.hasInvalidCapability)
        #expect(parsed.semantic.latestReset == nil)
        #expect(parsed.semantic.activeWatch?.forecastWindow == longForecast.trimmingCharacters(in: .whitespaces))
        let resolution = ResetRadarStateMachine.resolve(cache: .empty, fetch: .modified(parsed), now: now)
        #expect(resolution.display.status == .activeWatch)
        #expect(resolution.display.signalPercent == 1)

        for invalidWatch in [
            #"{"level":"strong","reset_chance_percent":101,"forecast_window":"soon","observed_at":"2026-08-24T01:00:00Z","expires_at":"2026-08-24T03:00:00Z"}"#,
            #"{"level":"strong","reset_chance_percent":70.0,"forecast_window":"soon","observed_at":"2026-08-24T01:00:00Z","expires_at":"2026-08-24T03:00:00Z"}"#,
            #"{"level":"strong","reset_chance_percent":70,"forecast_window":"   ","observed_at":"2026-08-24T01:00:00Z","expires_at":"2026-08-24T03:00:00Z"}"#,
            #"{"level":"strong","reset_chance_percent":70,"forecast_window":"soon","observed_at":"invalid","expires_at":"2026-08-24T03:00:00Z"}"#,
            #"{"level":"strong","reset_chance_percent":70,"forecast_window":"soon","observed_at":"2026-08-24T03:00:00Z","expires_at":"2026-08-24T03:00:00Z"}"#,
        ] {
            let invalid = try ResetRadarParser.parse(Data(status(
                latestReset: "null",
                activeWatch: invalidWatch
            ).utf8))
            #expect(invalid.hasInvalidCapability)
            #expect(invalid.explicitNoWatch == false)
            #expect(invalid.hasUsableCapability == false)
        }
    }

    @Test func httpClientMapsRateLimitAndRejectsOversizedOrInvalidBodies() async throws {
        let endpoint = URL(string: "https://radar.invalid/api/v1/status")!
        let rateLimited = ResetRadarClient(
            endpoint: endpoint,
            transport: RadarTransportStub(status: 429, headers: ["Retry-After": "7200"], body: Data("SECRET_RATE_LIMIT".utf8))
        )
        #expect(await rateLimited.read() == .failed(reason: .rateLimited, retryAfterSeconds: 7_200))

        let oversized = ResetRadarClient(
            endpoint: endpoint,
            transport: RadarTransportStub(status: 200, body: Data(repeating: 120, count: 65_537))
        )
        #expect(await oversized.read() == .failed(reason: .responseTooLarge, retryAfterSeconds: nil))

        let invalid = ResetRadarClient(
            endpoint: endpoint,
            transport: RadarTransportStub(status: 200, body: Data("SECRET_INVALID_RESPONSE".utf8))
        )
        let invalidResult = await invalid.read()
        #expect(invalidResult == .failed(reason: .invalidResponse, retryAfterSeconds: nil))
        #expect(String(describing: invalidResult).contains("SECRET_INVALID_RESPONSE") == false)

        var exactBody = Data(status(latestReset: "null", activeWatch: "null").utf8)
        exactBody.append(Data(repeating: 32, count: 64 * 1_024 - exactBody.count))
        let exactLimit = ResetRadarClient(
            endpoint: endpoint,
            transport: RadarTransportStub(status: 200, body: exactBody)
        )
        let expected = try ResetRadarParser.parse(exactBody)
        #expect(await exactLimit.read() == .modified(expected))
    }

    @Test func httpClientKeepsETagInMemoryAndValidatesNotModified() async throws {
        let endpoint = URL(string: "https://radar.invalid/api/v1/status")!
        let transport = ConditionalRadarTransportStub(body: Data(status(
            latestReset: "null",
            activeWatch: "null"
        ).utf8))
        let client = ResetRadarClient(endpoint: endpoint, transport: transport)

        if case .modified = await client.read() {} else {
            Issue.record("first ETag request should return modified radar data")
        }
        #expect(await client.read() == .notModified)
        #expect(await transport.ifNoneMatchHeaders() == [nil, #""radar-v1""#])
        #expect(await transport.maximumByteLimits() == [64 * 1_024, 64 * 1_024])
        #expect(await transport.requestTimeouts() == [3, 3])

        let unconditional = ResetRadarClient(
            endpoint: endpoint,
            transport: RadarTransportStub(status: 304, body: Data())
        )
        #expect(await unconditional.read() == .failed(reason: .invalidResponse, retryAfterSeconds: nil))
    }

    @Test func retryAfterSupportsSecondsAndHTTPDatesWithoutShorteningTheHourlyPoll() {
        let reference = Date(timeIntervalSince1970: 784_111_777)
        #expect(ResetRadarClient.parseRetryAfter("7200", now: reference) == 7_200)
        #expect(ResetRadarClient.parseRetryAfter("invalid", now: reference) == nil)
        #expect(ResetRadarClient.parseRetryAfter(
            "Sun, 06 Nov 1994 10:49:37 GMT",
            now: reference
        ) == 7_200)

        let failedAt = now
        let shortRetry = ResetRadarStateMachine.resolve(
            cache: .empty,
            fetch: .failed(reason: .rateLimited, retryAfterSeconds: 30),
            now: failedAt
        )
        #expect(shortRetry.cache.nextFetchAt == failedAt.addingTimeInterval(60 * 60))
    }

    @Test func urlSessionTransportBoundsStreamingSuccessBodiesButSkipsErrorBodies() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RadarURLProtocolStub.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let transport = URLSessionResetRadarHTTPTransport(session: session)
        let request = URLRequest(url: URL(string: "https://radar.invalid/api/v1/status")!)

        RadarURLProtocolStub.state.set(
            .init(status: 200, body: Data(repeating: 120, count: 64 * 1_024))
        )
        let (exactBody, exactResponse) = try await transport.data(
            for: request,
            maximumBytes: 64 * 1_024
        )
        #expect(exactBody.count == 64 * 1_024)
        #expect(exactResponse.statusCode == 200)

        RadarURLProtocolStub.state.set(
            .init(status: 200, body: Data(repeating: 120, count: 64 * 1_024 + 1))
        )
        do {
            _ = try await transport.data(for: request, maximumBytes: 64 * 1_024)
            Issue.record("streaming response over 64 KiB should be rejected")
        } catch {
            #expect(error as? ResetRadarTransportError == .responseTooLarge)
        }

        RadarURLProtocolStub.state.set(
            .init(
                status: 429,
                headers: ["Retry-After": "7200"],
                body: Data(repeating: 120, count: 64 * 1_024 + 1)
            )
        )
        let (rateLimitBody, rateLimitResponse) = try await transport.data(
            for: request,
            maximumBytes: 64 * 1_024
        )
        #expect(rateLimitBody.isEmpty)
        #expect(rateLimitResponse.statusCode == 429)
    }

    private func status(latestReset: String, activeWatch: String) -> String {
        #"{"data":{"latest_reset":\#(latestReset),"active_watch":\#(activeWatch),"stats":{"SECRET_STATS":"SECRET_STATS"}},"meta":{"generated_at":"SECRET_GENERATED"},"SECRET_ADDITIVE":"SECRET_ADDITIVE"}"#
    }
}

private actor RadarTransportStub: ResetRadarHTTPTransport {
    private let status: Int
    private let headers: [String: String]
    private let body: Data

    init(status: Int, headers: [String: String] = [:], body: Data) {
        self.status = status
        self.headers = headers
        self.body = body
    }

    func data(for request: URLRequest, maximumBytes: Int) async throws -> (Data, HTTPURLResponse) {
        guard body.count <= maximumBytes else { throw ResetRadarTransportError.responseTooLarge }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: nil,
            headerFields: headers
        )!
        return (body, response)
    }
}

private actor ConditionalRadarTransportStub: ResetRadarHTTPTransport {
    private let body: Data
    private var requests: [URLRequest] = []
    private var maximumBytesValues: [Int] = []

    init(body: Data) {
        self.body = body
    }

    func data(for request: URLRequest, maximumBytes: Int) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        maximumBytesValues.append(maximumBytes)
        let call = requests.count
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: call == 1 ? 200 : 304,
            httpVersion: nil,
            headerFields: call == 1 ? ["ETag": #""radar-v1""#] : [:]
        )!
        return (call == 1 ? body : Data(), response)
    }

    func ifNoneMatchHeaders() -> [String?] {
        requests.map { $0.value(forHTTPHeaderField: "If-None-Match") }
    }

    func maximumByteLimits() -> [Int] {
        maximumBytesValues
    }

    func requestTimeouts() -> [TimeInterval] {
        requests.map(\.timeoutInterval)
    }
}

private final class RadarURLProtocolStub: URLProtocol, @unchecked Sendable {
    static let state = RadarURLProtocolState()

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let value = Self.state.get()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: value.status,
            httpVersion: nil,
            headerFields: value.headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: value.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private struct RadarURLProtocolResponse: Sendable {
    let status: Int
    var headers: [String: String] = [:]
    var body: Data
}

private final class RadarURLProtocolState: @unchecked Sendable {
    private let lock = NSLock()
    private var response = RadarURLProtocolResponse(status: 500, body: Data())

    func set(_ response: RadarURLProtocolResponse) {
        lock.withLock { self.response = response }
    }

    func get() -> RadarURLProtocolResponse {
        lock.withLock { response }
    }
}
