"use strict";

// Issue #56: an independently versioned <project>/.agent checkout must not
// accidentally become the project root and create <project>/.agent/.agent/.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  resolveRuntimePaths, resolveLayout, resolveWritePath,
} = require("../../lib/runtime-layout");
const { ensureRuntimeRoot: ensureBridgeRoot } = require("../../lib/cross-project/runtime-root");
const { ensureRuntimeRoot: ensureNotificationRoot } = require("../../lib/coordination/notification-host");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-issue56-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = path.join(root, ".agent");
  fs.mkdirSync(path.join(agent, ".git"), { recursive: true });
  return { root, agent };
}

function isWrongRoot(error) {
  return error && error.code === "agent_directory_as_project_root"
    && error.name === "RuntimeLayoutError";
}

test("Issue #56: independent .agent checkout is not a project root", (t) => {
  const { root, agent } = fixture(t);
  const realJournal = path.join(agent, "runtime", "coordination", "journal", "events-000001.jsonl");
  fs.mkdirSync(path.dirname(realJournal), { recursive: true });
  const evidence = "existing journal content must remain untouched\n";
  fs.writeFileSync(realJournal, evidence);

  assert.throws(() => resolveRuntimePaths(agent + path.sep), isWrongRoot);
  assert.throws(() => resolveLayout({ projectRoot: agent, projectId: "sam-hmi" }), isWrongRoot);
  assert.throws(() => resolveWritePath("new", "legacy", agent), isWrongRoot);
  assert.throws(() => ensureBridgeRoot(agent), isWrongRoot);
  assert.throws(() => ensureNotificationRoot(agent), isWrongRoot);

  assert.equal(fs.existsSync(path.join(agent, ".agent")), false);
  assert.equal(fs.existsSync(path.join(agent, ".agent-runtime")), false);
  assert.equal(fs.readFileSync(realJournal, "utf8"), evidence);
  assert.equal(resolveRuntimePaths(root).coordination.new,
    path.join(root, ".agent", "runtime", "coordination"));
});

test("Issue #56: a valid outer project root keeps the new runtime layout", (t) => {
  const { root, agent } = fixture(t);
  const bridge = ensureBridgeRoot(root);
  const coordination = ensureNotificationRoot(root);
  assert.equal(bridge, path.join(agent, "runtime"));
  assert.equal(coordination, path.join(agent, "runtime", "coordination"));
  assert.equal(fs.existsSync(path.join(coordination, "journal")), true);
  assert.equal(fs.existsSync(path.join(agent, ".agent")), false);
});

test("Issue #56: existing legacy data stays authoritative before activation", (t) => {
  const { root, agent } = fixture(t);
  const journal = path.join(root, ".agent-runtime", "coordination", "journal", "events-000001.jsonl");
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  const evidence = "legacy journal content must remain untouched\n";
  fs.writeFileSync(journal, evidence);
  const bridge = ensureBridgeRoot(root);
  const coordination = ensureNotificationRoot(root);
  assert.equal(bridge, path.join(root, ".agent-runtime"));
  assert.equal(coordination, path.join(root, ".agent-runtime", "coordination"));
  assert.equal(fs.readFileSync(journal, "utf8"), evidence);
  assert.equal(fs.existsSync(path.join(agent, ".agent")), false);
  assert.equal(fs.existsSync(path.join(agent, "runtime")), false);
});

test("Issue #56: explicit activation retains the new layout without nesting", (t) => {
  const { root, agent } = fixture(t);
  const marker = path.join(agent, "runtime", "layout.json");
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, "{}\n");
  fs.mkdirSync(path.join(root, ".agent-runtime", "coordination"), { recursive: true });
  assert.equal(ensureBridgeRoot(root), path.join(agent, "runtime"));
  assert.equal(ensureNotificationRoot(root), path.join(agent, "runtime", "coordination"));
  assert.equal(fs.existsSync(path.join(agent, ".agent")), false);
});

test("Issue #56: a different project name is not accidentally blocked", (t) => {
  const { root } = fixture(t);
  const ordinary = path.join(root, "my.agent");
  assert.equal(resolveRuntimePaths(ordinary).coordination.new,
    path.join(ordinary, ".agent", "runtime", "coordination"));
  assert.equal(fs.existsSync(ordinary), false, "path resolution must be read-only");
});
