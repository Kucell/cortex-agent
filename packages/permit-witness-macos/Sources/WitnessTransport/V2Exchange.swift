import Foundation
import Network

/// The native v2 adapter keeps the request send direction OPEN. It uses the
/// unchanged native TLS policy; there is still no way to mint TrustedDeployment.
final class NativeV2Connection: CandidateConnection, @unchecked Sendable {
    private let connection: NWConnection
    init(deployment: TrustedDeployment, queue: DispatchQueue) throws {
        guard deployment.policy.peerRole == .server,
              let port = NWEndpoint.Port(rawValue: deployment.policy.port) else { throw WitnessError.invalidPolicy }
        connection = NWConnection(host: NWEndpoint.Host(deployment.policy.serverName), port: port,
                                  using: try NativeTLS.parameters(deployment, queue: queue))
    }
    func start(on queue: DispatchQueue, state: @escaping @Sendable (Bool) -> Void) {
        connection.stateUpdateHandler = { update in
            switch update {
            case .ready: state(true)
            case .failed, .cancelled, .waiting: state(false)
            default: break
            }
        }
        connection.start(queue: queue)
    }
    func send(_ data: Data, completion: @escaping @Sendable (Bool) -> Void) {
        connection.send(content: data, contentContext: .defaultMessage, isComplete: true,
                        completion: .contentProcessed { completion($0 == nil) })
    }
    func receive(maximum: Int, completion: @escaping @Sendable (Data?, Bool, Bool) -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: maximum) { data, _, eof, error in
            completion(data, eof, error == nil)
        }
    }
    func cancel() {
        connection.stateUpdateHandler = nil
        connection.cancel()
    }
}

/// REQUIRED integration seam, deliberately without a permissive implementation.
/// Validators receive ORIGINAL payload bytes and must enforce strict UTF-8,
/// canonical format-1 JSON, limits, exact schemas, per-action results/signatures,
/// and authenticated peer/authorization binding. Framing does not supply these.
/// Tests use an exact-fixture validator, not a production wire implementation.
struct V2Validation: Sendable {
    let request: @Sendable (V2Frame) throws -> Void
    let response: @Sendable (V2Frame, V2Frame) throws -> Void
}

enum V2BusinessResult: Equatable, Sendable {
    case notAttempted
    case unknown
    /// Client: accepted response. Server: validated host response, independently
    /// of send/close success. Neither grants execution authorization.
    case response(V2Frame)
}

enum V2Diagnostic: Equatable, Sendable {
    case failure(WitnessError)
    case trailingObserved(Int)
    case lateInput(Int)
    case lateHostResult
    case duplicateCallback
    case checkpointQueryUnsupported
    case peerEOFUnknownClose
    case abortedClose
}

struct V2Snapshot: Sendable {
    let businessResult: V2BusinessResult?
    let hostResponse: V2Frame?
    let diagnostics: [V2Diagnostic]
    let diagnosticsTruncated: Bool
    let dispatches: Int
    let sends: Int
    let hostInFlight: Bool
    let readPending: Bool
    let closing: Bool
}

private final class V2Cancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.withLock { cancelled = true } }
    var isCancelled: Bool { lock.withLock { cancelled } }
    /// Reserve the operation atomically against cancellation. The winner may
    /// proceed after unlocking, so a later cancellation cannot revoke the
    /// reservation or prove that a send/dispatch did not happen.
    func reserve() -> Bool {
        lock.withLock {
            guard !cancelled else { return false }
            return true
        }
    }
}

/// One queue, one reader, one dispatch, at most one send per side. Internal
/// standalone candidate only: no listener, managed host, retries, or startup hook.
/// The deadline is absolute and monotonic, not a claim that synchronous work can
/// be preempted. A hung host task remains accounted for until it actually exits.
final class V2Exchange: @unchecked Sendable {
    enum Role: Sendable {
        case client(V2Frame)
        // Connection.ready MUST mean the accepted peer has been authenticated.
        // No native listener/accepted-connection bootstrap is implemented here.
        case server(@Sendable (V2Frame) async throws -> V2Frame)
    }
    private let queue = DispatchQueue(label: "permit-witness.v2-exchange")
    private let connection: any CandidateConnection
    private let role: Role
    private let validation: V2Validation
    private let maximumPayload: Int
    private let timeoutMilliseconds: Int
    private let now: @Sendable () -> UInt64
    private var decoder: V2FrameDecoder
    private var deadline: UInt64 = 0
    private var timer: DispatchSourceTimer?
    private var continuation: CheckedContinuation<V2Snapshot, any Error>?
    private var owner: UUID?
    private var cancellation: V2Cancellation?
    private var request: V2Frame?
    private var businessResult: V2BusinessResult?
    private var hostResponse: V2Frame?
    private var diagnostics: [V2Diagnostic] = []
    private var diagnosticsTruncated = false
    private var ready = false
    private var closing = false
    private var readToken: UUID?
    private var dispatches = 0
    private var sends = 0
    private var hostTask: Task<Void, Never>?
    private var hostInFlight = false

