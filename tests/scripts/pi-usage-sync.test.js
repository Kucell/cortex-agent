"use strict";

// ─── pi-usage-sync tests (M-025/MS-003 Phase B backfill — Pi agent host) ─────
// Focused tests for Pi session transcript → token-attempt-ledger mapping.
// Validates:
//   1. Fixture discovery under ~/.pi/agent/sessions/<slug>/*.jsonl
//   2. Nested message.usage extraction (0.84.x format) + top-level usage (legacy)
//   3. attempt_id derivation (pi-<session>-<eventId>)
//   4. Canonical field mapping (input→input_tokens etc.)
//   5. Skip reasons (not_message_row / no_usage / empty_usage)
//   6. Dry-run vs apply behavior
//   7. Idempotency (apply twice → duplicates collapsed)
//   8. --session-slug filter
//   9. Missing pi-home → graceful error

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "pi-usage-sync.js");

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pi-sync-"));
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  return root;
}

function writeSession(piHome, slug, name, lines) {
  const dir = path.join(piHome, "agent", "sessions", slug);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

function runSync(extraArgs, piHome, projectRoot) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, HOME: piHome, USERPROFILE: piHome },
    encoding: "utf8",
  });
}

// 0.84.x format: usage nested under message.usage
function makeNestedMessage(overrides = {}) {
  return {
    type: "message",
    id: "msg-0001",
    parentId: null,
    timestamp: "2026-08-18T01:02:03.000Z",
    message: {
      role: "assistant",
      api: "anthropic-messages",
      provider: "minimax-cn",
      model: "MiniMax-M3",
      usage: {
        input: 1650,
        output: 72,
        cacheRead: 12070,
        cacheWrite: 0,
        totalTokens: 13792,
        cost: { total: 0.0013056 },
      },
      ...(overrides.message || {}),
    },
    ...overrides,
  };
}

// Legacy format: usage at top level
function makeTopLevelUsage(overrides = {}) {
  return {
    type: "message",
    id: "msg-0002",
    parentId: null,
    timestamp: "2026-08-18T02:03:04.000Z",
    provider: "volcengine",
    model: "Volc-M1",
    usage: {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
    },
    ...overrides,
  };
}

function messageLine(obj) { return JSON.stringify(obj); }

// ─── TC-001: --help prints usage ────────────────────────────────────────────
test("TC-001: --help prints usage and exits 0", () => {
  const result = runSync(["--help"], "/nonexistent", "/tmp");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: pi-usage-sync/);
  assert.match(result.stdout, /--apply/);
});

// ─── TC-002: dry-run reports counts without writing ─────────────────────────
test("TC-002: dry-run reports parsed/submitted counts but writes no ledger", () => {
  const piHome = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pi-home-"));
  const root = tempProject();
  const slug = "--Users-xueyq-myworks-cortex-agent--";
  writeSession(piHome, slug, "2026-08-18T01-00-00Z_abc123", [
    messageLine(makeNestedMessage()),
    messageLine(makeTopLevelUsage()),
    messageLine({ type: "session", id: "s1", timestamp: "2026-08-18T00:00:00Z" }),
    messageLine({ type: "message", id: "msg-no-usage", timestamp: "2026-08-18T03:00:00Z", message: { role: "user" } }),
  ]);
  const result = runSync(["--pi-home", piHome, "--project-root", root, "--dry-run"], piHome, root);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.mode, "dry-run");
  assert.equal(out.counters.rows_parsed, 4);
  assert.equal(out.counters.submitted, 2);
  assert.equal(out.counters.rows_skipped, 2);
  assert.equal(out.counters.written, 0);
  assert.equal(out.counters.skipped_by_reason.not_message_row, 1);
  assert.equal(out.counters.skipped_by_reason.no_usage, 1);
  assert.equal(out.by_slug[slug], 2);
  // Ledger must not be created on dry-run
  assert.equal(fs.existsSync(path.join(root, ".agent", "token-attempts", "ledger-index.json")), false);
});

