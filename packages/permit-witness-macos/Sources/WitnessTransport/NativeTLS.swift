import CryptoKit
import Foundation
import LocalAuthentication
import Network
import Security

enum KeychainIdentity {
    /// Only a persistent identity reference from a trusted deployment can select
    /// an identity. No label search, enumeration, PEM/P12 import, private-key
    /// serialization, interactive authentication, fallback or mutation API.
    static func load(_ deployment: TrustedDeployment) throws -> SecIdentity {
        guard (1...4096).contains(deployment.identityReference.count),
              deployment.ownCertificateSHA256.count == 32 else { throw WitnessError.invalidPolicy }
        let authentication = LAContext()
        authentication.interactionNotAllowed = true
        let query: [CFString: Any] = [
            kSecClass: kSecClassIdentity,
            kSecValuePersistentRef: deployment.identityReference as CFData,
            kSecReturnRef: true,
            kSecMatchLimit: kSecMatchLimitOne,
            kSecUseAuthenticationContext: authentication
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let result, CFGetTypeID(result) == SecIdentityGetTypeID() else {
            throw WitnessError.identityUnavailable
        }
        let identity = result as! SecIdentity
        var certificate: SecCertificate?
        var key: SecKey?
        guard SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess,
              let certificate,
              Data(SHA256.hash(data: SecCertificateCopyData(certificate) as Data)) == deployment.ownCertificateSHA256,
              SecIdentityCopyPrivateKey(identity, &key) == errSecSuccess, let key else {
            throw WitnessError.identityUnavailable
        }
        // This is only a necessary attribute check, NOT evidence of service ACL
        // protection. The trusted bootstrap stays closed until that is proven.
        guard let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
              attributes[kSecAttrIsExtractable] as? Bool == false,
              attributes[kSecAttrIsPermanent] as? Bool == true else { throw WitnessError.unprotectedKey }
        return identity
    }
}

enum PeerTrust {
    /// Configure an explicit private trust domain. System/user anchors cannot
    /// authorize peers; pinning never bypasses PKI. macOS may still consult its
    /// keychain for intermediates: SecTrustSetKeychains is a deprecated NO-OP.
    /// We do not change any search list. Full trust evaluation is not executed
    /// by this candidate's tests, to avoid reading existing certificate stores.
    /// Revocation must have positive cached/stapled evidence. No network fetch
    /// (including AIA/OCSP) is permitted here. Missing evidence fails closed.
    static func configure(_ trust: SecTrust, policy: CandidatePolicy) -> Bool {
        let anchors = policy.anchorsDER.compactMap { SecCertificateCreateWithData(nil, $0 as CFData) }
        guard anchors.count == policy.anchorsDER.count else { return false }
        let ssl = SecPolicyCreateSSL(policy.peerRole == .server, policy.peerRole == .server ? policy.serverName as CFString : nil)
        let flags = CFOptionFlags(kSecRevocationUseAnyAvailableMethod | kSecRevocationRequirePositiveResponse | kSecRevocationNetworkAccessDisabled)
        guard let revocation = SecPolicyCreateRevocation(flags),
              SecTrustSetPolicies(trust, [ssl, revocation] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, anchors as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess else { return false }
        return true
    }

    static func matchesLeaf(_ certificate: SecCertificate, policy: CandidatePolicy) -> Bool {
        Data(SHA256.hash(data: SecCertificateCopyData(certificate) as Data)) == policy.peerLeafSHA256
    }

    static func evaluate(_ trust: SecTrust, policy: CandidatePolicy) -> Bool {
        guard configure(trust, policy: policy), SecTrustEvaluateWithError(trust, nil),
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else { return false }
        return matchesLeaf(leaf, policy: policy)
    }
}

enum NativeTLS {
    /// Same factory serves outbound target -> authority and inbound authority
    /// validation of target client certs. No listener is exposed by this candidate.
    static func parameters(_ deployment: TrustedDeployment, queue: DispatchQueue) throws -> NWParameters {
        let identity = try KeychainIdentity.load(deployment)
        guard let local = sec_identity_create(identity) else { throw WitnessError.identityUnavailable }
        let tls = NWProtocolTLS.Options()
        let options = tls.securityProtocolOptions
        sec_protocol_options_set_min_tls_protocol_version(options, .TLSv13)
        sec_protocol_options_set_local_identity(options, local)
        sec_protocol_options_set_peer_authentication_required(options, true)
        sec_protocol_options_set_tls_resumption_enabled(options, false)
        sec_protocol_options_set_tls_tickets_enabled(options, false)
        sec_protocol_options_set_tls_false_start_enabled(options, false)
        if deployment.policy.peerRole == .server {
            sec_protocol_options_set_tls_server_name(options, deployment.policy.serverName)
        }
        let policy = deployment.policy
        sec_protocol_options_set_verify_block(options, { _, trust, complete in
            let native = sec_trust_copy_ref(trust).takeRetainedValue()
            complete(PeerTrust.evaluate(native, policy: policy))
        }, queue)
        return NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
    }
}
