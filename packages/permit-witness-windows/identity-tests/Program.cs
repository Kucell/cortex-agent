using System.Reflection;
using System.Security.Authentication;
using System.Text;
using PermitWitness.Windows;

// No WindowsIdentity, stores, chains, keys, certificates, filesystem mutation or
// network fixtures. Parser success NEVER means origin/service authentication.
internal static class Program
{
    private static int passed;
    private static readonly string Leaf = new('A', 64), Root = new('B', 64);
    private static string Valid => "{\"format_version\":1,\"certificate_sha256\":\"" + Leaf + "\",\"root_sha256\":\"" + Root + "\"}";
    private static void Assert(bool value) { if (!value) throw new Exception("assertion failed"); }
    private static void Check(string name, Action action) { action(); passed++; Console.WriteLine("PASS " + name); }
    private static void Deny(byte[] bytes)
    {
        try { ProvisionedServiceIdentity.ParseConfiguration(bytes); }
        catch (AuthenticationException error) { Assert(error.Message == "ERR_SERVICE_CONFIGURATION"); return; }
        throw new Exception("invalid configuration accepted");
    }
    private static void Deny(string text) => Deny(Encoding.UTF8.GetBytes(text));
    private static void LoadDenied()
    {
        try { ProvisionedServiceIdentity.Load(); }
        catch (Exception error) when (error is PlatformNotSupportedException or AuthenticationException)
        {
            Assert(error.Message == (OperatingSystem.IsWindows() ? "ERR_SERVICE_IDENTITY_ACCEPTANCE_UNVERIFIED" : "ERR_WINDOWS_REQUIRED"));
            return;
        }
        throw new Exception("unverified native acceptance succeeded");
    }
    public static int Main()
    {
        Check("valid nonsecret config only parses pins", () =>
        {
            var value = ProvisionedServiceIdentity.ParseConfiguration(Encoding.UTF8.GetBytes(Valid));
            Assert(value.CertificateSha256 == Leaf && value.RootSha256 == Root);
        });
        Check("property order and whitespace do not change values", () =>
        {
            var value = ProvisionedServiceIdentity.ParseConfiguration(Encoding.UTF8.GetBytes(" {\"root_sha256\":\"" + Root + "\",\"certificate_sha256\":\"" + Leaf + "\",\"format_version\":1} \r\n"));
            Assert(value.CertificateSha256 == Leaf);
        });
        Check("empty and missing fields refused", () => { Deny(""); Deny("{}"); Deny("{\"format_version\":1}"); });
        Check("unknown fields including identity/provider/path refused", () =>
        {
            foreach (string key in new[] { "identity", "account", "service", "path", "store", "eku", "provider", "private_key", "verified", "rollback_domain" })
                Deny(Valid[..^1] + ",\"" + key + "\":true}");
        });
        Check("duplicate and escaped duplicate names refused", () =>
        {
            Deny(Valid[..^1] + ",\"format_version\":1}");
            Deny(Valid[..^1] + ",\"\\u0066ormat_version\":1}");
            Deny(Valid[..^1] + ",\"certificate_sha256\":\"" + Leaf + "\"}");
        });
        Check("pin length/case/format rejected without normalization", () =>
        {
            foreach (string pin in new[] { "", new string('a', 64), new string('G', 64), new string('A', 63), new string('A', 65), " " + Leaf, "sha256:" + Leaf })
                Deny(Valid.Replace(Leaf, pin, StringComparison.Ordinal));
        });
        Check("leaf identical to root is not deployment proof", () => Deny(Valid.Replace(Root, Leaf, StringComparison.Ordinal)));
        Check("format versions and wrong JSON types refused", () =>
        {
            foreach (string version in new[] { "0", "2", "-1", "1.5", "true", "null", "\"1\"", "{}", "[]" })
                Deny(Valid.Replace("\"format_version\":1", "\"format_version\":" + version, StringComparison.Ordinal));
            Deny(Valid.Replace("\"" + Leaf + "\"", "null", StringComparison.Ordinal));
        });
        Check("arrays/scalars are not configuration", () => { foreach (string value in new[] { "[]", "null", "true", "1", "\"config\"" }) Deny(value); });
        Check("depth and comments/trailing commas refused", () =>
        { Deny("{\"format_version\":{\"nested\":{\"deep\":1}}}"); Deny("/*comment*/" + Valid); Deny(Valid[..^1] + ",}"); });
        Check("multiple JSON and NUL suffix refused", () => { Deny(Valid + Valid); Deny(Valid + "\0"); });
        Check("invalid UTF8 and BOM refused", () =>
        { Deny(new byte[] { 0xC0, 0xAF }); Deny(new byte[] { 0xEF, 0xBB, 0xBF }.Concat(Encoding.UTF8.GetBytes(Valid)).ToArray()); });
        Check("byte capacity boundary is exact", () =>
        {
            int size = Encoding.UTF8.GetByteCount(Valid);
            var bytes = Encoding.UTF8.GetBytes(Valid + new string(' ', ProvisionedServiceIdentity.MaxConfigurationBytes - size));
            Assert(bytes.Length == 4096); ProvisionedServiceIdentity.ParseConfiguration(bytes);
            Deny(bytes.Concat(new byte[] { 32 }).ToArray());
        });
        Check("fixed composition constants select no caller policy", () =>
        {
            Assert(ProvisionedServiceIdentity.ServiceName == "CortexPermitAuthority");
            Assert(ProvisionedServiceIdentity.AccountName == @"NT SERVICE\CortexPermitAuthority");
            Assert(ProvisionedServiceIdentity.ConfigurationRelativePath == @"CortexPermitAuthority\.agent\config\identity.json");
            Assert(ProvisionedServiceIdentity.BinaryRelativePath == @"CortexPermitAuthority\PermitWitness.Windows.exe");
            Assert(ProvisionedServiceIdentity.CertificateLocation == "LocalMachine" && ProvisionedServiceIdentity.CertificateStore == "My");
            Assert(ProvisionedServiceIdentity.RequiredEku == "1.3.6.1.5.5.7.3.1");
            var load = typeof(ProvisionedServiceIdentity).GetMethod("Load", BindingFlags.Static | BindingFlags.NonPublic)!;
            Assert(load.GetParameters().Length == 0 && load.ReturnType == typeof(void));
        });
        Check("no certificate account service or callback can be supplied to Load", LoadDenied);
        Check("successful parsing does not grant a capability", () =>
        { ProvisionedServiceIdentity.ParseConfiguration(Encoding.UTF8.GetBytes(Valid)); LoadDenied(); Assert(!ProvisionedServiceIdentity.AuthorityEnabled && !ProvisionedServiceIdentity.IndependentRollbackDomainVerified); });
        Console.WriteLine("PASS " + passed + " groups; native Windows acceptance BLOCKED; no certificates or services created");
        return 0;
    }
}
