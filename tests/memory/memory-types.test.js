"use strict";

// ─── Memory Types Tests (M-002 MS-002) ────────────────────────────────────────
//
// Coverage: lib/memory/types.js — 3 type registry, parseTypeList validation,
// writable vs read-only types per D-002-2.

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  TYPES,
  ALL_TYPES,
  WRITABLE_TYPES,
  DEFAULT_EXPIRY_DAYS,
  isValidType,
  isWritableType,
  parseTypeList,
} = require("../../lib/memory/types");

test("memory-types: TYPES exposes 3 canonical names", () => {
  assert.equal(TYPES.EPISODIC, "episodic");
  assert.equal(TYPES.SEMANTIC, "semantic");
  assert.equal(TYPES.PROCEDURAL, "procedural");
});

test("memory-types: ALL_TYPES has exactly 3 entries in expected order", () => {
  assert.deepEqual([...ALL_TYPES], ["episodic", "semantic", "procedural"]);
});

test("memory-types: WRITABLE_TYPES excludes procedural (v1.12 deferred)", () => {
  assert.deepEqual([...WRITABLE_TYPES], ["episodic", "semantic"]);
  assert.equal(WRITABLE_TYPES.includes("procedural"), false);
});

test("memory-types: DEFAULT_EXPIRY_DAYS reflects type semantics", () => {
  assert.equal(DEFAULT_EXPIRY_DAYS.episodic, 90);
  assert.equal(DEFAULT_EXPIRY_DAYS.semantic, null);
  assert.equal(DEFAULT_EXPIRY_DAYS.procedural, null);
});

test("memory-types: isValidType accepts only known types", () => {
  assert.equal(isValidType("episodic"), true);
  assert.equal(isValidType("semantic"), true);
  assert.equal(isValidType("procedural"), true);
  assert.equal(isValidType("episodic "), false);
  assert.equal(isValidType("EPISODIC"), false);
  assert.equal(isValidType(""), false);
  assert.equal(isValidType(null), false);
  assert.equal(isValidType(undefined), false);
});

test("memory-types: isWritableType is isValidType minus procedural", () => {
  assert.equal(isWritableType("episodic"), true);
  assert.equal(isWritableType("semantic"), true);
  assert.equal(isWritableType("procedural"), false);
});

test("memory-types: parseTypeList with no input returns all 3 types", () => {
  assert.deepEqual(parseTypeList(), ["episodic", "semantic", "procedural"]);
  assert.deepEqual(parseTypeList(""), ["episodic", "semantic", "procedural"]);
  assert.deepEqual(parseTypeList(null), ["episodic", "semantic", "procedural"]);
});

test("memory-types: parseTypeList splits comma-separated values and dedupes", () => {
  assert.deepEqual(parseTypeList("episodic"), ["episodic"]);
  assert.deepEqual(parseTypeList("episodic,semantic"), ["episodic", "semantic"]);
  assert.deepEqual(parseTypeList("episodic, semantic"), ["episodic", "semantic"]);
  assert.deepEqual(parseTypeList("episodic,episodic,semantic"), ["episodic", "semantic"]);
});

test("memory-types: parseTypeList throws on unknown type with code", () => {
  assert.throws(
    () => parseTypeList("episodic,bogus"),
    (err) => err.code === "ERR_INVALID_MEMORY_TYPE" && /bogus/.test(err.message),
  );
});
