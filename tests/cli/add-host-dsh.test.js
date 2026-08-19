"use strict";

// ─── DSH host `cortex-agent add dsh` CLI test (M-029 / P-006 / MS-004) ─────────
//
// Coverage (VC-029-004-01 / VC-029-004-02):
//   - `cortex-agent add dsh` via real addPlatforms() + installPlatform() path:
//     .dsh/settings.json (merge), .dsh/README.md, .dsh/AGENTS.md written;
//     .dsh/skills + .dsh/workflows symlinks created; .agent/.platforms state
//     includes "dsh"; success output emitted.
//   - PLATFORM_REGISTRY contains the dsh entry with zh + en descriptions.
//   - Double `add dsh` keeps user settings (merge preserves existing fields).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { addPlatforms } = require("../../lib/commands/platform");
const { PLATFORM_REGISTRY } = require("../../lib/registry");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dsh-add-"));
}

function captureStdout() {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stdout.write = orig; return chunks.join(""); } };
}

function captureStderr() {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stderr.write = orig; return chunks.join(""); } };
}

// Build a minimal templateDir with the dsh integration files (zh template used
// by default when lang=zh; installPlatform resolves `integrations/<src>`).
function buildTemplateDir(root, lang) {
  const templateDir = path.join(root, "templates", lang);
  const dshDir = path.join(templateDir, "integrations", "dsh");
  fs.mkdirSync(dshDir, { recursive: true });
  fs.writeFileSync(
    path.join(dshDir, "settings.json"),
    JSON.stringify({ skills: [".agent/skills"], prompts: [".agent/workflows"], packages: [] }, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(path.join(dshDir, "README.md"), "# DSH README fixture\n", "utf8");
  fs.writeFileSync(path.join(dshDir, "AGENTS.md"), "# DSH AGENTS fixture\n", "utf8");
  return templateDir;
}

test("platform registry: PLATFORM_REGISTRY contains the dsh entry (zh + en)", () => {
  const p = PLATFORM_REGISTRY.dsh;
  assert.ok(p, "PLATFORM_REGISTRY.dsh must exist");
  assert.equal(p.name, "DSH (DeepSeek Harness)");
  assert.ok(typeof p.desc.zh === "string" && p.desc.zh.length > 0);
  assert.ok(typeof p.desc.en === "string" && p.desc.en.length > 0);
  // Files to install
  assert.deepEqual(
    p.files.map((f) => f.src),
    ["dsh/settings.json", "dsh/README.md", "dsh/AGENTS.md"],
  );
  assert.ok(p.files[0].merge === true, "settings.json must merge");
  // Symlinks
  assert.deepEqual(
    p.links.map((l) => l.link),
    [".dsh/skills", ".dsh/workflows"],
  );
  assert.ok(p.cleanupPaths.includes(".dsh"));
});

test("add dsh: happy path writes files + symlinks + platforms state (zh)", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const templateDir = buildTemplateDir(root, "zh");
  const ctx = {
    cwd: root,
    lang: "zh",
    args: ["add", "dsh"],
    options: {},
    templateDir,
  };
  const outCap = captureStdout();
  const errCap = captureStderr();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    addPlatforms(ctx);
  } finally {
    const out = outCap.restore();
    errCap.restore();
    process.exitCode = origExitCode;

    // 1. Files written.
    assert.equal(fs.existsSync(path.join(root, ".dsh", "settings.json")), true);
    assert.equal(fs.existsSync(path.join(root, ".dsh", "README.md")), true);
    assert.equal(fs.existsSync(path.join(root, ".dsh", "AGENTS.md")), true);
    // 2. Symlinks created (relative targets).
    const skillsLink = path.join(root, ".dsh", "skills");
    assert.equal(fs.lstatSync(skillsLink).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(skillsLink), path.join("..", ".agent", "skills"));
    const workflowsLink = path.join(root, ".dsh", "workflows");
    assert.equal(fs.lstatSync(workflowsLink).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(workflowsLink), path.join("..", ".agent", "workflows"));
    // 3. Platforms state includes dsh.
    const stateRaw = fs.readFileSync(path.join(root, ".agent", ".platforms"), "utf8");
    assert.match(stateRaw, /dsh/);
    // 4. Success output.
    assert.match(out, /DSH/);
    assert.match(out, /完成|successfully|成功/i);
  }
});

test("add dsh: settings.json merge preserves user fields on second add", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const templateDir = buildTemplateDir(root, "en");
  const ctx = {
    cwd: root,
    lang: "en",
    args: ["add", "dsh"],
    options: {},
    templateDir,
  };
  const outCap = captureStdout();
  const errCap = captureStderr();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    // First add.
    addPlatforms(ctx);
    // Simulate a user having added their own field, then re-add.
    const settingsPath = path.join(root, ".dsh", "settings.json");
    const userSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    userSettings.packages = ["@user/custom"];
    fs.writeFileSync(settingsPath, JSON.stringify(userSettings, null, 2) + "\n", "utf8");
    addPlatforms(ctx);
    // Second add merges template arrays but keeps the user's packages.
    const merged = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.ok(Array.isArray(merged.skills));
    assert.ok(Array.isArray(merged.prompts));
    assert.deepEqual(merged.packages, ["@user/custom"]);
  } finally {
    outCap.restore();
    errCap.restore();
    process.exitCode = origExitCode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("add dsh: idempotent re-add skips existing files without overwriting user edits", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const templateDir = buildTemplateDir(root, "en");
  const ctx = {
    cwd: root,
    lang: "en",
    args: ["add", "dsh"],
    options: {},
    templateDir,
  };
  const outCap = captureStdout();
  const errCap = captureStderr();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    addPlatforms(ctx);
    // User edits README after first add.
    const readmePath = path.join(root, ".dsh", "README.md");
    fs.writeFileSync(readmePath, "# USER EDITED\n", "utf8");
    addPlatforms(ctx);
    const content = fs.readFileSync(readmePath, "utf8");
    assert.match(content, /USER EDITED/);
  } finally {
    outCap.restore();
    errCap.restore();
    process.exitCode = origExitCode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
