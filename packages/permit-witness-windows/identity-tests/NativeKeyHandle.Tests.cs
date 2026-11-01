#if NATIVE_KEY_HANDLE_TESTING
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using PermitWitness.Windows;

// Entirely synthetic numeric handles, never actual CNG/registry/cert-store calls.
// This proves managed ownership/lifetime logic, NOT OS identity or ACL access.
internal static class NativeKeyHandleTestInterop
{
    internal static bool Success, CallerFree, ThrowAcquire, ThrowFree, CapiSuccess;
    internal static IntPtr Raw;
    internal static uint Spec;
    internal static int CngStatus, LastError, AcquireError, Acquires, CngFrees, CapiFrees;
    internal static Action? DuringAcquire;
    internal static readonly List<IntPtr> Freed = [];
    internal static void Reset()
    {
        Success = CallerFree = CapiSuccess = true; ThrowAcquire = ThrowFree = false;
        Raw = new(1234); Spec = NativeKeyHandle.NcryptKeySpec;
        CngStatus = 0; LastError = AcquireError = 5; Acquires = CngFrees = CapiFrees = 0; DuringAcquire = null; Freed.Clear();
    }
    internal static bool Acquire(IntPtr certificate, uint flags, IntPtr reserved, out IntPtr key, out uint spec, out bool free)
    {
        NativeKeyHandleTests.Assert(certificate == new IntPtr(42));
        NativeKeyHandleTests.Assert(flags == 0x4004C && reserved == IntPtr.Zero);
        Interlocked.Increment(ref Acquires); DuringAcquire?.Invoke();
        if (ThrowAcquire) throw new InvalidOperationException("synthetic acquire exception");
        key = Raw; spec = Spec; free = CallerFree;
        // Synthetic thread-local error, not a Windows acquisition. This entire
        // interop replacement is absent unless NATIVE_KEY_HANDLE_TESTING is set;
        // production reads the real SetLastError=true P/Invoke result instead.
        Marshal.SetLastPInvokeError(AcquireError);
        return Success;
    }
    internal static int FreeCng(IntPtr key)
    { Interlocked.Increment(ref CngFrees); lock (Freed) Freed.Add(key); if (ThrowFree) throw new InvalidOperationException("synthetic free exception"); return CngStatus; }
    internal static bool FreeCapi(IntPtr key, uint flags)
    { NativeKeyHandleTests.Assert(flags == 0); Interlocked.Increment(ref CapiFrees); lock (Freed) Freed.Add(key); return CapiSuccess; }
}

