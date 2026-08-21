"use strict";

// ─── tests/catalog/extract.test.js ────────────────────────────────────────────
//
// Unit tests for lib/catalog/extract.js — Brand-backed URL → DESIGN.md wrapper.
//
// Coverage:
//   1. URL validation (isValidUrl)
//   2. Daemon detection (isDaemonAvailable)
//   3. Fallback mode (daemon absent) — no fake DESIGN.md, structured hand-off
//   4. URL pattern edge cases
//   5. validateExtractedLicense — fail-closed on missing license
//   6. validateExtractedLicense — pass on acceptable
//   7. extractFromUrl — invalid URL throws
//   8. extractFromUrl — invalid id throws (kebab-case only)
//   9. writeExtractOutput — atomic 3-file write
//  10. isDaemonAvailable — node:child_process probe

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const extract = require("../../lib/catalog/extract");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "extract-test-"));
}

// ─── 1. URL validation ──────────────────────────────────────────────────────

test("isValidUrl — accepts https URLs", () => {
  assert.equal(extract.isValidUrl("https://stripe.com"), true);
  assert.equal(extract.isValidUrl("https://linear.app"), true);
  assert.equal(extract.isValidUrl("https://anthropic.com"), true);
});

test("isValidUrl — accepts http URLs", () => {
  assert.equal(extract.isValidUrl("http://example.com/path"), true);
});

test("isValidUrl — rejects non-string", () => {
  assert.equal(extract.isValidUrl(123), false);
  assert.equal(extract.isValidUrl(null), false);
  assert.equal(extract.isValidUrl(undefined), false);
});

test("isValidUrl — rejects empty / whitespace", () => {
  assert.equal(extract.isValidUrl(""), false);
  assert.equal(extract.isValidUrl("   "), false);
});

// ─── 2. Daemon detection ─────────────────────────────────────────────────────

test("isDaemonAvailable — returns boolean (zero false-positives)", async () => {
  // We don't assert true/false directly because it depends on the host.
  // We assert it resolves with a boolean without throwing.
  const result = await extract.isDaemonAvailable();
  assert.equal(typeof result, "boolean");
});

// ─── 3. Fallback mode (daemon absent) ────────────────────────────────────────

test("extractFromUrl — fallback mode when daemon absent", async () => {
  // Force fallback by stubbing isDaemonAvailable.
  const original = extract.isDaemonAvailable;
  extract.isDaemonAvailable = async () => false;
  try {
    const result = await extract.extractFromUrl({
      url: "https://stripe.com",
      id: "stripe-extracted",
      cwd: tmpDir(),
    });
    assert.equal(result.fallback, true);
    assert.equal(result.handOffUrl, "https://stripe.com");
    assert.equal(result.source, "fallback");
    assert.equal(result.license, undefined); // license not extracted in fallback
    assert.equal(result.kind, "design-system");
    assert.equal(result.id, "stripe-extracted");
    assert.ok(result.message);
    assert.match(result.message, /open-design daemon not on PATH/);
    // No files written in fallback.
    assert.deepEqual(result.sha256, {});
  } finally {
    extract.isDaemonAvailable = original;
  }
});

// ─── 4. URL pattern edge cases ───────────────────────────────────────────────

test("URL_PATTERN — rejects javascript: scheme", () => {
  assert.equal(extract.isValidUrl("javascript:alert(1)"), false);
});

test("URL_PATTERN — rejects file: scheme", () => {
  assert.equal(extract.isValidUrl("file:///etc/passwd"), false);
});

test("URL_PATTERN — rejects data: scheme", () => {
  assert.equal(extract.isValidUrl("data:text/plain,hello"), false);
});

// ─── 5. validateExtractedLicense — fail-closed ───────────────────────────────

test("validateExtractedLicense — null payload fails", () => {
  const r = extract.validateExtractedLicense(null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing/);
});

