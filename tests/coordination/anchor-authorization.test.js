"use strict";

// Tests for the platform authorization adapter of the protected anchor
// domain.
//
// The adapter is what makes the strict anchor check meaningful on Windows
// and on macOS. Before it existed, the check read POSIX mode bits, which
// are constantly 0666 on Windows (so every deployment was refused without
// proving anything) and blind to named ACLs on macOS (so a deployment that
// staff could write was accepted).
//
// The tests below use an injected adapter for the platform-specific
// behaviour, so they run on every host, plus the real macOS adapter where
// the host allows it.

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const authz = require("../../lib/coordination/anchor-authorization");
const anchor = require("../../lib/coordination/protected-anchor");

// The Windows snapshot reader shells out to PowerShell. The tests below
// replace execFileSync with a recording stub so that the ARGUMENT SHAPE of
// that call can be asserted on a host that is not Windows. The stub mimics
// the two properties of the real call that the defect depended on:
//
//   1. `input` is written to the child's STDIN, and it is only delivered
//      when stdio[0] is "pipe" (with "ignore" the child's stdin is /dev/null,
//      so the payload is dropped).
//   2. a non-zero exit status makes execFileSync throw, which is how the
//      product's catch block turns a failed read into `null`.
//
// The stub therefore reproduces the real failure mode: a script whose LAST
// command takes no positional parameters fails as soon as anything is
// appended to the command line, and a script that reads the payload from
// STDIN only sees it when stdin is piped.
function installPowerShellStub(handler) {
  const real = childProcess.execFileSync;
  const calls = [];
  childProcess.execFileSync = function stubbed(file, args, options) {
    if (typeof file === "string" && /powershell/i.test(file)) {
      const argv = (Array.isArray(args) ? args : []).map(String);
      const stdio = (options && options.stdio) || ["pipe", "pipe", "pipe"];
      const record = { argv, stdio, stdin: null };
      calls.push(record);
      // Deliver the payload on STDIN, but only when stdin is a pipe.
      if (options && Object.prototype.hasOwnProperty.call(options, "input")
          && stdio[0] === "pipe") {
        record.stdin = String(options.input);
      }
      const outcome = handler(record);
      if (outcome && outcome.status !== 0) {
        const error = new Error("Command failed: powershell.exe " + argv.join(" "));
        error.status = outcome.status;
        error.stdout = outcome.stdout || "";
        error.stderr = outcome.stderr || "";
        throw error;
      }
      return outcome ? outcome.stdout : "";
    }
    return real.apply(childProcess, arguments);
  };
  // The module binds execFileSync at load time
  // (`const { execFileSync } = require("node:child_process")`), so patching
  // the child_process object after the module was loaded has no effect on it.
  // The module is therefore re-required with the stub in place, and the
  // cache entry is restored afterwards so the other tests keep the real
  // implementation.
  const modulePath = require.resolve("../../lib/coordination/anchor-authorization");
  const cached = require.cache[modulePath];
  delete require.cache[modulePath];
  const stubbed = require(modulePath);
  return {
    calls,
    module: stubbed,
    restore() {
      childProcess.execFileSync = real;
      delete require.cache[modulePath];
      if (cached) require.cache[modulePath] = cached;
    },
  };
}

// The PowerShell script the product ships reads the paths from STDIN. This
// stub reproduces the real semantics closely enough to catch the defect the
// live measurement found: `powershell.exe -Command <script> <args...>`
// APPENDS the trailing arguments to the LAST command of the script, so a
// script ending in `ConvertTo-Json ... -Compress` fails with
// "A positional parameter cannot be found that accepts argument 'D:'".
// A script that reads STDIN works as long as stdin is piped.
function emulatePowerShell(record) {
  const script = record.argv[3] || "";
  const trailing = record.argv.slice(4);
  const readsStdin = script.indexOf("[Console]::In.ReadToEnd()") !== -1;
  const lastCommand = script.slice(script.lastIndexOf(";") + 1).trim();
  const lastCommandTakesNoPositional = /ConvertTo-Json/.test(lastCommand);

  if (trailing.length > 0) {
    if (lastCommandTakesNoPositional) {
      return {
        status: 1,
        stdout: "",
        stderr: "ConvertTo-Json : A positional parameter cannot be found that accepts argument '"
          + trailing[0] + "'.",
      };
    }
    if (readsStdin) {
      return { status: 0, stdout: JSON.stringify(trailing) };
    }
    return { status: 0, stdout: "" };
  }

  if (!readsStdin) return { status: 0, stdout: "" };
  if (record.stdin === null) {
    return {
      status: 1,
      stdout: "",
      stderr: "Get-Acl : Cannot validate argument on parameter 'LiteralPath'. The argument is null or empty.",
    };
  }
  let paths;
  try { paths = JSON.parse(record.stdin); }
  catch (e) { return { status: 1, stdout: "", stderr: "ConvertFrom-Json : " + e.message }; }
  if (!Array.isArray(paths)) paths = [paths];
  const list = paths.map((p) => ({
    Path: p,
    Owner: OWNER_BY_PATH[p] || "S-1-5-18",
    CurrentSid: "S-1-5-21-1000-1001",
    Groups: [],
    Access: [{ Sid: "S-1-5-18", Type: "Allow", Rights: "FullControl" }],
  }));
  return { status: 0, stdout: JSON.stringify(list.length === 1 ? list[0] : list) };
}

