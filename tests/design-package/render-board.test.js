"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { pixsoToScene } = require("../../lib/design-package/adapter/pixso");
const { renderBoardHtml } = require("../../lib/design-package/render/board");

function boardFixture() {
  return {
    roots: [
      {
        id: "33:471",
        type: "FRAME",
        name: "P-M01 画面模块设计区",
        box: { w: 23570, h: 6757, x: 0, y: 0 },
        fills: [{ type: "solid", value: "rgba(248,237,237,1)" }],
        children: [
          {
            id: "39:6071",
            type: "FRAME",
            name: "Windows editor baseline",
            box: { w: 1920, h: 1080, x: 0, y: 0 },
            fills: [{ type: "solid", value: "rgba(255,255,255,1)" }],
            children: [
              {
                id: "39:6072",
                type: "TEXT",
                name: "Title",
                box: { w: 360, h: 32, x: 32, y: 32 },
                text: { content: "HMI 画面编辑器", fontFamily: "Noto Sans SC", fontSize: 22 },
                fills: [{ type: "solid", value: "rgba(31,45,65,1)" }],
              },
            ],
          },
          {
            id: "33:474",
            type: "RECTANGLE",
            name: "Decorative Block",
            box: { w: 100, h: 50, x: 5000, y: 1000 },
            fills: [{ type: "solid", value: "rgba(34,160,107,1)" }],
          },
        ],
      },
    ],
  };
}

test("board: HTML is self-contained (no external script, no CDN, no network)", () => {
  const scene = pixsoToScene(boardFixture());
  const brief = { taskId: "BOARD-T", title: "P-M01 画面模块设计区" };
  const html = renderBoardHtml(brief, scene, { lang: "zh" });
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(!/<script[^>]+src=/i.test(html));
  assert.ok(!/https?:\/\//i.test(html));
  assert.ok(!/tailwind|cdn/i.test(html));
  assert.ok(html.includes("data-od-render-mode=\"board\""));
  assert.ok(html.includes("data-od-canvas"));
  assert.ok(html.includes("data-od-viewport"));
  assert.ok(html.includes("data-od-stage"));
});

test("board: real source canvas dimensions rendered into toolbar", () => {
  const scene = pixsoToScene(boardFixture());
  const html = renderBoardHtml({ taskId: "BOARD-T", title: "P-M01" }, scene, { lang: "zh" });
  assert.ok(html.includes("23570 × 6757"));
});

test("board: every drawable Pixso node is rendered with data-pixso-id", () => {
  const scene = pixsoToScene(boardFixture());
  const html = renderBoardHtml({ taskId: "BOARD-T", title: "P-M01" }, scene, { lang: "zh" });
  assert.ok(html.includes('data-pixso-id="33:471"'));
  assert.ok(html.includes('data-pixso-id="39:6071"'));
  assert.ok(html.includes('data-pixso-id="39:6072"'));
  assert.ok(html.includes('data-pixso-id="33:474"'));
});

test("board: tree sidebar contains every node name", () => {
  const scene = pixsoToScene(boardFixture());
  const html = renderBoardHtml({ taskId: "BOARD-T", title: "P-M01" }, scene, { lang: "zh" });
  assert.ok(html.includes("P-M01 画面模块设计区"));
  assert.ok(html.includes("Windows editor baseline"));
  assert.ok(html.includes("Title"));
});

test("board: coverage panel discloses drawable / known / omitted", () => {
  const scene = pixsoToScene(boardFixture());
  const html = renderBoardHtml({ taskId: "BOARD-T", title: "P-M01" }, scene, { lang: "zh" });
  assert.ok(html.includes("可绘制"));
  assert.ok(html.includes("已知节点"));
  assert.ok(html.includes("省略子树"));
});

test("board: provider field rendered for provenance", () => {
  const scene = pixsoToScene(boardFixture());
  const html = renderBoardHtml({ taskId: "BOARD-T", title: "P-M01" }, scene, { lang: "zh" });
  assert.ok(html.includes('data-od-source="pixso"'));
});

test("board: deterministic — same input produces same bytes", () => {
  const scene = pixsoToScene(boardFixture());
  const a = renderBoardHtml({ taskId: "BOARD-T", title: "P-M01" }, scene, { lang: "zh" });
  const b = renderBoardHtml({ taskId: "BOARD-T", title: "P-M01" }, scene, { lang: "zh" });
  assert.equal(a, b);
});