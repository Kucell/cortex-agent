"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { penpotToScene } = require("../../lib/design-package/adapter/penpot.js");
const { SCHEMA_VERSION, findNode } = require("../../lib/design-package/scene.js");

function makeExport(overrides = {}) {
  return {
    name: "MS-5 fixture",
    file_id: "fixture-file-001",
    data: {
      pages: ["page-1"],
      objects: {
        "page-1": {
          type: "frame",
          name: "1920×1080 Canvas",
          x: 0, y: 0, width: 1920, height: 1080,
          shapes: ["header-1", "body-1"],
          fills: [{ "fill-color": "#ffffff" }],
        },
        "header-1": {
          type: "frame",
          name: "Header",
          x: 0, y: 0, width: 1920, height: 80,
          shapes: ["title-1"],
          fills: [{ "fill-color": "#1f7a4d" }],
        },
        "title-1": {
          type: "text",
          name: "Title Text",
          x: 24, y: 24, width: 600, height: 32,
          content: "SAMHMI Pilot",
          "font-family": "Noto Sans SC",
          "font-size": 24,
          shapes: [],
        },
        "body-1": {
          type: "rect",
          name: "Body Background",
          x: 0, y: 80, width: 1920, height: 1000,
          shapes: [],
          fills: [{ "fill-color": "#f5f5f5" }],
        },
      },
    },
    ...overrides,
  };
}

test("penpotToScene emits design-scene.v1 with provider=penpot", () => {
  const scene = penpotToScene(makeExport());
  assert.equal(scene.schemaVersion, SCHEMA_VERSION);
  assert.equal(scene.source.provider, "penpot");
  assert.equal(scene.source.documentId, "fixture-file-001");
  assert.equal(scene.source.rootId, "page-1");
});

test("penpotToScene materializes nested shapes into tree children", () => {
  const scene = penpotToScene(makeExport());
  assert.equal(scene.nodes.length, 4);
  const page = findNode(scene, "page-1");
  assert.equal(page.name, "1920×1080 Canvas");
  assert.equal(page.type, "FRAME");
  assert.equal(page.w, 1920);
  assert.equal(page.h, 1080);

  const header = findNode(scene, "header-1");
  assert.equal(header.parentId, "page-1");
  assert.equal(header.type, "FRAME");
  assert.equal(header.style.fill, "#1f7a4d");

  const title = findNode(scene, "title-1");
  assert.equal(title.parentId, "header-1");
  assert.equal(title.type, "TEXT");
  assert.equal(title.content.text, "SAMHMI Pilot");
  assert.equal(title.content.fontFamily, "Noto Sans SC");
  assert.equal(title.content.fontSize, 24);

  const body = findNode(scene, "body-1");
  assert.equal(body.parentId, "page-1");
  assert.equal(body.type, "RECTANGLE");
});

test("penpotToScene maps known Penpot types to design-scene.v1 types", () => {
  const scene = penpotToScene(makeExport());
  const types = scene.nodes.map((n) => n.type);
  assert.ok(types.includes("FRAME"));
  assert.ok(types.includes("TEXT"));
  assert.ok(types.includes("RECTANGLE"));
});

test("penpotToScene throws on empty input", () => {
  assert.throws(() => penpotToScene(null), /Penpot export JSON object/);
  assert.throws(() => penpotToScene({}), /data" object/);
  assert.throws(() => penpotToScene({ data: {} }), /data.objects" map/);
  assert.throws(() => penpotToScene({ data: { objects: {} } }), /data.pages" array/);
});

test("penpotToScene throws when no page materializes", () => {
  const e = makeExport({
    data: { pages: ["missing-page"], objects: {} },
  });
  assert.throws(() => penpotToScene(e), /no materializable roots/);
});

test("penpotToScene surfaces text content from text-shape nodes", () => {
  const e = makeExport();
  e.data.objects["title-1"].type = "text-shape";
  const scene = penpotToScene(e);
  const title = findNode(scene, "title-1");
  assert.equal(title.type, "TEXT");
  assert.equal(title.content.text, "SAMHMI Pilot");
});

test("penpotToScene dedupes cycles via seen-set", () => {
  const e = makeExport();
  // Force a cycle: header-1 shapes include itself.
  e.data.objects["header-1"].shapes = ["header-1"];
  const scene = penpotToScene(e);
  // Should still produce a scene with header-1 but no duplicated subtree
  const header = findNode(scene, "header-1");
  assert.ok(header);
  // Should not crash or loop forever.
});

test("penpotToScene handles missing shapes gracefully", () => {
  const e = makeExport();
  delete e.data.objects["body-1"].shapes;
  const scene = penpotToScene(e);
  const body = findNode(scene, "body-1");
  assert.ok(body);
  assert.equal(body.w, 1920);
});

test("penpotToScene emits canvas from root dimensions", () => {
  const scene = penpotToScene(makeExport());
  assert.equal(scene.canvas.width, 1920);
  assert.equal(scene.canvas.height, 1080);
});

test("penpotToScene keeps coverage counters aligned with node count", () => {
  const scene = penpotToScene(makeExport());
  assert.equal(scene.coverage.knownNodes, 4);
  assert.ok(scene.coverage.drawableNodes >= 2);
  assert.equal(scene.coverage.textNodes, 1);
});
