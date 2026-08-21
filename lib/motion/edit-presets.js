"use strict";

// ─── edit-presets — 剪辑预设矩阵 (P-005 MS-005) ───────────────────────────────
//
// "直接拖进剪辑就能用" 的质量矩阵:每个 preset 绑定目标剪辑软件 / 编码 / 帧率 /
// 分辨率 / 像素格式 / 容器 / Alpha 支持,并翻译成 FFmpeg flag 序列。
//
// 8 presets (P-005 §4.4 + task spec):
//   fcp-1080p / fcp-4k        — Final Cut Pro, ProRes 422 (yuv422p10le)
//   pp-1080p / pp-4k          — Premiere Pro, H.264 High
//   jianying-1080p            — 剪映 / CapCut 竖屏 H.264 直拖
//   vertical-9x16             — TikTok / Reels 9:16
//   overlay-webm              — 透明 overlay VP9 alpha (yuva420p)
//   overlay-mov               — FCP 透明 overlay ProRes 4444 alpha (yuva444p10le)
//
// 零 npm 依赖:纯数据 + 纯函数。

const PRESETS = Object.freeze({
  "fcp-1080p": {
    codec: "prores_ks",
    profile: "2",
    pixel_format: "yuv422p10le",
    width: 1920,
    height: 1080,
    fps: 24,
    audio_codec: "pcm_s16le",
    container: "mov",
    alpha: false,
    targets: ["Final Cut Pro", "DaVinci Resolve"],
    description: "FCP standard 1080p ProRes 422 HQ",
  },
  "fcp-4k": {
    codec: "prores_ks",
    profile: "3",
    pixel_format: "yuv422p10le",
    width: 3840,
    height: 2160,
    fps: 24,
    audio_codec: "pcm_s16le",
    container: "mov",
    alpha: false,
    targets: ["Final Cut Pro", "DaVinci Resolve"],
    description: "FCP 4K ProRes 422 HQ",
  },
  "pp-1080p": {
    codec: "h264",
    profile: "high",
    pixel_format: "yuv420p",
    width: 1920,
    height: 1080,
    fps: 30,
    audio_codec: "aac",
    container: "mp4",
    alpha: false,
    targets: ["Premiere Pro", "剪映", "CapCut"],
    description: "Premiere 1080p H.264 High",
  },
  "pp-4k": {
    codec: "h264",
    profile: "high",
    pixel_format: "yuv420p",
    width: 3840,
    height: 2160,
    fps: 30,
    audio_codec: "aac",
    container: "mp4",
    alpha: false,
    targets: ["Premiere Pro"],
    description: "Premiere 4K H.264 High",
  },
  "jianying-1080p": {
    codec: "h264",
    profile: "high",
    pixel_format: "yuv420p",
    width: 1080,
    height: 1920,
    fps: 30,
    audio_codec: "aac",
    container: "mp4",
    alpha: false,
    targets: ["剪映", "CapCut", "Premiere"],
    description: "剪映/CapCut 1080p vertical,直接拖入",
  },
  "vertical-9x16": {
    codec: "h264",
    profile: "high",
    pixel_format: "yuv420p",
    width: 1080,
    height: 1920,
    fps: 30,
    audio_codec: "aac",
    container: "mp4",
    alpha: false,
    targets: ["TikTok", "Reels", "抖音", "快手"],
    description: "TikTok/Reels 9:16 vertical",
  },
  "overlay-webm": {
    codec: "vp9",
    profile: null,
    pixel_format: "yuva420p",
    width: 1920,
    height: 1080,
    fps: 30,
    audio_codec: "libopus",
    container: "webm",
    alpha: true,
    targets: ["Premiere", "剪映", "FCP"],
    description: "透明 overlay WebM VP9 alpha",
  },
  "overlay-mov": {
    codec: "prores_ks",
    profile: "4",
    pixel_format: "yuva444p10le",
    width: 1920,
    height: 1080,
    fps: 24,
    audio_codec: "pcm_s16le",
    container: "mov",
    alpha: true,
    targets: ["Final Cut Pro", "DaVinci Resolve"],
    description: "FCP 透明 overlay ProRes 4444 alpha",
  },
});

const PRESET_IDS = Object.freeze(Object.keys(PRESETS));

