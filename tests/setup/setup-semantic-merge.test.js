"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const setup = require("../../lib/setup");

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
  assert.match(once, /## Session Bootstrap/);
  assert.equal(setup.needsSessionBootstrapMerge(ctx, agents), false);
  assert.equal(setup.ensureSessionBootstrapEntry(ctx), false);
  assert.equal(fs.readFileSync(agents, "utf8"), once);
});

test("compatibility adapter bootstrap seeds fresh AGENTS.md with managed block", (t) => {
  const ctx = fixture(t);
  const agents = path.join(ctx.cwd, "AGENTS.md");
  assert.equal(fs.existsSync(agents), false);
  assert.equal(setup.ensureAgentEntryFile(ctx), undefined);

  const initial = fs.readFileSync(agents, "utf8");
  assert.match(initial, /# Cortex Agent Entry/);
  assert.match(initial, /cortex-agent:compatibility-adapter-bootstrap:start/);
  assert.match(initial, /cortex-agent:compatibility-adapter-bootstrap:end/);
  assert.match(initial, /## Compatibility Adapter Bootstrap/);
  assert.match(initial, /source-command-/);
  assert.match(initial, /`.agent\/workflows\/<command>\.md`/);
  assert.match(initial, /report the adapter-vs-truth mismatch and stop/);
});

test("compatibility adapter bootstrap merge preserves user content and is idempotent", (t) => {
  const ctx = fixture(t);
  const agents = path.join(ctx.cwd, "AGENTS.md");
  const userText = "# Existing project rules\n\nKeep this text untouched.\n";
  fs.writeFileSync(agents, userText, "utf8");

  assert.equal(setup.needsCompatibilityAdapterBootstrapMerge(ctx, agents), true);
  assert.equal(setup.ensureCompatibilityAdapterBootstrapEntry(ctx), true);
  const once = fs.readFileSync(agents, "utf8");
  assert.match(once, /# Existing project rules/);
  assert.match(once, /Keep this text untouched\./);
  assert.match(once, /cortex-agent:compatibility-adapter-bootstrap:start/);
  assert.match(once, /cortex-agent:compatibility-adapter-bootstrap:end/);
  assert.match(once, /## Compatibility Adapter Bootstrap/);

  assert.equal(setup.needsCompatibilityAdapterBootstrapMerge(ctx, agents), false);
  assert.equal(setup.ensureCompatibilityAdapterBootstrapEntry(ctx), false);
  assert.equal(fs.readFileSync(agents, "utf8"), once);
});

test("compatibility adapter bootstrap replaces stale managed block without touching outside content", (t) => {
  const ctx = fixture(t);
  const agents = path.join(ctx.cwd, "AGENTS.md");
  const staleBlock = setup.compatibilityAdapterBootstrapSection({ lang: "zh" });
  const initial = [
    "# Existing project rules",
    "",
    "Keep this text untouched.",
    "",
    staleBlock,
    "",
    "## Trailing user section",
    "",
    "Tail text must survive marker replacement.",
    "",
  ].join("\n");
  fs.writeFileSync(agents, initial, "utf8");

  const refreshed = setup.ensureCompatibilityAdapterBootstrapEntry(ctx);
  assert.equal(refreshed, true);
  const after = fs.readFileSync(agents, "utf8");
  assert.match(after, /Keep this text untouched\./);
  assert.match(after, /Trailing user section/);
  assert.match(after, /Tail text must survive marker replacement\./);
  // language switched to en, so zh-specific phrasing must be gone
  assert.doesNotMatch(after, /显式报告\u201c适配器与真源不一致\u201d/);

  // Re-run is a no-op.
  assert.equal(setup.ensureCompatibilityAdapterBootstrapEntry(ctx), false);
  assert.equal(fs.readFileSync(agents, "utf8"), after);
});

test("compatibility adapter bootstrap emits zh and en variants under the same markers", () => {
  const zhCtx = { lang: "zh" };
  const enCtx = { lang: "en" };
  const zhBlock = setup.compatibilityAdapterBootstrapSection(zhCtx);
  const enBlock = setup.compatibilityAdapterBootstrapSection(enCtx);

  assert.match(zhBlock, /cortex-agent:compatibility-adapter-bootstrap:start/);
  assert.match(zhBlock, /cortex-agent:compatibility-adapter-bootstrap:end/);
  assert.match(zhBlock, /source-command-/);
  assert.match(zhBlock, /真源工作流/);
  assert.match(enBlock, /cortex-agent:compatibility-adapter-bootstrap:start/);
  assert.match(enBlock, /cortex-agent:compatibility-adapter-bootstrap:end/);
  assert.match(enBlock, /source-command-/);
  assert.match(enBlock, /truth workflow is missing/);
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
