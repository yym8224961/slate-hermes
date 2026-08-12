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

    enum RemovalReason: Equatable, Sendable {
        case release
        case staleRecovery
        case createCleanup
    }

    struct TestingHooks {
        var failCreateAfterOpen = false
        var failInitialCreateFstat = false
        var failAfterQuarantine: RemovalReason?
        var failDirectoryEnumerationAfterReadCount: Int?
        var beforeQuarantine: ((RemovalReason, URL) -> Void)?
        var afterQuarantine: ((RemovalReason, URL) -> Void)?

        init(
            failCreateAfterOpen: Bool = false,
            failInitialCreateFstat: Bool = false,
            failAfterQuarantine: RemovalReason? = nil,
            failDirectoryEnumerationAfterReadCount: Int? = nil,
            beforeQuarantine: ((RemovalReason, URL) -> Void)? = nil,
            afterQuarantine: ((RemovalReason, URL) -> Void)? = nil
        ) {
            self.failCreateAfterOpen = failCreateAfterOpen
            self.failInitialCreateFstat = failInitialCreateFstat
            self.failAfterQuarantine = failAfterQuarantine
            self.failDirectoryEnumerationAfterReadCount = failDirectoryEnumerationAfterReadCount
            self.beforeQuarantine = beforeQuarantine
            self.afterQuarantine = afterQuarantine
        }
    }

    final class Lease: @unchecked Sendable {
        private let applicationSupportURL: URL
        private let record: Record
        private let fileIdentity: FileIdentity
        private let directoryIdentity: FileIdentity
        private let stateLock = NSLock()
        private var released = false
        private var testingHooks: TestingHooks

        fileprivate init(
            applicationSupportURL: URL,
            record: Record,
            fileIdentity: FileIdentity,
            directoryIdentity: FileIdentity,
            testingHooks: TestingHooks
        ) {
            self.applicationSupportURL = applicationSupportURL
            self.record = record
            self.fileIdentity = fileIdentity
            self.directoryIdentity = directoryIdentity
            self.testingHooks = testingHooks
        }

        func setTestingHooks(_ hooks: TestingHooks) {
            stateLock.withLock { testingHooks = hooks }
        }

        func release() throws {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard !released else { return }
            try RunLock.release(
                at: applicationSupportURL,
                record: record,
                fileIdentity: fileIdentity,
                directoryIdentity: directoryIdentity,
                testingHooks: testingHooks
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

    private struct InspectedLock {
        let record: Record?
        let identity: FileIdentity
        let bytes: Data
    }

    private static let directoryName = "SlateQuotaCollector"
    private static let lockName = "run.lock"
    private static let maximumRecordBytes = 4_096
    private static let maximumArtifactBytes = 64 * 1_024
    // A fixed RENAME_EXCL target bounds current-version crash residue to one file.
    private static let quarantineName = ".run.lock.recovery"
    private static let legacyQuarantinePrefix = ".run.lock.quarantine-"

    static func directoryURL(in applicationSupportURL: URL) -> URL {
        applicationSupportURL.appendingPathComponent(directoryName, isDirectory: true)
    }

    static func url(in applicationSupportURL: URL) -> URL {
        directoryURL(in: applicationSupportURL).appendingPathComponent(lockName)
    }

    static func acquire(
        at applicationSupportURL: URL,
        pid: pid_t,
        isProcessAlive: ProcessLiveness,
        testingHooks: TestingHooks = .init()
    ) throws -> Lease? {
        guard pid > 0 else { throw RunLockError.invalidPID }

        return try withLockedDirectory(at: applicationSupportURL, testingHooks: testingHooks) { directory in
            for attempt in 0...1 {
                let record = Record(pid: pid, startedAt: currentTimestamp())
                switch try create(
                    record,
                    in: directory.descriptor,
                    applicationSupportURL: applicationSupportURL,
                    testingHooks: testingHooks
                ) {
                case let .created(identity):
                    return Lease(
                        applicationSupportURL: applicationSupportURL,
                        record: record,
                        fileIdentity: identity,
                        directoryIdentity: directory.identity,
                        testingHooks: testingHooks
                    )
                case .alreadyExists:
                    let inspected = try inspectLock(in: directory.descriptor)

                    if let owner = inspected.record, isProcessAlive(owner.pid) {
                        return nil
                    }
                    guard attempt == 0 else { throw RunLockError.staleRecoveryFailed }
                    testingHooks.beforeQuarantine?(.staleRecovery, url(in: applicationSupportURL))
                    let removed = try quarantineAndRemove(
                        in: directory.descriptor,
                        expected: inspected,
                        reason: .staleRecovery,
                        applicationSupportURL: applicationSupportURL,
                        testingHooks: testingHooks
                    )
                    guard removed else { throw RunLockError.staleRecoveryFailed }
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
            guard let record = try inspectLock(in: directory.descriptor).record else {
                throw RunLockError.invalidRecord
            }
            return record.pid
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
            guard case .created = try create(
                record,
                in: directory.descriptor,
                applicationSupportURL: applicationSupportURL,
                testingHooks: .init()
            ) else {
                throw RunLockError.ioFailure
            }
        }
    }

    private enum CreateResult {
        case created(FileIdentity)
        case alreadyExists
    }

    private static func create(
        _ record: Record,
        in directoryDescriptor: Int32,
        applicationSupportURL: URL,
        testingHooks: TestingHooks
    ) throws -> CreateResult {
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
        var descriptorIsOpen = true

        var createdIdentity: FileIdentity?
        do {
            var status = stat()
            if testingHooks.failInitialCreateFstat { throw RunLockError.ioFailure }
            guard fstat(descriptor, &status) == 0 else { throw RunLockError.ioFailure }
            let identity = FileIdentity(status)
            createdIdentity = identity
            guard status.st_mode & S_IFMT == S_IFREG,
                  status.st_uid == geteuid(),
                  status.st_nlink == 1 else {
                throw RunLockError.unsafeLockFile
            }
            if testingHooks.failCreateAfterOpen {
                throw RunLockError.ioFailure
            }
            guard fchmod(descriptor, S_IRUSR | S_IWUSR) == 0 else {
                throw RunLockError.ioFailure
            }
            let data = try encode(record)
            try writeAll(data, to: descriptor)
            guard fsync(descriptor) == 0 else { throw RunLockError.ioFailure }
            let closeResult = close(descriptor)
            descriptorIsOpen = false
            guard closeResult == 0 else { throw RunLockError.ioFailure }
            return .created(identity)
        } catch {
            testingHooks.beforeQuarantine?(.createCleanup, url(in: applicationSupportURL))
            let cleanupResult = Result {
                if createdIdentity == nil {
                    var retryStatus = stat()
                    if fstat(descriptor, &retryStatus) == 0 {
                        createdIdentity = FileIdentity(retryStatus)
                    }
                }
                guard let createdIdentity else { return }
                let current = try inspectLock(in: directoryDescriptor)
                guard current.identity == createdIdentity else { return }
                _ = try quarantineAndRemove(
                    in: directoryDescriptor,
                    expected: current,
                    reason: .createCleanup,
                    applicationSupportURL: applicationSupportURL,
                    testingHooks: testingHooks
                )
            }
            if descriptorIsOpen { _ = close(descriptor) }
            if case let .failure(cleanupError) = cleanupResult { throw cleanupError }
            throw error
        }
    }

    private static func release(
        at applicationSupportURL: URL,
        record: Record,
        fileIdentity: FileIdentity,
        directoryIdentity: FileIdentity,
        testingHooks: TestingHooks
    ) throws {
        try withLockedDirectory(at: applicationSupportURL, testingHooks: testingHooks) { directory in
            guard directory.identity == directoryIdentity else { return }
            let current: InspectedLock
            do {
                current = try inspectLock(in: directory.descriptor)
            } catch let error as POSIXError where error.code == .ENOENT {
                return
            } catch RunLockError.invalidRecord {
                return
            }
            guard current.record == record, current.identity == fileIdentity else { return }
            testingHooks.beforeQuarantine?(.release, url(in: applicationSupportURL))
            _ = try quarantineAndRemove(
                in: directory.descriptor,
                expected: current,
                reason: .release,
                applicationSupportURL: applicationSupportURL,
                testingHooks: testingHooks
            )
        }
    }

    private static func inspectLock(
        in directoryDescriptor: Int32,
        name: String = lockName
    ) throws -> InspectedLock {
        let descriptor = openat(
            directoryDescriptor,
            name,
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
        guard status.st_size >= 0, status.st_size <= maximumArtifactBytes else {
            throw RunLockError.unsafeLockFile
        }

        let data = try readBounded(from: descriptor, maximumBytes: maximumArtifactBytes)
        var finalStatus = stat()
        guard fstat(descriptor, &finalStatus) == 0,
              FileIdentity(finalStatus) == FileIdentity(status),
              finalStatus.st_size == status.st_size else {
            throw RunLockError.ioFailure
        }
        let record = data.count <= maximumRecordBytes ? try? decode(data) : nil
        return InspectedLock(record: record, identity: FileIdentity(status), bytes: data)
    }

    private static func quarantineAndRemove(
        in directoryDescriptor: Int32,
        expected: InspectedLock,
        reason: RemovalReason,
        applicationSupportURL: URL,
        testingHooks: TestingHooks
    ) throws -> Bool {
        guard renameatx_np(
            directoryDescriptor,
            lockName,
            directoryDescriptor,
            quarantineName,
            UInt32(RENAME_EXCL)
        ) == 0 else {
            if errno == ENOENT { return false }
            throw RunLockError.ioFailure
        }

        let quarantineURL = directoryURL(in: applicationSupportURL).appendingPathComponent(quarantineName)
        testingHooks.afterQuarantine?(reason, quarantineURL)
        if testingHooks.failAfterQuarantine == reason { throw RunLockError.ioFailure }

        let isolated: InspectedLock
        do {
            isolated = try inspectLock(in: directoryDescriptor, name: quarantineName)
        } catch {
            try restoreQuarantine(quarantineName, in: directoryDescriptor)
            throw error
        }

        guard isolated.identity == expected.identity, isolated.bytes == expected.bytes else {
            try restoreQuarantine(quarantineName, in: directoryDescriptor)
            return false
        }
        let pathIdentity = try regularFileIdentity(named: quarantineName, in: directoryDescriptor)
        guard pathIdentity == isolated.identity else {
            try restoreQuarantine(quarantineName, in: directoryDescriptor)
            return false
        }
        guard unlinkat(directoryDescriptor, quarantineName, 0) == 0 else {
            throw RunLockError.ioFailure
        }
        return true
    }

    private static func restoreQuarantine(_ quarantineName: String, in directoryDescriptor: Int32) throws {
        guard renameatx_np(
            directoryDescriptor,
            quarantineName,
            directoryDescriptor,
            lockName,
            UInt32(RENAME_EXCL)
        ) == 0 else {
            if errno == EEXIST { throw RunLockError.staleRecoveryFailed }
            throw RunLockError.ioFailure
        }
    }

    private static func regularFileIdentity(named name: String, in directoryDescriptor: Int32) throws -> FileIdentity {
        var status = stat()
        guard fstatat(directoryDescriptor, name, &status, AT_SYMLINK_NOFOLLOW) == 0 else {
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

    private static func recoverControlledQuarantine(
        in directoryDescriptor: Int32,
        failEnumerationAfterReadCount: Int?
    ) throws {
        let artifacts = try controlledQuarantineNames(
            in: directoryDescriptor,
            failAfterReadCount: failEnumerationAfterReadCount
        )
        guard artifacts.count <= 1 else { throw RunLockError.staleRecoveryFailed }
        guard let artifactName = artifacts.first else { return }

        _ = try inspectLock(in: directoryDescriptor, name: artifactName)
        var activeStatus = stat()
        if fstatat(directoryDescriptor, lockName, &activeStatus, AT_SYMLINK_NOFOLLOW) == 0 {
            // The public successor always wins; recovery never mutates run.lock.
            guard unlinkat(directoryDescriptor, artifactName, 0) == 0 else {
                throw RunLockError.ioFailure
            }
            return
        }
        guard errno == ENOENT else { throw RunLockError.ioFailure }
        guard renameatx_np(
            directoryDescriptor,
            artifactName,
            directoryDescriptor,
            lockName,
            UInt32(RENAME_EXCL)
        ) == 0 else {
            throw RunLockError.ioFailure
        }
    }

    private static func controlledQuarantineNames(
        in directoryDescriptor: Int32,
        failAfterReadCount: Int?
    ) throws -> [String] {
        let duplicate = dup(directoryDescriptor)
        guard duplicate >= 0 else { throw RunLockError.ioFailure }
        guard let stream = fdopendir(duplicate) else {
            _ = close(duplicate)
            throw RunLockError.ioFailure
        }
        defer { _ = closedir(stream) }

        var names: [String] = []
        var readCount = 0
        while true {
            errno = 0
            let entry: UnsafeMutablePointer<dirent>?
            if failAfterReadCount == readCount {
                errno = EIO
                entry = nil
            } else {
                entry = readdir(stream)
            }
            guard let entry else {
                let readError = errno
                guard readError == 0 else { throw RunLockError.ioFailure }
                break
            }
            readCount += 1
            var rawName = entry.pointee.d_name
            let name = withUnsafeBytes(of: &rawName) { bytes -> String in
                String(cString: bytes.bindMemory(to: CChar.self).baseAddress!)
            }
            if name == quarantineName {
                names.append(name)
            } else if name.hasPrefix(legacyQuarantinePrefix) {
                let suffix = String(name.dropFirst(legacyQuarantinePrefix.count))
                guard UUID(uuidString: suffix) != nil else { throw RunLockError.unsafeLockFile }
                names.append(name)
            }
        }
        return names
    }

    private static func withLockedDirectory<T>(
        at applicationSupportURL: URL,
        testingHooks: TestingHooks = .init(),
        _ operation: (OpenedDirectory) throws -> T
    ) throws -> T {
        let directory = try openDirectory(at: applicationSupportURL)
        defer { _ = close(directory.descriptor) }
        guard flock(directory.descriptor, LOCK_EX) == 0 else { throw RunLockError.ioFailure }
        defer { _ = flock(directory.descriptor, LOCK_UN) }
        try recoverControlledQuarantine(
            in: directory.descriptor,
            failEnumerationAfterReadCount: testingHooks.failDirectoryEnumerationAfterReadCount
        )
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

    private static func readBounded(from descriptor: Int32, maximumBytes: Int) throws -> Data {
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 512)
        while result.count <= maximumBytes {
            let count = Darwin.read(descriptor, &buffer, min(buffer.count, maximumBytes + 1 - result.count))
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
        let result = kill(pid, 0)
        return classifyProcessLiveness(killResult: result, errorNumber: errno)
    }

    static func classifyProcessLiveness(killResult: Int32, errorNumber: Int32) -> Bool {
        if killResult == 0 { return true }
        return switch errorNumber {
        case EPERM: true
        case ESRCH: false
        default: true
        }
    }
}
