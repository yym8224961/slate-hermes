import Darwin
import Foundation

enum RunLockError: Error, Equatable, Sendable {
    case invalidPID
    case unsafeDirectory
    case unsafeLockFile
    case invalidRecord
    case ioFailure
    case staleRecoveryFailed
}

enum RunLock {
    typealias ProcessLiveness = (pid_t) -> Bool

    final class Lease: @unchecked Sendable {
        private let applicationSupportURL: URL
        private let record: Record
        private let fileIdentity: FileIdentity
        private let directoryIdentity: FileIdentity
        private let stateLock = NSLock()
        private var released = false

        fileprivate init(
            applicationSupportURL: URL,
            record: Record,
            fileIdentity: FileIdentity,
            directoryIdentity: FileIdentity
        ) {
            self.applicationSupportURL = applicationSupportURL
            self.record = record
            self.fileIdentity = fileIdentity
            self.directoryIdentity = directoryIdentity
        }

        func release() throws {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard !released else { return }
            try RunLock.release(
                at: applicationSupportURL,
                record: record,
                fileIdentity: fileIdentity,
                directoryIdentity: directoryIdentity
            )
            released = true
        }

        deinit {
            try? release()
        }
    }

    fileprivate struct Record: Codable, Equatable, Sendable {
        let pid: pid_t
        let startedAt: String

        enum CodingKeys: String, CodingKey {
            case pid
            case startedAt = "started_at"
        }
    }

    fileprivate struct FileIdentity: Equatable, Sendable {
        let device: dev_t
        let inode: ino_t

        init(_ status: stat) {
            device = status.st_dev
            inode = status.st_ino
        }
    }

    private struct OpenedDirectory {
        let descriptor: Int32
        let identity: FileIdentity
    }

    private static let directoryName = "SlateQuotaCollector"
    private static let lockName = "run.lock"
    private static let maximumRecordBytes = 4_096

    static func directoryURL(in applicationSupportURL: URL) -> URL {
        applicationSupportURL.appendingPathComponent(directoryName, isDirectory: true)
    }

    static func url(in applicationSupportURL: URL) -> URL {
        directoryURL(in: applicationSupportURL).appendingPathComponent(lockName)
    }

    static func acquire(
        at applicationSupportURL: URL,
        pid: pid_t,
        isProcessAlive: ProcessLiveness
    ) throws -> Lease? {
        guard pid > 0 else { throw RunLockError.invalidPID }

        return try withLockedDirectory(at: applicationSupportURL) { directory in
            for attempt in 0...1 {
                let record = Record(pid: pid, startedAt: currentTimestamp())
                switch try create(record, in: directory.descriptor) {
                case let .created(identity):
                    return Lease(
                        applicationSupportURL: applicationSupportURL,
                        record: record,
                        fileIdentity: identity,
                        directoryIdentity: directory.identity
                    )
                case .alreadyExists:
                    let owner: Record?
                    do {
                        owner = try readRecord(in: directory.descriptor).record
                    } catch RunLockError.invalidRecord {
                        owner = nil
                    }

                    if let owner, isProcessAlive(owner.pid) {
                        return nil
                    }
                    guard attempt == 0 else { throw RunLockError.staleRecoveryFailed }
                    try removeStaleRegularLock(in: directory.descriptor)
                }
            }
            throw RunLockError.staleRecoveryFailed
        }
    }

    static func acquire(at applicationSupportURL: URL, pid: pid_t = getpid()) throws -> Lease? {
        try acquire(at: applicationSupportURL, pid: pid, isProcessAlive: processIsAlive)
    }

    static func readPID(at applicationSupportURL: URL) throws -> pid_t {
        try withLockedDirectory(at: applicationSupportURL) { directory in
            try readRecord(in: directory.descriptor).record.pid
        }
    }

    static func writeFixture(
        at applicationSupportURL: URL,
        pid: pid_t,
        startedAt: String = "2026-08-12T00:00:00.000000000Z"
    ) throws {
        guard pid > 0 else { throw RunLockError.invalidPID }
        let record = Record(pid: pid, startedAt: startedAt)
        guard timestampIsValid(startedAt) else { throw RunLockError.invalidRecord }
        try withLockedDirectory(at: applicationSupportURL) { directory in
            guard case .created = try create(record, in: directory.descriptor) else {
                throw RunLockError.ioFailure
            }
        }
    }

