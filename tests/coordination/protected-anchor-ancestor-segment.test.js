"use strict";

// Tests for the controlled ancestor segment of the protected anchor.
//
// A Windows volume root carries an inherent ACE that grants Authenticated
// Users the right to create children (AppendData / AddSubdirectory). That
// right lets anybody create a NEW directory next to the anchor domain; it
// does NOT let anybody rewrite the anchor domain's ACL, delete it, or
// replace it. Counting it as "the anchor domain can be replaced" was
// semantically wrong, and it made a protected deployment impossible on
// every Windows volume.
//
// The deployment therefore declares the anchor domain's controlled
// ancestor path explicitly. The product judges that segment and everything
// below it, and RECORDS the ancestors above it without judging them.
//
// The tests below pin both halves of that contract:
//
//   (a) a declared segment whose interior is clean passes;
//   (b) a declared segment whose interior has a broad writer is still
//       refused with ERR_ANCHOR_PERMISSIONS;
//   (c) without the declaration the previous behaviour is kept: the whole
//       chain is judged, so a broad writer on the volume root refuses;
//   (d) an undeterminable writer set is still refused with
//       ERR_ANCHOR_AUTHORIZATION_UNKNOWN;
//   (e) the skipped ancestors are recorded.
//
// The Windows behaviour is exercised on every host by pinning the
// platform, because the deployment that matters is the Windows one and the
// test has to run where the CI runs.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const anchor = require("../../lib/coordination/protected-anchor");

const SERVICE_SID = "sid:S-1-5-80-1234-567890123456-1234567890";
// Authenticated Users: a broad group on Windows. Its ACE on a volume root
// grants the right to create children, which is the exact case the
// controlled ancestor segment exists for.
const BROAD_SID = "sid:S-1-5-11";

// The anchor chain used by the tests below, ordered from the closest
// ancestor of the anchor domain up to the volume root.
const CHAIN = ["D:\\anchor", "D:\\m044-sva-svc", "D:\\"];

// An adapter whose writer set is decided per path. The anchor domain
// itself and the controlled segment are clean; the volume root carries the
// broad group.
function windowsAdapter(overrides) {
  const writers = new Map(Object.entries(overrides || {}));
  return {
    writableIdentities: (targetPath) => {
      const value = writers.get(targetPath);
      return value === undefined ? new Set([SERVICE_SID]) : new Set(value);
    },
    writableIdentitiesBatch: (targetPaths) => {
      const map = new Map();
      for (const targetPath of targetPaths) {
        const value = writers.get(targetPath);
        map.set(targetPath, value === undefined ? new Set([SERVICE_SID]) : new Set(value));
      }
      return map;
    },
    currentIdentity: () => SERVICE_SID,
    currentGroups: () => new Set([SERVICE_SID]),
    ownerIdentity: () => SERVICE_SID,
    normalizeIdentity: (value) => value,
  };
}

// Run a body with the platform pinned to Windows, so the Windows branch of
// the ancestor check is the one under test.
function asWindows(body) {
  const realPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    return body();
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  }
}

// The verdict the ancestor check reaches for a chain, without touching the
// file system. The chain is passed in directly, so the test states the
// deployment shape instead of depending on where the temporary directory
// happens to live.
function judge(chain, options, adapter) {
  return asWindows(() => anchor.assertAncestorsNotReplaceable(
    chain, adapter, SERVICE_SID, options || {},
  ));
}

test("MS-003 a declared controlled ancestor segment lets the volume root be skipped", () => {
  // (a) The controlled segment D:\m044-sva-svc is judged and clean; the
  // volume root D:\ -- which carries the broad Authenticated Users ACE --
  // is above the declared segment, so it is recorded instead of judged.
  const adapter = windowsAdapter({ "D:\\": [BROAD_SID] });
  const verdict = judge(CHAIN, { controlledAncestorPath: "D:\\m044-sva-svc" }, adapter);
  assert.equal(verdict.status, "applied");
  assert.deepEqual(verdict.judgedAncestors, ["D:\\anchor", "D:\\m044-sva-svc"]);
  assert.deepEqual(verdict.skippedAncestors, ["D:\\"]);
  assert.equal(verdict.controlledAncestorPath, "D:\\m044-sva-svc");
});

