using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace PermitWitness.PublicationEvidence;

// Diagnostic-only native probe used by the platform matrix. It is NOT part
// of the publication primitive and never touches a real target.
internal static class NativeProbe
{
    internal const uint CreateNew = 1;
    internal const uint OpenExisting = 3;
    internal const uint FileFlagWriteThrough = 0x80000000;
    internal const int FileRenameInfo = 3;
    internal const int FileRenameInfoEx = 22;

    internal static SafeFileHandle Open(string path, uint access, uint creation)
    {
        return OpenWithShare(path, access, creation, 0x00000007);
    }

    internal static SafeFileHandle OpenWithShare(string path, uint access, uint creation, uint share)
    {
        IntPtr raw = CreateFile(path, access, share, IntPtr.Zero, creation, FileFlagWriteThrough, IntPtr.Zero);
        if (raw == IntPtr.Zero || raw == new IntPtr(-1))
            throw new IOException("CreateFile failed: " + Marshal.GetLastPInvokeError());
        return new SafeFileHandle(raw, ownsHandle: true);
    }

    internal static SafeFileHandle OpenDirectory(string path)
    {
        const uint fileFlagBackupSemantics = 0x02000000;
        IntPtr raw = CreateFile(path, 0x00000001 | 0x00000080 | 0x00010000, 0x00000007, IntPtr.Zero,
            OpenExisting, fileFlagBackupSemantics, IntPtr.Zero);
        if (raw == IntPtr.Zero || raw == new IntPtr(-1))
            throw new IOException("CreateFile(directory) failed: " + Marshal.GetLastPInvokeError());
        return new SafeFileHandle(raw, ownsHandle: true);
    }

    // FILE_RENAME_INFO with RootDirectory bound to the verified parent and
    // only the final name in FileName.
    internal static void RenameInDirectory(SafeFileHandle file, SafeFileHandle directory, string name)
    {
        byte[] encoded = Encoding.Unicode.GetBytes(name);
        int fileNameOffset = Marshal.OffsetOf<RenameInfo>(nameof(RenameInfo.FileName)).ToInt32();
        int lengthOffset = Marshal.OffsetOf<RenameInfo>(nameof(RenameInfo.FileNameLength)).ToInt32();
        int rootOffset = Marshal.OffsetOf<RenameInfo>(nameof(RenameInfo.RootDirectory)).ToInt32();
        // The FileName field is a NUL-terminated wide string. Without the
        // terminator the kernel reads past the buffer and renames to a name
        // with unrelated trailing bytes appended, so the destination does
        // not appear even though the call reported success.
        int size = fileNameOffset + encoded.Length + 2;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            for (int index = 0; index < size; index++) Marshal.WriteByte(buffer, index, 0);
            Marshal.WriteIntPtr(buffer, rootOffset, directory.DangerousGetHandle());
            Marshal.WriteInt32(buffer, lengthOffset, encoded.Length);
            Marshal.Copy(encoded, 0, IntPtr.Add(buffer, fileNameOffset), encoded.Length);
            if (!SetFileInformationByHandle(file, FileRenameInfo, buffer, (uint)size))
                throw new IOException("SetFileInformationByHandle(rooted) failed: " + Marshal.GetLastPInvokeError());
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }


    internal static void Rename(SafeFileHandle file, string target, int infoClass)
    {
        byte[] name = Encoding.Unicode.GetBytes(target);
        int fileNameOffset = Marshal.OffsetOf<RenameInfo>(nameof(RenameInfo.FileName)).ToInt32();
        int lengthOffset = Marshal.OffsetOf<RenameInfo>(nameof(RenameInfo.FileNameLength)).ToInt32();
        int size = fileNameOffset + name.Length + 2;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            for (int index = 0; index < size; index++) Marshal.WriteByte(buffer, index, 0);
            Marshal.WriteInt32(buffer, lengthOffset, name.Length);
            Marshal.Copy(name, 0, IntPtr.Add(buffer, fileNameOffset), name.Length);
            if (!SetFileInformationByHandle(file, infoClass, buffer, (uint)size))
                throw new IOException("SetFileInformationByHandle failed: " + Marshal.GetLastPInvokeError());
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    // FILE_RENAME_INFO_EX layout (winbase.h):
    //   +0  union { DWORD Flags; DWORD ReplaceIfExists; }
    //   +4  HANDLE RootDirectory
    //   +8  DWORD FileNameLength
    //   +12 DWORD Flags (extended)
    //   +16 WCHAR FileName[]
    internal static void RenameEx(SafeFileHandle file, string target)
    {
        byte[] name = Encoding.Unicode.GetBytes(target);
        int fileNameOffset = Marshal.OffsetOf<RenameInfoEx>(nameof(RenameInfoEx.FileName)).ToInt32();
        int lengthOffset = Marshal.OffsetOf<RenameInfoEx>(nameof(RenameInfoEx.FileNameLength)).ToInt32();
        int size = fileNameOffset + name.Length + 2;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            for (int index = 0; index < size; index++) Marshal.WriteByte(buffer, index, 0);
            Marshal.WriteInt32(buffer, lengthOffset, name.Length);
            Marshal.Copy(name, 0, IntPtr.Add(buffer, fileNameOffset), name.Length);
            if (!SetFileInformationByHandle(file, FileRenameInfoEx, buffer, (uint)size))
                throw new IOException("SetFileInformationByHandle(Ex) failed: " + Marshal.GetLastPInvokeError());
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security,
        uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle file, int infoClass, IntPtr info, uint size);

    // FILE_RENAME_INFO: the 4-byte flag union at +0 keeps the following
    // HANDLE 8-byte aligned on x64, so RootDirectory is at +8, FileNameLength
    // at +16 and FileName at +20.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct RenameInfo
    {
        internal uint Flags;
        internal IntPtr RootDirectory;
        internal uint FileNameLength;
        internal char FileName;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct RenameInfoEx
    {
        internal uint Flags;
        internal IntPtr RootDirectory;
        internal uint FileNameLength;
        internal uint FlagsEx;
        internal char FileName;
    }
}
