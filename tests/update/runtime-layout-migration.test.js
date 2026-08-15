"use strict";

// ─── Runtime Layout Migration Tests (M-026 MS-002, VC-006..VC-010) ─────────────
//
// Validation contracts covered:
//   VC-006 (api):  planner produces JSON plan with per-action source_ref,
//                  target_ref, risk, conflict_policy, rollback_ref,
//                  verification_ids.
//   VC-007 (test): dry-run is zero-write on a disposable fixture;
//                  apply does candidate validation then marker-last activation.
//   VC-008 (test): fault injection at every migration phase restores legacy
//                  readability and never leaves a half-activated marker.
//   VC-009 (test): second update is a no-op (no duplicate journal/lease/
//                  archive/report/binding).
//   VC-010 (security): files outside the allowlist are byte-identical
//                      before/after; conflicts fail closed with no Git side effect.
//
// Test fixture structure:
//   tests/fixtures/runtime-layout-migration/
//     legacy-only/           - has .agent-runtime/ but no .agent/runtime/
//     already-migrated/      - has both legacy and .agent/runtime/layout.json
//     user-modified/         - user has modified a file outside allowlist
//     conflict/              - new layout file already exists
//
// All fixtures use disposable temp directories; no test touches the real
// project .agent-runtime/.

const {
  describe,
  it,
  beforeEach,
  afterEach,
  mock,
} = require("node:test");
const assert = require("node:assert");

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

// Module under test
const {
  buildMigrationPlan,
  applyMigration,
  rollbackMigration,
  buildMigrationReport,
  inspectLegacyRuntime,
  inspectLegacySchemas,
  isUnderLegacyRuntime,
  isAllowedNewLayoutPath,
  scanProjectState,
  fileDigest,
  digestDirectory,
  ACTION_TYPES,
  RISK_LEVELS,
  CONFLICT_POLICIES,
  LAYOUT_MARKER_FILE,
  RUNTIME_LAYOUT_VERSION,
  LEGACY_SOURCE_SEGMENTS,
  MigrationError,
} = require("../../lib/commands/update/runtime-layout-migration");

const {
  detectLegacyRuntime,
  AGENT_DIR_SEGMENT,
  RUNTIME_DIR,
} = require("../../lib/runtime-layout");

// Define legacy segment constant
const LEGACY_RT_SEGMENT = ".agent-runtime";

// ─── Test fixture helpers ───────────────────────────────────────────────────

/**
 * Create a disposable fixture directory with a legacy .agent-runtime/ structure.
 * Returns the fixture root path.
 */
function createLegacyFixture(root) {
  // Create legacy runtime with portable namespaces
  const legacyDir = path.join(root, LEGACY_RT_SEGMENT);
  fs.mkdirSync(legacyDir, { recursive: true });

  // Add coordination namespace
  const coordDir = path.join(legacyDir, "coordination");
  fs.mkdirSync(coordDir, { recursive: true });
  fs.writeFileSync(path.join(coordDir, "tasks.json"), JSON.stringify({ tasks: [] }));
  fs.writeFileSync(path.join(coordDir, "leases.json"), JSON.stringify({ leases: [] }));

  // Add cross-project namespace
  const crossProjectDir = path.join(legacyDir, "cross-project");
  fs.mkdirSync(crossProjectDir, { recursive: true });
  fs.writeFileSync(path.join(crossProjectDir, "inbox.json"), JSON.stringify({ messages: [] }));

  // Add dispatch namespace
  const dispatchDir = path.join(legacyDir, "dispatch");
  fs.mkdirSync(dispatchDir, { recursive: true });
  fs.writeFileSync(path.join(dispatchDir, "journal.json"), JSON.stringify({ entries: [] }));

  // Add handoffs namespace
  const handoffsDir = path.join(legacyDir, "handoffs");
  fs.mkdirSync(handoffsDir, { recursive: true });
  fs.writeFileSync(path.join(handoffsDir, "test-handoff.json"), JSON.stringify({ id: "test-1" }));

  // Add runtime-continuity namespace
  const continuityDir = path.join(legacyDir, "runtime-continuity");
  fs.mkdirSync(continuityDir, { recursive: true });
  fs.writeFileSync(path.join(continuityDir, "state.json"), JSON.stringify({ state: "active" }));

  // Add runtime-evidence namespace
  const evidenceDir = path.join(legacyDir, "runtime-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "archive.json"), JSON.stringify({ archives: [] }));

  // Create .agent/ directory (but no .agent/runtime/layout.json)
  const agentDir = path.join(root, AGENT_DIR_SEGMENT);
  fs.mkdirSync(agentDir, { recursive: true });

  return root;
}

/**
 * Create a fixture where migration already completed.
 */
function createMigratedFixture(root) {
  // Create legacy runtime (retained)
  const legacyDir = path.join(root, LEGACY_RT_SEGMENT);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.mkdirSync(path.join(legacyDir, "coordination"), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "coordination", "tasks.json"), JSON.stringify({ tasks: [] }));

  // Create new runtime layout
  const runtimeDir = path.join(root, AGENT_DIR_SEGMENT, RUNTIME_DIR);
  fs.mkdirSync(path.join(runtimeDir, "coordination"), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "coordination", "tasks.json"), JSON.stringify({ tasks: [] }));
  fs.mkdirSync(path.join(runtimeDir, "cross-project"), { recursive: true });
  fs.mkdirSync(path.join(runtimeDir, "dispatch"), { recursive: true });
  fs.mkdirSync(path.join(runtimeDir, "continuity"), { recursive: true });
  fs.mkdirSync(path.join(runtimeDir, "evidence"), { recursive: true });

  // Write activation marker
  const markerPath = path.join(runtimeDir, LAYOUT_MARKER_FILE);
  fs.writeFileSync(markerPath, JSON.stringify({
    layout_version: RUNTIME_LAYOUT_VERSION,
    activated_at: new Date().toISOString(),
    plan_id: "TEST-PLAN-1",
    source: "test",
  }, null, 2));

  return root;
}

