using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace PermitWitness.Windows;

// Owns ONE successful CryptAcquireCertificatePrivateKey result, not an identity
// or authorization. Acquire requires an authentic certificate-context SafeHandle
// from the future trusted composition root, NOT a pointer from request data.
// No certificate/key creation, property healing, key lookup by name or Load hook.
internal sealed class NativeKeyHandle : SafeHandle
{
    internal const uint NcryptKeySpec = uint.MaxValue;
    internal const uint AcquireFlags = 0x00040000 | 0x00000040 | 0x00000004 | 0x00000008;
    // ONLY_NCRYPT | SILENT | COMPARE_KEY | NO_HEALING; no CACHE or USE_PROV_INFO.
    // Windows can still return callerFree=false: honor the actual output.
    // COMPARE_KEY does NOT compare when Windows returns a cached handle.
    // These flags/acquisition success do not prove certificate public-key match;
    // the future trusted root must separately verify that binding before use.
    private const int ReleaseUnknown = unchecked((int)0x80090020); // NTE_FAIL
    private SafeHandle? certificateContext;
    private bool callerFree;
    private uint keySpec;
    private int releaseStatus;
    private int releaseCompleted;
    private int closing;
    private NativeKeyHandle() : base(IntPtr.Zero, ownsHandle: true) { }
    public override bool IsInvalid => handle == IntPtr.Zero || handle == new IntPtr(-1);
    internal bool OwnsNativeKey => callerFree;
    // Release failure is observable after the LAST lease closes, not just after
    // Dispose requests closure. No retry: a failed native free may be uncertain.
    internal int? ReleaseStatus
    {
        get { return Volatile.Read(ref releaseCompleted) == 0 ? null : releaseStatus; }
    }

    internal static NativeKeyHandle Acquire(SafeHandle certificateContext)
    {
#if !NATIVE_KEY_HANDLE_TESTING
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("ERR_WINDOWS_REQUIRED");
#endif
        ArgumentNullException.ThrowIfNull(certificateContext);
        // Allocate the owner before asking Windows for a resource. Failure
        // outputs have no ownership contract and are NEVER adopted/freed.
        var result = new NativeKeyHandle();
        bool retained = false, transferred = false;
        Exception? failure = null;
        try
        {
            certificateContext.DangerousAddRef(ref retained);
            if (certificateContext.IsInvalid) throw new ArgumentException("ERR_CERT_CONTEXT_INVALID", nameof(certificateContext));
            if (!Native.Acquire(certificateContext.DangerousGetHandle(), AcquireFlags, IntPtr.Zero,
                out IntPtr raw, out uint spec, out bool free))
            {
                int acquireError = Marshal.GetLastPInvokeError();
                // Capture FIRST: no allocation, logging, cleanup or other call
                // between the failed P/Invoke and its thread-local error read.
                // Keep the wire-facing error stable. Only trusted diagnostics
                // may read this numeric code; never serialize exception Data.
                var error = new CryptographicException("ERR_NATIVE_KEY_ACQUIRE");
                error.Data["NativeKeyAcquireError"] = acquireError;
                throw error;
            }
            if (raw == IntPtr.Zero || raw == new IntPtr(-1)) throw new CryptographicException("ERR_NATIVE_KEY_INVALID");
            result.keySpec = spec;
            result.callerFree = free;
            result.SetHandle(raw);
            if (!free)
            {
                // The ORIGINAL certificate context (not a duplicate) owns a
                // cached key until its last release. Retain the actual parent.
                result.certificateContext = certificateContext;
                retained = false; // lease transferred into result
            }
            // Even with ONLY_NCRYPT verify keySpec. A successful legacy result
            // is rejected and, if owned, freed with CryptReleaseContext, NEVER
            // NCryptFreeObject. That path is cleanup only, not CAPI support.
            if (spec != NcryptKeySpec) throw new CryptographicException("ERR_NATIVE_KEY_NOT_CNG");
            transferred = true;
            return result;
        }
        catch (Exception error) { failure = error; throw; }
        finally
        {
            if (!transferred) result.Dispose();
            if (retained) certificateContext.DangerousRelease();
            if (failure is not null && result.ReleaseStatus is int status && status != 0)
                failure.Data["NativeKeyReleaseStatus"] = status; // retain primary failure, no raw handles
        }
    }

