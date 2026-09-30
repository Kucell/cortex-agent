"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildEffect,
  commandNone,
  commandRead,
  commandMutation,
  commandFailure,
  isCommittedMutation,
} = require("../../lib/cli/effect.js");

test("commandNone returns zero-effect envelope", () => {
  const result = commandNone({ help: true });
  assert.equal(result.ok, true);
  assert.equal(result.mutated, false);
  assert.equal(result.help, true);
  assert.equal(result.effect.kind, "none");
  assert.equal(result.effect.committed, false);
  assert.deepEqual(result.effect.paths, []);
});

test("commandRead returns read effect and never committed", () => {
  const result = commandRead({ resources: ["runs"] });
  assert.equal(result.read, true);
  assert.equal(result.effect.kind, "read");
  assert.equal(result.effect.committed, false);
  assert.deepEqual(result.effect.resources, ["runs"]);
});

test("commandMutation normalizes exact paths/resources/domains", () => {
  const result = commandMutation({
    resources: ["waitpoint:WP-1", "waitpoint:WP-1"],
    paths: [".agent/waitpoints/WP-1.json", ".agent/waitpoints/index.json"],
    domains: ["filesystem"],
  });
  assert.equal(result.mutated, true);
  assert.equal(result.effect.kind, "mutation");
  assert.equal(result.effect.committed, true);
  assert.equal(result.effect.exact_paths, true);
  assert.deepEqual(result.effect.resources, ["waitpoint:WP-1"]);
  assert.deepEqual(result.effect.paths, [".agent/waitpoints/WP-1.json", ".agent/waitpoints/index.json"]);
  assert.equal(isCommittedMutation(result), true);
});

test("commandMutation can mark exact paths unavailable", () => {
  const result = commandMutation({ exact_paths: false, paths: [] });
  assert.equal(result.effect.exact_paths, false);
  assert.equal(isCommittedMutation(result), true);
});

test("commandFailure is effect=none and non-mutating", () => {
  const result = commandFailure("INVALID_USAGE");
  assert.equal(result.ok, false);
  assert.equal(result.mutated, false);
  assert.equal(result.code, "INVALID_USAGE");
  assert.equal(result.effect.kind, "none");
  assert.equal(isCommittedMutation(result), false);
});

test("buildEffect rejects unknown domains", () => {
  assert.throws(
    () => buildEffect("mutation", { domains: ["telepathy"] }),
    /Unknown command effect domain/,
  );
});
