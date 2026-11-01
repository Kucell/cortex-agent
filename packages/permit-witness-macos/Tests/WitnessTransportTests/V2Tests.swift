import Foundation
import Testing
@testable import WitnessTransport

/// No network, certificates, identities, files, JSON reserialization or store.
/// Delivery gates model application-observation order, not physical TLS arrival.
private final class V2TestConnection: CandidateConnection, @unchecked Sendable {
    typealias Reader = @Sendable (Data?, Bool, Bool) -> Void
    private let lock = NSLock()
    private var queue: DispatchQueue?
    private var state: (@Sendable (Bool) -> Void)?
    private var reader: Reader?
    private var sendCompletion: (@Sendable (Bool) -> Void)?
    private var sent: [Data] = []
    private var cancellations = 0
    private var reads = 0
    private var overlappingReads = 0
    let autoReady: Bool
    let autoSend: Bool
    let onSend: (@Sendable () -> Void)?
    init(autoReady: Bool = true, autoSend: Bool = true, onSend: (@Sendable () -> Void)? = nil) {
        self.autoReady = autoReady; self.autoSend = autoSend; self.onSend = onSend
    }
    func start(on queue: DispatchQueue, state: @escaping @Sendable (Bool) -> Void) {
        lock.withLock { self.queue = queue; self.state = state }
        if autoReady { queue.async { state(true) } }
    }
    func send(_ data: Data, completion: @escaping @Sendable (Bool) -> Void) {
        let queue = lock.withLock { sent.append(data); sendCompletion = completion; return queue! }
        onSend?()
        if autoSend { queue.async { completion(true) } }
    }
    func receive(maximum: Int, completion: @escaping Reader) {
        lock.withLock {
            if reader != nil { overlappingReads += 1 }
            reads += 1; reader = completion
        }
    }
    func cancel() { lock.withLock { cancellations += 1 } }
    func deliver(_ data: Data?, eof: Bool = false, success: Bool = true, duplicate: Bool = false) {
        let (queue, reader) = lock.withLock { let callback = self.reader!; self.reader = nil; return (self.queue!, callback) }
        queue.async {
            reader(data, eof, success)
            if duplicate { reader(data, eof, success) }
        }
    }
    func completeSend(_ success: Bool) {
        let (queue, callback) = lock.withLock { (self.queue!, self.sendCompletion!) }
        queue.async { callback(success) }
    }
    func reportReady(_ ready: Bool) {
        let (queue, callback) = lock.withLock { (self.queue!, self.state!) }
        queue.async { callback(ready) }
    }
    var counts: (started: Bool, sends: Int, cancels: Int, reads: Int, pending: Bool, overlap: Int) {
        lock.withLock { (queue != nil, sent.count, cancellations, reads, reader != nil, overlappingReads) }
    }
}

private final class V2TaskReference: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<V2Snapshot, any Error>?
    func set(_ task: Task<V2Snapshot, any Error>) { lock.withLock { self.task = task } }
    func cancel() { lock.withLock { task }?.cancel() }
}

private final class V2TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var expired = false
    func expire() { lock.withLock { expired = true } }
    func now() -> UInt64 { lock.withLock { DispatchTime.now().uptimeNanoseconds + (expired ? 60_000_000_000 : 0) } }
}

/// Fixtures are already canonical format-1 bytes. This is deliberately an exact
/// allowlist, not an implementation/claim of production canonical JSON or host
/// authorization. Mutated bytes MUST NOT be accepted by the framing candidate.
private struct V2Fixture: Sendable {
    let request = V2Frame(operation: .transition,
                          requestID: UUID(uuidString: "00112233-4455-6677-8899-aabbccddeeff")!,
                          status: nil, payload: Data("{\"fixture\":\"request\",\"format_version\":1}".utf8))
    func response(_ status: UInt8 = 0) -> V2Frame {
        let names = ["committed", "rejected", "unknown", "unavailable"]
        let commits = ["confirmed", "not-attempted", "unknown", "not-attempted"]
        let extra = status == 0 ? "\"result\":{\"executionAuthorized\":false}," : "\"code\":\"ERR_FIXTURE\","
        // Sorted keys; result schema is intentionally fixture-only.
        let body = status == 0
            ? "{\"commit\":\"confirmed\",\"executionAuthorized\":false,\"format_version\":1,\"mode\":\"development-only\",\(extra)\"status\":\"committed\"}"
            : "{\(extra)\"commit\":\"\(commits[Int(status)])\",\"executionAuthorized\":false,\"format_version\":1,\"mode\":\"development-only\",\"status\":\"\(names[Int(status)])\"}"
        return V2Frame(operation: request.operation, requestID: request.requestID, status: status, payload: Data(body.utf8))
    }
    var validation: V2Validation {
        V2Validation(request: { frame in
            guard frame == request else { throw WitnessError.malformedFrame }
        }, response: { frame, original in
            guard original == request, let status = frame.status, status <= 3,
                  frame == response(status) else { throw WitnessError.malformedFrame }
        })
    }
}

