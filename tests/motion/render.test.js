"use strict";

// tests/motion/render.test.js — 渲染路径 A/B 调度 + sandbox-exec 警告 +
// 输出路径 + manifest (P-005 MS-005)。外部进程缺失时优雅处理(注入 fake spawn)。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const render = require("../../lib/motion/render");

function makeComposition(motionId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-motion-render-"));
  const comp = path.join(dir, ".agent", "motion", motionId);
  fs.mkdirSync(comp, { recursive: true });
  fs.writeFileSync(path.join(comp, "index.html"), "<html data-duration=\"4\">gsap</html>", "utf8");
  fs.writeFileSync(path.join(comp, "hyperframes.json"), JSON.stringify({ schemaVersion: "od-composition/v1" }), "utf8");
  fs.writeFileSync(path.join(comp, "meta.json"), JSON.stringify({ name: motionId }), "utf8");
  return dir;
}

function fakeChild(exitCode) {
  const child = new EventEmitter();
  setImmediate(() => child.emit("exit", exitCode));
  return child;
}

// ─── 路径选择 ────────────────────────────────────────────────────────────────

test("selectRenderPath: daemon when open-design present (path A default)", () => {
  assert.equal(render.selectRenderPath({ hasOpenDesign: true, hasNpx: false }), "daemon");
  assert.equal(render.selectRenderPath({ hasOpenDesign: true, hasNpx: true }), "daemon");
});

test("selectRenderPath: npx fallback when no daemon (path B)", () => {
  assert.equal(render.selectRenderPath({ hasOpenDesign: false, hasNpx: true }), "npx");
});

test("selectRenderPath: error when neither renderer available", () => {
  const r = render.selectRenderPath({ hasOpenDesign: false, hasNpx: false });
  assert.equal(r.error.code, "NO_RENDERER");
  assert.match(r.error.message, /open-design daemon 也没有 npx/);
});

// ─── sandbox 警告 ───────────────────────────────────────────────────────────

test("sandboxWarning: CLAUDE_CODE=true → sandbox-exec warning", () => {
  const w = render.sandboxWarning({ CLAUDE_CODE: "true" });
  assert.match(w, /sandbox-exec 会挂起 Chrome/);
});

test("sandboxWarning: plain shell → null", () => {
  assert.equal(render.sandboxWarning({}), null);
  assert.equal(render.sandboxWarning(undefined), null);
});

// ─── renderMotion 路径 A(daemon)────────────────────────────────────────────

test("renderMotion: path A spawns open-design media generate and writes manifest", async () => {
  const dir = makeComposition("m-001");
  const spawned = [];
  const result = await render.renderMotion({
    cwd: dir,
    motionId: "m-001",
    preset: "fcp-1080p",
    detect: { hasOpenDesign: true, hasNpx: true },
    spawnFn: (cmd, args) => {
      spawned.push({ cmd, args });
      return fakeChild(0);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.engine, "open-design-daemon");
  assert.equal(spawned[0].cmd, "open-design");
  assert.deepEqual(spawned[0].args, ["media", "generate", "--motion-id", "m-001", "--preset", "fcp-1080p"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".agent", "motion", "m-001", "renders", "render-manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, "od-render-manifest/v1");
  assert.equal(manifest.preset, "fcp-1080p");
  assert.equal(manifest.engine, "open-design-daemon");
  assert.ok(manifest.composition.indexHtmlSha256);
  assert.equal(manifest.render.fps, 24);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── renderMotion 路径 B(npx)+ sandbox 警告 ────────────────────────────────

test("renderMotion: path B spawns npx hyperframes render with sandbox warning", async () => {
  const dir = makeComposition("m-002");
  const spawned = [];
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    const result = await render.renderMotion({
      cwd: dir,
      motionId: "m-002",
      preset: "overlay-webm",
      detect: { hasOpenDesign: false, hasNpx: true },
      env: { CLAUDE_CODE: "true" },
      spawnFn: (cmd, args) => {
        spawned.push({ cmd, args });
        return fakeChild(0);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "hyperframes-npx");
    assert.equal(spawned[0].cmd, "npx");
    assert.deepEqual(spawned[0].args, ["hyperframes", "render", "--motion-id", "m-002", "--preset", "overlay-webm"]);
    assert.ok(warnings.some((w) => w.includes("sandbox-exec 会挂起 Chrome")));
  } finally {
    console.warn = origWarn;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("renderMotion: no sandbox warning in plain shell", async () => {
  const dir = makeComposition("m-003");
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    const result = await render.renderMotion({
      cwd: dir,
      motionId: "m-003",
      preset: "pp-1080p",
      detect: { hasOpenDesign: false, hasNpx: true },
      env: {},
      spawnFn: () => fakeChild(0),
    });
    assert.equal(result.ok, true);
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = origWarn;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── 错误路径 ───────────────────────────────────────────────────────────────

test("renderMotion: unknown preset → UNKNOWN_PRESET", async () => {
  const dir = makeComposition("m-004");
  const result = await render.renderMotion({ cwd: dir, motionId: "m-004", preset: "bogus" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "UNKNOWN_PRESET");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("renderMotion: missing composition → NO_COMPOSITION", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-motion-render-"));
  const result = await render.renderMotion({ cwd: dir, motionId: "m-000", preset: "fcp-1080p" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "NO_COMPOSITION");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("renderMotion: renderer failure propagates RENDER_FAILED", async () => {
  const dir = makeComposition("m-005");
  const result = await render.renderMotion({
    cwd: dir,
    motionId: "m-005",
    preset: "fcp-1080p",
    detect: { hasOpenDesign: true },
    spawnFn: () => fakeChild(2),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RENDER_FAILED");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── 输出路径 + manifest 确定性 ─────────────────────────────────────────────

test("expectedOutputPath: renders/<id>-<preset>.<ext> per preset container", () => {
  const dir = makeComposition("m-006");
  assert.equal(
    render.expectedOutputPath(dir, "m-006", "fcp-4k", require("../../lib/motion/edit-presets").getPreset("fcp-4k")),
    path.join(dir, ".agent", "motion", "m-006", "renders", "m-006-fcp-4k.mov"),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("compositionHashes: sha256 of composition files (deterministic audit)", () => {
  const dir = makeComposition("m-007");
  const hashes = render.compositionHashes(dir, "m-007");
  assert.equal(hashes.indexHtmlSha256.length, 64);
  assert.equal(hashes.hyperframesJsonSha256.length, 64);
  assert.equal(hashes.metaJsonSha256.length, 64);
  const again = render.compositionHashes(dir, "m-007");
  assert.deepEqual(hashes, again);
  fs.rmSync(dir, { recursive: true, force: true });
});
