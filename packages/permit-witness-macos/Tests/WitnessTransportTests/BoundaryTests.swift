import Foundation
import Testing
@testable import WitnessTransport

func policy(host: String = "authority.invalid", port: UInt16 = 443,
            anchors: [Data] = [Data([1])], pin: Data = Data(repeating: 1, count: 32),
            role: CandidatePolicy.PeerRole = .server, maximum: Int = 1024,
            timeout: Int = 1000) throws -> CandidatePolicy {
    try CandidatePolicy(peerRole: role, serverName: host, port: port, anchorsDER: anchors,
                        peerLeafSHA256: pin, maximumPayload: maximum, timeoutMilliseconds: timeout)
}

struct BoundaryTests {
    @Test func testBootstrapIsClosedWithoutReadingConfigurationOrIdentity() {
        #expect(throws: WitnessError.trustedBootstrapUnavailable) { try CandidateStartup.run() }
        #expect(throws: WitnessError.trustedBootstrapUnavailable) { try TrustedDeployment.load() }
    }

    @Test func testPolicyBoundsAndCanonicalDestination() throws {
        let valid = try policy()
        #expect(valid.serverName == "authority.invalid")
        #expect(valid.port == 443)
        for host in ["", "localhost", "127.0.0.1", "[::1]", "https://authority.invalid", "a.invalid/path",
                     "user@a.invalid", "a.invalid\u{0}", "a.invalid.", "a..invalid", "*.invalid", "-a.invalid",
                     "a-.invalid", "A.invalid", "中.invalid", String(repeating: "a", count: 64) + ".invalid"] {
            #expect(throws: (any Error).self) { try policy(host: host) }
        }
        #expect(throws: (any Error).self) { try policy(port: 0) }
        for anchors in [[], [Data()], Array(repeating: Data([1]), count: 9), [Data(count: 65537)]] {
            #expect(throws: (any Error).self) { try policy(anchors: anchors) }
        }
        for length in [0, 31, 33] { #expect(throws: (any Error).self) { try policy(pin: Data(count: length)) } }
        for length in [0, -1, 1_048_577, Int.max] { #expect(throws: (any Error).self) { try policy(maximum: length) } }
        for timeout in [0, -1, 30_001, Int.max] { #expect(throws: (any Error).self) { try policy(timeout: timeout) } }
        _ = try policy(role: .client, maximum: 1_048_576, timeout: 30_000)
    }

    @Test func testRejectsNumericAddressSpellingsWithoutDNSLookup() throws {
        for host in ["0x7f.1", "0x7f.0x1", "0177.0.0.1", "127.1", "127.0.1", "0x7f000001",
                     "2130706433", "127.0.0.1", "name.123", "name.0x1"] {
            #expect(throws: WitnessError.invalidPolicy) { try policy(host: host) }
        }
        for host in ["authority.invalid", "0x7f.example", "service.123example", "host.xn--p1ai"] {
            #expect(try policy(host: host).serverName == host)
        }
    }

    @Test func testFrameEverySplitAndUUIDByteOrder() throws {
        let id = UUID(uuidString: "00112233-4455-6677-8899-aabbccddeeff")!
        let frame = IPCFrame(operation: .checkpoint, requestID: id, payload: Data("{}".utf8))
        let wire = try frame.encode(maximumPayload: 1024)
        #expect(wire.map { String(format: "%02x", $0) }.joined() == "00000014010100112233445566778899aabbccddeeff7b7d")
        let response = IPCResponse(operation: .checkpoint, requestID: id, status: 0, payload: Data("{}".utf8))
        #expect(try response.encode(maximumPayload: 2).map { String(format: "%02x", $0) }.joined() == "00000015010100112233445566778899aabbccddeeff007b7d")
        for split in 0..<wire.count {
            var decoder = try FrameDecoder(maximumPayload: 1024)
            #expect(try decoder.append(Data(wire.prefix(split))) == nil)
            #expect(try decoder.append(Data(wire.dropFirst(split))) == frame)
            #expect(throws: (any Error).self) { try decoder.append(Data([0])) }
        }
        var decoder = try FrameDecoder(maximumPayload: 1024)
        for (index, byte) in wire.enumerated() {
            let result = try decoder.append(Data([byte]))
            if index == wire.count - 1 { #expect(result == frame) } else { #expect(result == nil) }
        }
    }

    @Test func testRejectsHostileLengthsBeforeBodyAndRejectsHeaders() throws {
        for prefix: [UInt8] in [[0, 0, 0, 0], [0, 0, 0, 18], [255, 255, 255, 255], [0, 16, 0, 19]] {
            var decoder = try FrameDecoder(maximumPayload: 1_048_576)
            #expect(throws: (any Error).self) { try decoder.append(Data(prefix)) }
        }
        for input in ["GET / HTTP/1.1\r\nX-Service-Identity: trusted\r\n\r\n",
                      "{\"verified\":true,\"identity\":\"authority\"}",
                      "{\"headers\":{\"authorization\":\"local\"}}"] {
            var decoder = try FrameDecoder(maximumPayload: 1024)
            #expect(throws: (any Error).self) { try decoder.append(Data(input.utf8)) }
        }
        for limit in [0, -1, 1_048_577, Int.max] { #expect(throws: (any Error).self) { try FrameDecoder(maximumPayload: limit) } }
    }

    @Test func testUnknownVersionOperationTrailingDataAndEmptyPayload() throws {
        let frame = IPCFrame(operation: .transition, requestID: UUID(), payload: Data([0x7b]))
        let wire = try frame.encode(maximumPayload: 1)
        for (offset, byte): (Int, UInt8) in [(4, 0), (4, 2), (5, 0), (5, 3), (5, 255)] {
            var changed = wire
            changed[offset] = byte
            var decoder = try FrameDecoder(maximumPayload: 100)
            #expect(throws: (any Error).self) { try decoder.append(changed) }
        }
        for trailing in [Data([0]), wire] {
            var decoder = try FrameDecoder(maximumPayload: 100)
            #expect(throws: (any Error).self) { try decoder.append(wire + trailing) }
        }
        #expect(throws: (any Error).self) { try IPCFrame(operation: .checkpoint, requestID: UUID(), payload: Data()).encode(maximumPayload: 10) }
        #expect(throws: (any Error).self) { try frame.encode(maximumPayload: 0) }
        var largePayload = Data(count: 1_048_576)
        largePayload[0] = 0x7b
        let large = IPCFrame(operation: .transition, requestID: UUID(), payload: largePayload)
        var decoder = try FrameDecoder(maximumPayload: 1_048_576)
        #expect(try decoder.append(large.encode(maximumPayload: 1_048_576)) == large)
        #expect(throws: (any Error).self) { try large.encode(maximumPayload: 1_048_575) }
        for status: UInt8 in 0...3 {
            let response = IPCResponse(operation: .transition, requestID: frame.requestID, status: status, payload: Data([0x7b, 0x7d]))
            let bytes = try response.encode(maximumPayload: 2)
            #expect(Array(bytes.prefix(4)) == [0, 0, 0, 21])
            for split in 0..<bytes.count {
                var decoder = try FrameDecoder(maximumPayload: 2, kind: .response)
                #expect(try decoder.append(Data(bytes.prefix(split))) == nil)
                let candidate = try decoder.append(Data(bytes.dropFirst(split)))
                let decoded = try #require(candidate)
                #expect(decoded.payload == Data([status, 0x7b, 0x7d]))
            }
        }
        let maxResponse = IPCResponse(operation: .checkpoint, requestID: frame.requestID, status: 3, payload: Data(count: 1_048_576))
        let maxBytes = try maxResponse.encode(maximumPayload: 1_048_576)
        #expect(Array(maxBytes.prefix(4)) == [0, 0x10, 0, 19])
        var responseDecoder = try FrameDecoder(maximumPayload: 1_048_576, kind: .response)
        #expect(try responseDecoder.append(maxBytes)?.payload.count == 1_048_577)
        var tooSmall = try FrameDecoder(maximumPayload: 1_048_575, kind: .response)
        #expect(throws: (any Error).self) { try tooSmall.append(maxBytes) }
        #expect(throws: (any Error).self) { try IPCResponse(operation: .checkpoint, requestID: frame.requestID, status: 4, payload: Data([1])).encode(maximumPayload: 1) }
        #expect(throws: (any Error).self) { try IPCResponse(operation: .checkpoint, requestID: frame.requestID, status: 0, payload: Data()).encode(maximumPayload: 1) }
        for byte: UInt8 in [0, 1, 2, 3, 4, 0x7a, 0x7c, 0xff] {
            let invalidRequest = IPCFrame(operation: .checkpoint, requestID: frame.requestID, payload: Data([byte, 0x7d]))
            #expect(throws: WitnessError.malformedFrame) { try invalidRequest.encode(maximumPayload: 2) }
            var raw = try IPCFrame(operation: .checkpoint, requestID: frame.requestID, payload: Data([0x7b, 0x7d])).encode(maximumPayload: 2)
            raw[22] = byte
            var requestDecoder = try FrameDecoder(maximumPayload: 2)
            #expect(throws: WitnessError.malformedFrame) { try requestDecoder.append(raw) }
        }
    }
}
