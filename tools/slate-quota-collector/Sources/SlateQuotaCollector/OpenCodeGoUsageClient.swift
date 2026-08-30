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
    case invalidResponse

    var publicCode: String {
        switch self {
        case .unauthorized: "unauthorized"
        case .subscriptionRequired: "subscription_required"
        case .rateLimited: "rate_limited"
        case .server: "server_error"
        case let .http(status): "http_\(status)"
        case .timeout: "timeout"
        case .transport: "transport_error"
        case .invalidResponse: "invalid_response"
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

        do {
            let wire = try JSONDecoder().decode(OpenCodeGoWireResponse.self, from: data)
            let usage = try Self.normalized(wire)
            try Self.validate(usage)
            return usage
        } catch {
            throw OpenCodeGoClientError.invalidResponse
        }
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
            guard window.resetAt.timeIntervalSinceReferenceDate.isFinite,
                  window.usagePercent.isFinite,
                  (0 ... 100).contains(window.usagePercent) else {
                throw OpenCodeGoClientError.invalidResponse
            }
        }
    }

    private static func normalized(_ wire: OpenCodeGoWireResponse) throws -> OpenCodeGoUsageResponse {
        OpenCodeGoUsageResponse(
            rollingUsage: try normalized(wire.usage.rolling),
            weeklyUsage: try normalized(wire.usage.weekly),
            monthlyUsage: try normalized(wire.usage.monthly)
        )
    }

    private static func normalized(_ wire: OpenCodeGoWireWindow) throws -> OpenCodeGoUsageWindow {
        guard let resetAt = parseDate(wire.resetsAt) else {
            throw OpenCodeGoClientError.invalidResponse
        }
        return OpenCodeGoUsageWindow(
            status: wire.status,
            resetAt: resetAt,
            usagePercent: wire.percent
        )
    }

    private static func parseDate(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let value = fractional.date(from: text) { return value }
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        return ordinary.date(from: text)
    }
}

private struct OpenCodeGoWireResponse: Decodable {
    let usage: OpenCodeGoWireUsage
}

private struct OpenCodeGoWireUsage: Decodable {
    let rolling: OpenCodeGoWireWindow
    let weekly: OpenCodeGoWireWindow
    let monthly: OpenCodeGoWireWindow
}

private struct OpenCodeGoWireWindow: Decodable {
    let status: OpenCodeGoUsageWindow.Status
    let percent: Double
    let resetsAt: String
}
