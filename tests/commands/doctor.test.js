"use strict";

// ─── lib/commands/doctor.js unit tests ─────────────────────────────────────────
//
// Coverage:
//   - doctor: in a non-git temp dir with no .agent/, runs to completion
//     without throwing (with graphify-prompt answered "n" → skip install).
//   - doctor: in a temp dir WITH .agent/ + AGENTS.md + GEMINI.md, prints
//     the [version] section without crashing.
//   - doctor: pass options.fix=true and a non-existent templateDir still
//     fails-fast at the scriptManifest.reconcileScripts attempt (graceful
//     no-op via try/catch).
//
// Deeper coverage (Team Pack verify failure, minimax-cli adapter block,
// graphify auto-install path) lives in tests/doctor.test.js (end-to-end
// over `node bin/cli.js doctor`). The unit tests here pin the contract
// that doctor() never throws on a clean tmpdir, and that it threads the
// key options through to its helpers.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { doctor } = require("../../lib/commands/doctor");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-doctor-test-"));
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

test("doctor: empty non-git project runs to completion without throwing", async () => {
  const root = mkRoot();
  // Provide a templateDir so the .agent/ + scriptManifest calls inside
  // doctor have a sane cwd but no managed scripts.  doctor() does not
  // require templateDir to exist (scriptManifest.reconcileScripts catches
  // its own errors), but we still need a placeholder to keep
  // `scriptManifest.discoverTemplateScriptEntries(templateDir, ...)` from
  // walking into a real path.  Pointing at a missing dir is fine.
  const ctx = {
    cwd: root,
    lang: "en",
    templateDir: path.join(root, "no-such-template"),
    options: {},
  };
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  try {
    await doctor(ctx);
  } finally {
    restoreOut();
    restoreErr();
  }
  // No assertion needed: reaching this line means doctor() returned without
  // throwing.  The output buffer is intentionally discarded — this test
  // only pins the "no-throw" contract.
});

test("doctor: project with .agent/ + AGENTS.md + GEMINI.md prints version block", async () => {
  const root = mkRoot();
  // Lay down the three core paths doctor() checks.
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# test\n");
  fs.writeFileSync(path.join(root, "GEMINI.md"), "# test\n");

  const ctx = {
    cwd: root,
    lang: "en",
    templateDir: path.join(root, "no-such-template"),
    options: {},
  };
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  let out = "";
  try {
    await doctor(ctx);
  } finally {
    out = restoreOut();
    restoreErr();
  }
  // The [version] block is always printed and is unique to doctor().
  assert.match(out, /\[version\]/, "output must include [version] section header");
  assert.match(out, /CLI version/, "output must include 'CLI version' line");
  // The three core paths are reported on, regardless of git status.
  assert.match(out, /\[\.agent\]/);
  assert.match(out, /\[AGENTS\.md\]/);
  assert.match(out, /\[GEMINI\.md\]/);
});

test("doctor: project with .agent/ + AGENTS.md + GEMINI.md + zh language → Chinese strings", async () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# test\n");

  const ctx = {
    cwd: root,
    lang: "zh",
    templateDir: path.join(root, "no-such-template"),
    options: {},
  };
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  let out = "";
  try {
    await doctor(ctx);
  } finally {
    out = restoreOut();
    restoreErr();
  }
  assert.match(out, /🩺 正在执行/, "output must use Chinese header");
  assert.match(out, /\[版本\]/, "output must include [版本] section header");
  assert.match(out, /CLI 版本/, "output must include 'CLI 版本' line");
});

test("doctor: --fix option is accepted (does not throw on empty project)", async () => {
  const root = mkRoot();
  // Without .agent/ the script-drift section is a no-op (scriptManifest
  // reconcileScripts catches its own error) and the Team Pack section
  // falls into the "manifest invalid or missing" branch.  --fix is a
  // no-op in this state but must not throw.
  const ctx = {
    cwd: root,
    lang: "en",
    templateDir: path.join(root, "no-such-template"),
    options: { fix: true },
  };
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  try {
    await doctor(ctx);
  } finally {
    restoreOut();
    restoreErr();
  }
});

test("doctor: setup-portability section is always printed (even with no .agent/global)", async () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  // No .agent/global symlink → "missing" branch.
  const ctx = {
    cwd: root,
    lang: "en",
    templateDir: path.join(root, "no-such-template"),
    options: {},
  };
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  let out = "";
  try {
    await doctor(ctx);
  } finally {
    out = restoreOut();
    restoreErr();
  }
  assert.match(out, /\[setup-portability\]/);
  // "missing" status appears when no .agent/global link is present.
  assert.match(out, /\.agent\/global:\s*missing/);
  // The remedy line is printed for the missing branch.
  assert.match(out, /remedy/);
});

// T-ISSUE-3 follow-up: setup-portability now also covers the four additional
// symlinks linkGlobalConfig manages: .agent/global-shared-skills,
// .cursor/global-rules, .cursor/global-commands, .claude/global-commands.
test("doctor: setup-portability covers all 5 linkGlobalConfig-managed symlinks", async () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const ctx = {
    cwd: root,
    lang: "en",
    templateDir: path.join(root, "no-such-template"),
    options: {},
  };
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  let out = "";
  try {
    await doctor(ctx);
  } finally {
    out = restoreOut();
    restoreErr();
  }
  for (const rel of [
    ".agent/global",
    ".agent/global-shared-skills",
    ".cursor/global-rules",
    ".cursor/global-commands",
    ".claude/global-commands",
  ]) {
    const re = new RegExp(`${rel.replace(/\./g, "\\.")}:\\s*missing`);
    assert.match(out, re, `${rel} must be reported as missing`);
  }
});

// T-ISSUE-3 follow-up: when a setup-portability symlink is ok, doctor prints
// the path and does not flag a remedy.
test("doctor: setup-portability prints path detail for an ok symlink", async () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  // Pre-create a valid relative symlink: .agent/global → a sibling fake
  // ~/.agent under project. We need a fake HOME so realpathSync() matches.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-doc-home-"));
  fs.mkdirSync(path.join(fakeHome, ".agent", "rules"), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, ".agent", "workflows"), { recursive: true });
  const realHomeAgent = fs.realpathSync(path.join(fakeHome, ".agent"));
  const realAgentDir = fs.realpathSync(path.join(root, ".agent"));
  const rel = path.relative(realAgentDir, realHomeAgent);
  fs.symlinkSync(rel, path.join(realAgentDir, "global"));

  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const ctx = {
    cwd: root,
    lang: "en",
    templateDir: path.join(root, "no-such-template"),
    options: {},
  };
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  let out = "";
  try {
    await doctor(ctx);
  } finally {
    out = restoreOut();
    restoreErr();
    process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
  // ok status is reported and a path detail is printed (no remedy line for ok).
  assert.match(out, /\.agent\/global:\s*ok/);
  assert.match(out, /path:\s+\S+\/global/);
});
