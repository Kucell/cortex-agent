"use strict";

// Reconstructed from the pinned Management API contract.
// These tests verify Decision/Waitpoint isolation, not a complete release gate.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const VARIANTS = ["_shared", "en", "zh"];
const DECISION_ID = "D-isolation";
const RESOURCE = "proposal:test#digest:0123456789abcdef";
const OUTCOMES = [
  ["approved", "approve"],
  ["rejected", "reject"],
  ["revision_requested", "revise"],
  ["canceled", "cancel"],
];

function write(cwd, relative, value) {
  const file = path.join(cwd, ".agent", relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function read(cwd, relative) {
  return JSON.parse(fs.readFileSync(path.join(cwd, ".agent", relative), "utf8"));
}

function snapshot(cwd) {
  const root = path.join(cwd, ".agent");
  const files = {};
  function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else files[relative] = fs.readFileSync(path.join(dir, entry.name), "utf8");
    }
  }
  walk(root, "");
  return files;
}

function changed(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((file) => before[file] !== after[file]).sort();
}

function run(variant, cwd, args) {
  const script = path.join(cwd, ".agent", "skills", "management-api", "scripts", "index.js");
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, CORTEX_STATE_SYNC: "off" },
  });
}

function fixture(t, variant) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-decision-isolation-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const scripts = path.join(cwd, ".agent", "skills", "management-api", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of ["index.js", "normalize-token-usage.js", "query-activity.js", "query-dispatch-state.js", "projection-registry.json"]) {
    const sourceVariant = file === "index.js" ? variant : "_shared";
    fs.copyFileSync(
      path.join(ROOT, "templates", sourceVariant, ".agent", "skills", "management-api", "scripts", file),
      path.join(scripts, file),
    );
  }
  const taskScripts = path.join(cwd, ".agent", "tasks", "scripts");
  fs.mkdirSync(taskScripts, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, "templates", "_shared", ".agent", "tasks", "scripts", "task-state.js"),
    path.join(taskScripts, "task-state.js"),
  );
  const requested = run(variant, cwd, [
    "decisions", "request", "--decision-id", DECISION_ID, "--gate", "mission",
    "--type", "approval", "--requested-by", "test", "--prompt", "Approve?",
    "--gate-action", "architecture", "--resource-ref", RESOURCE,
    "--options", '["approve","reject","revise","cancel"]',
  ]);
  assert.equal(requested.status, 0, requested.stderr + requested.stdout);

  const cases = [
    ["WP-blocked", { status: "blocked" }],
    ["WP-pending", { status: "pending" }],
    ["WP-released", { status: "released" }],
    ["WP-canceled", { status: "canceled" }],
    ["WP-expired", { status: "expired", expires_at: "2000-01-01T00:00:00Z" }],
    ["WP-elapsed", { status: "blocked", expires_at: "2000-01-01T00:00:00Z" }],
    ["WP-invalid-expiry", { status: "blocked", expires_at: "invalid-date" }],
    ["WP-other-owner", { status: "blocked", owner_workflow: "/other" }],
    ["WP-other-action", { status: "blocked", gate: { action: "merge", resource_ref: RESOURCE } }],
    ["WP-other-resource", { status: "blocked", gate: { action: "architecture", resource_ref: "proposal:other" } }],
    ["WP-other-decision", { status: "blocked", decision_id: "D-other" }],
  ];
  const entries = [];
  for (const [id, overrides] of cases) {
    const value = {
      schema_version: 1,
      waitpoint_id: id,
      owner_workflow: "/mission",
      reason: "Isolation fixture",
      gate: { action: "architecture", resource_ref: RESOURCE },
      decision_id: DECISION_ID,
      evidence_refs: ["fixture:existing"],
      release_note: null,
      released_by: null,
      released_at: null,
      expires_at: null,
      relations: {},
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      workflow_gate: "mission",
      ...overrides,
    };
    write(cwd, "waitpoints/" + id + ".json", value);
    entries.push({ waitpoint_id: id, status: value.status, owner_workflow: value.owner_workflow });
  }
  write(cwd, "waitpoints/index.json", { waitpoints: entries });
  write(cwd, "inbox/IM-unrelated.json", { message_id: "IM-unrelated", status: "unread" });
  return cwd;
}

function resolve(variant, cwd, status, selected) {
  return run(variant, cwd, [
    "decisions", "resolve", "--decision-id", DECISION_ID, "--gate", "user",
    "--status", status, "--selected-option", selected,
    "--resolved-by", "interactive-user", "--rationale", "Explicit test choice",
  ]);
}

for (const variant of VARIANTS) {
  for (const [status, selected] of OUTCOMES) {
    test(variant + ": resolving " + status + " changes only the Decision and its index", (t) => {
      const cwd = fixture(t, variant);
      const before = snapshot(cwd);
      const result = resolve(variant, cwd, status, selected);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const body = JSON.parse(result.stdout);
      assert.deepEqual(changed(before, snapshot(cwd)), [
        "decisions/" + DECISION_ID + ".json", "decisions/index.json",
      ]);
      assert.deepEqual(body.changed_paths, [
        ".agent/decisions/" + DECISION_ID + ".json", ".agent/decisions/index.json",
      ]);
      assert.deepEqual(body.changed_resources, ["decision:" + DECISION_ID]);
      assert.equal(body.decision.status, status);
      assert.equal(body.decision.selected_option, selected);
      assert.equal(read(cwd, "decisions/index.json").decisions
        .find((entry) => entry.decision_id === DECISION_ID).status, status);

      const terminal = snapshot(cwd);
      const repeated = resolve(variant, cwd, status, selected);
      assert.equal(repeated.status, 1, repeated.stderr + repeated.stdout);
      assert.equal(JSON.parse(repeated.stdout).error, "decision_not_open");
      assert.deepEqual(snapshot(cwd), terminal);
    });
  }

  test(variant + ": an owning workflow can still explicitly release after approval", (t) => {
    const cwd = fixture(t, variant);
    const result = resolve(variant, cwd, "approved", "approve");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(read(cwd, "waitpoints/WP-blocked.json").status, "blocked");
    const beforeRelease = snapshot(cwd);
    const released = run(variant, cwd, [
      "waitpoints", "release", "--waitpoint-id", "WP-blocked", "--gate", "owner",
      "--owner-workflow", "/mission", "--decision-id", DECISION_ID,
      "--released-by", "mission-coordinator",
    ]);
    assert.equal(released.status, 0, released.stderr + released.stdout);
    assert.deepEqual(changed(beforeRelease, snapshot(cwd)), [
      "waitpoints/WP-blocked.json", "waitpoints/index.json",
    ]);
    const waitpoint = read(cwd, "waitpoints/WP-blocked.json");
    assert.equal(waitpoint.status, "released");
    assert.equal(waitpoint.released_by, "mission-coordinator");
    assert.deepEqual(waitpoint.evidence_refs, [".agent/decisions/" + DECISION_ID + ".json"]);
  });
}
