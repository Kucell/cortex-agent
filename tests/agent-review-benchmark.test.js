"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, ".agent/skills/agent-review-benchmark/scripts/index.js");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-review-benchmark-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function execute(directory, command, input, name) {
  const inputFile = path.join(directory, `${name}-input.json`);
  const outputFile = path.join(directory, `${name}-output.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const result = spawnSync(process.execPath, [SCRIPT, command, "--input", inputFile, "--output", outputFile], { encoding: "utf8" });
  return { result, outputFile, text: result.status === 0 ? fs.readFileSync(outputFile, "utf8") : "" };
}

test("Guided Review groups intent and preserves evidence identities deterministically", (t) => {
  const directory = fixture(t);
  const input = {
    artifact_id: "GR-001", task_id: "T-001", run_id: "R-001", session_id: "S-001",
    workspace_ids: ["WS-b", "WS-a"], base_revision: "1234567", head_revision: "89abcde",
    generated_at: "2026-07-19T00:00:00.000Z",
    groups: [{
      group_id: "G-001", title: "Lease safety", intent: "Prevent collisions", files: ["b.js", "a.js"],
      summary: "Adds owner-checked leases", impact: "Parallel workspaces remain isolated", risk: "high",
      validation_refs: ["VC-005", "VC-004"], follow_ups: ["Document adapter", "Document adapter"]
    }]
  };
  const first = execute(directory, "review", input, "first");
  const second = execute(directory, "review", input, "second");
  assert.equal(first.result.status, 0, first.result.stdout);
  assert.equal(second.result.status, 0, second.result.stdout);
  assert.equal(first.text, second.text);
  const output = JSON.parse(first.text);
  assert.deepEqual(output.workspace_ids, ["WS-a", "WS-b"]);
  assert.deepEqual(output.groups[0].files, ["a.js", "b.js"]);
  assert.deepEqual(output.groups[0].validation_refs, ["VC-004", "VC-005"]);
  assert.equal(output.summary.follow_up_count, 1);
  assert.equal(output.summary.risk_counts.high, 1);
});

test("Benchmark keeps quality, cost, and duration separate and byte deterministic", (t) => {
  const directory = fixture(t);
  const input = {
    dataset_id: "workspace-history", dataset_version: "1", generated_at: "2026-07-19T00:00:00.000Z",
    cases: [
      { case_id: "case-b", weight: 1, runs: [
        { candidate_id: "agent-b", passed_assertions: 2, total_assertions: 2, cost_microunits: 10, duration_ms: 20, evidence_refs: ["e-b"] },
        { candidate_id: "agent-a", passed_assertions: 1, total_assertions: 2, cost_microunits: 4, duration_ms: 8, evidence_refs: ["e-a2"] }
      ] },
      { case_id: "case-a", weight: 2, runs: [
        { candidate_id: "agent-a", passed_assertions: 3, total_assertions: 3, cost_microunits: 6, duration_ms: 12, evidence_refs: ["e-a1"] },
        { candidate_id: "agent-b", passed_assertions: 2, total_assertions: 3, cost_microunits: 12, duration_ms: 22, evidence_refs: ["e-b"] }
      ] }
    ]
  };
  const first = execute(directory, "benchmark", input, "first");
  const second = execute(directory, "benchmark", input, "second");
  assert.equal(first.result.status, 0, first.result.stdout);
  assert.equal(first.text, second.text);
  const output = JSON.parse(first.text);
  assert.deepEqual(output.candidates.map((item) => item.candidate_id), ["agent-a", "agent-b"]);
  assert.equal(output.candidates[0].quality_basis_points, 8750);
  assert.equal(output.candidates[0].cost_microunits, 10);
  assert.equal(output.candidates[0].duration_ms, 20);
  assert.deepEqual(output.candidates[0].evidence_refs, ["e-a1", "e-a2"]);
});

test("invalid or self-reported inputs fail closed", (t) => {
  const directory = fixture(t);
  const missingEvidence = {
    dataset_id: "bad", dataset_version: "1", generated_at: "2026-07-19T00:00:00.000Z",
    cases: [{ case_id: "case", weight: 1, runs: [{ candidate_id: "agent", passed_assertions: 1, total_assertions: 1, cost_microunits: 0, duration_ms: 1 }]}]
  };
  assert.equal(execute(directory, "benchmark", missingEvidence, "bad").result.status, 2);
});
