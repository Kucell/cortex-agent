"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hasPiSettledSignal } = require("../../lib/governed/pi-settlement");

test("VC-034-002-02: agent_settled signal in stdout JSONL marks settlement", () => {
  const line = JSON.stringify({type:"agent_settled",task:"T-X",session:"S-X"});
  assert.equal(hasPiSettledSignal(line + String.fromCharCode(10)), true);
});

test("VC-034-002-02: empty stdout returns false (no false positive)", () => {
  assert.equal(hasPiSettledSignal(""), false);
});

test("VC-034-002-02: stdout without type=agent_settled returns false", () => {
  assert.equal(hasPiSettledSignal(JSON.stringify({type:"progress"}) + String.fromCharCode(10)), false);
});

test("VC-034-002-04: non-JSONL garbage does not trigger settled (fail-closed)", () => {
  assert.equal(hasPiSettledSignal("not json" + String.fromCharCode(10) + "just text" + String.fromCharCode(10)), false);
});

test("VC-034-002-04: partial JSONL with bad line does not crash, continues scan", () => {
  const stdout = "not json" + String.fromCharCode(10) + JSON.stringify({type:"agent_settled"}) + String.fromCharCode(10);
  assert.equal(hasPiSettledSignal(stdout), true);
});

test("VC-034-002-04: agent_settled embedded in non-JSON garbage returns false (must be parseable JSON)", () => {
  assert.equal(hasPiSettledSignal("type=agent_settled in prose"), false);
});

test("VC-034-002-03: hasPiSettledSignal is pure and side-effect free (10 invocations identical)", () => {
  const stdout = JSON.stringify({type:"agent_settled"}) + String.fromCharCode(10);
  const calls = Array.from({ length: 10 }, function() { return hasPiSettledSignal(stdout); });
  assert.ok(calls.every(function(r) { return r === true; }), "all 10 calls return true");
});
