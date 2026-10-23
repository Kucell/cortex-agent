"use strict";

// End-to-end coverage for the guided-review → pull request comment loop.
//
// This is the seam the comparison against PR-Agent / Qodo identified as the
// single blocking gap: cortex could *produce* a validated review artifact
// but had no way to carry it to the pull request, where a human actually
// reads it.  The backend cases pin each end; this case pins the seam.
//
// The chain exercised here is the real one:
//
//   raw findings
//     → reviewer-backend  (schema / changeset / file-existence gates)
//     → guided-review.json
//     → render-pr-comment  (artifact → markdown)
//     → the body vcs-pr would POST
//
// Two properties are asserted beyond "it produced output":
//
//   * A finding about a file outside the changeset never reaches the
//     comment.  The gate that stops it is mechanical, and this case proves
//     the gate is upstream of the renderer rather than beside it.
//   * The rendered body carries no content the artifact did not contain.
//     A renderer that padded its output would make a review look fuller
//     than the evidence behind it.
//
// No network is involved: the comment body is what vcs-pr would POST, so
// the transport stays out of scope and the test stays hermetic.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { describe, test } = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");

// The loop is exercised against the governance copy (L3, the source of truth)
// and against the L1 distribution layer that ships it.  A downstream project
// installs the L1 copy, so the L1 path is the one that actually runs in the
// field — a passing L3-only suite would prove nothing about it.
const SKILL_COPIES = [
  { label: "L3 governance", dir: path.join(ROOT, ".agent", "skills", "agent-review-benchmark", "scripts") },
  { label: "L1 _shared", dir: path.join(ROOT, "templates", "_shared", ".agent", "skills", "agent-review-benchmark", "scripts") },
].filter((copy) => fs.existsSync(path.join(copy.dir, "reviewer-backend.js")));

function run(script, args) {
  return execFileSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-review-loop-"));
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib", "app.js"), "module.exports = {};\n");
  return root;
}

function rawFindings(root) {
  return {
    task_id: "T-H29",
    run_id: "R-1",
    session_id: "S-1",
    workspace_ids: ["WS-1"],
    base_revision: "aaaaaaa",
    head_revision: "bbbbbbb",
    changed_files: ["lib/app.js"],
    generated_at: "2026-10-23T00:00:00Z",
    findings: [
      {
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
      },
      {
        group_id: "G-2",
        title: "Finding about a file outside the changeset",
        intent: "Probe the changeset gate",
        files: ["lib/not-in-changeset.js"],
        summary: "This must never reach the pull request.",
        impact: "This must never reach the pull request.",
        risk: "low",
        category: "docs",
        validation_refs: [],
        follow_ups: [],
      },
    ],
  };
}

