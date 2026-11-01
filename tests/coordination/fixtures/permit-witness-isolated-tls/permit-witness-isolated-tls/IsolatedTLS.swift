import CryptoKit
import Darwin
import Foundation
import Network
import Security

// Standalone TEST ONLY. No existing Keychain queries, store imports, trust evaluation,
// production factory/bootstrap, private-key serialization, or global settings.
// Keys are nonextractable in a newly created, explicitly selected OS Keychain;
// certificates stay in memory. No search-list/default-keychain changes.
enum ProbeError: Error { case blocked(String), failed(String), terminated(Int32) }
final class Termination: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int32?
    func note(_ signal: Int32) { lock.withLock { if value == nil { value = signal } } }
    func check() throws { if let signal = lock.withLock({ value }) { throw ProbeError.terminated(signal) } }
    func waitForTestSignal() throws {
        // Test-only creation boundary; never used by the normal TLS run.
        let until = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
        while DispatchTime.now().uptimeNanoseconds < until {
            try check(); Thread.sleep(forTimeInterval: 0.005)
        }
        throw ProbeError.failed("test-termination-not-received")
    }
}
func emit(_ value: [String: Any]) {
    let bytes = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(bytes + Data([10]))
}
func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw ProbeError.failed(message) }
}
func der(_ tag: UInt8, _ content: Data) -> Data {
    let count = content.count
    var length = Data()
    if count < 128 { length.append(UInt8(count)) }
    else {
        var n = count, bytes = [UInt8]()
        while n > 0 { bytes.insert(UInt8(n & 255), at: 0); n >>= 8 }
        length.append(0x80 | UInt8(bytes.count)); length.append(contentsOf: bytes)
    }
    return Data([tag]) + length + content
}
func seq(_ values: Data...) -> Data { der(0x30, values.reduce(Data(), +)) }
func oid(_ hex: [UInt8]) -> Data { der(0x06, Data(hex)) }
let ecdsaSHA256 = seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]))
func extensionDER(_ id: [UInt8], _ value: Data, critical: Bool = false) -> Data {
    seq(oid(id), critical ? der(0x01, Data([0xff])) : Data(), der(0x04, value))
}
func name(_ label: String) -> Data {
    seq(der(0x31, seq(oid([0x55, 0x04, 0x03]), der(0x0c, Data(label.utf8)))))
}
struct TestIdentity: @unchecked Sendable {
    let key: SecKey
    let identity: SecIdentity
    let certificate: SecCertificate
    let bytes: Data
    let fingerprint: String
    let role: String
}

// Each case owns a serial callback queue and exactly one reader per endpoint.
// This drives real Network.framework TLS with a fixture-only exact-certificate
// verifier. It never invokes SecTrust evaluation or consults certificate stores.
final class TLSCase: @unchecked Sendable {
    private let queue = DispatchQueue(label: "isolated-tls-case")
    private let done = DispatchSemaphore(value: 0)
    private let serverIdentity: TestIdentity
    private let clientIdentity: TestIdentity
    private let rogueIdentity: TestIdentity
    private let mode: String
    private var listener: NWListener?
    private var client: NWConnection?
    private var server: NWConnection?
    private var timer: DispatchSourceTimer?
    private var finished = false
    private var failure: String?
    private var events = [[String: Any]]()
    private var verified = Set<String>()
    private var denied = Set<String>()
    private var request = Data(), response = Data()
    // Fixed opaque v2 bytes; this is neither a wire/host nor codec integration test.
    private let requestBytes = Data([0, 0, 0, 20, 2, 2] + Array(0..<16) + [0x7b, 0x7d])
    private let responseBytes = Data([0, 0, 0, 21, 2, 2] + Array(0..<16) + [0, 0x7b, 0x7d])

