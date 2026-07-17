"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const WORKFLOWS = ["approve", "worktree", "release", "mission", "arch-design", "briefing"];
const VARIANTS = {
  canonical: path.join(ROOT, ".agent", "workflows"),
  zh: path.join(ROOT, "templates", "zh", ".agent", "workflows"),
  en: path.join(ROOT, "templates", "en", ".agent", "workflows"),
};

function read(variant, workflow) {
  return fs.readFileSync(path.join(VARIANTS[variant], `${workflow}.md`), "utf8");
}

function requireMarkers(variant, workflow, markers) {
  const source = read(variant, workflow);
  for (const marker of markers) {
    assert.match(source, marker, `${variant}/${workflow}.md is missing ${marker}`);
  }
}

test("canonical and Chinese workflow templates remain aligned", () => {
  for (const workflow of WORKFLOWS) {
    assert.equal(read("zh", workflow), read("canonical", workflow), `${workflow}.md drifted`);
  }
});

test("approval keeps Proposal and Decision modes separate", () => {
  for (const variant of Object.keys(VARIANTS)) {
    requireMarkers(variant, "approve", [
      /Proposal|提案/,
      /Decision/,
      /query decisions/,
      /decisions resolve/,
      /--gate user/,
      /gate\.action/,
      /gate\.resource_ref/,
      /must not call `waitpoints release`|不得调用 `waitpoints release`/,
    ]);
  }
});

test("architecture approval binds action and revision digest", () => {
  for (const variant of Object.keys(VARIANTS)) {
    requireMarkers(variant, "arch-design", [
      /type=architecture|`type=architecture`/,
      /action=architecture|`action=architecture`/,
      /revision-digest/,
      /decisions request/,
      /waitpoints create/,
      /waitpoints release/,
      /--owner-workflow \/arch-design/,
    ]);
  }
});

test("release candidate exists and is validated before approval", () => {
  for (const variant of Object.keys(VARIANTS)) {
    requireMarkers(variant, "release", [
      /candidate_digest/,
      /candidate-digest/,
      /decisions request/,
      /--action release/,
      /--owner-workflow \/release/,
      /waitpoints release/,
      /external_side_effect/,
      /candidate must exist and pass validation before|候选必须先在工作区真实形成并完成验证/,
    ]);
  }
});

test("worktree merge freezes strategy and exact resource ownership", () => {
  for (const variant of Object.keys(VARIANTS)) {
    requireMarkers(variant, "worktree", [
      /fast-forward/,
      /squash/,
      /local-merge/,
      /pr-handoff/,
      /#strategy:<integration-strategy>#digest:<resource-digest>/,
      /--action merge/,
      /--owner-workflow \/worktree/,
      /waitpoints release/,
      /single-task|单任务/,
    ]);
  }
});

test("mission exposes HUMAN_DECISION without taking Task gate ownership", () => {
  for (const variant of Object.keys(VARIANTS)) {
    requireMarkers(variant, "mission", [
      /HUMAN_DECISION/,
      /resource-digest/,
      /decisions request/,
      /waitpoints create/,
      /--owner-workflow \/mission/,
      /waitpoints release/,
      /does not transfer Task gate ownership|不转移 Task gate ownership|不转移 Task gate 所有权/,
    ]);
  }
});

test("briefing is a read-only communication surface", () => {
  for (const variant of Object.keys(VARIANTS)) {
    requireMarkers(variant, "briefing", [
      /query decisions/,
      /query waitpoints/,
      /query inbox/,
      /read-only|只读/,
      /must never resolve a Decision|不得解析 Decision/,
      /release a Waitpoint|释放 Waitpoint/,
    ]);
  }
});

test("templates report future Checkpoint routing without invoking an unapproved workflow", () => {
  for (const variant of Object.keys(VARIANTS)) {
    for (const workflow of WORKFLOWS) {
      assert.doesNotMatch(read(variant, workflow), /\/checkpoint-merge\b/);
    }
    for (const workflow of ["worktree", "mission", "arch-design"]) {
      requireMarkers(variant, workflow, [/Checkpoint/, /pending approval|待批准/]);
    }
  }
});

test("protected mutation command signatures are consistent", () => {
  const signatures = {
    approve: ["query decisions", "decisions resolve", "--gate user"],
    worktree: ["decisions request", "waitpoints create", "waitpoints release", "--gate owner"],
    release: ["decisions request", "waitpoints create", "waitpoints release", "--gate owner"],
    mission: ["decisions request", "waitpoints create", "waitpoints release", "--gate owner"],
    "arch-design": ["decisions request", "waitpoints create", "waitpoints release", "--gate owner"],
    briefing: ["query decisions", "query waitpoints", "query inbox"],
  };

  for (const [workflow, commands] of Object.entries(signatures)) {
    for (const variant of Object.keys(VARIANTS)) {
      const source = read(variant, workflow);
      for (const command of commands) {
        assert.ok(source.includes(command), `${variant}/${workflow}.md is missing command: ${command}`);
      }
    }
  }
});
