import Darwin
import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite("Run lock", .serialized)
struct RunLockTests {
    @Test func activeOwnerMakesThisRunExitSuccessfullyWithoutWork() throws {
        let root = try TemporaryDirectory()
        let acquired = try RunLock.acquire(at: root.url, pid: 100, isProcessAlive: { $0 == 100 })
        let first = try #require(acquired)

        let second = try RunLock.acquire(at: root.url, pid: 200, isProcessAlive: { $0 == 100 })

        #expect(second == nil)
        try first.release()
    }

    @Test func staleOwnerIsReplacedAndReleaseRemovesOnlyOwnLock() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)

        let acquired = try RunLock.acquire(at: root.url, pid: 200, isProcessAlive: { _ in false })
        let lease = try #require(acquired)

        #expect(try RunLock.readPID(at: root.url) == 200)
        try lease.release()
        #expect(FileManager.default.fileExists(atPath: RunLock.url(in: root.url).path) == false)
    }

    @Test func malformedOwnerIsReplacedOnce() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)
        try Data("not-json".utf8).write(to: RunLock.url(in: root.url))

        let acquired = try RunLock.acquire(at: root.url, pid: 200, isProcessAlive: { _ in false })
        let lease = try #require(acquired)

        #expect(try RunLock.readPID(at: root.url) == 200)
        try lease.release()
    }

    @Test func oversizedMalformedOwnerIsReadWithABoundThenReplaced() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)
        try Data(repeating: 0x41, count: 32 * 1_024).write(to: RunLock.url(in: root.url))

        let acquired = try RunLock.acquire(at: root.url, pid: 200, isProcessAlive: { _ in false })
        let lease = try #require(acquired)

        #expect(try RunLock.readPID(at: root.url) == 200)
        try lease.release()
    }

    @Test func twentyConcurrentContendersProduceExactlyOneLease() async throws {
        let root = try TemporaryDirectory()

        let results = await withTaskGroup(
            of: Result<RunLock.Lease?, Error>.self,
            returning: [Result<RunLock.Lease?, Error>].self
        ) { group in
            for pid in 1...20 {
                group.addTask {
                    Result {
                        try RunLock.acquire(at: root.url, pid: pid_t(pid), isProcessAlive: { _ in true })
                    }
                }
            }
            return await group.reduce(into: []) { $0.append($1) }
        }

        var leases: [RunLock.Lease] = []
        var nilCount = 0
        var failureCount = 0
        for result in results {
            switch result {
            case let .success(lease?): leases.append(lease)
            case .success(nil): nilCount += 1
            case .failure: failureCount += 1
            }
        }
        #expect(leases.count == 1)
        #expect(nilCount == 19)
        #expect(failureCount == 0)
        try leases[0].release()
    }

    @Test func releaseQuarantinePreservesLockSwappedAtValidationBoundary() throws {
        let root = try TemporaryDirectory()
        let acquired = try RunLock.acquire(at: root.url, pid: 100, isProcessAlive: { _ in false })
        let original = try #require(acquired)
        let originalData = try Data(contentsOf: RunLock.url(in: root.url))
        let originalInode = try inode(of: RunLock.url(in: root.url))
        let hooks = RunLock.TestingHooks(beforeQuarantine: { reason, lockURL in
            guard reason == .release else { return }
            try! FileManager.default.removeItem(at: lockURL)
            try! originalData.write(to: lockURL, options: .withoutOverwriting)
            #expect(try! self.inode(of: lockURL) != originalInode)
        })
        original.setTestingHooks(hooks)

        try original.release()

        #expect(try RunLock.readPID(at: root.url) == 100)
        #expect(try inode(of: RunLock.url(in: root.url)) != originalInode)
        #expect(try quarantineNames(in: root.url).isEmpty)
    }

    @Test func staleRecoveryQuarantinePreservesReplacementSwappedAfterValidation() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)
        let replacement = Data(#"{"pid":300,"started_at":"2050-01-01T00:00:00Z"}"#.utf8)
        let hooks = RunLock.TestingHooks(beforeQuarantine: { reason, lockURL in
            guard reason == .staleRecovery else { return }
            try! FileManager.default.removeItem(at: lockURL)
            try! replacement.write(to: lockURL, options: .withoutOverwriting)
        })

        #expect(throws: RunLockError.self) {
            try RunLock.acquire(
                at: root.url,
                pid: 200,
                isProcessAlive: { _ in false },
                testingHooks: hooks
            )
        }

        #expect(try RunLock.readPID(at: root.url) == 300)
        #expect(try quarantineNames(in: root.url).isEmpty)
    }

    @Test func failedCreateCleanupQuarantineNeverUnlinksReplacement() throws {
        let root = try TemporaryDirectory()
        let replacement = Data(#"{"pid":300,"started_at":"2050-01-01T00:00:00Z"}"#.utf8)
        let hooks = RunLock.TestingHooks(
            failCreateAfterOpen: true,
            beforeQuarantine: { reason, lockURL in
                guard reason == .createCleanup else { return }
                try! FileManager.default.removeItem(at: lockURL)
                try! replacement.write(to: lockURL, options: .withoutOverwriting)
            }
        )

        #expect(throws: RunLockError.self) {
            try RunLock.acquire(
                at: root.url,
                pid: 200,
                isProcessAlive: { _ in false },
                testingHooks: hooks
            )
        }

        #expect(try RunLock.readPID(at: root.url) == 300)
        #expect(try quarantineNames(in: root.url).isEmpty)
    }

    @Test func successorAtRunLockWinsWhenQuarantineRestoreWouldCollide() throws {
        let root = try TemporaryDirectory()
        let acquired = try RunLock.acquire(at: root.url, pid: 100, isProcessAlive: { _ in false })
        let lease = try #require(acquired)
        let successor = Data(#"{"pid":300,"started_at":"2050-01-01T00:00:00Z"}"#.utf8)
        let hooks = RunLock.TestingHooks(afterQuarantine: { reason, quarantineURL in
            guard reason == .release else { return }
            let handle = try! FileHandle(forWritingTo: quarantineURL)
            try! handle.truncate(atOffset: 0)
            try! handle.write(contentsOf: Data("changed".utf8))
            try! handle.close()
            try! successor.write(to: RunLock.url(in: root.url), options: .withoutOverwriting)
        })
        lease.setTestingHooks(hooks)

        #expect(throws: RunLockError.self) { try lease.release() }
        #expect(try RunLock.readPID(at: root.url) == 300)
        #expect(try quarantineNames(in: root.url).isEmpty)
    }

    @Test func nextAcquireRecoversPostRenameCrashArtifact() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)
        let hooks = RunLock.TestingHooks(failAfterQuarantine: .staleRecovery)

        #expect(throws: RunLockError.self) {
            try RunLock.acquire(
                at: root.url,
                pid: 200,
                isProcessAlive: { _ in false },
                testingHooks: hooks
            )
        }
        #expect(FileManager.default.fileExists(atPath: RunLock.url(in: root.url).path) == false)
        #expect(try quarantineNames(in: root.url).count == 1)

        let acquired = try RunLock.acquire(at: root.url, pid: 300, isProcessAlive: { _ in false })
        let recovered = try #require(acquired)
        #expect(try RunLock.readPID(at: root.url) == 300)
        #expect(try quarantineNames(in: root.url).isEmpty)
        try recovered.release()
    }

    @Test func successorSurvivesWhileNextAcquireCleansCrashArtifact() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)
        let hooks = RunLock.TestingHooks(failAfterQuarantine: .staleRecovery)

        #expect(throws: RunLockError.self) {
            try RunLock.acquire(
                at: root.url,
                pid: 200,
                isProcessAlive: { _ in false },
                testingHooks: hooks
            )
        }
        try Data(#"{"pid":300,"started_at":"2050-01-01T00:00:00.000000000Z"}"#.utf8)
            .write(to: RunLock.url(in: root.url), options: .withoutOverwriting)

        let contender = try RunLock.acquire(at: root.url, pid: 400, isProcessAlive: { $0 == 300 })

        #expect(contender == nil)
        #expect(try RunLock.readPID(at: root.url) == 300)
        #expect(try quarantineNames(in: root.url).isEmpty)
    }

    @Test func multipleControlledArtifactsFailClosedWithoutRemovingEither() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)
        let directory = RunLock.directoryURL(in: root.url)
        let fixed = directory.appendingPathComponent(".run.lock.recovery")
        let legacy = directory.appendingPathComponent(".run.lock.quarantine-00000000-0000-0000-0000-000000000001")
        try FileManager.default.moveItem(at: RunLock.url(in: root.url), to: fixed)
        try Data(#"{"pid":200,"started_at":"2050-01-01T00:00:00Z"}"#.utf8).write(to: legacy)

        #expect(throws: RunLockError.self) {
            try RunLock.acquire(at: root.url, pid: 300, isProcessAlive: { _ in false })
        }
        #expect(FileManager.default.fileExists(atPath: fixed.path))
        #expect(FileManager.default.fileExists(atPath: legacy.path))
    }

    @Test func abnormalControlledArtifactFailsClosedAndIsPreserved() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)
        let recovery = RunLock.directoryURL(in: root.url).appendingPathComponent(".run.lock.recovery")
        try FileManager.default.removeItem(at: RunLock.url(in: root.url))
        try FileManager.default.createDirectory(at: recovery, withIntermediateDirectories: false)

        #expect(throws: RunLockError.self) {
            try RunLock.acquire(at: root.url, pid: 300, isProcessAlive: { _ in false })
        }
        var isDirectory: ObjCBool = false
        #expect(FileManager.default.fileExists(atPath: recovery.path, isDirectory: &isDirectory))
        #expect(isDirectory.boolValue)
    }

    @Test func malformedLegacyArtifactNameFailsClosed() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)
        let malformed = RunLock.directoryURL(in: root.url)
            .appendingPathComponent(".run.lock.quarantine-not-a-uuid")
        let original = try Data(contentsOf: RunLock.url(in: root.url))
        try Data("reserved".utf8).write(to: malformed)

        #expect(throws: RunLockError.self) {
            try RunLock.acquire(at: root.url, pid: 300, isProcessAlive: { _ in false })
        }
        #expect(try Data(contentsOf: RunLock.url(in: root.url)) == original)
        #expect(FileManager.default.fileExists(atPath: malformed.path))
    }

    @Test func firstDirectoryEnumerationErrorFailsClosedWithoutCreatingLock() throws {
        let root = try TemporaryDirectory()
        let hooks = RunLock.TestingHooks(failDirectoryEnumerationAfterReadCount: 0)

        #expect(throws: RunLockError.ioFailure) {
            try RunLock.acquire(
                at: root.url,
                pid: 300,
                isProcessAlive: { _ in false },
                testingHooks: hooks
            )
        }

        #expect(FileManager.default.fileExists(atPath: RunLock.url(in: root.url).path) == false)
        #expect(try quarantineNames(in: root.url).isEmpty)
    }

    @Test func midDirectoryEnumerationErrorPreservesLockAndArtifact() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)
        let lockURL = RunLock.url(in: root.url)
        let artifactURL = RunLock.directoryURL(in: root.url).appendingPathComponent(".run.lock.recovery")
        let lockData = try Data(contentsOf: lockURL)
        try lockData.write(to: artifactURL, options: .withoutOverwriting)
        let lockInode = try inode(of: lockURL)
        let artifactInode = try inode(of: artifactURL)
        let hooks = RunLock.TestingHooks(failDirectoryEnumerationAfterReadCount: 3)

        #expect(throws: RunLockError.ioFailure) {
            try RunLock.acquire(
                at: root.url,
                pid: 300,
                isProcessAlive: { _ in false },
                testingHooks: hooks
            )
        }

        #expect(try inode(of: lockURL) == lockInode)
        #expect(try inode(of: artifactURL) == artifactInode)
        #expect(try Data(contentsOf: lockURL) == lockData)
        #expect(try Data(contentsOf: artifactURL) == lockData)
    }

    @Test func transientCreateFstatFailureUsesBoundCleanup() throws {
        let root = try TemporaryDirectory()
        let hooks = RunLock.TestingHooks(failInitialCreateFstat: true)

        #expect(throws: RunLockError.self) {
            try RunLock.acquire(
                at: root.url,
                pid: 200,
                isProcessAlive: { _ in false },
                testingHooks: hooks
            )
        }

        #expect(FileManager.default.fileExists(atPath: RunLock.url(in: root.url).path) == false)
        #expect(try quarantineNames(in: root.url).isEmpty)
    }

    @Test func sameInodeRewriteAfterInspectionIsNotRemoved() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)
        let originalInode = try inode(of: RunLock.url(in: root.url))
        let replacement = Data(#"{"pid":300,"started_at":"2050-01-01T00:00:00Z"}"#.utf8)
        let hooks = RunLock.TestingHooks(beforeQuarantine: { reason, lockURL in
            guard reason == .staleRecovery else { return }
            let handle = try! FileHandle(forWritingTo: lockURL)
            try! handle.truncate(atOffset: 0)
            try! handle.write(contentsOf: replacement)
            try! handle.close()
            #expect(try! self.inode(of: lockURL) == originalInode)
        })

        #expect(throws: RunLockError.self) {
            try RunLock.acquire(
                at: root.url,
                pid: 200,
                isProcessAlive: { _ in false },
                testingHooks: hooks
            )
        }

        #expect(try RunLock.readPID(at: root.url) == 300)
        #expect(try quarantineNames(in: root.url).isEmpty)
    }

    @Test func oldLeaseDoesNotDeleteAReplacementOwnedByAnotherPID() throws {
        let root = try TemporaryDirectory()
        let acquired = try RunLock.acquire(at: root.url, pid: 100, isProcessAlive: { _ in false })
        let oldLease = try #require(acquired)
        try FileManager.default.removeItem(at: RunLock.url(in: root.url))
        try RunLock.writeFixture(at: root.url, pid: 200, startedAt: "2050-01-01T00:00:00.000000000Z")

        try oldLease.release()

        #expect(try RunLock.readPID(at: root.url) == 200)
    }

    @Test func oldLeaseDoesNotDeleteSamePIDReacquisitionABA() throws {
        let root = try TemporaryDirectory()
        let acquired = try RunLock.acquire(at: root.url, pid: 100, isProcessAlive: { _ in false })
        let oldLease = try #require(acquired)
        try FileManager.default.removeItem(at: RunLock.url(in: root.url))
        try RunLock.writeFixture(at: root.url, pid: 100, startedAt: "2050-01-01T00:00:00.000000000Z")

        try oldLease.release()

        #expect(try RunLock.readPID(at: root.url) == 100)
    }

    @Test func lockAndDirectoryUseExactOwnerOnlyPermissions() throws {
        let root = try TemporaryDirectory()
        let acquired = try RunLock.acquire(at: root.url, pid: 100, isProcessAlive: { _ in false })
        let lease = try #require(acquired)

        #expect(try mode(of: RunLock.url(in: root.url)) == 0o600)
        #expect(try mode(of: RunLock.directoryURL(in: root.url)) == 0o700)
        try lease.release()
    }

    @Test func strictRecordRejectsExtraKeysAndInvalidPID() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)
        try Data(#"{"pid":100,"started_at":"2050-01-01T00:00:00Z","token":"private"}"#.utf8)
            .write(to: RunLock.url(in: root.url))
        #expect(throws: RunLockError.self) { try RunLock.readPID(at: root.url) }

        try Data(#"{"pid":0,"started_at":"2050-01-01T00:00:00Z"}"#.utf8)
            .write(to: RunLock.url(in: root.url))
        #expect(throws: RunLockError.self) { try RunLock.readPID(at: root.url) }
    }

    @Test func symlinkLockIsNeverFollowedOrRemoved() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)
        let lockURL = RunLock.url(in: root.url)
        try FileManager.default.removeItem(at: lockURL)
        let target = root.url.appendingPathComponent("target")
        try Data("do-not-touch".utf8).write(to: target)
        #expect(symlink(target.path, lockURL.path) == 0)

        #expect(throws: RunLockError.self) {
            try RunLock.acquire(at: root.url, pid: 200, isProcessAlive: { _ in false })
        }
        #expect(try String(contentsOf: target, encoding: .utf8) == "do-not-touch")
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: lockURL.path) == target.path)
    }

    @Test func fifoLockIsRejectedWithoutBlockingForAWriter() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)
        let lockURL = RunLock.url(in: root.url)
        try FileManager.default.removeItem(at: lockURL)
        #expect(mkfifo(lockURL.path, S_IRUSR | S_IWUSR) == 0)
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(300)) {
            let writer = open(lockURL.path, O_WRONLY | O_NONBLOCK)
            if writer >= 0 { _ = close(writer) }
        }
        let clock = ContinuousClock()
        let startedAt = clock.now

        #expect(throws: RunLockError.self) {
            try RunLock.acquire(at: root.url, pid: 200, isProcessAlive: { _ in false })
        }

        #expect(startedAt.duration(to: clock.now) < .milliseconds(150))
    }

    @Test func symlinkApplicationSupportRootIsRejected() throws {
        let parent = try TemporaryDirectory()
        let target = parent.url.appendingPathComponent("real", isDirectory: true)
        let link = parent.url.appendingPathComponent("linked", isDirectory: true)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
        #expect(symlink(target.path, link.path) == 0)

        #expect(throws: RunLockError.self) {
            try RunLock.acquire(at: link, pid: 100, isProcessAlive: { _ in false })
        }
        #expect(FileManager.default.fileExists(atPath: target.appendingPathComponent("SlateQuotaCollector").path) == false)
    }

    @Test func productionLivenessTreatsCurrentProcessAsActive() throws {
        let root = try TemporaryDirectory()
        let acquired = try RunLock.acquire(at: root.url, pid: getpid(), isProcessAlive: { _ in false })
        let lease = try #require(acquired)

        let blocked = try RunLock.acquire(at: root.url, pid: getpid() + 1)

        #expect(blocked == nil)
        try lease.release()
    }

    @Test(arguments: [
        (0, Int32(ESRCH), true),
        (-1, Int32(EPERM), true),
        (-1, Int32(ESRCH), false),
        (-1, Int32(EIO), true),
    ])
    func errnoLivenessClassificationIsConservative(_ values: (Int32, Int32, Bool)) {
        #expect(RunLock.classifyProcessLiveness(killResult: values.0, errorNumber: values.1) == values.2)
    }

    @Test func strictRecordAcceptsExactly4096BytesAndRejects4097() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)
        let base = Data(#"{"pid":100,"started_at":"2050-01-01T00:00:00Z"}"#.utf8)
        var exact = base
        exact.append(Data(repeating: 0x20, count: 4_096 - base.count))
        try exact.write(to: RunLock.url(in: root.url))
        #expect(try RunLock.readPID(at: root.url) == 100)

        exact.append(0x20)
        try exact.write(to: RunLock.url(in: root.url))
        #expect(throws: RunLockError.self) { try RunLock.readPID(at: root.url) }
    }

    @Test func directoryAtLockPathIsRejectedAndPreserved() throws {
        let root = try TemporaryDirectory()
        try RunLock.writeFixture(at: root.url, pid: 100)
        let lockURL = RunLock.url(in: root.url)
        try FileManager.default.removeItem(at: lockURL)
        try FileManager.default.createDirectory(at: lockURL, withIntermediateDirectories: false)

        #expect(throws: RunLockError.self) {
            try RunLock.acquire(at: root.url, pid: 200, isProcessAlive: { _ in false })
        }
        var isDirectory: ObjCBool = false
        #expect(FileManager.default.fileExists(atPath: lockURL.path, isDirectory: &isDirectory))
        #expect(isDirectory.boolValue)
    }

    @Test func twoRealChildProcessesContendOnLiveLockWithoutErrors() throws {
        let root = try TemporaryDirectory()
        let outcomes = try childProcessRace(at: root.url, precreateStalePID: nil)

        #expect(outcomes.sorted() == ["N", "W"])
        #expect(try quarantineNames(in: root.url).isEmpty)
    }

    @Test func twoRealChildProcessesRecoverOneStaleLockWithoutErrors() throws {
        let root = try TemporaryDirectory()
        let outcomes = try childProcessRace(at: root.url, precreateStalePID: 999_999)

        #expect(outcomes.sorted() == ["N", "W"])
        #expect(try quarantineNames(in: root.url).isEmpty)
    }

    private func mode(of url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try #require((attributes[.posixPermissions] as? NSNumber)?.intValue) & 0o777
    }

    private func inode(of url: URL) throws -> UInt64 {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try #require((attributes[.systemFileNumber] as? NSNumber)?.uint64Value)
    }

    private func quarantineNames(in root: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: RunLock.directoryURL(in: root).path)
            .filter { $0 == ".run.lock.recovery" || $0.hasPrefix(".run.lock.quarantine-") }
    }

    private func childProcessRace(at root: URL, precreateStalePID: pid_t?) throws -> [String] {
        if let precreateStalePID { try RunLock.writeFixture(at: root, pid: precreateStalePID) }
        let helperDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("run-lock-process-helper-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: helperDirectory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: helperDirectory) }
        let helperSource = helperDirectory.appendingPathComponent("Helper.swift")
        let helperExecutable = helperDirectory.appendingPathComponent("run-lock-helper")
        let gate = helperDirectory.appendingPathComponent("start.gate")
        try Data(
            #"""
            import Darwin
            import Foundation

            @main
            struct RunLockProcessHelper {
                static func main() {
                    let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
                    let gate = CommandLine.arguments[2]
                    while access(gate, F_OK) != 0 { usleep(1_000) }
                    do {
                        if let lease = try RunLock.acquire(at: root, pid: getpid()) {
                            print("W")
                            fflush(stdout)
                            usleep(300_000)
                            try lease.release()
                        } else {
                            print("N")
                        }
                    } catch {
                        print("E")
                        exit(71)
                    }
                }
            }
            """#.utf8
        ).write(to: helperSource)
        let runLockSource = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/SlateQuotaCollector/RunLock.swift")
        let compiler = Process()
        compiler.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        compiler.arguments = ["swiftc", runLockSource.path, helperSource.path, "-o", helperExecutable.path]
        let compilerError = Pipe()
        compiler.standardError = compilerError
        try compiler.run()
        compiler.waitUntilExit()
        #expect(compiler.terminationStatus == 0, Comment(rawValue: String(
            data: compilerError.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? "swiftc failed"))

        let children: [(Process, Pipe)] = try (0..<2).map { _ in
            let child = Process()
            let output = Pipe()
            child.executableURL = helperExecutable
            child.arguments = [root.path, gate.path]
            child.standardOutput = output
            child.standardError = Pipe()
            try child.run()
            return (child, output)
        }
        try Data().write(to: gate, options: .withoutOverwriting)
        return children.map { child, output in
            child.waitUntilExit()
            #expect(child.terminationStatus == 0)
            return String(
                data: output.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "E"
        }
    }
}
