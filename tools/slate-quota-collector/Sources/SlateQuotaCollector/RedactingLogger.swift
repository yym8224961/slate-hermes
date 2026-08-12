import Foundation

protocol RedactingLogSink: Sendable {
    func write(_ message: String)
}

enum PublicLogCode: String, CaseIterable, Sendable {
    case collectorStarted = "collector_started"
    case collectorSucceeded = "collector_succeeded"
    case providerFailed = "provider_failed"
    case pushFailed = "push_failed"
    case cacheCorrupt = "cache_corrupt"
    case cacheIO = "cache_io"
    case timeout
    case unauthorized
    case unauthenticated
    case unconfigured
    case subscriptionRequired = "subscription_required"
    case rateLimited = "rate_limited"
    case serverError = "server_error"
    case invalidData = "invalid_data"
    case invalidResponse = "invalid_response"
    case launchFailed = "launch_failed"
    case inputFailed = "input_failed"
    case transportError = "transport_error"
    case httpError = "http_error"
}

struct RedactingLogger: Sendable {
    private let sink: any RedactingLogSink

    init(sink: any RedactingLogSink) {
        self.sink = sink
    }

    func error(code: PublicLogCode, detail: String? = nil) {
        write(level: "error", code: code, hasDetail: detail != nil)
    }

    func info(code: PublicLogCode, detail: String? = nil) {
        write(level: "info", code: code, hasDetail: detail != nil)
    }

    private func write(level: String, code: PublicLogCode, hasDetail: Bool) {
        let suffix = hasDetail ? " detail=[REDACTED]" : ""
        sink.write("level=\(level) code=\(code.rawValue)\(suffix)")
    }
}
