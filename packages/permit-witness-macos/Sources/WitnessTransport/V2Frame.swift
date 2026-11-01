import Foundation

/// Standalone candidate. Never changes the v1 IPC encoder/decoder or negotiates
/// a fallback. This layer validates framing only, not JSON or authorization.
struct V2Frame: Equatable, Sendable {
    enum Operation: UInt8, Sendable { case checkpoint = 1, transition = 2 }
    enum Kind: Sendable { case request, response }
    let operation: Operation
    let requestID: UUID
    let status: UInt8?
    let payload: Data

    var kind: Kind { status == nil ? .request : .response }

    func encode(maximumPayload: Int) throws -> Data {
        guard (1...1_048_576).contains(maximumPayload) else { throw WitnessError.invalidPolicy }
        guard !payload.isEmpty, payload.count <= maximumPayload else { throw WitnessError.oversizedFrame }
        guard status.map({ $0 <= 3 }) ?? true else { throw WitnessError.malformedFrame }
        let length = UInt32(18 + (status == nil ? 0 : 1) + payload.count)
        var bytes = Data([UInt8(length >> 24), UInt8((length >> 16) & 255),
                          UInt8((length >> 8) & 255), UInt8(length & 255), 2, operation.rawValue])
        var uuid = requestID.uuid
        withUnsafeBytes(of: &uuid) { bytes.append(contentsOf: $0) }
        if let status { bytes.append(status) }
        bytes.append(payload)
        return bytes
    }
}

struct V2FrameDecoder {
    struct Delivery: Sendable {
        let frame: V2Frame
        let trailingBytes: Int
    }
    private let maximumPayload: Int
    private let kind: V2Frame.Kind
    private var buffer = Data()
    private var expected: Int?
    private(set) var completed = false
    var bufferedBytes: Int { buffer.count }

    init(maximumPayload: Int, kind: V2Frame.Kind) throws {
        guard (1...1_048_576).contains(maximumPayload) else { throw WitnessError.invalidPolicy }
        self.maximumPayload = maximumPayload
        self.kind = kind
    }

    /// Only copy the prefix, validate its length, then copy at most that body.
    /// Preserve a complete first frame even when this batch also has trailing
    /// bytes: client outcome arbitration differs from server dispatch arbitration.
    mutating func append(_ bytes: Data) throws -> Delivery? {
        guard !completed else { throw WitnessError.malformedFrame }
        var remaining = bytes[...]
        if expected == nil {
            let count = min(4 - buffer.count, remaining.count)
            buffer.append(contentsOf: remaining.prefix(count))
            remaining = remaining.dropFirst(count)
            guard buffer.count == 4 else { return nil }
            let length = buffer.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            let overhead = kind == .request ? 18 : 19
            guard length > overhead, length <= maximumPayload + overhead else { throw WitnessError.oversizedFrame }
            expected = 4 + Int(length)
        }
        let expected = expected!
        let count = min(expected - buffer.count, remaining.count)
        buffer.append(contentsOf: remaining.prefix(count))
        remaining = remaining.dropFirst(count)
        guard buffer.count == expected else { return nil }
        guard buffer[4] == 2, let operation = V2Frame.Operation(rawValue: buffer[5]) else {
            throw WitnessError.malformedFrame
        }
        let status: UInt8? = kind == .response ? buffer[22] : nil
        guard status.map({ $0 <= 3 }) ?? true else { throw WitnessError.malformedFrame }
        let id = Array(buffer[6..<22])
        let uuid = UUID(uuid: (id[0], id[1], id[2], id[3], id[4], id[5], id[6], id[7],
                              id[8], id[9], id[10], id[11], id[12], id[13], id[14], id[15]))
        let frame = V2Frame(operation: operation, requestID: uuid, status: status,
                            payload: Data(buffer.dropFirst(kind == .request ? 22 : 23)))
        completed = true
        buffer.removeAll(keepingCapacity: false)
        return Delivery(frame: frame, trailingBytes: remaining.count)
    }
}
