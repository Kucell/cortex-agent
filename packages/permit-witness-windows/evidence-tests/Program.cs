using System.Text;
using System.Text.Json;
using System.Linq;
using PermitWitness.Windows;
using PermitWitness.PublicationEvidence;

// Isolated native publication evidence harness.
//
// It writes ONLY synthetic files into a caller-supplied scratch directory and
// reports per-stage observations. It is NOT an authority, NOT an execution
// authorization and NOT a durability proof: a successful run cannot establish
// power-loss safety, cross-machine rollback isolation or OS identity.
//
// Usage: PermitWitness.PublicationEvidence <scratch-directory>
internal static class Program
{
    private static int passed;

    public static int Main(string[] args)
    {
        if (args.Length != 1) { Console.Error.WriteLine("ERR_USAGE"); return 64; }
        if (!OperatingSystem.IsWindows()) { Console.Error.WriteLine("ERR_WINDOWS_REQUIRED"); return 69; }

        string scratchRoot = Path.GetFullPath(args[0]);
        // Every run uses its own directory. A temporary name belongs to one
        // attempt: a leftover temporary from an earlier failed attempt must
        // never block a later attempt, and must never be deleted silently.
        string runId = $"{DateTime.UtcNow:yyyyMMddTHHmmssZ}-{Environment.ProcessId}";
        string scratch = Path.Combine(scratchRoot, runId);
        Directory.CreateDirectory(scratch);
        var observations = new List<object>();

        observations.Add(new
        {
            stage = "environment",
            os = Environment.OSVersion.VersionString,
            osVersion = Environment.OSVersion.Version.ToString(),
            machine = Environment.MachineName,
            runtime = Environment.Version.ToString(),
            processIs64Bit = Environment.Is64BitProcess,
            scratch = scratch,
            runId = runId,
            drive = Path.GetPathRoot(scratch),
            driveFormat = DriveFormat(scratch),
            volumeSerial = VolumeSerial(scratch),
            user = Environment.UserName,
            isElevated = IsElevated(),
            executionAuthorized = false,
            authority = false,
            note = "stage observations only; no durability, witness or execution claim",
        });

        // 1. Fresh publication of a new name in the same directory.
        string firstDir = Path.Combine(scratch, "fresh");
        Directory.CreateDirectory(firstDir);
        string target = Path.Combine(firstDir, "entry.json");
        byte[] payload = Encoding.UTF8.GetBytes("{\"schema\":1,\"body\":\"synthetic\"}\n");
        string temp = NativePublication.TemporaryName(target, "attempt-1");
        observations.Add(Run("fresh-publish", () =>
        {
            NativePublication.PublishNew(temp, target, payload);
            return new
            {
                target = target,
                exists = File.Exists(target),
                bytesMatch = File.Exists(target) && File.ReadAllBytes(target).AsSpan().SequenceEqual(payload),
                temporaryRemoved = !File.Exists(temp),
                // The directory must contain exactly the published name. A
                // rename that resolves a different name leaves an extra
                // entry next to the target, which is how the missing NUL
                // terminator was detected on this host.
                directoryEntries = Directory.GetFileSystemEntries(firstDir).Select(n => Path.GetFileName(n) ?? n).OrderBy(n => n).ToArray(),
                unexpectedEntries = Directory.GetFileSystemEntries(firstDir).Select(n => Path.GetFileName(n) ?? n)
                    .Where(n => n != "entry.json").OrderBy(n => n).ToArray(),
                identity = NativePublication.Identity(target),
            };
        }));

        // 2. An existing target is a conflict, never a silent overwrite.
        observations.Add(Run("existing-target-is-conflict", () =>
        {
            string second = NativePublication.TemporaryName(target, "attempt-2");
            byte[] other = Encoding.UTF8.GetBytes("{\"schema\":1,\"body\":\"different\"}\n");
            string[] before = Directory.GetFileSystemEntries(firstDir).Select(n => Path.GetFileName(n) ?? n).OrderBy(n => n).ToArray();
            try
            {
                NativePublication.PublishNew(second, target, other);
                return new
                {
                    rejected = false,
                    targetBytesUnchanged = File.ReadAllBytes(target).AsSpan().SequenceEqual(payload),
                    before,
                    after = Directory.GetFileSystemEntries(firstDir).Select(n => Path.GetFileName(n) ?? n).OrderBy(n => n).ToArray(),
                };
            }
            catch (NativePublication.PublicationException error)
            {
                return new
                {
                    rejected = true,
                    code = error.Message,
                    stage = error.FailureStage.ToString(),
                    nativeError = error.NativeError,
                    targetBytesUnchanged = File.ReadAllBytes(target).AsSpan().SequenceEqual(payload),
                    before,
                    after = Directory.GetFileSystemEntries(firstDir).Select(n => Path.GetFileName(n) ?? n).OrderBy(n => n).ToArray(),
                    // A rejected publication must not leave any new name in
                    // the directory besides its own temporary file. An extra
                    // entry means the rename landed somewhere the caller did
                    // not ask for.
                    unexpectedEntries = Directory.GetFileSystemEntries(firstDir).Select(n => Path.GetFileName(n) ?? n)
                        .Where(n => !before.Contains(n) && n != Path.GetFileName(second)).OrderBy(n => n).ToArray(),
                };
            }
        }));

        // 3. Idempotent re-publication of the SAME bytes to the same name.
        observations.Add(Run("same-bytes-republish", () =>
        {
            string third = NativePublication.TemporaryName(target, "attempt-3");
            try
            {
                NativePublication.PublishNew(third, target, payload);
                return new { republished = true, note = "unexpected: target was replaced" };
            }
            catch (NativePublication.PublicationException error)
            {
                // A same-name republication must be refused as a conflict,
                // and the already published bytes must survive unchanged.
                return new
                {
                    republished = false,
                    code = error.Message,
                    stage = error.FailureStage.ToString(),
                    nativeError = error.NativeError,
                    targetBytesUnchanged = File.ReadAllBytes(target).AsSpan().SequenceEqual(payload),
                    // The refused attempt leaves only its own temporary file.
                    // It must not create or modify any other directory entry.
                    unexpectedEntries = Directory.GetFileSystemEntries(firstDir)
                        .Select(n => Path.GetFileName(n) ?? n)
                        .Where(n => n != "entry.json" && n != Path.GetFileName(third)).ToArray(),
                };
            }
        }));

        // 4. Distinct names in the same directory each get a distinct File ID.
        observations.Add(Run("distinct-file-ids", () =>
        {
            var ids = new List<string>();
            for (int index = 0; index < 3; index++)
            {
                string n = Path.Combine(firstDir, $"multi-{index}.json");
                string t = NativePublication.TemporaryName(n, $"multi-{index}");
                NativePublication.PublishNew(t, n, Encoding.UTF8.GetBytes($"{{\"i\":{index}}}\n"));
                ids.Add(NativePublication.Identity(n));
            }
            return new { identities = ids, distinct = ids.Distinct().Count() == ids.Count };
        }));

        // 5b. A leftover temporary from an earlier attempt must not block a
        // later attempt and must not be reused: each attempt owns its name.
        observations.Add(Run("per-attempt-temporary-names", () =>
        {
            string baseName = Path.Combine(firstDir, "attempt.json");
            string first = NativePublication.TemporaryName(baseName, "attempt-a");
            string second = NativePublication.TemporaryName(baseName, "attempt-b");
            File.WriteAllText(first, "leftover");
            string published = NativePublication.TemporaryName(baseName, "attempt-c");
            NativePublication.PublishNew(published, baseName, Encoding.UTF8.GetBytes("{}\n"));
            return new
            {
                distinctNames = first != second && second != published,
                leftoverUntouched = File.Exists(first),
                leftoverBytes = File.ReadAllText(first),
                published = File.Exists(baseName),
            };
        }));

        // 5. Cross-directory publication is refused by the caller contract.
        observations.Add(Run("cross-directory-refused", () =>
        {
            string otherDir = Path.Combine(scratch, "other");
            Directory.CreateDirectory(otherDir);
            try
            {
                NativePublication.PublishNew(Path.Combine(firstDir, "x.tmp"),
                    Path.Combine(otherDir, "x.json"), Encoding.UTF8.GetBytes("x"));
                return new { refused = false };
            }
            catch (ArgumentException error)
            {
                return new { refused = true, code = error.Message.Split('(')[0].Trim() };
            }
        }));

        // 6. Platform contract: which access mask and info class allow a
        // same-directory rename on this host. These are stable assertions
        // about the frozen support matrix, not a durability observation, and
        // they never touch a real target.
        observations.Add(Run("rename-access-matrix", () =>
        {
            var matrix = new List<object>();
            bool deleteRequired = false;
            bool legacySupported = false;
            bool extendedUnsupported = true;
            var masks = new (string Name, uint Access)[]
            {
                ("rw", 0x00000001 | 0x00000002),
                ("rw+delete", 0x00000001 | 0x00000002 | 0x00010000),
                ("rw+delete+attrs", 0x00000001 | 0x00000002 | 0x00010000 | 0x00000080 | 0x00000100),
                ("rw+delete+attrs+sync", 0x00000001 | 0x00000002 | 0x00010000 | 0x00000080 | 0x00000100 | 0x00100000),
                ("generic-rw+delete", 0x80000000 | 0x40000000 | 0x00010000),
            };
            foreach (var (name, access) in masks)
            {
                string dir = Path.Combine(scratch, $"matrix-{name}");
                Directory.CreateDirectory(dir);
                string source = Path.Combine(dir, "source.bin");
                string destination = Path.Combine(dir, "destination.bin");
                File.WriteAllText(source, "probe");
                string? error = null;
                bool renamed = false;
                try
                {
                    using var handle = NativeProbe.Open(source, access, NativeProbe.OpenExisting);
                    NativeProbe.Rename(handle, destination, NativeProbe.FileRenameInfo);
                    renamed = true;
                }
                catch (Exception failure)
                {
                    error = $"{failure.GetType().Name}:{failure.Message}";
                }
                matrix.Add(new
                {
                    access = name,
                    accessMask = access,
                    renamed,
                    destinationExists = File.Exists(destination),
                    error,
                });
                if (name == "rw") deleteRequired = !renamed;
                if (name == "rw+delete+attrs+sync") legacySupported = renamed && File.Exists(destination);
            }
            // The same matrix with FileRenameInfoEx, which carries the
            // POSIX-style flags instead of the legacy boolean.
            foreach (var (name, access) in masks)
            {
                string dir = Path.Combine(scratch, $"matrix-ex-{name}");
                Directory.CreateDirectory(dir);
                string source = Path.Combine(dir, "source.bin");
                string destination = Path.Combine(dir, "destination.bin");
                File.WriteAllText(source, "probe");
                string? error = null;
                bool renamed = false;
                try
                {
                    using var handle = NativeProbe.Open(source, access, NativeProbe.OpenExisting);
                    NativeProbe.RenameEx(handle, destination);
                    renamed = true;
                }
                catch (Exception failure)
                {
                    error = $"{failure.GetType().Name}:{failure.Message}";
                }
                matrix.Add(new
                {
                    access = name + "+renameEx",
                    accessMask = access,
                    renamed,
                    destinationExists = File.Exists(destination),
                    error,
                });
                if (renamed) extendedUnsupported = false;
            }
            return new
            {
                matrix,
                // DELETE access is mandatory for the legacy rename path.
                deleteRequired,
                // The legacy FileRenameInfo path is the supported one.
                legacySupported,
                // FileRenameInfoEx is not supported on this platform build and
                // must not be used by the implementation.
                extendedUnsupported,
            };
        }));

        // 6b. Root-directory variant: bind the verified parent directory by
        // handle and pass only the final name. This is the documented form
        // for a same-directory rename.
        observations.Add(Run("rename-root-directory-variant", () =>
        {
            string dir = Path.Combine(scratch, "root-directory");
            Directory.CreateDirectory(dir);
            string source = Path.Combine(dir, "source.bin");
            string destination = Path.Combine(dir, "destination.bin");
            File.WriteAllText(source, "probe");
            string? error = null;
            bool renamed = false;
            try
            {
                using var directory = NativeProbe.OpenDirectory(dir);
                using var handle = NativeProbe.Open(source,
                    0x00000001 | 0x00000002 | 0x00010000 | 0x00000080 | 0x00000100, NativeProbe.OpenExisting);
                NativeProbe.RenameInDirectory(handle, directory, "destination.bin");
                renamed = true;
            }
            catch (Exception failure)
            {
                error = $"{failure.GetType().Name}:{failure.Message}";
            }
            return new { renamed, destinationExists = File.Exists(destination), error };
        }));

        var report = new
        {
            schema = 1,
            kind = "windows-native-publication-stage-evidence",
            executionAuthorized = false,
            authority = false,
            durable = false,
            crossMachine = false,
            claim = "per-stage native observations only",
            notClaimed = new[]
            {
                "power-loss durability",
                "device write-cache safety",
                "snapshot or whole-machine rollback isolation",
                "external witness or trusted time",
                "OS identity or service-account proof",
                "transaction or cross-domain atomicity",
            },
            checks = passed,
            observations,
        };
        Console.WriteLine(JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
        return 0;
    }

    private static object Run(string stage, Func<object> body)
    {
        try
        {
            object result = body();
            passed++;
            return new { stage, outcome = "observed", result };
        }
        catch (Exception error)
        {
            NativePublication.PublicationException? publication = error as NativePublication.PublicationException;
            return new
            {
                stage,
                outcome = "error",
                error = error.GetType().Name,
                code = error.Message,
                nativeError = publication?.NativeError ?? 0,
                failureStage = publication?.FailureStage.ToString(),
            };
        }
    }

    private static string DriveFormat(string path)
    {
        string root = Path.GetPathRoot(path) ?? "";
        try
        {
            var drive = new DriveInfo(root);
            return drive.DriveFormat;
        }
        catch { return "unknown"; }
    }

    private static string VolumeSerial(string path)
    {
        try
        {
            var info = new System.IO.DriveInfo(Path.GetPathRoot(path) ?? "");
            return $"{info.Name}:{info.VolumeLabel}";
        }
        catch { return "unknown"; }
    }

    private static bool IsElevated()
    {
        try
        {
            using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
            var principal = new System.Security.Principal.WindowsPrincipal(identity);
            return principal.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
        }
        catch { return false; }
    }
}