// Required fields every preset must carry (used by validatePreset).
const REQUIRED_FIELDS = Object.freeze([
  "codec",
  "width",
  "height",
  "fps",
  "audio_codec",
  "container",
  "description",
]);

const CODEC_FFMPEG = Object.freeze({
  prores_ks: "prores_ks",
  h264: "libx264",
  vp9: "libvpx-vp9",
});

// container → `-f` value
const CONTAINER_FORMAT = Object.freeze({
  mov: "mov",
  mp4: "mp4",
  webm: "webm",
});

// Extension for rendered outputs, by container.
const CONTAINER_EXT = Object.freeze({
  mov: "mov",
  mp4: "mp4",
  webm: "webm",
});

function getPreset(id) {
  return PRESETS[id] || null;
}

function validatePreset(preset) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (preset[field] === undefined || preset[field] === null || preset[field] === "") {
      errors.push(`missing required field: ${field}`);
    }
  }
  if (!(preset.width > 0 && preset.height > 0)) errors.push("width/height must be positive integers");
  if (!(preset.fps > 0)) errors.push("fps must be a positive number");
  if (!CODEC_FFMPEG[preset.codec]) errors.push(`unsupported codec: ${preset.codec}`);
  if (!CONTAINER_FORMAT[preset.container]) errors.push(`unsupported container: ${preset.container}`);
  if (preset.alpha && preset.codec === "h264") {
    errors.push("H.264 preset cannot carry alpha — use overlay-webm / overlay-mov");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Translate a preset into an FFmpeg flag list (for direct ffmpeg use).
 * Returns ["-c:v", "libx264", "-profile:v", "high", ...]. Pure function.
 */
function ffmpegArgs(preset, options) {
  const opts = options || {};
  const args = [];
  if (opts.input) args.push("-i", String(opts.input));
  const vcodec = CODEC_FFMPEG[preset.codec];
  if (vcodec) args.push("-c:v", vcodec);
  if (preset.codec === "prores_ks" && preset.profile) {
    args.push("-profile:v", String(preset.profile));
  }
  if (preset.codec === "h264" && preset.profile) {
    args.push("-profile:v", String(preset.profile));
  }
  const pixFmt = preset.pixel_format || (preset.alpha ? "yuva420p" : "yuv420p");
  args.push("-pix_fmt", pixFmt);
  if (preset.width && preset.height) args.push("-s", `${preset.width}x${preset.height}`);
  if (preset.fps) args.push("-r", String(preset.fps));
  const acodec = preset.audio_codec;
  if (acodec) {
    if (acodec === "pcm_s16le") args.push("-c:a", "pcm_s16le");
    else args.push("-c:a", acodec);
  }
  if (opts.duration) args.push("-t", String(opts.duration));
  if (opts.extra) args.push(...opts.extra);
  if (CONTAINER_FORMAT[preset.container]) args.push("-f", CONTAINER_FORMAT[preset.container]);
  if (opts.output) args.push(String(opts.output));
  return args;
}

function outputExtension(preset) {
  return CONTAINER_EXT[preset.container] || "mp4";
}

/**
 * Filter presets by consumer kind.
 * kind: "fcp" (ProRes mov) | "pp" (H.264 mp4) | "webm" (alpha overlay webm) |
 *       "vertical" (9:16) | "overlay" (alpha) | "all" / null.
 */
function presetsByKind(kind) {
  if (!kind || kind === "all") return { ...PRESETS };
  const out = {};
  for (const [id, preset] of Object.entries(PRESETS)) {
    let match = false;
    switch (kind) {
      case "fcp":
        match = preset.container === "mov" && preset.codec === "prores_ks" && !preset.alpha;
        break;
      case "pp":
        match = preset.container === "mp4" && preset.codec === "h264";
        break;
      case "webm":
        match = preset.container === "webm";
        break;
      case "overlay":
        match = preset.alpha === true;
        break;
      case "vertical":
        match = preset.height > preset.width;
        break;
      default:
        return null;
    }
    if (match) out[id] = preset;
  }
  return out;
}

module.exports = {
  PRESETS,
  PRESET_IDS,
  REQUIRED_FIELDS,
  CODEC_FFMPEG,
  CONTAINER_FORMAT,
  CONTAINER_EXT,
  getPreset,
  validatePreset,
  ffmpegArgs,
  outputExtension,
  presetsByKind,
};
