"use strict";

// tests/motion/verify.test.js — ffprobe 质量门 (P-005 MS-005)。
// 纯函数校验 + 注入 fake ffprobe;外部 ffprobe 缺失时优雅错误(不 fail)。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const verify = require("../../lib/motion/verify");
const ep = require("../../lib/motion/edit-presets");

// ─── parseFfprobeOutput ─────────────────────────────────────────────────────

test("parseFfprobeOutput: normalizes duration/width/height/fps/codec/pix_fmt", () => {
  const info = verify.parseFfprobeOutput({
    format: { duration: "4.000000" },
    streams: [
      { codec_type: "audio", codec_name: "aac" },
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
        pix_fmt: "yuv420p",
        r_frame_rate: "30000/1001",
      },
    ],
  });
  assert.equal(info.duration, 4);
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080);
  assert.equal(info.codec, "h264");
  assert.equal(info.pixelFormat, "yuv420p");
  assert.equal(info.fps, 29.97);
  assert.equal(info.hasAlpha, false);
});

test("parseFfprobeOutput: alpha pixel format detected", () => {
  const info = verify.parseFfprobeOutput({
    streams: [{ codec_type: "video", codec_name: "vp9", pix_fmt: "yuva420p", r_frame_rate: "30/1" }],
  });
  assert.equal(info.hasAlpha, true);
});

test("normalizeFps: rational + decimal", () => {
  assert.equal(verify.normalizeFps("24000/1001"), 23.976);
  assert.equal(verify.normalizeFps("24.0"), 24);
  assert.equal(verify.normalizeFps(null), null);
});

// ─── validateRender ─────────────────────────────────────────────────────────

test("validateRender: pass — fcp-1080p info matches preset", () => {
  const info = { duration: 4, width: 1920, height: 1080, fps: 24, codec: "prores", pixelFormat: "yuv422p10le", hasAlpha: false };
  const { ok, checks, errors } = verify.validateRender(info, ep.getPreset("fcp-1080p"));
  assert.equal(ok, true, errors.join("; "));
  assert.ok(checks.length >= 5);
});

test("validateRender: resolution mismatch → error", () => {
  const info = { duration: 4, width: 1280, height: 720, fps: 24, codec: "prores", pixelFormat: "yuv422p10le" };
  const { ok, errors } = verify.validateRender(info, ep.getPreset("fcp-1080p"));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("resolution")));
});

test("validateRender: overlay preset requires alpha (yuva*)", () => {
  const noAlpha = { duration: 4, width: 1920, height: 1080, fps: 30, codec: "vp9", pixelFormat: "yuv420p", hasAlpha: false };
  const r1 = verify.validateRender(noAlpha, ep.getPreset("overlay-webm"));
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes("alpha")));
  const withAlpha = { ...noAlpha, pixelFormat: "yuva420p", hasAlpha: true };
  const r2 = verify.validateRender(withAlpha, ep.getPreset("overlay-webm"));
  assert.equal(r2.ok, true);
});

test("validateRender: fps drift beyond tolerance → error", () => {
  const info = { duration: 4, width: 1920, height: 1080, fps: 60, codec: "h264", pixelFormat: "yuv420p" };
  const { ok, errors } = verify.validateRender(info, ep.getPreset("pp-1080p"));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("fps")));
});

test("codecMatches: prores family + h264 family", () => {
  assert.equal(verify.codecMatches("prores_ks", "prores"), true);
  assert.equal(verify.codecMatches("h264", "avc1"), true);
  assert.equal(verify.codecMatches("vp9", "vp9"), true);
  assert.equal(verify.codecMatches("prores_ks", "h264"), false);
});

// ─── verifyRender(集成,注入 fake ffprobe)──────────────────────────────────

function fakeFfprobe(json, exitCode) {
  return (file, opts) => {
    const child = new EventEmitter();
    const payload = JSON.stringify(json);
    setImmediate(() => {
      if (child.stdout) child.stdout.emit("data", Buffer.from(payload));
      child.emit("exit", exitCode);
    });
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  };
}

test("verifyRender: ffprobe success → ok with checks (fcp-1080p)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-motion-verify-"));
  const renders = path.join(dir, ".agent", "motion", "m-001", "renders");
  fs.mkdirSync(renders, { recursive: true });
  const file = path.join(renders, "m-001-fcp-1080p.mov");
  fs.writeFileSync(file, "x");
  const json = {
    format: { duration: "4.0" },
    streams: [{ codec_type: "video", codec_name: "prores", width: 1920, height: 1080, pix_fmt: "yuv422p10le", r_frame_rate: "24/1" }],
  };
  const result = await verify.verifyRender({ cwd: dir, motionId: "m-001", preset: "fcp-1080p", ffprobeFn: fakeFfprobe(json, 0) });
  assert.equal(result.ok, true);
  assert.ok(result.checks.length >= 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("verifyRender: no render output → NO_RENDER_OUTPUT graceful error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-motion-verify-"));
  const result = await verify.verifyRender({ cwd: dir, motionId: "m-999" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "NO_RENDER_OUTPUT");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("verifyRender: ffprobe missing (spawn error) → FFPROBE_MISSING + install guidance", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-motion-verify-"));
  const renders = path.join(dir, ".agent", "motion", "m-002", "renders");
  fs.mkdirSync(renders, { recursive: true });
  fs.writeFileSync(path.join(renders, "m-002-pp-1080p.mp4"), "x");
  const failing = () => {
    const child = new EventEmitter();
    setImmediate(() => child.emit("error", new Error("spawn ffprobe ENOENT")));
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  };
  const result = await verify.verifyRender({ cwd: dir, motionId: "m-002", preset: "pp-1080p", ffprobeFn: failing });
  assert.equal(result.ok, false);
  assert.equal(result.code, "FFPROBE_MISSING");
  assert.match(result.message, /brew install ffmpeg/);
  fs.rmSync(dir, { recursive: true, force: true });
});
