"use strict";

// The `State:` reader exists in two repositories: `lib/mission-state.js` in
// the framework repository, and `.agent/missions/scripts/mission-state.js` in
// the governance repository. The two repositories are independent, so the
// rule is vendored — and a vendored rule that nobody compares drifts.
//
// This suite locks the two copies to the same answers. It only runs where the
// governance repository is materialised; a checkout of the framework
// repository alone cannot compare what it does not have.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const OUTER_READER = path.join(ROOT, "lib", "mission-state.js");
const LIVE_READER = path.join(ROOT, ".agent", "missions", "scripts", "mission-state.js");
const LIVE_AVAILABLE = fs.existsSync(LIVE_READER);

const outer = require(OUTER_READER);

// Every declaration form the rule has to answer the same way in both copies.
const FORMS = [
  ["plain", "- State: COMPLETE", "COMPLETE"],
  ["bold", "- **State**: **COMPLETE**", "COMPLETE"],
  ["inline code", "- State: `COMPLETE`", "COMPLETE"],
  ["bold inline code", "- **State**: `COMPLETE`", "COMPLETE"],
  ["prose", "- State: MISSION COMPLETE", "COMPLETE"],
  ["annotated prose", "- State: MISSION COMPLETE + archived", "COMPLETE"],
  ["status key", "- Status: COMPLETE", "COMPLETE"],
  ["full width colon", "- State：COMPLETE", "COMPLETE"],
  ["not complete", "- State: IN_PROGRESS", "IN_PROGRESS"],
  ["planned", "- State: Planned (blocked on MS-004 PASS)", "PLANNED"],
  ["token with digits", "- State: MS_001", "MS_001"],
];

function plan(body) {
  return `# Mission Plan\n\n## Current State\n\n${body}\n`;
}

test("the outer copy answers every declaration form", () => {
  for (const [name, body, expected] of FORMS) {
    assert.equal(outer.readStateToken(plan(body)), expected, `outer copy: ${name}`);
  }
});

test("the outer copy and the governance copy answer identically", {
  skip: LIVE_AVAILABLE ? false : "the governance repository is not part of this checkout",
}, () => {
  const live = require(LIVE_READER);
  for (const [name, body, expected] of FORMS) {
    assert.equal(live.readStateToken(plan(body)), expected, `live copy: ${name}`);
    assert.equal(
      outer.readStateToken(plan(body)),
      live.readStateToken(plan(body)),
      `the two copies disagree on: ${name}`
    );
  }
  for (const state of ["COMPLETE", "COMPLETED", "IN_PROGRESS", null]) {
    assert.equal(outer.isCompleteState(state), live.isCompleteState(state));
  }
});

test("a plan without a Current State section still yields its token", () => {
  const body = "- State: `COMPLETE`";
  assert.equal(outer.readStateToken(body), "COMPLETE");
});