test("MS-003 a broad writer INSIDE the declared controlled segment is still refused", () => {
  // (b) The narrowing must not turn the controlled segment into a free
  // pass. A broad writer on the controlled segment itself -- the level
  // whose ACL decides whether the anchor domain can be renamed away --
  // is still refused with the same code.
  const adapter = windowsAdapter({ "D:\\m044-sva-svc": [BROAD_SID] });
  assert.throws(() => judge(CHAIN, { controlledAncestorPath: "D:\\m044-sva-svc" }, adapter),
    (error) => error.code === "ERR_ANCHOR_PERMISSIONS",
    "a broad writer inside the controlled segment must still be refused");
});

test("MS-003 the nearest ancestor of the anchor domain is always judged", () => {
  // A declaration that names the anchor domain's own parent cannot remove
  // that level from the judgement: the parent is the level whose writer
  // set decides whether the anchor domain can be renamed away and replaced.
  const adapter = windowsAdapter({ "D:\\anchor": [BROAD_SID] });
  assert.throws(() => judge(CHAIN, { controlledAncestorPath: "D:\\anchor" }, adapter),
    (error) => error.code === "ERR_ANCHOR_PERMISSIONS",
    "the nearest ancestor must be judged whatever the declaration says");
});

test("MS-003 without the declaration the whole chain is judged as before", () => {
  // (c) The narrowing only happens when the deployment declares the
  // controlled segment. Without the declaration the previous behaviour is
  // kept exactly: a broad writer on the volume root refuses the
  // deployment.
  const adapter = windowsAdapter({ "D:\\": [BROAD_SID] });
  assert.throws(() => judge(CHAIN, {}, adapter),
    (error) => error.code === "ERR_ANCHOR_PERMISSIONS",
    "without a declaration the volume root must still be judged");
  const verdict = judge(CHAIN, {}, windowsAdapter());
  assert.equal(verdict.status, "not-declared");
  assert.deepEqual(verdict.skippedAncestors, []);
});

test("MS-003 a declaration that names no ancestor of the anchor domain narrows nothing", () => {
  // A declaration that does not name a chain entry cannot select a
  // segment. It must not become a switch that turns the ancestor check
  // off, so the whole chain is judged and the volume root still refuses.
  for (const declaration of ["C:\\other", "D:\\not-on-the-chain", "  ", 42, {}, []]) {
    const adapter = windowsAdapter({ "D:\\": [BROAD_SID] });
    assert.throws(() => judge(CHAIN, { controlledAncestorPath: declaration }, adapter),
      (error) => error.code === "ERR_ANCHOR_PERMISSIONS",
      "an unusable declaration must narrow nothing");
  }
});

test("MS-003 an undeterminable writer set inside the controlled segment fails closed", () => {
  // (d) Unknown is unknown. A writer set that cannot be enumerated inside
  // the controlled segment is refused with the registered code, not with an
  // unregistered TypeError and not by being read as "not broad".
  const adapter = {
    writableIdentities: () => null,
    writableIdentitiesBatch: (targetPaths) => {
      const map = new Map();
      for (const targetPath of targetPaths) map.set(targetPath, null);
      return map;
    },
    currentIdentity: () => SERVICE_SID,
    currentGroups: () => new Set([SERVICE_SID]),
    ownerIdentity: () => SERVICE_SID,
    normalizeIdentity: (value) => value,
  };
  assert.throws(() => judge(CHAIN, { controlledAncestorPath: "D:\\m044-sva-svc" }, adapter),
    (error) => error.code === "ERR_ANCHOR_AUTHORIZATION_UNKNOWN",
    "an unknown writer set must fail closed with the registered code");
});