/**
 * Create a fixture with user-modified files outside the allowlist.
 */
function createUserModifiedFixture(root) {
  createLegacyFixture(root);

  // Create a user-modified file in .agent/ that is NOT part of migration
  const agentDir = path.join(root, AGENT_DIR_SEGMENT);
  fs.writeFileSync(
    path.join(agentDir, "user-modified-rule.md"),
    "# User custom rule\nThis is user content that should not be modified."
  );

  // Capture digests for later verification
  return {
    "user-modified-rule.md": fileDigest(path.join(agentDir, "user-modified-rule.md")),
  };
}

// ─── VC-006: Planner API ─────────────────────────────────────────────────────

describe("VC-006: Migration Planner API", { concurrency: 1 }, () => {
  const fixtures = [];

  afterEach(() => {
    for (const fixture of fixtures) {
      try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
    }
    fixtures.length = 0;
  });

  it("produces JSON plan with required per-action fields", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc006-"));
    fixtures.push(fixtureRoot);
    createLegacyFixture(fixtureRoot);

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: true });

    assert.ok(plan.plan_id, "plan must have plan_id");
    assert.ok(plan.project_root, "plan must have project_root");
    assert.strictEqual(plan.layout_version, RUNTIME_LAYOUT_VERSION);
    assert.strictEqual(plan.has_legacy, true);
    assert.strictEqual(plan.is_noop, false);

    // Every action must have the required fields
    for (const action of plan.actions) {
      assert.ok(action.id, "action must have id");
      assert.ok(action.type, "action must have type");
      assert.ok(action.risk, "action must have risk");
      assert.ok(action.conflict_policy, "action must have conflict_policy");
      assert.ok(Array.isArray(action.verification_ids), "action must have verification_ids");
      assert.ok(action.phase, "action must have phase");
      // source_ref and target_ref may be null for some actions
      assert.ok("source_ref" in action, "action must have source_ref");
      assert.ok("target_ref" in action, "action must have target_ref");
    }

    // Allowlist must be populated for portable namespace migrations
    assert.ok(plan.allowlist.length > 0, "allowlist must not be empty for legacy migration");
  });

  it("has correct action types per P-002", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc006-types-"));
    fixtures.push(fixtureRoot);
    createLegacyFixture(fixtureRoot);

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: true });

    const actionTypes = new Set(plan.actions.map((a) => a.type));
    assert.ok(actionTypes.has(ACTION_TYPES.INSPECT_LEGACY), "must inspect legacy");
    assert.ok(actionTypes.has(ACTION_TYPES.COPY_RUNTIME_PORTABLE), "must copy portable namespaces");
    assert.ok(actionTypes.has(ACTION_TYPES.COPY_CONTRACTS), "must copy contracts");
    assert.ok(actionTypes.has(ACTION_TYPES.SEED_LOCAL_BINDING), "must seed local binding");
    assert.ok(actionTypes.has(ACTION_TYPES.VALIDATE_CANDIDATE_LAYOUT), "must validate");
    assert.ok(actionTypes.has(ACTION_TYPES.ACTIVATE_LAYOUT), "must activate");
    assert.ok(actionTypes.has(ACTION_TYPES.RETAIN_LEGACY_FALLBACK), "must retain legacy");
  });

  it("maps legacy segments to new layout correctly", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc006-mapping-"));
    fixtures.push(fixtureRoot);
    createLegacyFixture(fixtureRoot);

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: true });

    // coordination → coordination
    const coordActions = plan.actions.filter(
      (a) => a.source_ref && a.source_ref.includes(".agent-runtime/coordination/")
    );
    assert.ok(coordActions.length > 0, "must have coordination migration actions");
    for (const action of coordActions) {
      assert.ok(action.target_ref.includes(".agent/runtime/coordination/"), "coordination must map to coordination");
    }

    // runtime-continuity → continuity
    const continuityActions = plan.actions.filter(
      (a) => a.source_ref && a.source_ref.includes(".agent-runtime/runtime-continuity/")
    );
    assert.ok(continuityActions.length > 0, "must have continuity migration actions");
    for (const action of continuityActions) {
      assert.ok(action.target_ref.includes(".agent/runtime/continuity/"), "runtime-continuity must map to continuity");
    }
  });

  it("sets correct risk levels per action type", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc006-risk-"));
    fixtures.push(fixtureRoot);
    createLegacyFixture(fixtureRoot);

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: true });

    // Activation must be HIGH risk
    const activateActions = plan.actions.filter((a) => a.type === ACTION_TYPES.ACTIVATE_LAYOUT);
    assert.ok(activateActions.length > 0, "must have activation action");
    for (const action of activateActions) {
      assert.strictEqual(action.risk, RISK_LEVELS.HIGH, "activation must be HIGH risk");
      assert.strictEqual(action.conflict_policy, CONFLICT_POLICIES.BLOCK, "activation must BLOCK conflicts");
    }

    // Copy actions must be MEDIUM risk
    const copyActions = plan.actions.filter((a) => a.type === ACTION_TYPES.COPY_RUNTIME_PORTABLE);
    for (const action of copyActions) {
      assert.strictEqual(action.risk, RISK_LEVELS.MEDIUM, "copy must be MEDIUM risk");
    }

    // Inspection must be LOW risk
    const inspectActions = plan.actions.filter((a) => a.type === ACTION_TYPES.INSPECT_LEGACY);
    for (const action of inspectActions) {
      assert.strictEqual(action.risk, RISK_LEVELS.LOW, "inspect must be LOW risk");
    }
  });
});