    init(connection: any CandidateConnection, role: Role, validation: V2Validation,
         maximumPayload: Int = 1_048_576, timeoutMilliseconds: Int,
         now: @escaping @Sendable () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }) throws {
        guard (1...30_000).contains(timeoutMilliseconds) else { throw WitnessError.invalidPolicy }
        self.connection = connection
        self.role = role
        self.validation = validation
        self.maximumPayload = maximumPayload
        self.timeoutMilliseconds = timeoutMilliseconds
        self.now = now
        switch role {
        case .client(let request):
            guard request.kind == .request else { throw WitnessError.malformedFrame }
            _ = try request.encode(maximumPayload: maximumPayload)
            self.request = request
            decoder = try V2FrameDecoder(maximumPayload: maximumPayload, kind: .response)
        case .server:
            decoder = try V2FrameDecoder(maximumPayload: maximumPayload, kind: .request)
        }
    }

    func run() async throws -> V2Snapshot {
        let attempt = UUID()
        let cancellation = V2Cancellation()
        let start = now()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    guard self.owner == nil else { continuation.resume(throwing: WitnessError.alreadyStarted); return }
                    self.owner = attempt
                    self.cancellation = cancellation
                    self.continuation = continuation
                    self.deadline = start + UInt64(self.timeoutMilliseconds) * 1_000_000
                    guard self.active() else { return }
                    let timer = DispatchSource.makeTimerSource(queue: self.queue)
                    self.timer = timer
                    timer.schedule(deadline: DispatchTime(uptimeNanoseconds: self.deadline))
                    timer.setEventHandler { self.fail(.timedOut) }
                    timer.resume()
                    self.connection.start(on: self.queue) { ready in
                        self.queue.async { self.state(ready) }
                    }
                }
            }
        } onCancel: {
            cancellation.cancel()
            self.queue.async {
                if self.owner == attempt { self.fail(.cancelled) }
            }
        }
    }

    func snapshot() async -> V2Snapshot {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: self.currentSnapshot()) }
        }
    }

    private func currentSnapshot() -> V2Snapshot {
        V2Snapshot(businessResult: businessResult, hostResponse: hostResponse, diagnostics: diagnostics,
                   diagnosticsTruncated: diagnosticsTruncated, dispatches: dispatches, sends: sends,
                   hostInFlight: hostInFlight, readPending: readToken != nil, closing: closing)
    }

    private func note(_ diagnostic: V2Diagnostic) {
        if diagnostics.count < 64 { diagnostics.append(diagnostic) } else { diagnosticsTruncated = true }
    }

    private func active() -> Bool {
        guard !closing else { return false }
        if cancellation?.isCancelled == true { fail(.cancelled); return false }
        if now() >= deadline { fail(.timedOut); return false }
        return true
    }

    /// The lock protects only the cancellation/reservation decision. In
    /// particular no adapter, clock, task, or other callback runs while held.
    /// A cancellation that wins the reservation prevents the action; once the
    /// reservation wins, a later cancellation cannot retract that action.
    private func perform(_ action: () -> Void) -> Bool {
        guard active(), let cancellation else { return false }
        guard cancellation.reserve() else { fail(.cancelled); return false }
        guard now() < deadline else { fail(.timedOut); return false }
        action()
        return true
    }

    private func state(_ isReady: Bool) {
        guard active() else { return }
        guard isReady else { fail(.transportFailed); return }
        guard !ready else { return }
        ready = true
        switch role {
        case .client(let request):
            do {
                try validation.request(request)
                let wire = try request.encode(maximumPayload: maximumPayload)
                _ = perform { self.send(wire) }
            } catch { fail((error as? WitnessError) ?? .malformedFrame) }
        case .server: read()
        }
    }

    private func send(_ wire: Data) {
        sends += 1
        connection.send(wire) { success in
            self.queue.async {
                guard self.active() else { return }
                guard success else { self.fail(.transportFailed); return }
                switch self.role {
                case .client: self.read()
                case .server: self.close()
                }
            }
        }
    }

    private func read() {
        guard active(), readToken == nil else { return }
        let token = UUID()
        readToken = token
        connection.receive(maximum: 16_384) { data, eof, success in
            self.queue.async { self.received(data, eof: eof, success: success, token: token) }
        }
    }

    private func received(_ data: Data?, eof: Bool, success: Bool, token: UUID) {
        guard readToken == token else { note(.duplicateCallback); return }
        readToken = nil
        if closing {
            if let data, !data.isEmpty { note(decoder.completed ? .trailingObserved(data.count) : .lateInput(data.count)) }
            return
        }
        guard active() else {
            if let data, !data.isEmpty { note(.lateInput(data.count)) }
            return
        }
        // An errored TLS delivery cannot establish a valid application response.
        guard success else { fail(.transportFailed); return }
        if eof { note(.peerEOFUnknownClose) } // Bool EOF cannot prove close_notify.
        do {
            if let data, !data.isEmpty {
                if decoder.completed {
                    note(.trailingObserved(data.count))
                    fail(.malformedFrame)
                    return
                }
                if let delivery = try decoder.append(data) {
                    switch role {
                    case .client:
                        let request = request!
                        try validateResponse(delivery.frame, request: request)
                        // Fix the first result BEFORE classifying same-batch tail.
                        guard perform({ self.businessResult = .response(delivery.frame) }) else { return }
                        if delivery.trailingBytes > 0 { note(.trailingObserved(delivery.trailingBytes)) }
                        close()
                        return
                    case .server(let dispatch):
                        // Entire delivered batch is handled before any dispatch.
                        guard delivery.trailingBytes == 0 else {
                            note(.trailingObserved(delivery.trailingBytes)); fail(.malformedFrame); return
                        }
                        try validation.request(delivery.frame)
                        guard delivery.frame.operation == .transition else {
                            note(.checkpointQueryUnsupported); fail(.malformedFrame); return
                        }
                        guard perform({
                            self.request = delivery.frame
                            self.dispatches = 1
                            self.hostInFlight = true
                            let dispatchDeadline = self.deadline
                            let clock = self.now
                            let cancellation = self.cancellation!
                            self.hostTask = Task.detached {
                                let result: Result<V2Frame, any Error>
                                do {
                                    // Scheduling a task is not entry into the
                                    // host. Recheck after that executor hop too.
                                    guard !cancellation.isCancelled else { throw WitnessError.cancelled }
                                    guard clock() < dispatchDeadline else { throw WitnessError.timedOut }
                                    result = .success(try await dispatch(delivery.frame))
                                }
                                catch { result = .failure(error) }
                                self.queue.async { self.hostCompleted(result) }
                            }
                        }) else { return }
                    }
                }
            } else if !eof { fail(.transportFailed); return }
            if eof {
                // A complete request may be processed without a pending read;
                // EOF still does not establish response-write capability.
                if !decoder.completed { fail(.malformedFrame) }
            } else { read() }
        } catch { fail((error as? WitnessError) ?? .malformedFrame) }
    }

    private func validateResponse(_ frame: V2Frame, request: V2Frame) throws {
        guard frame.kind == .response, frame.operation == request.operation,
              frame.requestID == request.requestID else { throw WitnessError.malformedFrame }
        try validation.response(frame, request)
    }

    private func hostCompleted(_ result: Result<V2Frame, any Error>) {
        hostInFlight = false
        hostTask = nil
        do {
            let response = try result.get()
            try validateResponse(response, request: request!)
            let wire = try response.encode(maximumPayload: maximumPayload)
            // Keep a host's validated result even if it returned after transport
            // termination. It is not a second client completion or safe replay.
            hostResponse = response
            if closing { note(.lateHostResult); return }
            guard active() else { return }
            _ = perform {
                self.businessResult = .response(response)
                self.send(wire)
            }
        } catch {
            if closing { note(.lateHostResult) }
            else { fail((error as? WitnessError) ?? .transportFailed) }
        }
    }

    private func fail(_ error: WitnessError) {
        note(.failure(error))
        guard !closing else { return }
        if businessResult == nil { businessResult = sends > 0 || dispatches > 0 ? .unknown : .notAttempted }
        close()
    }

    private func close() {
        guard !closing else { return }
        closing = true // Stop reissuing reads before cancelling the connection.
        timer?.setEventHandler {}
        timer?.cancel()
        timer = nil
        hostTask?.cancel() // Cooperative only; keep hostInFlight until completion.
        // NWConnection has no independently cancellable receive in this seam.
        // Use explicit abnormal abort, never concurrent reader/TLS shutdown and
        // never claim close_notify. No grace timer delays result publication.
        note(.abortedClose)
        connection.cancel()
        let continuation = continuation
        self.continuation = nil
        continuation?.resume(returning: currentSnapshot())
    }
}
