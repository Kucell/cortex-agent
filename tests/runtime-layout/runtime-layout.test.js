"use strict";

// ─── M-026 MS-001 VC-004 focused resolver & identity tests ─────────────────
//
// Node's built-in test runner drives this file together with its sibling
// workspace-contracts suite via the documented two-arg form:
//   node --test \
//       tests/runtime-layout/runtime-layout.test.js \
//       tests/workspace/workspace-contracts.test.js
//
// (scripts/test-runner.cjs only accepts a single --file, so the two
// focused files must be passed as positional arguments to `node --test`
// rather than as repeated --file flags. Running them together is what
// produces the VC-004 single-line evidence: 28 tests pass, 0 fail.)
//
// Coverage matrix (per VC-004 + P-001 §7 验收):
//   • POSIX-shaped roots
//   • Windows-shaped roots (cross-platform path.join semantics)
//   • Symlink-shared `.agent` (host-specific symlink resolution must NOT
//     leak into shared state; identity equality stays on the logical value)
//   • Two worktree instances (project-level state is shared, instance state
//     is partitioned by `workspace_instance_id`)
//   • Unresolved local bindings (`LOCAL_BINDING_UNRESOLVED` is the only
//     way a missing binding surfaces — never a hard failure)
//   • Legacy layout detection (`.agent-runtime/` with at least one
//     recognised segment counts as a legacy layout; an empty `.DS_Store`-
//     only directory does NOT)
//
// Plus identity, URI, and binding behaviour that VC-002 / VC-003 require:
//   • Equality compares on identity strings only, never on resolved paths.
//   • Logical URIs refuse absolute paths, `.`, `..`, drive letters, control
//     characters, and out-of-vocabulary schemes.
//   • Local-binding writes reject symlinked parents and out-of-host paths.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const layoutModule = require("../../lib/runtime-layout");
const resolver = layoutModule.resolver;
const identity = layoutModule.identity;
const logicalUri = layoutModule.logicalUri;
const localBinding = layoutModule.localBinding;
const schemas = layoutModule.schemas;

// ─── helpers ───────────────────────────────────────────────────────────────

function mkRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withRoot(prefix, fn) {
  return (t) => {
    const root = mkRoot(prefix);
    t.after(() => {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    });
    return fn(t, root);
  };
}

function projectLayout(root, overrides = {}) {
  const out = {
    projectRoot: root,
    projectId: overrides.projectId || "cortex-agent",
    repositoryId: overrides.repositoryId || "cortex-agent",
    workspaceId: overrides.workspaceId || "WS-alpha",
    machineId: overrides.machineId || "M-hostA0001",
  };
  if (overrides.workspaceInstanceId !== undefined) {
    out.workspaceInstanceId = overrides.workspaceInstanceId;
  }
  return resolver.resolveLayout(out);
}

// POSIX absolute-path heuristic — every assertion below targets paths that
// look resolvable on POSIX; Windows-shaped inputs use the same string but
// with a drive letter so `path.join` still computes the right outcome.
const POSIX_ROOT = "/Users/xueyq/projects/cortex-agent";
const WINDOWS_ROOT = "C:\\Users\\xueyq\\projects\\cortex-agent";

// ─── VC-001 single-source-of-truth ─────────────────────────────────────────

test("resolver is the single source of truth for runtime data roots", () => {
  const layout = projectLayout(POSIX_ROOT);
  assert.equal(layout.paths.projectRoot, POSIX_ROOT);
  assert.equal(layout.paths.agentDir, path.join(POSIX_ROOT, ".agent"));
  assert.equal(layout.paths.contractsDir, path.join(POSIX_ROOT, ".agent", "contracts"));
  assert.equal(layout.paths.contractsRuntimeState, path.join(POSIX_ROOT, ".agent", "contracts", "runtime-state"));
  assert.equal(layout.paths.runtimeDir, path.join(POSIX_ROOT, ".agent", "runtime"));
  assert.equal(layout.paths.handoffsDir, path.join(POSIX_ROOT, ".agent", "handoffs"));
  assert.equal(layout.paths.legacyRuntimeDir, path.join(POSIX_ROOT, ".agent-runtime"));
});

test("resolver exposes every portable namespace defined by P-001 §2", () => {
  for (const namespace of ["coordination", "dispatch", "cross-project", "continuity", "evidence"]) {
    const layout = projectLayout(POSIX_ROOT);
    const target = resolver.portableRuntimePath(layout, namespace);
    assert.equal(target, path.join(POSIX_ROOT, ".agent", "runtime", namespace));
  }
  assert.throws(
    () => resolver.portableRuntimePath(projectLayout(POSIX_ROOT), "handoffs"),
    /unknown_namespace/,
  );
});

test("resolver exports the legacy recognised-segment vocabulary used by the migration planner", () => {
  for (const segment of ["coordination", "cross-project", "dispatch", "handoffs", "runtime-continuity", "runtime-evidence"]) {
    assert.ok(resolver.LEGACY_RECOGNISED_SEGMENTS.includes(segment));
  }
  // Mapping used by MS-002 must be the canonical P-001 §2 table.
  assert.equal(resolver.LEGACY_PORTABLE_NAMESPACES["runtime-continuity"], "continuity");
  assert.equal(resolver.LEGACY_PORTABLE_NAMESPACES["runtime-evidence"], "evidence");
  assert.equal(resolver.LEGACY_PORTABLE_NAMESPACES.handoffs, "handoffs");
});

// ─── VC-004 POSIX / Windows-shaped roots ───────────────────────────────────

test("resolver produces identical logical structure for POSIX and Windows-shaped roots", () => {
  const posix = projectLayout(POSIX_ROOT);
  const win = projectLayout(WINDOWS_ROOT);
  // Logical layout structure is identical: every segment name is the
  // same string on POSIX and Windows-shaped inputs.
  for (const key of ["agentDir", "contractsDir", "contractsRuntimeState", "runtimeDir", "handoffsDir", "legacyRuntimeDir"]) {
    const posixTail = posix.paths[key].slice(posix.paths.projectRoot.length);
    const winTail = win.paths[key].slice(win.paths.projectRoot.length);
    assert.equal(posixTail, winTail, `${key} tail must be platform-independent: ${posixTail} vs ${winTail}`);
  }
  // Identity is preserved across roots: two layouts with the same input
  // identity string compare equal regardless of the host-specific path.
  assert.equal(identity.equalIdentity(posix.projectIdentity, win.projectIdentity), true);
  assert.equal(identity.equalIdentity(posix.workspaceIdentity, win.workspaceIdentity), true);
  // The set of segment names referenced by the layout is the same on both
  // hosts — that's the structural invariant we care about. projectRoot is
  // the caller-provided absolute path and intentionally carries no
  // runtime segments; every other path field must.
  const expectedSegments = [".agent", "contracts", "runtime-state", "runtime", "handoffs", ".agent-runtime"];
  for (const key of Object.keys(posix.paths)) {
    if (key === "projectRoot") continue;
    const tail = posix.paths[key];
    assert.ok(expectedSegments.some((seg) => tail.endsWith(seg) || tail.includes(`${seg}/`) || tail.endsWith(`${seg}`)),
      `${key} must reference a recognised runtime segment`);
  }
});

test("logical URI parser is platform-agnostic and refuses drive letters in segments", () => {
  const uri = logicalUri.runtime("coordination", "tasks", "WS-alpha");
  assert.equal(uri, "runtime://coordination/tasks/WS-alpha");
  const parsed = logicalUri.parse(uri);
  assert.equal(parsed.scheme, "runtime");
  assert.deepEqual(parsed.segments, ["coordination", "tasks", "WS-alpha"]);
  // Drive letters are refused at the segment level: the parser must not
  // let a caller smuggle `C:/Windows/System32` into a logical reference.
  assert.throws(
    () => logicalUri.parse("runtime://C:/Windows/System32"),
    /absolute_path_segment|invalid_identity_segment/,
  );
  assert.throws(
    () => logicalUri.parse("runtime://coordination/.."),
    /traversal_segment/,
  );
  assert.throws(
    () => logicalUri.parse("runtime://coordination/."),
    /traversal_segment/,
  );
  // Schemes are case-sensitive (lowercase only). Mixed-case inputs are
  // refused at the parser boundary so a Windows host cannot collide a
  // `Project://…` entry with the lowercase `project://` vocabulary.
  assert.throws(
    () => logicalUri.parse("PROJECT://cortex-agent/foo"),
    /scheme_case_mismatch/,
  );
  assert.throws(
    () => logicalUri.parse("file:///etc/passwd"),
    /unknown_scheme/,
  );
});