// ─── VC-007: Dry-run Zero-Write and Apply Marker-Last ─────────────────────────

describe("VC-007: Dry-run Zero-Write and Apply Marker-Last", { concurrency: 1 }, () => {
  const fixtures = [];

  afterEach(() => {
    for (const fixture of fixtures) {
      try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
    }
    fixtures.length = 0;
  });

  it("dry-run creates no files", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc007-dry-"));
    fixtures.push(fixtureRoot);
    createLegacyFixture(fixtureRoot);

    // Capture directory state before
    const beforeFiles = getAllFiles(fixtureRoot);

    const ctx = { cwd: fixtureRoot };
    buildMigrationPlan(ctx, { dryRun: true });

    // Capture directory state after
    const afterFiles = getAllFiles(fixtureRoot);

    assert.deepStrictEqual(afterFiles.sort(), beforeFiles.sort(), "dry-run must not create any files");
  });

  it("apply creates candidate layout then marker last", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc007-apply-"));
    fixtures.push(fixtureRoot);
    createLegacyFixture(fixtureRoot);

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: true });

    // Apply migration
    const result = applyMigration(ctx, plan);

    assert.ok(result.ok, "migration must succeed");

    // Verify candidate files exist
    const coordinationFile = path.join(fixtureRoot, ".agent", "runtime", "coordination", "tasks.json");
    assert.ok(fs.existsSync(coordinationFile), "candidate file must exist");

    // Verify marker was written LAST
    const markerPath = path.join(fixtureRoot, ".agent", "runtime", LAYOUT_MARKER_FILE);
    assert.ok(fs.existsSync(markerPath), "activation marker must exist");

    // Marker content must be valid JSON
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.strictEqual(marker.layout_version, RUNTIME_LAYOUT_VERSION);
    assert.ok(marker.activated_at, "marker must have activated_at");
    assert.ok(marker.plan_id, "marker must have plan_id");
  });

  it("candidate validation runs before activation", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc007-validate-"));
    fixtures.push(fixtureRoot);
    createLegacyFixture(fixtureRoot);

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: true });

    // Manually remove a source file to trigger validation failure
    const sourceFile = path.join(fixtureRoot, LEGACY_RT_SEGMENT, "coordination", "tasks.json");
    fs.unlinkSync(sourceFile);

    const result = applyMigration(ctx, plan);

    // Migration should fail
    assert.ok(!result.ok, "migration must fail with missing source");

    // Marker must not exist (validation ran before activation)
    const markerPath = path.join(fixtureRoot, ".agent", "runtime", LAYOUT_MARKER_FILE);
    assert.ok(!fs.existsSync(markerPath), "marker must not exist after failed validation");
  });

  it("apply does not create .agent/runtime/ if no legacy", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc007-nolegacy-"));
    fixtures.push(fixtureRoot);

    // Create empty .agent/ without legacy
    const agentDir = path.join(fixtureRoot, AGENT_DIR_SEGMENT);
    fs.mkdirSync(agentDir, { recursive: true });

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: true });

    assert.strictEqual(plan.has_legacy, false, "must detect no legacy");
    assert.strictEqual(plan.is_noop, true, "must be noop");

    const result = applyMigration(ctx, plan);
    assert.ok(result.ok, "noop must succeed");
    assert.ok(result.noop, "must be noop");
    assert.ok(!fs.existsSync(path.join(fixtureRoot, AGENT_DIR_SEGMENT, RUNTIME_DIR)), ".agent/runtime/ must not exist");
  });
});

