"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { hasPiSettledSignal } = require("../../lib/governed/pi-settlement");

test("recognizes the Pi agent_settled JSON host signal", () => {
  assert.equal(hasPiSettledSignal('{"type":"agent_start"}\n{"type":"agent_settled"}\n'), true);
});

test("rejects malformed or unrelated output", () => {
  assert.equal(hasPiSettledSignal('{"type":"turn_end"}\nnot-json'), false);
});
