"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  designCommand,
  detectKind,
  KIND_ALIASES,
} = require("../../lib/commands/design");

// ─── detectKind ──────────────────────────────────────────────────────────────

test("detectKind: design-system from 'design' + subcommand", () => {
  assert.equal(detectKind(["design", "list"]), "design-system");
  assert.equal(detectKind(["design", "install"]), "design-system");
  assert.equal(detectKind(["design", "show"]), "design-system");
  assert.equal(detectKind(["design", "resolved"]), "design-system");
});

test("detectKind: explicit kind tokens", () => {
  assert.equal(detectKind(["design", "system", "list"]), "design-system");
  assert.equal(detectKind(["design", "plugin", "list"]), "plugin");
  assert.equal(detectKind(["design", "skill", "show"]), "skill");
  assert.equal(detectKind(["design", "template", "list"]), "template");
});

test("detectKind: accepts design-system alias", () => {
  assert.equal(detectKind(["design", "design-system", "list"]), "design-system");
});

test("detectKind: returns null for unrecognized first token", () => {
  assert.equal(detectKind(["design", "garbage"]), null);
});

test("detectKind: handles shifted args (no leading 'design')", () => {
  assert.equal(detectKind(["plugin", "list"]), "plugin");
  assert.equal(detectKind(["list"]), "design-system");
});

// ─── KIND_ALIASES ────────────────────────────────────────────────────────────

test("KIND_ALIASES: maps all 4 kinds", () => {
  assert.equal(KIND_ALIASES.system, "design-system");
  assert.equal(KIND_ALIASES["design-system"], "design-system");
  assert.equal(KIND_ALIASES.plugin, "plugin");
  assert.equal(KIND_ALIASES.skill, "skill");
  assert.equal(KIND_ALIASES.template, "template");
});

// ─── designCommand: help ─────────────────────────────────────────────────────

test("designCommand: --help prints help and exits 0", async () => {
  const code = await runCli(["design", "--help"]);
  assert.match(code.output, /Usage: cortex-agent design/);
  assert.match(code.output, /Kinds \(P-001 MS-002\)/);
});

test("designCommand: -h prints help", async () => {
  const code = await runCli(["design", "-h"]);
  assert.match(code.output, /Usage: cortex-agent design/);
});

test("designCommand: empty args prints help", async () => {
  const code = await runCli(["design"]);
  assert.match(code.output, /Usage: cortex-agent design/);
});

// ─── designCommand: backward compat (legacy design-system) ──────────────────

test("designCommand: legacy 'design list' → design-system", async () => {
  const stubPath = require.resolve("../../lib/design/cli");
  const original = require.cache[stubPath].exports.designCommand;
  require.cache[stubPath].exports.designCommand = async () => {
    process.stdout.write("legacy-design-list\n");
  };
  try {
    const code = await runCli(["design", "list"]);
    assert.match(code.output, /legacy-design-list/);
  } finally {
    require.cache[stubPath].exports.designCommand = original;
  }
});

test("designCommand: legacy 'design resolved' → design-system", async () => {
  const stubPath = require.resolve("../../lib/design/cli");
  const original = require.cache[stubPath].exports.designCommand;
  require.cache[stubPath].exports.designCommand = async () => {
    process.stdout.write("legacy-design-resolved\n");
  };
  try {
    const code = await runCli(["design", "resolved"]);
    assert.match(code.output, /legacy-design-resolved/);
  } finally {
    require.cache[stubPath].exports.designCommand = original;
  }
});

// ─── designCommand: 4-kind new subcommands ───────────────────────────────────

test("designCommand: 'design plugin list' prints starter entries", async () => {
  const code = await runCli(["design", "plugin", "list"]);
  assert.match(code.output, /plugin \(/);
  assert.match(code.output, /od-(figma-migration|claude-design-bridge)/);
});

test("designCommand: 'design plugin list --json' emits valid JSON", async () => {
  const code = await runCli(["design", "plugin", "list", "--json"]);
  const parsed = JSON.parse(code.output);
  assert.equal(parsed.kind, "plugin");
  assert.equal(parsed.source, "starter");
  assert.ok(Array.isArray(parsed.entries));
});

test("designCommand: 'design plugin list --installed' (no installs → empty)", async () => {
  const code = await runCli(["design", "plugin", "list", "--installed"]);
  assert.match(code.output, /\(plugin: none\)/);
});

test("designCommand: 'design plugin show <id>' for missing → exit 2", async () => {
  const code = await runCli(["design", "plugin", "show", "od-missing"]);
  assert.match(code.errOutput, /not installed/);
  assert.equal(code.exitCode, 2);
});

test("designCommand: 'design skill list' prints skill entries", async () => {
  const code = await runCli(["design", "skill", "list"]);
  assert.match(code.output, /skill \(/);
});

test("designCommand: 'design template list' prints template entries", async () => {
  const code = await runCli(["design", "template", "list"]);
  assert.match(code.output, /template \(/);
});

test("designCommand: 'design template list --mode prototype' filters", async () => {
  const code = await runCli(["design", "template", "list", "--mode", "prototype"]);
  assert.match(code.output, /\(template: none\)/);
});

test("designCommand: 'design plugin install' → not implemented (exit 1)", async () => {
  const code = await runCli(["design", "plugin", "install", "od-x"]);
  assert.match(code.errOutput, /fetch not yet implemented/);
  assert.equal(code.exitCode, 1);
});

test("designCommand: 'design plugin bogus' → unknown subcommand exit 2", async () => {
  const code = await runCli(["design", "plugin", "bogus"]);
  assert.match(code.errOutput, /Unknown design plugin subcommand/);
  assert.equal(code.exitCode, 2);
});

test("designCommand: 'design template show' without id → exit 2", async () => {
  const code = await runCli(["design", "template", "show"]);
  assert.match(code.errOutput, /id required/);
  assert.equal(code.exitCode, 2);
});

// ─── designCommand: installed show ──────────────────────────────────────────

test("designCommand: 'design plugin show <id>' for installed → prints manifest", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "design-cli-show-"));
  try {
    const id = "od-test";
    const root = path.join(tmp, ".agent", "plugins", id);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "manifest.json"),
      JSON.stringify({ name: id, version: "1.0.0" }, null, 2),
    );
    const prev = process.cwd();
    process.chdir(tmp);
    try {
      const code = await runCli(["design", "plugin", "show", id]);
      assert.match(code.output, /id:\s+od-test/);
      assert.match(code.output, /kind:\s+plugin/);
      assert.match(code.output, /manifest \(json\)/);
    } finally {
      process.chdir(prev);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── helpers ─────────────────────────────────────────────────────────────────

async function runCli(args) {
  let output = "";
  let errOutput = "";
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  const origExitCode = process.exitCode;
  process.exitCode = 0;
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    errOutput += String(chunk);
    return true;
  };
  try {
    const result = designCommand({
      args, cwd: process.cwd(), options: {}, lang: "en", templateDir: "",
    });
    if (result && typeof result.then === "function") {
      await result;
    }
    return { output, errOutput, exitCode: process.exitCode || 0 };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exitCode = origExitCode;
  }
}