private func eventually(_ predicate: () async -> Bool,
                        sourceLocation: SourceLocation = #_sourceLocation) async throws {
    for _ in 0..<2000 {
        if await predicate() { return }
        try await Task.sleep(for: .milliseconds(1))
    }
    Issue.record("test gate did not arrive", sourceLocation: sourceLocation)
    throw WitnessError.timedOut
}

struct V2FrameTests {
    @Test func everySplitByteOrderAndVersionIsolation() throws {
        let fixture = V2Fixture()
        for frame in [fixture.request, fixture.response(0), fixture.response(1), fixture.response(2), fixture.response(3)] {
            let wire = try frame.encode(maximumPayload: 1024)
            #expect(wire[4] == 2)
            #expect(Data(wire[6..<22]) == Data([0,17,34,51,68,85,102,119,136,153,170,187,204,221,238,255]))
            for split in 0..<wire.count {
                var decoder = try V2FrameDecoder(maximumPayload: 1024, kind: frame.kind)
                #expect(try decoder.append(Data(wire.prefix(split))) == nil)
                let decoded = try decoder.append(Data(wire.dropFirst(split)))
                let result = try #require(decoded)
                #expect(result.frame == frame)
                #expect(result.trailingBytes == 0)
                #expect(decoder.bufferedBytes == 0)
            }
            var decoder = try V2FrameDecoder(maximumPayload: 1024, kind: frame.kind)
            for (index, byte) in wire.enumerated() {
                let result = try decoder.append(Data([byte]))
                #expect((result != nil) == (index == wire.count - 1))
            }
            var v1 = try FrameDecoder(maximumPayload: 1024, kind: frame.status == nil ? .request : .response)
            #expect(throws: WitnessError.malformedFrame) { try v1.append(wire) }
            var old = wire; old[4] = 1
            var v2 = try V2FrameDecoder(maximumPayload: 1024, kind: frame.kind)
            #expect(throws: WitnessError.malformedFrame) { try v2.append(old) }
        }
    }

    @Test func boundedAllocationTailAndHostileLengths() throws {
        let fixture = V2Fixture()
        for kind: V2Frame.Kind in [.request, .response] {
            for length: UInt32 in [0, 18, kind == .request ? 1_048_595 : 19, 1_048_596, UInt32.max] {
                var decoder = try V2FrameDecoder(maximumPayload: 1_048_576, kind: kind)
                let bytes = Data([UInt8(length >> 24), UInt8((length >> 16) & 255), UInt8((length >> 8) & 255), UInt8(length & 255)])
                #expect(throws: WitnessError.oversizedFrame) { try decoder.append(bytes + Data(count: 100_000)) }
                #expect(decoder.bufferedBytes == 4)
            }
            let frame = V2Frame(operation: .transition, requestID: fixture.request.requestID,
                                status: kind == .request ? nil : 3, payload: Data(count: 1_048_576))
            let wire = try frame.encode(maximumPayload: 1_048_576)
            for tail in [Data([0]), wire, Data(wire.prefix(7))] {
                var decoder = try V2FrameDecoder(maximumPayload: 1_048_576, kind: kind)
                let decoded = try decoder.append(wire + tail)
                let delivery = try #require(decoded)
                #expect(delivery.frame == frame)
                #expect(delivery.trailingBytes == tail.count)
                #expect(throws: WitnessError.malformedFrame) { try decoder.append(Data([0])) }
            }
        }
        for limit in [0, -1, 1_048_577, Int.max] {
            #expect(throws: WitnessError.invalidPolicy) { try V2FrameDecoder(maximumPayload: limit, kind: .request) }
        }
        for (offset, value): (Int, UInt8) in [(4, 0), (4, 3), (5, 0), (5, 3), (22, 4)] {
            var bytes = try fixture.response().encode(maximumPayload: 1024); bytes[offset] = value
            var decoder = try V2FrameDecoder(maximumPayload: 1024, kind: .response)
            #expect(throws: WitnessError.malformedFrame) { try decoder.append(bytes) }
        }
    }
}

