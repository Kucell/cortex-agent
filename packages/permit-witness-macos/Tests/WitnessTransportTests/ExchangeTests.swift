import Foundation
import Testing
@testable import WitnessTransport

/// No sockets, Keychain, certificate store, files, credentials or configuration.
final class FakeConnection: CandidateConnection, @unchecked Sendable {
    struct Chunk: Sendable {
        let data: Data?
        let eof: Bool
        let success: Bool
        init(_ data: Data?, eof: Bool = false, success: Bool = true) {
            self.data = data; self.eof = eof; self.success = success
        }
    }
    private let lock = NSLock()
    private var queue: DispatchQueue?
    private var counts = (starts: 0, sends: 0, cancels: 0, receives: 0)
    private var sent = Data()
    private var chunks: [Chunk]
    let ready: Bool?
    let sendSuccess: Bool?
    let repeatReady: Bool
    let duplicateReply: Bool
    var blockReady: (entered: DispatchSemaphore, release: DispatchSemaphore)?

    init(chunks: [Chunk] = [], ready: Bool? = true, sendSuccess: Bool? = true,
         repeatReady: Bool = false, duplicateReply: Bool = false) {
        self.chunks = chunks; self.ready = ready; self.sendSuccess = sendSuccess
        self.repeatReady = repeatReady; self.duplicateReply = duplicateReply
    }

    func snapshot() -> (starts: Int, sends: Int, cancels: Int, receives: Int, sent: Data) {
        lock.withLock { (counts.starts, counts.sends, counts.cancels, counts.receives, sent) }
    }
    func start(on queue: DispatchQueue, state: @escaping @Sendable (Bool) -> Void) {
        lock.withLock { self.queue = queue; counts.starts += 1 }
        if let ready {
            queue.async {
                if let gate = self.blockReady { gate.entered.signal(); gate.release.wait() }
                state(ready)
                if self.repeatReady { state(ready) }
            }
        }
    }
    func send(_ data: Data, completion: @escaping @Sendable (Bool) -> Void) {
        let queue = lock.withLock { counts.sends += 1; sent = data; return self.queue! }
        if let sendSuccess { queue.async { completion(sendSuccess) } }
    }
    func receive(maximum: Int, completion: @escaping @Sendable (Data?, Bool, Bool) -> Void) {
        let (queue, chunk): (DispatchQueue, Chunk?) = lock.withLock {
            counts.receives += 1
            return (self.queue!, chunks.isEmpty ? nil : chunks.removeFirst())
        }
        guard let chunk else { return }
        queue.async {
            completion(chunk.data, chunk.eof, chunk.success)
            if self.duplicateReply { completion(chunk.data, chunk.eof, chunk.success) }
        }
    }
    func cancel() { lock.withLock { counts.cancels += 1 } }
}