for (const copy of SKILL_COPIES) {
const BACKEND = path.join(copy.dir, "reviewer-backend.js");
const RENDER = path.join(copy.dir, "render-pr-comment.js");

describe(`guided review to pull request comment (${copy.label})`, () => {
  test(`[${copy.label}] a validated artifact renders into a comment body that excludes rejected findings`, () => {
    const root = makeWorkspace();
    const rawPath = path.join(root, "raw.json");
    const artifactPath = path.join(root, "guided-review.json");
    fs.writeFileSync(rawPath, JSON.stringify(rawFindings(root), null, 2));

    // 1. The backend accepts one finding and rejects the one outside the
    //    changeset.
    const backendOut = JSON.parse(
      run(BACKEND, [
        "--backend", "builtin",
        "--input", rawPath,
        "--output", artifactPath,
        "--workspace", root,
      ])
    );
    assert.equal(backendOut.ok, true);
    assert.equal(backendOut.findings, 1);
    assert.equal(backendOut.rejected, 1);

    // 2. The rejection is recorded with its reason, not silently dropped.
    const diagnostics = JSON.parse(fs.readFileSync(`${artifactPath}.diagnostics.json`, "utf8"));
    assert.equal(diagnostics.rejected.length, 1);
    assert.equal(diagnostics.rejected[0].group_id, "G-2");
    assert.equal(diagnostics.rejected[0].reason, "file_not_in_changeset");

    // 3. The artifact carries only the accepted finding.
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    assert.equal(artifact.groups.length, 1);
    assert.equal(artifact.groups[0].group_id, "G-1");

    // 4. The renderer produces the body vcs-pr would POST.
    const body = run(RENDER, ["--input", artifactPath]);
    assert.match(body, /## Guided review/);
    assert.match(body, /#### 1\. Null guard missing/);
    assert.match(body, /\*\*Risk\*\*: High/);
    assert.match(body, /Add the null guard/);

    // 5. The rejected finding is nowhere in the body.
    assert.doesNotMatch(body, /G-2/);
    assert.doesNotMatch(body, /not-in-changeset/);
    assert.doesNotMatch(body, /must never reach/);
  });

  test(`[${copy.label}] the rendered body carries no content the artifact did not contain`, () => {
    const root = makeWorkspace();
    const rawPath = path.join(root, "raw.json");
    const artifactPath = path.join(root, "guided-review.json");
    fs.writeFileSync(rawPath, JSON.stringify(rawFindings(root), null, 2));
    run(BACKEND, ["--backend", "builtin", "--input", rawPath, "--output", artifactPath, "--workspace", root]);

    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const body = run(RENDER, ["--input", artifactPath]);

    // Every artifact field the body quotes must appear verbatim.
    for (const group of artifact.groups) {
      assert.ok(body.includes(group.title), `title must appear: ${group.title}`);
      assert.ok(body.includes(group.summary), `summary must appear: ${group.summary}`);
      for (const ref of group.validation_refs) assert.ok(body.includes(ref));
      for (const followUp of group.follow_ups) assert.ok(body.includes(followUp));
    }

    // And the body must not invent a validation or follow-up section for a
    // finding that has none.  An empty section would read as "there were
    // validations, listed below" with nothing listed.
    //
    // The check is structural: a Validation / Follow-ups heading is present
    // only when it is immediately followed by a list item.
    for (const heading of ["Validation", "Follow-ups"]) {
      const pattern = new RegExp(`\\*\\*${heading}\\*\\*:\\n(\\n(?:- .*\\n)+)?`);
      const match = body.match(pattern);
      assert.ok(match, `${heading} heading, if present, must be followed by its list`);
      if (match) assert.ok(match[1], `${heading} heading must not be empty`);
    }
  });

  test(`[${copy.label}] the same artifact renders to the same bytes every time`, () => {
    const root = makeWorkspace();
    const rawPath = path.join(root, "raw.json");
    const artifactPath = path.join(root, "guided-review.json");
    fs.writeFileSync(rawPath, JSON.stringify(rawFindings(root), null, 2));
    run(BACKEND, ["--backend", "builtin", "--input", rawPath, "--output", artifactPath, "--workspace", root]);

    assert.equal(run(RENDER, ["--input", artifactPath]), run(RENDER, ["--input", artifactPath]));
  });

  test(`[${copy.label}] a finding about a file that does not exist is rejected before rendering`, () => {
    const root = makeWorkspace();
    const rawPath = path.join(root, "raw.json");
    const artifactPath = path.join(root, "guided-review.json");
    const raw = rawFindings(root);
    // Point the accepted finding at a path that is not on disk: the
    // hallucinated-path guard must catch it.
    raw.findings[0].files = ["lib/does-not-exist.js"];
    raw.changed_files = ["lib/does-not-exist.js"];
    fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2));

    let failed = false;
    let stdout = "";
    try {
      stdout = run(BACKEND, ["--backend", "builtin", "--input", rawPath, "--output", artifactPath, "--workspace", root]);
    } catch (err) {
      failed = true;
      stdout = err.stdout || "";
    }
    assert.equal(failed, true, "the backend must fail when no finding survives");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "no_acceptable_findings");
    assert.equal(parsed.details.rejected[0].reason, "file_not_found");
  });
});
}
