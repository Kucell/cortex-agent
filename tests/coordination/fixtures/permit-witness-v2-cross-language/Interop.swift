import CryptoKit
import Foundation

// Fixture drives the REAL V2Frame codec with delivered memory batches. No EOF,
// socket, TLS, exchange/payload policy or fabricated authorization is involved.
@main struct Interop {
    static func main() throws {
        let args = CommandLine.arguments
        let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[2]))) as! [[String: Any]]
        var results = [[String: Any]]()
        for row in rows {
            let name = row["name"] as! String
            let direction = row["direction"] as! String
            do {
                if args[1] == "encode" {
                    let frame = V2Frame(operation: V2Frame.Operation(rawValue: UInt8(row["operation"] as! Int))!,
                        requestID: UUID(uuidString: row["request_id"] as! String)!,
                        status: direction == "response" ? UInt8(row["status"] as! Int) : nil,
                        payload: try Data(contentsOf: URL(fileURLWithPath: row["payload_path"] as! String)))
                    try frame.encode(maximumPayload: 1_048_576).write(to: URL(fileURLWithPath: row["output_path"] as! String))
                    results.append(["name": name, "ok": true])
                    continue
                }
                let wire = try Data(contentsOf: URL(fileURLWithPath: row["wire_path"] as! String))
                var decoder = try V2FrameDecoder(maximumPayload: 1_048_576, kind: direction == "request" ? .request : .response)
                var result: [String: Any]?
                let sizes = row["batches"] as! [Int]
                var offset = 0
                for size in sizes {
                    let end = min(offset + size, wire.count)
                    if let delivery = try decoder.append(Data(wire[offset..<end])) {
                        let frame = delivery.frame
                        result = ["name": name, "ok": true, "operation": frame.operation.rawValue,
                            "id": frame.requestID.uuidString.lowercased(), "payload_bytes": frame.payload.count,
                            "payload_sha256": SHA256.hash(data: frame.payload).map { String(format: "%02x", $0) }.joined(),
                            "completion_offset": end, "trailing_bytes": delivery.trailingBytes,
                            "unfed_bytes": wire.count - end]
                        if let status = frame.status { result!["status"] = status }
                        break // A connection owner handles future batches, not a second codec read.
                    }
                    offset = end
                }
                // Native decoder has no EOF/finish API. This is a FIXTURE
                // observation of incomplete input, not a codec-thrown error.
                results.append(result ?? ["name": name, "ok": false, "error": "truncated", "origin": "fixture"])
            } catch let error as WitnessError {
                results.append(["name": name, "ok": false,
                    "error": error == .oversizedFrame ? "size" : "protocol", "origin": "codec"])
            }
        }
        try JSONSerialization.data(withJSONObject: results, options: [.sortedKeys])
            .write(to: URL(fileURLWithPath: args[3]))
    }
}
