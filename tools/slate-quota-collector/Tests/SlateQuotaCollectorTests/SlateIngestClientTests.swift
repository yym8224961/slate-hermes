import Foundation
import Testing
@testable import SlateQuotaCollector

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
}

private actor RetrySleepRecorder {
    private(set) var durations: [Duration] = []

    func record(_ duration: Duration) {
        durations.append(duration)
    }
}
