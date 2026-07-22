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

function assertTransitionOwner(relativePath, transition, owner) {
  const rows = read(relativePath)
    .split("\n")
    .filter((line) => line.startsWith(`| \`${transition}\` |`));

  assert.strictEqual(rows.length, 1, `${relativePath} must define exactly one ${transition} transition row`);
  const cells = rows[0].split("|").map((cell) => cell.trim());
  assert.strictEqual(cells[2], `\`${owner}\``, `${relativePath} assigns ${transition} to ${cells[2]}`);
}

function assertPublishDocsDoesNotMutateCompletionGate(relativePath, contract) {
  const content = read(relativePath);
  const artifactSectionStart = content.indexOf("payload.artifact_kind: published-doc");
  assert.notStrictEqual(artifactSectionStart, -1, `${relativePath} is missing its published artifact section`);
  const nextSectionStart = content.indexOf("\n## ", artifactSectionStart);
  const artifactSection = content.slice(
    artifactSectionStart,
    nextSectionStart === -1 ? content.length : nextSectionStart,
  );

  for (const marker of contract.returnMarkers) {
    assert(
      artifactSection.includes(marker),
      `${relativePath} must explicitly return the final published-doc ref to /ship (${marker})`,
    );
  }
  for (const marker of contract.noMutationMarkers) {
    assert(
      artifactSection.includes(marker),
      `${relativePath} must explicitly prohibit completion-gate mutation (${marker})`,
    );
  }

  const positiveMutation = contract.positiveMutation;
  const explicitNegation = contract.explicitNegation;
  for (const [index, line] of artifactSection.split("\n").entries()) {
    if (!line.includes("evidence_refs") && !line.includes("gate `status`")) continue;
    if (!positiveMutation.test(line)) continue;
    assert(
      explicitNegation.test(line),
      `${relativePath}:${index + 1} grants /publish-docs completion-gate write access: ${line.trim()}`,
    );
  }
}

function assertShipDoesNotOwnPlanTransition(relativePath, contract) {
  for (const [index, line] of read(relativePath).split("\n").entries()) {
    if (!line.includes("plan -> implement") || !line.includes("/ship")) continue;
    if (!contract.shipPositiveMutation.test(line)) continue;
    assert(
      contract.shipExplicitNegation.test(line),
      `${relativePath}:${index + 1} grants /ship plan -> implement write access: ${line.trim()}`,
    );
  }
}

