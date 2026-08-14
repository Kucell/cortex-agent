"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const { buildManagedScriptsMap } = require("../helpers/managed-scripts");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeManagedScriptsManifest(cwd) {
  // Pre-register every managed template script so reconcileScripts never
  // reports `unmanaged_cold_start` for a script that the legacy fixture did
  // not copy into the project. Without this, the only shared+en duplicate
  // (`skills/vcs-pr/scripts/backends/gitlab.js`) would land in
  // `protectedLocal` and flip the update exit code to 2 with "Safe update
  // partially complete", which is not the legacy happy-path outcome.
  const scripts = buildManagedScriptsMap(ROOT);
  writeJson(path.join(cwd, ".agent", ".script-manifest.json"), {
    schema_version: 1,
    scripts,
  });
}

function createLegacyProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-update-semantic-"));
  fs.mkdirSync(path.join(cwd, ".agent"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), [
    "# Cortex Agent Entry",
    "",
    "This project uses `.agent/` as the single source of truth.",
    "",
    "## Session Bootstrap",
    "",
    "If the hook does not fire, run manually:",
    "",
    "```bash",
    "node .agent/skills/runtime-continuity/scripts/index.js warm --auto --project legacy",
    "node .agent/skills/runtime-continuity/scripts/index.js status --project legacy",
    "```",
    "",
    "## Load These Next",
    "",
    "1. `.agent/rules/core-principles.md`",
    "",
  ].join("\n"), "utf8");
  writeJson(path.join(cwd, ".agent", "hooks", "hooks.json"), {
    hooks: {
      SessionStart: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: "PROJ=$(node -e \"console.log(require('path').basename(process.cwd()))\"); node .agent/skills/runtime-continuity/scripts/index.js warm --auto --project \"$PROJ\" 2>/dev/null; exit 0",
              async: true,
              timeout: 5,
            },
          ],
          description: "old runtime hook",
        },
      ],
    },
  });
  writeJson(path.join(cwd, ".claude", "settings.json"), {
    hooks: {
      SessionStart: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: "node -e \"console.log('memory')\"",
            },
          ],
          description: "custom memory hook",
        },
      ],
    },
  });
  writeManagedScriptsManifest(cwd);
  return cwd;
}

function createRegistryProject() {
  const cwd = createLegacyProject();
  const scripts = path.join(cwd, ".agent", "skills", "management-api", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  writeJson(path.join(scripts, "projection-registry.json"), {
    schema_version: 1,
    projections: [
      {
        name: "runs",
        kind: "collection",
        exact_lookup: false,
        data_field: "runs",
        filters: [],
      },
      {
        name: "local-custom",
        kind: "collection",
        exact_lookup: false,
        data_field: "custom",
        filters: ["owner"],
      },
    ],
  });
  return cwd;
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8" },
  });
}

test("update dry-run report includes entry and hook semantic merge candidates", (t) => {
  const cwd = createLegacyProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = runCli(cwd, ["update", "--lang", "en", "--dry-run", "--report", "json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const merged = payload.changes.merged.map((item) => `${item.path}:${item.reason}`);
  assert.ok(merged.includes("AGENTS.md:entry_runtime_bootstrap_stale"));
  assert.ok(merged.includes("AGENTS.md:entry_compatibility_adapter_bootstrap_stale"));
  assert.ok(merged.includes(".agent/hooks/hooks.json:hook_runtime_continuity_stale"));
  assert.ok(merged.includes(".claude/settings.json:hook_runtime_continuity_stale"));
});

test("update semantically upgrades AGENTS and runtime-continuity hooks", (t) => {
  const cwd = createLegacyProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = runCli(cwd, ["update", "--lang", "en"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);

  const agents = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
  assert.match(agents, /cortex-agent:session-bootstrap:start/);
  assert.match(agents, /CORTEX_SESSION_START=1/);
  assert.match(agents, /do not manually fake automatic mode/);
  assert.doesNotMatch(agents, /If the hook does not fire, run manually/);
  assert.match(agents, /cortex-agent:compatibility-adapter-bootstrap:start/);
  assert.match(agents, /cortex-agent:compatibility-adapter-bootstrap:end/);
  assert.match(agents, /## Compatibility Adapter Bootstrap/);
  assert.match(agents, /source-command-/);
  assert.match(agents, /`.agent\/workflows\/<command>\.md`/);
  assert.match(agents, /report the adapter-vs-truth mismatch and stop/);

  const agentHooks = JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "hooks", "hooks.json"), "utf8"));
  const agentRuntimeRules = agentHooks.hooks.SessionStart.filter((rule) => JSON.stringify(rule).includes("runtime-continuity"));
  assert.equal(agentRuntimeRules.length, 1);
  assert.match(JSON.stringify(agentRuntimeRules[0]), /CORTEX_SESSION_START=1/);

  const claude = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
  assert.ok(JSON.stringify(claude).includes("custom memory hook"));
  const claudeRuntimeRules = claude.hooks.SessionStart.filter((rule) => JSON.stringify(rule).includes("runtime-continuity"));
  assert.equal(claudeRuntimeRules.length, 1);
  assert.match(JSON.stringify(claudeRuntimeRules[0]), /CORTEX_SESSION_START=1/);

  const updateReport = JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "updates", "latest.json"), "utf8"));
  assert.equal(updateReport.command, "update");
  assert.equal(updateReport.mode, "apply");
  assert.equal(updateReport.status, "passed");
  assert.equal(updateReport.summary.verification_failed, 0);

  const dashboard = runCli(cwd, ["query", "dashboard-state"]);
  assert.equal(dashboard.status, 0, dashboard.stderr);
  const state = JSON.parse(dashboard.stdout);
  assert.equal(state.data.latest_update.update_id, updateReport.update_id);
  assert.equal(state.data.latest_update.status, "passed");
  assert.equal(state.summary.latest_update_status, "passed");
});