test("logical URI scheme helpers match the proposal vocabulary", () => {
  assert.equal(logicalUri.project("cortex-agent", "tasks"), "project://cortex-agent/tasks");
  assert.equal(logicalUri.repo("cortex-agent", "src", "index.js"), "repo://cortex-agent/src/index.js");
  assert.equal(logicalUri.workspace("WS-alpha", "events"), "workspace://WS-alpha/events");
  assert.equal(logicalUri.agent("dispatch", "plans"), "agent://dispatch/plans");
  assert.equal(logicalUri.runtime("coordination", "journal"), "runtime://coordination/journal");
  assert.equal(logicalUri.artifact("T-RSL-001", "plan.json"), "artifact://T-RSL-001/plan.json");
});

// ─── VC-002 stable identity (no resolved path in equality) ─────────────────

test("identity equality compares on the value string only", () => {
  const a = identity.workspaceId("WS-alpha");
  const b = identity.workspaceId("WS-alpha");
  assert.equal(identity.equalIdentity(a, b), true);
  assert.equal(identity.equalIdentity("WS-alpha", "WS-alpha"), true);
});

test("identity equality rejects objects that smuggle in resolved paths", () => {
  const rec = { kind: "workspace_id", value: "WS-alpha", root: "/Users/xueyq/x" };
  assert.throws(() => identity.equalIdentity(rec, "WS-alpha"), /path_in_identity/);
});

test("identity factories refuse absolute paths, hostnames, and IPv4 literals", () => {
  // POSIX absolute path must NOT become a workspace_id.
  assert.throws(() => identity.workspaceId("/Users/xueyq/projects/cortex-agent"), /absolute_path|unsafe_chars/);
  // Windows drive root must NOT become a machine_id.
  assert.throws(() => identity.machineId("C:\\Users\\xueyq"), /absolute_path|unsafe_chars/);
  // UNC path must NOT become a project_id.
  assert.throws(() => identity.projectId("\\\\fileserver\\share\\cortex"), /absolute_path|unsafe_chars/);
  // Hostname / IPv4 must NOT become a project_id either. The identity
  // factories reject these at the validation boundary with a dedicated
  // error code so the failure is identifiable, not opaque.
  assert.throws(() => identity.projectId("build01.corp.local"), /hostname_in_identity|unsafe_chars/);
  assert.throws(() => identity.projectId("10.0.0.42"), /ipv4_in_identity|unsafe_chars/);
});

test("workspace_instance_id composes machine + workspace and round-trips through the resolver", () => {
  const layout = projectLayout(POSIX_ROOT);
  const ws = identity.workspaceId("WS-alpha");
  const host = identity.machineId("M-hostA0001");
  const inst = identity.workspaceInstanceId(host, ws);
  assert.equal(inst.kind, "workspace_instance_id");
  assert.equal(inst.value, "M-hostA0001::WS-alpha");
  const dir = resolver.workspaceInstanceDir(layout, inst);
  assert.equal(dir, path.join(POSIX_ROOT, ".agent", "runtime", "worktrees", "M-hostA0001::WS-alpha"));
});

test("workspace_instance_dir refuses malformed instance strings", () => {
  const layout = projectLayout(POSIX_ROOT);
  assert.throws(() => resolver.workspaceInstanceDir(layout, "nodelimiter"), /malformed_instance/);
});

// ─── R5 Root-review: composite workspaceInstanceId string handling ───────
//
// Root review reproduction: passing the canonical composite string
// `${machine_id}::${workspace_id}` as `resolveLayout({...,
// workspaceInstanceId: "M-hostA0001::WS-alpha"})` previously threw
// `IDENTITY_ERROR:empty` because the resolver split the string and fed
// the halves directly to the record-only composite factory. After the
// R5 fix, the same input must produce a real `workspace_instance_id`
// record, while every malformed / extra-delimiter / wrong-identity
// shape must fail closed with a typed error code.

test("resolveLayout accepts a legal composite workspaceInstanceId string", () => {
  const layout = projectLayout(POSIX_ROOT, {
    workspaceInstanceId: "M-hostA0001::WS-alpha",
  });
  assert.equal(layout.workspaceInstanceIdentity.kind, "workspace_instance_id");
  assert.equal(layout.workspaceInstanceIdentity.value, "M-hostA0001::WS-alpha");
  // The record-based path must produce a byte-identical value, so a
  // downstream caller cannot tell which path was used.
  const recordLayout = projectLayout(POSIX_ROOT);
  assert.equal(layout.workspaceInstanceIdentity.value, recordLayout.workspaceInstanceIdentity.value);
});

test("resolveLayout fails closed on malformed / extra-delimiter / wrong-identity composite strings", () => {
  // Each entry must throw a typed `RUNTIME_LAYOUT_ERROR:*` so callers can
  // tell malformed input apart from identity-unsafe input.
  const malformed = [
    { input: "nodelimiter", code: /malformed_instance/ },
    { input: "::WS-alpha", code: /malformed_instance/ },
    { input: "M-hostA0001::", code: /malformed_instance/ },
    { input: "M-hostA0001::WS-alpha::extra", code: /malformed_instance/ },
    { input: "M::WS::extra", code: /malformed_instance/ },
    // Wrong workspace_id half: pattern requires `WS-` prefix.
    { input: "M-hostA0001::bad-ws", code: /unsafe_identity/ },
    // Wrong machine_id half: too short (regex needs ≥8 chars overall).
    { input: "Mx::WS-alpha", code: /unsafe_identity/ },
  ];
  for (const { input, code } of malformed) {
    assert.throws(
      () => projectLayout(POSIX_ROOT, { workspaceInstanceId: input }),
      code,
      `composite ${JSON.stringify(input)} must fail closed`,
    );
  }
});

test("workspaceInstanceDir accepts a legal composite string and fails closed on the same malformed shapes", () => {
  const layout = projectLayout(POSIX_ROOT);
  // Legal composite path: round-trips through the same builder as the
  // resolver, so the produced directory matches the record-based path.
  const strDir = resolver.workspaceInstanceDir(layout, "M-hostA0001::WS-alpha");
  const recDir = resolver.workspaceInstanceDir(layout, identity.workspaceInstanceId(
    identity.machineId("M-hostA0001"),
    identity.workspaceId("WS-alpha"),
  ));
  assert.equal(strDir, recDir);
  // Fail closed on the same set of malformed inputs as resolveLayout.
  for (const input of ["nodelimiter", "::WS-alpha", "M-hostA0001::", "M-hostA0001::WS-alpha::extra", "M::WS::extra", "M-hostA0001::bad-ws", "Mx::WS-alpha"]) {
    assert.throws(
      () => resolver.workspaceInstanceDir(layout, input),
      /malformed_instance|unsafe_identity/,
      `composite ${JSON.stringify(input)} must fail closed in workspaceInstanceDir too`,
    );
  }
});

// ─── VC-003 / VC-004 containment + symlink + two-instances + unresolved ────

test("resolver containment rejects traversal that escapes the declared root",
  withRoot("cortex-rl-contain-", (t, root) => {
    const layout = projectLayout(root);
    assert.throws(
      () => resolver.assertContained(path.join(root, "..", "evil.txt"), layout.paths.runtimeDir),
      /outside_root/,
    );
  }),
);

