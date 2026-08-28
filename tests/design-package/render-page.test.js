"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { pixsoToScene } = require("../../lib/design-package/adapter/pixso");
const { renderPageHtml } = require("../../lib/design-package/render/page");

function pageFixture() {
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
              {
                id: "39:6073",
                type: "RECTANGLE",
                name: "CTA",
                box: { w: 200, h: 56, x: 32, y: 1000 },
                fills: [{ type: "solid", value: "rgba(47,109,235,1)" }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function pickPage(scene, id) {
  const n = scene.nodes.find((x) => x.id === id);
  return n;
}

test("page: HTML is self-contained and labels render-mode", () => {
  const scene = pixsoToScene(pageFixture());
  const page = pickPage(scene, "39:6071");
  const html = renderPageHtml({ taskId: "PAGE-T", title: "HMI 画面编辑器" }, scene, page, { lang: "zh" });
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.includes("data-od-render-mode=\"page\""));
  assert.ok(html.includes('data-od-page-id="39:6071"'));
  assert.ok(!/<script[^>]+src=/i.test(html));
  assert.ok(!/https?:\/\//i.test(html));
});

test("page: only nodes within the selected 1920x1080 frame are emitted", () => {
  const scene = pixsoToScene(pageFixture());
  const page = pickPage(scene, "39:6071");
  const html = renderPageHtml({ taskId: "PAGE-T", title: "HMI 画面编辑器" }, scene, page, { lang: "zh" });
  assert.ok(html.includes('data-pixso-id="39:6072"'));
  assert.ok(html.includes('data-pixso-id="39:6073"'));
  assert.ok(!html.includes('data-pixso-id="33:471"'));
  assert.ok(!html.includes('data-pixso-id="33:472"'));
});

test("page: 1:1 stage shows 1920x1080", () => {
  const scene = pixsoToScene(pageFixture());
  const page = pickPage(scene, "39:6071");
  const html = renderPageHtml({ taskId: "PAGE-T", title: "HMI 画面编辑器" }, scene, page, { lang: "zh" });
  assert.ok(html.includes("1920 × 1080"));
  assert.ok(html.includes("width:1920px;height:1080px"));
});

test("page: text is HTML-escaped", () => {
  const scene = pixsoToScene({
    roots: [{
      id: "33:471", type: "FRAME", name: "R", box: { w: 4000, h: 2000 },
      fills: [{ type: "solid", value: "rgba(0,0,0,1)" }],
      children: [{
        id: "39:6071", type: "FRAME", name: "P", box: { w: 1920, h: 1080 },
        fills: [{ type: "solid", value: "rgba(255,255,255,1)" }],
        children: [{
          id: "39:6072", type: "TEXT", name: "T", box: { w: 200, h: 32, x: 10, y: 10 },
          text: { content: "<script>alert(1)</script>", fontFamily: "Noto Sans SC", fontSize: 14 },
          fills: [{ type: "solid", value: "rgba(0,0,0,1)" }],
        }],
      }],
    }],
  });
  const page = pickPage(scene, "39:6071");
  const html = renderPageHtml({ taskId: "PAGE-T", title: "Esc" }, scene, page, { lang: "zh" });
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!html.includes("<script>alert(1)</script>"));
});

test("page: deterministic — same input produces same bytes", () => {
  const scene = pixsoToScene(pageFixture());
  const page = pickPage(scene, "39:6071");
  const a = renderPageHtml({ taskId: "PAGE-T", title: "HMI" }, scene, page, { lang: "zh" });
  const b = renderPageHtml({ taskId: "PAGE-T", title: "HMI" }, scene, page, { lang: "zh" });
  assert.equal(a, b);
});