"use strict";

// transcript-link-template-parity.test.js (P-002a)
// Verifies the audit-trail P-002 transcript-link contract is consistent across
// every distribution source that reaches user projects:
//   1. canonical .agent/skills/management-api/scripts/index.js (L3 self-bootstrap)
//   2. templates/_shared/.../management-api/scripts/index.js  (init/upgrade source)
//   3. templates/zh + templates/en (localized copies)
//   4. templates/_base/.agent/runs/run.schema.json (general-mode data layer)
//   5. canonical .agent/runs/run.schema.json

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CANONICAL_MGMT = path.join(ROOT, ".agent", "skills", "management-api", "scripts", "index.js");
const SHARED_MGMT = path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api", "scripts", "index.js");
const ZH_MGMT = path.join(ROOT, "templates", "zh", ".agent", "skills", "management-api", "scripts", "index.js");
const EN_MGMT = path.join(ROOT, "templates", "en", ".agent", "skills", "management-api", "scripts", "index.js");
const CANONICAL_SCHEMA = path.join(ROOT, ".agent", "runs", "run.schema.json");
const BASE_SCHEMA = path.join(ROOT, "templates", "_base", ".agent", "runs", "run.schema.json");

const FN_MARKERS = ["function runsTranscriptLink()", 'query === "transcript-link"', "transcript-link|tokens receipt"];
const SCHEMA_REQUIRED = ["source", "session_id", "path", "sha256", "byte_size", "turn_count", "linked_at"];

function read(file) { return fs.readFileSync(file, "utf8"); }

test("P-002a: all four management-api copies carry the transcript-link contract", () => {
  for (const file of [CANONICAL_MGMT, SHARED_MGMT, ZH_MGMT, EN_MGMT]) {
    const src = read(file);
    for (const marker of FN_MARKERS) {
      assert.ok(src.includes(marker), file + " missing marker " + marker);
    }
  }
});

test("P-002a: transcript-link block byte-identical between canonical and _shared", () => {
  const canonical = read(CANONICAL_MGMT);
  const shared = read(SHARED_MGMT);
  const cStart = canonical.indexOf("// ─── runs transcript-link");
  const cEnd = canonical.indexOf("function upsertQueue()", cStart);
  const sStart = shared.indexOf("// ─── runs transcript-link");
  const sEnd = shared.indexOf("function upsertQueue()", sStart);
  assert.ok(cStart >= 0 && cEnd > cStart, "canonical block anchors missing");
  assert.ok(sStart >= 0 && sEnd > sStart, "shared block anchors missing");
  assert.equal(canonical.slice(cStart, cEnd), shared.slice(sStart, sEnd), "transcript-link block drifted");
});

test("P-002a: zh/en dispatch and usage match _shared", () => {
  for (const file of [ZH_MGMT, EN_MGMT]) {
    const src = read(file);
    assert.ok(src.includes('query === "transcript-link"'), file + " dispatch missing");
    assert.ok(src.includes("transcript-link|tokens receipt"), file + " usage missing");
  }
});

test("P-002a: canonical and _base run schemas both declare transcript_refs", () => {
  for (const file of [CANONICAL_SCHEMA, BASE_SCHEMA]) {
    const schema = JSON.parse(read(file));
    assert.ok(schema.properties && schema.properties.transcript_refs, file + " transcript_refs missing");
    const items = schema.properties.transcript_refs.items;
    assert.ok(items && items.required, file + " items.required missing");
    for (const field of SCHEMA_REQUIRED) {
      assert.ok(items.required.includes(field), file + " missing required " + field);
    }
    assert.equal(items.additionalProperties, false, file + " ref object must be closed");
  }
});

test("P-002a: source enum identical between canonical and _base", () => {
  const canonical = JSON.parse(read(CANONICAL_SCHEMA));
  const base = JSON.parse(read(BASE_SCHEMA));
  const cEnum = canonical.properties.transcript_refs.items.properties.source.enum;
  const bEnum = base.properties.transcript_refs.items.properties.source.enum;
  assert.deepEqual(cEnum, bEnum, "source enum drifted");
  assert.deepEqual(cEnum, ["claude-code", "codex", "cursor", "pi", "other"]);
});