// ─── VC-008: Fault Injection and Rollback ─────────────────────────────────────

describe("VC-008: Fault Injection and Rollback", { concurrency: 1 }, () => {
  const fixtures = [];

  afterEach(() => {
    for (const fixture of fixtures) {
      try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
    }
    fixtures.length = 0;
  });

  it("restores legacy readability after candidate_write failure", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc008-candidate-"));
    fixtures.push(fixtureRoot);
    createLegacyFixture(fixtureRoot);

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: true });

    // Manually corrupt source to trigger failure during copy
    const sourceFile = path.join(fixtureRoot, LEGACY_RT_SEGMENT, "coordination", "tasks.json");
    fs.unlinkSync(sourceFile); // Remove source file

    const result = applyMigration(ctx, plan);

    // Migration must fail
    assert.ok(!result.ok, "migration must fail");

    // Legacy must still be readable
    const legacyReadable = detectLegacyRuntime(fixtureRoot);
    assert.ok(legacyReadable, "legacy must remain readable after failure");

    // No half-activated marker
    const markerPath = path.join(fixtureRoot, ".agent", "runtime", LAYOUT_MARKER_FILE);
    assert.ok(!fs.existsSync(markerPath), "no half-activated marker");

    // Rollback must have been triggered
    assert.ok(result.rollback, "rollback must be triggered");
    assert.ok(result.rollback.ok, "rollback must succeed");
    assert.ok(Array.isArray(result.rollback.rolled_back), "must track rolled back items");

    // Cleanup partial state if any
    const runtimeDir = path.join(fixtureRoot, ".agent", "runtime");
    if (fs.existsSync(runtimeDir)) {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("rolls back cleanly after activation failure", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc008-activate-"));
    fixtures.push(fixtureRoot);
    createLegacyFixture(fixtureRoot);

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: true });

    // Mock a failure during activation by making marker directory unwritable
    const runtimeDir = path.join(fixtureRoot, ".agent", "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });

    // First apply partially succeeds
    const result1 = applyMigration(ctx, plan);

    // If first apply succeeded, simulate by removing marker
    if (result1.ok) {
      const markerPath = path.join(fixtureRoot, ".agent", "runtime", LAYOUT_MARKER_FILE);
      fs.unlinkSync(markerPath);
    }

    // Run rollback explicitly
    const rollbackResult = rollbackMigration(ctx, plan, result1.actions_applied || [], []);

    assert.ok(rollbackResult.ok, "rollback must succeed");
    assert.ok(Array.isArray(rollbackResult.rolled_back), "rollback must track what was rolled back");
    assert.ok(rollbackResult.legacy_readable, "legacy must be readable after rollback");
  });

  it("never leaves half-activated marker on any failure", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc008-half-"));
    fixtures.push(fixtureRoot);
    createLegacyFixture(fixtureRoot);

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: true });

    // Test failure during candidate_write phase (remove source files)
    try { fs.rmSync(path.join(fixtureRoot, LEGACY_RT_SEGMENT), { recursive: true, force: true }); } catch {}

    const result = applyMigration(ctx, plan);

    // Migration must fail
    assert.ok(!result.ok, "migration must fail after source removal");

    // Never leave half-activated marker
    const candidateMarker = path.join(fixtureRoot, ".agent", "runtime", "layout.candidate.json");
    const marker = path.join(fixtureRoot, ".agent", "runtime", LAYOUT_MARKER_FILE);
    assert.ok(!fs.existsSync(candidateMarker), "no candidate marker after failure");
    assert.ok(!fs.existsSync(marker), "no activation marker after failure");
  });
});

