"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { pixsoToScene } = require("../../lib/design-package/adapter/pixso");
const { renderDualPageHtml, renderDualBoardHtml } = require("../../lib/design-package/render/dual");

function dualFixture() {
  return {
    roots: [{
      id: "33:471", type: "FRAME", name: "P-M01", box: { w: 4000, h: 2000 },
      fills: [{ type: "solid", value: "rgba(248,237,237,1)" }],
      children: [{
        id: "39:6071", type: "FRAME", name: "Windows editor baseline",
        box: { w: 1920, h: 1080, x: 0, y: 0 },
        fills: [{ type: "solid", value: "rgba(255,255,255,1)" }],
        children: [{
          id: "39:6072", type: "RECTANGLE", name: "CTA",
          box: { w: 200, h: 56, x: 32, y: 1000 },
          fills: [{ type: "solid", value: "rgba(47,109,235,1)" }],
        }],
      }],
    }],
  };
}

test("dual: page renderer emits 1920x1080 stage", () => {
  const scene = pixsoToScene(dualFixture());
  const page = scene.nodes.find((n) => n.id === "39:6071");
  const html = renderDualPageHtml({ taskId: "DUAL-T", title: "P" }, scene, page, { lang: "zh" });
  assert.ok(html.includes("data-od-render-mode=\"page\""));
  assert.ok(html.includes("1920 × 1080"));
  assert.ok(html.includes('data-pixso-id="39:6072"'));
});

test("dual: board renderer emits real source canvas and tree", () => {
  const scene = pixsoToScene(dualFixture());
  const html = renderDualBoardHtml({ taskId: "DUAL-T", title: "P" }, scene, { lang: "zh" });
  assert.ok(html.includes("data-od-render-mode=\"board\""));
  assert.ok(html.includes("4000 × 2000"));
  assert.ok(html.includes("P-M01"));
  assert.ok(html.includes("Windows editor baseline"));
});

test("dual: page + board are independent outputs (no shared state)", () => {
  const scene = pixsoToScene(dualFixture());
  const page = scene.nodes.find((n) => n.id === "39:6071");
  const a = renderDualPageHtml({ taskId: "DUAL-T", title: "P" }, scene, page, { lang: "zh" });
  const b = renderDualBoardHtml({ taskId: "DUAL-T", title: "P" }, scene, { lang: "zh" });
  assert.ok(a !== b);
  assert.ok(a.includes("data-od-render-mode=\"page\""));
  assert.ok(b.includes("data-od-render-mode=\"board\""));
});

test("dual: deterministic outputs", () => {
  const scene = pixsoToScene(dualFixture());
  const page = scene.nodes.find((n) => n.id === "39:6071");
  const a = renderDualPageHtml({ taskId: "DUAL-T", title: "P" }, scene, page, { lang: "zh" });
  const b = renderDualPageHtml({ taskId: "DUAL-T", title: "P" }, scene, page, { lang: "zh" });
  assert.equal(a, b);
  const c = renderDualBoardHtml({ taskId: "DUAL-T", title: "P" }, scene, { lang: "zh" });
  const d = renderDualBoardHtml({ taskId: "DUAL-T", title: "P" }, scene, { lang: "zh" });
  assert.equal(c, d);
});