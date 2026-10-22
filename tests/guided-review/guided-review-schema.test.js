"use strict";

// ─── Guided Review Finding Schema (Harness Phase 9 / P-001) ──────────────────
//
// 这份 schema 之前是**不可满足**的：summary 子对象写了 additionalProperties:false
// 却没有写 properties，于是所有属性都被禁止；而 required 又要求那 5 个字段必须
// 存在。两句话放在一起的结果是：任何文档都过不了校验，包括 skill 自己产出的
// 那一份。也就是说，这份「已发布 schema」从来没有真正约束过任何东西。
//
// 这里用三条证据把它钉死：
//   1. 反向验证——旧定义确实不可满足，新定义可满足；
//   2. 真实历史产物能通过校验（它本来就是按旧定义产出的）；
//   3. finding schema 与 artifact 的 group 定义逐字段一致，防止再次漂移。
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const SKILL = path.join(ROOT, ".agent", "skills", "agent-review-benchmark");
const TEMPLATE_SKILL = path.join(ROOT, "templates", "_shared", ".agent", "skills", "agent-review-benchmark");

const { formatErrors, validate } = require(path.join(SKILL, "scripts", "lib", "json-schema.js"));

const findingSchema = JSON.parse(fs.readFileSync(path.join(SKILL, "references", "guided-review-finding.schema.json"), "utf8"));
const artifactSchema = JSON.parse(fs.readFileSync(path.join(SKILL, "references", "guided-review.schema.json"), "utf8"));

const VALID_FINDING = {
  group_id: "F-001",
  title: "标题",
  intent: "意图",
  files: ["scripts/test-runner.cjs"],
  summary: "摘要",
  impact: "影响",
  risk: "high",
  category: "test",
  validation_refs: [],
  follow_ups: [],
};

test("反向验证：旧的 summary 定义确实不可满足", () => {
  // 旧定义：additionalProperties:false 却没有 properties。
  const legacy = {
    type: "object",
    required: ["group_count", "file_count", "risk_counts", "validation_ref_count", "follow_up_count"],
    additionalProperties: false,
  };
  const summary = {
    group_count: 1,
    file_count: 1,
    risk_counts: { low: 0, medium: 0, high: 1, critical: 0 },
    validation_ref_count: 0,
    follow_up_count: 0,
  };

  const result = validate(legacy, summary);
  assert.equal(result.ok, false, "旧定义必须不可满足，否则这个 bug 从来没存在过");
  assert.ok(
    result.errors.some((entry) => entry.keyword === "additionalProperties"),
    `错误应当来自 additionalProperties，实际：${formatErrors(result.errors).join("; ")}`
  );

  // 新的定义可满足。
  const current = artifactSchema.properties.summary;
  assert.equal(validate(current, summary).ok, true);
});

test("真实历史产物能通过修复后的 schema 校验", () => {
  const artifact = path.join(ROOT, ".agent", "artifacts", "T-AINSDLC-001", "009-ms002-guided-review.json");
  assert.ok(fs.existsSync(artifact), "真实产物应当存在");

  const data = JSON.parse(fs.readFileSync(artifact, "utf8"));
  const result = validate(artifactSchema, data);
  assert.equal(result.ok, true, `真实产物应当通过校验：${formatErrors(result.errors).join("; ")}`);
});

test("finding schema 与 artifact 的 group 定义逐字段一致（防漂移守卫）", () => {
  const groupSchema = artifactSchema.properties.groups.items;
  assert.deepEqual(
    Object.keys(findingSchema.properties).sort(),
    Object.keys(groupSchema.properties).sort(),
    "finding 与 group 的字段集合必须完全一致"
  );
  assert.deepEqual(findingSchema.required.slice().sort(), groupSchema.required.slice().sort());
  assert.deepEqual(findingSchema.properties, groupSchema.properties, "同名字段的约束必须完全一致");
});

test("L3 与 L1 分发副本逐字一致", () => {
  const files = [
    "SKILL.md",
    "scripts/index.js",
    "scripts/reviewer-backend.js",
    "scripts/lib/json-schema.js",
    "references/guided-review.schema.json",
    "references/guided-review-finding.schema.json",
  ];
  for (const relative of files) {
    const left = fs.readFileSync(path.join(SKILL, relative));
    const right = fs.readFileSync(path.join(TEMPLATE_SKILL, relative));
    assert.deepEqual(left, right, `${relative} 的 L3 与 L1 副本必须逐字一致`);
  }
});

test("校验器会拒绝它没有实现的 schema 关键字，而不是默默忽略", () => {
  const result = validate({ type: "object", multipleOf: 2 }, {});
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.keyword === "unsupported_keyword"));
});

test("校验器覆盖 type / required / additionalProperties / enum / pattern / uniqueItems / format", () => {
  const schema = {
    type: "object",
    required: ["name", "risk", "files"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
      risk: { type: "string", enum: ["low", "high"] },
      files: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
      stamp: { type: "string", format: "date-time" },
    },
  };

  assert.equal(validate(schema, { name: "a", risk: "low", files: ["x"] }).ok, true);

  const cases = [
    [{ name: "a", risk: "low" }, "required"],
    [{ name: "a", risk: "low", files: ["x"], extra: 1 }, "additionalProperties"],
    [{ name: "a", risk: "blocker", files: ["x"] }, "enum"],
    [{ name: "", risk: "low", files: ["x"] }, "minLength"],
    [{ name: "a", risk: "low", files: [] }, "minItems"],
    [{ name: "a", risk: "low", files: ["x", "x"] }, "uniqueItems"],
    [{ name: "a", risk: "low", files: ["x"], stamp: "not-a-date" }, "format"],
    [{ name: "a", risk: "low", files: [1] }, "type"],
  ];
  for (const [data, keyword] of cases) {
    const result = validate(schema, data);
    assert.equal(result.ok, false, `${JSON.stringify(data)} 应当被拒绝`);
    assert.ok(
      result.errors.some((entry) => entry.keyword === keyword),
      `期望 ${keyword} 错误，实际：${formatErrors(result.errors).join("; ")}`
    );
  }
});

test("合规 finding 通过校验，缺字段 / 越界字段 / 未知风险值被拒", () => {
  assert.equal(validate(findingSchema, VALID_FINDING).ok, true);

  const missingIntent = { ...VALID_FINDING };
  delete missingIntent.intent;
  assert.equal(validate(findingSchema, missingIntent).ok, false);

  const unknownRisk = { ...VALID_FINDING, risk: "blocker" };
  assert.equal(validate(findingSchema, unknownRisk).ok, false);

  const extraField = { ...VALID_FINDING, verdict: "PASS" };
  assert.equal(validate(findingSchema, extraField).ok, false);

  const noFiles = { ...VALID_FINDING, files: [] };
  assert.equal(validate(findingSchema, noFiles).ok, false);
});
