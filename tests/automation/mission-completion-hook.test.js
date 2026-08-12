"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const hook = require("../../lib/automation/mission-completion-hook");
const outbox = require("../../lib/cross-project/outbox");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-p006-hook-"));
}

function setupMission(root, missionId, contract, planFrontmatter) {
  const dir = path.join(root, ".agent", "missions", missionId);
  fs.mkdirSync(dir, { recursive: true });
  if (contract !== null) {
    fs.writeFileSync(path.join(dir, "validation-contract.json"), `${JSON.stringify(contract, null, 2)}\n`);
  }
  if (planFrontmatter !== null) {
    const planBody = [
      "---",
      ...Object.entries(planFrontmatter).map(([k, v]) => `${k}: ${v}`),
      "---",
      "",
      "# Mission Plan",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "mission-plan.md"), planBody);
  }
}

test("readMissionFrontmatter parses title/status", () => {
  const raw = "---\ntitle: M-001 Test\nstatus: planned\n---\n# body";
  const fm = hook.readMissionFrontmatter(raw);
  assert.equal(fm.title, "M-001 Test");
  assert.equal(fm.status, "planned");
});

test("readMissionFrontmatter returns null when missing", () => {
  assert.equal(hook.readMissionFrontmatter("# no frontmatter"), null);
  assert.equal(hook.readMissionFrontmatter(null), null);
});

test("findBridgeEmitFields picks only bridge_emit gates", () => {
  const contract = { gates: [
    { id: "g1", type: "manual" },
    { id: "g2", type: "bridge_emit", event_type: "checkpoint.closed" },
  ] };
  const fields = hook.findBridgeEmitFields(contract);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].event_type, "checkpoint.closed");
});

test("emitOnCompletion is a no-op when state is not done", () => {
  const root = mkRoot();
  const out = hook.emitOnCompletion(root, { mission_id: "M-019", new_state: "in_progress" });
  assert.equal(out.ok, true);
  assert.equal(out.skipped, "state not done");
});

test("emitOnCompletion returns skipped when no bridges declared", () => {
  const root = mkRoot();
  setupMission(root, "M-019", { gates: [] }, { title: "M-019" });
  const out = hook.emitOnCompletion(root, { mission_id: "M-019", new_state: "done", source_project_id: "SamHMI" });
  assert.equal(out.ok, true);
  assert.equal(out.skipped, "no bridge_emit gates declared");
});

test("emitOnCompletion emits checkpoint.closed from bridge_emit gate", () => {
  const root = mkRoot();
  setupMission(root, "M-019", {
    gates: [
      { id: "g-emit", type: "bridge_emit", event_type: "checkpoint.closed", correlation_group: "agentic-ui-delivery" },
    ],
  }, { title: "M-019", source_project_id: "SamHMI" });
  const out = hook.emitOnCompletion(root, { mission_id: "M-019", new_state: "done" });
  assert.equal(out.ok, true);
  assert.equal(out.emitted.length, 1);
  // Confirm the event lives in the outbox.
  const list = outbox.readEvents(root, { source_project_id: "SamHMI" });
  assert.equal(list.events.length, 1);
  assert.equal(list.events[0].event_type, "checkpoint.closed");
  assert.equal(list.events[0].correlation_group, "agentic-ui-delivery");
  assert.equal(list.events[0].summary.mission_id, "M-019");
});

test("emitOnCompletion respects bridge_emit_on_done frontmatter directive", () => {
  const root = mkRoot();
  setupMission(root, "M-019", null, { title: "M-019", source_project_id: "SamHMI", bridge_emit_on_done: "hmi-collab" });
  const out = hook.emitOnCompletion(root, { mission_id: "M-019", new_state: "done" });
  assert.equal(out.ok, true);
  assert.equal(out.emitted.length, 1);
  const list = outbox.readEvents(root, { source_project_id: "SamHMI" });
  assert.equal(list.events[0].correlation_group, "hmi-collab");
});

test("emitOnCompletion collects errors when event_type is missing", () => {
  const root = mkRoot();
  setupMission(root, "M-019", { gates: [{ id: "g-bad", type: "bridge_emit" /* missing event_type */ }] }, { title: "M-019", source_project_id: "SamHMI" });
  const out = hook.emitOnCompletion(root, { mission_id: "M-019", new_state: "done" });
  assert.equal(out.ok, false);
  assert.ok(out.errors[0].includes("event_type"));
});

test("emitOnCompletion requires mission_id", () => {
  const root = mkRoot();
  const out = hook.emitOnCompletion(root, { new_state: "done" });
  assert.equal(out.ok, false);
});
