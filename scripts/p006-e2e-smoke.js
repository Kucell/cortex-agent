#!/usr/bin/env node
// scripts/p006-e2e-smoke.js
//
// End-to-end smoke test for P-006 (cross-project automation pipeline).
//
//   hmi-platform                                   SamHMI
//   ──────────                                     ──────
//   bridge emit --source hmi-platform              bridge subscribe --source hmi-platform
//   ↓                                                 ↓
//   .agent-runtime/cross-project/outbox/hmi-platform/…
//                                                   bridge sync --source-root <hmi_root>
//                                                     ↓
//                                                   .agent-runtime/cross-project/inbox/hmi-platform/…
//                                                     ↓
//                                                   automation watch-inbox --handler <id>
//                                                     ↓
//                                                   .agent/missions/M-019/*.dispatch-pending.json
//
// Exits 0 only when every step succeeds.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const bridge = require("../lib/commands/bridge");
const automation = require("../lib/commands/automation");
const subscriptions = require("../lib/cross-project/subscriptions");

function step(name, fn) {
  process.stderr.write(`▶ ${name}\n`);
  const r = fn();
  if (r && r.ok === false) {
    process.stderr.write(`✗ ${name}: ${JSON.stringify(r)}\n`);
    process.exit(1);
  }
  return r;
}

function runCli(cmd, args, cwd) {
  // Wrap lib/commands directly to avoid process.exit messing with the
  // parent process state during the smoke test.
  process.exitCode = 0;
  const handler = cmd === "bridge" ? bridge.bridgeCommand : cmd === "automation" ? automation.automationCommand : null;
  if (!handler) throw new Error(`unknown cmd: ${cmd}`);
  const logs = [];
  const orig = console.log;
  console.log = (...rest) => logs.push(rest.join(" "));
  try {
    handler({ cwd, args: [cmd, ...args, "--json"], options: {} });
  } finally {
    console.log = orig;
  }
  const joined = logs.join("\n");
  try {
    return JSON.parse(joined);
  } catch {
    return { ok: false, raw: joined };
  }
}

function fresh() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p006-e2e-"));
}

