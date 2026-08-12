import Foundation

protocol RedactingLogSink: Sendable {
    func write(_ message: String)
}

struct RedactingLogger: Sendable {
    private let sink: any RedactingLogSink
    private let secrets: [String]

    init(sink: any RedactingLogSink, secrets: [String]) {
        self.sink = sink
        self.secrets = secrets.filter { !$0.isEmpty }
    }

    func error(code: String, detail: String? = nil) {
        write(level: "error", code: code, hasDetail: detail != nil)
    }

    func info(code: String, detail: String? = nil) {
        write(level: "info", code: code, hasDetail: detail != nil)
    }

    private func write(level: String, code: String, hasDetail: Bool) {
        let publicCode = sanitizedPublicCode(code)
        let suffix = hasDetail ? " detail=[REDACTED]" : ""
        sink.write("level=\(level) code=\(publicCode)\(suffix)")
    }

    private func sanitizedPublicCode(_ code: String) -> String {
        guard !secrets.contains(where: { code.localizedCaseInsensitiveContains($0) }) else {
            return "invalid_log_code"
        }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789_.-")
        guard !code.isEmpty,
              code.count <= 64,
              code.unicodeScalars.allSatisfy(allowed.contains) else {
            return "invalid_log_code"
        }
        return code
    }
}
