"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const facts = require("../../lib/governed/windows-identity-facts");
const holders = require("../../lib/governed/windows-channel-holders");

describe("governed/windows-identity-facts - CIM facts", () => {
  test("a live Windows process has precise CIM facts", { skip: process.platform !== "win32" }, () => {
    const current = facts.readCimFacts(process.pid);
    assert.ok(current);
    assert.match(current.creationTicks, /^\d+$/);
    assert.ok(current.commandLine && current.commandLine.trim());
    assert.equal(facts.readWindowsStartToken(process.pid), `win32:${current.creationTicks}`);
    assert.match(facts.readWindowsCommandDigest(process.pid), /^sha256:[0-9a-f]{64}$/);
  });

  test("successful CIM output returns creation ticks and command line", (t) => {
    const childProcess = require("node:child_process");
    const modulePath = require.resolve("../../lib/governed/windows-identity-facts");
    const original = require.cache[modulePath];
    const spawn = t.mock.method(childProcess, "spawnSync", () => ({
      status: 0,
      stdout: "CIM_FACTS=OK\nCIM_TICKS=638000000000000000\nCIM_CMDLINE_B64=bm9kZSBob3N0Lmpz\n",
      stderr: "",
    }));
    try {
      delete require.cache[modulePath];
      const fresh = require(modulePath);
      assert.deepEqual(fresh.readCimFacts(123), {
        creationTicks: "638000000000000000", commandLine: "node host.js",
      });
      const argv = spawn.mock.calls[0].arguments[1];
      assert.equal(argv.length, 4);
      assert.match(argv[3], /FromBase64String\('MTIz'\)/);
    } finally {
      require.cache[modulePath] = original;
    }
  });

  test("an invalid pid yields no facts", () => {
    assert.equal(facts.readCimFacts(0), null);
    assert.equal(facts.readCimFacts(-1), null);
    assert.equal(facts.readCimFacts(999_999_999), null);
  });

  test("the start token is null when the process does not exist", () => {
    // A pid that is not running has no creation date. The fact is
    // unavailable, and unavailable must be null — never a guess.
    assert.equal(facts.readWindowsStartToken(999_999_999), null);
  });

  test("the command digest is null when the process does not exist", () => {
    assert.equal(facts.readWindowsCommandDigest(999_999_999), null);
  });

  test("the command digest is prefixed the same way the POSIX path prefixes it", () => {
    // Both sides must agree on what is hashed, or a continuity check would
    // compare two different things. The POSIX path produces
    // `sha256:<hex>`; the Windows path must produce the same shape.
    const digest = facts.readWindowsCommandDigest(process.pid);
    if (digest === null) {
      // Not a Windows host: the fact is legitimately unavailable.
      return;
    }
    assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  });
});