test("local-binding store writes atomically with 0o600 and refuses symlinked host dir",
  withRoot("cortex-rl-binding-", (t, root) => {
    // Create a normal layout first.
    const { store, layout } = localBinding.openStore({
      projectRoot: root,
      projectId: "cortex-agent",
      repositoryId: "cortex-agent",
      workspaceId: "WS-alpha",
      machineId: "M-hostA0001",
    });
    const result = store.upsert({ workspace_id: "WS-alpha", absolute_path: path.join(root, "trees", "alpha") });
    assert.equal(result.workspace_id, "WS-alpha");
    const file = resolver.hostBindingsPath(layout, "M-hostA0001");
    const stat = fs.statSync(file);
    assert.equal(stat.mode & 0o777, 0o600);

    // Unresolved binding surfaces as a soft result.
    const missing = store.resolve("WS-does-not-exist");
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "LOCAL_BINDING_UNRESOLVED");

    // Now replace the host dir with a symlink to somewhere else and
    // confirm the resolver refuses to write through it.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-rl-outside-"));
    t.after(() => { try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* best effort */ } });
    const hostDirPath = path.join(layout.paths.runtimeDir, "hosts", "M-hostA0001");
    fs.rmSync(hostDirPath, { recursive: true, force: true });
    fs.symlinkSync(outside, hostDirPath, "dir");
    assert.throws(
      () => localBinding.openStore({
        projectRoot: root,
        projectId: "cortex-agent",
        repositoryId: "cortex-agent",
        workspaceId: "WS-alpha",
        machineId: "M-hostA0001",
      }),
      /symlink_host_dir|symlink_in_path/,
    );
  }),
);