struct V2ExchangeTests {
    private let fixture = V2Fixture()
    private func client(_ connection: V2TestConnection, timeout: Int = 2000,
                        validation: V2Validation? = nil, clock: V2TestClock? = nil) throws -> V2Exchange {
        try V2Exchange(connection: connection, role: .client(fixture.request),
                       validation: validation ?? fixture.validation, timeoutMilliseconds: timeout,
                       now: { clock?.now() ?? DispatchTime.now().uptimeNanoseconds })
    }

    @Test func synchronousCancellationInsideSendDoesNotDeadlock() async throws {
        for server in [false, true] {
            let taskReference = V2TaskReference()
            let returned = DispatchSemaphore(value: 0)
            let connection = V2TestConnection(autoReady: false, onSend: {
                taskReference.cancel() // synchronously re-enters cancellation from send
                returned.signal()
            })
            let role: V2Exchange.Role = server ? .server { _ in fixture.response() } : .client(fixture.request)
            let exchange = try V2Exchange(connection: connection, role: role, validation: fixture.validation,
                                          timeoutMilliseconds: 2000)
            let task = Task { try await exchange.run() }
            taskReference.set(task)
            try await eventually { connection.counts.started }
            connection.reportReady(true)
            if server {
                try await eventually { connection.counts.pending }
                connection.deliver(try fixture.request.encode(maximumPayload: 1024))
            }
            let returnedInTime = await withCheckedContinuation { continuation in
                DispatchQueue.global().async { continuation.resume(returning: returned.wait(timeout: .now() + 2) == .success) }
            }
            guard returnedInTime else { Issue.record("synchronous cancel deadlocked inside send"); continue }
            let result = try await task.value
            #expect(result.businessResult == (server ? .response(fixture.response()) : .unknown))
            #expect(result.sends == 1 && connection.counts.cancels == 1)
            #expect(result.diagnostics.contains(.failure(.cancelled)))
        }
    }

    @Test func cancellationBeforeSendReservationPreventsSend() async throws {
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let validation = V2Validation(request: { frame in
            try fixture.validation.request(frame)
            entered.signal()
            _ = release.wait(timeout: .now() + 2)
        }, response: fixture.validation.response)
        let connection = V2TestConnection()
        let exchange = try client(connection, validation: validation)
        let task = Task { try await exchange.run() }
        let reached = await withCheckedContinuation { continuation in
            DispatchQueue.global().async { continuation.resume(returning: entered.wait(timeout: .now() + 1) == .success) }
        }
        #expect(reached)
        task.cancel()
        release.signal()
        let result = try await task.value
        #expect(result.businessResult == .notAttempted)
        #expect(result.sends == 0 && connection.counts.sends == 0)
        #expect(result.diagnostics.contains(.failure(.cancelled)))
    }

