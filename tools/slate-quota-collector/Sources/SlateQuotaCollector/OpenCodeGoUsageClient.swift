import Foundation

protocol HTTPTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

struct URLSessionHTTPTransport: HTTPTransport, Sendable {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, httpResponse)
    }
}

enum OpenCodeGoClientError: Error, Equatable, Sendable, LocalizedError {
    case unauthorized
    case subscriptionRequired
    case rateLimited
    case server
    case http(status: Int)
    case timeout
    case transport

    var publicCode: String {
        switch self {
        case .unauthorized: "unauthorized"
        case .subscriptionRequired: "subscription_required"
        case .rateLimited: "rate_limited"
        case .server: "server_error"
        case let .http(status): "http_\(status)"
        case .timeout: "timeout"
        case .transport: "transport_error"
        }
    }

    var errorDescription: String? { publicCode }
}

struct OpenCodeGoUsageClient: OpenCodeGoUsageReading, Sendable {
    private static let usageURL = URL(string: "https://opencode.ai/zen/go/v1/usage")!
    private let transport: any HTTPTransport

    init(transport: any HTTPTransport = URLSessionHTTPTransport()) {
        self.transport = transport
    }

    func read(apiKey: String) async throws -> OpenCodeGoUsageResponse {
        var request = URLRequest(url: Self.usageURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")

        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.data(for: request)
        } catch let error as URLError where error.code == .timedOut {
            throw OpenCodeGoClientError.timeout
        } catch {
            throw OpenCodeGoClientError.transport
        }

        guard response.statusCode == 200 else {
            throw Self.error(for: response.statusCode)
        }

        let usage = try JSONDecoder().decode(OpenCodeGoUsageResponse.self, from: data)
        try Self.validate(usage)
        return usage
    }

    private static func error(for status: Int) -> OpenCodeGoClientError {
        switch status {
        case 401: .unauthorized
        case 403: .subscriptionRequired
        case 429: .rateLimited
        case 500...599: .server
        default: .http(status: status)
        }
    }

    private static func validate(_ usage: OpenCodeGoUsageResponse) throws {
        for window in [usage.rollingUsage, usage.weeklyUsage, usage.monthlyUsage] {
            guard window.resetInSec.isFinite, window.resetInSec >= 0,
                  window.usagePercent.isFinite else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: [], debugDescription: "usage windows must contain finite values and a nonnegative reset")
                )
            }
        }
    }
}