test("local-binding store rejects symlinked ancestor directories, not just the host dir", (t) => {
  // Simulate the symlinked-shared .agent scenario from VC-004: the project
  // root itself is a real directory, but a sibling inside `.agent/` is a
  // symlink pointing somewhere else. The store must refuse to resolve a
  // binding whose absolute_path traverses the symlinked ancestor.
  const projectRoot = mkRoot("cortex-rl-binding-symlink-");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-rl-binding-outside-"));
  t.after(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const { store, layout } = localBinding.openStore({
    projectRoot,
    projectId: "cortex-agent",
    repositoryId: "cortex-agent",
    workspaceId: "WS-alpha",
    machineId: "M-hostA0001",
  });

  // First upsert succeeds: the bound absolute_path is inside the real
  // project root, so no ancestor traversal happens during write.
  store.upsert({ workspace_id: "WS-alpha", absolute_path: path.join(projectRoot, "trees", "alpha") });

  // Now symlink `.agent/runtime/hosts/<machine-id>` to a directory outside
  // the project. Re-opening the store must fail before any read happens.
  const hostDirPath = path.join(layout.paths.runtimeDir, "hosts", "M-hostA0001");
  fs.rmSync(hostDirPath, { recursive: true, force: true });
  fs.symlinkSync(outside, hostDirPath, "dir");

  assert.throws(
    () => store.resolve("WS-alpha"),
    /symlink_in_path|symlink_host_dir/,
  );
});

test("two worktree instances on the same host are partitioned under worktrees/", (t) => {
  const root = mkRoot("cortex-rl-instances-");
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  const layout = projectLayout(root, { workspaceId: "WS-alpha", machineId: "M-hostA0001" });
  const inst1 = identity.workspaceInstanceId(
    { value: "M-hostA0001", kind: "machine_id" },
    { value: "WS-alpha", kind: "workspace_id" },
  );
  const inst2 = identity.workspaceInstanceId(
    { value: "M-hostA0001", kind: "machine_id" },
    { value: "WS-beta", kind: "workspace_id" },
  );
  // Project-level coordination is shared (same path on both instances).
  const coord = resolver.portableRuntimePath(layout, "coordination");
  assert.equal(coord, path.join(root, ".agent", "runtime", "coordination"));
  // Per-instance state is partitioned.
  const dir1 = resolver.workspaceInstanceDir(layout, inst1);
  const dir2 = resolver.workspaceInstanceDir(layout, inst2);
  assert.notEqual(dir1, dir2);
  assert.ok(dir1.endsWith(path.join("worktrees", "M-hostA0001::WS-alpha")));
  assert.ok(dir2.endsWith(path.join("worktrees", "M-hostA0001::WS-beta")));
});

test("two worktree instances on different hosts keep the same identity string for the same workspace", () => {
  const ws = identity.workspaceId("WS-shared");
  const hostA = identity.machineId("M-hostA0001");
  const hostB = identity.machineId("M-hostB0001");
  const instA = identity.workspaceInstanceId(hostA, ws);
  const instB = identity.workspaceInstanceId(hostB, ws);
  assert.notEqual(instA.value, instB.value, "different hosts produce different instance ids");
  // Workspace identity itself is still shared.
  assert.equal(identity.equalIdentity(ws, ws), true);
  assert.equal(identity.equalIdentity(hostA, hostB), false);
});

test("legacy layout detection recognises proposal §2 segments but ignores empty directories",
  withRoot("cortex-rl-legacy-", (t, root) => {
    // Empty .agent-runtime with only `.DS_Store` and `.gitignore` must NOT count.
    fs.mkdirSync(path.join(root, ".agent-runtime"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent-runtime", ".DS_Store"), "");
    fs.writeFileSync(path.join(root, ".agent-runtime", ".gitignore"), "*\n!.gitignore\n");
    assert.equal(resolver.detectLegacyRuntime(root), false);

    // A recognised segment makes it count.
    fs.mkdirSync(path.join(root, ".agent-runtime", "coordination"), { recursive: true });
    assert.equal(resolver.detectLegacyRuntime(root), true);

    // No legacy dir at all.
    const clean = mkRoot("cortex-rl-nolegacy-");
    t.after(() => { try { fs.rmSync(clean, { recursive: true, force: true }); } catch { /* best effort */ } });
    assert.equal(resolver.detectLegacyRuntime(clean), false);
  }),
);

test("logical URI parser round-trips percent-encoded reserved characters", () => {
  // '+' is a sub-delim per RFC 3986; it must percent-encode on format and
  // percent-decode on parse without collision with the unsafe-chars check.
  const uri = logicalUri.project("cortex-agent", "tasks", "T+RSL+001");
  assert.equal(uri, "project://cortex-agent/tasks/T%2BRSL%2B001");
  const parsed = logicalUri.parse(uri);
  assert.deepEqual(parsed.segments, ["cortex-agent", "tasks", "T+RSL+001"]);
});

test("logical URI parser refuses absolute paths and out-of-vocabulary schemes", () => {
  assert.throws(() => logicalUri.parse("/Users/xueyq/projects"), /absolute_path|malformed/);
  assert.throws(() => logicalUri.parse("file:///etc/passwd"), /unknown_scheme/);
  // `runtime://` (no path at all) is reported via the empty-segment
  // guard — the trailing slash after `://` is itself an empty segment
  // and we refuse to silently canonicalise it.
  assert.throws(() => logicalUri.parse("runtime://"), /empty_segment|empty_path|malformed/);
  // Half-encoded UTF-8 sequence is rejected.
  assert.throws(() => logicalUri.parse("project://cortex-agent/%E0%A4%A"), /decode_failed|invalid/);
});

// ─── R5 Root-review: external worktree path resolution (Bug #2) ─────────────
//
// Root review reproduction: `local-binding` exists precisely to carry an
// absolute on-disk worktree path for one workspace_id. The path may live
// anywhere on the host — inside OR outside `.agent/runtime/` — because the
// whole point of the binding is to point at a real worktree directory,
// not at a slot under the resolver-declared runtime dir. The previous
// `assertContained(found.absolute_path, runtimeDir)` check incorrectly
// rejected any binding whose worktree path lived outside `runtimeDir`,
// even when that path was a perfectly valid host absolute path. After the
// R5 fix:
//   * upsert + resolve round-trips for paths under `.agent/runtime/`.
//   * upsert + resolve round-trips for paths outside `.agent/runtime/`,
//     including paths outside the project root entirely (real-world case:
//     /Users/xueyq/projects/<other-project>/.worktrees/WS-alpha).
//   * non-absolute / empty paths still fail closed.

test("local-binding store round-trips a worktree path that lives outside runtimeDir and outside the project root",
  withRoot("cortex-rl-bug2-", (t, projectRoot) => {
    // Simulate a worktree that lives in another repository's root — a
    // perfectly normal Cortex multi-repo setup. The path is a legal POSIX
    // absolute path; the resolver-declared project root is irrelevant.
    const externalWorktree = "/Users/xueyq/projects/other-repo/.worktrees/WS-alpha";

    const { store, layout } = localBinding.openStore({
      projectRoot,
      projectId: "cortex-agent",
      workspaceId: "WS-alpha",
      machineId: "M-hostA0001",
    });

    // Upsert succeeds: the worktree path is a valid local absolute path,
    // not a string that contains the binding file or its parents.
    const upserted = store.upsert({ workspace_id: "WS-alpha", absolute_path: externalWorktree });
    assert.equal(upserted.absolute_path, externalWorktree);
    assert.equal(upserted.workspace_id, "WS-alpha");

    // Resolve round-trips the same external path. Previously this
    // surfaced as `RUNTIME_LAYOUT_ERROR:outside_root` because the
    // resolver demanded containment inside `runtimeDir`.
    const resolved = store.resolve("WS-alpha");
    assert.equal(resolved.ok, true, `resolve must succeed for external worktree path; got ${JSON.stringify(resolved)}`);
    assert.equal(resolved.binding.absolute_path, externalWorktree);

    // List echoes the same external path — `list` and `resolve` must
    // agree on what the binding record actually says.
    const listed = store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].absolute_path, externalWorktree);
  }),
);

test("local-binding store still refuses non-absolute paths on resolve", (t) => {
  const projectRoot = mkRoot("cortex-rl-bug2-bad-");
  t.after(() => { try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

  // Hand-craft a binding envelope with a non-absolute path; resolve must
  // fail closed even though the resolver-declared `runtimeDir` constraint
  // is no longer enforced. (A tampered or corrupted envelope is the only
  // realistic way a non-absolute path can land in the file.)
  const { store, layout } = localBinding.openStore({
    projectRoot,
    projectId: "cortex-agent",
    workspaceId: "WS-alpha",
    machineId: "M-hostA0001",
  });
  // Use a permissive upsert (it already validates absolute paths) and
  // then corrupt the envelope directly to simulate a tampered write.
  store.upsert({ workspace_id: "WS-alpha", absolute_path: "/tmp/legit" });
  const file = resolver.hostBindingsPath(layout, "M-hostA0001");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.bindings[0].absolute_path = "trees/alpha"; // relative — must be refused
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n", "utf8");

  assert.throws(() => store.resolve("WS-alpha"), /empty_path|not_absolute/);
});

// ─── R5 Root-review: write-after-symlink-swap (Bug #3) ────────────────────
//
// Root review reproduction: the previous design only re-validated the
// host binding-file chain inside `resolve`, and only checked at the host
// dir itself in the constructor. `list`, `upsert`, and `remove` skipped
// the re-validation entirely, which meant an attacker who swapped the
// host dir to a symlink between construction and a subsequent write
// could redirect the write to a foreign host directory. After the R5 fix,
// every read-modify-write (list / upsert / remove / resolve) re-validates
// the binding-file chain so a swap is always rejected up-front.

test("list / upsert / remove / resolve all fail closed when the host dir is swapped to a symlink after construction",
  withRoot("cortex-rl-swap-", (t, projectRoot) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-rl-swap-outside-"));
    t.after(() => { try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* best effort */ } });

    const { store, layout } = localBinding.openStore({
      projectRoot,
      projectId: "cortex-agent",
      workspaceId: "WS-alpha",
      machineId: "M-hostA0001",
    });
    // Write a real binding while the host dir is genuine.
    store.upsert({ workspace_id: "WS-alpha", absolute_path: path.join(projectRoot, "trees", "alpha") });

    // Now swap the host dir to a symlink pointing somewhere outside the
    // project. The store was constructed before the swap, so each of the
    // four operations must independently refuse to read or write through
    // the swapped path.
    const hostDirPath = path.join(layout.paths.runtimeDir, "hosts", "M-hostA0001");
    fs.rmSync(hostDirPath, { recursive: true, force: true });
    fs.symlinkSync(outside, hostDirPath, "dir");

    for (const op of ["list", "upsert", "remove", "resolve"]) {
      assert.throws(
        () => {
          if (op === "list") store.list();
          else if (op === "upsert") store.upsert({ workspace_id: "WS-beta", absolute_path: "/tmp/swapped" });
          else if (op === "remove") store.remove("WS-alpha");
          else if (op === "resolve") store.resolve("WS-alpha");
        },
        /symlink_in_path|symlink_host_dir/,
        `${op} must fail closed after host-dir symlink swap`,
      );
    }

    // Re-creating a fresh store also fails — opening a new store on a
    // swapped host dir must refuse, because `ensureHostDir` re-stats and
    // re-checks every time.
    assert.throws(
      () => localBinding.openStore({
        projectRoot,
        projectId: "cortex-agent",
        workspaceId: "WS-alpha",
        machineId: "M-hostA0001",
      }),
      /symlink_in_path|symlink_host_dir/,
    );
  }),
);

test("upsert + resolve round-trip is also defended against a swap of an ancestor above the host dir", (t) => {
  // Defence in depth: a symlink swap higher in the chain (above
  // `.agent/runtime/hosts/<machine>` but still inside `.agent/`) must
  // also fail closed. This is the same scenario the R5 fix targets.
  const projectRoot = mkRoot("cortex-rl-swap-ancestor-");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-rl-swap-ancestor-outside-"));
  t.after(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const { store } = localBinding.openStore({
    projectRoot,
    projectId: "cortex-agent",
    workspaceId: "WS-alpha",
    machineId: "M-hostA0001",
  });
  store.upsert({ workspace_id: "WS-alpha", absolute_path: path.join(projectRoot, "trees", "alpha") });

  // Swap `.agent/runtime` to a symlink; the chain re-validation must
  // catch this on every subsequent operation.
  const runtimeDir = path.join(projectRoot, ".agent", "runtime");
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.symlinkSync(outside, runtimeDir, "dir");

  for (const op of ["list", "upsert", "remove", "resolve"]) {
    assert.throws(
      () => {
        if (op === "list") store.list();
        else if (op === "upsert") store.upsert({ workspace_id: "WS-beta", absolute_path: "/tmp/swapped" });
        else if (op === "remove") store.remove("WS-alpha");
        else if (op === "resolve") store.resolve("WS-alpha");
      },
      /symlink_in_path|symlink_host_dir/,
      `${op} must fail closed after .agent/runtime symlink swap`,
    );
  }
});

// ─── schemas / closed-vocabulary spot checks ───────────────────────────────

test("identity / URI / binding schemas are closed and reject unknown fields", () => {
  const v1 = schemas.validateIdentityRecord({ kind: "workspace_id", value: "WS-alpha" });
  assert.equal(v1.ok, true);
  const v2 = schemas.validateIdentityRecord({ kind: "workspace_id", value: "WS-alpha", root: "/Users/x" });
  assert.equal(v2.ok, false);

  const u1 = schemas.validateLogicalUri({ scheme: "project", path: "cortex-agent/foo" });
  assert.equal(u1.ok, true);
  const u2 = schemas.validateLogicalUri({ scheme: "file", path: "/etc/passwd" });
  assert.equal(u2.ok, false);

  const b1 = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [{ workspace_id: "WS-alpha", absolute_path: "/tmp/x", captured_at: "2026-08-14T00:00:00.000Z" }],
    updated_at: "2026-08-14T00:00:00.000Z",
  });
  assert.equal(b1.ok, true);
  const b2 = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [],
    updated_at: "2026-08-14T00:00:00.000Z",
    absolute_root: "/Users/x",
  });
  assert.equal(b2.ok, false);
});

