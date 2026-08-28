"use strict";

const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const { generate, VALID_ENCODINGS, DEFAULT_BYTES, MAX_BYTES } =
  require("../../.agent/skills/secrets/scripts/generate.js");

const SCRIPT = path.join(__dirname, "..", "..", ".agent", "skills", "secrets", "scripts", "generate.js");

function runCli(argv, env = {}) {
  return cp.spawnSync(process.execPath, [SCRIPT, ...argv], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// ─── pure unit tests (no CLI spawn) ────────────────────────────────────────────

test("generate({}) returns a default 32-byte hex token", () => {
  const r = generate({});
  assert.equal(r.ok, true);
  assert.equal(r.action, "generate");
  assert.equal(r.bytes, DEFAULT_BYTES);
  assert.equal(r.encoding, "hex");
  // 32 bytes hex = 64 chars
  assert.equal(r.length_chars, 64);
  assert.match(r.value, /^[0-9a-f]{64}$/);
});

test("generate({bytes:16, encoding:'base64'}) yields 24-char base64", () => {
  const r = generate({ bytes: 16, encoding: "base64" });
  assert.equal(r.ok, true);
  assert.equal(r.bytes, 16);
  assert.equal(r.encoding, "base64");
  assert.equal(r.length_chars, 24);
  assert.match(r.value, /^[A-Za-z0-9+/]{22}==$/);
});

test("generate({bytes:32, encoding:'base64url'}) yields 43-char urlsafe no padding", () => {
  const r = generate({ bytes: 32, encoding: "base64url" });
  assert.equal(r.ok, true);
  assert.equal(r.length_chars, 43);
  assert.match(r.value, /^[A-Za-z0-9_-]{43}$/);
  // Must NOT contain + or / or =
  assert.equal(r.value.includes("+"), false);
  assert.equal(r.value.includes("/"), false);
  assert.equal(r.value.includes("="), false);
});

test("two consecutive generate() calls produce different outputs", () => {
  const a = generate({ bytes: 32 });
  const b = generate({ bytes: 32 });
  assert.notEqual(a.value, b.value, "CSPRNG output must be unique across calls");
});

test("generate rejects invalid encodings", () => {
  assert.equal(generate({ encoding: "utf8" }).ok, false);
  assert.equal(generate({ encoding: "utf8" }).error, "invalid_encoding");
  assert.equal(VALID_ENCODINGS.has("hex"), true);
  assert.equal(VALID_ENCODINGS.has("base64"), true);
  assert.equal(VALID_ENCODINGS.has("base64url"), true);
});

test("generate rejects non-positive or oversized bytes", () => {
  assert.equal(generate({ bytes: 0 }).ok, false);
  assert.equal(generate({ bytes: -1 }).ok, false);
  assert.equal(generate({ bytes: MAX_BYTES + 1 }).ok, false);
  assert.equal(generate({ bytes: MAX_BYTES + 1 }).error, "invalid_bytes");
});

test("generate rejects non-integer bytes", () => {
  assert.equal(generate({ bytes: 1.5 }).ok, false);
  assert.equal(generate({ bytes: NaN }).ok, false);
  assert.equal(generate({ bytes: "32" }).ok, false);
});

// ─── CLI integration (spawn the actual script) ─────────────────────────────────

test("CLI default invocation prints redacted envelope, exits 0", () => {
  const r = runCli([]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true);
  assert.equal(out.action, "generate");
  assert.equal(out.bytes, DEFAULT_BYTES);
  assert.equal(out.encoding, "hex");
  assert.equal(out.length_chars, 64);
  // The redacted envelope must NOT contain a real hex value.
  assert.match(out.value, /<cortex-redacted>\(len=64\)/);
});

test("CLI --print returns raw value on stdout, no redaction", () => {
  const r = runCli(["--bytes", "16", "--encoding", "base64", "--print"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true);
  assert.match(out.value, /^[A-Za-z0-9+/]{22}==$/);
  // Raw value must not be wrapped in the redacted placeholder.
  assert.equal(out.value.startsWith("<"), false);
});

test("CLI --bytes 0 fails with exit 1 (CLI-layer integer parse error)", () => {
  // Note: CLI does its own positive-int parse in main() and surfaces
  // `invalid_int`. The core generate() function emits `invalid_bytes` when
  // called directly with bytes=0. Both are valid rejections — this test
  // exercises the CLI path.
  const r = runCli(["--bytes", "0"]);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, false);
  assert.equal(out.error, "invalid_int");
});

test("CLI --encoding garbage fails with exit 1 and invalid_encoding", () => {
  const r = runCli(["--encoding", "rot13"]);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, false);
  assert.equal(out.error, "invalid_encoding");
});

test("dispatched via secrets/index.js generate command path", () => {
  // Smoke test that the dispatch we added in index.js routes to generate.js
  // without going through the ACTIONS-fail branch.
  const dispatcher = path.join(
    __dirname, "..", "..", ".agent", "skills", "secrets", "scripts", "index.js"
  );
  const r = cp.spawnSync(process.execPath, [dispatcher, "generate", "--bytes", "8", "--print"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true);
  assert.equal(out.action, "generate");
  // 8 bytes hex = 16 chars
  assert.equal(out.length_chars, 16);
  assert.match(out.value, /^[0-9a-f]{16}$/);
});
