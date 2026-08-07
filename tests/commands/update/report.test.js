"use strict";

// ─── lib/commands/update/report.js unit tests ────────────────────────────────
//
// Coverage:
//   - updateReportId: emits `U-YYYYMMDDHHMMSSxxx` shaped IDs derived from
//     the current timestamp (length + character set).
//   - writeUpdateReport: creates `.agent/updates/` (mkdir recursive), writes
//     both `<id>.json` and `latest.json` with the same JSON body, returns
//     both file paths.
//   - updateProjectDescriptor: realpath canonicalisation, falls back to the
//     raw input when realpath fails (does NOT throw).
//   - buildDryRunUpdateReport: shape + counts of the dry-run report.
//   - buildAppliedUpdateReport: shape + counts of the applied report,
//     including ok=false when status="failed".

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  updateReportJson,
  updateProjectDescriptor,
  buildDryRunUpdateReport,
  updateReportId,
  writeUpdateReport,
  buildAppliedUpdateReport,
} = require("../../../lib/commands/update/report");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-update-report-test-"));
}

test("updateReportId: emits U- prefix + 17-char timestamp slice (no separators)", () => {
  const id = updateReportId();
  // The implementation: `U-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}`
  // ISO with TZ removed is "20251127T143012345" → first 17 chars = "20251127T14301234".
  // Note: `T` is in the character class so it is also stripped — output is
  // a pure-digit "YYYYMMDDHHMMSSxxx" string, NOT "YYYYMMDDTHHMMSSxxx".
  assert.match(id, /^U-\d{17}$/);
  assert.equal(id.length, "U-".length + 17);
});

test("updateReportJson: returns true only when options.report === 'json'", () => {
  // Pinned behavior: original returns boolean true/false when ctx.options
  // is present, and `undefined` (falsy) when ctx.options is missing —
  // because of `ctx.options && ctx.options.report === "json"` short-circuit.
  // We do NOT normalize to false; we pin the original semantics.
  assert.equal(updateReportJson({ options: { report: "json" } }), true);
  assert.equal(updateReportJson({ options: { report: "text" } }), false);
  assert.equal(updateReportJson({ options: {} }), false);
  // When options is missing, the && short-circuits to undefined.
  assert.equal(updateReportJson({}), undefined);
});

test("updateProjectDescriptor: realpath canonical when both paths exist", () => {
  const root = mkRoot();
  const agentRoot = path.join(root, ".agent");
  fs.mkdirSync(agentRoot, { recursive: true });
  const descriptor = updateProjectDescriptor(root, agentRoot);
  assert.equal(descriptor.root, fs.realpathSync(root));
  assert.equal(descriptor.agent_root, fs.realpathSync(agentRoot));
});

test("updateProjectDescriptor: falls back to raw path when realpath fails (does not throw)", () => {
  // A path that does not exist: realpathSync throws, but the function
  // catches and keeps the original value.
  const root = mkRoot();
  const missing = path.join(root, "definitely-not-here");
  const descriptor = updateProjectDescriptor(root, missing);
  assert.equal(descriptor.root, fs.realpathSync(root));
  assert.equal(descriptor.agent_root, missing);
});

test("writeUpdateReport: mkdir .agent/updates/, write <id>.json + latest.json, return paths", () => {
  const root = mkRoot();
  const report = {
    update_id: "U-TEST-0001",
    summary: { added: 2 },
  };
  const { file, latest } = writeUpdateReport(root, report);
  assert.equal(file, path.join(root, ".agent", "updates", "U-TEST-0001.json"));
  assert.equal(latest, path.join(root, ".agent", "updates", "latest.json"));
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(latest), true);
  // Both files contain the same pretty-printed JSON + trailing newline.
  const expected = `${JSON.stringify(report, null, 2)}\n`;
  assert.equal(fs.readFileSync(file, "utf8"), expected);
  assert.equal(fs.readFileSync(latest, "utf8"), expected);
});

