"use strict";

/**
 * Dashboard Supervisor — bilingual distribution + cross-project parity.
 *
 * Contract:
 *  - The supervisor skill is shipped to both shared template and both
 *    zh / en templates (bilingual parity)
 *  - Shared, zh, and en templates keep the same schema for
 *    dashboard-automation.json and supervisor-state
 *  - A fresh init produces a default-disabled config in both languages
 *  - The supervisor's bilingual templates keep parity with the inner
 *    .agent workspace (locked-down source code matches)
 *  - The supervisor skill is L3-only: cortex-agent inner workspace has
 *    it, but downstream projects do not need it for the basic
 *    activity-recording baseline to work
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SHARED = path.join(ROOT, "templates", "_shared", ".agent");
const EN_TPL = path.join(ROOT, "templates", "en", ".agent");
const ZH_TPL = path.join(ROOT, "templates", "zh", ".agent");
const INNER = path.join(ROOT, ".agent");

function readText(rel) {
  return fs.readFileSync(path.join(SHARED, rel), "utf8");
}

function checkBilingualParity() {
  const files = [
    "config/dashboard-automation.json",
    "skills/dashboard-supervisor/schemas/dashboard-automation.schema.json",
    "skills/dashboard-supervisor/schemas/supervisor-state.schema.json",
    "skills/dashboard-supervisor/scripts/contracts.js",
    "skills/dashboard-supervisor/scripts/root-resolution.js",
    "skills/dashboard-supervisor/scripts/workload-classifier.js",
    "skills/dashboard-supervisor/scripts/supervisor.js",
    "skills/dashboard-supervisor/SKILL.md",
  ];
  for (const rel of files) {
    assert.ok(fs.existsSync(path.join(EN_TPL, rel)), `en missing: ${rel}`);
    assert.ok(fs.existsSync(path.join(ZH_TPL, rel)), `zh missing: ${rel}`);
    const sharedContent = readText(rel);
    assert.strictEqual(
      fs.readFileSync(path.join(EN_TPL, rel), "utf8"),
      sharedContent,
      `en/${rel} out of sync with shared`,
    );
    assert.strictEqual(
      fs.readFileSync(path.join(ZH_TPL, rel), "utf8"),
      sharedContent,
      `zh/${rel} out of sync with shared`,
    );
  }
}

test("M-005: bilingual supervisor templates match the shared template byte-for-byte", () => {
  checkBilingualParity();
});

test("M-005: dashboard-automation.json defaults to enabled=false in shared template", () => {
  const config = JSON.parse(readText("config/dashboard-automation.json"));
  assert.strictEqual(config.enabled, false,
    "shared template must ship dashboard-supervisor in the default-disabled state");
  assert.ok(Array.isArray(config.start_on));
  assert.ok(Array.isArray(config.exclude_roles));
  assert.ok(config.exclude_roles.includes("dashboard-manager"));
  assert.ok(config.exclude_roles.includes("runtime-continuity"));
});

test("M-005: init creates the supervisor config in both languages", () => {
  for (const language of ["en", "zh"]) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `cortex-dash-${language}-`));
    try {
      // Plant a code-mode marker so M-001 MS-003 auto-infer routes to
      // the code init path (which copies templates/_shared/.agent/config
      // and hence the supervisor config).
      fs.writeFileSync(path.join(cwd, "package.json"), "{}");
      execFileSync(process.execPath, [path.join(ROOT, "bin", "cli.js"), "init", "--lang", language, "--platforms", "codex"], {
        cwd,
        stdio: "ignore",
      });
      const configPath = path.join(cwd, ".agent", "config", "dashboard-automation.json");
      assert.ok(fs.existsSync(configPath), `${language} init missing dashboard-automation.json`);
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      assert.strictEqual(config.enabled, false, `${language} must ship supervisor disabled`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("M-005: supervisor skill source stays in lockstep between inner .agent and templates", () => {
  // The supervisor entry script must be byte-identical across
  // inner .agent, shared template, and zh / en templates. This is
  // the cross-project parity guarantee: any tool that updates one
  // location must update all of them.
  const inner = fs.readFileSync(path.join(INNER, "skills/dashboard-supervisor/scripts/supervisor.js"), "utf8");
  const shared = readText("skills/dashboard-supervisor/scripts/supervisor.js");
  const en = fs.readFileSync(path.join(EN_TPL, "skills/dashboard-supervisor/scripts/supervisor.js"), "utf8");
  const zh = fs.readFileSync(path.join(ZH_TPL, "skills/dashboard-supervisor/scripts/supervisor.js"), "utf8");
  assert.strictEqual(shared, inner, "shared template drifted from inner .agent");
  assert.strictEqual(en, inner, "en template drifted from inner .agent");
  assert.strictEqual(zh, inner, "zh template drifted from inner .agent");
});

test("standard CLI core and opt-in workflow adapters ship together", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "lib", "dashboard-supervisor.js")));
  for (const template of [INNER, EN_TPL, ZH_TPL]) {
    const hooks = fs.readFileSync(path.join(template, "hooks", "hooks.json"), "utf8");
    assert.match(hooks, /cortex-agent dashboard ensure/);
    for (const workflow of ["start-task.md", "mission.md", "worktree.md"]) {
      const content = fs.readFileSync(path.join(template, "workflows", workflow), "utf8");
      assert.match(content, /cortex-agent dashboard ensure/, `${template}/${workflow} missing Dashboard adapter`);
    }
  }
});

test("M-005: cortex-agent init preserves the default-disabled supervisor for downstream projects", () => {
  // A downstream project that installs cortex-agent must receive the
  // supervisor in its default-disabled state. VC-013 contract: init
  // creates a default profile, update / upgrade must add missing
  // files without overwriting local policy.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dash-downstream-"));
  try {
    // Plant a code-mode marker so M-001 MS-003 auto-infer routes to
    // the code init path (which carries the supervisor baseline).
    fs.writeFileSync(path.join(cwd, "package.json"), "{}");
    execFileSync(process.execPath, [path.join(ROOT, "bin", "cli.js"), "init", "--lang", "en", "--platforms", "codex"], {
      cwd,
      stdio: "ignore",
    });
    const config = JSON.parse(fs.readFileSync(path.join(cwd, ".agent/config/dashboard-automation.json"), "utf8"));
    assert.strictEqual(config.enabled, false);
    assert.ok(config.exclude_roles.includes("dashboard-manager"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