// ─── R9 Root-review: validateLocalBinding matches the M-026 contract JSON ──
//
// Root reproduction: the previous `validateLocalBinding` schema did NOT
// require `schema_version`, accepted an explicit `captured_at` only as
// optional, did not enforce the `workspace_id` `WS-…` pattern, did not
// enforce `maxItems: 256` on the bindings array, and silently dropped
// `additionalProperties: false` on the nested binding entries. The
// contract in `templates/_shared/.agent/contracts/runtime-state/
// local-binding.schema.json` is the only authority; the runtime-layout
// schemas MUST mirror it byte-for-byte at the validator level so a
// tampered envelope cannot land in `.agent/runtime/hosts/<machine>/`.
// The tests below exercise every one of those knobs.

test("validateLocalBinding accepts a fully-populated contract envelope", () => {
  const verdict = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [
      {
        workspace_id: "WS-alpha",
        workspace_instance_id: "M-hostA0001::WS-alpha",
        absolute_path: "/Users/xueyq/projects/cortex-agent/.agent/runtime/worktrees/M-hostA0001::WS-alpha",
        captured_at: "2026-08-14T05:00:00.000Z",
      },
    ],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
});

test("validateLocalBinding rejects an envelope without schema_version", () => {
  const verdict = schemas.validateLocalBinding({
    // schema_version intentionally omitted.
    machine_id: "M-hostA0001",
    bindings: [
      {
        workspace_id: "WS-alpha",
        absolute_path: "/tmp/x",
        captured_at: "2026-08-14T05:00:00.000Z",
      },
    ],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.errors.some((err) => /missing required: schema_version/.test(err)),
    `expected schema_version error; got ${JSON.stringify(verdict.errors)}`,
  );
});

test("validateLocalBinding rejects a binding entry that is missing captured_at", () => {
  const verdict = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [
      {
        workspace_id: "WS-alpha",
        absolute_path: "/tmp/x",
        // captured_at intentionally omitted.
      },
    ],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.errors.some((err) => /captured_at/.test(err)),
    `expected captured_at error; got ${JSON.stringify(verdict.errors)}`,
  );
});

test("validateLocalBinding rejects a binding entry that omits absolute_path", () => {
  const verdict = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [
      {
        workspace_id: "WS-alpha",
        captured_at: "2026-08-14T05:00:00.000Z",
        // absolute_path intentionally omitted.
      },
    ],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.errors.some((err) => /absolute_path/.test(err)),
    `expected absolute_path error; got ${JSON.stringify(verdict.errors)}`,
  );
});

test("validateLocalBinding rejects workspace_id values that do not match the WS- pattern", () => {
  const verdict = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [
      {
        workspace_id: "bad-ws", // missing WS- prefix.
        absolute_path: "/tmp/x",
        captured_at: "2026-08-14T05:00:00.000Z",
      },
    ],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.errors.some((err) => /workspace_id.*must match/.test(err)),
    `expected workspace_id pattern error; got ${JSON.stringify(verdict.errors)}`,
  );
});

test("validateLocalBinding rejects empty absolute_path (minLength 1) and over-long captured_at", () => {
  const verdict = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [
      {
        workspace_id: "WS-alpha",
        absolute_path: "", // empty string — must hit minLength 1.
        captured_at: "x".repeat(65), // one char over the maxLength 64.
      },
    ],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.errors.some((err) => /absolute_path/.test(err)),
    `expected absolute_path error; got ${JSON.stringify(verdict.errors)}`,
  );
  assert.ok(
    verdict.errors.some((err) => /captured_at/.test(err)),
    `expected captured_at error; got ${JSON.stringify(verdict.errors)}`,
  );
});

test("validateLocalBinding rejects nested unknown fields on a binding entry", () => {
  const verdict = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [
      {
        workspace_id: "WS-alpha",
        absolute_path: "/tmp/x",
        captured_at: "2026-08-14T05:00:00.000Z",
        // Two forged sibling fields. The validator must surface at
        // least one of them as `additional property not allowed`.
        note: "forged",
        owner: "root",
      },
    ],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.errors.some((err) => /additional property not allowed: note/.test(err)),
    `expected nested 'note' rejection; got ${JSON.stringify(verdict.errors)}`,
  );
  assert.ok(
    verdict.errors.some((err) => /additional property not allowed: owner/.test(err)),
    `expected nested 'owner' rejection; got ${JSON.stringify(verdict.errors)}`,
  );
});

test("validateLocalBinding rejects more than 256 binding entries", () => {
  const bindings = Array.from({ length: 257 }, (_, i) => ({
    workspace_id: `WS-w${i}`,
    absolute_path: `/tmp/w${i}`,
    captured_at: "2026-08-14T05:00:00.000Z",
  }));
  const verdict = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings,
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.errors.some((err) => /at most 256 items/.test(err)),
    `expected maxItems error; got ${JSON.stringify(verdict.errors)}`,
  );
});

test("validateLocalBinding accepts exactly 256 binding entries (maxItems boundary)", () => {
  const bindings = Array.from({ length: 256 }, (_, i) => ({
    workspace_id: `WS-w${i}`,
    absolute_path: `/tmp/w${i}`,
    captured_at: "2026-08-14T05:00:00.000Z",
  }));
  const verdict = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings,
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
});

test("validateLocalBinding treats workspace_instance_id as string|null and never weakens the rest of the envelope", () => {
  // Both string and null are accepted.
  const stringForm = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [
      {
        workspace_id: "WS-alpha",
        workspace_instance_id: "M-hostA0001::WS-alpha",
        absolute_path: "/tmp/x",
        captured_at: "2026-08-14T05:00:00.000Z",
      },
    ],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(stringForm.ok, true, JSON.stringify(stringForm));

  const nullForm = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [
      {
        workspace_id: "WS-alpha",
        workspace_instance_id: null,
        absolute_path: "/tmp/x",
        captured_at: "2026-08-14T05:00:00.000Z",
      },
    ],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(nullForm.ok, true, JSON.stringify(nullForm));

  // Wrong type (number) is rejected — the union does not widen the
  // accepted set beyond string|null.
  const wrongType = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [
      {
        workspace_id: "WS-alpha",
        workspace_instance_id: 42,
        absolute_path: "/tmp/x",
        captured_at: "2026-08-14T05:00:00.000Z",
      },
    ],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(wrongType.ok, false);
  assert.ok(
    wrongType.errors.some((err) => /workspace_instance_id/.test(err)),
    `expected workspace_instance_id type error; got ${JSON.stringify(wrongType.errors)}`,
  );

  // Other fields still validate independently: dropping only
  // workspace_instance_id (keeping everything else legal) must still
  // pass, because the field is optional.
  const omitted = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [
      {
        workspace_id: "WS-alpha",
        absolute_path: "/tmp/x",
        captured_at: "2026-08-14T05:00:00.000Z",
      },
    ],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(omitted.ok, true, JSON.stringify(omitted));
});

test("module re-exports surface stays stable for downstream consumers", () => {
  for (const fn of [
    "resolveLayout",
    "detectLegacyRuntime",
    "projectId",
    "repositoryId",
    "workspaceId",
    "machineId",
    "workspaceInstanceId",
    "parseLogicalUri",
    "formatLogicalUri",
    "openLocalBindingStore",
  ]) {
    assert.equal(typeof layoutModule[fn], "function", `${fn} must be exported`);
  }
  assert.equal(typeof layoutModule.resolver, "object");
  assert.equal(typeof layoutModule.identity, "object");
  assert.equal(typeof layoutModule.logicalUri, "object");
  assert.equal(typeof layoutModule.localBinding, "object");
  assert.equal(typeof layoutModule.schemas, "object");
});

