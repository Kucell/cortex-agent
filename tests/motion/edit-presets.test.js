"use strict";

// tests/motion/edit-presets.test.js — 剪辑预设矩阵 (P-005 MS-005)。
// 8 个 preset 完整参数 + codec/分辨率/帧率校验 + 必填字段。纯单元测试。

const test = require("node:test");
const assert = require("node:assert/strict");

const ep = require("../../lib/motion/edit-presets");

// ─── 矩阵完整性 ─────────────────────────────────────────────────────────────

test("PRESET_IDS: exactly the 8 edit presets", () => {
  assert.deepEqual(
    [...ep.PRESET_IDS].sort(),
    ["fcp-1080p", "fcp-4k", "jianying-1080p", "overlay-mov", "overlay-webm", "pp-1080p", "pp-4k", "vertical-9x16"].sort(),
  );
});

test("every preset carries all required fields with valid values", () => {
  for (const id of ep.PRESET_IDS) {
    const preset = ep.getPreset(id);
    assert.ok(preset, `preset ${id} exists`);
    const { ok, errors } = ep.validatePreset(preset);
    assert.equal(ok, true, `preset ${id} valid: ${errors.join("; ")}`);
  }
});

// ─── 关键 preset 参数 ────────────────────────────────────────────────────────

test("fcp-4k: ProRes 422 HQ 4K 24fps yuv422p10le mov", () => {
  const p = ep.getPreset("fcp-4k");
  assert.equal(p.codec, "prores_ks");
  assert.equal(p.profile, "3");
  assert.equal(p.pixel_format, "yuv422p10le");
  assert.equal(p.width, 3840);
  assert.equal(p.height, 2160);
  assert.equal(p.fps, 24);
  assert.equal(p.audio_codec, "pcm_s16le");
  assert.equal(p.container, "mov");
  assert.equal(p.alpha, false);
});

test("fcp-1080p: ProRes 422 1080p 24fps", () => {
  const p = ep.getPreset("fcp-1080p");
  assert.equal(p.codec, "prores_ks");
  assert.equal(p.profile, "2");
  assert.equal(p.width, 1920);
  assert.equal(p.height, 1080);
  assert.equal(p.fps, 24);
});

test("jianying-1080p: 剪映/CapCut 竖屏 H.264 1080x1920 30fps", () => {
  const p = ep.getPreset("jianying-1080p");
  assert.equal(p.codec, "h264");
  assert.equal(p.profile, "high");
  assert.equal(p.width, 1080);
  assert.equal(p.height, 1920);
  assert.equal(p.fps, 30);
  assert.equal(p.container, "mp4");
  assert.equal(p.audio_codec, "aac");
  assert.match(p.description, /剪映/);
});

test("vertical-9x16: TikTok/Reels 竖屏", () => {
  const p = ep.getPreset("vertical-9x16");
  assert.equal(p.width, 1080);
  assert.equal(p.height, 1920);
  assert.equal(p.fps, 30);
  assert.equal(p.alpha, false);
});

test("overlay-webm: VP9 透明 alpha yuva420p", () => {
  const p = ep.getPreset("overlay-webm");
  assert.equal(p.codec, "vp9");
  assert.equal(p.pixel_format, "yuva420p");
  assert.equal(p.alpha, true);
  assert.equal(p.container, "webm");
  assert.equal(p.audio_codec, "libopus");
});

test("overlay-mov: ProRes 4444 alpha yuva444p10le", () => {
  const p = ep.getPreset("overlay-mov");
  assert.equal(p.codec, "prores_ks");
  assert.equal(p.profile, "4");
  assert.equal(p.pixel_format, "yuva444p10le");
  assert.equal(p.alpha, true);
  assert.equal(p.container, "mov");
});

test("pp-1080p / pp-4k: Premiere H.264 High", () => {
  for (const id of ["pp-1080p", "pp-4k"]) {
    const p = ep.getPreset(id);
    assert.equal(p.codec, "h264");
    assert.equal(p.profile, "high");
    assert.equal(p.container, "mp4");
  }
  assert.equal(ep.getPreset("pp-4k").width, 3840);
});

// ─── FFmpeg flag 翻译 ────────────────────────────────────────────────────────

test("ffmpegArgs: prores preset → prores_ks + profile + pix_fmt + size + fps", () => {
  const args = ep.ffmpegArgs(ep.getPreset("fcp-4k"), { output: "out.mov" });
  assert.ok(args.includes("prores_ks"));
  assert.ok(args.includes("-profile:v"));
  assert.ok(args.includes("3"));
  assert.ok(args.includes("yuv422p10le"));
  assert.ok(args.includes("3840x2160"));
  assert.ok(args.includes("24"));
  assert.ok(args.includes("-f"));
  assert.ok(args.includes("mov"));
  assert.equal(args[args.length - 1], "out.mov");
});

test("ffmpegArgs: h264 preset → libx264 + aac + mp4", () => {
  const args = ep.ffmpegArgs(ep.getPreset("jianying-1080p"), { input: "in.html" });
  assert.ok(args.includes("-i"));
  assert.ok(args.includes("in.html"));
  assert.ok(args.includes("libx264"));
  assert.ok(args.includes("high"));
  assert.ok(args.includes("aac"));
  assert.ok(args.includes("mp4"));
});

// ─── 校验 / 过滤 / 扩展名 ───────────────────────────────────────────────────

test("validatePreset: missing required field → error", () => {
  const broken = { ...ep.getPreset("fcp-1080p"), fps: undefined };
  const { ok, errors } = ep.validatePreset(broken);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("fps")));
});

test("validatePreset: H.264 cannot carry alpha", () => {
  const { ok, errors } = ep.validatePreset({ ...ep.getPreset("pp-1080p"), alpha: true });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("alpha")));
});

test("presetsByKind: fcp / webm / vertical filters", () => {
  assert.deepEqual(Object.keys(ep.presetsByKind("fcp")).sort(), ["fcp-1080p", "fcp-4k"]);
  assert.deepEqual(Object.keys(ep.presetsByKind("webm")), ["overlay-webm"]);
  assert.deepEqual(Object.keys(ep.presetsByKind("vertical")).sort(), ["jianying-1080p", "vertical-9x16"]);
  assert.deepEqual(Object.keys(ep.presetsByKind("overlay")).sort(), ["overlay-mov", "overlay-webm"]);
  assert.equal(ep.presetsByKind("bogus"), null);
});

test("outputExtension: container → ext", () => {
  assert.equal(ep.outputExtension(ep.getPreset("fcp-4k")), "mov");
  assert.equal(ep.outputExtension(ep.getPreset("pp-1080p")), "mp4");
  assert.equal(ep.outputExtension(ep.getPreset("overlay-webm")), "webm");
});
