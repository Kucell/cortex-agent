import CryptoKit
import Foundation
import Security
import Testing
@testable import WitnessTransport

/// Only ephemeral in-memory keys/certificates. No SecItem APIs, keychain trust
/// evaluation, filesystem fixtures, system identities or private-key export.
private enum MemoryCertificate {
    static func tlv(_ tag: UInt8, _ body: Data) -> Data {
        var header = Data([tag])
        if body.count < 128 { header.append(UInt8(body.count)) }
        else if body.count < 256 { header.append(contentsOf: [0x81, UInt8(body.count)]) }
        else { header.append(contentsOf: [0x82, UInt8(body.count >> 8), UInt8(body.count & 255)]) }
        return header + body
    }
    static func sequence(_ parts: Data...) -> Data { tlv(0x30, parts.reduce(Data(), +)) }
    static func oid(_ bytes: [UInt8]) -> Data { tlv(6, Data(bytes)) }

    static func make(label: String) throws -> SecCertificate {
        var error: Unmanaged<CFError>?
        let key = try #require(SecKeyCreateRandomKey([
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits: 256,
            kSecAttrIsPermanent: false
        ] as CFDictionary, &error))
        let publicKey = try #require(SecKeyCopyPublicKey(key))
        // Only the PUBLIC point is serialized, never `key`.
        let point = try #require(SecKeyCopyExternalRepresentation(publicKey, &error)) as Data
        let algorithm = sequence(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 4, 3, 2]))
        let name = sequence(tlv(0x31, sequence(oid([0x55, 4, 3]), tlv(0x0c, Data(label.utf8)))))
        let spki = sequence(
            sequence(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 2, 1]), oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 3, 1, 7])),
            tlv(3, Data([0]) + point)
        )
        let body = sequence(
            tlv(0xa0, tlv(2, Data([2]))), tlv(2, Data([1])), algorithm, name,
            sequence(tlv(0x17, Data("260101000000Z".utf8)), tlv(0x17, Data("270101000000Z".utf8))),
            name, spki
        )
        let signature = try #require(SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, body as CFData, &error)) as Data
        let der = sequence(body, algorithm, tlv(3, Data([0]) + signature))
        let certificate = try #require(SecCertificateCreateWithData(nil, der as CFData))
        #expect(SecCertificateCopyData(certificate) as Data == der)
        return certificate
    }
}

struct NativePolicyTests {
    private func trust(_ certificate: SecCertificate) throws -> SecTrust {
        var trust: SecTrust?
        #expect(SecTrustCreateWithCertificates(certificate, SecPolicyCreateBasicX509(), &trust) == errSecSuccess)
        return try #require(trust)
    }

    @Test func testBothRolesConfigureExactAnchorsOfflineRevocationAndSSLUsage() throws {
        let certificate = try MemoryCertificate.make(label: "in-memory-only")
        let der = SecCertificateCopyData(certificate) as Data
        for role: CandidatePolicy.PeerRole in [.server, .client] {
            let candidate = try policy(anchors: [der], role: role)
            let trust = try trust(certificate)
            #expect(PeerTrust.configure(trust, policy: candidate))
            var networkAllowed = DarwinBoolean(true)
            #expect(SecTrustGetNetworkFetchAllowed(trust, &networkAllowed) == errSecSuccess)
            #expect(!networkAllowed.boolValue)
            var anchorArray: CFArray?
            #expect(SecTrustCopyCustomAnchorCertificates(trust, &anchorArray) == errSecSuccess)
            let anchors = try #require(anchorArray as? [SecCertificate])
            #expect(anchors.count == 1)
            #expect(SecCertificateCopyData(anchors[0]) as Data == der)
            var policyArray: CFArray?
            #expect(SecTrustCopyPolicies(trust, &policyArray) == errSecSuccess)
            let policies = try #require(policyArray as? [SecPolicy])
            #expect(policies.count == 2)
            let ssl = try #require(SecPolicyCopyProperties(policies[0])) as NSDictionary
            #expect(ssl[kSecPolicyOid] as? String == kSecPolicyAppleSSL as String)
            // Security omits the default server-mode false property.
            if role == .client { #expect(ssl[kSecPolicyClient] as? Bool == true) }
            else { #expect(ssl[kSecPolicyClient] == nil || ssl[kSecPolicyClient] as? Bool == false) }
            if role == .server { #expect(ssl[kSecPolicyName] as? String == "authority.invalid") }
            else { #expect(ssl[kSecPolicyName] == nil) }
            let revocation = try #require(SecPolicyCopyProperties(policies[1])) as NSDictionary
            #expect(revocation[kSecPolicyOid] as? String == kSecPolicyAppleRevocation as String)
            // No SecTrustEvaluateWithError here: on macOS it may consult existing
            // keychain intermediates, outside this task's authorized reads.
        }
    }

    @Test func testMalformedAnchorCannotReachTrustEvaluation() throws {
        let certificate = try MemoryCertificate.make(label: "in-memory-only")
        let firstTrust = try trust(certificate)
        let invalidPolicy = try policy()
        #expect(!PeerTrust.configure(firstTrust, policy: invalidPolicy))
        let valid = SecCertificateCopyData(certificate) as Data
        let secondTrust = try trust(certificate)
        let mixedPolicy = try policy(anchors: [valid, Data([0])])
        #expect(!PeerTrust.configure(secondTrust, policy: mixedPolicy))
    }

    @Test func testCertificatePinIsExactDERAndRolePoliciesRemainSeparate() throws {
        let first = try MemoryCertificate.make(label: "authority")
        let second = try MemoryCertificate.make(label: "target")
        let der = SecCertificateCopyData(first) as Data
        let pin = Data(SHA256.hash(data: der))
        let candidate = try policy(anchors: [der], pin: pin)
        #expect(PeerTrust.matchesLeaf(first, policy: candidate))
        #expect(!(PeerTrust.matchesLeaf(second, policy: candidate)))
        var changed = pin
        changed[0] ^= 1
        let changedPolicy = try policy(anchors: [der], pin: changed)
        #expect(!PeerTrust.matchesLeaf(first, policy: changedPolicy))
        // Pin match alone is deliberately NOT PeerTrust.evaluate and conveys
        // no chain, hostname, EKU, revocation or application authorization.
    }
}
