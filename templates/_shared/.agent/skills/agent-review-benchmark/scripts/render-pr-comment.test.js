"use strict";

// Regression coverage for the guided-review → pull request comment renderer.
//
// The renderer is the piece that carries a validated review artifact to the
// place a human reads.  Its contract is narrow on purpose:
//
//   * It never invents content.  Every emitted line comes from an artifact
//     field.  A finding without follow-ups contributes no follow-up section
//     — a placeholder there would read like content that was never found.
//   * It never drops a finding.  An unrecognized risk label still renders;
//     hiding it would hide a real finding behind a label typo.
//   * It is deterministic.  The same artifact renders to the same bytes, so
//     a re-render can be diffed against the previous one.
//
// These cases exercise the pure function directly — no filesystem, no
// network, no workspace — which is what makes the "invents nothing" claim
// checkable in the first place.

const assert = require("node:assert/strict");
const test = require("node:test");
const { groupByRisk, oneLine, renderComment } = require("./render-pr-comment.js");

function finding(overrides) {
  return {
    group_id: "G-1",
    title: "Null guard missing",
    intent: "Guard the lookup result before use",
    files: ["lib/app.js"],
    summary: "The lookup result is dereferenced without a null check.",
    impact: "A missing key crashes the request handler.",
    risk: "high",
    category: "quality",
    validation_refs: ["tests/app.test.js::handles missing key"],
    follow_ups: ["Add the null guard"],
    ...overrides,
  };
}

function artifact(overrides) {
  return {
    type: "guided_review",
    artifact_id: "GR-abcdef123456",
    task_id: "T-1",
    run_id: "R-1",
    session_id: "S-1",
    workspace_ids: ["WS-1"],
    base_revision: "aaaaaaa",
    head_revision: "bbbbbbb",
    groups: [finding()],
    summary: {
      group_count: 1,
      file_count: 1,
      risk_counts: { low: 0, medium: 0, high: 1, critical: 0 },
      validation_ref_count: 1,
      follow_up_count: 1,
    },
    generated_at: "2026-10-23T00:00:00Z",
    ...overrides,
  };
}

test("renders every artifact field into the comment body", () => {
  const body = renderComment(artifact());
  assert.match(body, /## Guided review/);
  assert.match(body, /#### 1\. Null guard missing/);
  assert.match(body, /\*\*Risk\*\*: High/);
  assert.match(body, /\*\*Category\*\*: quality/);
  assert.match(body, /`lib\/app\.js`/);
  assert.match(body, /The lookup result is dereferenced without a null check\./);
  assert.match(body, /\*\*Intent\*\*: Guard the lookup result before use/);
  assert.match(body, /\*\*Impact\*\*: A missing key crashes the request handler\./);
  assert.match(body, /tests\/app\.test\.js::handles missing key/);
  assert.match(body, /Add the null guard/);
  assert.match(body, /GR-abcdef123456/);
});

test("omits sections the artifact does not carry instead of emitting placeholders", () => {
  const body = renderComment(
    artifact({
      groups: [
        finding({ validation_refs: [], follow_ups: [], impact: "", intent: "" }),
      ],
    })
  );
  assert.doesNotMatch(body, /\*\*Validation\*\*/);
  assert.doesNotMatch(body, /\*\*Follow-ups\*\*/);
  assert.doesNotMatch(body, /\*\*Impact\*\*/);
  assert.doesNotMatch(body, /\*\*Intent\*\*/);
  // The finding itself is still present.
  assert.match(body, /Null guard missing/);
});

test("groups findings by risk, severe first, and numbers them across groups", () => {
  const body = renderComment(
    artifact({
      groups: [
        finding({ group_id: "G-1", title: "Low risk item", risk: "low" }),
        finding({ group_id: "G-2", title: "Critical risk item", risk: "critical" }),
        finding({ group_id: "G-3", title: "Medium risk item", risk: "medium" }),
      ],
    })
  );

  const criticalAt = body.indexOf("Critical risk item");
  const mediumAt = body.indexOf("Medium risk item");
  const lowAt = body.indexOf("Low risk item");
  assert.ok(criticalAt < mediumAt, "critical must precede medium");
  assert.ok(mediumAt < lowAt, "medium must precede low");

  assert.match(body, /### Critical risk/);
  assert.match(body, /### Medium risk/);
  assert.match(body, /### Low risk/);

  // Numbering runs across the whole comment, not per risk bucket.
  assert.match(body, /#### 1\. Critical risk item/);
  assert.match(body, /#### 2\. Medium risk item/);
  assert.match(body, /#### 3\. Low risk item/);
});

test("an unrecognized risk label still renders the finding", () => {
  const body = renderComment(
    artifact({ groups: [finding({ risk: "catastrophic", title: "Odd risk item" })] })
  );
  assert.match(body, /Odd risk item/);
  assert.match(body, /\*\*Risk\*\*: Unknown/);
});

test("a newline inside a title cannot break the markdown structure", () => {
  const body = renderComment(
    artifact({ groups: [finding({ title: "First line\n### Injected heading" })] })
  );
  assert.match(body, /#### 1\. First line ### Injected heading/);
  // The injected text must not become its own heading.
  assert.doesNotMatch(body, /\n### Injected heading/);
});

test("an empty artifact is rejected rather than rendered as an empty comment", () => {
  assert.throws(
    () => renderComment(artifact({ groups: [] })),
    (error) => error.error === "no_findings_to_render"
  );
});

test("rendering is deterministic", () => {
  const input = artifact();
  assert.equal(renderComment(input), renderComment(input));
});

test("groupByRisk keeps every finding exactly once", () => {
  const groups = [
    finding({ group_id: "G-1", risk: "low" }),
    finding({ group_id: "G-2", risk: "low" }),
    finding({ group_id: "G-3", risk: "high" }),
  ];
  const buckets = groupByRisk(groups);
  const total = buckets.reduce((sum, bucket) => sum + bucket.groups.length, 0);
  assert.equal(total, groups.length);
  assert.equal(buckets.length, 2);
});

test("oneLine collapses newlines and trims", () => {
  assert.equal(oneLine("  a\n\nb  "), "a b");
  assert.equal(oneLine(null), "");
});
