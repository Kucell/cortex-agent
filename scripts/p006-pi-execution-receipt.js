"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { mapPiEventToBoundaryEvent } = require("../lib/runtime-adapters/pi-adapter");

const root = path.resolve(__dirname, "..");
const evidenceDir = path.join(root, ".agent", "missions", "M-010", "evidence");
const receiptFile = path.join(evidenceDir, "pi-execution-receipt.json");
const invocationId = `PI-M010-${crypto.randomUUID()}`;
const marker = crypto.randomBytes(12).toString("hex");
const startedAt = new Date().toISOString();
const prompt = `Disposable Cortex receipt check. Return exactly this marker and nothing else: ${marker}`;

const execution = spawnSync("pi", [
  "--no-approve",
  "--no-session",
  "--no-tools",
  "--no-context-files",
  "--no-skills",
  "--no-extensions",
  "--print",
  prompt,
], {
  cwd: root,
  encoding: "utf8",
  timeout: 120_000,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const completedAt = new Date().toISOString();
const output = typeof execution.stdout === "string" ? execution.stdout.trim() : "";
const markerMatched = execution.status === 0 && output === marker;
const challengeSha256 = crypto.createHash("sha256").update(marker).digest("hex");
const outputSha256 = output
  ? crypto.createHash("sha256").update(output).digest("hex")
  : null;
const boundaryEvent = mapPiEventToBoundaryEvent({
  kind: "session",
  event: "end",
  ts: completedAt,
  sessionId: invocationId,
  seq: 1,
  correlation: {
    task_id: "T-ARI-001",
    run_id: "R-M-010",
    session_id: "S-M-010",
    operation_id: "OP-M010-PI-001",
  },
  evidenceRefs: [".agent/missions/M-010/evidence/pi-execution-receipt.json"],
});

const receipt = {
  schema_version: "1.0",
  receipt_kind: "pi_process_execution",
  invocation_id: invocationId,
  operation_attempt_id: "OP-M010-PI-001:1",
  authorization_ref: "AUTH-M010-PILOT",
  adapter_id: "pi",
  execution_mode: "no-session-no-tools",
  started_at: startedAt,
  completed_at: completedAt,
  exit_status: execution.status,
  signal: execution.signal || null,
  timed_out: Boolean(execution.error && execution.error.code === "ETIMEDOUT"),
  marker_matched: markerMatched,
  challenge_sha256: challengeSha256,
  output_sha256: outputSha256,
  output_bytes: Buffer.byteLength(output),
  boundary_event: boundaryEvent,
  persistence: {
    prompt_body: false,
    response_body: false,
    stderr_body: false,
    private_session: false,
    exact_usage: "unavailable",
  },
};

fs.mkdirSync(evidenceDir, { recursive: true });
const temporary = `${receiptFile}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, receiptFile);

if (!markerMatched) {
  process.stderr.write("Pi disposable execution did not return the expected marker.\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    invocation_id: invocationId,
    event_id: boundaryEvent.event_id,
    receipt_ref: ".agent/missions/M-010/evidence/pi-execution-receipt.json",
  })}\n`);
}
