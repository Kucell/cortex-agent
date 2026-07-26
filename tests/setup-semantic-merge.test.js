"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const setup = require("../lib/setup");

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-setup-merge-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, ".agent", "hooks"), { recursive: true });
  return { cwd, lang: "en", templateDir: path.join(ROOT, "templates", "en") };
}

test("session bootstrap merge is additive and idempotent", (t) => {
  const ctx = fixture(t);
  const agents = path.join(ctx.cwd, "AGENTS.md");
  fs.writeFileSync(agents, "# Existing project rules\n\nKeep this text.\n", "utf8");

  assert.equal(setup.needsSessionBootstrapMerge(ctx, agents), true);
  assert.equal(setup.ensureSessionBootstrapEntry(ctx), true);
  const once = fs.readFileSync(agents, "utf8");
  assert.match(once, /# Existing project rules/);
  assert.match(once, /## Cortex Session Bootstrap/);
  assert.equal(setup.needsSessionBootstrapMerge(ctx, agents), false);
  assert.equal(setup.ensureSessionBootstrapEntry(ctx), false);
  assert.equal(fs.readFileSync(agents, "utf8"), once);
});

test("agent hook merge preserves custom hooks and adds template rules once", (t) => {
  const ctx = fixture(t);
  const target = path.join(ctx.cwd, ".agent", "hooks", "hooks.json");
  const custom = { matcher: "Custom", hooks: [{ type: "command", command: "custom-check" }] };
  fs.writeFileSync(target, `${JSON.stringify({ hooks: { PostToolUse: [custom] } }, null, 2)}\n`, "utf8");

  assert.equal(setup.needsHookMerge(ctx, ".agent/hooks/hooks.json"), true);
  assert.equal(setup.ensureAgentHooks(ctx), true);
  const once = fs.readFileSync(target, "utf8");
  const hooks = JSON.parse(once).hooks;
  assert.deepEqual(hooks.PostToolUse[0], custom);
  assert.ok(hooks.PostToolUse.length > 1);
  assert.ok(Array.isArray(hooks.SessionStart));
  assert.equal(setup.ensureAgentHooks(ctx), false);
  assert.equal(fs.readFileSync(target, "utf8"), once);
});

test("Claude settings hook merge preserves unrelated settings", (t) => {
  const ctx = fixture(t);
  const target = path.join(ctx.cwd, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ permissions: { allow: ["Read"] }, hooks: {} }, null, 2)}\n`, "utf8");

  assert.equal(setup.needsHookMerge(ctx, ".claude/settings.json"), true);
  assert.equal(setup.ensureClaudeSettings(ctx), true);
  const once = fs.readFileSync(target, "utf8");
  const settings = JSON.parse(once);
  assert.deepEqual(settings.permissions, { allow: ["Read"] });
  assert.ok(Array.isArray(settings.hooks.PostToolUse));
  assert.ok(Array.isArray(settings.hooks.SessionStart));
  assert.equal(setup.ensureClaudeSettings(ctx), false);
  assert.equal(fs.readFileSync(target, "utf8"), once);
});
