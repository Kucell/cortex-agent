using System.Net.Security;
using System.Net.Sockets;
using System.Runtime.Versioning;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;

namespace PermitWitness.Windows;

// Dormant transport candidate. Only trusted service bootstrap may eventually
// construct policy; none of these values are accepted through IPC, argv or env.
internal sealed record ProvisionedEndpoint(string DnsName, int Port, string LocalCertificateSha256,
    string PeerCertificateSha256);

internal static class NativeTls
{
    internal static async Task<byte[]> ExchangeAsync(ProvisionedEndpoint endpoint,
        ReadOnlyMemory<byte> request, TimeSpan timeout, CancellationToken cancellation)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("ERR_WINDOWS_REQUIRED");
        return await ExchangeWindowsAsync(endpoint, request, timeout, cancellation);
    }

    [SupportedOSPlatform("windows")]
    private static async Task<byte[]> ExchangeWindowsAsync(ProvisionedEndpoint endpoint,
        ReadOnlyMemory<byte> request, TimeSpan timeout, CancellationToken cancellation)
    {
        Validate(endpoint, timeout);
        if (request.IsEmpty || request.Length > Frames.MaxBytes) throw new ProtocolException();
        using var deadline = CreateDeadline(timeout, cancellation);
        using var socket = new TcpClient();
        // Closing the socket interrupts native I/O even if cancellation alone is
        // insufficient. Certificate retrieval/Schannel cancellation still needs
        // Windows measurements; this is not a hard wall-clock guarantee.
        using var abort = deadline.Token.Register(socket.Dispose);
        await socket.ConnectAsync(endpoint.DnsName, endpoint.Port, deadline.Token);
        using var certificate = WindowsCertificates.OpenLocal(endpoint.LocalCertificateSha256, WindowsCertificates.ClientEku);
        using var tls = new SslStream(socket.GetStream(), false, (_, remote, chain, errors) =>
            WindowsCertificates.ValidatePeer(remote, chain, errors, endpoint.PeerCertificateSha256, WindowsCertificates.ServerEku));
        var options = new SslClientAuthenticationOptions
        {
            TargetHost = endpoint.DnsName,
            ClientCertificates = new X509CertificateCollection { certificate },
            LocalCertificateSelectionCallback = (_, _, _, _, _) => certificate,
            EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
            EncryptionPolicy = EncryptionPolicy.RequireEncryption,
            CertificateChainPolicy = WindowsCertificates.ChainPolicy(WindowsCertificates.ServerEku),
            CertificateRevocationCheckMode = X509RevocationMode.Online,
            AllowRenegotiation = false,
            AllowTlsResume = false
        };
        await tls.AuthenticateAsClientAsync(options, deadline.Token);
        RequireMutualTls(tls);
        deadline.Token.ThrowIfCancellationRequested();
        await Frames.WriteAsync(tls, request, deadline.Token);
        byte[] response = await Frames.ReadAsync(tls, deadline.Token);
        deadline.Token.ThrowIfCancellationRequested();
        return response; // Untrusted application bytes; never execution approval.
    }

    // Owns/disposes the accepted socket. No listener is exposed by this package.
    // Candidate witness side validates and reads one request, then always refuses
    // it: no authoritative registration/transaction host is implemented here.
    internal static async Task RefuseAcceptedAsync(TcpClient socket, ProvisionedEndpoint endpoint,
        TimeSpan timeout, CancellationToken cancellation)
    {
        using (socket)
        {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("ERR_WINDOWS_REQUIRED");
            await RefuseWindowsAsync(socket, endpoint, timeout, cancellation);
        }
    }

    [SupportedOSPlatform("windows")]
    private static async Task RefuseWindowsAsync(TcpClient socket, ProvisionedEndpoint endpoint,
        TimeSpan timeout, CancellationToken cancellation)
    {
        Validate(endpoint, timeout);
        using var deadline = CreateDeadline(timeout, cancellation);
        using var abort = deadline.Token.Register(socket.Dispose);
        using var certificate = WindowsCertificates.OpenLocal(endpoint.LocalCertificateSha256, WindowsCertificates.ServerEku);
        using var tls = new SslStream(socket.GetStream(), false, (_, remote, chain, errors) =>
            WindowsCertificates.ValidatePeer(remote, chain, errors, endpoint.PeerCertificateSha256, WindowsCertificates.ClientEku));
        await tls.AuthenticateAsServerAsync(new SslServerAuthenticationOptions
        {
            ServerCertificate = certificate,
            ClientCertificateRequired = true,
            EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
            EncryptionPolicy = EncryptionPolicy.RequireEncryption,
            CertificateChainPolicy = WindowsCertificates.ChainPolicy(WindowsCertificates.ClientEku),
            CertificateRevocationCheckMode = X509RevocationMode.Online,
            AllowRenegotiation = false,
            AllowTlsResume = false
        }, deadline.Token);
        RequireMutualTls(tls);
        var request = Frames.ParseRequest(await Frames.ReadAsync(tls, deadline.Token));
        await Frames.WriteAsync(tls, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
        {
            version = 1, request_id = request.RequestId, code = "ERR_AUTHORITY_NOT_IMPLEMENTED"
        }), deadline.Token);
    }

    internal static CancellationTokenSource CreateDeadline(TimeSpan timeout, CancellationToken cancellation)
    {
        if (timeout < TimeSpan.FromMilliseconds(1) || timeout > TimeSpan.FromSeconds(30))
            throw new ArgumentOutOfRangeException(nameof(timeout));
        cancellation.ThrowIfCancellationRequested();
        var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(timeout);
        return deadline;
    }

    [SupportedOSPlatform("windows")]
    private static void Validate(ProvisionedEndpoint endpoint, TimeSpan timeout)
    {
        if (string.IsNullOrEmpty(endpoint.DnsName) ||
            Uri.CheckHostName(endpoint.DnsName) != UriHostNameType.Dns || endpoint.Port is < 1 or > 65535 ||
            timeout < TimeSpan.FromMilliseconds(1) || timeout > TimeSpan.FromSeconds(30))
            throw new AuthenticationException("ERR_ENDPOINT_POLICY");
        WindowsCertificates.ValidatePin(endpoint.LocalCertificateSha256);
        WindowsCertificates.ValidatePin(endpoint.PeerCertificateSha256);
    }

    private static void RequireMutualTls(SslStream tls)
    {
        if (!tls.IsAuthenticated || !tls.IsMutuallyAuthenticated || !tls.IsEncrypted ||
            !tls.IsSigned || tls.RemoteCertificate is null || tls.LocalCertificate is null)
            throw new AuthenticationException("ERR_MUTUAL_TLS_REQUIRED");
    }
}
