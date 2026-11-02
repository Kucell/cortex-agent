import Foundation
import Network

private final class CancellationLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    var isCancelled: Bool { lock.withLock { cancelled } }
    func cancel() { lock.withLock { cancelled = true } }
    // Cancellation and starting a send share a linearization point. If send
    // wins, its remote outcome is unknown even if cancellation follows.
    func beginSend(_ body: () -> Void) -> Bool {
        lock.withLock {
            guard !cancelled else { return false }
            body()
            return true
        }
    }
}

/// Callbacks must be delivered on the start queue. Implementations are owned by
/// one Exchange; no reuse/reconnect. Fake implementations test lifecycle only.
protocol CandidateConnection: AnyObject, Sendable {
    func start(on queue: DispatchQueue, state: @escaping @Sendable (Bool) -> Void)
    func send(_ data: Data, completion: @escaping @Sendable (Bool) -> Void)
    func receive(maximum: Int, completion: @escaping @Sendable (Data?, Bool, Bool) -> Void)
    func cancel()
}

final class NativeConnection: CandidateConnection, @unchecked Sendable {
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
        // Half-close after the only request. Remote peer must close its response.
        connection.send(content: data, contentContext: .finalMessage, isComplete: true,
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

/// All mutable state, callbacks and finish arbitration live on a serial queue.
/// @unchecked Sendable expresses queue confinement, not unlocked shared state.
/// Deadline covers handshake + send + entire response, uses a monotonic clock,
/// is never extended by progress, and cancellation closes the native connection.
final class Exchange: @unchecked Sendable {
    private let queue = DispatchQueue(label: "permit-witness.exchange")
    private let connection: any CandidateConnection
    private let request: IPCFrame
    private let wire: Data
    private let timeoutMilliseconds: Int
    private var decoder: FrameDecoder
    private var response: IPCResponse?
    private var timer: DispatchSourceTimer?
    private var continuation: CheckedContinuation<IPCResponse, any Error>?
    private var started = false
    private var owner: UUID?
    private var activeCancellation: CancellationLatch?
    private var sent = false
    private var terminal: Result<IPCResponse, WitnessError>?

    init(connection: any CandidateConnection, request: IPCFrame, maximumPayload: Int,
         timeoutMilliseconds: Int) throws {
        guard (1...30_000).contains(timeoutMilliseconds) else { throw WitnessError.invalidPolicy }
        self.connection = connection
        self.request = request
        self.wire = try request.encode(maximumPayload: maximumPayload)
        self.decoder = try FrameDecoder(maximumPayload: maximumPayload, kind: .response)
        self.timeoutMilliseconds = timeoutMilliseconds
    }

    func run() async throws -> IPCResponse {
        let attempt = UUID()
        let cancellation = CancellationLatch()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    guard !self.started else {
                        continuation.resume(throwing: WitnessError.alreadyStarted)
                        return
                    }
                    self.started = true
                    self.owner = attempt
                    self.activeCancellation = cancellation
                    self.continuation = continuation
                    if cancellation.isCancelled { self.finish(.failure(.cancelled)); return }
                    let timer = DispatchSource.makeTimerSource(queue: self.queue)
                    self.timer = timer
                    timer.schedule(deadline: .now() + .milliseconds(self.timeoutMilliseconds))
                    timer.setEventHandler { self.finish(.failure(.timedOut)) }
                    timer.resume()
                    self.connection.start(on: self.queue) { ready in self.state(ready, cancellation: cancellation) }
                }
            }
        } onCancel: {
            cancellation.cancel()
            self.queue.async {
                if self.owner == attempt { self.finish(.failure(.cancelled)) }
            }
        }
    }

    private func state(_ ready: Bool, cancellation: CancellationLatch) {
        guard terminal == nil else { return }
        guard !cancellation.isCancelled else { finish(.failure(.cancelled)); return }
        guard ready else { finish(.failure(.transportFailed)); return }
        guard !sent else { return }
        let began = cancellation.beginSend {
            sent = true
            connection.send(wire) { success in
                self.queue.async {
                    guard self.terminal == nil else { return }
                    guard success else { self.finish(.failure(.transportFailed)); return }
                    self.read()
                }
            }
        }
        if !began { finish(.failure(.cancelled)) }
    }

    private func read() {
        guard terminal == nil else { return }
        connection.receive(maximum: 16_384) { data, eof, success in
            guard self.terminal == nil else { return }
            guard success else { self.finish(.failure(.transportFailed)); return }
            do {
                if let data, !data.isEmpty {
                    guard self.response == nil else { throw WitnessError.malformedFrame }
                    if let frame = try self.decoder.append(data) {
                        // A request starts with '{'; responses start with a
                        // status byte. Retain an explicit echo guard as well.
                        guard frame.operation == self.request.operation,
                              frame.requestID == self.request.requestID,
                              frame.payload != self.request.payload else { throw WitnessError.malformedFrame }
                        self.response = IPCResponse(operation: frame.operation, requestID: frame.requestID,
                                                    status: frame.payload[0], payload: Data(frame.payload.dropFirst()))
                    }
                }
                if eof {
                    guard let response = self.response,
                          response.operation == self.request.operation,
                          response.requestID == self.request.requestID else { throw WitnessError.malformedFrame }
                    self.finish(.success(response))
                } else {
                    guard let data, !data.isEmpty else { throw WitnessError.transportFailed }
                    self.read()
                }
            } catch let error as WitnessError { self.finish(.failure(error)) }
            catch { self.finish(.failure(.transportFailed)) }
        }
    }

    private func finish(_ result: Result<IPCResponse, WitnessError>) {
        guard terminal == nil else { return }
        let result: Result<IPCResponse, WitnessError> = activeCancellation?.isCancelled == true ? .failure(.cancelled) : result
        terminal = result
        timer?.setEventHandler {}
        timer?.cancel()
        timer = nil
        connection.cancel()
        resolve(result)
    }

    private func resolve(_ result: Result<IPCResponse, WitnessError>) {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result.mapError { $0 as any Error })
    }
}
