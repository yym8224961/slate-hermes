import Foundation

enum CodexClientError: Error, Equatable, Sendable {
    case rpc(code: Int)
    case timeout
    case invalidResponse
    case launchFailed
    case inputFailed
}

struct CodexRateLimitClient: CodexRateLimitReading, Sendable {
    private static let responseID = 2
    private static let timeout: Duration = .seconds(20)
    private static let requestLines = [
        #"{"method":"initialize","id":1,"params":{"clientInfo":{"name":"slate_quota_collector","title":"Slate quota collector","version":"1.0.0"}}}"#,
        #"{"method":"initialized","params":{}}"#,
        #"{"method":"account/rateLimits/read","id":2,"params":{}}"#,
    ].map { Data(($0 + "\n").utf8) }

    private let executableURL: URL
    private let transport: any CodexAppServerTransport

    init(
        executableURL: URL,
        transport: any CodexAppServerTransport = CodexAppServerProcessTransport()
    ) {
        self.executableURL = executableURL
        self.transport = transport
    }

    init(
        configuration: CollectorConfiguration,
        transport: any CodexAppServerTransport = CodexAppServerProcessTransport()
    ) {
        self.init(
            executableURL: URL(fileURLWithPath: configuration.codexExecutablePath),
            transport: transport
        )
    }

    func read() async throws -> CodexRateLimitsReadResult {
        let response = try await transport.request(
            executableURL: executableURL,
            lines: Self.requestLines,
            responseID: Self.responseID,
            timeout: Self.timeout
        )
        return try Self.decode(response)
    }

    static func decode(_ data: Data) throws -> CodexRateLimitsReadResult {
        let response: Response
        do {
            response = try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw CodexClientError.invalidResponse
        }
        guard response.id == responseID else {
            throw CodexClientError.invalidResponse
        }
        if let error = response.error {
            throw CodexClientError.rpc(code: error.code)
        }
        guard let result = response.result else {
            throw CodexClientError.invalidResponse
        }
        return result
    }

    private struct Response: Decodable {
        let id: Int
        let result: CodexRateLimitsReadResult?
        let error: ResponseError?
    }

    private struct ResponseError: Decodable {
        let code: Int
    }
}