test("update inserts compatibility adapter bootstrap into legacy AGENTS.md and stays idempotent", (t) => {
  const cwd = createLegacyProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const before = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
  assert.doesNotMatch(before, /cortex-agent:compatibility-adapter-bootstrap:start/);

  const first = runCli(cwd, ["update", "--lang", "en"]);
  assert.equal(first.status, 0, `stderr: ${first.stderr}\nstdout: ${first.stdout}`);

  const agentsPath = path.join(cwd, "AGENTS.md");
  const once = fs.readFileSync(agentsPath, "utf8");
  assert.match(once, /cortex-agent:compatibility-adapter-bootstrap:start/);
  assert.match(once, /cortex-agent:compatibility-adapter-bootstrap:end/);
  assert.match(once, /`.agent\/workflows\/<command>\.md`/);
  // Pre-existing user content outside the managed block must survive.
  assert.match(once, /## Load These Next/);
  assert.match(once, /`.agent\/rules\/core-principles\.md`/);

  // Second run must not introduce any additional diff.
  const second = runCli(cwd, ["update", "--lang", "en"]);
  assert.equal(second.status, 0, `stderr: ${second.stderr}\nstdout: ${second.stdout}`);
  assert.equal(fs.readFileSync(agentsPath, "utf8"), once);
});

test("update merges projection registry by name while preserving local projections", (t) => {
  const cwd = createRegistryProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const dry = runCli(cwd, ["update", "--lang", "en", "--dry-run", "--report", "json"]);
  assert.equal(dry.status, 0, dry.stderr);
  const payload = JSON.parse(dry.stdout);
  assert.ok(payload.changes.merged.some((item) =>
    item.path === ".agent/skills/management-api/scripts/projection-registry.json" &&
    item.reason === "projection_registry_stale"));

  const result = runCli(cwd, ["update", "--lang", "en"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  const registry = JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "skills", "management-api", "scripts", "projection-registry.json"), "utf8"));
  const names = registry.projections.map((entry) => entry.name);
  assert.ok(names.includes("runs"));
  assert.ok(names.includes("activity"));
  assert.ok(names.includes("dashboard-state"));
  assert.ok(names.includes("local-custom"));
  assert.equal(registry.projections.filter((entry) => entry.name === "runs").length, 1);
});

test("projection merge does not advertise token-attempts before the handler is installed", (t) => {
  const cwd = createRegistryProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const scripts = path.join(cwd, ".agent", "skills", "management-api", "scripts");
  fs.writeFileSync(path.join(scripts, "index.js"), [
    '"use strict";',
    'const QUERY_HANDLERS = Object.freeze({ runs: () => ({ ok: true }) });',
    'module.exports = { QUERY_HANDLERS };',
    "",
  ].join("\n"), "utf8");

  const { ensureProjectionRegistry } = require("../../lib/setup");
  ensureProjectionRegistry({ cwd, lang: "en" });
  const registry = JSON.parse(fs.readFileSync(path.join(scripts, "projection-registry.json"), "utf8"));
  assert.equal(registry.projections.some((entry) => entry.name === "token-attempts"), false);
  assert.doesNotMatch(fs.readFileSync(path.join(scripts, "index.js"), "utf8"), /tokenAttemptsProjection/);
});
