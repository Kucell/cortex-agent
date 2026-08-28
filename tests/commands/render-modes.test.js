"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { designPackageCommand } = require("../../lib/commands/design-package");
const { pixsoToScene } = require("../../lib/design-package/adapter/pixso");
const { buildScene } = require("../../lib/design-package/scene");

const INITIAL_EXIT_CODE = process.exitCode;
test.beforeEach(() => { process.exitCode = INITIAL_EXIT_CODE; });
test.afterEach(() => { process.exitCode = INITIAL_EXIT_CODE; });

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dp-mode-"));
  fs.mkdirSync(path.join(dir, ".agent"), { recursive: true });
  return dir;
}

function dualFixture() {
  return {
    roots: [{
      id: "33:471", type: "FRAME", name: "P-M01", box: { w: 23570, h: 6757 },
      fills: [{ type: "solid", value: "rgba(248,237,237,1)" }],
      children: [{
        id: "39:6071", type: "FRAME", name: "Windows editor baseline",
        box: { w: 1920, h: 1080, x: 0, y: 0 },
        fills: [{ type: "solid", value: "rgba(255,255,255,1)" }],
        children: [{
          id: "39:6072", type: "TEXT", name: "Title",
          box: { w: 360, h: 32, x: 32, y: 32 },
          text: { content: "HMI 画面编辑器", fontFamily: "Noto Sans SC", fontSize: 22 },
          fills: [{ type: "solid", value: "rgba(31,45,65,1)" }],
        }],
      }],
    }],
  };
}

function writeDsl(dir, name, dsl) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(dsl), "utf8");
  return file;
}

test("design-package: --render-mode board writes board entry", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writeDsl(dir, "dsl.json", dualFixture());
    const code = await designPackageCommand({
      args: ["B-T", "--from-pixso", dslFile, "--render-mode", "board", "--json"],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 0);
    const html = fs.readFileSync(path.join(dir, ".agent/artifacts/B-T/package/samhmi-editor.html"), "utf8");
    assert.ok(html.includes("data-od-render-mode=\"board\""));
    assert.ok(html.includes("23570 × 6757"));
    const art = JSON.parse(fs.readFileSync(path.join(dir, ".agent/artifacts/B-T/package/samhmi-editor.html.artifact.json"), "utf8"));
    assert.equal(art.metadata.renderMode, "board");
    assert.equal(art.metadata.sourceProvider, "pixso");
    assert.equal(art.metadata.views.length, 1);
    assert.equal(art.metadata.views[0].id, "board");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: --render-mode page requires --page-id", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writeDsl(dir, "dsl.json", dualFixture());
    const code = await designPackageCommand({
      args: ["P-T", "--from-pixso", dslFile, "--render-mode", "page"],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: --render-mode page writes page entry from selected 1920x1080 node", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writeDsl(dir, "dsl.json", dualFixture());
    const code = await designPackageCommand({
      args: ["P-T", "--from-pixso", dslFile, "--render-mode", "page", "--page-id", "39:6071", "--json"],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 0);
    const html = fs.readFileSync(path.join(dir, ".agent/artifacts/P-T/package/samhmi-editor.html"), "utf8");
    assert.ok(html.includes("data-od-render-mode=\"page\""));
    assert.ok(html.includes('data-od-page-id="39:6071"'));
    assert.ok(html.includes("1920 × 1080"));
    const art = JSON.parse(fs.readFileSync(path.join(dir, ".agent/artifacts/P-T/package/samhmi-editor.html.artifact.json"), "utf8"));
    assert.equal(art.metadata.views[0].id, "page");
    assert.equal(art.metadata.views[0].sourceGuid, "39:6071");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: --render-mode page with non-1920x1080 id → exit 2", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writeDsl(dir, "dsl.json", dualFixture());
    const code = await designPackageCommand({
      args: ["P-T", "--from-pixso", dslFile, "--render-mode", "page", "--page-id", "33:471"],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: --render-mode dual writes both page + board entries", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writeDsl(dir, "dsl.json", dualFixture());
    const code = await designPackageCommand({
      args: ["D-T", "--from-pixso", dslFile, "--render-mode", "dual", "--page-id", "39:6071", "--zip", "--json"],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 0);
    const pkg = path.join(dir, ".agent/artifacts/D-T/package");
    const pageHtml = fs.readFileSync(path.join(pkg, "samhmi-editor.html"), "utf8");
    const boardHtml = fs.readFileSync(path.join(pkg, "samhmi-editor.design-board.html"), "utf8");
    assert.ok(pageHtml.includes("data-od-render-mode=\"page\""));
    assert.ok(boardHtml.includes("data-od-render-mode=\"board\""));
    assert.ok(boardHtml.includes("23570 × 6757"));
    assert.ok(fs.existsSync(path.join(pkg, "samhmi-editor.zip")));
    const art = JSON.parse(fs.readFileSync(path.join(pkg, "samhmi-editor.html.artifact.json"), "utf8"));
    const ids = art.metadata.views.map((v) => v.id);
    assert.ok(ids.includes("page"));
    assert.ok(ids.includes("board"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: --render-mode invalid → exit 2", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writeDsl(dir, "dsl.json", dualFixture());
    const code = await designPackageCommand({
      args: ["X-T", "--from-pixso", dslFile, "--render-mode", "bogus"],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: default summary mode output equals pre-MS-3 baseline", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writeDsl(dir, "dsl.json", dualFixture());
    const code = await designPackageCommand({
      args: ["S-T", "--from-pixso", dslFile],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 0);
    const html = fs.readFileSync(path.join(dir, ".agent/artifacts/S-T/package/samhmi-editor.html"), "utf8");
    // Legacy SamHMI shell markers from render.js must still be present.
    assert.ok(html.includes("data-od-ref=\"91:3196\""));
    assert.ok(html.includes("SamHMI"));
    assert.ok(!html.includes("data-od-render-mode"));
    const art = JSON.parse(fs.readFileSync(path.join(dir, ".agent/artifacts/S-T/package/samhmi-editor.html.artifact.json"), "utf8"));
    assert.equal(art.metadata.renderMode, "summary");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});