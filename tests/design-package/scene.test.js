"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const scene = require("../../lib/design-package/scene");
const pixsoAdapter = require("../../lib/design-package/adapter/pixso");

// ─── Fixtures ───────────────────────────────────────────────────────────────

function nestedPixsoFixture() {
  return {
    stats: { source: { variableMap: 0, variableSetMap: 0, localStyleMap: 0 }, outputBytes: 1234 },
    roots: [
      {
        id: "33:471",
        type: "FRAME",
        name: "P-M01 画面模块设计区",
        box: { w: 23570, h: 6757, x: 0, y: 0 },
        fills: [{ type: "solid", value: "rgba(248,237,237,1)" }],
        children: [
          {
            id: "33:472",
            type: "FRAME",
            name: "标准 Inspector 模板实例",
            box: { w: 468, h: 1080, x: 28, y: 100 },
            fills: [{ type: "solid", value: "rgba(255,255,255,1)" }],
            children: [
              {
                id: "33:473",
                type: "TEXT",
                name: "区域标题",
                box: { w: 360, h: 32, x: 28, y: 24 },
                text: { content: "P-M01-00 控件属性与能力规范入口", fontFamily: "Noto Sans SC", fontSize: 22 },
                fills: [{ type: "solid", value: "rgba(31,45,65,1)" }],
              },
            ],
          },
          {
            id: "33:474",
            type: "RECTANGLE",
            name: "Decorative Block",
            box: { w: 100, h: 50, x: 500, y: 500 },
            fills: [{ type: "solid", value: "rgba(34,160,107,1)" }],
          },
          {
            id: "33:475",
            type: "VECTOR",
            name: "Icon",
            box: { w: 16, h: 16, x: 10, y: 10 },
            vectorRef: "33:475",
            childrenSummary: { total: 1, omitted: 3, reason: "vector-icon" },
          },
        ],
      },
    ],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("scene: schema version constant", () => {
  assert.equal(scene.SCHEMA_VERSION, "design-scene.v1");
});

test("scene: buildScene accumulates global coordinates from nested boxes", () => {
  const out = scene.buildScene({ provider: "pixso", roots: nestedPixsoFixture().roots });
  const title = out.nodes.find((n) => n.id === "33:473");
  assert.equal(title.x, 28 + 28);   // root x(0) + parent.x(28) + node.x(28)
  assert.equal(title.y, 100 + 24);
  assert.equal(title.w, 360);
  assert.equal(title.h, 32);
  assert.equal(title.content.text, "P-M01-00 控件属性与能力规范入口");
  assert.equal(title.renderable, true);
});

test("scene: canvas dimensions come from root box", () => {
  const out = scene.buildScene({ provider: "pixso", roots: nestedPixsoFixture().roots });
  assert.equal(out.canvas.width, 23570);
  assert.equal(out.canvas.height, 6757);
  assert.equal(out.source.provider, "pixso");
  assert.equal(out.source.rootId, "33:471");
});

test("scene: coverage honestly reports omitted subtrees and unsupported types", () => {
  const out = scene.buildScene({ provider: "pixso", roots: nestedPixsoFixture().roots });
  assert.ok(out.coverage.knownNodes >= 1);
  assert.ok(out.coverage.drawableNodes >= 3);
  assert.equal(out.coverage.omittedSubtrees, 3);
  assert.ok(out.coverage.unsupportedTypes.includes("VECTOR"));
});

test("scene: selectPage requires 1920×1080", () => {
  const fixture = nestedPixsoFixture();
  fixture.roots[0].children.push({
    id: "39:6071",
    type: "FRAME",
    name: "Windows editor baseline",
    box: { w: 1920, h: 1080, x: 0, y: 0 },
  });
  const out = scene.buildScene({ provider: "pixso", roots: fixture.roots });
  const page = scene.selectPage(out, "39:6071");
  assert.equal(page.w, 1920);
  assert.equal(page.h, 1080);
  assert.throws(() => scene.selectPage(out, "33:471"), /1920×1080/);
  assert.throws(() => scene.selectPage(out, "missing:id"), /not found/);
});

test("pixso adapter: emits design-scene.v1 from Pixso DSL", () => {
  const out = pixsoAdapter.pixsoToScene(nestedPixsoFixture());
  assert.equal(out.schemaVersion, "design-scene.v1");
  assert.equal(out.source.provider, "pixso");
  assert.equal(out.source.rootId, "33:471");
  assert.equal(out.canvas.width, 23570);
});

test("pixso adapter: rejects empty roots", () => {
  assert.throws(() => pixsoAdapter.pixsoToScene({ roots: [] }), /non-empty/);
  assert.throws(() => pixsoAdapter.pixsoToScene(null), /Pixso DSL object/);
});