    @Test func completesWithoutEOFAllStatusesAndNeverReuses() async throws {
        for status: UInt8 in 0...3 {
            let connection = V2TestConnection()
            let exchange = try client(connection)
            let task = Task { try await exchange.run() }
            try await eventually { connection.counts.pending }
            connection.reportReady(true)
            let bytes = try fixture.response(status).encode(maximumPayload: 1024)
            connection.deliver(Data(bytes.prefix(3)))
            try await eventually { connection.counts.reads == 2 }
            connection.deliver(Data(bytes.dropFirst(3))) // peer stays open
            let result = try await task.value
            #expect(result.businessResult == .response(fixture.response(status)))
            #expect(result.diagnostics == [.abortedClose])
            #expect(connection.counts.reads == 2)
            #expect(connection.counts.sends == 1 && connection.counts.cancels == 1 && connection.counts.overlap == 0)
            do { _ = try await exchange.run(); Issue.record("reused exchange") }
            catch { #expect(error as? WitnessError == .alreadyStarted) }
        }
    }

    @Test func committedSurvivesSameBatchTailDuplicateAndLateCancel() async throws {
        let wire = try fixture.response().encode(maximumPayload: 1024)
        for tail in [Data([0]), wire, Data(wire.prefix(7))] {
            let connection = V2TestConnection()
            let exchange = try client(connection)
            let task = Task { try await exchange.run() }
            try await eventually { connection.counts.pending }
            connection.deliver(wire + tail, duplicate: true)
            let result = try await task.value
            #expect(result.businessResult == .response(fixture.response()))
            #expect(result.diagnostics.contains(.trailingObserved(tail.count)))
            task.cancel()
            let snapshot = await exchange.snapshot()
            #expect(snapshot.businessResult == result.businessResult)
            #expect(snapshot.diagnostics.contains(.duplicateCallback))
            #expect(connection.counts.cancels == 1)
        }
    }

    @Test func invalidResponseCannotEstablishBusinessResult() async throws {
        let valid = fixture.response()
        let goodWire = try valid.encode(maximumPayload: 1024)
        let badPayloads = [fixture.request.payload, Data("{}".utf8), Data("{\"format_version\":2}".utf8),
                           valid.payload + Data([32]), Data([0xff]), Data("{\"a\":1,\"a\":1}".utf8)]
        var cases = try badPayloads.map {
            try V2Frame(operation: .transition, requestID: fixture.request.requestID, status: 0, payload: $0).encode(maximumPayload: 1024)
        }
        var wrongID = goodWire; wrongID[6] = 255; cases.append(wrongID)
        var wrongOperation = goodWire; wrongOperation[5] = 1; cases.append(wrongOperation)
        var mismatchStatus = goodWire; mismatchStatus[22] = 1; cases.append(mismatchStatus)
        cases.append(try fixture.request.encode(maximumPayload: 1024)) // reflection
        cases.append(Data(goodWire.dropLast()))
        for bytes in cases {
            let connection = V2TestConnection()
            let exchange = try client(connection)
            let task = Task { try await exchange.run() }
            try await eventually { connection.counts.pending }
            connection.deliver(bytes, eof: true)
            let result = try await task.value
            #expect(result.businessResult == .unknown)
            #expect(result.diagnostics.contains(.failure(.malformedFrame)))
        }
        let connection = V2TestConnection()
        let exchange = try client(connection)
        let task = Task { try await exchange.run() }
        try await eventually { connection.counts.pending }
        connection.deliver(goodWire, success: false)
        #expect(try await task.value.businessResult == .unknown)
    }

    @Test func deadlineAndCancellationAtHandshakeSendAndRead() async throws {
        for stage in 0..<3 {
            for cancel in [false, true] {
                let connection = V2TestConnection(autoReady: stage != 0, autoSend: stage != 1)
                let exchange = try client(connection, timeout: cancel ? 2000 : 40)
                let task = Task { try await exchange.run() }
                if cancel {
                    try await eventually {
                        stage == 0 ? connection.counts.started : stage == 1 ? connection.counts.sends == 1 : connection.counts.pending
                    }
                    task.cancel()
                }
                let result = try await task.value
                #expect(result.businessResult == (stage == 0 ? .notAttempted : .unknown))
                #expect(result.diagnostics.contains(.failure(cancel ? .cancelled : .timedOut)))
                #expect(connection.counts.cancels == 1)
                if stage == 2 {
                    let bytes = try fixture.response().encode(maximumPayload: 1024)
                    connection.deliver(bytes)
                    try await eventually { (await exchange.snapshot()).diagnostics.contains(.lateInput(bytes.count)) }
                    #expect(await exchange.snapshot().businessResult == .unknown)
                }
            }
        }
    }

    @Test func absoluteDeadlineRecheckedAfterValidationWithoutTimerDelivery() async throws {
        let clock = V2TestClock()
        let validator = fixture.validation
        let validation = V2Validation(request: validator.request, response: { frame, request in
            try validator.response(frame, request)
            clock.expire() // models blocking validation returning beyond original budget
        })
        let connection = V2TestConnection()
        let exchange = try client(connection, validation: validation, clock: clock)
        let task = Task { try await exchange.run() }
        try await eventually { connection.counts.pending }
        connection.deliver(try fixture.response().encode(maximumPayload: 1024))
        let result = try await task.value
        #expect(result.businessResult == .unknown)
        #expect(result.diagnostics.contains(.failure(.timedOut)))
    }

    @Test func serverDispatchesWithoutEOFAndObservesTailDuringHostWait() async throws {
        let connection = V2TestConnection()
        let gate = V2HostGate()
        let exchange = try V2Exchange(connection: connection, role: .server { _ in await gate.wait() },
                                      validation: fixture.validation, timeoutMilliseconds: 2000)
        let task = Task { try await exchange.run() }
        try await eventually { connection.counts.pending }
        connection.deliver(try fixture.request.encode(maximumPayload: 1024))
        try await eventually { await gate.started }
        try await eventually { connection.counts.reads == 2 }
        connection.deliver(Data([0]))
        let result = try await task.value
        #expect(result.dispatches == 1 && result.sends == 0 && result.hostInFlight)
        #expect(result.businessResult == .unknown)
        #expect(result.diagnostics.contains(.trailingObserved(1)))
        await gate.release(fixture.response()) // cancellation did not undo commit
        try await eventually { !(await exchange.snapshot()).hostInFlight }
        let snapshot = await exchange.snapshot()
        #expect(snapshot.businessResult == .unknown)
        #expect(snapshot.hostResponse == fixture.response())
        #expect(snapshot.diagnostics.contains(.lateHostResult))
        #expect(connection.counts.overlap == 0 && connection.counts.sends == 0)
    }

    @Test func serverRejectsSameBatchTailTruncationAndCheckpointBeforeDispatch() async throws {
        let wire = try fixture.request.encode(maximumPayload: 1024)
        for bytes in [wire + Data([0]), wire + wire, Data(wire.dropLast()), Data(wire.prefix(3))] {
            let connection = V2TestConnection()
            let exchange = try V2Exchange(connection: connection, role: .server { _ in
                Issue.record("invalid input reached host"); return fixture.response()
            }, validation: fixture.validation, timeoutMilliseconds: 2000)
            let task = Task { try await exchange.run() }
            try await eventually { connection.counts.pending }
            connection.deliver(bytes, eof: true)
            let result = try await task.value
            #expect(result.businessResult == .notAttempted && result.dispatches == 0 && result.sends == 0)
        }
        let connection = V2TestConnection()
        let checkpoint = V2Frame(operation: .checkpoint, requestID: fixture.request.requestID, status: nil, payload: Data("{}".utf8))
        let exchange = try V2Exchange(connection: connection, role: .server { _ in fixture.response() },
                                      validation: V2Validation(request: { frame in
                                          guard frame == checkpoint else { throw WitnessError.malformedFrame }
                                      }, response: fixture.validation.response), timeoutMilliseconds: 2000)
        let task = Task { try await exchange.run() }
        try await eventually { connection.counts.pending }
        connection.deliver(try checkpoint.encode(maximumPayload: 1024))
        let result = try await task.value
        #expect(result.dispatches == 0 && result.diagnostics.contains(.checkpointQueryUnsupported))
    }

    @Test func serverKeepsCommittedResultAfterResponseWriteFailureOrTimeout() async throws {
        for timeout in [false, true] {
            let connection = V2TestConnection(autoSend: false)
            let exchange = try V2Exchange(connection: connection, role: .server { _ in fixture.response() },
                                          validation: fixture.validation, timeoutMilliseconds: timeout ? 80 : 2000)
            let task = Task { try await exchange.run() }
            try await eventually { connection.counts.pending }
            connection.deliver(try fixture.request.encode(maximumPayload: 1024))
            try await eventually { connection.counts.sends == 1 }
            if !timeout { connection.completeSend(false) }
            let result = try await task.value
            #expect(result.businessResult == .response(fixture.response()))
            #expect(result.hostResponse == fixture.response())
            #expect(result.dispatches == 1 && result.sends == 1)
            #expect(result.diagnostics.contains(.failure(timeout ? .timedOut : .transportFailed)))
            #expect(connection.counts.cancels == 1)
        }
    }

    @Test func serverWaitsForFullSendBeforeAbortAndKeepsCommitOnDelayedTail() async throws {
        for trailing in [false, true] {
            let connection = V2TestConnection(autoSend: false)
            let exchange = try V2Exchange(connection: connection, role: .server { _ in fixture.response() },
                                          validation: fixture.validation, timeoutMilliseconds: 2000)
            let task = Task { try await exchange.run() }
            try await eventually { connection.counts.pending }
            connection.deliver(try fixture.request.encode(maximumPayload: 1024))
            try await eventually { connection.counts.sends == 1 && connection.counts.reads == 2 }
            #expect(connection.counts.cancels == 0)
            #expect(await exchange.snapshot().businessResult == .response(fixture.response()))
            if trailing { connection.deliver(Data([0])) }
            else { connection.completeSend(true) }
            let result = try await task.value
            #expect(result.businessResult == .response(fixture.response()))
            #expect(result.dispatches == 1 && result.sends == 1 && connection.counts.cancels == 1)
            if trailing { #expect(result.diagnostics.contains(.trailingObserved(1))) }
            else {
                #expect(result.diagnostics == [.abortedClose])
                // A pending read is not handed to an internal TLS shutdown.
                #expect(result.readPending)
                connection.deliver(Data([0])) // already-delivered callback after abort
                try await eventually { (await exchange.snapshot()).diagnostics.contains(.trailingObserved(1)) }
                #expect(await exchange.snapshot().businessResult == result.businessResult)
            }
        }
    }

    @Test func blockedHostRemainsAccountedAfterDeadlineUntilItExits() async throws {
        let connection = V2TestConnection()
        let gate = V2HostGate()
        let exchange = try V2Exchange(connection: connection, role: .server { _ in await gate.wait() },
                                      validation: fixture.validation, timeoutMilliseconds: 60)
        let task = Task { try await exchange.run() }
        try await eventually { connection.counts.pending }
        connection.deliver(try fixture.request.encode(maximumPayload: 1024))
        try await eventually { await gate.started }
        let result = try await task.value
        #expect(result.businessResult == .unknown && result.hostInFlight)
        #expect(result.diagnostics.contains(.failure(.timedOut)))
        await gate.release(fixture.response())
        try await eventually { !(await exchange.snapshot()).hostInFlight }
        #expect(await exchange.snapshot().businessResult == .unknown)
        #expect(await exchange.snapshot().hostResponse == fixture.response())
        #expect(connection.counts.sends == 0)
    }

    @Test func expiryDuringRequestValidationPreventsSendOrDispatch() async throws {
        for server in [false, true] {
            let clock = V2TestClock()
            let connection = V2TestConnection()
            let validation = V2Validation(request: { frame in
                try fixture.validation.request(frame)
                clock.expire()
            }, response: fixture.validation.response)
            let role: V2Exchange.Role = server ? .server { _ in
                Issue.record("expired validation dispatched"); return fixture.response()
            } : .client(fixture.request)
            let exchange = try V2Exchange(connection: connection, role: role, validation: validation,
                                          timeoutMilliseconds: 2000, now: { clock.now() })
            let task = Task { try await exchange.run() }
            if server {
                try await eventually { connection.counts.pending }
                connection.deliver(try fixture.request.encode(maximumPayload: 1024))
            }
            let result = try await task.value
            #expect(result.businessResult == .notAttempted)
            #expect(result.dispatches == 0 && result.sends == 0)
            #expect(result.diagnostics.contains(.failure(.timedOut)))
        }
    }

    @Test func cancellationDuringValidationWinsBeforeResultFixation() async throws {
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let validation = V2Validation(request: fixture.validation.request, response: { response, request in
            try fixture.validation.response(response, request)
            entered.signal()
            _ = release.wait(timeout: .now() + 2)
        })
        let connection = V2TestConnection()
        let exchange = try client(connection, validation: validation)
        let task = Task { try await exchange.run() }
        try await eventually { connection.counts.pending }
        connection.deliver(try fixture.response().encode(maximumPayload: 1024))
        let reached = await withCheckedContinuation { continuation in
            DispatchQueue.global().async { continuation.resume(returning: entered.wait(timeout: .now() + 1) == .success) }
        }
        #expect(reached)
        task.cancel()
        release.signal()
        let result = try await task.value
        #expect(result.businessResult == .unknown)
        #expect(result.diagnostics.contains(.failure(.cancelled)))
    }

    @Test func slowFragmentsDoNotRenewDeadlineAndDuplicateRunCannotCancelOwner() async throws {
        let connection = V2TestConnection()
        let clock = V2TestClock()
        let exchange = try client(connection, clock: clock)
        let task = Task { try await exchange.run() }
        try await eventually { connection.counts.pending }
        let duplicate = Task { try await exchange.run() }; duplicate.cancel()
        do { _ = try await duplicate.value; Issue.record("duplicate run succeeded") }
        catch { #expect(error as? WitnessError == .alreadyStarted) }
        #expect(connection.counts.cancels == 0)
        connection.deliver(Data([0]))
        try await eventually { connection.counts.reads == 2 }
        clock.expire()
        connection.deliver(try fixture.response().encode(maximumPayload: 1024).dropFirst())
        let result = try await task.value
        #expect(result.businessResult == .unknown)
        #expect(result.diagnostics.contains(.failure(.timedOut)))
    }
}

private actor V2HostGate {
    private var continuation: CheckedContinuation<V2Frame, Never>?
    var started: Bool { continuation != nil }
    func wait() async -> V2Frame {
        await withCheckedContinuation { continuation = $0 }
    }
    func release(_ response: V2Frame) {
        continuation?.resume(returning: response)
        continuation = nil
    }
}