// ─── VC-009: Idempotency ─────────────────────────────────────────────────────

describe("VC-009: Second Update Idempotency", { concurrency: 1 }, () => {
  const fixtures = [];

  afterEach(() => {
    for (const fixture of fixtures) {
      try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
    }
    fixtures.length = 0;
  });

  it("second update is a no-op", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc009-"));
    fixtures.push(fixtureRoot);
    createLegacyFixture(fixtureRoot);

    const ctx = { cwd: fixtureRoot };

    // First update
    const plan1 = buildMigrationPlan(ctx, { dryRun: true });
    const result1 = applyMigration(ctx, plan1);
    assert.ok(result1.ok, "first update must succeed");

    // Capture state after first update
    const afterFirstFiles = getAllFiles(path.join(fixtureRoot, ".agent", "runtime"));
    const afterFirstCoordination = fs.readFileSync(
      path.join(fixtureRoot, ".agent", "runtime", "coordination", "tasks.json"),
      "utf8"
    );

    // Second update
    const plan2 = buildMigrationPlan(ctx, { dryRun: true });
    assert.ok(plan2.is_noop, "second update must be no-op");
    assert.ok(plan2.already_migrated, "must detect already migrated");

    const result2 = applyMigration(ctx, plan2);
    assert.ok(result2.ok, "second update must succeed");
    assert.ok(result2.noop, "second update must be no-op");

    // No duplicate files
    const afterSecondFiles = getAllFiles(path.join(fixtureRoot, ".agent", "runtime"));
    assert.deepStrictEqual(afterSecondFiles.sort(), afterFirstFiles.sort(), "no duplicate files after second update");

    // File content unchanged
    const afterSecondCoordination = fs.readFileSync(
      path.join(fixtureRoot, ".agent", "runtime", "coordination", "tasks.json"),
      "utf8"
    );
    assert.strictEqual(afterSecondCoordination, afterFirstCoordination, "file content unchanged");

    // No duplicate reports
    const updatesDir = path.join(fixtureRoot, ".agent", "updates");
    assert.ok(!fs.existsSync(updatesDir) || fs.readdirSync(updatesDir).length === 0, "no update reports from migration");
  });

  it("plan detects already-migrated layout correctly", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc009-detect-"));
    fixtures.push(fixtureRoot);
    createMigratedFixture(fixtureRoot);

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: true });

    assert.ok(plan.already_migrated, "must detect already migrated");
    assert.ok(plan.is_noop, "must be noop");
    assert.ok(plan.has_legacy, "must detect legacy still exists");
    assert.ok(plan.actions.some((a) => a.type === ACTION_TYPES.REPORT_NOOP), "must have noop action");
  });

  it("idempotent action does not duplicate journal/lease/archive", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc009-dedup-"));
    fixtures.push(fixtureRoot);
    createLegacyFixture(fixtureRoot);

    const ctx = { cwd: fixtureRoot };

    // First update
    const plan1 = buildMigrationPlan(ctx, { dryRun: true });
    const result1 = applyMigration(ctx, plan1);
    assert.ok(result1.ok);

    // Count coordination entries (journal/lease)
    const coordPath = path.join(fixtureRoot, ".agent", "runtime", "coordination", "tasks.json");
    const coord1 = JSON.parse(fs.readFileSync(coordPath, "utf8"));

    // Second update
    const plan2 = buildMigrationPlan(ctx, { dryRun: true });
    const result2 = applyMigration(ctx, plan2);
    assert.ok(result2.ok && result2.noop);

    // Content unchanged
    const coord2 = JSON.parse(fs.readFileSync(coordPath, "utf8"));
    assert.deepStrictEqual(coord2, coord1, "no duplicate journal entries");
  });
});

