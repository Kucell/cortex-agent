"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const EN = path.join(ROOT, "templates/en/.agent/skills/runtime-state-integration");
const ZH = path.join(ROOT, "templates/zh/.agent/skills/runtime-state-integration");
const SHARED = path.join(ROOT, "templates/_shared/.agent/skills/runtime-state-integration");
const SCRIPT = path.join(SHARED, "scripts/index.js");

function invoke(mode, input) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-state-integration-"));
  const source = path.join(directory, "input.json");
  fs.writeFileSync(source, `${JSON.stringify(input)}\n`);
  const result = spawnSync(process.execPath, [SCRIPT, mode, "--input", source], { encoding: "utf8" });
  return { ...result, json: JSON.parse(result.stdout) };
}

function completeContract() {
  return {
    feature: "workspace-hook",
    classification: "stateful",
    characteristics: { lifecycle: true },
    contract: {
      resource: { stable_id: "HOOK-001", schema: "hook.schema.json", owner: "run", relations: ["task", "run", "session"] },
      state_machine: { initial: "pending", legal_transitions: ["pending->running"], terminal: ["complete"], failure: "failed", recovery: "retry" },
      event_journal: { append_only: true, actor: "worker", transition: "pending->running", evidence_relations: ["EV-001"] },
      evidence: { references: ["EV-001"], redaction: true, log_cursors: ["CUR-001"] },
      write_gate: { workflow: "/worktree", owner_checks: true, decision_gate: true, waitpoint_gate: true },
      query_projection: { management_api: "query hook", read_only: true, legacy_tolerant: true },
      consumer_surface: { consumers: ["CLI", "Dashboard"], shared_projection: true }
    }
  };
}

test("template machine files remain identical and rules cover the seven-part invariant", () => {
  assert.ok(fs.existsSync(SCRIPT));
  for (const locale of ["en", "zh"]) {
    const rule = fs.readFileSync(path.join(ROOT, `templates/${locale}/.agent/rules/runtime-state-integration.md`), "utf8");
    for (const term of ["Resource", "State machine", "Event journal", "Evidence", "Write gate", "Query projection", "Consumer surface"]) {
      assert.match(rule.toLowerCase(), new RegExp(term.toLowerCase().replace(" ", ".?")));
    }
  }
});

test("ASSESS is conservative and grants exemptions only with explicit guarantees", () => {
  const ambiguous = invoke("assess", { feature: "unknown" });
  assert.equal(ambiguous.status, 0);
  assert.equal(ambiguous.json.classification, "stateful");
  assert.equal(ambiguous.json.fail_closed, true);

  const exempt = invoke("assess", {
    feature: "formatter",
    characteristics: { lifecycle: false, persistent: false, side_effects: false, failure_or_recovery: false, queried: false, delivery_evidence: false },
    exemption: { synchronous: true, side_effect_free: true, non_persistent: true, no_durable_identity_owner_event_evidence: true, reason: "Pure string transform" }
  });
  assert.equal(exempt.json.classification, "exempt");
  assert.equal(exempt.json.exemption_gaps.length, 0);
});

test("CREATE normalizes without inventing missing contract evidence", () => {
  const result = invoke("create", { feature: "partial", characteristics: { persistent: true }, contract: { resource: { stable_id: "R-1" } } });
  assert.equal(result.status, 0);
  assert.equal(result.json.status, "FAIL");
  assert.equal(result.json.contract.resource.stable_id, "R-1");
  assert.deepEqual(result.json.contract.evidence, {});
  assert.ok(result.json.blocking_gaps.includes("contract.evidence.references"));
});

test("CHECK passes a complete contract and fails closed on every missing section", () => {
  const pass = invoke("check", completeContract());
  assert.equal(pass.status, 0);
  assert.equal(pass.json.status, "PASS");
  assert.equal(pass.json.covered_sections.length, 7);

  for (const section of ["resource", "state_machine", "event_journal", "evidence", "write_gate", "query_projection", "consumer_surface"]) {
    const input = completeContract();
    delete input.contract[section];
    const failed = invoke("check", input);
    assert.equal(failed.status, 1, section);
    assert.equal(failed.json.status, "FAIL");
    assert.ok(failed.json.blocking_gaps.includes(`contract.${section}`));
  }
});

test("CHECK enforces read-only/redaction integrity and target-side log cursors", () => {
  const input = completeContract();
  input.contract.query_projection.read_only = false;
  input.contract.evidence.redaction = false;
  input.contract.cross_target_time_filtered_logs = true;
  const result = invoke("check", input);
  assert.equal(result.status, 1);
  assert.ok(result.json.blocking_gaps.includes("contract.query_projection.read_only_true"));
  assert.ok(result.json.blocking_gaps.includes("contract.evidence.redaction_true"));
  assert.ok(result.json.blocking_gaps.includes("contract.evidence.target_side_timestamp_true"));
  assert.ok(result.json.blocking_gaps.includes("contract.evidence.cursor_per_producer_true"));
});

test("SUMMARIZE is deterministic and sorts evidence and consumers", () => {
  const input = completeContract();
  input.contract.evidence.references = ["Z", "A", "Z"];
  input.contract.consumer_surface.consumers = ["MCP", "CLI", "MCP"];
  const first = invoke("summarize", input);
  const second = invoke("summarize", input);
  assert.equal(first.stdout, second.stdout);
  assert.deepEqual(first.json.evidence_references, ["A", "Z"]);
  assert.deepEqual(first.json.consumers, ["CLI", "MCP"]);
});
