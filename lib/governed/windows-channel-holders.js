"use strict";

// ─── Windows Channel Holders (M-053 / MS-008 第 9 环) ────────────────────
//
// Enumerate the processes that hold a supervised child's IPC channel on
// Windows. This is the third of the three identity facts, and the one that
// has no portable equivalent at all.
//
// THE MECHANISM
//   cortex's Linux implementation reads the child's fd-3 socket INODE from
//   /proc, then scans every socket on the machine for a holder of that same
//   inode. The inode is the object's GLOBAL identity: two processes holding
//   the same inode are holding the SAME object.
//
//   Windows has the same thing, and it is even more direct:
//   SYSTEM_HANDLE_TABLE_ENTRY.Object is a pointer to the KERNEL OBJECT
//   itself. Two processes holding the same kernel object have the SAME
//   Object pointer — that pointer IS the identity. So the Windows
//   equivalent of "read the inode, then find every other process whose
//   inode equals it" is:
//
//     1. read the target's Object pointer for the channel handle
//     2. scan every other process's handle table for the SAME Object pointer
//
//   The second step needs no name resolution: an anonymous pipe's name is
//   empty, so name-based matching would be useless for exactly the case that
//   matters. The Object pointer works for anonymous pipes.
//
// LAYOUT IS MEASURED, NOT ASSUMED
//   The buffer returned by NtQuerySystemInformation has no public layout
//   guarantee, and the record size has changed between Windows releases.
//   Hard-coding a struct offset is how a probe reports "enumeration is
//   impossible" when it merely read the wrong bytes. So the layout is
//   MEASURED: a grid of (offset x stride) candidates is scored by how many
//   records look like real handle records, and the field positions INSIDE a
//   record (Object / pid / handle value) are detected by majority vote over
//   the whole table rather than assumed.
//
// WHY THE SOURCE ARRIVES ON STDIN
//   The helper reads process handle tables. Its source describes exactly how
//   to do that, and it must not be readable by a same-account process. It is
//   piped to `Add-Type` on STDIN and compiled in memory: zero bytes on disk.

const { runPowerShellWithStdin } = require("./windows-identity-facts");

// The PowerShell driver. It reads the C# source from STDIN, compiles it in
// memory, and calls the helper's static entry point.
const HOLDER_DRIVER_SOURCE = [
  "$ErrorActionPreference = 'Stop'",
  "$source = [Console]::In.ReadToEnd()",
  "if ([string]::IsNullOrWhiteSpace($source)) { Write-Output 'HOLDERS=FAILED:empty-source'; exit 0 }",
  "Add-Type -TypeDefinition $source -Language CSharp",
  "$childPid = [int]$args[0]",
  "$parentPid = [int]$args[1]",
  "[CortexWindowsChannelHolders]::Enumerate($childPid, $parentPid)",
].join("; ");

// The driver for the BOUND enumeration. It carries the pipe name and the
// end selector in addition to the two pids.
const BOUND_DRIVER_SOURCE = [
  "$ErrorActionPreference = 'Stop'",
  "$source = [Console]::In.ReadToEnd()",
  "if ([string]::IsNullOrWhiteSpace($source)) { Write-Output 'HOLDERS=FAILED:empty-source'; exit 0 }",
  "Add-Type -TypeDefinition $source -Language CSharp",
  "$childPid = [int]$args[0]",
  "$parentPid = [int]$args[1]",
  "$pipeName = [string]$args[2]",
  "$mode = [string]$args[3]",
  "[CortexWindowsChannelHolders]::EnumerateBound($childPid, $parentPid, $pipeName, $mode)",
].join("; ");