    private enum CreateResult {
        case created(FileIdentity)
        case alreadyExists
    }

    private static func create(_ record: Record, in directoryDescriptor: Int32) throws -> CreateResult {
        let descriptor = openat(
            directoryDescriptor,
            lockName,
            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
            S_IRUSR | S_IWUSR
        )
        guard descriptor >= 0 else {
            if errno == EEXIST { return .alreadyExists }
            throw RunLockError.ioFailure
        }

        var keepFile = false
        defer {
            _ = close(descriptor)
            if !keepFile { _ = unlinkat(directoryDescriptor, lockName, 0) }
        }

        guard fchmod(descriptor, S_IRUSR | S_IWUSR) == 0 else {
            throw RunLockError.ioFailure
        }
        let data = try encode(record)
        try writeAll(data, to: descriptor)
        guard fsync(descriptor) == 0 else { throw RunLockError.ioFailure }

        var status = stat()
        guard fstat(descriptor, &status) == 0,
              status.st_mode & S_IFMT == S_IFREG,
              status.st_uid == geteuid(),
              status.st_nlink == 1 else {
            throw RunLockError.unsafeLockFile
        }
        keepFile = true
        return .created(FileIdentity(status))
    }

    private static func release(
        at applicationSupportURL: URL,
        record: Record,
        fileIdentity: FileIdentity,
        directoryIdentity: FileIdentity
    ) throws {
        try withLockedDirectory(at: applicationSupportURL) { directory in
            guard directory.identity == directoryIdentity else { return }
            let pathIdentity: FileIdentity
            do {
                pathIdentity = try regularFileIdentity(in: directory.descriptor)
            } catch let error as POSIXError where error.code == .ENOENT {
                return
            }
            guard pathIdentity == fileIdentity else { return }
            let current: (record: Record, identity: FileIdentity)
            do {
                current = try readRecord(in: directory.descriptor)
            } catch let error as POSIXError where error.code == .ENOENT {
                return
            } catch RunLockError.invalidRecord {
                return
            }
            guard current.record == record, current.identity == fileIdentity else { return }
            guard unlinkat(directory.descriptor, lockName, 0) == 0 else {
                if errno == ENOENT { return }
                throw RunLockError.ioFailure
            }
        }
    }