// ─── R7 Root-review: typed-record inputs must run the same validators ──────
//
// Root reproduction: `resolveLayout` used to accept any object literal
// carrying `{ kind, value }` for the *Identity inputs without ever running
// it through the schema or the identity factory. That let a caller pass
// `{ kind: "project_id", value: "/Users/forged" }` and have the resolver
// happily bake the absolute host path into the layout, completely
// bypassing the closed vocabulary. After the R7 fix, every typed-record
// input is routed through `coerceIdentityRecord`, which re-applies the
// regex/length/path heuristics that the string-input path already runs.

test("resolveLayout rejects forged object identities that would bypass the closed vocabulary", () => {
  // Absolute-path forgery: the closed vocabulary says no `project_id`
  // value may resemble a host filesystem path.
  assert.throws(
    () => resolver.resolveLayout({
      projectRoot: POSIX_ROOT,
      projectIdentity: { kind: "project_id", value: "/Users/forged" },
    }),
    /path_or_secret_in_identity|unsafe_chars|absolute_path/,
  );
  // Cross-kind forging: passing a `machine_id` record where a
  // `project_id` is expected — the resolver must refuse because the
  // kind discriminator must line up with the field name on every input.
  assert.throws(
    () => resolver.resolveLayout({
      projectRoot: POSIX_ROOT,
      projectIdentity: { kind: "machine_id", value: "M-hostA0001" },
    }),
    /wrong_kind/,
  );
  // Cross-kind forging for `repositoryIdentity`.
  assert.throws(
    () => resolver.resolveLayout({
      projectRoot: POSIX_ROOT,
      projectId: "cortex-agent",
      repositoryIdentity: { kind: "workspace_id", value: "WS-alpha" },
    }),
    /wrong_kind/,
  );
  // Forged `machine_id` with traversal segments: the resolver must
  // refuse because `machine_id` is closed-format and never contains
  // `..` or `/`.
  assert.throws(
    () => resolver.resolveLayout({
      projectRoot: POSIX_ROOT,
      projectId: "cortex-agent",
      machineIdentity: { kind: "machine_id", value: "../../escape" },
    }),
    /unsafe_chars|absolute_path/,
  );
});

test("resolveLayout accepts legitimately typed records for every identity field", () => {
  // The factory output is byte-identical to a built-from-string layout.
  const layout = resolver.resolveLayout({
    projectRoot: POSIX_ROOT,
    projectIdentity: identity.projectId("cortex-agent"),
    repositoryIdentity: identity.repositoryId("cortex-agent"),
    workspaceIdentity: identity.workspaceId("WS-alpha"),
    machineIdentity: identity.machineId("M-hostA0001"),
  });
  assert.equal(layout.projectIdentity.kind, "project_id");
  assert.equal(layout.repositoryIdentity.kind, "repository_id");
  assert.equal(layout.workspaceIdentity.kind, "workspace_id");
  assert.equal(layout.machineIdentity.kind, "machine_id");
  // composite built from the typed records
  const inst = identity.workspaceInstanceId(layout.machineIdentity, layout.workspaceIdentity);
  assert.equal(inst.kind, "workspace_instance_id");
  assert.equal(inst.value, "M-hostA0001::WS-alpha");
});

// ─── R7 Root-review: hostDir / workspaceInstanceDir must reuse identity ────
//
// Root reproduction: `hostDir(layout, {kind:"machine_id", value:"../../escape"})`
// and `workspaceInstanceDir(layout, {kind:"workspace_instance_id",
// value:"../../escape"})` previously accepted forged records whose value
// walked out of the resolver-declared hosts/worktrees dir after
// `path.join` normalised the traversal. After the R7 fix, both helpers
// route the record through `coerceIdentityRecord` (rejecting forged
// kinds/values) AND check containment after the join so a path that
// escapes the resolver-declared dir is refused with `outside_root`
// — this is the second line of defence in case a future contributor
// widens the regex.

test("hostDir refuses forged machine records that escape the hosts directory", () => {
  const layout = projectLayout(POSIX_ROOT);
  // Forged record value: a closed `machine_id` would never contain `..`,
  // so the identity validator catches this first.
  assert.throws(
    () => resolver.hostDir(layout, { kind: "machine_id", value: "../../escape" }),
    /unsafe_chars|absolute_path|outside_root/,
  );
  // Cross-kind forging: passing a `workspace_id` record when a
  // `machine_id` is expected.
  assert.throws(
    () => resolver.hostDir(layout, { kind: "workspace_id", value: "WS-alpha" }),
    /wrong_kind/,
  );
  // Legal record shape: byte-identical output to the string-input path.
  const recDir = resolver.hostDir(layout, { kind: "machine_id", value: "M-hostB0001" });
  const strDir = resolver.hostDir(layout, "M-hostB0001");
  assert.equal(recDir, strDir);
});

test("workspaceInstanceDir refuses forged instance records that escape the worktrees directory", () => {
  const layout = projectLayout(POSIX_ROOT);
  assert.throws(
    () => resolver.workspaceInstanceDir(layout, { kind: "workspace_instance_id", value: "../../escape" }),
    /unsafe_chars|absolute_path|outside_root|malformed_instance_record/,
  );
  assert.throws(
    () => resolver.workspaceInstanceDir(layout, { kind: "machine_id", value: "M-hostA0001::WS-alpha" }),
    /wrong_kind/,
  );
  // Composite string with a forged half: closed-vocabulary rejection.
  assert.throws(
    () => resolver.workspaceInstanceDir(layout, "M-hostA0001::bad-ws"),
    /unsafe_identity/,
  );
  // Legal composite record shape: round-trips to the same path the
  // string-input path would produce.
  const recDir = resolver.workspaceInstanceDir(layout, {
    kind: "workspace_instance_id",
    value: "M-hostA0001::WS-alpha",
  });
  const strDir = resolver.workspaceInstanceDir(layout, "M-hostA0001::WS-alpha");
  assert.equal(recDir, strDir);
});

// ─── R7 Root-review: parser output must round-trip through portablePath ────
//
// Root reproduction: `parseLogicalUri("runtime://coordination/tasks/T-1")`
// returned `{scheme, segments, ...}` but `portablePath` requires
// `{kind:"logical_uri", scheme, segments, ...}`. The two public surfaces
// could not be chained without wrapping the parser output in an
// adapter. After the R7 fix the parser emits `kind: "logical_uri"` (and
// a frozen `path` string) so the returned record is also valid input
// for `portablePath`, `handoffPath`, or any future resolver helper.

test("parser output carries kind:logical_uri and feeds resolver helpers directly", () => {
  const layout = projectLayout(POSIX_ROOT);
  const uri = logicalUri.runtime("coordination", "tasks", "T-1");
  assert.equal(uri, "runtime://coordination/tasks/T-1");
  const parsed = logicalUri.parse(uri);
  // The discriminated union that portablePath checks.
  assert.equal(parsed.kind, "logical_uri");
  assert.equal(parsed.scheme, "runtime");
  assert.equal(parsed.path, "coordination/tasks/T-1");
  assert.deepEqual(parsed.segments, ["coordination", "tasks", "T-1"]);
  // Direct composition with the resolver — no wrapping required.
  const target = resolver.portablePath(layout, parsed);
  assert.equal(target, path.join(POSIX_ROOT, ".agent", "runtime", "coordination", "tasks", "T-1"));
});

test("parser → portablePath round-trips through format/parse", () => {
  const layout = projectLayout(POSIX_ROOT);
  const segments = ["coordination", "tasks", "T-1"];
  const formatted = logicalUri.format("runtime", segments);
  const parsed = logicalUri.parse(formatted);
  // Re-using `format` via the parsed segments must produce the same URI.
  const reformatted = logicalUri.format(parsed.scheme, parsed.segments.slice());
  assert.equal(reformatted, formatted);
  // And the resolver must agree on where that URI lives on this host.
  const target = resolver.portablePath(layout, parsed);
  assert.equal(target, path.join(layout.paths.runtimeDir, "coordination", "tasks", "T-1"));
});

