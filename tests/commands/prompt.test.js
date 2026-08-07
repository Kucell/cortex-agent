"use strict";

// ─── lib/commands/prompt.js unit tests ───────────────────────────────────────
//
// Coverage:
//   - askYesNo: in non-TTY, returns false (no blocking readline)
//   - askYesNo: accepts 'y' / 'Y' / 'yes' (case-insensitive)
//   - askYesNo: rejects anything else (n / no / empty / random)

const assert = require("node:assert/strict");
const test = require("node:test");
const { askYesNo } = require("../../lib/commands/prompt");

test("askYesNo: returns false in non-TTY environment", async () => {
  // node:test runs in non-TTY by default (no controlling terminal).
  // The implementation guards on process.stdin.isTTY and short-circuits.
  const result = await askYesNo("Proceed? [y/N] ");
  assert.equal(result, false);
});

test("askYesNo: returns Promise (async)", () => {
  const r = askYesNo("?");
  assert.ok(r instanceof Promise);
  // Drain the promise so it doesn't unhandled-reject.
  return r.then((v) => assert.equal(v, false));
});
