using System.Runtime.InteropServices;
using System.Linq;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace PermitWitness.Windows;

// Internal, synchronous file primitives for an isolated durability experiment.
// This is NOT an authority, an authenticated IPC endpoint or a durability
// proof. Program, TLS, certificates, keys and the protected store are not
// connected to it, and every failure stage stays distinguishable from a
// confirmed publication.
internal static class NativePublication
{
    // The handle must carry exactly the access this protocol needs. Measured
    // on Windows 10.0.26300 (NTFS): SetFileInformationByHandle(FileRenameInfo)
    // fails with ERROR_ACCESS_DENIED (5) when DELETE is missing, and succeeds
    // with the mask below. FileRenameInfoEx is not supported on this build
    // (ERROR_INVALID_NAME, 123), so it is not used.
    private const uint FileReadData = 0x00000001;
    private const uint FileWriteData = 0x00000002;
    private const uint FileReadAttributes = 0x00000080;
    private const uint FileWriteAttributes = 0x00000100;
    private const uint DeleteAccess = 0x00010000;
    private const uint Synchronize = 0x00100000;
    private const uint CreateNew = 1;
    private const uint OpenExisting = 3;
    private const uint FileFlagWriteThrough = 0x80000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileShareDelete = 0x00000004;
    private const int FileIdInfo = 18;
    private const int FileRenameInfo = 3;
    private const int ErrorAlreadyExists = 183;
    private const int ErrorAccessDenied = 5;

    internal enum Stage { Open, Write, Flush, Rename, PostRenameFlush, Verified }

    internal sealed class PublicationException : IOException
    {
        internal PublicationException(string code, Stage stage, int nativeError = 0) : base(code)
        { FailureStage = stage; NativeError = nativeError; }
        internal Stage FailureStage { get; }
        internal int NativeError { get; }
    }