    init(_ mode: String, _ server: TestIdentity, _ client: TestIdentity, _ rogue: TestIdentity) {
        self.mode = mode; serverIdentity = server; clientIdentity = client; rogueIdentity = rogue
    }
    private func event(_ name: String, _ detail: [String: Any] = [:]) {
        events.append(["event": name, "detail": detail])
    }
    private func finish(_ error: String? = nil) {
        guard !finished else { return }
        finished = true; failure = error
        timer?.cancel(); client?.stateUpdateHandler = nil; server?.stateUpdateHandler = nil
        listener?.stateUpdateHandler = nil; listener?.newConnectionHandler = nil
        client?.cancel(); server?.cancel(); listener?.cancel(); done.signal()
    }
    private func parameters(_ side: String) throws -> NWParameters {
        let tls = NWProtocolTLS.Options(), options = tls.securityProtocolOptions
        let local = side == "server" ? serverIdentity : clientIdentity
        if side == "server" || mode != "missing-client" {
            guard let identity = sec_identity_create(local.identity) else { throw ProbeError.blocked("tls-identity") }
            sec_protocol_options_set_local_identity(options, identity)
        }
        if side == "client" && mode == "missing-client" {
            // Explicit nil prevents any default identity-selection fallback.
            sec_protocol_options_set_challenge_block(options, { [self] _, complete in
                event("explicit-no-client-identity"); complete(nil)
            }, queue)
        }
        sec_protocol_options_set_min_tls_protocol_version(options, .TLSv13)
        sec_protocol_options_set_max_tls_protocol_version(options, .TLSv13)
        sec_protocol_options_set_peer_authentication_required(options, true)
        sec_protocol_options_set_tls_resumption_enabled(options, false)
        sec_protocol_options_set_tls_tickets_enabled(options, false)
        sec_protocol_options_set_tls_false_start_enabled(options, false)
        if side == "client" { sec_protocol_options_set_tls_server_name(options, "isolated-witness.invalid") }
        let expected: Data
        if side == "client" { expected = mode == "wrong-server-pin" ? rogueIdentity.bytes : serverIdentity.bytes }
        else { expected = mode == "wrong-client-pin" ? rogueIdentity.bytes : clientIdentity.bytes }
        sec_protocol_options_set_verify_block(options, { [self] metadata, _, complete in
            // Examine only the peer-supplied TLS chain. No SecTrustCopy... call,
            // evaluation, anchors, cache lookup, or network fetching is used.
            var first = true, matches = false
            let accessed = sec_protocol_metadata_access_peer_certificate_chain(metadata) { certificate in
                if first {
                    first = false
                    let leaf = sec_certificate_copy_ref(certificate).takeRetainedValue()
                    matches = SecCertificateCopyData(leaf) as Data == expected
                }
            }
            let accepted = accessed && matches
            if accepted { verified.insert(side) } else { denied.insert(side) }
            event("peer-certificate", ["side": side, "accepted": accepted])
            complete(accepted)
        }, queue)
        let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
        parameters.requiredInterfaceType = .loopback
        parameters.includePeerToPeer = false
        if side == "server" {
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        }
        return parameters
    }
    private func state(_ side: String, _ connection: NWConnection, _ state: NWConnection.State) {
        guard !finished else { return }
        switch state {
        case .ready:
            guard let tls = connection.metadata(definition: NWProtocolTLS.definition) as? NWProtocolTLS.Metadata,
                  sec_protocol_metadata_get_negotiated_tls_protocol_version(tls.securityProtocolMetadata) == .TLSv13 else {
                finish("non-tls13-ready"); return
            }
            event("tls-ready", ["side": side, "tls": "1.3"])
            if side == "client" {
                // Keep the client write side OPEN. No .finalMessage/half-close.
                connection.send(content: requestBytes, contentContext: .defaultMessage, isComplete: true,
                    completion: .contentProcessed { [self] error in
                        guard !finished else { return }
                        if error != nil {
                            event("request-send-failed")
                            if mode == "valid-mutual" { finish("request-send-failed") }
                            return
                        }
                        event("request-sent-without-half-close")
                    })
            }
            receive(side, connection)
        case .failed(let error):
            transportFailure(side, "tls-failed", error)
        case .waiting(let error):
            // NW may report certificate rejection as waiting. Never retry;
            // require the explicit verifier denial (or missing-cert TLS error).
            transportFailure(side, "tls-waiting", error)
        default: break
        }
    }
    private func transportFailure(_ side: String, _ name: String, _ error: NWError) {
        event(name, ["side": side, "description": String(describing: error)])
        let expectedSide = mode == "wrong-server-pin" ? "client" : "server"
        let missingCertificate: Bool
        if case .tls(let status) = error {
            missingCertificate = mode == "missing-client" && side == "server" && status == -9863
        }
        else { missingCertificate = false }
        if mode != "valid-mutual" && request.isEmpty && response.isEmpty &&
            (denied.contains(expectedSide) || missingCertificate) {
            event("expected-authentication-rejection"); finish()
        } else if mode == "valid-mutual" { finish("unexpected-handshake-failure") }
    }
    private func receive(_ side: String, _ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [self] data, _, eof, error in
            guard !finished else { return }
            guard error == nil, !eof else { finish("unexpected-read-termination"); return }
            if side == "server" {
                request.append(data ?? Data())
                guard request.count <= requestBytes.count else { finish("request-extra-bytes"); return }
                if request.count < requestBytes.count { receive(side, connection); return }
                guard request == requestBytes, verified == Set(["client", "server"]), mode == "valid-mutual" else {
                    finish("unauthenticated-application-input"); return
                }
                event("request-received-without-eof")
                connection.send(content: responseBytes, contentContext: .defaultMessage, isComplete: true,
                    completion: .contentProcessed { [self] error in
                        if error != nil { finish("response-send-failed") }
                        else { event("response-send-complete") }
                    })
            } else {
                response.append(data ?? Data())
                guard response.count <= responseBytes.count else { finish("response-extra-bytes"); return }
                if response.count < responseBytes.count { receive(side, connection); return }
                guard response == responseBytes, verified == Set(["client", "server"]), mode == "valid-mutual" else {
                    finish("unexpected-application-response"); return
                }
                event("response-received-without-eof"); finish()
            }
        }
    }
    func run() throws -> [String: Any] {
        let listener = try NWListener(using: parameters("server"))
        self.listener = listener
        listener.newConnectionHandler = { [self] connection in
            guard server == nil else { connection.cancel(); finish("second-connection"); return }
            server = connection
            connection.stateUpdateHandler = { [self] update in state("server", connection, update) }
            connection.start(queue: queue)
        }
        listener.stateUpdateHandler = { [self] update in
            guard !finished else { return }
            switch update {
            case .ready:
                guard let port = listener.port else { finish("missing-listener-port"); return }
                event("listener-ready", ["bind": "127.0.0.1", "port": port.rawValue])
                do {
                    let c = NWConnection(host: "127.0.0.1", port: port, using: try parameters("client"))
                    client = c
                    c.stateUpdateHandler = { [self] state in self.state("client", c, state) }
                    c.start(queue: queue)
                } catch { finish("client-setup-failed") }
            case .failed: finish("listener-failed")
            default: break
            }
        }
        queue.async { [self] in
            let timer = DispatchSource.makeTimerSource(queue: queue); self.timer = timer
            timer.schedule(deadline: .now() + .seconds(4))
            timer.setEventHandler { [self] in finish("deadline") }; timer.resume()
            listener.start(queue: queue)
        }
        guard done.wait(timeout: .now() + .seconds(6)) == .success else { throw ProbeError.failed("driver-timeout") }
        // Drain completion callbacks before reading queue-confined evidence.
        return try queue.sync {
            if let failure { throw ProbeError.failed("\(mode):\(failure):\(events)") }
            return ["case": mode, "status": "pass", "events": events,
                    "request_bytes": request.count, "response_bytes": response.count]
        }
    }
}
func makeIdentity(_ role: String, keychain: SecKeychain) throws -> TestIdentity {
    var error: Unmanaged<CFError>?
    let parameters: [CFString: Any] = [
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits: 256,
        kSecUseKeychain: keychain,
        kSecAttrIsPermanent: true, kSecAttrIsExtractable: false, kSecAttrIsSensitive: true,
        kSecPrivateKeyAttrs: [kSecAttrIsPermanent: true, kSecAttrIsExtractable: false,
                             kSecAttrIsSensitive: true] as [CFString: Any]
    ]
    var generatedPublic: SecKey?, generatedPrivate: SecKey?
    let generationStatus = SecKeyGeneratePair(parameters as CFDictionary, &generatedPublic, &generatedPrivate)
    guard generationStatus == errSecSuccess, let key = generatedPrivate else {
        throw ProbeError.blocked("isolated-keychain-generation-status-\(generationStatus)")
    }
    let selectedAttributes = SecKeyCopyAttributes(key) as? [CFString: Any] ?? [:]
    let attributeReport: [String: Any] = ["event": "key-attribute-check",
        "extractable": selectedAttributes[kSecAttrIsExtractable] as? Bool ?? "absent" as Any,
        "permanent": selectedAttributes[kSecAttrIsPermanent] as? Bool ?? "absent" as Any]
    print(String(data: try JSONSerialization.data(withJSONObject: attributeReport, options: [.sortedKeys]), encoding: .utf8)!)
    guard let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
          attributes[kSecAttrIsExtractable] as? Bool == false,
          attributes[kSecAttrIsPermanent] as? Bool == true else {
        throw ProbeError.blocked("isolated-nonextractable-key-attributes-unavailable")
    }
    var actualKeychain: SecKeychain?
    let item = unsafeBitCast(key, to: SecKeychainItem.self)
    let status = SecKeychainItemCopyKeychain(item, &actualKeychain)
    guard status == errSecSuccess, let actualKeychain, CFEqual(actualKeychain, keychain) else {
        throw ProbeError.blocked("key-not-in-explicit-test-keychain-\(status)")
    }
    print("{\"event\":\"key-container-check\",\"matches_new_container\":true}")
    guard let publicKey = SecKeyCopyPublicKey(key),
          let publicBytes = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
        throw ProbeError.blocked("public-key-unavailable")
    }
    // Export ONLY the public point. Never invoke an export API on the private key.
    let publicInfo = seq(seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]),
                             oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07])),
                         der(0x03, Data([0]) + publicBytes))
    var serial = Data(count: 16)
    let randomStatus = serial.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
    try require(randomStatus == errSecSuccess, "serial-rng")
    serial[0] = (serial[0] & 0x7f) | 1
    let date = DateFormatter(); date.locale = Locale(identifier: "en_US_POSIX")
    date.timeZone = TimeZone(secondsFromGMT: 0); date.dateFormat = "yyMMddHHmmss'Z'"
    let validity = seq(der(0x17, Data(date.string(from: Date().addingTimeInterval(-60)).utf8)),
                       der(0x17, Data(date.string(from: Date().addingTimeInterval(600)).utf8)))
    let subject = name("isolated-\(role)-\(UUID().uuidString).invalid")
    let eku: [UInt8] = [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, role == "server" ? 1 : 2]
    let extensions = der(0xa3, seq(
        extensionDER([0x55, 0x1d, 0x13], seq(), critical: true), // CA=false
        extensionDER([0x55, 0x1d, 0x0f], der(0x03, Data([7, 0x80])), critical: true),
        extensionDER([0x55, 0x1d, 0x25], seq(oid(eku))),
        extensionDER([0x55, 0x1d, 0x11], seq(der(0x82, Data("isolated-witness.invalid".utf8))))))
    let tbs = seq(der(0xa0, der(0x02, Data([2]))), der(0x02, serial), ecdsaSHA256,
                  subject, validity, subject, publicInfo, extensions)
    guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, tbs as CFData, &error) as Data? else {
        throw ProbeError.blocked("managed-key-sign-unavailable")
    }
    try require(SecKeyVerifySignature(publicKey, .ecdsaSignatureMessageX962SHA256,
                                     tbs as CFData, signature as CFData, &error), "self-signature")
    let bytes = seq(tbs, ecdsaSHA256, der(0x03, Data([0]) + signature))
    guard let certificate = SecCertificateCreateWithData(nil, bytes as CFData),
          let identity = SecIdentityCreate(nil, certificate, key) else {
        throw ProbeError.blocked("in-memory-identity-unavailable")
    }
    return TestIdentity(key: key, identity: identity, certificate: certificate, bytes: bytes,
        fingerprint: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(), role: role)
}

