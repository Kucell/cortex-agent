import Foundation
import Darwin

enum WitnessError: Error, Equatable {
    case trustedBootstrapUnavailable
    case invalidPolicy
    case identityUnavailable
    case unprotectedKey
    case untrustedPeer
    case malformedFrame
    case oversizedFrame
    case transportFailed
    case timedOut
    case cancelled
    case alreadyStarted
}

/// CANDIDATE ONLY. There is deliberately no trusted configuration loader and no
/// public transport API. A future bootstrap must authenticate BOTH deployment
/// configuration and local caller before minting this capability. Neither file
/// ownership, UID, a local header, nor a caller-supplied `verified` bit suffices.
/// No environment/argv/test-mode switch can mint it in this executable.
struct TrustedDeployment {
    let policy: CandidatePolicy
    let identityReference: Data
    let ownCertificateSHA256: Data

    private init(policy: CandidatePolicy, identityReference: Data, ownCertificateSHA256: Data) {
        self.policy = policy
        self.identityReference = identityReference
        self.ownCertificateSHA256 = ownCertificateSHA256
    }

    static func load() throws -> Self {
        throw WitnessError.trustedBootstrapUnavailable
    }
}

public enum CandidateStartup {
    public static func run() throws {
        _ = try TrustedDeployment.load()
        // Intentionally no Keychain lookup, network connection, IPC listener,
        // provisioning, reset, recovery, export, or witness authorization path.
        throw WitnessError.trustedBootstrapUnavailable
    }
}

/// Untrusted policy syntax, NOT proof of provenance. Only used by internal
/// candidate building blocks. Not Decodable and never accepted over IPC.
struct CandidatePolicy: Sendable {
    enum PeerRole: Sendable { case server, client }
    let peerRole: PeerRole
    let serverName: String
    let port: UInt16
    let anchorsDER: [Data]
    let peerLeafSHA256: Data
    let maximumPayload: Int
    let timeoutMilliseconds: Int

    init(peerRole: PeerRole, serverName: String, port: UInt16,
         anchorsDER: [Data], peerLeafSHA256: Data,
         maximumPayload: Int = 1_048_576, timeoutMilliseconds: Int = 10_000) throws {
        // Canonical ASCII DNS name: no URL, path, userinfo, NUL, wildcard,
        // trailing dot, IP literal, Unicode normalization or override headers.
        let labels = serverName.split(separator: ".", omittingEmptySubsequences: false)
        let ascii = Array(serverName.utf8)
        var address = in_addr()
        let isNumericAddress = serverName.withCString { inet_aton($0, &address) == 1 }
        let lastLabel = labels.last.map(String.init) ?? ""
        // Avoid resolver-dependent interpretations of numeric final labels,
        // including hexadecimal forms even when inet_aton rejects the whole name.
        let numericLastLabel = !lastLabel.isEmpty && (lastLabel.utf8.allSatisfy { (48...57).contains($0) } ||
            (lastLabel.hasPrefix("0x") && lastLabel.count > 2 && lastLabel.dropFirst(2).utf8.allSatisfy {
                (48...57).contains($0) || (97...102).contains($0)
            }))
        guard (1...253).contains(ascii.count), labels.count >= 2,
              !isNumericAddress, !numericLastLabel,
              ascii.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 46 }),
              ascii.contains(where: { (97...122).contains($0) }),
              labels.allSatisfy({ (1...63).contains($0.utf8.count) && !$0.hasPrefix("-") && !$0.hasSuffix("-") }),
              port > 0, (1...8).contains(anchorsDER.count),
              anchorsDER.allSatisfy({ (1...65_536).contains($0.count) }),
              peerLeafSHA256.count == 32,
              (1...1_048_576).contains(maximumPayload),
              (1...30_000).contains(timeoutMilliseconds) else { throw WitnessError.invalidPolicy }
        self.peerRole = peerRole
        self.serverName = serverName
        self.port = port
        self.anchorsDER = anchorsDER
        self.peerLeafSHA256 = peerLeafSHA256
        self.maximumPayload = maximumPayload
        self.timeoutMilliseconds = timeoutMilliseconds
    }
}

/* Remaining deployment gates (all CLOSED):
 * - signed/notarized helper, dedicated service identity, launchd/XPC installation;
 * - audit-token based code-signing/designated-requirement validation and binding
 *   local requests to a live authorized caller session (UID/header is insufficient);
 * - authenticated, rollback-resistant configuration provisioning/rotation,
 *   exact authority/target/store-generation mapping and service-owned ACLs;
 * - Keychain access-control/access-group proof for both endpoints, provisioning
 *   non-extractable keys without migration/export and unattended access;
 * - native mTLS integration tests on provisioned, isolated hosts, positive
 *   revocation evidence for BOTH peers, certificate renewal and outage behavior;
 * - isolation/assessment of macOS trust evaluation's intermediate certificate
 *   lookup (SecTrustSetKeychains cannot disable it on supported macOS versions);
 * - witness protocol/transaction integration, replay/idempotency/concurrency,
 *   business authorization, canonical state/checkpoint and durable commit.
 *
 * TLS authentication is not witness authorization. This package does not write
 * stores or issue permits. Timeout/cancellation after send has UNKNOWN remote
 * outcome; never retry automatically. Opaque payloads below are not claimed to
 * implement lib/coordination/permit-witness-contract.js.
 */
