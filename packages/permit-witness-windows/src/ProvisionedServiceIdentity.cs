using System.Security.Authentication;
using System.Text;
using System.Text.Json;

namespace PermitWitness.Windows;

// Fixed future composition root; neither IPC/request data, argv nor environment
// chooses an identity, account, certificate store, EKU or configuration path.
// This file deliberately cannot produce an accepted service identity: native
// token/SCM/config ACL/CNG ACL+use evidence has not been validated on Windows.
// Unvalidated native implementation belongs in .agent, not a dormant enable path.
internal static class ProvisionedServiceIdentity
{
    internal const string ServiceName = "CortexPermitAuthority";
    internal const string AccountName = @"NT SERVICE\CortexPermitAuthority";
    // Relative to the OS KnownFolder ProgramData, never a user home or env path.
    // Agent logs/debug/runtime assets belong under CortexPermitAuthority\.agent\runtime.
    // Configuration and its full parent chain remain OS protected and service-read-only.
    internal const string ConfigurationRelativePath = @"CortexPermitAuthority\.agent\config\identity.json";
    internal const string BinaryRelativePath = @"CortexPermitAuthority\PermitWitness.Windows.exe";
    internal const string CertificateLocation = "LocalMachine";
    internal const string CertificateStore = "My";
    internal const string RequiredEku = "1.3.6.1.5.5.7.3.1";
    internal const int MaxConfigurationBytes = 4096;
    internal static bool AuthorityEnabled => false;
    internal static bool IndependentRollbackDomainVerified => false;

    // No acceptance object/certificate/key can escape while the OS proof chain
    // is absent. No credential-store, filesystem, crypto-key or network access.
    internal static void Load()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("ERR_WINDOWS_REQUIRED");
        throw new AuthenticationException("ERR_SERVICE_IDENTITY_ACCEPTANCE_UNVERIFIED");
    }

    // Parse ONLY a detached nonsecret configuration supplied by a future fixed,
    // protected file reader. Parsing does not authenticate its origin or grant
    // Load/authority/TLS access, even if callers construct the record themselves.
    internal sealed record Configuration(string CertificateSha256, string RootSha256);
    internal static Configuration ParseConfiguration(ReadOnlySpan<byte> bytes)
    {
        if (bytes.IsEmpty || bytes.Length > MaxConfigurationBytes) throw Refuse();
        try
        {
            // No replacement decoding, BOM, NUL suffix or multiple JSON bodies.
            _ = new UTF8Encoding(false, true).GetString(bytes);
            using var document = JsonDocument.Parse(bytes.ToArray(), new JsonDocumentOptions
            { MaxDepth = 2, AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw Refuse();
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in root.EnumerateObject())
                if (!names.Add(property.Name) || property.Name is not ("format_version" or "certificate_sha256" or "root_sha256"))
                    throw Refuse();
            if (names.Count != 3 || !root.GetProperty("format_version").TryGetInt32(out int version) || version != 1)
                throw Refuse();
            string leaf = Pin(root.GetProperty("certificate_sha256"));
            string anchor = Pin(root.GetProperty("root_sha256"));
            if (leaf == anchor) throw Refuse();
            return new(leaf, anchor);
        }
        catch (Exception error) when (error is JsonException or DecoderFallbackException or InvalidOperationException or FormatException)
        { throw Refuse(); }
    }
    private static string Pin(JsonElement value)
    {
        string? text = value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        if (text is null || text.Length != 64 || text.Any(c => !char.IsAsciiHexDigitUpper(c))) throw Refuse();
        return text;
    }
    private static AuthenticationException Refuse() => new("ERR_SERVICE_CONFIGURATION");
}
