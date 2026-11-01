using System.Net.Security;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using PermitWitness.Windows;

// Dependency-free harness; no test certificate, key or certificate store is created.
internal static class Program
{
    private static int passed;
    private static byte[] Utf8(string text) => Encoding.UTF8.GetBytes(text);
    private static readonly Guid RequestId = Guid.Parse("00112233-4455-6677-8899-aabbccddeeff");
    private static readonly byte[] Request = Convert.FromHexString("00000014010100112233445566778899AABBCCDDEEFF7B7D");

    public static async Task<int> Main()
    {
        await Check("default gate refuses without accepting credentials", () =>
        {
            Assert(PermitWitness.Windows.Program.Refuse([]) == (OperatingSystem.IsWindows() ? 78 : 69));
            return Task.CompletedTask;
        });
        await Check("arguments cannot enable or forge authentication", () =>
        {
            Assert(PermitWitness.Windows.Program.Refuse(["--authenticated=true"]) == 64);
            return Task.CompletedTask;
        });
        await Check("fixed checkpoint vector and segmented request decode", async () =>
        {
            Assert(Frames.EncodeRequest(1, RequestId, Utf8("{}")).SequenceEqual(Request));
            using var segmented = new OneByteStream(Request);
            var request = await Frames.ReadRequestAsync(segmented, default);
            Assert(request.Operation == 1 && request.RequestId == RequestId && request.Payload.SequenceEqual(Utf8("{}")));
            using var wire = new MemoryStream();
            await Frames.WriteRequestAsync(wire, 1, RequestId, Utf8("{}"), default);
            Assert(wire.ToArray().SequenceEqual(Request));
        });
        await Check("shared single-frame EOF vectors for request and response", async () =>
        {
            // Shared vectors: fixed checkpoint request and its status-00 response.
            byte[] response = Convert.FromHexString("00000015010100112233445566778899AABBCCDDEEFF007B7D");
            foreach (bool isResponse in new[] { false, true })
            {
                byte[] frame = isResponse ? response : Request;
                // One byte at a time, including an explicit subsequent EOF read.
                using (var normal = new OneByteStream(frame))
                {
                    if (isResponse)
                        Assert((await Frames.ReadResponseAsync(normal, 1, RequestId, Utf8("{}"), default)).Payload.SequenceEqual(Utf8("{}")));
                    else
                        Assert((await Frames.ReadRequestAsync(normal, default)).Payload.SequenceEqual(Utf8("{}")));
                }
                foreach (byte[] invalid in new[] { frame.Concat(new byte[] { 0 }).ToArray(), frame.Concat(frame).ToArray() })
                {
                    using var segmented = new OneByteStream(invalid);
                    if (isResponse)
                        await Throws<ProtocolException>(async () => { await Frames.ReadResponseAsync(segmented, 1, RequestId, Utf8("{}"), default); });
                    else
                        await Throws<ProtocolException>(async () => { await Frames.ReadRequestAsync(segmented, default); });
                }
            }
        });
        await Check("response echoes operation and RFC UUID with allowed statuses", async () =>
        {
            for (byte op = 1; op <= 2; op++)
            for (byte status = 0; status <= 3; status++)
            {
                byte[] expected = Convert.FromHexString($"0000001501{op:X2}00112233445566778899AABBCCDDEEFF{status:X2}7B7D");
                Assert(Frames.EncodeResponse(op, RequestId, status, Utf8("{}")).SequenceEqual(expected));
                using var segmented = new OneByteStream(expected);
                var response = await Frames.ReadResponseAsync(segmented, op, RequestId, Utf8("{}"), default);
                Assert(response.Operation == op && response.RequestId == RequestId && response.Status == status &&
                    response.Payload.SequenceEqual(Utf8("{}")));
                using var wire = new MemoryStream();
                await Frames.WriteResponseAsync(wire, op, RequestId, status, Utf8("{}"), default);
                Assert(wire.ToArray().SequenceEqual(expected));
            }
        });
        await Check("malformed and truncated frames fail closed", async () =>
        {
            foreach (byte[] data in new byte[][] {
                [], [0], [0,0,0], [0,0,0,0], [0,0,0,18], [255,255,255,255], Request[..^1],
                Request.Select((b, i) => i == 4 ? (byte)2 : b).ToArray(),
                Request.Select((b, i) => i == 5 ? (byte)3 : b).ToArray()
            })
            {
                using var stream = new OneByteStream(data);
                await Throws<ProtocolException>(async () => { await Frames.ReadRequestAsync(stream, default); });
            }
            ThrowsSync<ProtocolException>(() => Frames.EncodeRequest(0, RequestId, Utf8("{}")));
            ThrowsSync<ProtocolException>(() => Frames.EncodeRequest(3, RequestId, Utf8("{}")));
            ThrowsSync<ProtocolException>(() => Frames.EncodeRequest(1, RequestId, []));
            ThrowsSync<ProtocolException>(() => Frames.EncodeResponse(1, RequestId, 4, Utf8("{}")));
            ThrowsSync<ProtocolException>(() => Frames.EncodeResponse(1, RequestId, 0, []));
        });
        await Check("request encoding and decoding require an opening brace", async () =>
        {
            foreach (byte first in new byte[] { 0, 1, 2, 3, 0x20, 0x5b, 0xef })
            {
                byte[] payload = [first, 0x7d];
                ThrowsSync<ProtocolException>(() => Frames.EncodeRequest(1, RequestId, payload));
                byte[] wire = (byte[])Request.Clone(); wire[22] = first;
                using var stream = new OneByteStream(wire);
                await Throws<ProtocolException>(async () => { await Frames.ReadRequestAsync(stream, default); });
            }
            // Prefix check deliberately does not parse or validate JSON.
            byte[] invalidJson = Utf8("{not-json");
            using var acceptsPrefix = new MemoryStream(Frames.EncodeRequest(1, RequestId, invalidJson));
            Assert((await Frames.ReadRequestAsync(acceptsPrefix, default)).Payload.SequenceEqual(invalidJson));
        });
        await Check("responses reject request vector, bad status, mismatched identity and trailing bytes", async () =>
        {
            var valid = Frames.EncodeResponse(1, RequestId, 0, Utf8("{}"));
            var badStatus = (byte[])valid.Clone(); badStatus[22] = 4;
            var otherVersion = (byte[])valid.Clone(); otherVersion[4] = 2;
            var wrongOperation = (byte[])valid.Clone(); wrongOperation[5] = 2;
            var wrongId = (byte[])valid.Clone(); wrongId[6] ^= 1;
            foreach (byte[] data in new byte[][] { Request, badStatus, otherVersion, wrongOperation, wrongId,
                valid[..^1], valid.Concat(new byte[] { 0 }).ToArray(), valid.Concat(valid).ToArray() })
            {
                using var stream = new OneByteStream(data);
                await Throws<ProtocolException>(async () => { await Frames.ReadResponseAsync(stream, 1, RequestId, Utf8("{}"), default); });
            }
            // Reflected requests start with 0x7b, never an allowed status.
            foreach (byte op in new byte[] { 1, 2 })
            {
                byte[] reflected = Frames.EncodeRequest(op, RequestId, Utf8("{\"a\":1}"));
                using var reflectedStream = new OneByteStream(reflected);
                await Throws<ProtocolException>(async () => { await Frames.ReadResponseAsync(reflectedStream, op, RequestId, Utf8("{\"a\":1}"), default); });
            }
            using var invalidSentPayload = new MemoryStream(valid);
            await Throws<ProtocolException>(async () => { await Frames.ReadResponseAsync(invalidSentPayload, 1, RequestId, new byte[] { 0, 0x7b }, default); });
            using var mismatch = new MemoryStream(valid);
            await Throws<ProtocolException>(async () => { await Frames.ReadResponseAsync(mismatch, 2, RequestId, Utf8("{}"), default); });
            using var mismatchId = new MemoryStream(valid);
            await Throws<ProtocolException>(async () => { await Frames.ReadResponseAsync(mismatchId, 1, Guid.Empty, Utf8("{}"), default); });
        });
        await Check("maximum payload and length prefix boundaries", async () =>
        {
            var maximum = new byte[Frames.MaxPayload]; maximum[0] = 0x7b; maximum[^1] = 42;
            var request = Frames.EncodeRequest(2, RequestId, maximum);
            using var requestStream = new MemoryStream(request);
            var decodedRequest = await Frames.ReadRequestAsync(requestStream, default);
            Assert(decodedRequest.Payload.SequenceEqual(maximum));
            var response = Frames.EncodeResponse(2, RequestId, 3, maximum);
            using var responseStream = new MemoryStream(response);
            var decodedResponse = await Frames.ReadResponseAsync(responseStream, 2, RequestId, maximum, default);
            Assert(decodedResponse.Payload.SequenceEqual(maximum) && decodedResponse.Status == 3);
            ThrowsSync<ProtocolException>(() => Frames.EncodeRequest(1, RequestId, new byte[Frames.MaxPayload + 1]));
            ThrowsSync<ProtocolException>(() => Frames.EncodeResponse(1, RequestId, 0, new byte[Frames.MaxPayload + 1]));
            byte[] tooLargeRequest = [0, 0x10, 0, 0x13]; // 18 + 1,048,577
            byte[] tooLargeResponse = [0, 0x10, 0, 0x14]; // 19 + 1,048,577
            using var req = new MemoryStream(tooLargeRequest);
            using var res = new MemoryStream(tooLargeResponse);
            await Throws<ProtocolException>(async () => { await Frames.ReadRequestAsync(req, default); });
            await Throws<ProtocolException>(async () => { await Frames.ReadResponseAsync(res, 1, RequestId, Utf8("{}"), default); });
        });
        await Check("EOF wait, reads and writes honor cancellation", async () =>
        {
            using var blocking = new BlockingStream();
            using var readDeadline = NativeTls.CreateDeadline(TimeSpan.FromMilliseconds(30), default);
            await Throws<OperationCanceledException>(async () => { await Frames.ReadRequestAsync(blocking, readDeadline.Token); });
            using var writeDeadline = NativeTls.CreateDeadline(TimeSpan.FromMilliseconds(30), default);
            await Throws<OperationCanceledException>(() => Frames.WriteRequestAsync(blocking, 1, RequestId, Utf8("{}"), writeDeadline.Token));
            using var noEof = new NoEofStream(Frames.EncodeResponse(1, RequestId, 0, Utf8("{}")));
            using var eofDeadline = NativeTls.CreateDeadline(TimeSpan.FromMilliseconds(30), default);
            await Throws<OperationCanceledException>(async () => { await Frames.ReadResponseAsync(noEof, 1, RequestId, Utf8("{}"), eofDeadline.Token); });
            using var noRequestEof = new NoEofStream(Request);
            using var requestEofDeadline = NativeTls.CreateDeadline(TimeSpan.FromMilliseconds(30), default);
            await Throws<OperationCanceledException>(async () => { await Frames.ReadRequestAsync(noRequestEof, requestEofDeadline.Token); });
            using var caller = new CancellationTokenSource();
            using var linked = NativeTls.CreateDeadline(TimeSpan.FromSeconds(30), caller.Token);
            caller.Cancel();
            await Throws<OperationCanceledException>(async () => { await Frames.ReadRequestAsync(blocking, linked.Token); });
            ThrowsSync<OperationCanceledException>(() => NativeTls.CreateDeadline(TimeSpan.FromSeconds(1), caller.Token));
            ThrowsSync<ArgumentOutOfRangeException>(() => NativeTls.CreateDeadline(TimeSpan.Zero, default));
        });
        await Check("legacy JSON framing remains disabled", async () =>
        {
            using var wire = new MemoryStream(Request);
            await Throws<ProtocolException>(async () => { await Frames.ReadAsync(wire, default); });
            await Throws<ProtocolException>(() => Frames.WriteAsync(wire, Request, default));
            ThrowsSync<ProtocolException>(() => Frames.ParseRequest(Request));
        });
        await Check("certificate policy refuses missing chain and every TLS error", () =>
        {
            string pin = new('A', 64);
            WindowsCertificates.ValidatePin(pin);
            foreach (string invalid in new[] { "", new string('a', 64), new string('A', 63), new string('Z', 64) })
                ThrowsSync<AuthenticationException>(() => WindowsCertificates.ValidatePin(invalid));
            foreach (SslPolicyErrors error in new[] { SslPolicyErrors.None, SslPolicyErrors.RemoteCertificateNotAvailable,
                SslPolicyErrors.RemoteCertificateNameMismatch, SslPolicyErrors.RemoteCertificateChainErrors })
                Assert(!WindowsCertificates.ValidatePeer(null, null, error, pin, WindowsCertificates.ServerEku));
            var policy = WindowsCertificates.ChainPolicy(WindowsCertificates.ClientEku);
            Assert(policy.TrustMode == X509ChainTrustMode.System && policy.RevocationMode == X509RevocationMode.Online &&
                policy.VerificationFlags == X509VerificationFlags.NoFlag && policy.DisableCertificateDownloads &&
                policy.RevocationFlag == X509RevocationFlag.EntireChain &&
                policy.ApplicationPolicy[0].Value == WindowsCertificates.ClientEku);
            return Task.CompletedTask;
        });
        await Check("explicit role EKU, signature KU and validity required", () =>
        {
            var now = new DateTime(2026, 10, 31, 0, 0, 0, DateTimeKind.Utc);
            var start = now.AddMinutes(-1);
            var end = now.AddMinutes(1);
            var client = Extensions(WindowsCertificates.ClientEku, X509KeyUsageFlags.DigitalSignature);
            var server = Extensions(WindowsCertificates.ServerEku, X509KeyUsageFlags.DigitalSignature);
            var noEku = Extensions(null, X509KeyUsageFlags.DigitalSignature);
            var wrongUsage = Extensions(WindowsCertificates.ClientEku, X509KeyUsageFlags.KeyEncipherment);
            Assert(WindowsCertificates.HasProfile(client, start, end, WindowsCertificates.ClientEku, now));
            Assert(WindowsCertificates.HasProfile(server, start, end, WindowsCertificates.ServerEku, now));
            Assert(!WindowsCertificates.HasProfile(client, start, end, WindowsCertificates.ServerEku, now));
            Assert(!WindowsCertificates.HasProfile(noEku, start, end, WindowsCertificates.ClientEku, now));
            Assert(!WindowsCertificates.HasProfile(wrongUsage, start, end, WindowsCertificates.ClientEku, now));
            Assert(!WindowsCertificates.HasProfile(client, start, end, WindowsCertificates.ClientEku, end.AddTicks(1)));
            client.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
            Assert(!WindowsCertificates.HasProfile(client, start, end, WindowsCertificates.ClientEku, now));
            return Task.CompletedTask;
        });
        await Check("leaf profile requires unique explicit non-CA basic constraints", () =>
        {
            Assert(Profile(ProfileWith("2.5.29.19", new X509BasicConstraintsExtension(false, false, 0, false))));
            foreach (X509Extension? constraint in new X509Extension?[] {
                null, new X509BasicConstraintsExtension(true, false, 0, true),
                new X509BasicConstraintsExtension(false, true, 0, true),
                new X509Extension("2.5.29.19", Convert.FromHexString("3003010100"), false), // DER DEFAULT encoded
                new X509Extension("2.5.29.19", Convert.FromHexString("300000"), false), // trailing data
                new X509Extension("2.5.29.19", Convert.FromHexString("300101"), false) })
                Assert(!Profile(ProfileWith("2.5.29.19", constraint)));
            foreach (string oid in new[] { "2.5.29.19", "2.5.29.15", "2.5.29.37" })
            {
                var duplicate = Extensions(WindowsCertificates.ServerEku, X509KeyUsageFlags.DigitalSignature);
                var original = duplicate.Cast<X509Extension>().Single(e => e.Oid!.Value == oid);
                duplicate.Add(new X509Extension(oid, original.RawData, original.Critical));
                Assert(!Profile(duplicate));
            }
            return Task.CompletedTask;
        });
        await Check("leaf KU requires signing and forbids issuer and undefined bits", () =>
        {
            foreach (X509KeyUsageFlags usage in new[] { X509KeyUsageFlags.DigitalSignature,
                X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment,
                X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyAgreement | X509KeyUsageFlags.EncipherOnly,
                X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyAgreement | X509KeyUsageFlags.DecipherOnly })
                Assert(Profile(Extensions(WindowsCertificates.ServerEku, usage)));
            foreach (X509KeyUsageFlags usage in new[] { X509KeyUsageFlags.None, X509KeyUsageFlags.KeyEncipherment,
                X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyCertSign,
                X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.CrlSign,
                X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.EncipherOnly,
                X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.DecipherOnly })
                Assert(!Profile(Extensions(WindowsCertificates.ServerEku, usage)));
            foreach (string der in new[] { "0303078040", "03020781", "0302078000", "03020080" })
                Assert(!Profile(ProfileWith("2.5.29.15", new X509Extension("2.5.29.15", Convert.FromHexString(der), true))));
            Assert(!Profile(ProfileWith("2.5.29.15", null)));
            return Task.CompletedTask;
        });
        await Check("EKU explicit role cannot be replaced or broadened by any-EKU", () =>
        {
            foreach (string[] purposes in new[] { new[] { "2.5.29.37.0" },
                new[] { WindowsCertificates.ServerEku, "2.5.29.37.0" },
                new[] { WindowsCertificates.ServerEku, WindowsCertificates.ServerEku },
                new[] { WindowsCertificates.ClientEku }, Array.Empty<string>() })
            {
                var oids = new OidCollection(); foreach (string oid in purposes) oids.Add(new Oid(oid));
                Assert(!Profile(ProfileWith("2.5.29.37", new X509EnhancedKeyUsageExtension(oids, false))));
            }
            var both = new X509EnhancedKeyUsageExtension(new OidCollection {
                new Oid(WindowsCertificates.ServerEku), new Oid(WindowsCertificates.ClientEku) }, false);
            Assert(Profile(ProfileWith("2.5.29.37", both)));
            foreach (string? invalidRole in new[] { "", "2.5.29.37.0", "1.2.3", null })
                Assert(!Profile(Extensions(WindowsCertificates.ServerEku, X509KeyUsageFlags.DigitalSignature), invalidRole!));
            return Task.CompletedTask;
        });
        await Check("raw extension OIDs are decoded strictly, not trusted by CLR subtype", () =>
        {
            var valid = Extensions(WindowsCertificates.ServerEku, X509KeyUsageFlags.DigitalSignature);
            var generic = new X509ExtensionCollection();
            foreach (var extension in valid) generic.Add(new X509Extension(extension.Oid!, extension.RawData, extension.Critical));
            Assert(Profile(generic));
            foreach (string oid in new[] { "2.5.29.19", "2.5.29.15", "2.5.29.37" })
                foreach (byte[] der in new byte[][] { [], [5, 0], [0x30, 0x80, 0, 0], [0x30, 0x7F] })
                    Assert(!Profile(ProfileWith(oid, new X509Extension(oid, der, false))));
            var purpose = valid.Cast<X509Extension>().Single(e => e.Oid!.Value == "2.5.29.37");
            Assert(!Profile(ProfileWith("2.5.29.37", new X509Extension("2.5.29.37", purpose.RawData.Concat(new byte[] { 0 }).ToArray(), false))));
            return Task.CompletedTask;
        });
        await Check("validity is UTC, ordered and inclusive at exact bounds", () =>
        {
            var now = new DateTime(2026, 10, 31, 0, 0, 0, DateTimeKind.Utc);
            var extensions = Extensions(WindowsCertificates.ServerEku, X509KeyUsageFlags.DigitalSignature);
            bool At(DateTime start, DateTime end, DateTime time) => WindowsCertificates.HasProfile(extensions, start, end, WindowsCertificates.ServerEku, time);
            Assert(At(now, now.AddTicks(1), now) && At(now.AddTicks(-1), now, now) && At(now, now, now));
            Assert(!At(now.AddTicks(1), now.AddTicks(2), now));
            Assert(!At(now.AddTicks(-2), now.AddTicks(-1), now));
            Assert(!At(now.AddTicks(1), now.AddTicks(-1), now));
            foreach (var kind in new[] { DateTimeKind.Local, DateTimeKind.Unspecified })
            {
                var ambiguous = DateTime.SpecifyKind(now, kind);
                Assert(!At(ambiguous, now, now) && !At(now, ambiguous, now) && !At(now, now, ambiguous));
            }
            return Task.CompletedTask;
        });
        if (!OperatingSystem.IsWindows())
            await Check("non-Windows transport refuses before credentials or network", async () =>
            {
                await Throws<PlatformNotSupportedException>(async () =>
                    await NativeTls.ExchangeAsync(new("unused.invalid", 443, "invalid", "invalid"),
                        Request, TimeSpan.FromSeconds(1), default));
            });
        if (!OperatingSystem.IsWindows())
            await Check("non-Windows publication refuses before any native file call", async () =>
            {
                // The guard must fire before CreateFile, so no file is touched
                // and no path is opened on a host without the Windows contract.
                ThrowsSync<PlatformNotSupportedException>(() =>
                    NativePublication.PublishNew("C:\\evidence\\tmp.bin", "C:\\evidence\\final.bin",
                        new byte[] { 1, 2, 3 }));
                ThrowsSync<PlatformNotSupportedException>(() =>
                    NativePublication.Identity("C:\\evidence\\final.bin"));
            });
        await Check("publication failure stages stay distinguishable", () =>
        {
            // The stage must survive on the exception so an unknown outcome can
            // never be collapsed into a plain failure.
            var error = new NativePublication.PublicationException("ERR_PUBLICATION_FLUSH_UNKNOWN",
                NativePublication.Stage.PostRenameFlush, 5);
            Assert(error.FailureStage == NativePublication.Stage.PostRenameFlush);
            Assert(error.NativeError == 5);
            Assert(error is IOException);
            return Task.CompletedTask;
        });
        await Check("publication is not reachable from the process entry point", () =>
        {
            // The shipped entry point keeps refusing; the publication
            // primitive must never become an argument-enabled capability.
            Assert(PermitWitness.Windows.Program.Refuse([]) == (OperatingSystem.IsWindows() ? 78 : 69));
            Assert(PermitWitness.Windows.Program.Refuse(["--publish"]) == 64);
            return Task.CompletedTask;
        });
        await V2Tests.RunAsync();
        Console.WriteLine($"PASS {passed} v1/gate/policy checks plus v2 suite; no certificate or key created; no live TLS exercised; no native publication executed.");
        return 0;
    }

