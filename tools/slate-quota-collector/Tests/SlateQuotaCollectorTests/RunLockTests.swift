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

        let leases = await withTaskGroup(of: RunLock.Lease?.self, returning: [RunLock.Lease].self) { group in
            for pid in 1...20 {
                group.addTask {
                    try? RunLock.acquire(at: root.url, pid: pid_t(pid), isProcessAlive: { _ in true })
                }
            }
            var winners: [RunLock.Lease] = []
            for await lease in group {
                if let lease { winners.append(lease) }
            }
            return winners
        }

        #expect(leases.count == 1)
        try leases.first?.release()
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

    private func mode(of url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try #require((attributes[.posixPermissions] as? NSNumber)?.intValue) & 0o777
    }
}
