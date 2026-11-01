import CryptoKit
import Dispatch
import Foundation

// In-memory callback transport. It never opens a socket or uses TLS/identity.
final class FixtureConnection: CandidateConnection, @unchecked Sendable {
    private var queue: DispatchQueue!
    private var chunks: [Data]
    private let stall: Bool

    init(_ wire: Data, chunkSize: Int, stall: Bool) {
        self.chunks = stride(from: 0, to: wire.count, by: chunkSize).map {
            Data(wire[$0..<min($0 + chunkSize, wire.count)])
        }
        self.stall = stall
    }
    func start(on queue: DispatchQueue, state: @escaping @Sendable (Bool) -> Void) {
        self.queue = queue
        queue.async { state(true) }
    }
    func send(_ data: Data, completion: @escaping @Sendable (Bool) -> Void) {
        queue.async { completion(true) }
    }
    func receive(maximum: Int, completion: @escaping @Sendable (Data?, Bool, Bool) -> Void) {
        if chunks.isEmpty && stall { return }
        let data = chunks.isEmpty ? nil : chunks.removeFirst()
        queue.async { completion(data, data == nil, true) }
    }
    func cancel() {}
}

@main struct Interop {
    static func main() async throws {
        let args = CommandLine.arguments
        let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[2]))) as! [[String: Any]]
        var results = [[String: Any]]()
        for row in rows {
            let name = row["name"] as! String
            let direction = row["direction"] as! String
            do {
                if args[1] == "encode" {
                    let id = UUID(uuidString: row["request_id"] as! String)!
                    let operation = IPCFrame.Operation(rawValue: UInt8(row["operation"] as! Int))!
                    let payload = try Data(contentsOf: URL(fileURLWithPath: row["payload_path"] as! String))
                    let wire: Data
                    if direction == "request" {
                        wire = try IPCFrame(operation: operation, requestID: id, payload: payload).encode(maximumPayload: 1_048_576)
                    } else {
                        wire = try IPCResponse(operation: operation, requestID: id, status: UInt8(row["status"] as! Int), payload: payload).encode(maximumPayload: 1_048_576)
                    }
                    try wire.write(to: URL(fileURLWithPath: row["output_path"] as! String))
                    results.append(["name": name, "ok": true])
                    continue
                }
                let wire = try Data(contentsOf: URL(fileURLWithPath: row["wire_path"] as! String))
                let chunk = row["chunk"] as! Int
                if direction == "response" {
                    let request = IPCFrame(operation: IPCFrame.Operation(rawValue: UInt8(row["expected_operation"] as! Int))!,
                                           requestID: UUID(uuidString: row["expected_id"] as! String)!, payload: Data("{}".utf8))
                    let stall = row["stall"] as? Bool ?? false
                    let connection = FixtureConnection(wire, chunkSize: chunk, stall: stall)
                    let response = try await Exchange(connection: connection, request: request, maximumPayload: 1_048_576,
                                                      timeoutMilliseconds: stall ? 150 : 2000).run()
                    var result = summary(name, response.operation, response.requestID, response.payload)
                    result["status"] = response.status
                    results.append(result)
                } else {
                    var decoder = try FrameDecoder(maximumPayload: 1_048_576, kind: .request)
                    var result: IPCFrame?
                    for start in stride(from: 0, to: wire.count, by: chunk) {
                        if let frame = try decoder.append(Data(wire[start..<min(start + chunk, wire.count)])) { result = frame }
                    }
                    // There is no request-side Exchange/finish API. This fixture
                    // supplies clean EOF after all chunks, and flags incomplete data.
                    guard let frame = result else { throw WitnessError.malformedFrame }
                    results.append(summary(name, frame.operation, frame.requestID, frame.payload))
                }
            } catch let error as WitnessError {
                results.append(["name": name, "ok": false, "error": error == .timedOut ? "timeout" : "protocol"])
            }
        }
        let output = try JSONSerialization.data(withJSONObject: results, options: [.sortedKeys])
        try output.write(to: URL(fileURLWithPath: args[3]))
    }

    static func summary(_ name: String, _ operation: IPCFrame.Operation, _ id: UUID, _ payload: Data) -> [String: Any] {
        ["name": name, "ok": true, "operation": operation.rawValue, "id": id.uuidString.lowercased(),
         "payload_bytes": payload.count, "payload_sha256": SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()]
    }
}
