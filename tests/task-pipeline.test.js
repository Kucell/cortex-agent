#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const stages = ["draft", "spec", "plan", "implement", "validate", "review", "done"];
const artifactKinds = [
  "spec",
  "architecture",
  "plan",
  "implementation",
  "validation",
  "review",
  "decision",
  "learning",
  "handoff",
  "release-note",
  "published-doc",
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function assertIncludes(relativePath, markers) {
  const content = read(relativePath);
  for (const marker of markers) {
    assert(content.includes(marker), `${relativePath} is missing ${JSON.stringify(marker)}`);
  }
}

const taskSchema = readJson(".agent/tasks/task.schema.json");
const indexSchema = readJson(".agent/tasks/index.schema.json");
const index = readJson(".agent/tasks/index.json");

assert.deepStrictEqual(taskSchema.$defs.stage.enum, stages);
assert.deepStrictEqual(taskSchema.properties.stage.enum, stages);
assert.deepStrictEqual(taskSchema.$defs.artifactKind.enum, artifactKinds);
assert.deepStrictEqual(indexSchema.properties.tasks.items.properties.stage.enum, stages);
assert.deepStrictEqual(index, { tasks: [] });

for (const locale of ["zh", "en"]) {
  assert.deepStrictEqual(readJson(`templates/${locale}/.agent/tasks/task.schema.json`), taskSchema);
  assert.deepStrictEqual(readJson(`templates/${locale}/.agent/tasks/index.schema.json`), indexSchema);
  assert.deepStrictEqual(readJson(`templates/${locale}/.agent/tasks/index.json`), index);

  assertIncludes(`templates/${locale}/.agent/tasks/README.md`, [
    "draft -> spec -> plan -> implement -> validate -> review -> done",
    "payload.artifact_kind",
    "published-doc",
    "Management API",
  ]);
}

const workflowMarkers = {
  "plan.md": [".agent/tasks/<task-id>.json", "draft -> spec", "spec -> plan", "payload.artifact_kind"],
  "arch-design.md": [".agent/tasks/<task-id>.json", "kind: architecture", "draft -> spec", "spec -> plan"],
  "ship.md": [".agent/tasks/<task-id>.json", "plan -> implement", "implement -> validate", "validate -> review", "review -> done"],
  "publish-docs.md": [".agent/tasks/<task-id>.json", "published-doc", "evidence_refs", "Management API"],
};

for (const [workflow, markers] of Object.entries(workflowMarkers)) {
  assertIncludes(`.agent/workflows/${workflow}`, markers);
  assertIncludes(`templates/zh/.agent/workflows/${workflow}`, markers);
  assertIncludes(`templates/en/.agent/workflows/${workflow}`, markers);
}

assert.strictEqual(read(".agent/tasks/README.md"), read("templates/en/.agent/tasks/README.md"));

console.log("task pipeline contract: ok");