test("validateExtractedLicense — missing license field fails", () => {
  const r = extract.validateExtractedLicense({ id: "x" });
  assert.equal(r.ok, false);
});

test("validateExtractedLicense — Apache-2.0 acceptable", () => {
  const r = extract.validateExtractedLicense({ id: "x", license: "Apache-2.0" });
  assert.equal(r.ok, true);
});

// ─── 6. validateExtractedLicense — pass ──────────────────────────────────────

test("validateExtractedLicense — MIT acceptable", () => {
  const r = extract.validateExtractedLicense({ id: "x", license: "MIT" });
  assert.equal(r.ok, true);
});

// ─── 7. extractFromUrl — invalid URL throws ─────────────────────────────────

test("extractFromUrl — invalid URL throws (no silent fail)", async () => {
  await assert.rejects(
    () => extract.extractFromUrl({ url: "not-a-url", id: "bad-id" }),
    /invalid URL "not-a-url"/,
  );
});

test("extractFromUrl — javascript: URL throws", async () => {
  await assert.rejects(
    () => extract.extractFromUrl({ url: "javascript:alert(1)", id: "x" }),
    /invalid URL/,
  );
});

// ─── 8. extractFromUrl — invalid id throws ──────────────────────────────────

test("extractFromUrl — id with uppercase rejected", async () => {
  await assert.rejects(
    () => extract.extractFromUrl({ url: "https://x.com", id: "BadId" }),
    /id must be kebab-case slug/,
  );
});

test("extractFromUrl — id with spaces rejected", async () => {
  await assert.rejects(
    () => extract.extractFromUrl({ url: "https://x.com", id: "bad id" }),
    /id must be kebab-case slug/,
  );
});

test("extractFromUrl — id with slash rejected", async () => {
  await assert.rejects(
    () => extract.extractFromUrl({ url: "https://x.com", id: "evil/path" }),
    /id must be kebab-case slug/,
  );
});

// ─── 9. writeExtractOutput — atomic 3-file write ───────────────────────────

test("writeExtractOutput — writes manifest + DESIGN.md + tokens.css", () => {
  const dir = tmpDir();
  const files = extract.writeExtractOutput(dir, {
    manifest: { id: "x", license: "Apache-2.0" },
    design: "# Test Design\n",
    tokens: ":root { --primary: #5e6ad2; }\n",
  });

  assert.ok(fs.existsSync(path.join(dir, "manifest.json")));
  assert.ok(fs.existsSync(path.join(dir, "DESIGN.md")));
  assert.ok(fs.existsSync(path.join(dir, "tokens.css")));
  assert.equal(fs.readFileSync(path.join(dir, "DESIGN.md"), "utf8"), "# Test Design\n");
  assert.equal(Object.keys(files).length, 3);
});

test("writeExtractOutput — accepts string manifest (already-serialized)", () => {
  const dir = tmpDir();
  const files = extract.writeExtractOutput(dir, {
    manifest: '{"id":"x","license":"Apache-2.0"}',
    design: "# Test\n",
  });
  assert.ok(fs.existsSync(path.join(dir, "manifest.json")));
  assert.equal(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"), '{"id":"x","license":"Apache-2.0"}');
  assert.equal(Object.keys(files).length, 2);
});

test("writeExtractOutput — empty payload writes nothing", () => {
  const dir = tmpDir();
  const files = extract.writeExtractOutput(dir, {});
  assert.equal(Object.keys(files).length, 0);
  // Directory still created (mkdirSync recursive).
  assert.ok(fs.existsSync(dir));
});

// ─── 10. runDaemonExtract — defensive against spawn failures ────────────────

test("runDaemonExtract — non-existent binary rejects", async () => {
  await assert.rejects(
    () => extract.runDaemonExtract({ url: "https://x.com", id: "x" }),
    // Either ENOENT (most systems) or "daemon exit N" — both signal failure.
    /ENOENT|exit/,
  );
});