internal static class NativeKeyHandleTests
{
    private static int passed;
    internal static void Assert(bool value) { if (!value) throw new Exception("ownership assertion failed"); }
    private static void Check(string name, Action action)
    { NativeKeyHandleTestInterop.Reset(); action(); passed++; Console.WriteLine("PASS " + name); }
    private static void Throws<T>(Action action) where T : Exception
    { try { action(); } catch (T) { return; } throw new Exception("expected " + typeof(T).Name); }
    private sealed class Certificate : SafeHandle
    {
        internal int Releases;
        internal int? ReleaseLastError;
        internal int? ReleaseErrorWritten;
        internal Certificate(bool invalid = false) : base(IntPtr.Zero, true) { SetHandle(invalid ? IntPtr.Zero : new IntPtr(42)); }
        public override bool IsInvalid => handle == IntPtr.Zero;
        protected override bool ReleaseHandle()
        {
            Releases++;
            if (ReleaseLastError is int error)
            {
                Marshal.SetLastPInvokeError(error);
                ReleaseErrorWritten = Marshal.GetLastPInvokeError();
            }
            return true;
        }
    }
    public static int Main()
    {
        Check("owned CNG result frees once, repeated dispose never double-frees", () =>
        {
            using var cert = new Certificate(); var key = NativeKeyHandle.Acquire(cert);
            Assert(key.OwnsNativeKey && key.ReleaseStatus is null); key.Dispose(); key.Dispose();
            Assert(NativeKeyHandleTestInterop.CngFrees == 1 && NativeKeyHandleTestInterop.CapiFrees == 0 && key.ReleaseStatus == 0);
            Assert(NativeKeyHandleTestInterop.Freed.Single() == new IntPtr(1234));
        });
        Check("borrowed CNG retains original context and never calls key free", () =>
        {
            NativeKeyHandleTestInterop.CallerFree = false;
            var cert = new Certificate(); var key = NativeKeyHandle.Acquire(cert);
            Assert(!key.OwnsNativeKey); cert.Dispose(); Assert(cert.Releases == 0);
            key.Dispose(); key.Dispose(); Assert(cert.Releases == 1 && key.ReleaseStatus == 0);
            Assert(NativeKeyHandleTestInterop.CngFrees == 0 && NativeKeyHandleTestInterop.CapiFrees == 0);
        });
        Check("owned key does not retain unneeded certificate after acquire", () =>
        {
            var cert = new Certificate(); using var key = NativeKeyHandle.Acquire(cert);
            cert.Dispose(); Assert(cert.Releases == 1 && NativeKeyHandleTestInterop.CngFrees == 0);
        });
        Check("owning key waits for all leases even when owner disposed first", () =>
        {
            using var cert = new Certificate(); var key = NativeKeyHandle.Acquire(cert);
            var a = key.Borrow(); var b = key.Borrow(); key.Dispose();
            Assert(NativeKeyHandleTestInterop.CngFrees == 0 && key.ReleaseStatus is null);
            a.Dispose(); a.Dispose(); Assert(NativeKeyHandleTestInterop.CngFrees == 0);
            b.Dispose(); Assert(NativeKeyHandleTestInterop.CngFrees == 1 && key.ReleaseStatus == 0);
            Throws<ObjectDisposedException>(() => key.Borrow());
        });
        Check("borrowed key leases retain certificate through every disposal order", () =>
        {
            NativeKeyHandleTestInterop.CallerFree = false;
            var cert = new Certificate(); var key = NativeKeyHandle.Acquire(cert); var lease = key.Borrow();
            key.Dispose(); cert.Dispose(); Assert(cert.Releases == 0);
            lease.Dispose(); Assert(cert.Releases == 1 && NativeKeyHandleTestInterop.CngFrees == 0);
        });
        Check("leases disposed before owner do not free it prematurely", () =>
        {
            using var cert = new Certificate(); var key = NativeKeyHandle.Acquire(cert);
            key.Borrow().Dispose(); Assert(NativeKeyHandleTestInterop.CngFrees == 0);
            key.Dispose(); Assert(NativeKeyHandleTestInterop.CngFrees == 1);
        });
        foreach (bool free in new[] { false, true })
        {
            Check("failed acquisition ignores undefined output ownership free=" + free, () =>
            {
                NativeKeyHandleTestInterop.Success = false; NativeKeyHandleTestInterop.CallerFree = free;
                var cert = new Certificate(); Throws<CryptographicException>(() => NativeKeyHandle.Acquire(cert)); cert.Dispose();
                Assert(cert.Releases == 1 && NativeKeyHandleTestInterop.CngFrees == 0 && NativeKeyHandleTestInterop.CapiFrees == 0);
            });
        }
        foreach (int nativeError in new[] { 0, 5, unchecked((int)0x80090016) })
        {
            foreach (bool free in new[] { false, true })
            {
                Check($"synthetic acquisition error survives cleanup, stable refusal free={free} code={nativeError}", () =>
                {
                    NativeKeyHandleTestInterop.Success = false; NativeKeyHandleTestInterop.CallerFree = free;
                    NativeKeyHandleTestInterop.AcquireError = nativeError;
                    var cert = new Certificate { ReleaseLastError = 0x12345678 };
                    // Close the original reference during acquire: the failure
                    // finally must release the retained reference. Inside the
                    // release callback overwrite thread-local error; SafeHandle
                    // can restore it on return, so assert inside that callback.
                    NativeKeyHandleTestInterop.DuringAcquire = cert.Dispose;
                    try { NativeKeyHandle.Acquire(cert); throw new Exception("failed acquire accepted"); }
                    catch (CryptographicException error)
                    {
                        Assert(error.Message == "ERR_NATIVE_KEY_ACQUIRE");
                        Assert(error.HResult == new CryptographicException("ERR_NATIVE_KEY_ACQUIRE").HResult && error.InnerException is null);
                        Assert(error.Data.Count == 1 && error.Data["NativeKeyAcquireError"] is int captured && captured == nativeError);
                        Assert(cert.ReleaseErrorWritten == cert.ReleaseLastError);
                    }
                    cert.Dispose();
                    Assert(cert.Releases == 1 && NativeKeyHandleTestInterop.Acquires == 1);
                    Assert(NativeKeyHandleTestInterop.CngFrees == 0 && NativeKeyHandleTestInterop.CapiFrees == 0);
                });
            }
        }
        Check("successful synthetic acquire does not treat stale error as failure", () =>
        {
            NativeKeyHandleTestInterop.AcquireError = unchecked((int)0x80090016);
            using var cert = new Certificate(); using var key = NativeKeyHandle.Acquire(cert);
            Assert(key.OwnsNativeKey);
        });
        Check("successful native result rejected by validation has no acquisition diagnostic", () =>
        {
            using var cert = new Certificate();
            foreach (uint spec in new[] { 1U, NativeKeyHandle.NcryptKeySpec })
            {
                NativeKeyHandleTestInterop.Spec = spec;
                NativeKeyHandleTestInterop.Raw = spec == NativeKeyHandle.NcryptKeySpec ? IntPtr.Zero : new(1234);
                try { NativeKeyHandle.Acquire(cert); throw new Exception("invalid output accepted"); }
                catch (CryptographicException error)
                {
                    Assert(error.Message == (spec == NativeKeyHandle.NcryptKeySpec ? "ERR_NATIVE_KEY_INVALID" : "ERR_NATIVE_KEY_NOT_CNG"));
                    Assert(error.Data.Count == 0);
                }
            }
        });
        Check("acquire exception releases only context reference", () =>
        {
            NativeKeyHandleTestInterop.ThrowAcquire = true; var cert = new Certificate();
            try { NativeKeyHandle.Acquire(cert); throw new Exception("throwing acquire accepted"); }
            catch (InvalidOperationException error) { Assert(error.Data.Count == 0); }
            cert.Dispose();
            Assert(cert.Releases == 1 && NativeKeyHandleTestInterop.CngFrees == 0);
        });
        foreach (uint spec in new uint[] { 1, 2, 0, 99 })
        {
            foreach (bool free in new[] { false, true })
            {
                Check($"non-CNG spec {spec} rejected; cleanup honors callerFree={free}", () =>
                {
                    NativeKeyHandleTestInterop.Spec = spec; NativeKeyHandleTestInterop.CallerFree = free;
                    var cert = new Certificate(); Throws<CryptographicException>(() => NativeKeyHandle.Acquire(cert)); cert.Dispose();
                    Assert(cert.Releases == 1 && NativeKeyHandleTestInterop.CngFrees == 0 && NativeKeyHandleTestInterop.CapiFrees == (free ? 1 : 0));
                });
            }
        }
        foreach (long invalid in new long[] { 0, -1 })
        {
            Check("invalid successful raw handle " + invalid + " is never freed", () =>
            {
                NativeKeyHandleTestInterop.Raw = new(invalid); using var cert = new Certificate();
                Throws<CryptographicException>(() => NativeKeyHandle.Acquire(cert));
                Assert(NativeKeyHandleTestInterop.CngFrees == 0 && NativeKeyHandleTestInterop.CapiFrees == 0);
            });
        }
        Check("closed/invalid/null certificate is refused before native acquire", () =>
        {
            var closed = new Certificate(); closed.Dispose();
            Throws<ObjectDisposedException>(() => NativeKeyHandle.Acquire(closed));
            using var invalid = new Certificate(true); Throws<ArgumentException>(() => NativeKeyHandle.Acquire(invalid));
            Throws<ArgumentNullException>(() => NativeKeyHandle.Acquire(null!)); Assert(NativeKeyHandleTestInterop.Acquires == 0);
        });
        foreach (bool free in new[] { true, false })
        {
            Check("certificate Dispose during acquisition is retained until handoff free=" + free, () =>
            {
                NativeKeyHandleTestInterop.CallerFree = free; var cert = new Certificate();
                NativeKeyHandleTestInterop.DuringAcquire = () => { cert.Dispose(); Assert(cert.Releases == 0); };
                var key = NativeKeyHandle.Acquire(cert);
                Assert(cert.Releases == (free ? 1 : 0)); key.Dispose(); Assert(cert.Releases == 1);
                Assert(NativeKeyHandleTestInterop.CngFrees == (free ? 1 : 0));
            });
        }
        Check("free status failure is recorded once and is never retried", () =>
        {
            NativeKeyHandleTestInterop.CngStatus = unchecked((int)0x80090026);
            using var cert = new Certificate(); var key = NativeKeyHandle.Acquire(cert);
            key.Dispose(); key.Dispose(); Assert(key.ReleaseStatus == NativeKeyHandleTestInterop.CngStatus && NativeKeyHandleTestInterop.CngFrees == 1);
        });
        Check("every native failure status remains distinct from release pending", () =>
        {
            NativeKeyHandleTestInterop.CngStatus = int.MinValue;
            using var cert = new Certificate(); var key = NativeKeyHandle.Acquire(cert);
            Assert(key.ReleaseStatus is null); key.Dispose(); Assert(key.ReleaseStatus == int.MinValue);
            Assert(NativeKeyHandleTestInterop.CngFrees == 1);
        });
        Check("release exception does not escape finalizer/dispose or trigger retry", () =>
        {
            NativeKeyHandleTestInterop.ThrowFree = true; using var cert = new Certificate(); var key = NativeKeyHandle.Acquire(cert);
            key.Dispose(); key.Dispose(); Assert(key.ReleaseStatus != 0 && key.ReleaseStatus is not null && NativeKeyHandleTestInterop.CngFrees == 1);
        });
        Check("legacy release failure still never uses NCrypt or retries", () =>
        {
            NativeKeyHandleTestInterop.Spec = 1; NativeKeyHandleTestInterop.CapiSuccess = false;
            using var cert = new Certificate(); Throws<CryptographicException>(() => NativeKeyHandle.Acquire(cert));
            Assert(NativeKeyHandleTestInterop.CapiFrees == 1 && NativeKeyHandleTestInterop.CngFrees == 0);
        });
        Check("validation failure after acquire releases in using exactly once", () =>
        {
            using var cert = new Certificate();
            Throws<InvalidOperationException>(() => { using var key = NativeKeyHandle.Acquire(cert); throw new InvalidOperationException("subsequent validation"); });
            Assert(NativeKeyHandleTestInterop.CngFrees == 1);
        });
        Check("concurrent Dispose releases owned key only once", () =>
        {
            using var cert = new Certificate(); var key = NativeKeyHandle.Acquire(cert);
            Parallel.For(0, 128, _ => key.Dispose()); Assert(NativeKeyHandleTestInterop.CngFrees == 1);
        });
        Check("last lease on another thread controls final release", () =>
        {
            using var cert = new Certificate(); var key = NativeKeyHandle.Acquire(cert); var lease = key.Borrow();
            Task.Run(key.Dispose).GetAwaiter().GetResult(); Assert(NativeKeyHandleTestInterop.CngFrees == 0);
            Task.Run(lease.Dispose).GetAwaiter().GetResult(); Assert(NativeKeyHandleTestInterop.CngFrees == 1);
        });
        Check("unreachable owned owner finalized once", () =>
        {
            using var cert = new Certificate(); var weak = Leak(cert, borrow: false);
            Collect(weak); Assert(NativeKeyHandleTestInterop.CngFrees == 1);
        });
        Check("unreachable borrowed owner releases certificate lease but never cached key", () =>
        {
            NativeKeyHandleTestInterop.CallerFree = false; var cert = new Certificate(); var weak = Leak(cert, borrow: true);
            cert.Dispose(); Assert(cert.Releases == 0); Collect(weak);
            Assert(cert.Releases == 1 && NativeKeyHandleTestInterop.CngFrees == 0);
        });
        Check("Dispose rejects NEW leases even while previous lease keeps key alive", () =>
        {
            using var cert = new Certificate(); var key = NativeKeyHandle.Acquire(cert); var old = key.Borrow();
            key.Dispose(); Throws<ObjectDisposedException>(() => key.Borrow());
            Assert(NativeKeyHandleTestInterop.CngFrees == 0);
            old.Dispose(); Assert(NativeKeyHandleTestInterop.CngFrees == 1);
        });
        Check("concurrent borrow/dispose race never uses a released key or double-frees", () =>
        {
            for (int i = 0; i < 64; i++)
            {
                int before = NativeKeyHandleTestInterop.CngFrees;
                using var cert = new Certificate(); var key = NativeKeyHandle.Acquire(cert);
                using var barrier = new Barrier(2);
                var borrow = Task.Run(() => {
                    barrier.SignalAndWait();
                    try
                    {
                        using var lease = key.Borrow();
                        Assert(lease.DangerousGetHandle() == new IntPtr(1234));
                        Assert(Volatile.Read(ref NativeKeyHandleTestInterop.CngFrees) == before);
                    }
                    catch (ObjectDisposedException) { }
                });
                barrier.SignalAndWait(); key.Dispose(); borrow.GetAwaiter().GetResult();
                Assert(NativeKeyHandleTestInterop.CngFrees == before + 1);
            }
        });
        Check("rejected legacy acquire exposes cleanup failure on primary exception", () =>
        {
            NativeKeyHandleTestInterop.Spec = 2; NativeKeyHandleTestInterop.CapiSuccess = false;
            using var cert = new Certificate();
            try { NativeKeyHandle.Acquire(cert); throw new Exception("legacy accepted"); }
            catch (CryptographicException error)
            {
                Assert(error.Message == "ERR_NATIVE_KEY_NOT_CNG");
                Assert((int)error.Data["NativeKeyReleaseStatus"]! == NativeKeyHandleTestInterop.LastError);
            }
            Assert(NativeKeyHandleTestInterop.CapiFrees == 1 && NativeKeyHandleTestInterop.CngFrees == 0);
        });
        Check("failed legacy cleanup with missing error still reports unknown failure", () =>
        {
            NativeKeyHandleTestInterop.Spec = 1; NativeKeyHandleTestInterop.CapiSuccess = false;
            NativeKeyHandleTestInterop.LastError = 0;
            using var cert = new Certificate();
            try { NativeKeyHandle.Acquire(cert); throw new Exception("legacy accepted"); }
            catch (CryptographicException error) { Assert((int)error.Data["NativeKeyReleaseStatus"]! != 0); }
            Assert(NativeKeyHandleTestInterop.CapiFrees == 1 && NativeKeyHandleTestInterop.CngFrees == 0);
        });
        Console.WriteLine($"PASS {passed} ownership groups; native acquisition/.NET CNG bridge NOT EXERCISED"); return 0;
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference Leak(Certificate certificate, bool borrow)
    {
        var key = NativeKeyHandle.Acquire(certificate);
        return new WeakReference(borrow ? (object)key.Borrow() : key);
    }
    private static void Collect(WeakReference weak)
    {
        for (int i = 0; i < 6; i++) { GC.Collect(); GC.WaitForPendingFinalizers(); }
        Assert(!weak.IsAlive);
    }
}
#endif
