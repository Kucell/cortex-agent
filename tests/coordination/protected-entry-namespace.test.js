"use strict";

// Contract tests for the candidate entry namespace enumeration.
const test = require("node:test");
const assert = require("node:assert");
const namespace = require("../../lib/coordination/protected-entry-namespace");

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function entry(overrides = {}) {
  return {
    domain: "domain-a",
    store_id: "store-a",
    sequence: 1,
    attempt: 1,
    type: "intent",
    body_digest: DIGEST_A,
    ...overrides,
  };
}

function slot(domain, storeId, sequence, attempt, type, body_digest = DIGEST_A) {
  return entry({ domain, store_id: storeId, sequence, attempt, type, body_digest });
}

test("a complete slot is clean", () => {
  const view = namespace.summarize(namespace.enumerate([
    slot("d", "s", 1, 1, "intent"),
    slot("d", "s", 1, 1, "commit"),
  ]));
  assert.strictEqual(view.clean, true);
  assert.strictEqual(view.slots, 1);
  assert.strictEqual(view.entries, 2);
});

test("the intent and the terminal record share one logical slot", () => {
  const view = namespace.enumerate([
    slot("d", "s", 1, 1, "intent"),
    slot("d", "s", 1, 1, "commit"),
  ]);
  assert.strictEqual(view.slots.size, 1);
});

test("a different attempt is a different slot", () => {
  const view = namespace.enumerate([
    slot("d", "s", 1, 1, "intent"),
    slot("d", "s", 1, 2, "intent"),
  ]);
  assert.strictEqual(view.slots.size, 2);
});

test("a missing intent is a conflict", () => {
  const view = namespace.summarize(namespace.enumerate([
    slot("d", "s", 1, 1, "commit"),
  ]));
  assert.strictEqual(view.clean, false);
  assert.ok(view.conflicts.some((conflict) => conflict.reason === "missing-intent"));
});

test("a missing terminal record is a conflict", () => {
  const view = namespace.summarize(namespace.enumerate([
    slot("d", "s", 1, 1, "intent"),
  ]));
  assert.strictEqual(view.clean, false);
  assert.ok(view.conflicts.some((conflict) => conflict.reason === "missing-terminal"));
});

test("a commit and an abort in the same slot is a conflict", () => {
  const view = namespace.summarize(namespace.enumerate([
    slot("d", "s", 1, 1, "intent"),
    slot("d", "s", 1, 1, "commit"),
    slot("d", "s", 1, 1, "abort"),
  ]));
  assert.strictEqual(view.clean, false);
  assert.ok(view.conflicts.some((conflict) => conflict.reason === "commit-and-abort"));
});

test("a duplicate intent is a conflict", () => {
  const view = namespace.summarize(namespace.enumerate([
    slot("d", "s", 1, 1, "intent"),
    slot("d", "s", 1, 1, "intent"),
    slot("d", "s", 1, 1, "commit"),
  ]));
  assert.strictEqual(view.clean, false);
  assert.ok(view.conflicts.some((conflict) => conflict.reason === "duplicate-intent"));
});

test("records of one slot that disagree on the digest is a conflict", () => {
  const view = namespace.summarize(namespace.enumerate([
    slot("d", "s", 1, 1, "intent", DIGEST_A),
    slot("d", "s", 1, 1, "commit", DIGEST_B),
  ]));
  assert.strictEqual(view.clean, false);
  const conflict = view.conflicts.find((entry) => entry.reason === "digest-mismatch");
  assert.ok(conflict);
  assert.deepStrictEqual(conflict.digests, [DIGEST_A, DIGEST_B]);
});

test("two different stores are separate namespaces", () => {
  const view = namespace.summarize(namespace.enumerate([
    slot("d", "store-1", 1, 1, "intent"),
    slot("d", "store-1", 1, 1, "commit"),
    slot("d", "store-2", 1, 1, "intent"),
    slot("d", "store-2", 1, 1, "commit"),
  ]));
  assert.strictEqual(view.clean, true);
  assert.strictEqual(view.slots, 2);
});

test("two different domains are separate namespaces", () => {
  const view = namespace.summarize(namespace.enumerate([
    slot("domain-1", "s", 1, 1, "intent"),
    slot("domain-1", "s", 1, 1, "commit"),
    slot("domain-2", "s", 1, 1, "intent"),
    slot("domain-2", "s", 1, 1, "commit"),
  ]));
  assert.strictEqual(view.clean, true);
  assert.strictEqual(view.slots, 2);
});

test("a domain filter selects only that domain", () => {
  const view = namespace.enumerate([
    slot("domain-1", "s", 1, 1, "intent"),
    slot("domain-2", "s", 1, 1, "intent"),
  ], { domain: "domain-2" });
  assert.strictEqual(view.records.length, 1);
  assert.strictEqual(view.slots.size, 1);
});

test("the next attempt is one above the highest attempt of the sequence", () => {
  const view = namespace.enumerate([
    slot("d", "s", 1, 1, "intent"),
    slot("d", "s", 1, 3, "intent"),
  ]);
  assert.strictEqual(namespace.nextAttemptFor(view, "d", "s", 1), 4);
});

test("the next attempt of an unused sequence is one", () => {
  const view = namespace.enumerate([]);
  assert.strictEqual(namespace.nextAttemptFor(view, "d", "s", 9), 1);
});

test("the next attempt does not count another store", () => {
  const view = namespace.enumerate([
    slot("d", "store-2", 1, 5, "intent"),
  ]);
  assert.strictEqual(namespace.nextAttemptFor(view, "d", "store-1", 1), 1);
});

test("an unknown record type is refused", () => {
  assert.throws(
    () => namespace.enumerate([entry({ type: "pending" })]),
    (error) => error.code === "ERR_ENTRY_NAMESPACE_INPUT",
  );
});

test("a bad digest is refused", () => {
  assert.throws(
    () => namespace.enumerate([entry({ body_digest: "short" })]),
    (error) => error.code === "ERR_ENTRY_NAMESPACE_INPUT",
  );
});

test("a non-array entry list is refused", () => {
  assert.throws(
    () => namespace.enumerate({}),
    (error) => error.code === "ERR_ENTRY_NAMESPACE_INPUT",
  );
});

test("every conflict is reported, not only the first", () => {
  const view = namespace.summarize(namespace.enumerate([
    slot("d", "s", 1, 1, "commit"),
    slot("d", "s", 2, 1, "intent"),
  ]));
  assert.strictEqual(view.conflicts.length, 2);
});

test("new attempts cannot hide corruption in earlier attempts", () => {
  for (const [extra, reason] of [
    [[slot("d", "s", 1, 1, "commit"), slot("d", "s", 1, 1, "abort")], "commit-and-abort"],
    [[slot("d", "s", 1, 1, "commit", DIGEST_B)], "digest-mismatch"],
    [[slot("d", "s", 1, 1, "intent")], "duplicate-intent"],
  ]) {
    const view = namespace.enumerate([
      slot("d", "s", 1, 1, "intent"), ...extra,
      slot("d", "s", 1, 2, "intent"), slot("d", "s", 1, 2, "commit"),
    ]);
    assert.ok(namespace.partitionConflicts(view).corrupt.some(conflict => conflict.reason === reason));
  }
});

test("a superseded unterminated attempt is not corrupt or an active crash window", () => {
  const view = namespace.enumerate([
    slot("d", "s", 1, 1, "intent"),
    slot("d", "s", 1, 2, "intent"), slot("d", "s", 1, 2, "commit"),
  ]);
  assert.deepStrictEqual(namespace.partitionConflicts(view), { corrupt: [], unterminated: [] });
});
