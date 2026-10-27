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
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const authz = require("../../lib/coordination/anchor-authorization");
const anchor = require("../../lib/coordination/protected-anchor");

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
