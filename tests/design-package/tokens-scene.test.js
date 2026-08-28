"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const tokens = require("../../lib/design-package/tokens");
const { pixsoToScene } = require("../../lib/design-package/adapter/pixso");
const { buildScene } = require("../../lib/design-package/scene");

// ─── Fixtures ────────────────────────────────────────────────────────────────

function nestedPixsoFixture() {
  return {
    roots: [
      {
        id: "33:471",
        type: "FRAME",
        name: "P-M01 画面模块设计区",
        box: { w: 23570, h: 6757 },
        fills: [{ type: "solid", value: "rgba(248,237,237,1)" }],
        children: [
          {
            id: "33:472",
            type: "TEXT",
            name: "区域标题",
            box: { w: 360, h: 32, x: 28, y: 100 },
            text: { content: "P-M01-00 控件属性与能力规范入口", fontFamily: "Noto Sans SC", fontSize: 22 },
            fills: [{ type: "solid", value: "rgba(31,45,65,1)" }],
          },
          {
            id: "33:473",
            type: "RECTANGLE",
            name: "decoration",
            box: { w: 100, h: 50, x: 500, y: 500 },
            fills: [{ type: "solid", value: "rgba(34,160,107,1)" }],
          },
        ],
      },
    ],
  };
}

// ─── Scene-driven extraction ─────────────────────────────────────────────────

test("tokens: extractTokens consumes design-scene.v1", () => {
  const scene = pixsoToScene(nestedPixsoFixture());
  const t = tokens.extractTokens(scene);
  // The P-M01 root fill rgba(248,237,237,1) → #F8EDED, fg #1F2D41, accent #22A06B
  assert.ok(t.colors.includes("#F8EDED"));
  assert.ok(t.colors.includes("#1F2D41"));
  assert.ok(t.colors.includes("#22A06B"));
  assert.ok(t.fontFamilies.includes("Noto Sans SC"));
  assert.ok(t.fontSizes.includes(22));
});

test("tokens: extractTokens also accepts raw Pixso DSL via adapter", () => {
  const t = tokens.extractTokens(nestedPixsoFixture());
  assert.ok(t.colors.includes("#F8EDED"));
  assert.ok(t.colors.includes("#22A06B"));
  assert.ok(t.fontFamilies.includes("Noto Sans SC"));
});

test("tokens: rootCanvas reads from scene.canvas", () => {
  const scene = pixsoToScene(nestedPixsoFixture());
  const c = tokens.rootCanvas(scene);
  assert.equal(c.w, 23570);
  assert.equal(c.h, 6757);
});

test("tokens: rootChildren walks scene parent links", () => {
  const scene = pixsoToScene(nestedPixsoFixture());
  const children = tokens.rootChildren(scene);
  assert.equal(children.length, 2);
  const names = children.map((c) => c.name).sort();
  assert.deepEqual(names, ["decoration", "区域标题"]);
});

test("tokens: textLabels returns scene text content", () => {
  const scene = pixsoToScene(nestedPixsoFixture());
  const labels = tokens.textLabels(scene);
  assert.ok(labels.some((l) => l.text.includes("P-M01-00")));
});

test("tokens: buildBrandTokens wires scene canvas into brand spec", () => {
  const scene = pixsoToScene(nestedPixsoFixture());
  const brand = tokens.buildBrandTokens(scene, { lang: "zh" });
  assert.equal(brand.canvas.w, 23570);
  assert.equal(brand.canvas.h, 6757);
  assert.equal(brand.fontFamily, "Noto Sans SC");
  assert.equal(brand.semantic.accent, "#2F6DEB");
});

test("tokens: buildBrandSpec mentions design-scene.v1 source", () => {
  const scene = pixsoToScene(nestedPixsoFixture());
  const brand = tokens.buildBrandTokens(scene, { lang: "zh" });
  const md = tokens.buildBrandSpec({ taskId: "SAMHMI" }, brand, { lang: "zh", template: "samhmi-editor" });
  assert.ok(md.includes("23570 × 6757"));
  assert.ok(md.includes("design-scene.v1"));
  assert.ok(md.includes("samhmi-editor"));
});

// ─── Schema-shape sanity for an empty DSL input (not a Pixso DSL) ────────────

test("tokens: scene schemaVersion is recorded", () => {
  const scene = buildScene({ provider: "pixso", roots: nestedPixsoFixture().roots });
  assert.equal(scene.schemaVersion, "design-scene.v1");
  assert.equal(scene.source.provider, "pixso");
});
