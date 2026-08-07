"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const SHARED = path.join(ROOT, "templates", "_shared", ".agent", "dispatch");
const contract = require("../../lib/cli-contract");
const COMMANDS = ["daemon", "trigger"];
const SCHEMAS = ["trigger.schema.json", "daemon-state.schema.json", "idempotency.schema.json"];

function run(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

function snapshot(dir) {
  const result = {};
  const walk = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else result[path.relative(dir, full)] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return result;
}

test("remaining Phase 0 automation commands are discoverable fail-closed stubs", () => {
  for (const name of COMMANDS) {
    const entry = contract.commands.find((item) => item.name === name);
    assert.ok(entry, `${name} must be discoverable`);
    assert.equal(entry.mode, "phase0_stub");
    assert.equal(entry.implemented, false);

    const help = run(ROOT, ["help", name, "--json"]);
    assert.equal(help.status, 0, help.stderr);
    const helpPayload = JSON.parse(help.stdout);
    assert.equal(helpPayload.contract.commands[0].name, name);
    assert.equal(helpPayload.contract.commands[0].implemented, false);

    const execution = run(ROOT, [name, "placeholder", "--json"]);
    assert.equal(execution.status, 2, execution.stderr);
    const payload = JSON.parse(execution.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.phase, 0);
    assert.equal(payload.status, "not_implemented");
    assert.equal(payload.side_effects, false);
    assert.equal(payload.error.code, "PHASE_ZERO_STUB");
  }
});

test("dispatch contract advertises governed manual dispatch rather than a stale Phase 0 stub", () => {
  const entry = contract.commands.find((item) => item.name === "dispatch");
  assert.ok(entry, "dispatch must be discoverable");
  assert.equal(entry.mode, "governed_manual");
  assert.equal(entry.implemented, true);
  assert.equal(entry.automatic_dispatch_enabled, false);
  assert.deepEqual(entry.requires, ["approved_task", "ownership_lease", "idempotency_key", "host", "gate"]);

  const help = run(ROOT, ["help", "dispatch", "--json"]);
  assert.equal(help.status, 0, help.stderr);
  const payload = JSON.parse(help.stdout);
  assert.equal(payload.contract.commands[0].mode, "governed_manual");
  assert.equal(payload.contract.commands[0].implemented, true);
});

test("remaining Phase 0 stubs do not write project runtime state", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-fae-phase0-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, ".agent", "runs"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".agent", "runs", "sentinel.json"), "{}\n");
  const before = snapshot(cwd);

  for (const name of COMMANDS) {
    const result = run(cwd, [name, "placeholder", "--json"]);
    assert.equal(result.status, 2, result.stderr);
  }

  assert.deepEqual(snapshot(cwd), before);
});

test("Phase 0 dispatch schemas are strict shared contracts", () => {
  for (const file of SCHEMAS) {
    const schema = JSON.parse(fs.readFileSync(path.join(SHARED, file), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.schema_version.const, 1);
    assert.ok(schema.required.length > 0);
  }

  const trigger = JSON.parse(fs.readFileSync(path.join(SHARED, "trigger.schema.json"), "utf8"));
  assert.deepEqual(trigger.properties.type.enum, ["manual", "queue_item", "schedule", "file_change", "post_commit"]);
  assert.equal(trigger.allOf[0].then.properties.opt_in.const, true);

  const daemon = JSON.parse(fs.readFileSync(path.join(SHARED, "daemon-state.schema.json"), "utf8"));
  assert.equal(daemon.properties.enabled.default, false);
  assert.ok(daemon.properties.status.enum.includes("disabled"));

  const idempotency = JSON.parse(fs.readFileSync(path.join(SHARED, "idempotency.schema.json"), "utf8"));
  assert.ok(idempotency.properties.status.enum.includes("completed"));
  assert.equal(idempotency.properties.request_digest.pattern, "^[a-f0-9]{64}$");
});

test("localized docs and rules retain explicit manual-dispatch and Phase 0 safety boundaries", () => {
  const files = [
    path.join(ROOT, "templates", "en", ".agent", "dispatch", "README.md"),
    path.join(ROOT, "templates", "zh", ".agent", "dispatch", "README.md"),
    path.join(ROOT, "templates", "en", ".agent", "rules", "ai-behavior.md"),
    path.join(ROOT, "templates", "zh", ".agent", "rules", "ai-behavior.md"),
  ];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const marker of ["Dispatch", "Phase 0", "Management API"]) {
      assert.ok(content.includes(marker), `${path.relative(ROOT, file)} is missing ${marker}`);
    }
  }
  assert.match(fs.readFileSync(files[0], "utf8"), /Governed explicit manual dispatch/);
  assert.match(fs.readFileSync(files[1], "utf8"), /Governed explicit manual dispatch/);
  assert.match(fs.readFileSync(files[0], "utf8"), /automatic dispatch is disabled/);
  assert.match(fs.readFileSync(files[1], "utf8"), /automatic dispatch is disabled/);
});
