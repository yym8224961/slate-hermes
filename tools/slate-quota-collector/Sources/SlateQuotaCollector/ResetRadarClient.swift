import Foundation

private enum ResetRadarHTTPBounds {
    static let connectionTimeout: TimeInterval = 3
    static let totalTimeout: TimeInterval = 5
}

enum ResetRadarTransportError: Error, Equatable, Sendable {
    case responseTooLarge
}

protocol ResetRadarHTTPTransport: Sendable {
    func data(
        for request: URLRequest,
        maximumBytes: Int
    ) async throws -> (Data, HTTPURLResponse)
}

struct URLSessionResetRadarHTTPTransport: ResetRadarHTTPTransport, Sendable {
    private static let defaultSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = ResetRadarHTTPBounds.connectionTimeout
        configuration.timeoutIntervalForResource = ResetRadarHTTPBounds.totalTimeout
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    private let session: URLSession

    init(session: URLSession = Self.defaultSession) {
        self.session = session
    }

    func data(
        for request: URLRequest,
        maximumBytes: Int
    ) async throws -> (Data, HTTPURLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200 ..< 300).contains(http.statusCode) else {
            return (Data(), http)
        }
        if let contentLength = http.value(forHTTPHeaderField: "Content-Length"),
           let count = Int(contentLength), count > maximumBytes {
            throw ResetRadarTransportError.responseTooLarge
        }

        var data = Data()
        data.reserveCapacity(min(maximumBytes, 8 * 1_024))
        for try await byte in bytes {
            guard data.count < maximumBytes else {
                throw ResetRadarTransportError.responseTooLarge
            }
            data.append(byte)
        }
        return (data, http)
    }
}

private actor ResetRadarConditionalRequestState {
    private var etag: String?

    func currentETag() -> String? {
        etag
    }

    func accept(etag: String?) {
        self.etag = etag
    }
}

struct ResetRadarClient: ResetRadarReading, Sendable {
    static let productionEndpoint = URL(string: "https://codex-resets.com/api/v1/status")!
    private static let maximumResponseBytes = 64 * 1_024

    private let endpoint: URL
    private let transport: any ResetRadarHTTPTransport
    private let conditionalRequestState: ResetRadarConditionalRequestState

    init(
        endpoint: URL = Self.productionEndpoint,
        transport: any ResetRadarHTTPTransport = URLSessionResetRadarHTTPTransport()
    ) {
        self.endpoint = endpoint
        self.transport = transport
        conditionalRequestState = ResetRadarConditionalRequestState()
    }

    func read() async -> ResetRadarFetchResult {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        request.timeoutInterval = ResetRadarHTTPBounds.connectionTimeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let requestETag = await conditionalRequestState.currentETag()
        if let requestETag {
            request.setValue(requestETag, forHTTPHeaderField: "If-None-Match")
        }

        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.data(
                for: request,
                maximumBytes: Self.maximumResponseBytes
            )
        } catch ResetRadarTransportError.responseTooLarge {
            return .failed(reason: .responseTooLarge, retryAfterSeconds: nil)
        } catch {
            return .failed(reason: .network, retryAfterSeconds: nil)
        }

        switch response.statusCode {
        case 200 ..< 300:
            break
        case 304 where requestETag != nil:
            return .notModified
        case 304:
            return .failed(reason: .invalidResponse, retryAfterSeconds: nil)
        case 429:
            return .failed(
                reason: .rateLimited,
                retryAfterSeconds: Self.parseRetryAfter(
                    response.value(forHTTPHeaderField: "Retry-After")
                )
            )
        default:
            return .failed(reason: .upstreamUnavailable, retryAfterSeconds: nil)
        }

        guard data.count <= Self.maximumResponseBytes,
              let parsed = try? ResetRadarParser.parse(data),
              parsed.hasUsableCapability else {
            return .failed(reason: .invalidResponse, retryAfterSeconds: nil)
        }
        await conditionalRequestState.accept(
            etag: response.value(forHTTPHeaderField: "ETag")
        )
        return .modified(parsed)
    }

    static func parseRetryAfter(_ value: String?, now: Date = Date()) -> Int? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        if let seconds = Int(value), seconds >= 0 { return seconds }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        guard let retryAt = formatter.date(from: value) else { return nil }
        return max(0, Int(ceil(retryAt.timeIntervalSince(now))))
    }
}