function main() {
  const hmi = fresh();
  const sam = fresh();
  process.stderr.write(`hmi_root=${hmi}\nsam_root=${sam}\n`);

  // ─── 1. hmi-platform: emit task.state_changed ───
  step("hmi: emit task.state_changed", () => runCli("bridge", [
    "emit",
    "--source", "hmi-platform",
    "--type", "task.state_changed",
    "--summary", JSON.stringify({ task_id: "M-017", state: "READY_FOR_REVIEW", milestone: "MS-001" }),
    "--group", "agentic-ui-delivery",
    "--id", "BR-EVT-m017-ready",
  ], hmi));

  // ─── 2. SamHMI: subscribe to hmi-platform's events ───
  step("sam: subscribe to hmi-platform", () => {
    const result = subscriptions.addSubscription(sam, {
      source_project_id: "hmi-platform",
      correlation_group: "agentic-ui-delivery",
      event_types: ["task.state_changed", "decision.resolved", "checkpoint.closed", "waitpoint.released"],
    });
    if (!result || !result.subscriptions) return { ok: false };
    return { ok: true, index: result.index };
  });

  // ─── 3. SamHMI: bridge sync (read hmi-platform's outbox → write to SamHMI's inbox) ───
  step("sam: sync from hmi outbox", () => {
    const bridgeSync = require("../lib/cross-project/bridge-sync");
    return bridgeSync.syncForProject(sam, { sourceProjectId: "hmi-platform", sourceRoot: hmi });
  });

  // ─── 4. SamHMI: write the automation handler config ───
  step("sam: write automation handler", () => {
    const dir = path.join(sam, ".agent", "bridges");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "m019-integration.json"), `${JSON.stringify({
      source_project_id: "hmi-platform",
      event_types: ["task.state_changed"],
      correlation_group: "agentic-ui-delivery",
      target_mission_id: "M-019",
      target_milestone: "MS-INTEGRATION",
    }, null, 2)}\n`);
    return { ok: true };
  });

  // ─── 5. SamHMI: automation watch-inbox --handler m019-integration ───
  const watchResult = step("sam: automation watch-inbox", () => runCli("automation", [
    "watch-inbox", "--handler", "m019-integration", "--root", sam,
  ], sam));

  // ─── 6. SamHMI: assert dispatch sidecar was created ───
  // dispatch sidecars are written under .agent/missions/<target_mission_id>/
  const missionsRoot = path.join(sam, ".agent", "missions");
  const dispatchFiles = [];
  if (fs.existsSync(missionsRoot)) {
    for (const missionDir of fs.readdirSync(missionsRoot)) {
      const full = path.join(missionsRoot, missionDir);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const f of fs.readdirSync(full)) {
        if (f.endsWith(".dispatch-pending.json")) {
          dispatchFiles.push(path.join(missionDir, f));
        }
      }
    }
  }
  if (dispatchFiles.length === 0) {
    process.stderr.write("✗ no dispatch sidecar produced\n");
    if (fs.existsSync(missionsRoot)) {
      process.stderr.write(`  missions root listing: ${JSON.stringify(fs.readdirSync(missionsRoot))}\n`);
    } else {
      process.stderr.write(`  missions root not found: ${missionsRoot}\n`);
    }
    process.exit(2);
  }
  const sidecarRel = dispatchFiles[0];
  const sidecar = JSON.parse(fs.readFileSync(path.join(missionsRoot, sidecarRel), "utf8"));
  if (sidecar.target_mission_id !== "M-019") {
    process.stderr.write(`✗ wrong target_mission_id: ${sidecar.target_mission_id}\n`);
    process.exit(3);
  }
  if (sidecar.payload.bridge_event_id !== "BR-EVT-m017-ready") {
    process.stderr.write(`✗ wrong bridge_event_id: ${sidecar.payload.bridge_event_id}\n`);
    process.exit(4);
  }
  process.stderr.write(`✓ dispatch sidecar: ${sidecarRel} → M-019/${sidecar.target_milestone}\n`);

  // ─── 7. SamHMI: emit-on-done on M-019 (simulates completion hook) ───
  // First need to materialise M-019 with a bridge_emit gate.
  const m019Proposal = path.join(sam, ".agent", "proposals", "M-019.md");
  fs.mkdirSync(path.dirname(m019Proposal), { recursive: true });
  fs.writeFileSync(m019Proposal, [
    "---",
    "title: M-019 agentic-ui-delivery integration",
    "status: approved",
    "source_project_id: SamHMI",
    "---",
    "",
    "Integration acceptance mission.",
  ].join("\n"));
  step("sam: materialise-mission M-019", () => runCli("automation", [
    "materialise-mission", "--proposal", m019Proposal, "--mission", "M-019", "--host-root", sam,
  ], sam));
  // Augment the contract with a bridge_emit gate.
  const cpath = path.join(sam, ".agent", "missions", "M-019", "validation-contract.json");
  const contract = JSON.parse(fs.readFileSync(cpath, "utf8"));
  contract.gates.push({
    id: "g-emit",
    type: "bridge_emit",
    event_type: "checkpoint.closed",
    correlation_group: "agentic-ui-delivery",
  });
  fs.writeFileSync(cpath, `${JSON.stringify(contract, null, 2)}\n`);
  step("sam: emit-on-done M-019", () => runCli("automation", [
    "emit-on-done", "--mission", "M-019", "--source-project", "SamHMI", "--root", sam,
  ], sam));

  // ─── 8. Verify SamHMI emitted a checkpoint.closed back to its outbox ───
  const samOutbox = fs.readdirSync(path.join(sam, ".agent-runtime", "cross-project", "outbox", "SamHMI"));
  if (samOutbox.length === 0) {
    process.stderr.write("✗ SamHMI outbox empty after emit-on-done\n");
    process.exit(5);
  }
  process.stderr.write(`✓ SamHMI outbox now has ${samOutbox.length} event(s)\n`);

  process.stderr.write("\n✅ ALL P-006 SMOKE STEPS PASSED\n");
  process.exit(0);
}

main();
