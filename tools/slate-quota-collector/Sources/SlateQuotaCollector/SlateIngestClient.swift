import Darwin
import Foundation

enum SlateRedirectPolicy {
    static func permits(originalURL _: URL?, proposedURL _: URL) -> Bool {
        false
    }
}

final class SlateNoRedirectSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let onInvalidation: @Sendable (Error?) -> Void

    init(onInvalidation: @escaping @Sendable (Error?) -> Void = { _ in }) {
        self.onInvalidation = onInvalidation
    }

    func urlSession(
        _: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection _: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        let proposedURL = request.url ?? URL(string: "about:blank")!
        completionHandler(
            SlateRedirectPolicy.permits(originalURL: task.originalRequest?.url, proposedURL: proposedURL)
                ? request
                : nil
        )
    }

    func urlSession(_: URLSession, didBecomeInvalidWithError error: Error?) {
        onInvalidation(error)
    }
}

final class SlateURLSessionHTTPTransport: HTTPTransport, @unchecked Sendable {
    let session: URLSession
    private let redirectDelegate: SlateNoRedirectSessionDelegate

    init(
        configuration: URLSessionConfiguration = .ephemeral,
        redirectDelegate: SlateNoRedirectSessionDelegate = SlateNoRedirectSessionDelegate()
    ) {
        self.redirectDelegate = redirectDelegate
        session = URLSession(
            configuration: configuration,
            delegate: redirectDelegate,
            delegateQueue: nil
        )
    }

    deinit {
        session.invalidateAndCancel()
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, httpResponse)
    }
}

enum SlateEndpointError: Error, Equatable, Sendable, LocalizedError {
    case invalidEndpoint

    var publicCode: String { "slate_transport_invalid_endpoint" }
    var errorDescription: String? { publicCode }
}

enum SlateTransportCode: String, Equatable, Sendable {
    case timedOut = "timed_out"
    case cannotFindHost = "cannot_find_host"
    case cannotConnectToHost = "cannot_connect_to_host"
    case networkConnectionLost = "network_connection_lost"
    case dnsLookupFailed = "dns_lookup_failed"
    case notConnectedToInternet = "not_connected_to_internet"
    case resourceUnavailable = "resource_unavailable"
    case badURL = "bad_url"
    case cancelled
    case invalidResponse = "invalid_response"
    case unknown

    init(_ code: URLError.Code) {
        self = switch code {
        case .timedOut: .timedOut
        case .cannotFindHost: .cannotFindHost
        case .cannotConnectToHost: .cannotConnectToHost
        case .networkConnectionLost: .networkConnectionLost
        case .dnsLookupFailed: .dnsLookupFailed
        case .notConnectedToInternet: .notConnectedToInternet
        case .resourceUnavailable: .resourceUnavailable
        case .badURL: .badURL
        case .cancelled: .cancelled
        default: .unknown
        }
    }

    var isTransient: Bool {
        switch self {
        case .timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost,
             .dnsLookupFailed, .notConnectedToInternet, .resourceUnavailable:
            true
        case .badURL, .cancelled, .invalidResponse, .unknown:
            false
        }
    }
}

enum SlateIngestError: Error, Equatable, Sendable, LocalizedError {
    case http(status: Int)
    case transport(SlateTransportCode)

    var publicCode: String {
        switch self {
        case let .http(status): "slate_http_\(status)"
        case let .transport(code): "slate_transport_\(code.rawValue)"
        }
    }

    var errorDescription: String? { publicCode }
}

enum SlateEndpointPolicy {
    static func validate(_ url: URL) throws -> URL {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let rawHost = components.host?.lowercased(), !rawHost.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              hasExactIngestPath(components.percentEncodedPath) else {
            throw SlateEndpointError.invalidEndpoint
        }

        let host = unbracketedIPv6Host(rawHost)
        if scheme == "http", !isPrivateHTTPHost(host) {
            throw SlateEndpointError.invalidEndpoint
        }
        return url
    }

    private static func unbracketedIPv6Host(_ host: String) -> String {
        guard host.first == "[", host.last == "]" else { return host }
        return String(host.dropFirst().dropLast())
    }

    private static func hasExactIngestPath(_ path: String) -> Bool {
        guard path == path.removingPercentEncoding else { return false }
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        guard segments.count == 6,
              segments[0].isEmpty,
              segments[1] == "api",
              segments[2] == "v1",
              segments[3] == "contents",
              segments[5] == "data",
              !segments[4].isEmpty,
              let contentID = String(segments[4]).removingPercentEncoding,
              !contentID.isEmpty,
              contentID != ".",
              contentID != "..",
              !contentID.contains("/"),
              !contentID.contains("\\") else {
            return false
        }
        return true
    }