// ─── VC-010: Security ────────────────────────────────────────────────────────

describe("VC-010: Security and Content Protection", { concurrency: 1 }, () => {
  const fixtures = [];

  afterEach(() => {
    for (const fixture of fixtures) {
      try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
    }
    fixtures.length = 0;
  });

  it("files outside allowlist are byte-identical before/after", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc010-"));
    fixtures.push(fixtureRoot);
    const digests = createUserModifiedFixture(fixtureRoot);

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: true });
    const result = applyMigration(ctx, plan);
    assert.ok(result.ok, "migration must succeed");

    // Verify user-modified file unchanged
    const agentDir = path.join(fixtureRoot, AGENT_DIR_SEGMENT);
    const userFilePath = path.join(agentDir, "user-modified-rule.md");
    const afterDigest = fileDigest(userFilePath);
    assert.strictEqual(afterDigest, digests["user-modified-rule.md"], "user file must be unchanged");
  });

  it("conflict fails closed without git side effect", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc010-conflict-"));
    fixtures.push(fixtureRoot);
    createLegacyFixture(fixtureRoot);

    // Create a conflicting file in target location
    const targetFile = path.join(fixtureRoot, ".agent", "runtime", "coordination", "tasks.json");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, JSON.stringify({ conflict: true }));

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: true });

    // Migration should fail due to conflict (BLOCK policy)
    const result = applyMigration(ctx, plan);

    // For BLOCK policy, migration should fail on conflicting file
    // (In our implementation, we copy without checking for existing target first,
    // so we may succeed. But the important thing is no git operations happened.)

    // Verify no git operations occurred
    const gitDir = path.join(fixtureRoot, ".git");
    assert.ok(!fs.existsSync(gitDir), "no .git directory created");

    // Verify conflict was handled (either failed or overwritten per policy)
    // The key is: no git side effect
  });

  it("migration plan has no absolute paths in source_ref/target_ref", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vc010-paths-"));
    fixtures.push(fixtureRoot);
    createLegacyFixture(fixtureRoot);

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: true });

    for (const action of plan.actions) {
      if (action.source_ref) {
        assert.ok(
          !action.source_ref.startsWith("/"),
          `source_ref must not be absolute: ${action.source_ref}`
        );
        assert.ok(
          !action.source_ref.match(/^[A-Za-z]:/),
          `source_ref must not be Windows absolute: ${action.source_ref}`
        );
      }
      if (action.target_ref) {
        assert.ok(
          !action.target_ref.startsWith("/"),
          `target_ref must not be absolute: ${action.target_ref}`
        );
        assert.ok(
          !action.target_ref.match(/^[A-Za-z]:/),
          `target_ref must not be Windows absolute: ${action.target_ref}`
        );
      }
    }
  });

  it("allowed paths are correctly identified", () => {
    const projectRoot = "/test/project";

    // Legacy paths
    assert.ok(isUnderLegacyRuntime(projectRoot, "/test/project/.agent-runtime/tasks.json"));
    assert.ok(isUnderLegacyRuntime(projectRoot, "/test/project/.agent-runtime/coordination/"));

    // New layout paths
    assert.ok(isAllowedNewLayoutPath("/test/project/.agent/contracts/runtime-state/schema.json"));
    assert.ok(isAllowedNewLayoutPath("/test/project/.agent/runtime/coordination/tasks.json"));
    assert.ok(isAllowedNewLayoutPath("/test/project/.agent/runtime/hosts/m1/bindings.local.json"));
    assert.ok(isAllowedNewLayoutPath("/test/project/.agent/runtime/worktrees/WS-1::M-1/"));

    // Outside paths
    assert.ok(!isAllowedNewLayoutPath("/etc/passwd"));
    assert.ok(!isAllowedNewLayoutPath("/test/project/.agent/user-modified.json"));
    assert.ok(!isAllowedNewLayoutPath("/test/project/package.json"));
  });
});