// ─── TC-003: --apply writes canonical fields with pi-* attempt_id ───────────
test("TC-003: --apply writes canonical fields and pi-* attempt_id prefix", () => {
  const piHome = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pi-home-"));
  const root = tempProject();
  const slug = "--Users-xueyq-myworks-cortex-agent--";
  writeSession(piHome, slug, "2026-08-18T01-00-00Z_abc123", [
    messageLine(makeNestedMessage()),
  ]);
  const result = runSync(["--pi-home", piHome, "--project-root", root, "--apply"], piHome, root);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.mode, "apply");
  assert.equal(out.counters.written, 1);
  assert.equal(out.counters.duplicates, 0);

  const ledgerDir = path.join(root, ".agent", "token-attempts");
  const index = JSON.parse(fs.readFileSync(path.join(ledgerDir, "ledger-index.json"), "utf8"));
  assert.equal(index.entries.length, 1);
  const r = index.entries[0];
  assert.match(r.attempt_id, /^pi-/);
  assert.match(r.attempt_id, /msg-0001$/);
  assert.equal(r.host, "pi-json");
  assert.equal(r.model, "MiniMax-M3");
  assert.equal(r.recorded_at, "2026-08-18T01:02:03.000Z");
  assert.equal(r.usage.input_tokens, 1650);
  assert.equal(r.usage.output_tokens, 72);
  assert.equal(r.usage.cache_read_input_tokens, 12070);
  assert.equal(r.usage.cache_creation_input_tokens, 0);
});

// ─── TC-004: legacy top-level usage also maps ───────────────────────────────
test("TC-004: top-level usage (legacy format) maps to canonical fields", () => {
  const piHome = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pi-home-"));
  const root = tempProject();
  const slug = "legacy-slug";
  writeSession(piHome, slug, "2026-08-18T02-00-00Z_def456", [
    messageLine(makeTopLevelUsage()),
  ]);
  const result = runSync(["--pi-home", piHome, "--project-root", root, "--apply"], piHome, root);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.counters.written, 1);
  const index = JSON.parse(fs.readFileSync(path.join(root, ".agent", "token-attempts", "ledger-index.json"), "utf8"));
  const r = index.entries[0];
  assert.equal(r.host, "pi-json");
  assert.equal(r.model, "Volc-M1");
  assert.equal(r.usage.input_tokens, 100);
  assert.equal(r.usage.output_tokens, 50);
});

// ─── TC-005: idempotency — apply twice collapses duplicates ────────────────
test("TC-005: idempotency — apply twice → duplicates collapsed, no double count", () => {
  const piHome = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pi-home-"));
  const root = tempProject();
  const slug = "idem-slug";
  writeSession(piHome, slug, "2026-08-18T03-00-00Z_ghi789", [
    messageLine(makeNestedMessage()),
  ]);
  runSync(["--pi-home", piHome, "--project-root", root, "--apply"], piHome, root);
  const result = runSync(["--pi-home", piHome, "--project-root", root, "--apply"], piHome, root);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.counters.written, 0);
  assert.equal(out.counters.duplicates, 1);
  const index = JSON.parse(fs.readFileSync(path.join(root, ".agent", "token-attempts", "ledger-index.json"), "utf8"));
  assert.equal(index.entries.length, 1);
});

// ─── TC-006: --session-slug filters to one slug ─────────────────────────────
test("TC-006: --session-slug filters to one slug dir", () => {
  const piHome = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pi-home-"));
  const root = tempProject();
  writeSession(piHome, "slug-a", "s1", [messageLine(makeNestedMessage())]);
  writeSession(piHome, "slug-b", "s2", [messageLine(makeNestedMessage())]);
  const result = runSync(["--pi-home", piHome, "--project-root", root, "--session-slug", "slug-a", "--dry-run"], piHome, root);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.counters.sessions_scanned, 1);
  assert.equal(out.counters.submitted, 1);
  assert.deepEqual(Object.keys(out.by_slug), ["slug-a"]);
});

// ─── TC-007: missing pi-home → graceful error ───────────────────────────────
test("TC-007: missing pi-home sessions → graceful error exit 2", () => {
  const piHome = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pi-empty-"));
  const root = tempProject();
  const result = runSync(["--pi-home", piHome, "--project-root", root], piHome, root);
  assert.equal(result.status, 2);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error, "no_pi_sessions_found");
});

// ─── TC-008: --limit caps writes ────────────────────────────────────────────
test("TC-008: --limit caps the number of receipts written", () => {
  const piHome = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pi-home-"));
  const root = tempProject();
  const slug = "limit-slug";
  const rows = [
    messageLine(makeNestedMessage({ id: "m1" })),
    messageLine(makeNestedMessage({ id: "m2" })),
    messageLine(makeNestedMessage({ id: "m3" })),
  ];
  writeSession(piHome, slug, "s-limit", rows);
  const result = runSync(["--pi-home", piHome, "--project-root", root, "--apply", "--limit", "2"], piHome, root);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.counters.written, 2);
});