// The inlined C# helper. It is the same algorithm the Windows feasibility
// probe used on the real machine, with `Main` replaced by a callable entry
// point so `Add-Type` can host it.
const HOLDER_HELPER_SOURCE = `
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class CortexWindowsChannelHolders
{
    [DllImport("ntdll.dll")]
    private static extern int NtQuerySystemInformation(int c, IntPtr p, int l, out int r);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryObject(IntPtr handle, int infoClass, IntPtr buf, int len, out int retLen);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint access, bool inherit, uint options);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint clientProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint serverProcessId);

    private const int SystemHandleInformation = 64;
    private const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);
    private const int ObjectNameInformation = 1;
    private const int ObjectTypeInformation = 2;
    private const uint ProcessDupHandle = 0x0040;
    private const uint DuplicateSameAccess = 0x00000002;

    public static string Enumerate(int childPid, int parentPid)
    {
        var report = new StringBuilder();
        if (childPid <= 0)
        {
            report.AppendLine("HOLDERS=FAILED:bad-pid");
            return report.ToString();
        }

        int length = 1 << 22;
        IntPtr buffer = Marshal.AllocHGlobal(length);
        int needed;
        int status = NtQuerySystemInformation(SystemHandleInformation, buffer, length, out needed);

        // STATUS_INFO_LENGTH_MISMATCH is not a failure: the kernel reports the
        // size the table actually needs. A busy machine has hundreds of
        // thousands of open handles. Giving up here would read as
        // "enumeration is impossible" when it is merely "the buffer was too
        // small" — a fail-open conclusion drawn from a fixable error.
        for (int attempt = 0; attempt < 5 && status == StatusInfoLengthMismatch; attempt++)
        {
            Marshal.FreeHGlobal(buffer);
            length = needed + (1 << 22);
            buffer = Marshal.AllocHGlobal(length);
            status = NtQuerySystemInformation(SystemHandleInformation, buffer, length, out needed);
        }

        if (status != 0)
        {
            Marshal.FreeHGlobal(buffer);
            report.AppendLine("HOLDERS=FAILED:ntqsistatus-" + status.ToString("X8"));
            return report.ToString();
        }

        int count = Marshal.ReadInt32(buffer);
        Layout layout = DetectLayout(buffer, count, needed, childPid);
        if (layout == null)
        {
            Marshal.FreeHGlobal(buffer);
            report.AppendLine("HOLDERS=FAILED:layout-undetermined");
            return report.ToString();
        }

        IntPtr table = IntPtr.Add(buffer, layout.Offset);

        // -- pass 1: the child's kernel objects ----------------------------
        Dictionary<long, long> childObjects = new Dictionary<long, long>();
        for (int i = 0; i < count; i++)
        {
            try
            {
                IntPtr entry = IntPtr.Add(table, i * layout.Stride);
                int ownerPid = ReadPid(entry, layout);
                if (ownerPid != childPid) continue;
                long objectPointer = ReadObject(entry, layout);
                if (objectPointer != 0 && !childObjects.ContainsKey(objectPointer))
                {
                    childObjects[objectPointer] = ReadHandleValue(entry, layout);
                }
            }
            catch (Exception)
            {
                // One bad record must not abort the inventory.
            }
        }

        // -- pass 2: every OTHER process holding one of those objects ------
        Dictionary<long, List<int>> objectHolders = new Dictionary<long, List<int>>();
        foreach (long key in childObjects.Keys)
        {
            objectHolders[key] = new List<int>();
        }

        for (int i = 0; i < count; i++)
        {
            try
            {
                IntPtr entry = IntPtr.Add(table, i * layout.Stride);
                int ownerPid = ReadPid(entry, layout);
                long objectPointer = ReadObject(entry, layout);
                List<int> holders;
                if (!objectHolders.TryGetValue(objectPointer, out holders)) continue;
                if (!holders.Contains(ownerPid)) holders.Add(ownerPid);
            }
            catch (Exception)
            {
                // Same as above.
            }
        }

        // -- pass 3: which shared object is the IPC channel? --------------
        //
        // Parent and child share many kernel objects (the current directory,
        // a mutex, the console, mapped image sections). The channel is the
        // one whose kernel type is File. Without this step the result would
        // only prove "something is shared", which is not the fact needed.
        var channelObjects = new List<string>();
        if (parentPid > 0)
        {
            IntPtr processHandle = OpenProcess(ProcessDupHandle, false, childPid);
            if (processHandle != IntPtr.Zero)
            {
                foreach (KeyValuePair<long, List<int>> pair in objectHolders)
                {
                    List<int> holders = pair.Value;
                    if (!holders.Contains(parentPid) || !holders.Contains(childPid)) continue;
                    if (!childObjects.ContainsKey(pair.Key)) continue;

                    string typeName = "(unresolved)";
                    IntPtr duplicated;
                    if (DuplicateHandle(processHandle, new IntPtr(childObjects[pair.Key]), GetCurrentProcess(), out duplicated, 0, false, DuplicateSameAccess))
                    {
                        typeName = QueryTypeName(duplicated);
                        CloseHandle(duplicated);
                    }

                    if (typeName != null && typeName.ToLower().Contains("file"))
                    {
                        channelObjects.Add("0x" + pair.Key.ToString("X") + ":" + JoinPids(holders));
                    }
                }
                CloseHandle(processHandle);
            }
        }

        Marshal.FreeHGlobal(buffer);

        if (channelObjects.Count == 0)
        {
            report.AppendLine("HOLDERS=FAILED:no-channel-object");
            return report.ToString();
        }

        var pids = new SortedSet<int>();
        foreach (string entry in channelObjects)
        {
            int colon = entry.IndexOf(':');
            string pidPart = entry.Substring(colon + 1);
            foreach (string piece in pidPart.Split(','))
            {
                int parsed;
                if (int.TryParse(piece, out parsed)) pids.Add(parsed);
            }
        }

        report.AppendLine("HOLDERS=OK");
        report.AppendLine("HOLDER_PIDS=" + JoinPids(new List<int>(pids)));
        return report.ToString();
    }

    // ── the BOUND enumeration ────────────────────────────────────────
    //
    // The enumeration above identifies the channel by intersecting the
    // coordinator's and the child's kernel objects and keeping the ones
    // whose type contains "File". On the real machine that matches every
    // INHERITED handle — stdout, stderr, the secret pipe, the console —
    // each with a third holder, so the audit reports a transfer for a
    // clean session.
    //
    // This one binds to ONE object: the pipe instance the coordinator
    // created and the child connected to by name. Three conditions are
    // taken TOGETHER, none of which is sufficient alone:
    //
    //   1. the FULL generated pipe name, compared EXACTLY on the final
    //      segment (a suffix match would let a decoy satisfy the filter);
    //   2. the ROLE, decided by the peer-pid APIs — a server end knows its
    //      client, a client end knows its server;
    //   3. the CONNECTION STATE — a server end with a client is connected
    //      and carries messages; a server end without one is a listener
    //      instance that carries none.
    //
    // Measured on the real machine (2026-11-04): the coordinator holds
    // FIVE objects with the pipe's name and exactly ONE of them is the
    // connected server end, so the filter does real work.
    //
    // The two ends are DIFFERENT kernel objects, so their holder sets are
    // never merged: the server's holder set cannot see a transfer of the
    // client end, and the client's holder set is audited on its own.
    public static string EnumerateBound(int childPid, int parentPid, string pipeName, string mode)
    {
        var report = new StringBuilder();
        if (childPid <= 0)
        {
            report.AppendLine("HOLDERS=FAILED:bad-pid");
            return report.ToString();
        }
        if (string.IsNullOrEmpty(pipeName))
        {
            report.AppendLine("HOLDERS=FAILED:no-pipe-name");
            return report.ToString();
        }
        bool clientMode = string.Equals(mode, "client", StringComparison.Ordinal);
        int ownerPid = clientMode ? childPid : parentPid;

        int length = 1 << 22;
        IntPtr buffer = Marshal.AllocHGlobal(length);
        int needed;
        int status = NtQuerySystemInformation(SystemHandleInformation, buffer, length, out needed);
        for (int attempt = 0; attempt < 5 && status == StatusInfoLengthMismatch; attempt++)
        {
            Marshal.FreeHGlobal(buffer);
            length = needed + (1 << 22);
            buffer = Marshal.AllocHGlobal(length);
            status = NtQuerySystemInformation(SystemHandleInformation, buffer, length, out needed);
        }
        if (status != 0)
        {
            Marshal.FreeHGlobal(buffer);
            report.AppendLine("HOLDERS=FAILED:ntqsistatus-" + status.ToString("X8"));
            return report.ToString();
        }

        int count = Marshal.ReadInt32(buffer);
        Layout layout = DetectLayout(buffer, count, needed, ownerPid);
        if (layout == null)
        {
            Marshal.FreeHGlobal(buffer);
            report.AppendLine("HOLDERS=FAILED:layout-undetermined");
            return report.ToString();
        }

        IntPtr table = IntPtr.Add(buffer, layout.Offset);

        // -- pass 1: every kernel object and its holder set ----------------
        Dictionary<long, HashSet<int>> allHolders = new Dictionary<long, HashSet<int>>();
        Dictionary<long, List<long>> ownerHandles = new Dictionary<long, List<long>>();
        for (int i = 0; i < count; i++)
        {
            try
            {
                IntPtr entry = IntPtr.Add(table, i * layout.Stride);
                int entryPid = ReadPid(entry, layout);
                long objectPointer = ReadObject(entry, layout);
                long handleValue = ReadHandleValue(entry, layout);
                if (objectPointer == 0) continue;

                HashSet<int> holderSet;
                if (!allHolders.TryGetValue(objectPointer, out holderSet))
                {
                    holderSet = new HashSet<int>();
                    allHolders[objectPointer] = holderSet;
                }
                holderSet.Add(entryPid);

                if (entryPid == ownerPid)
                {
                    List<long> handleList;
                    if (!ownerHandles.TryGetValue(objectPointer, out handleList))
                    {
                        handleList = new List<long>();
                        ownerHandles[objectPointer] = handleList;
                    }
                    handleList.Add(handleValue);
                }
            }
            catch (Exception)
            {
                // One bad record must not abort the inventory.
            }
        }

        // -- pass 2: classify the owner's objects -------------------------
        IntPtr ownerProcess = OpenProcess(ProcessDupHandle, false, ownerPid);
        if (ownerProcess == IntPtr.Zero)
        {
            Marshal.FreeHGlobal(buffer);
            report.AppendLine("HOLDERS=FAILED:open-process");
            return report.ToString();
        }

        int nameMatches = 0;
        int roleMatches = 0;
        int connectedMatches = 0;
        int peerIsChild = 0;
        int peerOther = 0;
        int holderSets = 0;
        int holderSetsClean = 0;
        int holderSetsWithThirdParty = 0;
        // The peer-pid APIs only answer on the end they belong to, so the
        // raw outcome is reported instead of being folded into a verdict:
        // a client end has no client, and a server end knows both.
        int matchHasClient = 0;
        int matchHasServer = 0;
        int firstClientPid = 0;
        int firstServerPid = 0;
        var holderPids = new SortedSet<int>();

        foreach (KeyValuePair<long, List<long>> pair in ownerHandles)
        {
            IntPtr duplicated;
            if (!DuplicateHandle(ownerProcess, new IntPtr(pair.Value[0]), GetCurrentProcess(), out duplicated, 0, false, DuplicateSameAccess))
            {
                continue;
            }
            try
            {
                string typeName = QueryTypeName(duplicated);
                if (typeName == null || typeName.ToLower().Contains("file") == false) continue;
                string objectName = QueryUnicodeString(duplicated, ObjectNameInformation);
                if (objectName == null || objectName.Length == 0) continue;
                if (!NamesMatch(objectName, pipeName)) continue;
                nameMatches++;

                uint clientPid = 0;
                uint serverPid = 0;
                bool hasClient = GetNamedPipeClientProcessId(duplicated, out clientPid);
                bool hasServer = GetNamedPipeServerProcessId(duplicated, out serverPid);
                if (hasClient) { matchHasClient++; if (firstClientPid == 0) firstClientPid = (int)clientPid; }
                if (hasServer) { matchHasServer++; if (firstServerPid == 0) firstServerPid = (int)serverPid; }

                // THE ROLE comes from the peer-pid APIs. GetNamedPipeInfo's
                // return value only answers "is this a pipe at all" and is
                // NOT a role test.
                //
                // MEASURED on the real machine (2026-11-04): BOTH APIs
                // answer on BOTH ends. A client end reports clientPid =
                // its OWN holder and serverPid = the server's pid; a server
                // end reports clientPid = the connected client and serverPid
                // = its OWN holder. So the pair (clientPid, serverPid)
                // identifies the CONNECTION, and which END this is follows
                // from WHO HOLDS THE HANDLE: the holder is the server when
                // serverPid == ownerPid, and the client when clientPid ==
                // ownerPid. Testing the peer's pid instead (the first
                // version of this code) matches the server end and can
                // never match the client end.
                bool isServerEnd = hasClient && hasServer
                    && (int)serverPid == ownerPid && (int)clientPid == childPid;
                bool isClientEnd = hasClient && hasServer
                    && (int)clientPid == ownerPid && (int)serverPid == parentPid;
                if (clientMode ? !isClientEnd : !isServerEnd) continue;
                roleMatches++;

                // THE CONNECTION STATE. A server end with a client is
                // connected and carries messages; a server end without one
                // is a listener instance that carries none.
                if (!clientMode && !hasClient) continue;
                connectedMatches++;

                if ((int)clientPid == childPid) peerIsChild++; else peerOther++;

                HashSet<int> holderSet = allHolders[pair.Key];
                int size = holderSet == null ? 0 : holderSet.Count;
                holderSets++;
                if (size == 0) continue;
                bool third = false;
                foreach (int pid in holderSet)
                {
                    if (pid != ownerPid) { third = true; break; }
                }
                if (third) holderSetsWithThirdParty++; else holderSetsClean++;
                foreach (int pid in holderSet) holderPids.Add(pid);
            }
            finally
            {
                CloseHandle(duplicated);
            }
        }

        // The process handle opened for duplication is released BEFORE the
        // measurement is reported: an open process handle is itself a handle
        // on the owner's process object, and leaving it open would put the
        // measuring process into the holder sets this module observes.
        CloseHandle(ownerProcess);

        report.AppendLine("HOLDERS=OK");
        report.AppendLine("HOLDER_NAME_MATCHES=" + nameMatches.ToString(CultureInfo.InvariantCulture));
        report.AppendLine("HOLDER_ROLE_MATCHES=" + roleMatches.ToString(CultureInfo.InvariantCulture));
        report.AppendLine("HOLDER_CONNECTED_MATCHES=" + connectedMatches.ToString(CultureInfo.InvariantCulture));
        report.AppendLine("HOLDER_PEER_IS_CHILD=" + peerIsChild.ToString(CultureInfo.InvariantCulture));
        report.AppendLine("HOLDER_PEER_OTHER=" + peerOther.ToString(CultureInfo.InvariantCulture));
        report.AppendLine("HOLDER_SETS=" + holderSets.ToString(CultureInfo.InvariantCulture));
        report.AppendLine("HOLDER_SETS_CLEAN=" + holderSetsClean.ToString(CultureInfo.InvariantCulture));
        report.AppendLine("HOLDER_SETS_WITH_THIRD_PARTY=" + holderSetsWithThirdParty.ToString(CultureInfo.InvariantCulture));
        report.AppendLine("HOLDER_MATCH_HAS_CLIENT=" + matchHasClient.ToString(CultureInfo.InvariantCulture));
        report.AppendLine("HOLDER_MATCH_HAS_SERVER=" + matchHasServer.ToString(CultureInfo.InvariantCulture));
        report.AppendLine("HOLDER_MATCH_FIRST_CLIENT_PID=" + firstClientPid.ToString(CultureInfo.InvariantCulture));
        report.AppendLine("HOLDER_MATCH_FIRST_SERVER_PID=" + firstServerPid.ToString(CultureInfo.InvariantCulture));
        report.AppendLine("HOLDER_PIDS=" + JoinPids(new List<int>(holderPids)));
        Marshal.FreeHGlobal(buffer);
        return report.ToString();
    }

    // The kernel reports the pipe as \\Device\\NamedPipe\\<name>. The
    // comparison is on the FINAL segment and is EXACT: a decoy named
    // <name>-extra must not satisfy the filter.
    private static bool NamesMatch(string objectName, string expected)
    {
        string wanted = expected;
        int slash = wanted.LastIndexOf(Path.DirectorySeparatorChar);
        if (slash >= 0) wanted = wanted.Substring(slash + 1);
        string got = objectName;
        int gotSlash = got.LastIndexOf(Path.DirectorySeparatorChar);
        if (gotSlash >= 0) got = got.Substring(gotSlash + 1);
        return string.Equals(got, wanted, StringComparison.Ordinal);
    }

    private static int ReadPid(IntPtr entry, Layout layout)
    {
        long raw = Marshal.ReadInt64(entry, layout.PidSlot * 8);
        return (int)(raw & 0xFFFFFFFFL);
    }

    private static long ReadObject(IntPtr entry, Layout layout)
    {
        return Marshal.ReadInt64(entry, layout.ObjectSlot * 8);
    }

    private static long ReadHandleValue(IntPtr entry, Layout layout)
    {
        return Marshal.ReadInt64(entry, layout.HandleSlot * 8);
    }

    private static string JoinPids(List<int> pids)
    {
        string rendered = "";
        for (int i = 0; i < pids.Count; i++)
        {
            if (i > 0) rendered += ",";
            rendered += pids[i].ToString();
        }
        return rendered;
    }

    private static string QueryTypeName(IntPtr handle)
    {
        return QueryUnicodeString(handle, ObjectTypeInformation);
    }

    private static string QueryUnicodeString(IntPtr handle, int infoClass)
    {
        int returned;
        int status = NtQueryObject(handle, infoClass, IntPtr.Zero, 0, out returned);
        if (status != StatusInfoLengthMismatch || returned <= 0)
        {
            return "(query-failed:" + status.ToString("X8") + ")";
        }

        int allocated = returned;
        IntPtr buffer = Marshal.AllocHGlobal(allocated);
        try
        {
            status = NtQueryObject(handle, infoClass, buffer, returned, out returned);
            if (status != 0)
            {
                return "(query-failed:" + status.ToString("X8") + ")";
            }

            // NtQueryObject returns a UNICODE_STRING: byte lengths precede
            // an aligned pointer. Validate it before dereferencing the text.
            int pointerOffset = IntPtr.Size == 8 ? 8 : 4;
            if (allocated < pointerOffset + IntPtr.Size) return "(query-failed:short-buffer)";
            int length = (ushort)Marshal.ReadInt16(buffer, 0);
            int maxLength = (ushort)Marshal.ReadInt16(buffer, 2);
            IntPtr text = Marshal.ReadIntPtr(buffer, pointerOffset);
            if (length == 0) return "";
            if (text == IntPtr.Zero || (length & 1) != 0 || length > maxLength)
                return "(query-failed:invalid-string)";
            long offset = text.ToInt64() - buffer.ToInt64();
            if (offset < 0 || offset > allocated || length > allocated - offset)
                return "(query-failed:invalid-string)";
            return Marshal.PtrToStringUni(text, length / 2);
        }
        catch (Exception)
        {
            return "(query-failed:exception)";
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static Layout DetectLayout(IntPtr buffer, int count, int tableLength, int targetPid)
    {
        // THE LAYOUT IS RECOGNISED BY STRUCTURE, NOT BY MAGNUMUM
        //
        // The previous detector scored each candidate column against
        // magnitude thresholds and kept the best-scoring one. Measured on
        // the real Windows development machine, that detector found NO
        // candidate at all and the managed caller session failed closed with
        // "layout-undetermined". The reason was specific: the handle column
        // gate required a distinct-value ratio of at least 0.4, while the
        // real handle column measures 0.355. A threshold that the real data
        // misses by 0.045 is not a measurement, it is a coin flip on how
        // many handles the machine happens to hold.
        //
        // The replacement recognises the layout by properties that hold for
        // every value the kernel can produce:
        //
        //   P1 NO OVERREAD. The candidate must fit inside the length the
        //      KERNEL reported, not inside the buffer that was allocated to
        //      hold it. The allocation is always larger than the table, so
        //      comparing against it allowed a candidate whose stride
        //      overhangs the real table to read the NEXT record's fields and
        //      pair one record's handle with another record's object pointer.
        //      That is a silent mis-binding, and it is worse than the
        //      fail-closed the old detector produced.
        //   P2 THE OBJECT COLUMN IS THE RECORD'S FIRST FIELD. The kernel
        //      object pointer is the first member of the entry, so the
        //      pointer column must be slot 0. This is what separates the
        //      true offset from the ones that read the pointer one slot late.
        //   P3 PROCESS IDS GROUP CONTIGUOUSLY. The table is emitted in
        //      process order, so the number of maximal runs in the pid column
        //      equals the number of distinct pids in it.
        //   P4 A PROCESS CANNOT HOLD THE SAME HANDLE VALUE TWICE, so the
        //      (process id, handle value) pair is unique across the whole
        //      table. This identifies the handle column without assuming how
        //      many distinct handle values exist.
        //   P5 PROCESS IDS ARE 16-BIT AND HANDLE VALUES ARE 4-BYTE ALIGNED,
        //      which separates the pid column and the handle column from the
        //      access-mask column that shares their record.
        //
        // On the real machine these properties select exactly ONE candidate:
        // offset 16, stride 40, object slot 0, pid slot 1, handle slot 2, and
        // that candidate exactly fills the kernel-reported table.
        //
        // The work is done in ONE pass per candidate rather than one pass per
        // column pair. The old detector sampled 4000 records per column; this
        // one reads every record, because the properties above are properties
        // of the WHOLE table and a sample cannot establish them. Reading the
        // whole table is affordable: P1 and P2 reject almost every candidate
        // before the per-column statistics are computed.
        int[] offsetCandidates = { 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64 };
        int[] strideCandidates = { 16, 24, 28, 32, 40, 48, 56, 64 };

        List<Layout> candidates = new List<Layout>();
        foreach (int offset in offsetCandidates)
        {
            foreach (int stride in strideCandidates)
            {
                // P1: the candidate must fit inside the kernel-reported table.
                long span = (long)offset + (long)stride * count;
                if (span > tableLength) continue;

                int slots = stride / 8;
                if (slots < 3) continue;

                // P2: the kernel object pointer is the record's first field.
                if (PointerColumnRatio(buffer, offset, stride, count) < 0.99) continue;

                // -- one pass: per-column statistics --------------------------
                int[] runs = new int[slots];
                int[] previous = new int[slots];
                bool[] pidShaped = new bool[slots];
                bool[] handleShaped = new bool[slots];
                HashSet<long>[] distinct = new HashSet<long>[slots];
                for (int s = 0; s < slots; s++)
                {
                    previous[s] = -1;
                    pidShaped[s] = true;
                    handleShaped[s] = true;
                    distinct[s] = new HashSet<long>();
                }

                for (int i = 0; i < count; i++)
                {
                    IntPtr entry = IntPtr.Add(buffer, offset + i * stride);
                    for (int s = 0; s < slots; s++)
                    {
                        long value = Marshal.ReadInt64(entry, s * 8);
                        if (value <= 0 || value > 65535) pidShaped[s] = false;
                        if (value < 0 || value > 0xFFFFFFL || (value & 3) != 0) handleShaped[s] = false;
                        int low = (int)(value & 0xFFFFFFFFL);
                        if (low != previous[s])
                        {
                            runs[s]++;
                            previous[s] = low;
                        }
                        distinct[s].Add(value);
                    }
                }

                for (int pidSlot = 1; pidSlot < slots; pidSlot++)
                {
                    // P3 + P5: the pid column holds 16-bit ids and groups by
                    // process, so its maximal runs equal its distinct values.
                    if (!pidShaped[pidSlot]) continue;
                    if (runs[pidSlot] != distinct[pidSlot].Count) continue;

                    for (int handleSlot = 1; handleSlot < slots; handleSlot++)
                    {
                        if (handleSlot == pidSlot) continue;
                        if (!handleShaped[handleSlot]) continue;
                        // P4: a process cannot hold the same handle value twice.
                        if (!PairsAreUnique(buffer, offset, stride, pidSlot, handleSlot, count)) continue;

                        Layout layout = new Layout();
                        layout.Offset = offset;
                        layout.Stride = stride;
                        layout.ObjectSlot = 0;
                        layout.PidSlot = pidSlot;
                        layout.HandleSlot = handleSlot;
                        layout.FitsExactly = span == tableLength;
                        candidates.Add(layout);
                    }
                }
            }
        }

        if (candidates.Count == 0) return null;

        // A total order, so the outcome never depends on iteration order: the
        // candidate that exactly fills the kernel-reported table wins, then
        // the smallest stride, then the smallest offset.
        candidates.Sort(delegate(Layout a, Layout b)
        {
            if (a.FitsExactly != b.FitsExactly) return a.FitsExactly ? -1 : 1;
            if (a.Stride != b.Stride) return a.Stride.CompareTo(b.Stride);
            return a.Offset.CompareTo(b.Offset);
        });

        Layout best = candidates[0];

        // The layout is only usable if the target process actually appears in
        // the table under it. Without this the detector could report a
        // layout that simply does not contain the process being asked about.
        int targetHits = 0;
        for (int i = 0; i < count; i++)
        {
            IntPtr entry = IntPtr.Add(buffer, best.Offset + i * best.Stride);
            long ownerRaw = Marshal.ReadInt64(entry, best.PidSlot * 8);
            if ((int)(ownerRaw & 0xFFFFFFFFL) == targetPid) targetHits++;
        }
        if (targetHits <= 0) return null;

        best.TargetHits = targetHits;
        best.CandidateCount = candidates.Count;
        return best;
    }

    // P2: the fraction of records whose first slot holds a kernel object
    // pointer. The property is binary in nature — a column either is the
    // pointer column or it is not — so the acceptance bar is set where a
    // misaligned column cannot reach it, not where the real data barely
    // reaches it.
    private static double PointerColumnRatio(IntPtr buffer, int offset, int stride, int count)
    {
        int hits = 0;
        for (int i = 0; i < count; i++)
        {
            long value = Marshal.ReadInt64(IntPtr.Add(buffer, offset + i * stride), 0);
            if (value < 0 && (value & 7) == 0) hits++;
        }
        return (double)hits / count;
    }

    // P4: a process cannot hold the same handle value twice. The key packs
    // the process id and the handle value into one 64-bit integer, which
    // keeps the check to a single hash set of numbers instead of a set of
    // formatted strings.
    private static bool PairsAreUnique(IntPtr buffer, int offset, int stride, int pidSlot, int handleSlot, int count)
    {
        HashSet<long> pairs = new HashSet<long>();
        for (int i = 0; i < count; i++)
        {
            IntPtr entry = IntPtr.Add(buffer, offset + i * stride);
            long pid = Marshal.ReadInt64(entry, pidSlot * 8) & 0xFFFFFFFFL;
            long handle = Marshal.ReadInt64(entry, handleSlot * 8);
            long key = (pid << 32) | (handle & 0xFFFFFFFFL);
            if (!pairs.Add(key)) return false;
        }
        return true;
    }

    private sealed class Layout
    {
        public int Offset;
        public int Stride;
        public int ObjectSlot;
        public int PidSlot;
        public int HandleSlot;
        public int TargetHits;
        public bool FitsExactly;
        public int CandidateCount;
    }
}
`;

