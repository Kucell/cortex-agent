#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const contracts = [
  {
    locale: "zh",
    modelHeading: "## 三层模型",
    decisionHeading: "## 决策流程",
    layerMarkers: [
      "| L1 | 通用分发层 |",
      "| L2 | 项目实例层 |",
      "| L3 | 能力提供方自维护层 |",
    ],
    decisionMarkers: [
      "识别能力边界",
      "排除临时工件",
      "检查通用分发价值",
      "检查项目实例依赖",
      "检查提供方自维护属性",
      "记录与验证",
    ],
    distributionMarkers: [
      "进入项目模板",
      "不向其他项目分发",
      "排除在普通项目模板之外",
      "不属于 L1/L2/L3 能力层级",
    ],
    forbiddenL3Markers: ["| L3 | 任务层 |", "归为 L3，即使它暂时位于项目目录中"],
  },
  {
    locale: "en",
    modelHeading: "## Three-Layer Model",
    decisionHeading: "## Decision Process",
    layerMarkers: [
      "| L1 | General Distribution |",
      "| L2 | Project Instance |",
      "| L3 | Capability-Provider Self-Maintenance |",
    ],
    decisionMarkers: [
      "Identify the capability boundary",
      "Exclude temporary artifacts",
      "Check general distribution value",
      "Check project-instance dependencies",
      "Check provider self-maintenance",
      "Record and verify",
    ],
    distributionMarkers: [
      "Included in project templates",
      "do not distribute it to other projects",
      "exclude it from ordinary project templates",
      "not L1, L2, or L3 capability layers",
    ],
    forbiddenL3Markers: ["| L3 | Task |", "classify it as L3 even when"],
  },
];

for (const contract of contracts) {
  const agentRoot = path.join(root, "templates", contract.locale, ".agent");
  const rulePath = path.join(agentRoot, "rules", "agent-scope.md");
  const workflowPath = path.join(agentRoot, "workflows", "agent-update.md");

  assert(fs.existsSync(rulePath), `${contract.locale}: rules/agent-scope.md must exist`);

  const rule = fs.readFileSync(rulePath, "utf8");
  assert(rule.includes(contract.modelHeading), `${contract.locale}: missing three-layer model`);
  assert(rule.includes(contract.decisionHeading), `${contract.locale}: missing decision process`);
  for (const marker of [
    ...contract.layerMarkers,
    ...contract.decisionMarkers,
    ...contract.distributionMarkers,
  ]) {
    assert(rule.includes(marker), `${contract.locale}: missing ${JSON.stringify(marker)}`);
  }
  for (const marker of contract.forbiddenL3Markers) {
    assert(!rule.includes(marker), `${contract.locale}: L3 must not be defined as task scope (${marker})`);
  }

  const workflow = fs.readFileSync(workflowPath, "utf8");
  const reference = workflow.match(/`(rules\/agent-scope\.md)`/);
  assert(reference, `${contract.locale}: /agent-update must reference rules/agent-scope.md`);

  const resolvedReference = path.resolve(agentRoot, reference[1]);
  assert.strictEqual(resolvedReference, rulePath, `${contract.locale}: reference resolves to an unexpected path`);
  assert(fs.existsSync(resolvedReference), `${contract.locale}: /agent-update reference must resolve`);
}

const zhLayers = contracts[0].layerMarkers.map((marker) => marker.match(/L[123]/)[0]);
const enLayers = contracts[1].layerMarkers.map((marker) => marker.match(/L[123]/)[0]);
assert.deepStrictEqual(zhLayers, enLayers, "Chinese and English templates must define the same layers");
assert.strictEqual(
  contracts[0].decisionMarkers.length,
  contracts[1].decisionMarkers.length,
  "Chinese and English templates must define aligned decision steps",
);
assert.strictEqual(
  contracts[0].distributionMarkers.length,
  contracts[1].distributionMarkers.length,
  "Chinese and English templates must define aligned distribution boundaries",
);

console.log("agent scope template contract: ok");