test("MS-003 the skipped ancestors are recorded next to the anchor", () => {
  // (e) A skipped ancestor is a deliberate, declared decision, so it has to
  // leave an auditable trace. The record lives next to the anchor, which
  // is outside the database rollback domain.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m044-segment-"));
  try {
    const verdict = {
      judgedAncestors: ["D:\\anchor", "D:\\m044-sva-svc"],
      skippedAncestors: ["D:\\"],
      controlledAncestorPath: "D:\\m044-sva-svc",
      status: "applied",
    };
    anchor.recordSkippedAncestors(root, verdict);
    const file = path.join(root, "protected-anchor-audit.log");
    assert.equal(fs.existsSync(file), true, "the skipped ancestors must leave a trace");
    const record = JSON.parse(fs.readFileSync(file, "utf8").trim());
    assert.equal(record.event, "anchor_ancestor_segment_narrowing");
    assert.deepEqual(record.skipped_ancestors, ["D:\\"]);
    assert.deepEqual(record.judged_ancestors, ["D:\\anchor", "D:\\m044-sva-svc"]);
    assert.equal(record.controlled_ancestor_path, "D:\\m044-sva-svc");
    assert.equal(record.status, "applied");

    // The same decision is not written over and over: the check runs on
    // every open, and an unbounded audit log would grow without limit.
    anchor.recordSkippedAncestors(root, verdict);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "an unchanged decision must not be written again");

    // The transaction audit writes to the same file, so the narrowing
    // record is usually NOT the last line. The whole log is searched, so
    // an unchanged decision is still not written again.
    fs.appendFileSync(file, JSON.stringify({ event: "transaction", at: "later" }) + "\n");
    anchor.recordSkippedAncestors(root, verdict);
    const interleaved = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(interleaved.length, 2,
      "an unchanged decision must not be written again after an interleaved record");

    // A DIFFERENT decision is written again: the trace has to follow the
    // declaration, not stay at the first one.
    anchor.recordSkippedAncestors(root, {
      ...verdict,
      controlledAncestorPath: "D:\\other",
      skippedAncestors: ["D:\\"],
    });
    const after = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(after.length, 3, "a changed decision must leave its own record");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MS-003 nothing is recorded when no ancestor was skipped", () => {
  // The whole chain was judged, so there is nothing to record and the
  // audit log must stay untouched.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m044-segment-"));
  try {
    anchor.recordSkippedAncestors(root, {
      judgedAncestors: ["D:\\anchor"],
      skippedAncestors: [],
      controlledAncestorPath: null,
      status: "not-declared",
    });
    assert.equal(fs.existsSync(path.join(root, "protected-anchor-audit.log")), false,
      "a fully judged chain must not produce a narrowing record");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MS-003 the POSIX branch keeps judging the whole chain", () => {
  // The narrowing answers a Windows volume-root semantics question. The
  // POSIX sticky-bit rule is left exactly as it was: a declaration has no
  // effect there.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m044-segment-"));
  try {
    const parent = path.join(root, "parent");
    fs.mkdirSync(parent);
    const original = fs.statSync(parent).mode & 0o7777;
    try {
      fs.chmodSync(parent, (original | 0o002) & 0o7777);
      assert.throws(() => anchor.assertAncestorsNotReplaceable(
        [parent], windowsAdapter(), SERVICE_SID, { controlledAncestorPath: parent },
      ), (error) => error.code === "ERR_ANCHOR_PERMISSIONS",
      "the POSIX rule must not be narrowed by a declaration");
    } finally {
      try { fs.chmodSync(parent, original); } catch { /* the directory is gone */ }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MS-003 the declaration is matched against the chain, whatever it is spelled", () => {
  // The deployment manifest names a path; the chain holds canonical paths.
  // A trailing separator and a different case name the same Windows
  // directory and must select the same segment. A path that names nothing
  // in the chain selects nothing.
  const chain = ["D:\\anchor", "D:\\m044-sva-svc", "D:\\"];
  for (const declaration of ["D:\\m044-sva-svc", "D:\\m044-sva-svc\\", "d:\\m044-sva-svc"]) {
    const verdict = judge(chain, { controlledAncestorPath: declaration }, windowsAdapter());
    assert.equal(verdict.status, "applied",
      "the same directory must select the same segment however it is spelled");
    assert.deepEqual(verdict.skippedAncestors, ["D:\\"]);
  }
});

test("MS-003 the judged set is always a non-empty prefix that contains the nearest ancestor", () => {
  // The structural invariants of the narrowing, stated once so that a later
  // change to the split cannot quietly break them:
  //
  //   * the judged set is never empty and is always a PREFIX of the chain
  //     (the chain runs from the nearest ancestor upwards), so the nearest
  //     ancestor -- the level whose writer set decides whether the anchor
  //     domain can be renamed away -- is always judged;
  //   * the skipped set is the complementary SUFFIX, so no ancestor is
  //     dropped between the two sets;
  //   * nothing is narrowed unless the declaration actually selected a
  //     segment.
  const chain = ["D:\\anchor-parent", "D:\\svc", "D:\\"];
  const declarations = [
    undefined, null, "", "   ", 42, {}, [], "C:\\x", "D:\\not-here",
    "D:\\anchor-parent", "D:\\svc", "D:\\", "D:\\anchor-parent\\",
  ];
  for (const declaration of declarations) {
    const verdict = anchor.splitControlledAncestors(chain, declaration);
    assert.ok(verdict.judged.length > 0,
      "the judged set must never be empty");
    assert.equal(verdict.judged.length + verdict.skipped.length, chain.length,
      "no ancestor may be dropped between the judged and the skipped set");
    for (let i = 0; i < verdict.judged.length; i += 1) {
      assert.equal(verdict.judged[i], chain[i],
        "the judged set must be a prefix of the chain");
    }
    for (let i = 0; i < verdict.skipped.length; i += 1) {
      assert.equal(verdict.skipped[i], chain[verdict.judged.length + i],
        "the skipped set must be the complementary suffix of the chain");
    }
    assert.ok(verdict.judged.includes(chain[0]),
      "the nearest ancestor of the anchor domain must always be judged");
    if (verdict.status !== "applied") {
      assert.equal(verdict.judged.length, chain.length,
        "nothing may be narrowed unless the declaration selected a segment");
    }
  }
});

test("MS-003 the strict check records the skipped ancestors of a real anchor domain", () => {
  // The end-to-end wiring: the product path (not just the helper) writes
  // the trace. The declared segment is the anchor domain's own parent, so
  // everything above it -- the temporary root and the rest of the real
  // chain -- is recorded instead of judged.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m044-segment-e2e-"));
  try {
    const parent = path.join(root, "controlled");
    const anchorDir = path.join(parent, "anchor");
    fs.mkdirSync(parent);
    fs.mkdirSync(anchorDir, { mode: 0o700 });
    const adapter = windowsAdapter();
    asWindows(() => {
      anchor.assertAnchorPermissionsWithIdentity(
        anchorDir, "strict", SERVICE_SID,
        { adapter, controlledAncestorPath: parent },
      );
    });
    const file = path.join(anchorDir, "protected-anchor-audit.log");
    assert.equal(fs.existsSync(file), true,
      "the strict check must leave the narrowing record next to the anchor");
    const record = JSON.parse(fs.readFileSync(file, "utf8").trim());
    assert.equal(record.event, "anchor_ancestor_segment_narrowing");
    assert.ok(Array.isArray(record.skipped_ancestors) && record.skipped_ancestors.length > 0,
      "the ancestors above the declared segment must be recorded");
    // The chain is walked over the canonical path, so the judged ancestors
    // are recorded in their canonical spelling (on macOS /var is a
    // symbolic link to /private/var).
    assert.ok(record.judged_ancestors.includes(fs.realpathSync(parent)),
      "the declared segment must be among the judged ancestors");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