struct ExchangeTests {
    private func frame(_ payload: String = "request") -> IPCFrame {
        IPCFrame(operation: .checkpoint, requestID: UUID(), payload: Data("{\"message\":\"\(payload)\"}".utf8))
    }
    private func response(_ request: IPCFrame, status: UInt8 = 0, payload: Data = Data("reply".utf8)) -> IPCResponse {
        IPCResponse(operation: request.operation, requestID: request.requestID, status: status, payload: payload)
    }
    private func assertFailure(_ exchange: Exchange, _ expected: WitnessError,
                               sourceLocation: SourceLocation = #_sourceLocation) async {
        do { _ = try await exchange.run(); Issue.record("expected refusal", sourceLocation: sourceLocation) }
        catch { #expect(error as? WitnessError == expected, sourceLocation: sourceLocation) }
    }

    private func waitFor(_ condition: () -> Bool) async throws {
        for _ in 0..<500 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(1))
        }
        Issue.record("fake connection did not reach expected stage")
    }

    @Test func testFragmentedResponseWaitsForEOFAndSendsOnce() async throws {
        let request = frame()
        let response = response(request, payload: Data("response".utf8))
        let bytes = try response.encode(maximumPayload: 1024)
        let connection = FakeConnection(chunks: [.init(Data(bytes.prefix(3))), .init(Data(bytes.dropFirst(3))), .init(nil, eof: true)], repeatReady: true)
        let exchange = try Exchange(connection: connection, request: request, maximumPayload: 1024, timeoutMilliseconds: 500)
        let result = try await exchange.run()
        #expect(result == response)
        let snapshot = connection.snapshot()
        #expect(snapshot.sends == 1)
        let expectedWire = try request.encode(maximumPayload: 1024)
        #expect(snapshot.sent == expectedWire)
        #expect(snapshot.cancels == 1)
        #expect(snapshot.receives == 3)
        await assertFailure(exchange, .alreadyStarted)
        for status: UInt8 in 0...3 {
            let reply = self.response(request, status: status)
            let transport = FakeConnection(chunks: [.init(try reply.encode(maximumPayload: 1024), eof: true)])
            let result = try await Exchange(connection: transport, request: request, maximumPayload: 1024, timeoutMilliseconds: 500).run()
            #expect(result == reply)
        }
    }

    @Test func testMissingWrongIdentityOrOperationResponseIsRefused() async throws {
        let request = frame()
        for response in [response(frame("other id")), IPCResponse(operation: .transition, requestID: request.requestID, status: 0, payload: Data([1]))] {
            let connection = FakeConnection(chunks: [.init(try response.encode(maximumPayload: 1024), eof: true)])
            await assertFailure(try Exchange(connection: connection, request: request, maximumPayload: 1024, timeoutMilliseconds: 500), .malformedFrame)
            #expect(connection.snapshot().cancels == 1)
        }
        let connection = FakeConnection(chunks: [.init(nil, eof: true)])
        await assertFailure(try Exchange(connection: connection, request: request, maximumPayload: 1024, timeoutMilliseconds: 500), .malformedFrame)
    }

    @Test func testRejectsTruncatedTrailingOversizeAndEmptyProgress() async throws {
        let request = frame()
        let wire = try response(request).encode(maximumPayload: 1024)
        let cases: [([FakeConnection.Chunk], WitnessError)] = [
            ([.init(Data(wire.dropLast()), eof: true)], .malformedFrame),
            ([.init(wire), .init(Data([0]), eof: true)], .malformedFrame),
            ([.init(wire + wire, eof: true)], .malformedFrame),
            ([.init(Data([255, 255, 255, 255]))], .oversizedFrame),
            ([.init(nil)], .transportFailed),
            ([.init(Data())], .transportFailed),
            ([.init(wire, eof: true, success: false)], .transportFailed)
        ]
        for (chunks, error) in cases {
            let connection = FakeConnection(chunks: chunks)
            await assertFailure(try Exchange(connection: connection, request: request, maximumPayload: 1024, timeoutMilliseconds: 500), error)
            #expect(connection.snapshot().cancels == 1)
        }
        let echoed = try request.encode(maximumPayload: 1024)
        var reflectedWithStatus = echoed
        reflectedWithStatus[22] = 0
        var invalidStatus = wire
        invalidStatus[22] = 4
        for invalid in [echoed, invalidStatus] {
            let connection = FakeConnection(chunks: [.init(invalid, eof: true)])
            await assertFailure(try Exchange(connection: connection, request: request, maximumPayload: 1024, timeoutMilliseconds: 500), .malformedFrame)
        }
        // A response-shaped status byte cannot enter the request encoder/decoder.
        var requestDecoder = try FrameDecoder(maximumPayload: 1024)
        #expect(throws: WitnessError.malformedFrame) { try requestDecoder.append(reflectedWithStatus) }
    }

    @Test func testHandshakeFailureCannotSendAnyPayload() async throws {
        let connection = FakeConnection(ready: false)
        await assertFailure(try Exchange(connection: connection, request: frame(), maximumPayload: 1024, timeoutMilliseconds: 500), .transportFailed)
        #expect(connection.snapshot().sends == 0)
        #expect(connection.snapshot().cancels == 1)
    }

    @Test func testSendFailureDoesNotReadOrRetry() async throws {
        let connection = FakeConnection(sendSuccess: false)
        await assertFailure(try Exchange(connection: connection, request: frame(), maximumPayload: 1024, timeoutMilliseconds: 500), .transportFailed)
        #expect(connection.snapshot().sends == 1)
        #expect(connection.snapshot().receives == 0)
        #expect(connection.snapshot().cancels == 1)
    }

    @Test func testDeadlineCoversHandshakeSendReadAndMissingEOF() async throws {
        let request = frame()
        for connection in [FakeConnection(ready: nil), FakeConnection(sendSuccess: nil), FakeConnection(),
                           FakeConnection(chunks: [.init(try response(request).encode(maximumPayload: 1024))])] {
            await assertFailure(try Exchange(connection: connection, request: request, maximumPayload: 1024, timeoutMilliseconds: 20), .timedOut)
            #expect(connection.snapshot().starts == 1)
            #expect(connection.snapshot().cancels == 1)
            #expect(connection.snapshot().sends <= 1)
        }
    }

    @Test func testCancellationBeforeOrDuringStartClosesExactlyOnce() async throws {
        let connection = FakeConnection(ready: nil)
        let exchange = try Exchange(connection: connection, request: frame(), maximumPayload: 1024, timeoutMilliseconds: 1000)
        let task = Task { try await exchange.run() }
        task.cancel()
        do { _ = try await task.value; Issue.record("cancelled operation succeeded") }
        catch { #expect(error as? WitnessError == .cancelled) }
        #expect(connection.snapshot().cancels == 1)
        #expect(connection.snapshot().sends == 0)
    }

    @Test func testCancellationBeforeQueuedReadyNeverSends() async throws {
        let connection = FakeConnection()
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        connection.blockReady = (entered, release)
        let exchange = try Exchange(connection: connection, request: frame(), maximumPayload: 1024, timeoutMilliseconds: 2000)
        let task = Task { try await exchange.run() }
        let reached = await withCheckedContinuation { continuation in
            DispatchQueue.global().async { continuation.resume(returning: entered.wait(timeout: .now() + 1) == .success) }
        }
        #expect(reached)
        task.cancel() // latch is set synchronously; queued finish is behind ready
        release.signal()
        do { _ = try await task.value; Issue.record("cancelled operation succeeded") }
        catch { #expect(error as? WitnessError == .cancelled) }
        #expect(connection.snapshot().sends == 0)
        #expect(connection.snapshot().cancels == 1)
    }

    @Test func testCancellationWhileHandshakeSendOrReadIsPending() async throws {
        let request = frame()
        let connections = [FakeConnection(ready: nil), FakeConnection(sendSuccess: nil), FakeConnection(),
                           FakeConnection(chunks: [.init(try response(request).encode(maximumPayload: 1024))])]
        for (stage, connection) in connections.enumerated() {
            let exchange = try Exchange(connection: connection, request: request, maximumPayload: 1024, timeoutMilliseconds: 2000)
            let task = Task { try await exchange.run() }
            try await waitFor {
                let snapshot = connection.snapshot()
                switch stage {
                case 0: return snapshot.starts == 1
                case 1: return snapshot.sends == 1
                case 2: return snapshot.receives == 1
                default: return snapshot.receives == 2
                }
            }
            task.cancel()
            do { _ = try await task.value; Issue.record("cancelled operation succeeded") }
            catch { #expect(error as? WitnessError == .cancelled) }
            #expect(connection.snapshot().cancels == 1)
            #expect(connection.snapshot().starts == 1)
            #expect(connection.snapshot().sends <= 1)
        }
    }

    @Test func testCancellingRejectedSecondRunDoesNotCancelOwner() async throws {
        let connection = FakeConnection(ready: nil)
        let exchange = try Exchange(connection: connection, request: frame(), maximumPayload: 1024, timeoutMilliseconds: 2000)
        let owner = Task { try await exchange.run() }
        try await waitFor { connection.snapshot().starts == 1 }
        let duplicate = Task { try await exchange.run() }
        duplicate.cancel()
        do { _ = try await duplicate.value; Issue.record("duplicate run succeeded") }
        catch { #expect(error as? WitnessError == .alreadyStarted) }
        #expect(connection.snapshot().cancels == 0)
        owner.cancel()
        do { _ = try await owner.value; Issue.record("cancelled owner succeeded") }
        catch { #expect(error as? WitnessError == .cancelled) }
        #expect(connection.snapshot().cancels == 1)
    }

    @Test func testLateDuplicateCompletionCannotResolveTwice() async throws {
        let request = frame()
        let reply = response(request)
        let connection = FakeConnection(chunks: [.init(try reply.encode(maximumPayload: 1024), eof: true)], duplicateReply: true)
        let exchange = try Exchange(connection: connection, request: request, maximumPayload: 1024, timeoutMilliseconds: 500)
        let response = try await exchange.run()
        #expect(response == reply)
        #expect(connection.snapshot().cancels == 1)
    }

    @Test func testInvalidLimitsFailBeforeConnectionStart() throws {
        let connection = FakeConnection()
        for timeout in [0, -1, 30_001, Int.max] {
            #expect(throws: (any Error).self) { try Exchange(connection: connection, request: frame(), maximumPayload: 1024, timeoutMilliseconds: timeout) }
        }
        #expect(throws: (any Error).self) { try Exchange(connection: connection, request: frame(), maximumPayload: 1, timeoutMilliseconds: 500) }
        #expect(connection.snapshot().starts == 0)
    }
}