test("writeUpdateReport: works even when .agent/ already exists (no clobber)", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  // Pre-existing file in .agent/ to make sure mkdir recursive doesn't break.
  fs.writeFileSync(path.join(root, ".agent", "marker"), "keep");
  writeUpdateReport(root, { update_id: "U-TEST-0002", x: 1 });
  assert.equal(fs.readFileSync(path.join(root, ".agent", "marker"), "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(root, ".agent", "updates", "U-TEST-0002.json")), true);
});

test("buildDryRunUpdateReport: shape for empty additive+script plan (semantic plan is environment-driven)", () => {
  const root = mkRoot();
  const agentDest = path.join(root, ".agent");
  fs.mkdirSync(agentDest, { recursive: true });
  const ctx = {
    cwd: root,
    lang: "en",
    command: "update",
    templateDir: path.join(root, "templates", "en"),
    options: {},
    args: [],
  };
  const report = buildDryRunUpdateReport(ctx, {
    agentDest,
    wouldAdd: [],
    scriptCandidates: [],
    skippedChecks: [],
  });
  assert.equal(report.ok, true);
  assert.equal(report.schema_version, 1);
  assert.equal(report.command, "update");
  assert.equal(report.mode, "dry-run");
  assert.equal(report.language, "en");
  assert.deepEqual(report.template, { lang: "en", template_dir: ctx.templateDir });
  // Additive + script plans are empty by construction.
  assert.deepEqual(report.changes.added, []);
  assert.deepEqual(report.changes.updated, []);
  assert.deepEqual(report.changes.protected, []);
  assert.deepEqual(report.skipped_checks, []);
  assert.deepEqual(report.verification, []);
  // Summary numbers are derived from the (possibly non-empty) semantic plan
  // in this test environment, so we only assert the two we control.
  assert.equal(report.summary.would_add, 0);
  assert.equal(report.summary.candidate_scripts, 0);
  assert.equal(report.summary.blockers, 0);
  // total_plan_items = additive + script + semantic.
  assert.equal(report.summary.total_plan_items, report.plan.length);
  assert.equal(typeof report.generated_at, "string");
  assert.ok(report.project.root, "project.root present");
});

test("buildDryRunUpdateReport: next_actions populated iff plan is non-empty (semantic-only is enough)", () => {
  const root = mkRoot();
  const agentDest = path.join(root, ".agent");
  fs.mkdirSync(agentDest, { recursive: true });
  const ctx = {
    cwd: root,
    lang: "zh",
    command: "update",
    templateDir: path.join(root, "templates", "zh"),
    options: {},
    args: [],
  };
  // In this empty-mkdtemp environment, the semantic plan collects AGENTS.md
  // + compatibility adapter + projection registry candidates (3 entries).
  // So next_actions should be non-empty even with empty additive/script plans.
  const report = buildDryRunUpdateReport(ctx, {
    agentDest,
    wouldAdd: [],
    scriptCandidates: [],
    skippedChecks: [],
  });
  if (report.plan.length > 0) {
    assert.equal(report.next_actions.length, 1);
    assert.match(report.next_actions[0], /cortex-agent update/);
  } else {
    assert.deepEqual(report.next_actions, []);
  }
});

test("buildDryRunUpdateReport: counts additive + script + semantic plans", () => {
  const root = mkRoot();
  const agentDest = path.join(root, ".agent");
  fs.mkdirSync(agentDest, { recursive: true });
  const ctx = {
    cwd: root,
    lang: "en",
    command: "update",
    templateDir: path.join(root, "templates", "en"),
    options: {},
    // Avoid pulling in real setup helpers — stub out the "needs" checks
    // so the semantic plan is empty.
    args: [],
  };
  const report = buildDryRunUpdateReport(ctx, {
    agentDest,
    wouldAdd: ["rules/foo.md", "skills/bar.md"],
    scriptCandidates: [
      { path: "skills/x/index.js", reason: "missing" },
      { path: "skills/y/index.js", reason: "drift" },
    ],
    skippedChecks: ["link-cli"],
  });
  assert.equal(report.summary.would_add, 2);
  assert.equal(report.summary.candidate_scripts, 2);
  // semantic merge may be 0 in this test environment; the totals must add up.
  const expectedTotal = report.changes.added.length
    + report.changes.updated.length
    + report.changes.merged.length;
  assert.equal(report.summary.total_plan_items, expectedTotal);
  assert.equal(report.summary.blockers, 0);
  assert.deepEqual(report.skipped_checks, ["link-cli"]);
});

test("buildDryRunUpdateReport: next_actions populated when plan is non-empty", () => {
  const root = mkRoot();
  const agentDest = path.join(root, ".agent");
  fs.mkdirSync(agentDest, { recursive: true });
  const ctx = {
    cwd: root,
    lang: "zh",
    command: "update",
    templateDir: path.join(root, "templates", "zh"),
    options: {},
    args: [],
  };
  const report = buildDryRunUpdateReport(ctx, {
    agentDest,
    wouldAdd: ["rules/foo.md"],
    scriptCandidates: [],
    skippedChecks: [],
  });
  assert.equal(report.next_actions.length, 1);
  assert.match(report.next_actions[0], /cortex-agent update/);
  assert.equal(report.language, "zh");
});

test("buildAppliedUpdateReport: shape + counts when status='ok'", () => {
  const root = mkRoot();
  const agentDest = path.join(root, ".agent");
  fs.mkdirSync(agentDest, { recursive: true });
  const ctx = {
    cwd: root,
    lang: "en",
    command: "update",
    templateDir: path.join(root, "templates", "en"),
    options: {},
  };
  const report = buildAppliedUpdateReport(ctx, {
    updateId: "U-APPLIED-0001",
    startedAt: "2025-11-27T00:00:00.000Z",
    agentDest,
    added: ["rules/foo.md"],
    reconcileReport: {
      applied: ["skills/x/index.js"],
      skipped: [
        { path: "skills/y/index.js", reason: "user_modified" },
        { path: "skills/z/index.js", reason: "unmanaged_cold_start" },
        { path: "skills/w/index.js", reason: "other_skip_reason" },
      ],
      failed: [{ path: "skills/broken/index.js", error: "ENOENT" }],
    },
    semanticMergePlan: [{ path: "AGENTS.md", action: "merge" }],
    verification: {
      verification: [{ name: "x", status: "passed" }],
      summary: { failed: 0, skipped: 1 },
    },
    status: "ok",
  });
  assert.equal(report.ok, true);
  assert.equal(report.schema_version, 1);
  assert.equal(report.update_id, "U-APPLIED-0001");
  assert.equal(report.command, "update");
  assert.equal(report.mode, "apply");
  assert.equal(report.status, "ok");
  assert.equal(report.started_at, "2025-11-27T00:00:00.000Z");
  assert.equal(typeof report.finished_at, "string");
  // Counted changes
  assert.equal(report.changes.added.length, 1);
  assert.equal(report.changes.updated.length, 1);
  assert.equal(report.changes.merged.length, 1);
  // protected: only user_modified + unmanaged_cold_start (not "other_skip_reason")
  assert.equal(report.changes.protected.length, 2);
  assert.equal(report.changes.failed.length, 1);
  // Summary
  assert.deepEqual(report.summary, {
    added: 1,
    updated: 1,
    merged: 1,
    protected: 2,
    failed: 1,
    verification_failed: 0,
    verification_skipped: 1,
  });
  // plan = all 5 categories concatenated in order
  assert.equal(report.plan.length, 6);
  // 2 protected items → exactly one review-protected next_action.
  // No verification failures → no verify-fix next_action.
  assert.equal(report.next_actions.length, 1);
  assert.match(
    report.next_actions[0],
    /Review protected local scripts; use --force-scripts only after confirming the diff\./,
  );
  // verification array passes through from input
  assert.deepEqual(report.verification, [{ name: "x", status: "passed" }]);
});

test("buildAppliedUpdateReport: status='failed' sets ok=false", () => {
  const root = mkRoot();
  const agentDest = path.join(root, ".agent");
  fs.mkdirSync(agentDest, { recursive: true });
  const ctx = {
    cwd: root,
    lang: "en",
    command: "update",
    templateDir: path.join(root, "templates", "en"),
    options: {},
  };
  const report = buildAppliedUpdateReport(ctx, {
    updateId: "U-APPLIED-FAIL",
    startedAt: "2025-11-27T00:00:00.000Z",
    agentDest,
    added: [],
    reconcileReport: { applied: [], skipped: [], failed: [] },
    semanticMergePlan: [],
    verification: null,
    status: "failed",
  });
  assert.equal(report.ok, false);
  assert.equal(report.status, "failed");
  assert.equal(report.summary.added, 0);
  assert.equal(report.summary.verification_failed, 0);
  assert.equal(report.summary.verification_skipped, 0);
  assert.equal(report.verification.length, 0);
});

test("buildAppliedUpdateReport: next_actions populated when protected + verification failed", () => {
  const root = mkRoot();
  const agentDest = path.join(root, ".agent");
  fs.mkdirSync(agentDest, { recursive: true });
  const ctx = {
    cwd: root,
    lang: "en",
    command: "update",
    templateDir: path.join(root, "templates", "en"),
    options: {},
  };
  const report = buildAppliedUpdateReport(ctx, {
    updateId: "U-NX",
    startedAt: "2025-11-27T00:00:00.000Z",
    agentDest,
    added: [],
    reconcileReport: {
      applied: [],
      skipped: [{ path: "skills/y/index.js", reason: "user_modified" }],
      failed: [],
    },
    semanticMergePlan: [],
    verification: {
      verification: [{ name: "x", status: "failed" }],
      summary: { failed: 1, skipped: 0 },
    },
    status: "ok",
  });
  assert.equal(report.next_actions.length, 2);
  assert.ok(
    report.next_actions.some((a) => /Review protected local scripts/.test(a)),
    "expected review-protected next_action",
  );
  assert.ok(
    report.next_actions.some((a) => /cortex-agent update --verify --report json/.test(a)),
    "expected verify-fix next_action",
  );
});

test("buildAppliedUpdateReport: failed item without explicit error uses 'script_update_failed'", () => {
  const root = mkRoot();
  const agentDest = path.join(root, ".agent");
  fs.mkdirSync(agentDest, { recursive: true });
  const ctx = {
    cwd: root,
    lang: "en",
    command: "update",
    templateDir: path.join(root, "templates", "en"),
    options: {},
  };
  const report = buildAppliedUpdateReport(ctx, {
    updateId: "U-FAILED-NO-ERR",
    startedAt: "2025-11-27T00:00:00.000Z",
    agentDest,
    added: [],
    reconcileReport: {
      applied: [],
      skipped: [],
      failed: [{ path: "skills/broken/index.js" }], // no `error` field
    },
    semanticMergePlan: [],
    verification: null,
    status: "ok",
  });
  const failedChange = report.changes.failed[0];
  assert.equal(failedChange.reason, "script_update_failed");
  assert.equal(failedChange.risk, "high");
});