    // Publishes a NEW name from an exclusively created temporary file in the
    // same directory. The target is never replaced: an existing target is a
    // conflict, not a success. The caller must still treat the return value
    // as a local stage receipt, not as a full durability confirmation.
    internal static void PublishNew(string temporary, string target, ReadOnlySpan<byte> content)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("ERR_WINDOWS_REQUIRED");
        ValidatePath(temporary);
        ValidatePath(target);
        string temporaryFull = Path.GetFullPath(temporary);
        string targetFull = Path.GetFullPath(target);
        if (string.Equals(temporaryFull, targetFull, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("ERR_PUBLICATION_NAME_CONFLICT");
        if (!string.Equals(Path.GetDirectoryName(temporaryFull), Path.GetDirectoryName(targetFull),
            StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("ERR_PUBLICATION_PARENT_MISMATCH");

        using var file = Open(temporaryFull,
            FileReadData | FileWriteData | FileReadAttributes | FileWriteAttributes | DeleteAccess | Synchronize,
            CreateNew);
        WriteAll(file, content);
        Flush(file, Stage.Flush);
        Rename(file, targetFull);
        Flush(file, Stage.PostRenameFlush);
        VerifyIdentity(file, targetFull);
        // SafeFileHandle disposal has no success result, so this local return
        // deliberately stops short of a `confirmed` receipt.
    }

    // Builds a temporary name for ONE attempt. The temporary name carries no
    // authorization meaning: it must be unique per attempt so a leftover
    // temporary from a failed attempt can never be silently reused or
    // silently deleted, and so the exclusive create never fails because of an
    // unrelated earlier attempt.
    internal static string TemporaryName(string target, string attemptId)
    {
        ArgumentException.ThrowIfNullOrEmpty(target);
        ArgumentException.ThrowIfNullOrEmpty(attemptId);
        string directory = Path.GetDirectoryName(Path.GetFullPath(target)) ?? "";
        string name = Path.GetFileName(Path.GetFullPath(target));
        foreach (char invalid in Path.GetInvalidFileNameChars())
            if (attemptId.Contains(invalid))
                throw new ArgumentException("ERR_PUBLICATION_ATTEMPT_ID_INVALID", nameof(attemptId));
        return Path.Combine(directory, $".{name}.attempt-{attemptId}.tmp");
    }

    internal static string Identity(string path)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("ERR_WINDOWS_REQUIRED");
        ValidatePath(path);
        using var file = Open(Path.GetFullPath(path),
            FileReadData | FileReadAttributes | Synchronize, OpenExisting);
        return FileId(file);
    }

    private static void ValidatePath(string path)
    {
        ArgumentException.ThrowIfNullOrEmpty(path);
        string full = Path.GetFullPath(path);
        if (!Path.IsPathFullyQualified(path) || full.StartsWith(@"\\", StringComparison.Ordinal))
            throw new ArgumentException("ERR_PUBLICATION_PATH_UNSUPPORTED", nameof(path));
    }

    private static SafeFileHandle Open(string path, uint access, uint creation)
    {
        // Sharing is permissive so the post-rename identity check can reopen
        // the published name while the original handle is still open.
        IntPtr raw = Native.CreateFile(path, access, FileShareRead | FileShareWrite | FileShareDelete,
            IntPtr.Zero, creation, FileFlagWriteThrough, IntPtr.Zero);
        if (raw == IntPtr.Zero || raw == new IntPtr(-1))
        {
            // Read the native error immediately: nothing may run between the
            // failed call and this read.
            int error = Marshal.GetLastPInvokeError();
            throw new PublicationException("ERR_PUBLICATION_OPEN", Stage.Open, error);
        }
        return new SafeFileHandle(raw, ownsHandle: true);
    }

    private static void WriteAll(SafeFileHandle file, ReadOnlySpan<byte> content)
    {
        int offset = 0;
        while (offset < content.Length)
        {
            int count = Math.Min(content.Length - offset, 1024 * 1024);
            // A ReadOnlySpan<byte> parameter cannot be marshalled by P/Invoke.
            // Copy the chunk into a managed array before the native call.
            byte[] chunk = content.Slice(offset, count).ToArray();
            if (!Native.WriteFile(file, chunk, (uint)chunk.Length, out uint written, IntPtr.Zero))
                throw new PublicationException("ERR_PUBLICATION_WRITE_UNKNOWN", Stage.Write, Marshal.GetLastPInvokeError());
            if (written == 0 || written > chunk.Length)
                throw new PublicationException("ERR_PUBLICATION_WRITE_UNKNOWN", Stage.Write);
            offset += (int)written;
        }
    }

    private static void Flush(SafeFileHandle file, Stage stage)
    {
        if (!Native.FlushFileBuffers(file))
            throw new PublicationException("ERR_PUBLICATION_FLUSH_UNKNOWN", stage, Marshal.GetLastPInvokeError());
    }

    private static void Rename(SafeFileHandle file, string target)
    {
        // FILE_RENAME_INFO (winbase.h):
        //   union { BOOLEAN ReplaceIfExists; DWORD Flags; }  -> 4 bytes at +0
        //   HANDLE RootDirectory                              -> +8 on x64
        //   DWORD FileNameLength                              -> +16 on x64
        //   WCHAR FileName[]                                  -> +20 on x64
        // The offsets are NOT the 32-bit layout (4/8/12): on x64 the HANDLE is
        // 8-byte aligned, so RootDirectory starts at +8. Using the 32-bit
        // offsets made the kernel read FileNameLength as the RootDirectory
        // handle and fail with ERROR_INVALID_HANDLE. The offsets are taken
        // from the declared struct so the runtime resolves the real layout.
        int fileNameOffset = Marshal.OffsetOf<Native.RenameInfo>(nameof(Native.RenameInfo.FileName)).ToInt32();
        int lengthOffset = Marshal.OffsetOf<Native.RenameInfo>(nameof(Native.RenameInfo.FileNameLength)).ToInt32();
        int rootOffset = Marshal.OffsetOf<Native.RenameInfo>(nameof(Native.RenameInfo.RootDirectory)).ToInt32();
        const int flagsOffset = 0;
        byte[] name = Encoding.Unicode.GetBytes(target);
        // FileName is a variable-length wide-character field and the kernel
        // reads it as a NUL-terminated string. A buffer that ends exactly at
        // the last character makes the kernel read past the allocation and
        // append unrelated heap bytes to the target name. Measured on
        // Windows 10.0.26300: without the terminator the rename of
        // "...entry.json" produced "...entry.jsonDLL", so the publication
        // silently landed on an unrequested name. The terminator is part of
        // the buffer and of the size passed to the kernel.
        int size = checked(fileNameOffset + name.Length + 2);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            for (int index = 0; index < size; index++) Marshal.WriteByte(buffer, index, 0);
            // ReplaceIfExists stays false: an existing target is a conflict.
            Marshal.WriteInt32(buffer, flagsOffset, 0);
            Marshal.WriteIntPtr(buffer, rootOffset, IntPtr.Zero);
            Marshal.WriteInt32(buffer, lengthOffset, name.Length);
            Marshal.Copy(name, 0, IntPtr.Add(buffer, fileNameOffset), name.Length);
            // The terminator is already zero because the whole buffer was
            // cleared above; writing it explicitly keeps the intent visible.
            Marshal.WriteInt16(buffer, fileNameOffset + name.Length, 0);
            if (!Native.SetFileInformationByHandle(file, FileRenameInfo, buffer, (uint)size))
            {
                int error = Marshal.GetLastPInvokeError();
                // ERROR_ALREADY_EXISTS (183) is the expected outcome when the
                // target name is already taken: ReplaceIfExists stays false,
                // so the existing entry is never replaced. It is a conflict,
                // not an unknown failure.
                if (error == ErrorAlreadyExists)
                    throw new PublicationException("ERR_PUBLICATION_TARGET_EXISTS", Stage.Rename, error);
                // ERROR_ACCESS_DENIED (5) is the measured result when the
                // handle lacks DELETE access.
                if (error == ErrorAccessDenied)
                    throw new PublicationException("ERR_PUBLICATION_RENAME_DENIED", Stage.Rename, error);
                // Any other code stays distinguishable so the platform matrix
                // can tell a sharing or path error apart from a conflict.
                throw new PublicationException("ERR_PUBLICATION_RENAME_UNKNOWN", Stage.Rename, error);
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static void VerifyIdentity(SafeFileHandle file, string target)
    {
        if (!File.Exists(target))
        {
            // The rename reported success but the expected name is absent.
            // This happens when the kernel resolved a different name than the
            // one that was requested. The directory listing is part of the
            // failure detail so the actual destination is visible in the
            // evidence instead of being silently discarded.
            string directory = Path.GetDirectoryName(target) ?? "";
            string actual = "<unavailable>";
            try
            {
                string[] names = Directory.GetFileSystemEntries(directory);
                actual = string.Join(",", names.Select(Path.GetFileName));
            }
            catch (Exception error) { actual = "<" + error.GetType().Name + ">"; }
            throw new PublicationException("ERR_PUBLICATION_NAME_UNRESOLVED:" + actual, Stage.Verified);
        }
        using var named = Open(target, FileReadData | FileReadAttributes | Synchronize, OpenExisting);
        if (!string.Equals(FileId(file), FileId(named), StringComparison.Ordinal))
            throw new PublicationException("ERR_PUBLICATION_IDENTITY", Stage.Verified);
    }

    private static string FileId(SafeFileHandle file)
    {
        if (!Native.GetFileInformationByHandleEx(file, FileIdInfo, out Native.FileIdInfo info,
            (uint)Marshal.SizeOf<Native.FileIdInfo>()))
            throw new PublicationException("ERR_PUBLICATION_IDENTITY", Stage.Verified, Marshal.GetLastPInvokeError());
        return $"{info.VolumeSerialNumber:X16}:{info.FileIdHigh:X16}{info.FileIdLow:X16}";
    }

    private static class Native
    {
        // FILE_ID_INFO: ULONGLONG VolumeSerialNumber plus a 128-bit FILE_ID_128.
        [StructLayout(LayoutKind.Sequential)]
        internal struct FileIdInfo
        {
            internal ulong VolumeSerialNumber;
            internal ulong FileIdHigh;
            internal ulong FileIdLow;
        }

        // FILE_RENAME_INFO. The union is declared as a 4-byte Flags field so
        // the following HANDLE keeps its natural 8-byte alignment on x64.
        // Writing Flags = 0 leaves ReplaceIfExists false.
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct RenameInfo
        {
            internal uint Flags;
            internal IntPtr RootDirectory;
            internal uint FileNameLength;
            internal char FileName;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateFile([MarshalAs(UnmanagedType.LPWStr)] string name, uint access, uint share, IntPtr security,
            uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool WriteFile(SafeFileHandle file, byte[] buffer, uint bytes,
            out uint written, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool FlushFileBuffers(SafeFileHandle file);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int infoClass,
            out FileIdInfo info, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetFileInformationByHandle(SafeFileHandle file, int infoClass,
            IntPtr info, uint size);
    }
}