    // A typed lease can be passed to a future NCrypt P/Invoke as a SafeHandle.
    // Its Dispose releases a reference only, never the raw key. Native callers
    // MUST NOT cache DangerousGetHandle outside a lease or free it themselves.
    internal KeyLease Borrow() => new(this);
    internal sealed class KeyLease : SafeHandle
    {
        private readonly NativeKeyHandle owner;
        internal KeyLease(NativeKeyHandle owner) : base(IntPtr.Zero, ownsHandle: true)
        {
            this.owner = owner;
            bool retained = false;
            try
            {
                if (Volatile.Read(ref owner.closing) != 0) throw new ObjectDisposedException(nameof(NativeKeyHandle));
                owner.DangerousAddRef(ref retained);
                if (Volatile.Read(ref owner.closing) != 0 || owner.IsInvalid) throw new ObjectDisposedException(nameof(NativeKeyHandle));
                SetHandle(owner.DangerousGetHandle());
                retained = false;
            }
            finally { if (retained) owner.DangerousRelease(); }
        }
        public override bool IsInvalid => handle == IntPtr.Zero || handle == new IntPtr(-1);
        protected override bool ReleaseHandle() { owner.DangerousRelease(); return true; }
    }

    // The documented parent constructor does NOT own/free the child raw key:
    // it DangerousAddRefs this real owner, then DangerousReleases it on close.
    // This is not a dummy provider handle or null-forgiving-parent workaround.
    // Windows bridge is compile checked, NOT executed by macOS unit tests.
    // Acquire/free must NOT run on the SCM StartService callback path: Windows
    // documents a possible NCryptFreeObject deadlock there; caller controls that
    // service lifecycle constraint, not this resource wrapper.
    [SupportedOSPlatform("windows")]
    internal SafeNCryptKeyHandle CreateCngView()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("ERR_WINDOWS_REQUIRED");
        // Hold a temporary lease against Dispose between reading raw and the
        // .NET constructor acquiring its own reference to this owner.
        using var lease = Borrow();
        return new SafeNCryptKeyHandle(lease.DangerousGetHandle(), this);
    }

    protected override void Dispose(bool disposing)
    {
        Volatile.Write(ref closing, 1); // stop NEW leases even if old references delay release
        base.Dispose(disposing);
    }

    protected override bool ReleaseHandle()
    {
        int status = 0;
        try
        {
            if (callerFree)
            {
                if (keySpec == NcryptKeySpec) status = Native.FreeCng(handle);
                else if (!Native.FreeCapi(handle, 0))
                {
                    status = Native.LastError();
                    if (status == 0) status = ReleaseUnknown; // false must never report success
                }
            }
            // Borrowed key: never free. Dropping its certificate lease permits
            // the certificate owner/Windows cache to perform the eventual free.
        }
        catch { status = ReleaseUnknown; } // SafeHandle finalizer must not throw.
        finally
        {
            try { certificateContext?.DangerousRelease(); }
            catch { status = ReleaseUnknown; }
            certificateContext = null;
            releaseStatus = status;
            Volatile.Write(ref releaseCompleted, 1);
        }
        return status == 0;
    }

    private static class Native
    {
#if NATIVE_KEY_HANDLE_TESTING
        // Build-time unit-test seam only. No delegate/provider/caller callback
        // exists in the shipped implementation. Tests execute the same owner,
        // lease, branching, cleanup and SafeHandle code against synthetic IDs.
        internal static bool Acquire(IntPtr certificate, uint flags, IntPtr reserved, out IntPtr key, out uint spec, out bool free)
            => NativeKeyHandleTestInterop.Acquire(certificate, flags, reserved, out key, out spec, out free);
        internal static int FreeCng(IntPtr key) => NativeKeyHandleTestInterop.FreeCng(key);
        internal static bool FreeCapi(IntPtr key, uint flags) => NativeKeyHandleTestInterop.FreeCapi(key, flags);
        internal static int LastError() => NativeKeyHandleTestInterop.LastError;
#else
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [DllImport("crypt32.dll", EntryPoint = "CryptAcquireCertificatePrivateKey", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool Acquire(IntPtr certificate, uint flags, IntPtr reserved, out IntPtr key,
            out uint spec, [MarshalAs(UnmanagedType.Bool)] out bool free);
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [DllImport("ncrypt.dll", EntryPoint = "NCryptFreeObject")]
        internal static extern int FreeCng(IntPtr key);
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [DllImport("advapi32.dll", EntryPoint = "CryptReleaseContext", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool FreeCapi(IntPtr key, uint flags);
        internal static int LastError() => Marshal.GetLastPInvokeError();
#endif
    }
}
