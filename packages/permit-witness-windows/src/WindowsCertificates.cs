using System.Formats.Asn1;
using System.Net.Security;
using System.Runtime.Versioning;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace PermitWitness.Windows;

[SupportedOSPlatform("windows")]
internal static class WindowsCertificates
{
    internal const string ServerEku = "1.3.6.1.5.5.7.3.1";
    internal const string ClientEku = "1.3.6.1.5.5.7.3.2";

    internal static void ValidatePin(string pin)
    {
        if (pin.Length != 64 || pin.Any(c => !char.IsAsciiHexDigitUpper(c)))
            throw new AuthenticationException("ERR_CERT_POLICY");
    }

    internal static bool HasProfile(X509Certificate2 certificate, string eku)
    {
        return HasProfile(certificate.Extensions, certificate.NotBefore.ToUniversalTime(),
            certificate.NotAfter.ToUniversalTime(), eku, DateTime.UtcNow);
    }

    internal static bool HasProfile(X509ExtensionCollection extensions, DateTime notBeforeUtc,
        DateTime notAfterUtc, string eku, DateTime nowUtc)
    {
        if (eku is not (ServerEku or ClientEku) ||
            notBeforeUtc.Kind != DateTimeKind.Utc || notAfterUtc.Kind != DateTimeKind.Utc || nowUtc.Kind != DateTimeKind.Utc ||
            notBeforeUtc > notAfterUtc || nowUtc < notBeforeUtc || nowUtc > notAfterUtc) return false;
        try
        {
            // Count by OID, not CLR subtype: generic/malformed duplicates must
            // not disappear from the profile. Require explicit non-CA, KU, EKU.
            var constraints = extensions.Cast<X509Extension>().Where(e => e.Oid?.Value == "2.5.29.19").ToArray();
            var usages = extensions.Cast<X509Extension>().Where(e => e.Oid?.Value == "2.5.29.15").ToArray();
            var purposes = extensions.Cast<X509Extension>().Where(e => e.Oid?.Value == "2.5.29.37").ToArray();
            if (constraints.Length != 1 || usages.Length != 1 || purposes.Length != 1) return false;

            // DER BasicConstraints for a non-CA is an empty SEQUENCE: cA is
            // DEFAULT FALSE (omitted), and a non-CA cannot have pathLenConstraint.
            var basic = new AsnReader(constraints[0].RawData, AsnEncodingRules.DER);
            basic.ReadSequence().ThrowIfNotEmpty();
            basic.ThrowIfNotEmpty();

            var ku = new AsnReader(usages[0].RawData, AsnEncodingRules.DER);
            var bits = ku.ReadNamedBitList(); // ASN.1 bit 0 = digitalSignature
            ku.ThrowIfNotEmpty();
            // The reader retains redundant zero bits: DER NamedBitList must
            // end at its last SET bit, not merely be a valid BIT STRING.
            if (bits.Length == 0 || bits.Length > 9 || !bits[bits.Length - 1] || !bits[0] ||
                (bits.Length > 5 && bits[5]) || (bits.Length > 6 && bits[6])) return false; // no issuer KU
            if (bits.Length > 7 && (bits[7] || (bits.Length > 8 && bits[8])) && !bits[4]) return false; // requires keyAgreement

            var purpose = new AsnReader(purposes[0].RawData, AsnEncodingRules.DER);
            var sequence = purpose.ReadSequence();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            while (sequence.HasData)
            {
                string oid = sequence.ReadObjectIdentifier();
                if (oid == "2.5.29.37.0" || !seen.Add(oid)) return false; // any-EKU is not a grant
            }
            purpose.ThrowIfNotEmpty();
            return seen.Contains(eku);
        }
        catch (AsnContentException) { return false; }
        catch (CryptographicException) { return false; }
    }

    // LocalMachine/My only, read-only. Never imports, repairs, enrolls, or exports.
    // This does NOT prove the service SID or key ACL; the executable gate stays shut.
    internal static X509Certificate2 OpenLocal(string sha256, string eku)
    {
        ValidatePin(sha256);
        using var store = new X509Store(StoreName.My, StoreLocation.LocalMachine);
        store.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
        var certificates = store.Certificates;
        X509Certificate2? selected = null;
        try
        {
            foreach (var certificate in certificates)
            {
                if (certificate.GetCertHashString(HashAlgorithmName.SHA256) != sha256) continue;
                if (selected is not null || !certificate.HasPrivateKey || !HasProfile(certificate, eku))
                    throw new AuthenticationException("ERR_LOCAL_CERT");
                // Hold an OS key handle; do not serialize the private key.
                using RSA? rsa = certificate.GetRSAPrivateKey();
                using ECDsa? ec = certificate.GetECDsaPrivateKey();
                CngKey? key = rsa is RSACng r ? r.Key : ec is ECDsaCng e ? e.Key : null;
                if (key is null || !key.IsMachineKey || key.IsEphemeral ||
                    key.ExportPolicy != CngExportPolicies.None ||
                    (key.Provider != CngProvider.MicrosoftSoftwareKeyStorageProvider &&
                     key.Provider != CngProvider.MicrosoftPlatformCryptoProvider))
                    throw new AuthenticationException("ERR_LOCAL_KEY_POLICY");
                selected = certificate;
            }
            return selected ?? throw new AuthenticationException("ERR_LOCAL_CERT");
        }
        catch
        {
            selected?.Dispose();
            selected = null;
            throw;
        }
        finally
        {
            foreach (var certificate in certificates)
                if (!ReferenceEquals(certificate, selected)) certificate.Dispose();
        }
    }

    internal static bool ValidatePeer(X509Certificate? remote, X509Chain? chain,
        SslPolicyErrors errors, string sha256, string eku)
    {
        // Schannel's platform chain/revocation result AND exact provisioned leaf
        // identity must agree. Never replace chain failure with pin success.
        if (errors != SslPolicyErrors.None || remote is not X509Certificate2 certificate || chain is null)
            return false;
        try
        {
            return certificate.GetCertHashString(HashAlgorithmName.SHA256) == sha256 &&
                HasProfile(certificate, eku) && chain.ChainStatus.Length == 0;
        }
        catch (CryptographicException) { return false; }
    }

    internal static X509ChainPolicy ChainPolicy(string eku)
    {
        var policy = new X509ChainPolicy
        {
            TrustMode = X509ChainTrustMode.System,
            RevocationMode = X509RevocationMode.Online,
            RevocationFlag = X509RevocationFlag.EntireChain,
            VerificationFlags = X509VerificationFlags.NoFlag,
            UrlRetrievalTimeout = TimeSpan.FromSeconds(2),
            DisableCertificateDownloads = true
        };
        policy.ApplicationPolicy.Add(new Oid(eku));
        return policy;
    }
}