    private static func isPrivateHTTPHost(_ host: String) -> Bool {
        if host == "localhost" || (host.hasSuffix(".local") && host.count > ".local".count) {
            return true
        }
        if let bytes = ipv4Bytes(host) {
            return bytes[0] == 127
                || bytes[0] == 10
                || (bytes[0] == 172 && (16...31).contains(bytes[1]))
                || (bytes[0] == 192 && bytes[1] == 168)
                || (bytes[0] == 169 && bytes[1] == 254)
        }
        if let bytes = ipv6Bytes(host) {
            let isLoopback = bytes.dropLast().allSatisfy { $0 == 0 } && bytes.last == 1
            let isLinkLocal = bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80
            return isLoopback || isLinkLocal
        }
        return false
    }

    private static func ipv4Bytes(_ host: String) -> [UInt8]? {
        var address = in_addr()
        let parsed = host.withCString { inet_pton(AF_INET, $0, &address) }
        guard parsed == 1 else { return nil }
        return withUnsafeBytes(of: &address) { Array($0) }
    }

    private static func ipv6Bytes(_ host: String) -> [UInt8]? {
        var address = in6_addr()
        let parsed = host.withCString { inet_pton(AF_INET6, $0, &address) }
        guard parsed == 1 else { return nil }
        return withUnsafeBytes(of: &address) { Array($0) }
    }
}

struct SlateIngestClient: SlateIngesting, OpenCodeGoSlateIngesting, Sendable {
    typealias Sleep = @Sendable (Duration) async throws -> Void

    private let transport: any HTTPTransport
    private let sleep: Sleep

    init(
        transport: any HTTPTransport = SlateURLSessionHTTPTransport(),
        sleep: @escaping Sleep = { try await Task.sleep(for: $0) }
    ) {
        self.transport = transport
        self.sleep = sleep
    }

    func push(_ envelope: SlateEnvelope, capabilityURL: URL) async throws -> SlateIngestReceipt {
        var request = URLRequest(url: try SlateEndpointPolicy.validate(capabilityURL))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder.slate.encode(envelope)

        let body = try await perform(request)
        return try decode(SlateIngestReceipt.self, from: body)
    }

    func readCurrentData(capabilityURL: URL) async throws -> SlateDashboardData {
        var request = URLRequest(url: try SlateEndpointPolicy.validate(capabilityURL))
        request.httpMethod = "GET"
        request.timeoutInterval = 15

        let body = try await perform(request)
        return try decodeDashboard(from: body)
    }

    func push(
        _ envelope: OpenCodeGoSlateEnvelope,
        capabilityURL: URL
    ) async throws -> SlateIngestReceipt {
        var request = URLRequest(url: try SlateEndpointPolicy.validate(capabilityURL))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder.slate.encode(envelope)

        let body = try await perform(request)
        return try decode(SlateIngestReceipt.self, from: body)
    }

    func readCurrentOpenCodeGoData(capabilityURL: URL) async throws -> OpenCodeGoDashboardData {
        var request = URLRequest(url: try SlateEndpointPolicy.validate(capabilityURL))
        request.httpMethod = "GET"
        request.timeoutInterval = 15

        let body = try await perform(request)
        return try decode(OpenCodeGoDashboardData.self, from: body)
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        for attempt in 0...1 {
            do {
                let (body, response) = try await transport.data(for: request)
                guard (200...299).contains(response.statusCode) else {
                    let error = SlateIngestError.http(status: response.statusCode)
                    if attempt == 0, Self.isRetryableHTTP(response.statusCode) {
                        try await sleep(.seconds(1))
                        continue
                    }
                    throw error
                }
                return body
            } catch let error as SlateIngestError {
                throw error
            } catch let error as URLError {
                let code = SlateTransportCode(error.code)
                if attempt == 0, code.isTransient {
                    try await sleep(.seconds(1))
                    continue
                }
                throw SlateIngestError.transport(code)
            } catch {
                throw SlateIngestError.transport(.unknown)
            }
        }
        throw SlateIngestError.transport(.unknown)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: value) {
                return date
            }
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: value) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "expected an ISO 8601 timestamp"
            )
        }
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw SlateIngestError.transport(.invalidResponse)
        }
    }

    private func decodeDashboard(from data: Data) throws -> SlateDashboardData {
        try decode(SlateDashboardData.self, from: data)
    }

    private static func isRetryableHTTP(_ status: Int) -> Bool {
        status == 408 || status == 429 || (500...599).contains(status)
    }
}
