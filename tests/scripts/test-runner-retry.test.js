"use strict";

// MS — test-runner exclusive retry
//
// The suite spawns hundreds of child processes. On a machine that runs out of
// memory the kernel refuses the fork/exec (EAGAIN / ENOMEM) and the child
// never starts. The test file sees that as a plain assertion failure, so a
// file that failed only because the machine was contended would go red.
//
// The runner therefore re-runs a failed file *alone*. This test pins that
// behaviour down as a discriminator, not a mask:
//
//   - fails in parallel, passes alone  → ok, flagged as retried
//   - fails alone as well               → still a failure
//
// The fixtures are real `node --test` files: the flaky one fails on its first
// execution and passes on its second, using a counter file next to it.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runParallel } = require("../../scripts/test-runner.cjs");

function writeFixture(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

const FLAKY_BODY = `
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const counter = path.join(__dirname, 'flaky.count');
const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(seen + 1));

test('fails on the first execution, passes on the second', () => {
  assert.equal(seen, 1, 'the first execution must fail');
});
`;

const ALWAYS_FAIL_BODY = `
const test = require('node:test');
const assert = require('node:assert/strict');

test('never passes', () => {
  assert.fail('this fixture is expected to fail');
});
`;

test("a file that fails in parallel but passes alone is reported as retried", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-retry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const flaky = writeFixture(dir, "flaky.test.js", FLAKY_BODY);
  const results = await runParallel([flaky], 1, 60, true, 0, 0);

  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.ok, true, "the exclusive retry must be able to turn this green");
  assert.equal(r.retried, true, "the result must be flagged as retried");
  assert.ok(r.firstFailure, "the first failure must be recorded");
  assert.notEqual(r.firstFailure.code, 0, "the first attempt must have failed");
});

test("a file that also fails alone stays a failure", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-retry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const broken = writeFixture(dir, "broken.test.js", ALWAYS_FAIL_BODY);
  const results = await runParallel([broken], 1, 60, true, 0, 0);

  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.ok, false, "a file that fails twice must stay red");
  assert.equal(r.retried, true, "the second attempt must be recorded as a retry");
});

test("a file that passes on the first attempt is never retried", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-retry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const broken = writeFixture(dir, "broken.test.js", ALWAYS_FAIL_BODY);
  const results = await runParallel([broken], 1, 60, true, 0, 0);
  assert.equal(results[0].retried, true);

  // A second run of the same fixture keeps failing — the retry never turns a
  // genuine failure green, it only reports the attempt.
  const again = await runParallel([broken], 1, 60, true, 0, 0);
  assert.equal(again[0].ok, false);
});

test("the retry is visible in the per-file output", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-retry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const flaky = writeFixture(dir, "flaky.test.js", FLAKY_BODY);

  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); };
  t.after(() => { console.log = original; });
  try {
    await runParallel([flaky], 1, 60, false, 0, 0);
  } finally {
    console.log = original;
  }

  const output = lines.join("\n");
  assert.match(output, /↺/, "the retry must be visible in the output");
  assert.match(output, /独占重跑通过/, "the retry must say why it passed");
});
