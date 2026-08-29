import Foundation
import Testing
@testable import SlateQuotaCollector
#if canImport(Darwin)
import Darwin
#endif

@Suite("Slate ingest client")
struct SlateIngestClientTests {
    private static let privateURL = URL(string: "http://192.168.1.20/api/v1/contents/content-123/data")!
    private static let dashboard = SlateDashboardData.fixture(generatedAt: Date(timeIntervalSince1970: 1_723_456_789))

    private static var receipt: Data {
        Data(
            """
            {
              "id": "content-123",
              "image_etag": "image-v2",
              "manifest_etag": "manifest-v2",
              "rendered_at": "2026-08-12T08:30:00.123Z"
            }
            """.utf8
        )
    }

    @Test(arguments: [
        "http://localhost/api/v1/contents/abc/data",
        "http://printer.local/api/v1/contents/abc/data",
        "http://127.255.255.254/api/v1/contents/abc/data",
        "http://10.255.0.1/api/v1/contents/abc/data",
        "http://172.16.0.1/api/v1/contents/abc/data",
        "http://172.31.255.254/api/v1/contents/abc/data",
        "http://192.168.1.20/api/v1/contents/abc/data",
        "http://169.254.255.254/api/v1/contents/abc/data",
        "http://[::1]/api/v1/contents/abc/data",
        "http://[fe80::1]/api/v1/contents/abc/data",
        "http://[febf::ffff]/api/v1/contents/abc/data",
        "https://slate.example.com/api/v1/contents/abc/data",
        "https://slate.example.com:9443/api/v1/contents/abc/data",
    ])
    func acceptsHTTPSOrExplicitPrivateHTTP(_ raw: String) throws {
        #expect(try SlateEndpointPolicy.validate(try #require(URL(string: raw))).absoluteString == raw)
    }