// The owner each stubbed path reports. Two DIFFERENT paths with two
// DIFFERENT owners is what makes the "the paths really arrived" assertion
// meaningful: a call that lost its arguments can only ever return the same
// owner for both.
const OWNER_BY_PATH = {
  "D:\\anchor-one": "S-1-5-80-1111-2222-3333-4444-5555",
  "D:\\anchor-two": "S-1-5-32-544",
};

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A fake adapter: the writable identities of a path are given by name.
function fakeAdapter(map, current, normalized) {
  return {
    writableIdentities: (targetPath) => {
      const value = map.get(targetPath);
      return value === undefined ? null : new Set(value);
    },
    writableIdentitiesBatch: null,
    currentIdentity: () => current,
    normalizeIdentity: (value) => (normalized ? normalized(value) : value),
  };
}

test("MS-003 the adapter reports a null writer set when the platform model cannot be read", () => {
  // null means "cannot be enumerated". It is not the same as an empty set,
  // which would mean "nobody can write".
  const adapter = fakeAdapter(new Map(), null);
  const dir = tempDir("m044-authz-");
  try {
    assert.equal(adapter.writableIdentities(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 the strict check refuses an anchor domain whose writers cannot be enumerated", () => {
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  try {
    const adapter = fakeAdapter(new Map(), "sid:S-1-5-18");
    assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, anchor.ANCHOR_MODE.strict, "sid:S-1-5-18", { adapter }
    ), { code: "ERR_ANCHOR_AUTHORIZATION_UNKNOWN" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 the strict check refuses an anchor domain with a second writer", () => {
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  try {
    const adapter = fakeAdapter(
      new Map([[anchorDir, ["sid:S-1-5-18", "sid:S-1-5-21"]]]),
      "sid:S-1-5-18",
    );
    assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, anchor.ANCHOR_MODE.strict, "sid:S-1-5-18", { adapter }
    ), { code: "ERR_ANCHOR_WRITER_SET" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 the strict check refuses an anchor domain that the service identity cannot write", () => {
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  try {
    const adapter = fakeAdapter(
      new Map([[anchorDir, ["sid:S-1-5-21"]]]),
      "sid:S-1-5-18",
    );
    assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, anchor.ANCHOR_MODE.strict, "sid:S-1-5-18", { adapter }
    ), { code: "ERR_ANCHOR_WRITER_SET" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 the strict check refuses a calling process that is not the declared service identity", () => {
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  try {
    // The caller is not the declared service identity. Without this check
    // the writer set could be correct while the process running it is not
    // the service at all.
    const adapter = fakeAdapter(
      new Map([[anchorDir, ["sid:S-1-5-18"]]]),
      "sid:S-1-5-21",
    );
    assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, anchor.ANCHOR_MODE.strict, "sid:S-1-5-18", { adapter }
    ), { code: "ERR_ANCHOR_SERVICE_IDENTITY_MISMATCH" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 the strict check refuses a declared service identity that cannot be normalized", () => {
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  try {
    const adapter = fakeAdapter(
      new Map([[anchorDir, ["sid:S-1-5-18"]]]),
      "sid:S-1-5-18",
      () => null,
    );
    assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, anchor.ANCHOR_MODE.strict, "not-an-identity", { adapter }
    ), { code: "ERR_ANCHOR_SERVICE_IDENTITY_INVALID" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 the strict check refuses a writer set that includes every identity", () => {
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  try {
    const adapter = fakeAdapter(
      new Map([[anchorDir, [authz.ANY_IDENTITY]]]),
      "sid:S-1-5-18",
    );
    assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, anchor.ANCHOR_MODE.strict, "sid:S-1-5-18", { adapter }
    ), { code: "ERR_ANCHOR_PERMISSIONS" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 the strict check accepts an anchor domain that only the service identity can write", () => {
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  try {
    const adapter = fakeAdapter(
      new Map([[anchorDir, ["sid:S-1-5-18"]]]),
      "sid:S-1-5-18",
    );
    assert.doesNotThrow(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, anchor.ANCHOR_MODE.strict, "sid:S-1-5-18", { adapter }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 the permissive mode does not consult the authorization model", () => {
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o777 });
  try {
    const adapter = fakeAdapter(new Map(), null);
    assert.doesNotThrow(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, anchor.ANCHOR_MODE.permissive, null, { adapter }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 the POSIX adapter reads the writable identities from the mode bits", () => {
  const dir = tempDir("m044-authz-");
  try {
    fs.chmodSync(dir, 0o700);
    const writers = authz.posixWritableIdentities(dir);
    assert.equal(writers.size, 1);
    assert.ok(writers.has("uid:" + process.getuid()));
    fs.chmodSync(dir, 0o702);
    const other = authz.posixWritableIdentities(dir);
    assert.ok(other.has(authz.ANY_IDENTITY));
    fs.chmodSync(dir, 0o720);
    const group = authz.posixWritableIdentities(dir);
    assert.ok(group.has(authz.ANY_IDENTITY));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 the macOS adapter sees a named ACL entry that the mode bits cannot", () => {
  if (process.platform !== "darwin") return;
  const dir = tempDir("m044-authz-acl-");
  try {
    fs.chmodSync(dir, 0o700);
    // The mode bits say owner-only, while the ACL says staff may write.
    // The old check accepted this shape.
    const before = authz.macosWritableIdentities(dir);
    assert.ok(!before.has(authz.ANY_IDENTITY));
    const { execFileSync } = require("node:child_process");
    try {
      execFileSync("/bin/chmod", ["+a", "staff allow write,delete", dir]);
    } catch {
      // The host does not allow the ACL to be set; the negative half of this
      // test needs it, so the negative half stands alone.
      return;
    }
    const after = authz.macosWritableIdentities(dir);
    assert.ok(after.has(authz.ANY_IDENTITY),
      "a named group ACL that grants write must make the writer set unbounded");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 the Windows adapter treats a broad group as an unbounded writer set", () => {
  // The broad group list is what keeps an ACE for BUILTIN\\Users or
  // BUILTIN\\Administrators from being folded into the caller identity: the
  // members of those groups are ordinary processes, not the service.
  const snapshot = {
    Owner: "S-1-5-32-544",
    CurrentSid: "S-1-5-21-1-2-3-1001",
    Groups: ["S-1-5-32-544"],
    Access: [
      { Sid: "S-1-5-32-544", Type: "Allow", Rights: "FullControl" },
    ],
  };
  const writers = authz.windowsWritersFromSnapshot(snapshot);
  assert.ok(writers.has(authz.ANY_IDENTITY),
    "an ACE for Administrators must not be folded into the caller identity");
});

test("MS-003 a broad group that owns the object is an unbounded writer set", () => {
  // The owner may always change the ACL of the object it owns, so a broad
  // group that owns it is a broad writer even without any ACE. Reporting it
  // as a concrete identity would hide that ordinary processes can write it.
  const snapshot = {
    Owner: "S-1-5-32-544",
    CurrentSid: "S-1-5-21-1-2-3-1001",
    Groups: [],
    Access: [],
  };
  const writers = authz.windowsWritersFromSnapshot(snapshot);
  assert.ok(writers.has(authz.ANY_IDENTITY),
    "a broad group owner must not be reported as a single concrete identity");
});

test("MS-003 the broad group table is shared between the adapter and the ancestor check", () => {
  // The two used to carry separate lists, and six real Windows groups were
  // recognised by one and not the other. The ancestor check asks the
  // adapter, so the lists cannot drift apart any more.
  const groups = [
    "S-1-1-0", "S-1-5-11", "S-1-5-32-545", "S-1-5-32-544", "S-1-5-32-546",
    "S-1-5-32-555", "S-1-5-32-547", "S-1-5-15", "S-1-5-64-10", "S-1-5-64-14",
    "S-1-5-113",
  ];
  for (const sid of groups) {
    assert.ok(authz.windowsIsBroadGroupSid(sid),
      `${sid} must be recognised as a broad group`);
  }
  assert.equal(authz.windowsIsBroadGroupSid("S-1-5-18"), false,
    "SYSTEM is not a broad group");
  assert.equal(authz.windowsIsBroadGroupSid("S-1-5-21-1-2-3-1001"), false,
    "an ordinary user SID is not a broad group");
});

test("MS-003 a narrow group keeps its group SID instead of being folded into the caller", () => {
  // Folding the group into the caller asserted that only the caller can
  // write, while in fact every member of the group can. The reported set
  // has to stay truthful: the group SID stays, so a group that is not the
  // declared service identity fails the comparison for the right reason.
  const snapshot = {
    Owner: "S-1-5-21-1-2-3-1001",
    CurrentSid: "S-1-5-21-1-2-3-1001",
    Groups: ["S-1-5-21-1-2-3-2002"],
    Access: [
      { Sid: "S-1-5-21-1-2-3-2002", Type: "Allow", Rights: "FullControl" },
    ],
  };
  const writers = authz.windowsWritersFromSnapshot(snapshot);
  assert.ok(writers.has("sid:S-1-5-21-1-2-3-2002"),
    "the group SID must stay in the writer set");
});

test("MS-003 an ACE without a SID makes the whole writer batch undeterminable", () => {
  // The batch used to put the null into the map, and the first .has() on it
  // raised an unregistered TypeError, which replaced the fail-closed gate
  // with a crash. The whole batch has to degrade to "cannot be determined".
  const fakeSnapshot = {
    Owner: "S-1-5-18",
    CurrentSid: "S-1-5-18",
    Groups: [],
    Access: [{ Sid: "", Type: "Allow", Rights: "FullControl" }],
  };
  // The single path reports "cannot be determined"...
  const writers = authz.windowsWritersFromSnapshot(fakeSnapshot);
  assert.equal(writers, null,
    "an ACE without a SID must not yield a writer set");

  // ...and the batch must not degrade that into a map entry that is not a
  // set. One undeterminable path among several makes the whole batch
  // undeterminable, because the caller has to refuse either way.
  const paths = ["/anchor/a", "/anchor/b", "/anchor/c"];
  const map = authz.writersFromSnapshots(paths, (targetPath) => {
    if (targetPath === "/anchor/b") return null;
    return new Set(["sid:S-1-5-18"]);
  });
  assert.equal(map, null,
    "a path whose writer set is unknown must make the whole batch unknown");

  // A fully determinable batch still produces the map.
  const good = authz.writersFromSnapshots(paths, () => new Set(["sid:S-1-5-18"]));
  assert.equal(good.size, 3);
  for (const value of good.values()) {
    assert.ok(value instanceof Set, "every entry has to be a writer set");
  }
});

test("MS-003 the strict check refuses an anchor domain whose writer set is null", () => {
  // The registered fail-closed code has to be what surfaces, not an
  // unregistered TypeError from calling .has() on a null set.
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  try {
    const adapter = {
      writableIdentities: () => null,
      writableIdentitiesBatch: () => new Map([[anchorDir, null]]),
      currentIdentity: () => "sid:S-1-5-18",
      normalizeIdentity: (value) => value,
    };
    assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, "strict", "sid:S-1-5-18", { adapter },
    ), (error) => error.code === "ERR_ANCHOR_AUTHORIZATION_UNKNOWN",
    "a null writer set must fail closed with the registered code");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 the Windows check refuses to run without a declared service identity", () => {
  // Falling back to the caller's own identity made the impostor check a
  // tautology on Windows, where the caller is not the service. The
  // declaration is mandatory there; on POSIX the fallback stays, because
  // the owner of the witnesses has to be the service there.
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  try {
    const adapter = {
      writableIdentities: () => new Set(["sid:S-1-5-18"]),
      writableIdentitiesBatch: null,
      currentIdentity: () => "sid:S-1-5-18",
      normalizeIdentity: (value) => value,
    };
    assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, "strict", undefined, { adapter, platform: "windows" },
    ), (error) => error.code === "ERR_ANCHOR_SERVICE_IDENTITY_INVALID",
    "Windows must require an explicit service identity declaration");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 the ancestor chain refuses a null writer set with the registered code", () => {
  // The anchor domain check got the explicit null guard first; the ancestor
  // check -- which consumes the same writer map -- was left with only the
  // undefined guard. hasBroadWriter() iterates the set, so a null entry
  // raised an unregistered TypeError there and replaced the fail-closed
  // gate with a crash. The two checks have to guard at the same strength.
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  const realPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const adapter = {
      // The anchor domain itself is fine; the ancestor is not determinable.
      writableIdentities: () => new Set(["sid:S-1-5-18"]),
      writableIdentitiesBatch: (paths) => {
        const map = new Map();
        for (const p of paths) {
          map.set(p, p === anchorDir ? new Set(["sid:S-1-5-18"]) : null);
        }
        return map;
      },
      currentIdentity: () => "sid:S-1-5-18",
      currentGroups: () => new Set(["sid:S-1-5-18"]),
      normalizeIdentity: (value) => value,
    };
    assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, "strict", "sid:S-1-5-18", { adapter },
    ), (error) => error.code === "ERR_ANCHOR_AUTHORIZATION_UNKNOWN",
    "a null ancestor writer set must fail closed with the registered code");
    assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, "strict", "sid:S-1-5-18", { adapter },
    ), (error) => !(error instanceof TypeError),
    "the refusal must not be an unregistered TypeError");
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 a service virtual account SID is accepted as the service's own group", () => {
  // A Windows service virtual account has an SID the platform derives from
  // the service name, and only that service's own token carries it. Granting
  // it write access therefore grants exactly one identity. The set
  // {service, service-virtual-account} describes that single writer
  // truthfully and has to be accepted.
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  const SERVICE_SID = "sid:S-1-5-80-1234-567890123456-1234567890-1234567890";
  try {
    const adapter = {
      writableIdentities: () => new Set(["sid:S-1-5-18", SERVICE_SID]),
      writableIdentitiesBatch: (paths) => {
        const map = new Map();
        for (const p of paths) map.set(p, new Set(["sid:S-1-5-18", SERVICE_SID]));
        return map;
      },
      currentIdentity: () => "sid:S-1-5-18",
      currentGroups: () => new Set([SERVICE_SID]),
      ownerIdentity: () => "sid:S-1-5-18",
      normalizeIdentity: (value) => value,
    };
    anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, "strict", "sid:S-1-5-18", { adapter },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 a group that merely contains the service is still a second writer", () => {
  // A group that CONTAINS the service also contains its other members, and
  // those members can write too. Accepting such a group would undo the
  // ninth-round fix, so it stays refused -- and it is refused as a plain
  // second writer, not as an undeterminable authorization model.
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  const OTHER_GROUP = "sid:S-1-5-21-9-8-7-600";
  try {
    const adapter = {
      writableIdentities: () => new Set(["sid:S-1-5-18", OTHER_GROUP]),
      writableIdentitiesBatch: (paths) => {
        const map = new Map();
        for (const p of paths) map.set(p, new Set(["sid:S-1-5-18", OTHER_GROUP]));
        return map;
      },
      currentIdentity: () => "sid:S-1-5-18",
      currentGroups: () => new Set([OTHER_GROUP]),
      ownerIdentity: () => "sid:S-1-5-18",
      normalizeIdentity: (value) => value,
    };
    assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, "strict", "sid:S-1-5-18", { adapter },
    ), { code: "ERR_ANCHOR_WRITER_SET" },
    "a group that merely contains the service must stay refused");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 a service virtual account the caller does not hold is refused", () => {
  // The SID shape alone is not enough: the grant has to belong to THIS
  // process, so that a namesake grant cannot pass the check.
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  const SERVICE_SID = "sid:S-1-5-80-1234-567890123456-1234567890-1234567890";
  try {
    const adapter = {
      writableIdentities: () => new Set(["sid:S-1-5-18", SERVICE_SID]),
      writableIdentitiesBatch: (paths) => {
        const map = new Map();
        for (const p of paths) map.set(p, new Set(["sid:S-1-5-18", SERVICE_SID]));
        return map;
      },
      currentIdentity: () => "sid:S-1-5-18",
      currentGroups: () => new Set(),
      ownerIdentity: () => "sid:S-1-5-18",
      normalizeIdentity: (value) => value,
    };
    assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, "strict", "sid:S-1-5-18", { adapter },
    ), { code: "ERR_ANCHOR_WRITER_SET" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 the POSIX platform keeps the caller fallback when the platform is named", () => {
  // The fallback used to be decided by "opts.platform is undefined", so the
  // two ways of saying the same thing disagreed: leaving the platform out
  // fell back to the caller, while naming "posix" disabled the fallback and
  // failed. The fallback is a property of the resolved platform now.
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  try {
    const adapter = {
      writableIdentities: () => new Set(["uid:" + process.getuid()]),
      writableIdentitiesBatch: null,
      currentIdentity: () => "uid:" + process.getuid(),
      currentGroups: () => new Set(["uid:" + process.getuid()]),
      ownerIdentity: () => "uid:" + process.getuid(),
      normalizeIdentity: (value) => value,
    };
    anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, "strict", undefined, { adapter, platform: "posix" },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 an owner that is not the service identity is reported as its own failure", () => {
  // The owner may always rewrite the ACL of the object it owns, so an owner
  // that is not the service is a second writer that no ACE describes. It
  // used to be reported as the writer-set error, which described a
  // different failure and left the owner error code unreachable.
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  try {
    const adapter = {
      writableIdentities: () => new Set(["sid:S-1-5-18"]),
      writableIdentitiesBatch: (paths) => {
        const map = new Map();
        for (const p of paths) map.set(p, new Set(["sid:S-1-5-18"]));
        return map;
      },
      currentIdentity: () => "sid:S-1-5-18",
      currentGroups: () => new Set(["sid:S-1-5-18"]),
      ownerIdentity: () => "sid:S-1-5-32-544",
      normalizeIdentity: (value) => value,
    };
    assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, "strict", "sid:S-1-5-18", { adapter },
    ), { code: "ERR_ANCHOR_OWNERSHIP" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 the service virtual account SID shape is recognised", () => {
  // A real per-service SID is SHA1(service name in UTF-16LE, upper-cased)
  // cut into little-endian DWORDs. The digest is 20 bytes, so the derived
  // form carries five segments. The segment count is not a security
  // property, so any positive number of numeric segments is accepted.
  assert.equal(authz.isServiceVirtualAccountSid("sid:S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"), true);
  assert.equal(authz.isServiceVirtualAccountSid("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"), true);
  assert.equal(authz.isServiceVirtualAccountSid("sid:S-1-5-80-1-2-3-4"), true);
  assert.equal(authz.isServiceVirtualAccountSid("S-1-5-80-1-2-3-4"), true);
  assert.equal(authz.isServiceVirtualAccountSid("sid:S-1-5-80-1-2-3"), true);
  assert.equal(authz.isServiceVirtualAccountSid("S-1-5-80-1-2-3"), true);
  assert.equal(authz.isServiceVirtualAccountSid("sid:S-1-5-80-1"), true);
  // The fixed "all services" SID is shared by every service and is never a
  // per-service identity, so it must not be accepted.
  assert.equal(authz.isServiceVirtualAccountSid("sid:S-1-5-80-0"), false);
  assert.equal(authz.isServiceVirtualAccountSid("S-1-5-80-0"), false);
  assert.equal(authz.isServiceVirtualAccountSid("sid:S-1-5-32-544"), false);
  assert.equal(authz.isServiceVirtualAccountSid("sid:S-1-5-18"), false);
  assert.equal(authz.isServiceVirtualAccountSid("uid:0"), false);
  assert.equal(authz.isServiceVirtualAccountSid(null), false);
  assert.equal(authz.isServiceVirtualAccountSid("sid:S-1-5-80-a-b-c-d"), false);
  assert.equal(authz.isServiceVirtualAccountSid("sid:S-1-5-80-"), false);
  assert.equal(authz.isServiceVirtualAccountSid("sid:S-1-5-80"), false);
  assert.equal(authz.isServiceVirtualAccountSid("sid:S-1-5-80-1-2-3-4-5-6"), true);
});

test("MS-003 the all-services SID is refused as a service virtual account", () => {
  // S-1-5-80-0 is the fixed "all services" SID. It is not derived from a
  // service name and every service token carries it, so granting it write
  // access grants write access to every service. Accepting it would turn
  // "exactly one writer" into "any service may write".
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  const ALL_SERVICES = "sid:S-1-5-80-0";
  const realPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const adapter = {
      writableIdentities: () => new Set(["sid:S-1-5-18", ALL_SERVICES]),
      writableIdentitiesBatch: (paths) => {
        const map = new Map();
        for (const p of paths) map.set(p, new Set(["sid:S-1-5-18", ALL_SERVICES]));
        return map;
      },
      currentIdentity: () => "sid:S-1-5-18",
      currentGroups: () => new Set(["sid:S-1-5-18", ALL_SERVICES]),
      ownerIdentity: () => "sid:S-1-5-18",
      normalizeIdentity: (value) => value,
    };
    assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, "strict", "sid:S-1-5-18", { adapter },
    ), (error) => error.code === "ERR_ANCHOR_WRITER_SET",
    "the all-services SID must not be accepted as a single writer");
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 a writer set that is not a Set fails closed with the registered code", () => {
  // The ancestor chain refuses an uninspectable writer set through
  // hasBroadWriter(); the anchor domain consumes the same map and had no
  // equivalent guard, so a non-Set value raised an unregistered TypeError
  // there. Both paths have to refuse at the same strength.
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  const realPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    for (const bad of ["S-1-5-18", 42, ["sid:S-1-5-18"], {}]) {
      const adapter = {
        writableIdentities: () => bad,
        writableIdentitiesBatch: (paths) => {
          const map = new Map();
          for (const p of paths) map.set(p, bad);
          return map;
        },
        currentIdentity: () => "sid:S-1-5-18",
        currentGroups: () => new Set(["sid:S-1-5-18"]),
        ownerIdentity: () => "sid:S-1-5-18",
        normalizeIdentity: (value) => value,
      };
      assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
        anchorDir, "strict", "sid:S-1-5-18", { adapter },
      ), (error) => error.code === "ERR_ANCHOR_AUTHORIZATION_UNKNOWN",
      "a writer set that is not a Set must fail closed with the registered code");
      assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
        anchorDir, "strict", "sid:S-1-5-18", { adapter },
      ), (error) => !(error instanceof TypeError),
      "the refusal must not be an unregistered TypeError");
    }
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MS-003 a group list that is not a Set fails closed with the registered code", () => {
  // The membership list comes from the process token. A token read that
  // fails, returns something other than a Set, or throws must all be
  // "unknown", and unknown fails closed with the registered code -- not
  // with an unregistered TypeError that the caller would dress up as an
  // unrelated diagnostic.
  const dir = tempDir("m044-authz-");
  const anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  const SERVICE_SID = "sid:S-1-5-80-1234-567890123456-1234567890-1234567890";
  const realPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const base = {
      writableIdentities: () => new Set(["sid:S-1-5-18", SERVICE_SID]),
      writableIdentitiesBatch: (paths) => {
        const map = new Map();
        for (const p of paths) map.set(p, new Set(["sid:S-1-5-18", SERVICE_SID]));
        return map;
      },
      currentIdentity: () => "sid:S-1-5-18",
      ownerIdentity: () => "sid:S-1-5-18",
      normalizeIdentity: (value) => value,
    };
    for (const bad of [null, undefined, "sid:S-1-5-18", 42, ["sid:S-1-5-18"]]) {
      const adapter = { ...base, currentGroups: () => bad };
      assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
        anchorDir, "strict", "sid:S-1-5-18", { adapter },
      ), (error) => error.code === "ERR_ANCHOR_AUTHORIZATION_UNKNOWN",
      "a membership list that is not a Set must fail closed with the registered code");
    }
    // An adapter whose token read throws must not let the exception escape.
    const throwing = {
      ...base,
      currentGroups: () => { throw new Error("token read failed"); },
    };
    assert.throws(() => anchor.assertAnchorPermissionsWithIdentity(
      anchorDir, "strict", "sid:S-1-5-18", { adapter: throwing },
    ), (error) => error.code === "ERR_ANCHOR_AUTHORIZATION_UNKNOWN",
    "a throwing membership read must fail closed with the registered code");
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The Windows DACL read: the paths have to REACH the PowerShell script.
//
// A live measurement on the Windows host (M-044 MS-003, 2026-10-27) found
// that windowsAclSnapshot() and windowsAclSnapshotBatch() returned null on
// EVERY path on Windows. The cause was the argument shape of the call:
//
//     powershell.exe -NoProfile -NonInteractive -Command <script> - <paths...>
//
// `-Command` APPENDS the trailing arguments to the LAST command of the
// script. The script ended in
//
//     $result | ConvertTo-Json -Depth 5 -Compress
//
// so it became
//
//     $result | ConvertTo-Json -Depth 5 -Compress - D:\path
//
// and ConvertTo-Json has no positional parameter that accepts "D:\path":
//
//     ConvertTo-Json : A positional parameter cannot be found that accepts
//     argument 'D:'.
//
// -> exit code 1 -> execFileSync throws -> the catch block returns null.
//
// The consequence was not a narrow one: the writer set, the owner and the
// ancestor chain all come from the DACL snapshot, so on the TARGET platform
// every one of those judgements was stuck at the fail-closed "unknown"
// branch and could not be proven at all.
//
// The fix passes the paths on STDIN. The tests below pin the argument shape
// so the defect cannot come back unnoticed, and they pin the CONTENT so a
// call that loses or mangles its paths cannot pass either.
// ─────────────────────────────────────────────────────────────────────────────

test("MS-003 the Windows DACL read delivers its paths to the snapshot script", () => {
  // The single-path read. Before the fix this returned null on Windows for
  // every path; the owner below is what a readable DACL actually yields.
  const stub = installPowerShellStub(emulatePowerShell);
  try {
    const snapshot = stub.module.windowsAclSnapshot("D:\\anchor-one");
    assert.notEqual(snapshot, null,
      "the DACL snapshot must not be null: a null means the authorization model is unknown");
    assert.equal(snapshot.Owner, "S-1-5-80-1111-2222-3333-4444-5555");
    assert.equal(snapshot.Path, "D:\\anchor-one");

    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    // The paths must NOT be trailing command-line arguments: that is the
    // carrier that made ConvertTo-Json fail on every path.
    assert.deepEqual(call.argv.slice(4), [],
      "the snapshot call must not append the paths to the command line");
    // The paths must arrive on STDIN, and STDIN must be piped or the payload
    // is discarded before the script ever sees it.
    assert.equal(call.stdio[0], "pipe",
      "stdin must be piped, otherwise the path payload is dropped");
    assert.deepEqual(JSON.parse(call.stdin), ["D:\\anchor-one"]);
  } finally {
    stub.restore();
  }
});

test("MS-003 the Windows batch DACL read keeps each path paired with its own owner", () => {
  // The regression case for the exact defect: TWO DIFFERENT paths with TWO
  // DIFFERENT owners. A call that loses its arguments can only produce one
  // owner for both, so this assertion cannot be satisfied by a broken call.
  const stub = installPowerShellStub(emulatePowerShell);
  try {
    const paths = ["D:\\anchor-one", "D:\\anchor-two"];
    const batch = stub.module.windowsAclSnapshotBatch(paths);
    assert.notEqual(batch, null,
      "the DACL snapshot batch must not be null: a null means the authorization model is unknown");
    assert.equal(batch.size, 2);
    assert.equal(batch.get("D:\\anchor-one").Owner, "S-1-5-80-1111-2222-3333-4444-5555");
    assert.equal(batch.get("D:\\anchor-two").Owner, "S-1-5-32-544");
    // Each path must be present under its OWN key, so the map is not merely
    // right in size but right in content.
    assert.deepEqual(Array.from(batch.keys()).sort(), paths.slice().sort());

    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    assert.deepEqual(call.argv.slice(4), [],
      "the batch snapshot call must not append the paths to the command line");
    assert.equal(call.stdio[0], "pipe",
      "stdin must be piped, otherwise the path payload is dropped");
    assert.deepEqual(JSON.parse(call.stdin), paths);
  } finally {
    stub.restore();
  }
});

test("MS-003 the Windows DACL read would fail if the paths went back on the command line", () => {
  // This test states the failure mode explicitly, so the fix cannot be
  // reverted to the command-line form by a later reader who believes it is
  // equivalent. The stub reproduces PowerShell's real behaviour: trailing
  // arguments are appended to the LAST command of the script, and the last
  // command here is a ConvertTo-Json that accepts no positional argument.
  const stub = installPowerShellStub(emulatePowerShell);
  try {
    const argv = ["-NoProfile", "-NonInteractive", "-Command",
      "$result | ConvertTo-Json -Depth 5 -Compress", "-", "D:\\anchor-one"];
    const outcome = emulatePowerShell({ argv, stdio: ["pipe", "pipe", "pipe"], stdin: null });
    assert.equal(outcome.status, 1,
      "the command-line form must be shown to fail, otherwise this test proves nothing");
    assert.match(outcome.stderr, /positional parameter cannot be found/);
  } finally {
    stub.restore();
  }
});

test("MS-003 the Windows writer set is derived from the delivered DACL snapshot", () => {
  // The judgement that was unreachable on Windows: the writer set of a path
  // whose DACL grants write to exactly one service virtual account.
  const stub = installPowerShellStub(emulatePowerShell);
  try {
    const writers = stub.module.windowsWritableIdentities("D:\\anchor-one");
    assert.notEqual(writers, null,
      "the writer set must be enumerable; null is the unknown that failed closed");
    assert.ok(writers instanceof Set);
    // The owner is always a writer, and the stub's DACL grants FullControl to
    // SYSTEM, so the set carries the owner and the ACE identity.
    assert.ok(writers.has("sid:S-1-5-80-1111-2222-3333-4444-5555"));
  } finally {
    stub.restore();
  }
});
