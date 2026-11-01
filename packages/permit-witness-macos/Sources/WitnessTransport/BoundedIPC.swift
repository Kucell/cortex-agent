import Foundation

/// Private framed binary IPC/wire candidate; NOT HTTP. No headers, credentials,
/// URLs, configuration, environment, certificate selectors or trust flags.
/// v1 request body: version(1), operation(1), RFC 4122 UUID(16), payload.
/// The request starts with '{'; full canonical JSON validation is a higher layer.
/// Response body adds status(1) before the nonempty payload.
/// Prefix: body length u32 big endian. One frame per connection, no multiplexing.
struct IPCFrame: Equatable, Sendable {
    enum Operation: UInt8, Sendable { case checkpoint = 1, transition = 2 }
    static let overhead = 18
    let operation: Operation
    let requestID: UUID
    let payload: Data

    func encode(maximumPayload: Int) throws -> Data {
        guard (1...1_048_576).contains(maximumPayload), !payload.isEmpty,
              payload.count <= maximumPayload else { throw WitnessError.oversizedFrame }
        guard payload.first == 0x7b else { throw WitnessError.malformedFrame }
        let count = UInt32(Self.overhead + payload.count)
        var data = Data([UInt8(count >> 24), UInt8((count >> 16) & 255), UInt8((count >> 8) & 255), UInt8(count & 255), 1, operation.rawValue])
        var uuid = requestID.uuid
        withUnsafeBytes(of: &uuid) { data.append(contentsOf: $0) }
        data.append(payload)
        return data
    }
}

struct IPCResponse: Equatable, Sendable {
    let operation: IPCFrame.Operation
    let requestID: UUID
    let status: UInt8
    let payload: Data

    func encode(maximumPayload: Int) throws -> Data {
        guard (1...1_048_576).contains(maximumPayload), !payload.isEmpty,
              payload.count <= maximumPayload else { throw WitnessError.oversizedFrame }
        guard status <= 3 else { throw WitnessError.malformedFrame }
        let count = UInt32(IPCFrame.overhead + 1 + payload.count)
        var data = Data([UInt8(count >> 24), UInt8((count >> 16) & 255), UInt8((count >> 8) & 255), UInt8(count & 255), 1, operation.rawValue])
        var uuid = requestID.uuid
        withUnsafeBytes(of: &uuid) { data.append(contentsOf: $0) }
        data.append(status)
        data.append(payload)
        return data
    }
}

struct FrameDecoder {
    enum Kind { case request, response }
    private let maximumPayload: Int
    private let kind: Kind
    private var buffer = Data()
    private var expected: Int?
    private var completed = false

    init(maximumPayload: Int, kind: Kind = .request) throws {
        guard (1...1_048_576).contains(maximumPayload) else { throw WitnessError.invalidPolicy }
        self.maximumPayload = maximumPayload
        self.kind = kind
    }

    /// Validate size before allocation/append. A complete frame must be followed
    /// by EOF in the exchange; trailing frames/bytes are refused.
    mutating func append(_ bytes: Data) throws -> IPCFrame? {
        guard !completed else { throw WitnessError.malformedFrame }
        let extra = kind == .response ? 1 : 0
        guard bytes.count <= maximumPayload + extra + IPCFrame.overhead + 4 - buffer.count else {
            throw WitnessError.oversizedFrame
        }
        buffer.append(bytes)
        if expected == nil && buffer.count >= 4 {
            let length = buffer.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            guard length > IPCFrame.overhead + extra, length <= maximumPayload + extra + IPCFrame.overhead else {
                throw WitnessError.oversizedFrame
            }
            expected = Int(length) + 4
        }
        guard let expected, buffer.count >= expected else { return nil }
        guard buffer.count == expected, buffer[4] == 1,
              let operation = IPCFrame.Operation(rawValue: buffer[5]) else { throw WitnessError.malformedFrame }
        if kind == .response {
            guard buffer[22] <= 3 else { throw WitnessError.malformedFrame }
        } else {
            guard buffer[22] == 0x7b else { throw WitnessError.malformedFrame }
        }
        let id = Array(buffer[6..<22])
        let uuid = UUID(uuid: (id[0], id[1], id[2], id[3], id[4], id[5], id[6], id[7],
                              id[8], id[9], id[10], id[11], id[12], id[13], id[14], id[15]))
        completed = true
        return IPCFrame(operation: operation, requestID: uuid, payload: Data(buffer[22...]))
    }
}
