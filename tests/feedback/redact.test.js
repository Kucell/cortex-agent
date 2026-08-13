"use strict";

// ─── VC-003, VC-005 — Redaction scrubs PII / credentials before persistence ──

const assert = require("node:assert/strict");
const test = require("node:test");
const { redactString, redactEventFields, REDACTION_PATTERNS } = require("../../lib/feedback/redact");
const { appendEvent, inboxRootFor } = require("../../lib/feedback/inbox");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("VC-003 redactString scrubs emails", () => {
  const r = redactString("contact alice@example.com or bob@a.io for support");
  assert.equal(r.value.includes("alice@example.com"), false);
  assert.equal(r.value.includes("[REDACTED:email]"), true);
  assert.ok(r.applied.find((a) => a.name === "email"));
});

test("VC-003 redactString scrubs IPv4", () => {
  const r = redactString("server at 10.0.0.42 returned 502");
  assert.equal(r.value.includes("10.0.0.42"), false);
  assert.ok(r.value.includes("[REDACTED:ipv4]"));
});

test("VC-003 redactString scrubs absolute paths", () => {
  const r1 = redactString("see /home/alice/secret/file.txt for details");
  assert.ok(r1.value.includes("[REDACTED:path]"));
  const r2 = redactString("on Windows at C:\\Users\\bob\\passwords.txt was leaked");
  assert.ok(r2.value.includes("[REDACTED:path]"));
});

test("VC-003 redactString scrubs credential-shaped key=value pairs", () => {
  const r = redactString("debug: api_key=sk_live_abcdef123 debug=1");
  assert.equal(r.value.includes("sk_live_abcdef123"), false);
  assert.ok(r.value.includes("[REDACTED:credential]"));
});

test("VC-003 redactString scrubs JWT and PEM blocks", () => {
  const jwt = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature";
  const r1 = redactString(jwt);
  assert.equal(r1.value.includes("eyJhbGciOi"), false);
  assert.ok(r1.value.includes("[REDACTED:jwt]"));
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----";
  const r2 = redactString(pem);
  assert.equal(r2.value.includes("BEGIN PRIVATE KEY"), false);
  assert.ok(r2.value.includes("[REDACTED:pem]"));
});

test("VC-003 built-in patterns include the expected PII classes", () => {
  const names = REDACTION_PATTERNS.map((p) => p.name);
  for (const expected of ["email", "ipv4", "ipv6", "abs-path", "credential-kv", "jwt", "pem-block"]) {
    assert.ok(names.includes(expected), `missing pattern: ${expected}`);
  }
});

test("VC-003 redactEventFields scrubs title/summary/diagnostic_code and tags", () => {
  const ev = {
    schema_version: 1,
    event_id: "fev_00000000-0000-4000-8000-000000000000",
    occurred_at: "2026-08-12T09:00:00.000Z",
    kind: "blocker",
    severity: "high",
    title: "alice@example.com reported failure",
    summary: "leaked /home/user/.ssh/id_rsa and api_key=sk_test_xxx",
    diagnostic_code: "AUTH_FAILED for 10.1.2.3",
    source: { adapter: "cortex-diagnostic", project_slug: "cortex-agent" },
    tags: ["good", "alice@example.com", "ok.tag", "/etc/passwd"],
  };
  const { event, applied, dirty } = redactEventFields(ev);
  assert.equal(dirty, true);
  assert.equal(event.title.includes("alice@example.com"), false);
  assert.equal(event.summary.includes("/home/user/.ssh/id_rsa"), false);
  assert.equal(event.summary.includes("sk_test_xxx"), false);
  assert.equal(event.diagnostic_code.includes("10.1.2.3"), false);
  // Tags: the two offending tags are dropped, the [REDACTED:tag] is appended.
  assert.ok(event.tags.includes("good"));
  assert.ok(event.tags.includes("ok.tag"));
  assert.ok(event.tags.includes("[REDACTED:tag]"));
  assert.equal(event.tags.includes("alice@example.com"), false);
  assert.equal(event.tags.includes("/etc/passwd"), false);
  // redaction audit block exists.
  assert.equal(event.redaction.applied, true);
  assert.ok(Array.isArray(event.redaction.patterns));
  // applied entries have name + count.
  for (const entry of applied) {
    assert.ok(entry.name && typeof entry.count === "number");
  }
});

test("VC-005 appendEvent writes redacted payload to disk (PII never lands on disk)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-feedback-redact-"));
  try {
    const inboxRoot = inboxRootFor(root);
    const dirty = {
      schema_version: 1,
      event_id: "fev_00000000-0000-4000-8000-000000000001",
      occurred_at: "2026-08-12T09:00:00.000Z",
      kind: "blocker",
      severity: "high",
      title: "Alice <alice@example.com> reported /home/alice/secret.txt",
      summary: "api_key=sk_live_leak",
      diagnostic_code: "AUTH_FAILED_10.0.0.5",
      source: { adapter: "manual", project_slug: "cortex-agent" },
    };
    const r = appendEvent({ inboxRoot, event: dirty });
    assert.equal(r.ok, true, JSON.stringify(r));
    const onDisk = fs.readFileSync(r.path, "utf8");
    assert.equal(onDisk.includes("alice@example.com"), false, "email leaked to disk");
    assert.equal(onDisk.includes("/home/alice/secret.txt"), false, "path leaked to disk");
    assert.equal(onDisk.includes("sk_live_leak"), false, "credential leaked to disk");
    assert.equal(onDisk.includes("10.0.0.5"), false, "ip leaked to disk");
    // The redaction audit block must be present.
    assert.ok(onDisk.includes("\"redaction\""));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-003 redactString is a pure function (input unchanged)", () => {
  const input = "alice@example.com /home/x api_key=secret";
  const copy = input.slice(0);
  redactString(input);
  assert.equal(input, copy);
});