@main struct IsolatedTLS {
    static func main() {
        // Forbid core dumps of private process memory even on a fixture crash.
        var limit = rlimit(rlim_cur: 0, rlim_max: 0)
        guard setrlimit(RLIMIT_CORE, &limit) == 0 else { exit(2) }
        let termination = Termination()
        let signalQueue = DispatchQueue(label: "isolated-tls-termination")
        let signals = [SIGTERM, SIGINT].map { number in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: signalQueue)
            source.setEventHandler { @Sendable in termination.note(number) }; source.resume()
            return source
        }
        defer { for source in signals { source.cancel() } }
        do {
            // CoreFoundation may synthesize __CF_USER_TEXT_ENCODING internally;
            // the runner never inherits or supplies it from its parent.
            let allowedEnvironment = Set(["PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP",
                                          "CLANG_MODULE_CACHE_PATH", "XDG_CACHE_HOME", "__CF_USER_TEXT_ENCODING"])
            let environmentKeys = Set(ProcessInfo.processInfo.environment.keys)
            guard environmentKeys.isSubset(of: allowedEnvironment) else {
                emit(["event": "environment-rejected", "unexpected_keys": environmentKeys.subtracting(allowedEnvironment).sorted()])
                throw ProbeError.blocked("unexpected-child-environment")
            }
            emit(["event": "environment-check", "keys": environmentKeys.sorted(), "status": "pass"])
            guard CommandLine.arguments.count >= 2 else { throw ProbeError.blocked("runtime-path-required") }
            let runtime = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
            let expectedBase = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
                .appendingPathComponent(".agent/runtime/permit-witness-isolated-tls").standardizedFileURL
            guard runtime.deletingLastPathComponent().path == expectedBase.path,
                  runtime.resolvingSymlinksInPath().path == runtime.path else {
                throw ProbeError.blocked("unsafe-runtime-path")
            }
            var keychain: SecKeychain?
            // Own cleanup BEFORE the synchronous OS create call. The signal
            // queue records cancellation only; it never deletes an in-flight container.
            defer {
                if let keychain {
                    let deleted = SecKeychainDelete(keychain)
                    emit(["event": "test-keychain-cleanup", "status": deleted])
                }
            }
            guard SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else { throw ProbeError.blocked("cannot-disable-ui") }
            var random = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else { throw ProbeError.blocked("password-rng") }
            var password = Array(random.map { String(format: "%02x", $0) }.joined().utf8)
            _ = random.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }
            // Password stays in this process. No CLI security tool or env secret.
            let file = runtime.appendingPathComponent("test-only.keychain-db").path
            guard !FileManager.default.fileExists(atPath: file) else { throw ProbeError.blocked("keychain-already-exists") }
            try termination.check()
            emit(["event": "keychain-create-start"])
            let status = password.withUnsafeBytes { ptr in
                SecKeychainCreate(file, UInt32(ptr.count), ptr.baseAddress, false, nil, &keychain)
            }
            _ = password.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }
            emit(["event": "keychain-create-return", "status": status])
            guard status == errSecSuccess, let keychain else { throw ProbeError.blocked("isolated-keychain-create-\(status)") }
            if CommandLine.arguments.contains("--test-hold-after-create") { try termination.waitForTestSignal() }
            try termination.check()
            let server = try makeIdentity("server", keychain: keychain)
            try termination.check()
            let client = try makeIdentity("client", keychain: keychain)
            try termination.check()
            let rogue = try makeIdentity("client", keychain: keychain)
            try termination.check()
            let preflight: [String: Any] = ["event": "managed-key-preflight", "status": "pass",
                "backend": "isolated-temporary-keychain", "private_key_extractable": false, "private_key_permanent": true,
                "certificate_storage": "process-memory-only", "existing_certificate_queries": false,
                "server_sha256": server.fingerprint, "client_sha256": client.fingerprint]
            print(String(data: try JSONSerialization.data(withJSONObject: preflight, options: [.sortedKeys]), encoding: .utf8)!)
            if CommandLine.arguments.contains("--preflight") { return }
            for mode in ["valid-mutual", "wrong-server-pin", "wrong-client-pin", "missing-client"] {
                try termination.check()
                let result = try TLSCase(mode, server, client, rogue).run()
                try termination.check()
                print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
            }
        } catch {
            if case ProbeError.terminated(let number) = error {
                emit(["event": "terminated", "signal": number]); exit(128 + number)
            }
            let kind: String
            if case ProbeError.blocked = error { kind = "blocked" } else { kind = "failed" }
            let report: [String: Any] = ["event": kind, "reason": String(describing: error)]
            print(String(data: try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
            exit(2)
        }
    }
}