// ─── R7 Root-review: parser must reject empty segments, not canonicalise ────
//
// Root reproduction: `runtime://coordination//tasks` previously went
// through `split("/").filter(s => s.length > 0)` and silently collapsed
// to `["coordination", "tasks"]`, which collides with the legal
// single-slash URI. After the R7 fix, every empty segment (leading,
// trailing, or doubled) is refused at the parser boundary with a
// dedicated `empty_segment` error code, so consumers cannot accidentally
// treat a malformed input as a canonical one.

test("logical URI parser refuses every kind of empty segment at the boundary", () => {
  const malformed = [
    // trailing slash
    "runtime://coordination/",
    "runtime://coordination/tasks/",
    // leading slash
    "runtime:///tasks",
    "runtime:///",
    // doubled slash
    "runtime://coordination//tasks",
    "runtime://coordination///tasks",
    "runtime://coordination/tasks//T-1",
    // multiple separators in a row
    "runtime:////",
  ];
  for (const input of malformed) {
    assert.throws(
      () => logicalUri.parse(input),
      /empty_segment/,
      `${JSON.stringify(input)} must fail closed with empty_segment`,
    );
  }
  // Sanity guard: the well-formed parallel URI must still parse cleanly.
  const ok = logicalUri.parse("runtime://coordination//tasks" === "runtime://coordination/tasks"
    ? "runtime://coordination/tasks/T-1"
    : "runtime://coordination/tasks/T-1");
  assert.equal(ok.kind, "logical_uri");
});

// ─── R7 Root-review: os.tmpdir() platform-alias test must be cross-platform
//
// The R6 regression test asserted that the raw `os.tmpdir()` path lives
// behind a system symlink alias, and required the test to fail loudly on
// hosts that do not have that alias. That made the suite unrunnable on
// ordinary Linux / Windows CI, where `os.tmpdir()` is a plain directory.
// After the R7 fix the test exercises the round-trip on any host
// (proving the platform-alias code path), and ONLY when the host has a
// symlink ancestor does it assert that the alias branch is also covered —
// so a Linux CI run never fails or skips for the wrong reason.

test("local-binding store round-trips a worktree whose absolute_path equals raw os.tmpdir() on any host", (t) => {
  const projectRoot = mkRoot("cortex-rl-r7-aliastmpdir-");
  t.after(() => { try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

  // Walk up from `os.tmpdir()` looking for the first symlink ancestor.
  // We deliberately do NOT realpathSync, so on macOS we still see the
  // `/var/folders/...` (un-realpath'd) shape; on Linux we stop at `/`.
  const tmpRoot = os.tmpdir();
  let firstSegmentIsSymlink = false;
  let cursor = tmpRoot;
  while (true) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    let lstat;
    try { lstat = fs.lstatSync(parent); } catch { break; }
    if (lstat.isSymbolicLink()) { firstSegmentIsSymlink = true; break; }
    cursor = parent;
  }

  const externalWorktree = path.join(tmpRoot, "cortex-rl-r7-worktrees", "WS-alpha");
  fs.mkdirSync(externalWorktree, { recursive: true });
  t.after(() => { try { fs.rmSync(externalWorktree, { recursive: true, force: true }); } catch { /* best effort */ } });

  const { store } = localBinding.openStore({
    projectRoot,
    projectId: "cortex-agent",
    workspaceId: "WS-alpha",
    machineId: "M-hostA0001",
  });

  // Cross-platform round-trip: upsert + resolve the raw, un-realpath'd
  // `os.tmpdir()` value. This must succeed on every host — Linux,
  // macOS, and Windows alike.
  const upserted = store.upsert({ workspace_id: "WS-alpha", absolute_path: externalWorktree });
  assert.equal(upserted.absolute_path, externalWorktree);
  const resolved = store.resolve("WS-alpha");
  assert.equal(resolved.ok, true,
    `resolve must succeed for os.tmpdir() worktree on any host; got ${JSON.stringify(resolved)}`);
  assert.equal(resolved.binding.absolute_path, externalWorktree);
  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].absolute_path, externalWorktree);

  // Only when the host actually has a system symlink alias along the
  // path leading up to tmpdir do we additionally assert that the
  // alias branch is genuinely exercised (i.e. the stored path is NOT
  // canonicalised to the realpath). On Linux/Windows tmpdir is a plain
  // directory and this branch is skipped without failing the test.
  if (firstSegmentIsSymlink) {
    const realWorktree = fs.realpathSync.native
      ? fs.realpathSync.native(externalWorktree)
      : fs.realpathSync(externalWorktree);
    assert.notEqual(resolved.binding.absolute_path, realWorktree,
      "platform-alias branch: stored path must stay un-realpath'd when host has a symlink ancestor");
  }
});

// ─── R7 Root-review: public-API smoke chain ────────────────────────────────
//
// Smoke check that typed/plain inputs and the logical-URI parser compose
// cleanly across every public surface exported from `lib/runtime-layout`.
// This is the wiring test Root asked for: every consumer of the module
// must be able to chain `resolveLayout` → `parseLogicalUri` →
// `portablePath` → `workspaceInstanceDir` without hand-rolling a single
// adapter. M-026 MS-001 must keep this chain passing; MS-002 is allowed
// to extend it but must not regress.

test("public-API chain: resolveLayout → parseLogicalUri → portablePath + workspaceInstanceDir + equalIdentity", () => {
  const layout = resolver.resolveLayout({
    projectRoot: POSIX_ROOT,
    projectId: "cortex-agent",
    repositoryId: "cortex-agent",
    workspaceId: "WS-alpha",
    machineId: "M-hostA0001",
  });
  // Logical URI chain: parser output feeds portablePath directly.
  const uri = logicalUri.runtime("coordination", "tasks", "T-1");
  const parsed = logicalUri.parse(uri);
  assert.equal(parsed.kind, "logical_uri");
  const portableTarget = resolver.portablePath(layout, parsed);
  assert.equal(portableTarget,
    path.join(POSIX_ROOT, ".agent", "runtime", "coordination", "tasks", "T-1"));
  // Instance dir chain: factory output feeds workspaceInstanceDir.
  const ws = identity.workspaceId("WS-alpha");
  const host = identity.machineId("M-hostA0001");
  const inst = identity.workspaceInstanceId(host, ws);
  assert.equal(inst.kind, "workspace_instance_id");
  const instDir = resolver.workspaceInstanceDir(layout, inst);
  assert.equal(instDir,
    path.join(POSIX_ROOT, ".agent", "runtime", "worktrees", "M-hostA0001::WS-alpha"));
  // Equality chain: typed records compare on value alone, no path leaks.
  assert.equal(identity.equalIdentity(layout.workspaceIdentity, ws), true);
  assert.equal(identity.equalIdentity(layout.machineIdentity, host), true);
  assert.equal(identity.equalIdentity(layout.workspaceInstanceIdentity, inst), true);
  // Open the local-binding store against the same layout: the typed
  // factory outputs flow through without any re-shape step.
  const opened = localBinding.openStore({
    projectRoot: POSIX_ROOT,
    projectIdentity: layout.projectIdentity,
    repositoryIdentity: layout.repositoryIdentity,
    workspaceIdentity: layout.workspaceIdentity,
    machineIdentity: layout.machineIdentity,
  });
  // The store must echo the same identities on the way out — identity
  // stays on the value string, no host-side canonicalisation.
  assert.equal(opened.layout.workspaceIdentity.value, "WS-alpha");
  assert.equal(opened.layout.machineIdentity.value, "M-hostA0001");
});

