"use strict";

// tests/mcp/cli.test.js — `cortex-agent mcp` argv parser + dispatch (P-002 MS-003).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  mcpCommand,
  parseMcpArgs,
  printHelp,
  installCommand,
  listCommand,
  uninstallCommand,
} = require("../../lib/commands/mcp");

function capture(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

function withExitCode(fn) {
  const before = process.exitCode;
  try {
    fn();
  } finally {
    process.exitCode = before;
  }
}

// ─── parseMcpArgs ────────────────────────────────────────────────────────────

test("parseMcpArgs parses serve flags", () => {
  const parsed = parseMcpArgs(["serve", "--token", "ab".repeat(32), "--loopback-only"]);
  assert.equal(parsed.subcommand, "serve");
  assert.equal(parsed.token, "ab".repeat(32));
  assert.equal(parsed.loopbackOnly, true);
});

test("parseMcpArgs parses install flags and positional agent", () => {
  const parsed = parseMcpArgs(["install", "claude", "--dry-run", "--print", `--token=${"cd".repeat(32)}`]);
  assert.equal(parsed.subcommand, "install");
  assert.equal(parsed.agent, "claude");
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.print, true);
  assert.equal(parsed.token, "cd".repeat(32));
});

test("parseMcpArgs parses ping timeout and legacy serve --project", () => {
  assert.equal(parseMcpArgs(["ping", "--timeout", "5s"]).timeout, "5s");
  const legacy = parseMcpArgs(["serve", "--project", "/tmp/x"]);
  assert.equal(legacy.subcommand, "serve");
  assert.equal(legacy.project, "/tmp/x");
  assert.equal(parseMcpArgs(["list", "--json"]).json, true);
  assert.equal(parseMcpArgs(["--help"]).showHelp, true);
  assert.equal(parseMcpArgs([]).subcommand, null);
});

// ─── help / unknown subcommand ───────────────────────────────────────────────

test("printHelp lists all five subcommands", () => {
  const out = capture(printHelp);
  for (const sub of ["serve", "install", "ping", "list", "uninstall"]) {
    assert.match(out, new RegExp(`\\b${sub}\\b`));
  }
});

test("mcpCommand unknown subcommand sets exit code 2", async () => {
  withExitCode(() => {
    capture(() => {});
  });
  process.exitCode = undefined;
  const stderr = [];
  const originalErr = process.stderr.write;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    await mcpCommand({ cwd: os.tmpdir(), args: ["mcp", "bogus"] });
  } finally {
    process.stderr.write = originalErr;
  }
  assert.equal(process.exitCode, 2);
  assert.match(stderr.join(""), /unknown subcommand: bogus/);
  process.exitCode = undefined;
});

// ─── install subcommand ──────────────────────────────────────────────────────

test("installCommand --dry-run --print emits the JSON snippet", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mcp-cli-install-"));
  try {
    process.env.HOME = home;
    process.exitCode = undefined;
    const ctx = { cwd: "/proj", args: ["mcp", "install", "claude", "--dry-run", "--print"] };
    const parsed = parseMcpArgs(["install", "claude", "--dry-run", "--print"]);
    let exit = undefined;
    const out = capture(() => {
      withExitCode(() => {
        installCommand(ctx, parsed);
        exit = process.exitCode;
      });
    });
    assert.equal(exit, undefined);
    const json = JSON.parse(out);
    assert.equal(json.command, "cortex-agent");
    assert.equal(json.args[0], "mcp");
  } finally {
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = undefined;
  }
});

test("installCommand rejects invalid token with exit code 2", () => {
  process.exitCode = undefined;
  const stderr = [];
  const originalErr = process.stderr.write;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    installCommand({ cwd: os.tmpdir() }, parseMcpArgs(["install", "claude", "--token", "bad"]));
  } finally {
    process.stderr.write = originalErr;
  }
  assert.equal(process.exitCode, 2);
  assert.match(stderr.join(""), /invalid --token/);
  process.exitCode = undefined;
});

test("installCommand unknown agent exits 2 with a helpful message", () => {
  process.exitCode = undefined;
  const stderr = [];
  const originalErr = process.stderr.write;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    installCommand({ cwd: os.tmpdir() }, parseMcpArgs(["install", "nope"]));
  } finally {
    process.stderr.write = originalErr;
  }
  assert.equal(process.exitCode, 2);
  assert.match(stderr.join(""), /unknown agent "nope"/);
  process.exitCode = undefined;
});

// ─── list / uninstall subcommands ────────────────────────────────────────────

test("listCommand --json emits the installed registry", () => {
  const out = capture(() => {
    listCommand({ cwd: os.tmpdir() }, parseMcpArgs(["list", "--json"]));
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.installed));
  assert.ok(parsed.installed.some((i) => i.agent === "claude"));
});

test("uninstallCommand unknown agent exits 2", () => {
  process.exitCode = undefined;
  try {
    uninstallCommand({ cwd: os.tmpdir() }, parseMcpArgs(["uninstall", "nope"]));
  } finally {
    assert.equal(process.exitCode, 2);
    process.exitCode = undefined;
  }
});

// ─── end-to-end through bin/cli.js ───────────────────────────────────────────

test("cortex-agent mcp help --json is served by bin/cli.js dispatch", () => {
  const { spawnSync } = require("node:child_process");
  const cli = path.resolve(__dirname, "..", "..", "bin", "cli.js");
  const result = spawnSync(process.execPath, [cli, "mcp", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: cortex-agent mcp <subcommand>/);
});