    @Test(arguments: [
        "http://example.com/api/v1/contents/abc/data",
        "http://localhost.evil.example/api/v1/contents/abc/data",
        "http://192.168.1.20.evil.example/api/v1/contents/abc/data",
        "http://172.15.255.255/api/v1/contents/abc/data",
        "http://172.32.0.1/api/v1/contents/abc/data",
        "http://169.255.0.1/api/v1/contents/abc/data",
        "http://[fec0::1]/api/v1/contents/abc/data",
        "ftp://slate.local/api/v1/contents/abc/data",
        "https://example.com/admin",
        "https://example.com/api/v1/contents//data",
        "https://example.com/api/v1/contents/a/b/data",
        "https://example.com/api/v1/contents/%2F/data",
        "https://example.com/api/v1/contents/abc%2Fdef/data",
        "https://example.com/api/v1/contents/%2E%2E/data",
        "https://example.com/api/v1/contents/abc/data/",
        "https://example.com/api/v1/contents/abc/data?debug=true",
        "https://example.com/api/v1/contents/abc/data#fragment",
        "https://user@example.com/api/v1/contents/abc/data",
        "https://user:password@example.com/api/v1/contents/abc/data",
    ])
    func rejectsUnsafeOrInexactEndpoint(_ raw: String) throws {
        let url = try #require(URL(string: raw))
        #expect(throws: SlateEndpointError.self) {
            try SlateEndpointPolicy.validate(url)
        }
    }

    @Test func postsExactEnvelopeWithJSONTimeoutAndDecodesProofFields() async throws {
        let transport = RecordingHTTPTransport(status: 200, body: Self.receipt)
        let envelope = SlateEnvelope(data: Self.dashboard)

        let receipt = try await SlateIngestClient(transport: transport).push(envelope, capabilityURL: Self.privateURL)

        let request = try #require(await transport.lastRequest)
        #expect(request.httpMethod == "POST")
        #expect(request.timeoutInterval == 15)
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let actualBody = try #require(request.httpBody)
        let expectedBody = try JSONEncoder.slate.encode(envelope)
        #expect(
            try JSONSerialization.jsonObject(with: actualBody) as? NSDictionary
                == JSONSerialization.jsonObject(with: expectedBody) as? NSDictionary
        )
        #expect(receipt.id == "content-123")
        #expect(receipt.imageEtag == "image-v2")
        #expect(receipt.manifestEtag == "manifest-v2")
        let dateFormatter = ISO8601DateFormatter()
        dateFormatter.formatOptions.insert(.withFractionalSeconds)
        #expect(receipt.renderedAt == dateFormatter.date(from: "2026-08-12T08:30:00.123Z"))
    }

    @Test func getsInnerDashboardDataDirectly() async throws {
        let transport = RecordingHTTPTransport(status: 200, body: try JSONEncoder.slate.encode(Self.dashboard))

        let data = try await SlateIngestClient(transport: transport).readCurrentData(capabilityURL: Self.privateURL)

        let request = try #require(await transport.lastRequest)
        #expect(request.httpMethod == "GET")
        #expect(request.timeoutInterval == 15)
        #expect(request.httpBody == nil)
        #expect(data == Self.dashboard)
    }

    @Test func getsCodexOnlyDashboardDataWithoutOpenCodeGo() async throws {
        let expected = SlateDashboardData(
            schemaVersion: Self.dashboard.schemaVersion,
            generatedAt: Self.dashboard.generatedAt,
            codex: Self.dashboard.codex,
            opencodeGo: .unavailable(at: Self.dashboard.generatedAt),
            resetRadar: Self.dashboard.resetRadar,
            taskActivity: Self.dashboard.taskActivity,
            includesOpenCodeGo: false
        )
        let transport = RecordingHTTPTransport(status: 200, body: try JSONEncoder.slate.encode(expected))

        let data = try await SlateIngestClient(transport: transport).readCurrentData(capabilityURL: Self.privateURL)

        #expect(data == expected)
        #expect(!data.includesOpenCodeGo)
    }

    @Test func retriesOneRetryableHTTPFailureAfterOneSecond() async throws {
        let sleeper = RetrySleepRecorder()
        let transport = RecordingHTTPTransport(responses: [
            .success(.init(status: 500, body: Data("private body".utf8))),
            .success(.init(status: 200, body: Self.receipt)),
        ])
        let client = SlateIngestClient(transport: transport, sleep: { duration in
            await sleeper.record(duration)
        })

        _ = try await client.push(SlateEnvelope(data: Self.dashboard), capabilityURL: Self.privateURL)

        #expect(await transport.requests.count == 2)
        #expect(await sleeper.durations == [.seconds(1)])
    }

    @Test(arguments: [408, 429, 500, 503, 599])
    func retryableHTTPStatusesStopAfterOneRetry(_ status: Int) async throws {
        let sleeper = RetrySleepRecorder()
        let transport = RecordingHTTPTransport(responses: [
            .success(.init(status: status, body: Data("first private body".utf8))),
            .success(.init(status: status, body: Data("second private body".utf8))),
        ])
        let client = SlateIngestClient(transport: transport, sleep: { duration in
            await sleeper.record(duration)
        })

        do {
            _ = try await client.push(SlateEnvelope(data: Self.dashboard), capabilityURL: Self.privateURL)
            Issue.record("expected HTTP error")
        } catch let error as SlateIngestError {
            #expect(error.publicCode == "slate_http_\(status)")
            #expect(!error.publicCode.contains("content-123"))
            #expect(!error.publicCode.contains("private body"))
        }
        #expect(await transport.requests.count == 2)
        #expect(await sleeper.durations == [.seconds(1)])
    }

    @Test(arguments: [400, 401, 403, 404, 409, 422])
    func permanentHTTPStatusesAreNotRetried(_ status: Int) async throws {
        let sleeper = RetrySleepRecorder()
        let transport = RecordingHTTPTransport(status: status, body: Data("private content-123 body".utf8))
        let client = SlateIngestClient(transport: transport, sleep: { duration in
            await sleeper.record(duration)
        })

        do {
            _ = try await client.push(SlateEnvelope(data: Self.dashboard), capabilityURL: Self.privateURL)
            Issue.record("expected HTTP error")
        } catch let error as SlateIngestError {
            #expect(error.publicCode == "slate_http_\(status)")
            #expect(!error.publicCode.contains("content-123"))
            #expect(!error.publicCode.contains("private"))
        }
        #expect(await transport.requests.count == 1)
        #expect(await sleeper.durations.isEmpty)
    }

    @Test func transientTransportFailureRetriesOnceAndPublishesOnlySafeCode() async throws {
        let sleeper = RetrySleepRecorder()
        let transport = RecordingHTTPTransport(responses: [
            .failure(URLError(.timedOut, userInfo: [NSURLErrorFailingURLErrorKey: Self.privateURL])),
            .failure(URLError(.timedOut, userInfo: [NSURLErrorFailingURLErrorKey: Self.privateURL])),
        ])
        let client = SlateIngestClient(transport: transport, sleep: { duration in
            await sleeper.record(duration)
        })

        do {
            _ = try await client.readCurrentData(capabilityURL: Self.privateURL)
            Issue.record("expected transport error")
        } catch let error as SlateIngestError {
            #expect(error.publicCode == "slate_transport_timed_out")
            #expect(!error.publicCode.contains("content-123"))
            #expect(!String(describing: error).contains("192.168.1.20"))
        }
        #expect(await transport.requests.count == 2)
        #expect(await sleeper.durations == [.seconds(1)])
    }

    @Test(arguments: [
        URLError.Code.timedOut,
        .cannotFindHost,
        .cannotConnectToHost,
        .networkConnectionLost,
        .dnsLookupFailed,
        .notConnectedToInternet,
        .resourceUnavailable,
    ])
    func transientTransportCodesRetryExactlyOnce(_ code: URLError.Code) async throws {
        let sleeper = RetrySleepRecorder()
        let transport = RecordingHTTPTransport(responses: [
            .failure(URLError(code)),
            .success(.init(status: 200, body: try JSONEncoder.slate.encode(Self.dashboard))),
        ])
        let client = SlateIngestClient(transport: transport, sleep: { duration in
            await sleeper.record(duration)
        })

        let data = try await client.readCurrentData(capabilityURL: Self.privateURL)

        #expect(data == Self.dashboard)
        #expect(await transport.requests.count == 2)
        #expect(await sleeper.durations == [.seconds(1)])
    }

    @Test func permanentTransportFailureIsNotRetried() async throws {
        let sleeper = RetrySleepRecorder()
        let transport = RecordingHTTPTransport(responses: [.failure(URLError(.badURL))])
        let client = SlateIngestClient(transport: transport, sleep: { duration in
            await sleeper.record(duration)
        })

        do {
            _ = try await client.readCurrentData(capabilityURL: Self.privateURL)
            Issue.record("expected transport error")
        } catch let error as SlateIngestError {
            #expect(error.publicCode == "slate_transport_bad_url")
        }
        #expect(await transport.requests.count == 1)
        #expect(await sleeper.durations.isEmpty)
    }

    @Test func invalidResponseNeverExposesResponseBody() async throws {
        let body = Data("secret response content-123".utf8)
        let transport = RecordingHTTPTransport(status: 200, body: body)

        do {
            _ = try await SlateIngestClient(transport: transport).readCurrentData(capabilityURL: Self.privateURL)
            Issue.record("expected decode error")
        } catch let error as SlateIngestError {
            #expect(error.publicCode == "slate_transport_invalid_response")
            #expect(!String(describing: error).contains("secret response"))
            #expect(!String(describing: error).contains("content-123"))
        }
    }

    @Test(arguments: [301, 302, 303, 307, 308])
    func productionTransportNeverFollowsPOSTRedirectToWrongPath(_ status: Int) async throws {
        let secondHop = try LoopbackHTTPServer(response: .init(status: 200, body: Self.receipt))
        let redirectTarget = "http://127.0.0.1:\(secondHop.port)/wrong-path/content-123"
        let firstHop = try LoopbackHTTPServer(
            response: .init(status: status, headers: ["Location": redirectTarget], body: Data("private redirect body".utf8))
        )
        defer {
            firstHop.stop()
            secondHop.stop()
        }
        let capabilityURL = URL(
            string: "http://127.0.0.1:\(firstHop.port)/api/v1/contents/content-123/data"
        )!

        do {
            _ = try await SlateIngestClient().push(SlateEnvelope(data: Self.dashboard), capabilityURL: capabilityURL)
            Issue.record("production transport followed an unsafe redirect")
        } catch let error as SlateIngestError {
            #expect(error.publicCode == "slate_http_\(status)")
            #expect(!String(describing: error).contains("content-123"))
            #expect(!String(describing: error).contains("private redirect body"))
        }

        #expect(firstHop.requestCount == 1)
        #expect(secondHop.requestCount == 0)
    }

    @Test(arguments: [
        (
            URL(string: "https://slate.example.com/api/v1/contents/content-123/data")!,
            URL(string: "https://other.example.com/api/v1/contents/content-123/data")!
        ),
        (
            URL(string: "http://192.168.1.20/api/v1/contents/content-123/data")!,
            URL(string: "http://example.com/api/v1/contents/content-123/data")!
        ),
        (
            URL(string: "https://slate.example.com:443/api/v1/contents/content-123/data")!,
            URL(string: "https://slate.example.com:9443/api/v1/contents/content-123/data")!
        ),
        (
            URL(string: "https://slate.example.com/api/v1/contents/content-123/data")!,
            URL(string: "http://slate.example.com/api/v1/contents/content-123/data")!
        ),
        (
            URL(string: "https://slate.example.com/api/v1/contents/content-123/data")!,
            URL(string: "https://slate.example.com/wrong-path")!
        ),
    ])
    func redirectPolicyRejectsEveryProposedSecondHop(_ urls: (URL, URL)) {
        #expect(!SlateRedirectPolicy.permits(originalURL: urls.0, proposedURL: urls.1))
    }

    @Test func productionTransportReleasesItsSessionAndDelegateWhenOwnerReleasesIt() async throws {
        let invalidation = SessionInvalidationProbe()
        var delegate: SlateNoRedirectSessionDelegate? = SlateNoRedirectSessionDelegate { _ in
            invalidation.record()
        }
        weak var weakDelegate = delegate
        var transport: SlateURLSessionHTTPTransport? = SlateURLSessionHTTPTransport(
            redirectDelegate: try #require(delegate)
        )
        weak var weakTransport = transport
        weak var weakSession = transport?.session

        delegate = nil
        transport = nil

        for _ in 0..<100 {
            if weakTransport == nil, weakSession == nil, weakDelegate == nil, invalidation.called {
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(weakTransport == nil)
        #expect(weakSession == nil)
        #expect(weakDelegate == nil)
        #expect(invalidation.called)
    }
}

private actor RetrySleepRecorder {
    private(set) var durations: [Duration] = []

    func record(_ duration: Duration) {
        durations.append(duration)
    }
}

private final class SessionInvalidationProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var wasCalled = false

    var called: Bool { lock.withLock { wasCalled } }

    func record() {
        lock.withLock { wasCalled = true }
    }
}