describe("governed/windows-channel-holders - kernel object enumeration", () => {
  test("reads the types of real Windows process and file handles", { skip: process.platform !== "win32" }, () => {
    const { spawnSync } = require("node:child_process");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$source = [Console]::In.ReadToEnd()",
      "Add-Type -TypeDefinition $source -Language CSharp",
      "$method = [CortexWindowsChannelHolders].GetMethod('QueryTypeName', [Reflection.BindingFlags] 'NonPublic,Static')",
      "$handle = [Diagnostics.Process]::GetCurrentProcess().Handle",
      "$name = $method.Invoke($null, @($handle))",
      "[Console]::Out.WriteLine('TYPE_PROCESS=' + $name)",
      "$file = [IO.File]::OpenRead([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)",
      "try { $name = $method.Invoke($null, @($file.SafeFileHandle.DangerousGetHandle())); [Console]::Out.WriteLine('TYPE_FILE=' + $name) } finally { $file.Dispose() }",
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      input: holders.HOLDER_HELPER_SOURCE,
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /TYPE_PROCESS=Process\s/i);
    assert.match(result.stdout, /TYPE_FILE=File\s*$/i);
  });

  test("a valid pid invokes the stdin-backed helper and fails closed on execution failure", (t) => {
    const childProcess = require("node:child_process");
    const factsPath = require.resolve("../../lib/governed/windows-identity-facts");
    const holdersPath = require.resolve("../../lib/governed/windows-channel-holders");
    const originalFacts = require.cache[factsPath];
    const originalHolders = require.cache[holdersPath];
    const spawn = t.mock.method(childProcess, "spawnSync", () => ({ status: 1, stdout: "", stderr: "" }));
    try {
      delete require.cache[factsPath];
      delete require.cache[holdersPath];
      const fresh = require(holdersPath);
      const result = fresh.readWindowsChannelHolders(123, 456);
      assert.deepEqual(result, { ok: false, pids: [], reason: "powershell-failed:1" });
      assert.equal(spawn.mock.callCount(), 1);
      assert.match(spawn.mock.calls[0].arguments[2].input, /NtQuerySystemInformation/);
      const argv = spawn.mock.calls[0].arguments[1];
      assert.equal(argv.length, 4);
      assert.match(argv[3], /FromBase64String\('MTIz'\).*FromBase64String\('NDU2'\)/);
    } finally {
      require.cache[factsPath] = originalFacts;
      require.cache[holdersPath] = originalHolders;
    }
  });

  test("an invalid child pid is rejected before anything is executed", () => {
    const result = holders.readWindowsChannelHolders(0, process.pid);
    assert.equal(result.ok, false);
    assert.deepEqual(result.pids, []);
    assert.equal(result.reason, "bad-child-pid");
  });

  test("the helper source is inlined, never read from disk", () => {
    // The helper describes how to read process handle tables. It must not be
    // a file a same-account process can read, and it must not be loaded from
    // one either: the source travels on STDIN and is compiled in memory.
    const source = holders.HOLDER_HELPER_SOURCE;
    assert.ok(source.length > 0);
    assert.match(source, /NtQuerySystemInformation/);
    assert.match(source, /NtQueryObject/);

    // The driver reads the source from STDIN, not from a path.
    assert.match(holders.HOLDER_DRIVER_SOURCE, /Console\]::In\.ReadToEnd/);
    assert.match(holders.HOLDER_DRIVER_SOURCE, /Add-Type -TypeDefinition/);
  });

  test("the helper measures the table layout instead of assuming it", () => {
    // Hard-coding a struct offset is how a probe reports "enumeration is
    // impossible" when it merely read the wrong bytes. The layout has to be
    // measured, or the fact source silently stops working on the next
    // Windows release.
    const source = holders.HOLDER_HELPER_SOURCE;
    assert.match(source, /DetectLayout/);
    assert.match(source, /offsetCandidates/);
    assert.match(source, /strideCandidates/);
    // The pid slot is separated from the handle slot by a property of the
    // data, not by a magnitude threshold. The table is emitted in process
    // order, so the pid column's maximal runs equal its distinct values.
    assert.match(source, /ColumnIsPidColumn|distinct/);
    // A process cannot hold the same handle value twice, so the
    // (process id, handle value) pair is unique across the whole table.
    assert.match(source, /PairsAreUnique/);
    // The candidate must fit inside the length the KERNEL reported, not
    // inside the allocation that holds it. Comparing against the
    // allocation let a candidate overread the table and pair one record's
    // handle with another record's object pointer.
    assert.match(source, /tableLength/);
  });

  test("the channel is proven to be a File object, not merely something shared", () => {
    // Parent and child share plenty of kernel objects. "Something is shared"
    // is not the fact; "the shared object whose type is File" is.
    const source = holders.HOLDER_HELPER_SOURCE;
    assert.match(source, /ObjectTypeInformation/);
    assert.match(source, /Contains\("file"\)/i);
  });
});

describe("governed/managed-caller-identity - Windows branch selection", () => {
  test("the Windows branches are present and the POSIX branches are intact", () => {
    const source = require("node:fs").readFileSync(
      require.resolve("../../lib/governed/managed-caller-identity"),
      "utf8",
    );

    // Every platform has a fact source. A platform without one yields null,
    // and null is a fact the audit refuses — which is fail-closed but means
    // the continuity check can never run there.
    assert.match(source, /process\.platform === "win32"/);
    assert.match(source, /process\.platform === "linux"/);
    assert.match(source, /process\.platform === "darwin"/);
  });

  test("a Windows start token is never marked coarse", () => {
    // `isPreciseStartToken` refuses a `ps-coarse:` token. The Windows token
    // comes from CIM's 100ns CreationDate, so it must NOT carry that prefix
    // — otherwise the continuity audit would refuse a precise token.
    const identity = require("../../lib/governed/managed-caller-identity");
    assert.equal(identity.isPreciseStartToken("win32:638000000000000000"), true);
    assert.equal(identity.isPreciseStartToken("ps-coarse:Mon Nov  2 13:46:51 2026"), false);
  });
});