/**
 * Enumerate the pids holding a child's IPC channel.
 *
 * @param {number} childPid The supervised child.
 * @param {number} parentPid The coordinator that owns the other end.
 * @returns {{ok: boolean, pids: number[], reason: string|null}}
 */
function readWindowsChannelHolders(childPid, parentPid) {
  if (!Number.isInteger(childPid) || childPid <= 0) {
    return { ok: false, pids: [], reason: "bad-child-pid" };
  }

  const result = runPowerShellWithStdin(
    HOLDER_DRIVER_SOURCE,
    HOLDER_HELPER_SOURCE,
    [String(childPid), String(Number.isInteger(parentPid) && parentPid > 0 ? parentPid : 0)],
  );

  if (result.status !== 0) {
    return { ok: false, pids: [], reason: "powershell-failed:" + (result.error || result.status) };
  }

  const output = result.stdout;
  if (!/HOLDERS=OK/.test(output)) {
    const failure = (output.match(/HOLDERS=FAILED:([^\r\n]*)/) || [])[1] || "unknown";
    return { ok: false, pids: [], reason: failure.trim() };
  }

  const pidList = (output.match(/HOLDER_PIDS=([^\r\n]*)/) || [])[1] || "";
  const pids = pidList
    .split(",")
    .map((piece) => Number.parseInt(piece.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b);

  return { ok: true, pids, reason: null };
}

/**
 * Enumerate the processes holding ONE END of a named pipe channel.
 *
 * The channel is identified by the pipe's full name, NOT by intersecting
 * the coordinator's and the child's kernel objects: that intersection
 * matches every inherited handle (stdout, stderr, the secret pipe, the
 * console) and reports a transfer for a clean session.
 *
 * The two ends are separate kernel objects, so they are audited
 * separately and their holder sets are never merged: the server's holder
 * set cannot see a transfer of the client end to a descendant.
 *
 * @param {object} options
 * @param {number} options.childPid The supervised child.
 * @param {number} options.parentPid The coordinator that owns the other end.
 * @param {string} options.pipeName The FULL generated pipe name.
 * @param {"server"|"client"} [options.end] Which end to audit. Defaults to
 *   "server".
 * @param {number} [options.timeoutMs] Bound on the helper run.
 * @returns {{ok: boolean, pids: number[], reason: string|null, detail: object|null}}
 */
function readWindowsChannelHoldersBound(options) {
  const {
    childPid,
    parentPid,
    pipeName,
    end = "server",
    timeoutMs,
  } = options || {};

  if (!Number.isInteger(childPid) || childPid <= 0) {
    return { ok: false, pids: [], reason: "bad-child-pid", detail: null };
  }
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    return { ok: false, pids: [], reason: "bad-parent-pid", detail: null };
  }
  if (typeof pipeName !== "string" || !pipeName) {
    return { ok: false, pids: [], reason: "no-pipe-name", detail: null };
  }
  if (end !== "server" && end !== "client") {
    return { ok: false, pids: [], reason: "bad-end", detail: null };
  }

  const result = runPowerShellWithStdin(
    BOUND_DRIVER_SOURCE,
    HOLDER_HELPER_SOURCE,
    [String(childPid), String(parentPid), pipeName, end],
    Number.isInteger(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {},
  );

  if (result.status !== 0) {
    return {
      ok: false,
      pids: [],
      reason: "powershell-failed:" + (result.error || result.status),
      detail: null,
    };
  }

  const output = result.stdout;
  if (!/HOLDERS=OK/.test(output)) {
    const failure = (output.match(/HOLDERS=FAILED:([^\r\n]*)/) || [])[1] || "unknown";
    return { ok: false, pids: [], reason: failure.trim(), detail: null };
  }

  const count = (key) => {
    const raw = (output.match(new RegExp("^" + key + "=(\\S+)", "m")) || [])[1];
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) ? parsed : null;
  };

  const pidList = (output.match(/HOLDER_PIDS=([^\r\n]*)/) || [])[1] || "";
  const pids = pidList
    .split(",")
    .map((piece) => Number.parseInt(piece.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b);

  return {
    ok: true,
    pids,
    reason: null,
    detail: {
      nameMatches: count("HOLDER_NAME_MATCHES"),
      roleMatches: count("HOLDER_ROLE_MATCHES"),
      connectedMatches: count("HOLDER_CONNECTED_MATCHES"),
      peerIsChild: count("HOLDER_PEER_IS_CHILD"),
      peerOther: count("HOLDER_PEER_OTHER"),
      holderSets: count("HOLDER_SETS"),
      holderSetsClean: count("HOLDER_SETS_CLEAN"),
      holderSetsWithThirdParty: count("HOLDER_SETS_WITH_THIRD_PARTY"),
      matchHasClient: count("HOLDER_MATCH_HAS_CLIENT"),
      matchHasServer: count("HOLDER_MATCH_HAS_SERVER"),
      firstClientPid: count("HOLDER_MATCH_FIRST_CLIENT_PID"),
      firstServerPid: count("HOLDER_MATCH_FIRST_SERVER_PID"),
    },
  };
}

module.exports = Object.freeze({
  readWindowsChannelHolders,
  readWindowsChannelHoldersBound,
  BOUND_DRIVER_SOURCE,
  HOLDER_DRIVER_SOURCE,
  HOLDER_HELPER_SOURCE,
});
