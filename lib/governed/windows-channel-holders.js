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
  "[SamHMI.WindowsChannelHolders]::Enumerate($childPid, $parentPid)",
].join("; ");

// The inlined C# helper. It is the same algorithm the Windows feasibility
// probe used on the real machine, with `Main` replaced by a callable entry
// point so `Add-Type` can host it.
const HOLDER_HELPER_SOURCE = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class SamHMIWindowsChannelHolders
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
        Layout layout = DetectLayout(buffer, count, length, childPid);
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

        IntPtr buffer = Marshal.AllocHGlobal(returned);
        try
        {
            status = NtQueryObject(handle, infoClass, buffer, returned, out returned);
            if (status != 0)
            {
                return "(query-failed:" + status.ToString("X8") + ")";
            }

            IntPtr text = Marshal.ReadIntPtr(buffer);
            if (text == IntPtr.Zero) return "";
            int length = Marshal.ReadInt16(text, 8);
            if (length <= 0) return "";
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

    private static Layout DetectLayout(IntPtr buffer, int count, int length, int targetPid)
    {
        int[] offsetCandidates = { 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64 };
        int[] strideCandidates = { 16, 24, 28, 32, 40, 48, 56, 64 };
        const int sampleCount = 4000;

        List<Layout> candidates = new List<Layout>();
        foreach (int offset in offsetCandidates)
        {
            foreach (int stride in strideCandidates)
            {
                long needed = (long)offset + (long)stride * count;
                if (needed > length) continue;

                int slots = stride / 8;
                if (slots < 3) continue;

                int[] kernelHits = new int[slots];
                int[] pidHits = new int[slots];
                int[] handleHits = new int[slots];
                HashSet<long>[] distinctValues = new HashSet<long>[slots];
                for (int s = 0; s < slots; s++) distinctValues[s] = new HashSet<long>();

                int sampled = 0;
                for (int k = 0; k < sampleCount; k++)
                {
                    int i = (int)((long)k * count / sampleCount);
                    IntPtr entry = IntPtr.Add(buffer, offset + i * stride);
                    sampled++;
                    for (int s = 0; s < slots; s++)
                    {
                        long value = Marshal.ReadInt64(entry, s * 8);
                        // Kernel addresses on x64 live in 0xFFFF8xxx..., which is
                        // NEGATIVE when read as a signed long.
                        if (value < 0 && (value & 7) == 0) kernelHits[s]++;
                        if (value > 0 && value < 70000) pidHits[s]++;
                        if (value >= 0 && value < 0x100000 && (value & 3) == 0) handleHits[s]++;
                        distinctValues[s].Add(value);
                    }
                }

                if (sampled == 0) continue;

                int objectSlot = ArgMax(kernelHits);
                double objectRatio = (double)kernelHits[objectSlot] / sampled;
                if (objectRatio < 0.5) continue;

                // Separating the pid slot from the handle slot needs a
                // discriminator that survives the real data. Alignment does
                // NOT work: Windows allocates process ids as multiples of
                // four, so a pid looks exactly like a handle value under an
                // alignment test. What DOES separate them is REPETITION:
                //   - the pid slot repeats: one process owns many handles
                //   - the handle slot does not: handle values are unique
                int pidSlot = -1;
                int handleSlot = -1;
                double pidRatio = 0.0;
                double handleRatio = 0.0;
                double pidDistinct = 1.0;
                double handleDistinct = 0.0;

                for (int s = 0; s < slots; s++)
                {
                    if (s == objectSlot) continue;
                    double range = (double)pidHits[s] / sampled;
                    double distinct = (double)distinctValues[s].Count / sampled;
                    if (range >= 0.9 && distinct <= 0.15 && range > pidRatio)
                    {
                        pidSlot = s;
                        pidRatio = range;
                        pidDistinct = distinct;
                    }
                }

                if (pidSlot < 0) continue;

                for (int s = 0; s < slots; s++)
                {
                    if (s == objectSlot || s == pidSlot) continue;
                    double range = (double)handleHits[s] / sampled;
                    double distinct = (double)distinctValues[s].Count / sampled;
                    if (range >= 0.5 && distinct >= 0.4 && range * distinct > handleRatio * handleDistinct)
                    {
                        handleSlot = s;
                        handleRatio = range;
                        handleDistinct = distinct;
                    }
                }

                if (handleSlot < 0) continue;

                Layout layout = new Layout();
                layout.Offset = offset;
                layout.Stride = stride;
                layout.ObjectSlot = objectSlot;
                layout.PidSlot = pidSlot;
                layout.HandleSlot = handleSlot;
                layout.Score = objectRatio * 0.5 + pidRatio * 0.3 + handleDistinct * 0.2;
                layout.ObjectRatio = objectRatio;
                layout.PidRatio = pidRatio;
                layout.HandleRatio = handleRatio;
                layout.PidDistinct = pidDistinct;
                layout.HandleDistinct = handleDistinct;
                candidates.Add(layout);
            }
        }

        candidates.Sort(delegate(Layout a, Layout b) { return b.Score.CompareTo(a.Score); });

        foreach (Layout candidate in candidates)
        {
            int targetHits = 0;
            for (int i = 0; i < count; i++)
            {
                IntPtr entry = IntPtr.Add(buffer, candidate.Offset + i * candidate.Stride);
                long ownerRaw = Marshal.ReadInt64(entry, candidate.PidSlot * 8);
                int ownerPid = (int)(ownerRaw & 0xFFFFFFFFL);
                if (ownerPid == targetPid) targetHits++;
            }

            if (targetHits <= 0) continue;
            candidate.TargetHits = targetHits;
            return candidate;
        }

        return null;
    }

    private static int ArgMax(int[] values)
    {
        int bestIndex = 0;
        for (int i = 1; i < values.Length; i++)
        {
            if (values[i] > values[bestIndex]) bestIndex = i;
        }
        return bestIndex;
    }

    private sealed class Layout
    {
        public int Offset;
        public int Stride;
        public int ObjectSlot;
        public int PidSlot;
        public int HandleSlot;
        public double Score;
        public double ObjectRatio;
        public double PidRatio;
        public double HandleRatio;
        public double PidDistinct;
        public double HandleDistinct;
        public int TargetHits;
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

module.exports = Object.freeze({
  readWindowsChannelHolders,
  HOLDER_DRIVER_SOURCE,
  HOLDER_HELPER_SOURCE,
});