    private static func readRecord(in directoryDescriptor: Int32) throws -> (record: Record, identity: FileIdentity) {
        let descriptor = openat(
            directoryDescriptor,
            lockName,
            O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else {
            if errno == ELOOP { throw RunLockError.unsafeLockFile }
            if errno == ENOENT { throw POSIXError(.ENOENT) }
            throw RunLockError.ioFailure
        }
        defer { _ = close(descriptor) }

        var status = stat()
        guard fstat(descriptor, &status) == 0 else { throw RunLockError.ioFailure }
        guard status.st_mode & S_IFMT == S_IFREG,
              status.st_uid == geteuid(),
              status.st_nlink == 1 else {
            throw RunLockError.unsafeLockFile
        }
        guard status.st_size >= 0, status.st_size <= maximumRecordBytes else {
            throw RunLockError.invalidRecord
        }

        let data = try readBounded(from: descriptor)
        return (try decode(data), FileIdentity(status))
    }

    private static func removeStaleRegularLock(in directoryDescriptor: Int32) throws {
        _ = try regularFileIdentity(in: directoryDescriptor)
        guard unlinkat(directoryDescriptor, lockName, 0) == 0 else {
            if errno == ENOENT { return }
            throw RunLockError.ioFailure
        }
    }

    private static func regularFileIdentity(in directoryDescriptor: Int32) throws -> FileIdentity {
        var status = stat()
        guard fstatat(directoryDescriptor, lockName, &status, AT_SYMLINK_NOFOLLOW) == 0 else {
            if errno == ENOENT { throw POSIXError(.ENOENT) }
            throw RunLockError.ioFailure
        }
        guard status.st_mode & S_IFMT == S_IFREG,
              status.st_uid == geteuid(),
              status.st_nlink == 1 else {
            throw RunLockError.unsafeLockFile
        }
        return FileIdentity(status)
    }

    private static func withLockedDirectory<T>(
        at applicationSupportURL: URL,
        _ operation: (OpenedDirectory) throws -> T
    ) throws -> T {
        let directory = try openDirectory(at: applicationSupportURL)
        defer { _ = close(directory.descriptor) }
        guard flock(directory.descriptor, LOCK_EX) == 0 else { throw RunLockError.ioFailure }
        defer { _ = flock(directory.descriptor, LOCK_UN) }
        return try operation(directory)
    }

    private static func openDirectory(at applicationSupportURL: URL) throws -> OpenedDirectory {
        let rootDescriptor = open(
            applicationSupportURL.path,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard rootDescriptor >= 0 else { throw RunLockError.unsafeDirectory }
        defer { _ = close(rootDescriptor) }

        var rootStatus = stat()
        guard fstat(rootDescriptor, &rootStatus) == 0,
              rootStatus.st_mode & S_IFMT == S_IFDIR,
              rootStatus.st_uid == geteuid() else {
            throw RunLockError.unsafeDirectory
        }

        if mkdirat(rootDescriptor, directoryName, S_IRWXU) != 0, errno != EEXIST {
            throw RunLockError.ioFailure
        }
        let descriptor = openat(
            rootDescriptor,
            directoryName,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else { throw RunLockError.unsafeDirectory }

        var status = stat()
        guard fstat(descriptor, &status) == 0,
              status.st_mode & S_IFMT == S_IFDIR,
              status.st_uid == geteuid(),
              status.st_nlink >= 2,
              fchmod(descriptor, S_IRWXU) == 0 else {
            _ = close(descriptor)
            throw RunLockError.unsafeDirectory
        }
        return OpenedDirectory(descriptor: descriptor, identity: FileIdentity(status))
    }

    private static func encode(_ record: Record) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        do {
            return try encoder.encode(record)
        } catch {
            throw RunLockError.invalidRecord
        }
    }

    private static func decode(_ data: Data) throws -> Record {
        let raw: Any
        do {
            raw = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw RunLockError.invalidRecord
        }
        guard let object = raw as? [String: Any],
              Set(object.keys) == Set(["pid", "started_at"]) else {
            throw RunLockError.invalidRecord
        }

        let decoder = JSONDecoder()
        let record: Record
        do {
            record = try decoder.decode(Record.self, from: data)
        } catch {
            throw RunLockError.invalidRecord
        }
        guard record.pid > 0, timestampIsValid(record.startedAt) else {
            throw RunLockError.invalidRecord
        }
        return record
    }

    private static func readBounded(from descriptor: Int32) throws -> Data {
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 512)
        while result.count <= maximumRecordBytes {
            let count = Darwin.read(descriptor, &buffer, min(buffer.count, maximumRecordBytes + 1 - result.count))
            if count == 0 { return result }
            if count < 0 {
                if errno == EINTR { continue }
                throw RunLockError.ioFailure
            }
            result.append(buffer, count: count)
        }
        throw RunLockError.invalidRecord
    }

    private static func writeAll(_ data: Data, to descriptor: Int32) throws {
        try data.withUnsafeBytes { rawBuffer in
            guard var cursor = rawBuffer.baseAddress else { return }
            var remaining = rawBuffer.count
            while remaining > 0 {
                let count = Darwin.write(descriptor, cursor, remaining)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw RunLockError.ioFailure }
                remaining -= count
                cursor = cursor.advanced(by: count)
            }
        }
    }

    private static func currentTimestamp() -> String {
        var value = timespec()
        clock_gettime(CLOCK_REALTIME, &value)
        let date = Date(timeIntervalSince1970: TimeInterval(value.tv_sec))
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return "\(formatter.string(from: date)).\(String(format: "%09ld", value.tv_nsec))Z"
    }

    private static func timestampIsValid(_ value: String) -> Bool {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if formatter.date(from: value) != nil { return true }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value) != nil
    }

    private static func processIsAlive(_ pid: pid_t) -> Bool {
        guard pid > 0 else { return false }
        if kill(pid, 0) == 0 { return true }
        return switch errno {
        case EPERM: true
        case ESRCH: false
        default: true
        }
    }
}