const pipelineContracts = [
  {
    name: "source",
    readme: ".agent/tasks/README.md",
    startTask: ".agent/workflows/start-task.md",
    ship: ".agent/workflows/ship.md",
    publishDocs: ".agent/workflows/publish-docs.md",
    readmeOwnerMarker:
      "`/start-task` is the only workflow that may pass or block `plan -> implement`; it must do so before implementation edits begin.",
    startOwnerMarker:
      "`/start-task` 是唯一可以写入 `plan -> implement` gate 的工作流。开始任何实现编辑前必须：",
    shipNoOwnerMarker:
      "`/ship` 必须从 stage `implement` 开始，不得写入 `plan -> implement`；该 gate 由 `/start-task` 独占。",
    implementationEnvelopeMarker: "真实存在的 Artifact Bus envelope 或 execution report 文件",
    implementationRefMarker:
      "任务的 final `implementation.ref` 只引用该文件。",
    implementationPayloadMarker: "在 payload 中记录 commit、diff 摘要和变更路径",
    conditionalArtifactMarker:
      "条件不适用时，在 gate `reason` 记录判断并引用 final `decision` 证据，不 waiver 整个 gate",
    conditionalKindsMarker: "`release-note` / `published-doc`",
    shipPositiveMutation: /`\/ship`.*(写入|改写|修改|通过|阻断|推进).*(plan -> implement)|(plan -> implement).*(由 `\/ship`|`\/ship`.*(写入|改写|修改|通过|阻断|推进))/,
    shipExplicitNegation: /(不|不得|不能|禁止).*(写入|改写|修改|通过|阻断|推进)|由 `\/start-task` 独占/,
    returnMarkers: ["只向调用方返回 final `published-doc` ref", "`/ship` 接收返回结果"],
    noMutationMarkers: [
      "不得修改 `.agent/tasks/<task-id>.json`",
      "gate `evidence_refs`",
      "gate status",
      "task stage",
    ],
    positiveMutation: /(加入|写入|更新|回填|修改|标为|保持).*(evidence_refs|gate `status`)|(evidence_refs|gate `status`).*(加入|写入|更新|回填|修改|标为|保持)/,
    explicitNegation: /(不|不得|不能|禁止)(独立)?(加入|写入|更新|回填|修改|标为|保持)?/,
  },
  {
    name: "zh template",
    readme: "templates/zh/.agent/tasks/README.md",
    startTask: "templates/zh/.agent/workflows/start-task.md",
    ship: "templates/zh/.agent/workflows/ship.md",
    publishDocs: "templates/zh/.agent/workflows/publish-docs.md",
    readmeOwnerMarker:
      "`/start-task` 是唯一可以通过或阻断 `plan -> implement` 的工作流，且必须在开始实现编辑前执行。",
    startOwnerMarker:
      "`/start-task` 是唯一可以写入 `plan -> implement` gate 的工作流。开始任何实现编辑前必须：",
    shipNoOwnerMarker:
      "`/ship` 必须从 stage `implement` 开始，不得写入 `plan -> implement`；该 gate 由 `/start-task` 独占。",
    implementationEnvelopeMarker: "真实存在的 Artifact Bus envelope 或 execution report 文件",
    implementationRefMarker:
      "任务的 final `implementation.ref` 只引用该文件。",
    implementationPayloadMarker: "在 payload 中记录 commit、diff 摘要和变更路径",
    conditionalArtifactMarker:
      "条件不适用时，在 gate `reason` 记录判断并引用 final `decision` 证据，不 waiver 整个 gate",
    conditionalKindsMarker: "`release-note` / `published-doc`",
    shipPositiveMutation: /`\/ship`.*(写入|改写|修改|通过|阻断|推进).*(plan -> implement)|(plan -> implement).*(由 `\/ship`|`\/ship`.*(写入|改写|修改|通过|阻断|推进))/,
    shipExplicitNegation: /(不|不得|不能|禁止).*(写入|改写|修改|通过|阻断|推进)|由 `\/start-task` 独占/,
    returnMarkers: ["只向调用方返回 final `published-doc` ref", "`/ship` 接收返回结果"],
    noMutationMarkers: [
      "不得修改 `.agent/tasks/<task-id>.json`",
      "gate `evidence_refs`",
      "gate status",
      "task stage",
    ],
    positiveMutation: /(加入|写入|更新|回填|修改|标为|保持).*(evidence_refs|gate `status`)|(evidence_refs|gate `status`).*(加入|写入|更新|回填|修改|标为|保持)/,
    explicitNegation: /(不|不得|不能|禁止)(独立)?(加入|写入|更新|回填|修改|标为|保持)?/,
  },
  {
    name: "en template",
    readme: "templates/en/.agent/tasks/README.md",
    startTask: "templates/en/.agent/workflows/start-task.md",
    ship: "templates/en/.agent/workflows/ship.md",
    publishDocs: "templates/en/.agent/workflows/publish-docs.md",
    readmeOwnerMarker:
      "`/start-task` is the only workflow that may pass or block `plan -> implement`; it must do so before implementation edits begin.",
    startOwnerMarker:
      "`/start-task` is the only workflow allowed to write the `plan -> implement` gate. Before any implementation edit begins:",
    shipNoOwnerMarker:
      "`/ship` must start at stage `implement` and must not write `plan -> implement`; `/start-task` exclusively owns that gate.",
    implementationEnvelopeMarker: "an existing Artifact Bus envelope or execution-report file",
    implementationRefMarker:
      "The final task `implementation.ref` references only that file.",
    implementationPayloadMarker: "payload records commit IDs, a diff summary, and changed paths",
    conditionalArtifactMarker:
      "When a condition is not applicable, record the decision in gate `reason` and cite final `decision` evidence without waiving the whole gate",
    conditionalKindsMarker: "`release-note` / `published-doc`",
    shipPositiveMutation: /`\/ship`.*(write|rewrite|mutate|pass|block|advance).*(plan -> implement)|(plan -> implement).*(owned by `\/ship`|`\/ship`.*(write|rewrite|mutate|pass|block|advance))/i,
    shipExplicitNegation: /(does not|must not|cannot|never|prohibit).*?(write|rewrite|mutate|pass|block|advance)|neither.*nor.*(write|rewrite|mutate|pass|block|advance)|exclusively owns that gate/i,
    returnMarkers: ["return only its final `published-doc` ref to the caller", "`/ship` consumes the result"],
    noMutationMarkers: [
      "Do not modify `.agent/tasks/<task-id>.json`",
      "gate `evidence_refs`",
      "gate status",
      "task stage",
    ],
    positiveMutation: /(add|write|update|backfill|mutate|mark|keep).*(evidence_refs|gate `status`)|(evidence_refs|gate `status`).*(add|write|update|backfill|mutate|mark|keep)/i,
    explicitNegation: /(does not|must not|cannot|never|prohibit)/i,
  },
];

const taskSchema = readJson(".agent/tasks/task.schema.json");
const indexSchema = readJson(".agent/tasks/index.schema.json");
const index = readJson(".agent/tasks/index.json");

assert.deepStrictEqual(taskSchema.$defs.stage.enum, stages);
assert.deepStrictEqual(taskSchema.properties.stage.enum, stages);
assert.deepStrictEqual(taskSchema.$defs.artifactKind.enum, artifactKinds);
assert.deepStrictEqual(indexSchema.properties.tasks.items.properties.stage.enum, stages);
assert.deepStrictEqual(index, { tasks: [] });

for (const locale of ["zh", "en"]) {
  assertIncludes(`templates/${locale}/.agent/tasks/README.md`, [
    "draft -> spec -> plan -> implement -> validate -> review -> done",
    "payload.artifact_kind",
    "published-doc",
    "Management API",
  ]);
}

assert.deepStrictEqual(readJson("templates/_shared/.agent/tasks/task.schema.json"), taskSchema);
assert.deepStrictEqual(readJson("templates/_shared/.agent/tasks/index.schema.json"), indexSchema);
assert.deepStrictEqual(readJson("templates/_shared/.agent/tasks/index.json"), index);

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

for (const contract of pipelineContracts) {
  assertTransitionOwner(contract.readme, "plan -> implement", "/start-task");
  assertIncludes(contract.readme, [contract.readmeOwnerMarker]);
  assertIncludes(contract.startTask, [contract.startOwnerMarker]);
  assertIncludes(contract.ship, [
    contract.shipNoOwnerMarker,
    contract.implementationEnvelopeMarker,
    contract.implementationRefMarker,
    contract.implementationPayloadMarker,
    contract.conditionalKindsMarker,
    contract.conditionalArtifactMarker,
  ]);
  assertShipDoesNotOwnPlanTransition(contract.ship, contract);
  assertPublishDocsDoesNotMutateCompletionGate(contract.publishDocs, contract);
}

assert.strictEqual(read(".agent/tasks/README.md"), read("templates/en/.agent/tasks/README.md"));

console.log("task pipeline contract: ok");
