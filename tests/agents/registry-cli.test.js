"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const { deriveAgentId } = require("../../lib/agents/registry-identity");

const cli = path.resolve(__dirname, "../../bin/cli.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-registry-cli-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); });
  const identity = { provider: "openai", adapter_type: "codex", subject: "native-implementer" };
  const policy = { schema_version: 1, owner_id: "owner", local_user: os.userInfo().username,
    project_id: "example", maintainers: [{ actor_id: "maintainer", session_id: "native-m", projects: ["example"] }],
    grants: [{ identity, role: "implementer", model: "test-model", capabilities: ["code_generation", "test_writing"],
      projects: ["example"], owned_files: ["lib/example.js"] }] };
  const file = path.join(root, ".agent/config/agent-registry.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
  const auth = ["--actor", "maintainer", "--session", "native-m"];
  const registerArgs = ["register", "--identity-json", JSON.stringify(identity), ...auth];
  const id = deriveAgentId(identity);
  return { root, identity, policy, auth, registerArgs, policyFile: file,
    recordFile: path.join(root, ".agent/agents", `${id}.json`), id };
}

function call(root, args) {
  return spawnSync(process.execPath, [cli, "agent", ...args, "--project", root, "--json"],
    { cwd: root, encoding: "utf8", timeout: 10000 });
}

function json(result) {
  assert.equal(result.error, undefined);
  return JSON.parse(result.stdout);
}

test("public register/enable/discover/disable round-trip exact owner-granted profile", (t) => {
  const f = fixture(t);
  const registered = call(f.root, f.registerArgs);
  assert.equal(registered.status, 0, registered.stdout + registered.stderr);
  assert.equal(json(registered).agent.agent_id, f.id);
  assert.equal(json(registered).agent.enabled, false);
  assert.equal(call(f.root, ["enable", f.id, ...f.auth]).status, 0);
  let found = json(call(f.root, ["discover", "--managed-only", "--role", "implementer"]));
  assert.equal(found.returned, 1);
  assert.deepEqual(found.agents[0].identity, f.identity);
  assert.equal(found.agents[0].enabled, true);
  assert.equal(call(f.root, ["disable", f.id, ...f.auth]).status, 0);
  assert.equal(json(call(f.root, ["discover", "--managed-only"])).returned, 0);
  found = json(call(f.root, ["discover", "--managed-only", "--include-disabled"]));
  assert.equal(found.agents[0].enabled, false);
  assert.deepEqual(found.agents[0].registration.events.map((e) => e.action), ["register", "enable", "disable"]);
  for (const dir of ["runtime", "sessions", "runs"]) assert.equal(fs.existsSync(path.join(f.root, ".agent", dir)), false);
});

test("public reconcile plans by default and applies only against both expected snapshots", (t) => {
  const f = fixture(t);
  assert.equal(call(f.root, f.registerArgs).status, 0);
  f.policy.grants[0].role = "reviewer";
  f.policy.grants[0].model = "review-model";
  f.policy.grants[0].capabilities = ["code_review"];
  f.policy.grants[0].owned_files = ["lib/example.js", "tests/example.test.js"];
  fs.writeFileSync(f.policyFile, JSON.stringify(f.policy), { mode: 0o600 });

  const planned = json(call(f.root, ["reconcile", f.id, ...f.auth]));
  assert.equal(planned.command, "agent.reconcile.plan");
  assert.equal(planned.plan.agent_id, f.id);
  assert.equal(planned.plan.changed, true);
  assert.equal(planned.plan.enabled, false);
  const applied = call(f.root, ["reconcile", f.id, "--apply",
    "--expected-entry-sha256", planned.plan.entry_sha256,
    "--expected-policy-sha256", planned.plan.policy_sha256, ...f.auth]);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const updated = json(applied).agent;
  assert.equal(updated.agent_id, f.id);
  assert.equal(updated.enabled, false);
  assert.equal(updated.role, "reviewer");
  assert.deepEqual(updated.capabilities, ["code_review"]);
  assert.deepEqual(updated.registration.events.map((event) => event.action), ["register", "reconcile"]);
  assert.equal(call(f.root, ["enable", f.id, ...f.auth]).status, 0);
});

test("public reconcile requires maintainer authority, exact hashes, and explicit disable", (t) => {
  const f = fixture(t);
  assert.equal(call(f.root, f.registerArgs).status, 0);
  f.policy.grants[0].model = "changed-model";
  fs.writeFileSync(f.policyFile, JSON.stringify(f.policy), { mode: 0o600 });
  const plan = json(call(f.root, ["reconcile", f.id, ...f.auth])).plan;

  const unauthorized = call(f.root, ["reconcile", f.id, "--actor", "forged",
    "--session", "native-m"]);
  assert.notEqual(unauthorized.status, 0);
  assert.equal(json(unauthorized).error.code, "ERR_REGISTRY_UNAUTHORIZED");
  const missingHash = call(f.root, ["reconcile", f.id, "--apply", ...f.auth]);
  assert.notEqual(missingHash.status, 0);
  assert.equal(json(missingHash).error.code, "INVALID_USAGE");

  f.policy.grants[0].model = "newer-model";
  fs.writeFileSync(f.policyFile, JSON.stringify(f.policy), { mode: 0o600 });
  const stale = call(f.root, ["reconcile", f.id, "--apply",
    "--expected-entry-sha256", plan.entry_sha256,
    "--expected-policy-sha256", plan.policy_sha256, ...f.auth]);
  assert.notEqual(stale.status, 0);
  assert.equal(json(stale).error.code, "ERR_REGISTRY_STALE");

  f.policy.grants[0].model = "test-model";
  fs.writeFileSync(f.policyFile, JSON.stringify(f.policy), { mode: 0o600 });
  assert.equal(call(f.root, ["enable", f.id, ...f.auth]).status, 0);
  f.policy.grants[0].model = "newer-enabled-profile";
  fs.writeFileSync(f.policyFile, JSON.stringify(f.policy), { mode: 0o600 });
  const enabledPlan = json(call(f.root, ["reconcile", f.id, ...f.auth])).plan;
  const enabledApply = call(f.root, ["reconcile", f.id, "--apply",
    "--expected-entry-sha256", enabledPlan.entry_sha256,
    "--expected-policy-sha256", enabledPlan.policy_sha256, ...f.auth]);
  assert.notEqual(enabledApply.status, 0);
  assert.equal(json(enabledApply).error.code, "ERR_REGISTRY_ENABLED");
  assert.match(call(f.root, ["reconcile", "--help"]).stdout, /expected-policy-sha256/);
});

test("concurrent reconcile applies have one winner and one stale-snapshot failure", async (t) => {
  const f = fixture(t);
  assert.equal(call(f.root, f.registerArgs).status, 0);
  f.policy.grants[0].owned_files = ["lib/example.js", "tests/example.test.js"];
  fs.writeFileSync(f.policyFile, JSON.stringify(f.policy), { mode: 0o600 });
  const plan = json(call(f.root, ["reconcile", f.id, ...f.auth])).plan;
  const run = () => new Promise((resolve, reject) => {
    const args = [cli, "agent", "reconcile", f.id, "--apply",
      "--expected-entry-sha256", plan.entry_sha256,
      "--expected-policy-sha256", plan.policy_sha256,
      ...f.auth, "--project", f.root, "--json"];
    const child = spawn(process.execPath, args, { cwd: f.root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (part) => { out += part; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, payload: JSON.parse(out) }));
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(results.filter((result) => result.status === 0).length, 1);
  const loser = results.find((result) => result.status !== 0);
  assert.ok(["ERR_REGISTRY_BUSY", "ERR_REGISTRY_STALE"].includes(loser.payload.error.code));
  const saved = JSON.parse(fs.readFileSync(f.recordFile, "utf8"));
  assert.equal(saved.profile_revision, 2);
  assert.deepEqual(saved.registration.events.map((event) => event.action), ["register", "reconcile"]);
  assert.deepEqual(fs.readdirSync(path.dirname(f.recordFile)), [`${f.id}.json`]);
});

test("public write grammar rejects role injection, unknown flags, malformed identities and paths", (t) => {
  const f = fixture(t);
  for (const args of [[...f.registerArgs, "--role", "reviewer"],
    [...f.registerArgs, "--capability", "code_review"], [...f.registerArgs, "--actor", "again"],
    ["register", "--identity-json", "{bad", ...f.auth], ["enable", "../sample", ...f.auth],
    ["disable", f.id], ["register", "--identity-json"]]) {
    const r = call(f.root, args);
    assert.notEqual(r.status, 0, r.stdout);
    assert.equal(json(r).ok, false);
  }
  assert.equal(fs.existsSync(path.join(f.root, ".agent/agents")), false);
  const help = call(f.root, ["register", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Reconcile plans by default/);
});

test("projects set cannot modify an enabled managed grant", (t) => {
  const f = fixture(t);
  assert.equal(call(f.root, f.registerArgs).status, 0);
  assert.equal(call(f.root, ["enable", f.id, ...f.auth]).status, 0);
  const file = path.join(f.root, ".agent/agents", `${f.id}.json`);
  const before = fs.readFileSync(file, "utf8");
  const r = call(f.root, ["projects", "set", f.id, "ungranted", "--add"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /owner policy/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("disabled managed identities fail through all public selection routes before host launch", (t) => {
  const f = fixture(t);
  assert.equal(call(f.root, f.registerArgs).status, 0);
  const tasks = path.join(f.root, "tasks.json");
  fs.writeFileSync(tasks, JSON.stringify([{ agent_id: f.id, task: "must not start a host" }]));
  for (const args of [["invoke", f.id, "must not start a host"],
    ["dispatch-execute", f.id, "must not start a host"], ["dispatch-batch", "--tasks", tasks]]) {
    const r = call(f.root, args);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stdout + r.stderr, /ERR_AGENT_DISABLED/);
  }
  assert.equal(fs.existsSync(path.join(f.root, ".agent/runtime/coordination")), false);
});

test("concurrent public registrations have one winner and never replace its audit", async (t) => {
  const f = fixture(t);
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "agent", ...f.registerArgs, "--project", f.root, "--json"],
      { cwd: f.root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (part) => { out += part; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, payload: JSON.parse(out) }));
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(results.filter((r) => r.status === 0).length, 1);
  const loser = results.find((r) => r.status !== 0);
  assert.ok(["ERR_REGISTRY_BUSY", "ERR_REGISTRY_DUPLICATE"].includes(loser.payload.error.code));
  const files = fs.readdirSync(path.join(f.root, ".agent/agents"));
  assert.deepEqual(files, [`${f.id}.json`]);
  const record = JSON.parse(fs.readFileSync(path.join(f.root, ".agent/agents", files[0])));
  assert.equal(record.registration.events.length, 1);
});

test("task create help describes both real writer interfaces and does not write state", (t) => {
  const f = fixture(t);
  const r = spawnSync(process.execPath, [cli, "task", "create", "--help"], { cwd: f.root, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--task <id>/);
  assert.match(r.stdout, /--actor <coordinator-id>/);
  assert.match(r.stdout, /--session <session-id>/);
  assert.match(r.stdout, /Legacy event-envelope compatibility/);
  assert.match(r.stdout, /--event-json/);
  assert.doesNotMatch(r.stdout, /"kind": "coordinator\|agent\|system"/);
  assert.equal(fs.existsSync(path.join(f.root, ".agent/runtime")), false);
});