private final class LoopbackHTTPServer: @unchecked Sendable {
    struct Response: Sendable {
        let status: Int
        var headers: [String: String] = [:]
        var body = Data()
    }

    let port: UInt16
    private let state: LoopbackServerState

    var requestCount: Int {
        state.requestCount
    }

    init(response: Response) throws {
        let listener = socket(AF_INET, SOCK_STREAM, 0)
        guard listener >= 0 else { throw Self.currentPOSIXError() }

        var reuse: Int32 = 1
        guard setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout.size(ofValue: reuse))) == 0 else {
            let error = Self.currentPOSIXError()
            Darwin.close(listener)
            throw error
        }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, listen(listener, 4) == 0 else {
            let error = Self.currentPOSIXError()
            Darwin.close(listener)
            throw error
        }

        var actualAddress = sockaddr_in()
        var actualLength = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &actualAddress) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(listener, $0, &actualLength)
            }
        }
        guard named == 0 else {
            let error = Self.currentPOSIXError()
            Darwin.close(listener)
            throw error
        }
        self.port = UInt16(bigEndian: actualAddress.sin_port)
        state = LoopbackServerState(listener: listener)

        let state = self.state
        DispatchQueue.global(qos: .userInitiated).async {
            Self.serveOneRequest(listener: listener, response: response, state: state)
        }
    }

    deinit {
        stop()
    }

    func stop() {
        state.stop()
    }

    private static func serveOneRequest(listener: Int32, response: Response, state: LoopbackServerState) {
        let client = accept(listener, nil, nil)
        state.stop()
        guard client >= 0 else { return }
        defer { Darwin.close(client) }

        var bytes = [UInt8](repeating: 0, count: 4096)
        _ = recv(client, &bytes, bytes.count, 0)
        state.recordRequest()

        let reason = switch response.status {
        case 200: "OK"
        case 301: "Moved Permanently"
        case 302: "Found"
        case 303: "See Other"
        case 307: "Temporary Redirect"
        case 308: "Permanent Redirect"
        default: "Response"
        }
        var header = "HTTP/1.1 \(response.status) \(reason)\r\n"
        for (name, value) in response.headers {
            header += "\(name): \(value)\r\n"
        }
        header += "Content-Length: \(response.body.count)\r\nConnection: close\r\n\r\n"
        var payload = Data(header.utf8)
        payload.append(response.body)
        payload.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            _ = send(client, base, buffer.count, 0)
        }
    }

    private static func currentPOSIXError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}

private final class LoopbackServerState: @unchecked Sendable {
    private let lock = NSLock()
    private var listener: Int32?
    private var requests = 0

    init(listener: Int32) {
        self.listener = listener
    }

    var requestCount: Int {
        lock.withLock { requests }
    }

    func recordRequest() {
        lock.withLock { requests += 1 }
    }

    func stop() {
        let descriptor: Int32? = lock.withLock {
            defer { listener = nil }
            return listener
        }
        guard let descriptor else { return }
        shutdown(descriptor, SHUT_RDWR)
        Darwin.close(descriptor)
    }
}
