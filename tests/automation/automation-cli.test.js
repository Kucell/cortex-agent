"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cli = require("../../lib/commands/automation");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-p006-auto-cli-"));
}

function mkProposalFile(root, fm, body = "# Body") {
  const file = path.join(root, "P-TEST.md");
  const yaml = [
    "---",
    ...Object.entries(fm).map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.join(", ")}]`;
      return `${k}: ${v}`;
    }),
    "---",
    "",
    body,
  ].join("\n");
  fs.writeFileSync(file, yaml);
  return file;
}

function run(args, cwd) {
  process.exitCode = 0;
  const ctx = {
    cwd,
    args: ["automation", ...args, "--json"],
    options: {},
  };
  const logs = [];
  const orig = console.log;
  console.log = (...rest) => logs.push(rest.join(" "));
  try {
    cli.automationCommand(ctx);
  } finally {
    console.log = orig;
  }
  return logs.join("\n");
}

test("automation help lists subcommands", () => {
  const text = cli.usage();
  assert.ok(/materialise-mission/.test(text));
  assert.ok(/emit-on-done/.test(text));
  assert.ok(/watch-inbox/.test(text));
  assert.ok(/approve-and-launch/.test(text));
});

test("materialise-mission writes the skeleton", () => {
  const root = mkRoot();
  const proposal = mkProposalFile(root, {
    title: "P-006 Test Pipeline",
    status: "approved",
    depends_on: ["P-001", "P-003"],
    cross_project_peers: ["alpha", "beta"],
  }, "# Body\n");
  const out = run([
    "materialise-mission", "--proposal", proposal, "--mission", "M-P006-CLI-1", "--host-root", root,
  ], root);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mission_id, "M-P006-CLI-1");
  assert.ok(fs.existsSync(path.join(root, ".agent", "missions", "M-P006-CLI-1", "mission-plan.md")));
  const contract = JSON.parse(fs.readFileSync(path.join(root, ".agent", "missions", "M-P006-CLI-1", "validation-contract.json"), "utf8"));
  assert.ok(contract.gates.some((g) => g.type === "bridge_sync"));
});

test("materialise-mission rejects missing proposal", () => {
  const root = mkRoot();
  const out = run(["materialise-mission"], root);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "INVALID_USAGE");
});

test("emit-on-done emits a bridge event for a completed mission", () => {
  const root = mkRoot();
  // First materialise so the mission dir exists with a contract.
  const proposal = mkProposalFile(root, { title: "P-006 Test", status: "approved" });
  run([
    "materialise-mission", "--proposal", proposal, "--mission", "M-P006-EMIT", "--host-root", root,
  ], root);
  // Augment the contract with a bridge_emit gate.
  const contract = path.join(root, ".agent", "missions", "M-P006-EMIT", "validation-contract.json");
  const c = JSON.parse(fs.readFileSync(contract, "utf8"));
  c.gates.push({ id: "g-emit", type: "bridge_emit", event_type: "checkpoint.closed", correlation_group: "agentic-ui-delivery" });
  fs.writeFileSync(contract, `${JSON.stringify(c, null, 2)}\n`);
  // Add a frontmatter source_project_id so the hook knows which outbox to write.
  const planPath = path.join(root, ".agent", "missions", "M-P006-EMIT", "mission-plan.md");
  const plan = fs.readFileSync(planPath, "utf8");
  fs.writeFileSync(planPath, `---\nsource_project_id: SamHMI\n---\n${plan.replace(/^---[\s\S]*?---\n/, "")}`);

  const out = run([
    "emit-on-done", "--mission", "M-P006-EMIT", "--source-project", "SamHMI", "--root", root,
  ], root);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.emitted.length, 1);
});

test("watch-inbox dispatches when handler matches", () => {
  const root = mkRoot();
  // Seed the inbox via bridge emit/consume — for the test we write the
  // .agent/bridges/<id>.json config directly + an inbox entry.
  const bridgesDir = path.join(root, ".agent", "bridges");
  fs.mkdirSync(bridgesDir, { recursive: true });
  fs.writeFileSync(path.join(bridgesDir, "h1.json"), `${JSON.stringify({
    source_project_id: "hmi-platform",
    event_types: ["task.state_changed"],
    correlation_group: "agentic-ui-delivery",
    target_mission_id: "M-019",
    target_milestone: "MS-INTEGRATION",
  }, null, 2)}\n`);
  const inboxDir = path.join(root, ".agent-runtime", "cross-project", "inbox", "hmi-platform");
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(path.join(inboxDir, "BR-EVT-p006-auto-1.json"), `${JSON.stringify({
    bridge_event_id: "BR-EVT-p006-auto-1",
    source_project_id: "hmi-platform",
    event_type: "task.state_changed",
    summary: { task_id: "M-017", state: "READY_FOR_REVIEW" },
    correlation_group: "agentic-ui-delivery",
    propagated_at: "2026-08-12T01:00:00.000Z",
  }, null, 2)}\n`);

  const out = run(["watch-inbox", "--handler", "h1", "--root", root], root);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.dispatched.length, 1);
  assert.equal(parsed.result.dispatched[0].target_mission_id, "M-019");
});

test("approve-and-launch === materialise-mission", () => {
  const root = mkRoot();
  const proposal = mkProposalFile(root, { title: "P-006 Approve Launch", status: "approved" });
  const out = run([
    "approve-and-launch", "--proposal", proposal, "--mission", "M-P006-APL", "--host-root", root,
  ], root);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mission_id, "M-P006-APL");
});

test("invalid subcommand surfaces INVALID_USAGE", () => {
  const root = mkRoot();
  const out = run(["made-up-sub"], root);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "INVALID_USAGE");
});

test.after(() => {
  // automationCommand mutates process.exitCode on invalid usage. Without this
  // reset, the node:test file-level aggregator would treat the suite as failed.
  process.exitCode = 0;
});
