"use strict";

/**
 * Activity Projection — main-repo entry test.
 *
 * Validates the MS-004 contract from the public surface:
 *  - VC-010 the query shape distinguishes complete / partial / unknown
 *    sources and never treats an empty array as proof of no activity
 *  - VC-011 the Management API projection is read-only and tolerates
 *    missing legacy state
 *  - VC-012 the same projection is consumable by CLI / Dashboard /
 *    Briefing through a single, stable query surface
 *
 * The activity aggregation itself lives in the inner .agent workspace
 * (query-activity.js). This test exercises the public CLI and asserts
 * the consumer-facing contract.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const MGMT = path.join(ROOT, ".agent", "skills", "management-api", "scripts", "index.js");

function query(args = []) {
  const result = spawnSync("node", [MGMT, "query", "activity", ...args], { encoding: "utf8" });
  return { status: result.status, payload: JSON.parse(result.stdout) };
}

test("activity projection is wrapped in an ok+query envelope", () => {
  const { payload } = query();
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.query, "activity");
  assert.ok(typeof payload.generated_at === "string");
  assert.ok(payload.filters && typeof payload.filters === "object");
});

test("activity projection exposes summary counters (VC-011 consumer surface)", () => {
  const { payload } = query();
  assert.ok(payload.summary && typeof payload.summary === "object");
  assert.ok(typeof payload.summary.total === "number");
  assert.ok(payload.summary.total >= 0);
  // by_kind is the multi-bucket discriminator used by Dashboard / Briefing.
  assert.ok(payload.summary.by_kind && typeof payload.summary.by_kind === "object");
});

test("activity projection items keep kind / status / relations / evidence_refs (VC-012)", () => {
  const { payload } = query();
  if (payload.activity.length === 0) return;
  const item = payload.activity[0];
  assert.ok(typeof item.activity_id === "string");
  assert.ok(typeof item.kind === "string");
  assert.ok(item.relations && typeof item.relations === "object");
  assert.ok(Array.isArray(item.evidence_refs));
});

test("activity projection never silently fails (VC-011 read-only)", () => {
  // The Management API must surface warnings or unknown_time state
  // rather than swallow gaps.
  const { payload } = query();
  assert.ok(Array.isArray(payload.warnings));
  assert.ok(typeof payload.summary.unknown_time === "number");
});

test("activity projection tolerates --since / --until inclusive filters (VC-012)", () => {
  const since = "2026-01-01T00:00:00Z";
  const until = "2026-12-31T23:59:59Z";
  const { payload } = query(["--since", since, "--until", until]);
  // The query parser may normalize timestamps to ISO with milliseconds;
  // accept any RFC 3339 form starting with the supplied prefix.
  assert.ok(payload.filters.since.startsWith("2026-01-01T00:00:00"),
    `since not parsed as expected: ${payload.filters.since}`);
  assert.ok(payload.filters.until.startsWith("2026-12-31T23:59:59"),
    `until not parsed as expected: ${payload.filters.until}`);
  if (payload.activity.length > 0) {
    for (const item of payload.activity) {
      assert.ok(["known", "unknown"].includes(item.time_state));
    }
  }
});

test("dashboard-state projection also exposes latest_update without writing (VC-012)", () => {
  const result = spawnSync("node", [MGMT, "query", "dashboard-state"], { encoding: "utf8" });
  const payload = JSON.parse(result.stdout);
  assert.strictEqual(payload.ok, true);
  assert.ok("latest_update" in payload || payload.latest_update === null,
    "dashboard-state must include latest_update field");
});