    private static X509ExtensionCollection Extensions(string? eku, X509KeyUsageFlags usage)
    {
        var extensions = new X509ExtensionCollection {
            new X509BasicConstraintsExtension(false, false, 0, true), new X509KeyUsageExtension(usage, true) };
        if (eku is not null)
            extensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new Oid(eku) }, true));
        return extensions;
    }

    private static X509ExtensionCollection ProfileWith(string oid, X509Extension? replacement)
    {
        var extensions = new X509ExtensionCollection();
        foreach (var extension in Extensions(WindowsCertificates.ServerEku, X509KeyUsageFlags.DigitalSignature))
            if (extension.Oid!.Value != oid) extensions.Add(extension);
        if (replacement is not null) extensions.Add(replacement);
        return extensions;
    }

    private static bool Profile(X509ExtensionCollection extensions, string eku = WindowsCertificates.ServerEku)
    {
        var now = new DateTime(2026, 10, 31, 0, 0, 0, DateTimeKind.Utc);
        return WindowsCertificates.HasProfile(extensions, now.AddMinutes(-1), now.AddMinutes(1), eku, now);
    }

    private static async Task Check(string name, Func<Task> body)
    {
        await body();
        passed++;
        Console.WriteLine($"PASS {name}");
    }

    private static void Assert(bool condition)
    {
        if (!condition) throw new Exception("Assertion failed");
    }

    private static async Task Throws<T>(Func<Task> body) where T : Exception
    {
        try { await body(); } catch (T) { return; }
        throw new Exception($"Expected {typeof(T).Name}");
    }

    private static void ThrowsSync<T>(Action body) where T : Exception
    {
        try { body(); } catch (T) { return; }
        throw new Exception($"Expected {typeof(T).Name}");
    }

    private sealed class OneByteStream(byte[] data) : MemoryStream(data)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            base.ReadAsync(buffer[..Math.Min(1, buffer.Length)], cancellationToken);
    }

    private sealed class NoEofStream(byte[] data) : MemoryStream(data)
    {
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (Position < Length) return await base.ReadAsync(buffer, cancellationToken);
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return 0;
        }
    }

    private sealed class BlockingStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() => throw new NotSupportedException();
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return 0;
        }
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default) =>
            await Task.Delay(Timeout.Infinite, cancellationToken);
    }
}
