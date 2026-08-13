"use strict";

// ─── lib/commands/surface/graphify.js CLI surface tests (T-GWG-001) ──────────
//
// Pins the contract that:
//   - `graphify context` reports not_applicable on a bare project.
//   - `graphify context --json` emits structured JSON.
//   - `graphify doctor` reports plugin state without mutating.
//   - `graphify receipt` reports missing receipt gracefully.
//   - `graphify preflight` returns verdict=skipped when not_applicable.
//   - `graphify update` without CLI binary returns a structured error and
//     exits non-zero WITHOUT mutating the filesystem.
//   - `graphify help` is stable.
//   - `graphify` with an unknown subcommand exits 2.
//
// All tests reset process.exitCode and restore stdout/stderr in a
// `finally` block to keep state isolated.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const surface = require("../../lib/commands/surface/graphify");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-graphify-cli-"));
}

function withCapturedIo(fn) {
  const outChunks = [];
  const errChunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { outChunks.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { errChunks.push(String(chunk)); return true; };
  const beforeExit = process.exitCode;
  process.exitCode = 0;
  let result;
  try {
    result = fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    const finalExit = process.exitCode;
    process.exitCode = beforeExit;
    return {
      stdout: outChunks.join(""),
      stderr: errChunks.join(""),
      exitCode: finalExit,
      result,
    };
  }
}

test("graphify help prints usage", () => {
  const ctx = withCapturedIo(() => surface.graphify({ args: ["help"], cwd: process.cwd(), options: {} }));
  assert.match(ctx.stdout, /graphify <subcommand>/);
  assert.match(ctx.stdout, /context/);
  assert.match(ctx.stdout, /preflight/);
});

test("graphify context on bare project reports not_applicable", () => {
  const root = mkRoot();
  const ctx = withCapturedIo(() => surface.graphify({ args: ["context"], cwd: root, options: {} }));
  assert.match(ctx.stdout, /not_applicable/);
});

test("graphify context --json emits structured JSON", () => {
  const root = mkRoot();
  const ctx = withCapturedIo(() => surface.graphify({ args: ["context", "--json"], cwd: root, options: {} }));
  const parsed = JSON.parse(ctx.stdout);
  assert.equal(parsed.not_applicable, true);
  assert.equal(parsed.available, false);
  assert.equal(parsed.candidate.kind, "not_applicable");
});

test("graphify doctor --json emits state and context", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent", "plugins", "graphify"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "plugins", "graphify", "config.yml"), "graphify:\n  version: 1\n");
  const ctx = withCapturedIo(() => surface.graphify({ args: ["doctor", "--json"], cwd: root, options: {} }));
  const parsed = JSON.parse(ctx.stdout);
  assert.equal(parsed.state.pluginConfig, true);
  assert.equal(parsed.state.graphBuilt, false);
});

test("graphify receipt on missing receipt file returns reason=missing", () => {
  const root = mkRoot();
  const ctx = withCapturedIo(() => surface.graphify({ args: ["receipt", "--json"], cwd: root, options: {} }));
  const parsed = JSON.parse(ctx.stdout);
  assert.equal(parsed.exists, false);
  assert.equal(parsed.reason, "missing");
});

test("graphify preflight on bare project returns verdict=skipped and passes", () => {
  const root = mkRoot();
  const ctx = withCapturedIo(() => surface.graphify({ args: ["preflight", "--json"], cwd: root, options: {} }));
  const parsed = JSON.parse(ctx.stdout);
  assert.equal(parsed.not_applicable, true);
  assert.equal(parsed.pass, true);
  assert.equal(parsed.verdict.result, "skipped");
});

test("graphify update without CLI returns structured error and does not mutate", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent", "plugins", "graphify"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "plugins", "graphify", "config.yml"), "graphify:\n  version: 1\n");
  const ctx = withCapturedIo(() => surface.graphify({ args: ["update", "--json"], cwd: root, options: {} }));
  const parsed = JSON.parse(ctx.stdout);
  // The test machine may or may not have graphify installed; either
  // outcome is a valid contract pin. The structural guarantees:
  //   - ok=true  ⇒ graphify-out/graph.json exists + receipt.json exists
  //   - ok=false ⇒ exit code 3; if CLI is missing, the failure surfaces
  //                as a "graphify_cli_missing" reason with no mutation.
  //                If the CLI is present but the graph build failed, the
  //                command exits 3 with a populated exitStatus and stderr.
  if (parsed.ok) {
    assert.equal(fs.existsSync(path.join(root, "graphify-out", "graph.json")), true);
    assert.equal(fs.existsSync(path.join(root, ".agent", "artifacts", "graphify", "global", "receipt.json")), true);
    assert.equal(parsed.receiptPath && parsed.receiptPath.length > 0, true);
    assert.equal(parsed.result, "fresh");
  } else {
    // Failed update MUST NOT write a half-state receipt.
    assert.equal(fs.existsSync(path.join(root, ".agent", "artifacts", "graphify")), false);
    assert.equal(parsed.reason === "graphify_cli_missing" || typeof parsed.exitStatus === "number", true);
    assert.equal(ctx.exitCode, parsed.reason === "graphify_cli_missing" ? 4 : 3);
  }
});

test("graphify unknown subcommand exits 2 and prints help", () => {
  const ctx = withCapturedIo(() => surface.graphify({ args: ["bogus"], cwd: process.cwd(), options: {} }));
  assert.match(ctx.stderr, /unknown subcommand/);
  assert.match(ctx.stdout, /graphify <subcommand>/);
  assert.equal(ctx.exitCode, 2);
});