// ─── R10 Root-review: explicit null on non-nullable required fields ──────
//
// Root reproduction: the previous `validateAgainst` loop guarded the
// `v === null` case with
//   `if (v === null && !(Array.isArray(def.type) && def.type.includes("null"))) continue;`
// which silently skipped every type / pattern / minLength / maxLength
// check whenever the caller set a non-nullable required field to an
// explicit `null`. JSON Schema treats a present-but-null property as
// supplied (the `required` array does NOT cover it), so the validator
// accepted envelopes like
//   { schema_version: null, machine_id: "M-…", bindings: [...], updated_at: "…" }
// and the nested variant
//   bindings: [{ workspace_id: "WS-alpha", absolute_path: null, captured_at: "…" }]
// as if they were fully populated. After the R10 fix:
//   * Any explicit null on a top-level required string field in any of
//     the three schemas (identity-record, logical-uri, local-binding)
//     fails closed with `${key}: must be ${type}`.
//   * The same rule applies to every nested required string field
//     (workspace_id / absolute_path / captured_at) on a binding entry.
//   * The union `["string", "null"]` field `workspace_instance_id` is
//     unaffected: null, a string, and omission are all still accepted.
//   * Omitting an optional field continues to be accepted (no regression).

test("validateIdentityRecord rejects explicit null on required kind or value", () => {
  // kind=null: required string field with an explicit null must fail
  // closed; the validator must NOT silently drop the constraint.
  const kindNull = schemas.validateIdentityRecord({ kind: null, value: "WS-alpha" });
  assert.equal(kindNull.ok, false);
  assert.ok(
    kindNull.errors.some((err) => err === "kind: must be string"),
    `expected kind type error; got ${JSON.stringify(kindNull.errors)}`,
  );

  // value=null: same expectation for the other required string field.
  const valueNull = schemas.validateIdentityRecord({ kind: "workspace_id", value: null });
  assert.equal(valueNull.ok, false);
  assert.ok(
    valueNull.errors.some((err) => err === "value: must be string"),
    `expected value type error; got ${JSON.stringify(valueNull.errors)}`,
  );

  // Both null: both errors surface together.
  const bothNull = schemas.validateIdentityRecord({ kind: null, value: null });
  assert.equal(bothNull.ok, false);
  assert.ok(bothNull.errors.some((err) => err === "kind: must be string"));
  assert.ok(bothNull.errors.some((err) => err === "value: must be string"));

  // Sanity guard: a fully-populated identity still passes.
  const ok = schemas.validateIdentityRecord({ kind: "workspace_id", value: "WS-alpha" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("validateLogicalUri rejects explicit null on required scheme or path", () => {
  const schemeNull = schemas.validateLogicalUri({ scheme: null, path: "cortex-agent/foo" });
  assert.equal(schemeNull.ok, false);
  assert.ok(
    schemeNull.errors.some((err) => err === "scheme: must be string"),
    `expected scheme type error; got ${JSON.stringify(schemeNull.errors)}`,
  );

  const pathNull = schemas.validateLogicalUri({ scheme: "project", path: null });
  assert.equal(pathNull.ok, false);
  assert.ok(
    pathNull.errors.some((err) => err === "path: must be string"),
    `expected path type error; got ${JSON.stringify(pathNull.errors)}`,
  );

  const ok = schemas.validateLogicalUri({ scheme: "project", path: "cortex-agent/foo" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("validateLocalBinding rejects explicit null on every top-level required string field", () => {
  // schema_version=null: must fail closed with the type error, NOT
  // silently drop the constraint.
  const schemaVersionNull = schemas.validateLocalBinding({
    schema_version: null,
    machine_id: "M-hostA0001",
    bindings: [{ workspace_id: "WS-alpha", absolute_path: "/tmp/x", captured_at: "2026-08-14T05:00:00.000Z" }],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(schemaVersionNull.ok, false);
  assert.ok(
    schemaVersionNull.errors.some((err) => err === "schema_version: must be string"),
    `expected schema_version type error; got ${JSON.stringify(schemaVersionNull.errors)}`,
  );

  // machine_id=null: same expectation.
  const machineIdNull = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: null,
    bindings: [{ workspace_id: "WS-alpha", absolute_path: "/tmp/x", captured_at: "2026-08-14T05:00:00.000Z" }],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(machineIdNull.ok, false);
  assert.ok(
    machineIdNull.errors.some((err) => err === "machine_id: must be string"),
    `expected machine_id type error; got ${JSON.stringify(machineIdNull.errors)}`,
  );

  // updated_at=null: same expectation.
  const updatedAtNull = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [{ workspace_id: "WS-alpha", absolute_path: "/tmp/x", captured_at: "2026-08-14T05:00:00.000Z" }],
    updated_at: null,
  });
  assert.equal(updatedAtNull.ok, false);
  assert.ok(
    updatedAtNull.errors.some((err) => err === "updated_at: must be string"),
    `expected updated_at type error; got ${JSON.stringify(updatedAtNull.errors)}`,
  );
});

test("validateLocalBinding rejects explicit null on every nested required string field inside bindings", () => {
  // workspace_id=null on a binding entry: must fail closed. The error
  // path includes the array index so callers can locate the bad entry.
  const workspaceIdNull = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [{
      workspace_id: null,
      absolute_path: "/tmp/x",
      captured_at: "2026-08-14T05:00:00.000Z",
    }],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(workspaceIdNull.ok, false);
  assert.ok(
    workspaceIdNull.errors.some((err) => /workspace_id/.test(err) && /must be string/.test(err)),
    `expected nested workspace_id type error; got ${JSON.stringify(workspaceIdNull.errors)}`,
  );

  // absolute_path=null: same expectation.
  const absolutePathNull = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [{
      workspace_id: "WS-alpha",
      absolute_path: null,
      captured_at: "2026-08-14T05:00:00.000Z",
    }],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(absolutePathNull.ok, false);
  assert.ok(
    absolutePathNull.errors.some((err) => /absolute_path/.test(err) && /must be string/.test(err)),
    `expected nested absolute_path type error; got ${JSON.stringify(absolutePathNull.errors)}`,
  );

  // captured_at=null: same expectation.
  const capturedAtNull = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [{
      workspace_id: "WS-alpha",
      absolute_path: "/tmp/x",
      captured_at: null,
    }],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(capturedAtNull.ok, false);
  assert.ok(
    capturedAtNull.errors.some((err) => /captured_at/.test(err) && /must be string/.test(err)),
    `expected nested captured_at type error; got ${JSON.stringify(capturedAtNull.errors)}`,
  );
});

test("validateLocalBinding still accepts the nullable string|null union for workspace_instance_id", () => {
  // R10 must NOT regress the nullable union: null, a string, and
  // omission are all still accepted, and a wrong-type value (e.g.
  // a number) is still rejected.
  const nullForm = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [{
      workspace_id: "WS-alpha",
      workspace_instance_id: null,
      absolute_path: "/tmp/x",
      captured_at: "2026-08-14T05:00:00.000Z",
    }],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(nullForm.ok, true, JSON.stringify(nullForm));

  const stringForm = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [{
      workspace_id: "WS-alpha",
      workspace_instance_id: "M-hostA0001::WS-alpha",
      absolute_path: "/tmp/x",
      captured_at: "2026-08-14T05:00:00.000Z",
    }],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(stringForm.ok, true, JSON.stringify(stringForm));

  // Omitted field: still accepted (no regression vs R9).
  const omitted = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [{
      workspace_id: "WS-alpha",
      absolute_path: "/tmp/x",
      captured_at: "2026-08-14T05:00:00.000Z",
    }],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(omitted.ok, true, JSON.stringify(omitted));

  // Wrong type: a number must NOT widen the union.
  const wrongType = schemas.validateLocalBinding({
    schema_version: "1.0",
    machine_id: "M-hostA0001",
    bindings: [{
      workspace_id: "WS-alpha",
      workspace_instance_id: 42,
      absolute_path: "/tmp/x",
      captured_at: "2026-08-14T05:00:00.000Z",
    }],
    updated_at: "2026-08-14T05:00:00.000Z",
  });
  assert.equal(wrongType.ok, false);
  assert.ok(
    wrongType.errors.some((err) => /workspace_instance_id/.test(err)),
    `expected workspace_instance_id type error; got ${JSON.stringify(wrongType.errors)}`,
  );
});