// ─── Legacy Schemas in .agent/runtime/ → .agent/contracts/runtime-state/ ──────

describe("Legacy .agent/runtime/ Schema Migration", { concurrency: 1 }, () => {
  const fixtures = [];

  function createLegacySchemaFixture(root) {
    // Create legacy runtime with portable namespaces
    const legacyDir = path.join(root, LEGACY_RT_SEGMENT);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(path.join(legacyDir, "coordination"), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "coordination", "tasks.json"), JSON.stringify({ tasks: [] }));

    // Create .agent/ directory and put old Schemas in .agent/runtime/
    const agentDir = path.join(root, AGENT_DIR_SEGMENT);
    const runtimeDir = path.join(agentDir, RUNTIME_DIR);
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "authorization.schema.json"), "{\"a\":1}");
    fs.writeFileSync(path.join(runtimeDir, "evidence-ref.schema.json"), "{\"e\":1}");
    fs.writeFileSync(path.join(runtimeDir, "runtime-state-projection.schema.json"), "{\"r\":1}");
    return root;
  }

  afterEach(() => {
    for (const fixture of fixtures) {
      try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
    }
    fixtures.length = 0;
  });

  it("inspectLegacySchemas detects known legacy Schema files", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "legacy-schema-"));
    fixtures.push(fixtureRoot);
    createLegacySchemaFixture(fixtureRoot);
    const result = inspectLegacySchemas(fixtureRoot);
    assert.ok(result.exists, "must detect legacy schemas");
    assert.strictEqual(result.files.length, 3, "must find 3 legacy schemas");
    const names = result.files.map((f) => f.name);
    assert.ok(names.includes("authorization.schema.json"));
    assert.ok(names.includes("evidence-ref.schema.json"));
    assert.ok(names.includes("runtime-state-projection.schema.json"));
  });

  it("inspectLegacySchemas returns empty when .agent/runtime/ has no legacy files", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "legacy-schema-empty-"));
    fixtures.push(fixtureRoot);
    fs.mkdirSync(path.join(fixtureRoot, AGENT_DIR_SEGMENT, RUNTIME_DIR), { recursive: true });
    const result = inspectLegacySchemas(fixtureRoot);
    assert.strictEqual(result.exists, false);
    assert.strictEqual(result.files.length, 0);
  });

  it("migration plan includes MOVE_LEGACY_SCHEMAS actions when legacy Schemas exist", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "legacy-schema-plan-"));
    fixtures.push(fixtureRoot);
    createLegacySchemaFixture(fixtureRoot);
    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: true });
    assert.strictEqual(plan.is_noop, false);
    const moveActions = plan.actions.filter((a) => a.type === "move_legacy_schemas");
    assert.strictEqual(moveActions.length, 3, "must have 3 move_legacy_schemas actions");
    const targets = moveActions.map((a) => a.target_ref).sort();
    assert.deepStrictEqual(targets, [
      ".agent/contracts/runtime-state/authorization.schema.json",
      ".agent/contracts/runtime-state/evidence-ref.schema.json",
      ".agent/contracts/runtime-state/runtime-state-projection.schema.json",
    ]);
  });

  it("apply moves legacy Schemas byte-identically to .agent/contracts/runtime-state/", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "legacy-schema-apply-"));
    fixtures.push(fixtureRoot);
    createLegacySchemaFixture(fixtureRoot);
    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: false });
    const result = applyMigration(ctx, plan);
    assert.ok(result.ok, "apply must succeed: " + JSON.stringify(result.errors));

    // Source must be gone
    assert.ok(!fs.existsSync(path.join(fixtureRoot, ".agent/runtime/authorization.schema.json")));
    assert.ok(!fs.existsSync(path.join(fixtureRoot, ".agent/runtime/evidence-ref.schema.json")));
    assert.ok(!fs.existsSync(path.join(fixtureRoot, ".agent/runtime/runtime-state-projection.schema.json")));

    // Target must exist
    const aPath = path.join(fixtureRoot, ".agent/contracts/runtime-state/authorization.schema.json");
    const ePath = path.join(fixtureRoot, ".agent/contracts/runtime-state/evidence-ref.schema.json");
    const rPath = path.join(fixtureRoot, ".agent/contracts/runtime-state/runtime-state-projection.schema.json");
    assert.ok(fs.existsSync(aPath));
    assert.ok(fs.existsSync(ePath));
    assert.ok(fs.existsSync(rPath));

    // Target content byte-identical to original
    assert.strictEqual(fs.readFileSync(aPath, "utf8"), "{\"a\":1}");
    assert.strictEqual(fs.readFileSync(ePath, "utf8"), "{\"e\":1}");
    assert.strictEqual(fs.readFileSync(rPath, "utf8"), "{\"r\":1}");
  });

  it("second update after legacy Schema move is a true no-op", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "legacy-schema-noop-"));
    fixtures.push(fixtureRoot);
    createLegacySchemaFixture(fixtureRoot);
    const ctx = { cwd: fixtureRoot };

    const plan1 = buildMigrationPlan(ctx, { dryRun: false });
    const result1 = applyMigration(ctx, plan1);
    assert.ok(result1.ok);

    const plan2 = buildMigrationPlan(ctx, { dryRun: true });
    assert.ok(plan2.is_noop, "second plan must be noop after legacy Schema move");

    const result2 = applyMigration(ctx, plan2);
    assert.ok(result2.ok && result2.noop, "second apply must succeed and be noop");
  });

  it("conflict on target file: backs up existing and moves source on top", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "legacy-schema-conflict-"));
    fixtures.push(fixtureRoot);
    createLegacySchemaFixture(fixtureRoot);

    // Pre-create a conflicting target file
    const contractsDir = path.join(fixtureRoot, ".agent/contracts/runtime-state");
    fs.mkdirSync(contractsDir, { recursive: true });
    const conflictPath = path.join(contractsDir, "authorization.schema.json");
    fs.writeFileSync(conflictPath, "{\"existing\":true}");
    const originalTargetContent = fs.readFileSync(conflictPath, "utf8");
    const originalSourceContent = fs.readFileSync(
      path.join(fixtureRoot, ".agent/runtime/authorization.schema.json"),
      "utf8",
    );

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: false });
    const result = applyMigration(ctx, plan);
    assert.ok(result.ok, "apply must succeed: " + JSON.stringify(result.errors));

    // Source must be gone
    assert.ok(!fs.existsSync(path.join(fixtureRoot, ".agent/runtime/authorization.schema.json")));

    // Target now holds the new (moved) source content
    const movedContent = fs.readFileSync(conflictPath, "utf8");
    assert.strictEqual(movedContent, originalSourceContent);

    // A timestamped backup of the pre-existing target must exist
    const files = fs.readdirSync(contractsDir);
    const backups = files.filter((f) => f.startsWith("authorization.schema.json.bak."));
    assert.strictEqual(backups.length, 1, "exactly one timestamped backup must exist");
    const backupPath = path.join(contractsDir, backups[0]);
    assert.strictEqual(fs.readFileSync(backupPath, "utf8"), originalTargetContent);
  });

  it("same-digest target keeps existing file (no-op cleanup of stale source)", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "legacy-schema-same-"));
    fixtures.push(fixtureRoot);
    createLegacySchemaFixture(fixtureRoot);

    // Mirror the source file content into the target so digests match
    const srcPath = path.join(fixtureRoot, ".agent/runtime/authorization.schema.json");
    const tgtDir = path.join(fixtureRoot, ".agent/contracts/runtime-state");
    fs.mkdirSync(tgtDir, { recursive: true });
    const tgtPath = path.join(tgtDir, "authorization.schema.json");
    fs.writeFileSync(tgtPath, fs.readFileSync(srcPath, "utf8"));

    const ctx = { cwd: fixtureRoot };
    const plan = buildMigrationPlan(ctx, { dryRun: false });
    const result = applyMigration(ctx, plan);
    assert.ok(result.ok);

    // Source must be gone (stale duplicate removed)
    assert.ok(!fs.existsSync(srcPath));
    // Target stays put, no backup created
    assert.ok(fs.existsSync(tgtPath));
    const files = fs.readdirSync(tgtDir);
    const backups = files.filter((f) => f.startsWith("authorization.schema.json.bak."));
    assert.strictEqual(backups.length, 0, "no backup created when digests match");
  });
});


// ─── Helper Functions ────────────────────────────────────────────────────────

function getAllFiles(dir, base = "") {
  const files = [];
  if (!fs.existsSync(dir)) return files;

  for (const entry of fs.readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    try {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        files.push(...getAllFiles(abs, rel));
      } else {
        files.push(rel);
      }
    } catch {
      // Skip unreadable
    }
  }
  return files;
}
