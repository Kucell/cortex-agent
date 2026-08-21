"use strict";

// ─── motion — `cortex-agent motion` CLI surface (P-005 MS-005) ───────────────
//
// 动效第 5 平面命令矩阵:
//   scaffold     脚手架起步(local starter → .agent/motion/<id>/,锁 index.html 一处)
//   style-tokens DESIGN.md → motion style tokens 编译(HARD-GATE 产物)
//   lint          hyperframes lint(静态校验,shell 直接跑)
//   check         hyperframes check(结构校验,shell 直接跑)
//   snapshot      proof 帧 contact-sheet(Chrome-bound → 缺失优雅指引)
//   preview       python3 http.server live reload(默认端口 4173)
//   render        渲染(用户门控:snapshot proof 帧确认后才渲染;daemon 路径 A 默认)
//   verify        ffprobe 质量门(时长/分辨率/帧率/codec/alpha)
//   presets       剪辑预设矩阵(fcp-4k / jianying-1080p / overlay-webm / …)
//   doctor        检测 Chrome + FFmpeg + hyperframes + open-design daemon
//
// Exit codes: 0 成功 / 1 运行时错误 / 2 用户参数错误。
// 零 npm 依赖;外部命令(open-design / npx / ffprobe / python3 / Chrome)经 spawn。

const path = require("node:path");
const readline = require("node:readline");

const styleTokens = require("../motion/style-tokens");
const editPresets = require("../motion/edit-presets");
const scaffold = require("../motion/scaffold");
const render = require("../motion/render");
const verify = require("../motion/verify");
const doctor = require("../motion/doctor");
const preview = require("../motion/preview");
const snapshot = require("../motion/snapshot");

const SUBCOMMANDS = Object.freeze([
  "scaffold",
  "style-tokens",
  "lint",
  "check",
  "snapshot",
  "preview",
  "render",
  "verify",
  "presets",
  "doctor",
]);

const PRESET_KINDS = Object.freeze(["fcp", "pp", "webm", "vertical", "overlay", "all"]);

function printHelp(lang) {
  const zh = lang === "zh";
  const t = zh
    ? [
        "用法: cortex-agent motion <subcommand> [options]",
        "",
        "动效第 5 平面(HyperFrames 引擎):品牌配色 → 生成 → 实时预览 → MP4 直接拖进剪辑。",
        "",
        "子命令:",
        "  scaffold       脚手架起步:  --motion-id <id> --template <kobe-lite|saas-hero|stat-counter> [--style <design-system-id>]",
        "  style-tokens   DESIGN.md → motion style tokens 编译(HARD-GATE 产物): --motion-id <id> [--design-system <id>] [--json]",
        "  lint           hyperframes lint 静态校验: --motion-id <id>",
        "  check          hyperframes check 结构校验: --motion-id <id>",
        "  snapshot       proof 帧 contact-sheet(依赖 headless Chrome): --motion-id <id>",
        "  preview        浏览器 live reload: --motion-id <id> [--port <n>]",
        "  render         渲染(用户门控,需 --yes 确认): --motion-id <id> --preset <id> [--yes]",
        "  verify         ffprobe 质量门: --motion-id <id> [--preset <id>]",
        "  presets        剪辑预设矩阵: [--kind fcp|pp|webm|vertical|overlay] [--json]",
        "  doctor         检测 Chrome/FFmpeg/hyperframes/open-design daemon [--json]",
        "",
        "Preset ids: fcp-1080p, fcp-4k, pp-1080p, pp-4k, jianying-1080p, vertical-9x16, overlay-webm, overlay-mov",
        "Exit codes: 0 成功 / 1 运行时错误 / 2 用户参数错误",
      ]
    : [
        "Usage: cortex-agent motion <subcommand> [options]",
        "",
        "Motion graphics 5th plane (HyperFrames engine): brand → generate → live preview → edit-ready MP4.",
        "",
        "Subcommands:",
        "  scaffold       --motion-id <id> --template <kobe-lite|saas-hero|stat-counter> [--style <design-system-id>]",
        "  style-tokens   DESIGN.md → motion style tokens (HARD-GATE): --motion-id <id> [--design-system <id>] [--json]",
        "  lint           hyperframes lint: --motion-id <id>",
        "  check          hyperframes check: --motion-id <id>",
        "  snapshot       proof contact-sheet (needs headless Chrome): --motion-id <id>",
        "  preview        browser live reload: --motion-id <id> [--port <n>]",
        "  render         user-gated render (needs --yes): --motion-id <id> --preset <id> [--yes]",
        "  verify         ffprobe quality gate: --motion-id <id> [--preset <id>]",
        "  presets        edit presets matrix: [--kind fcp|pp|webm|vertical|overlay] [--json]",
        "  doctor         detect Chrome/FFmpeg/hyperframes/open-design daemon [--json]",
        "",
        "Preset ids: fcp-1080p, fcp-4k, pp-1080p, pp-4k, jianying-1080p, vertical-9x16, overlay-webm, overlay-mov",
        "Exit codes: 0 ok / 1 runtime error / 2 user error",
      ];
  console.log(t.join("\n"));
}

// ─── arg parsing ─────────────────────────────────────────────────────────────

function parseMotionArgs(args) {
  // args may arrive as ["motion", <sub>, ...] (bin/cli.js) or [<sub>, ...] (tests).
  let argv = args;
  if (argv[0] === "motion") argv = argv.slice(1);
  const sub = argv[0];
  const opts = {
    sub,
    motionId: null,
    template: null,
    style: null,
    designSystem: null,
    preset: null,
    kind: null,
    port: null,
    json: false,
    yes: false,
    showHelp: sub === "--help" || sub === "-h",
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.showHelp = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--yes") opts.yes = true;
    else if (a === "--motion-id" && argv[i + 1]) opts.motionId = argv[++i];
    else if (a.startsWith("--motion-id=")) opts.motionId = a.slice("--motion-id=".length);
    else if (a === "--template" && argv[i + 1]) opts.template = argv[++i];
    else if (a.startsWith("--template=")) opts.template = a.slice("--template=".length);
    else if (a === "--style" && argv[i + 1]) opts.style = argv[++i];
    else if (a.startsWith("--style=")) opts.style = a.slice("--style=".length);
    else if (a === "--design-system" && argv[i + 1]) opts.designSystem = argv[++i];
    else if (a.startsWith("--design-system=")) opts.designSystem = a.slice("--design-system=".length);
    else if (a === "--preset" && argv[i + 1]) opts.preset = argv[++i];
    else if (a.startsWith("--preset=")) opts.preset = a.slice("--preset=".length);
    else if (a === "--kind" && argv[i + 1]) opts.kind = argv[++i];
    else if (a.startsWith("--kind=")) opts.kind = a.slice("--kind=".length);
    else if (a === "--port" && argv[i + 1]) opts.port = argv[++i];
    else if (a.startsWith("--port=")) opts.port = a.slice("--port=".length);
  }
  if (opts.port !== null) {
    const n = Number(opts.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) opts.portError = `invalid --port "${opts.port}"`;
  }
  return opts;
}

// ─── preset matrix printing ──────────────────────────────────────────────────

function presetsPayload(kind) {
  if (kind) {
    if (!PRESET_KINDS.includes(kind)) {
      return { error: `invalid --kind "${kind}" — valid: ${PRESET_KINDS.join(", ")}` };
    }
    return { presets: editPresets.presetsByKind(kind) };
  }
  return { presets: editPresets.PRESETS };
}

function printPresets(payload, json) {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, presets: payload.presets }, null, 2) + "\n");
    return;
  }
  const rows = Object.entries(payload.presets);
  console.log(`${"preset".padEnd(18)} ${"codec".padEnd(10)} ${"res".padEnd(12)} fps  alpha  container  description`);
  for (const [id, p] of rows) {
    const res = p.width && p.height ? `${p.width}x${p.height}` : "match";
    console.log(
      `${id.padEnd(18)} ${String(p.codec).padEnd(10)} ${res.padEnd(12)} ${String(p.fps).padEnd(4)} ${p.alpha ? "✓" : "—".padEnd(1)}     ${p.container.padEnd(9)}  ${p.description}`,
    );
  }
  console.log(`\n${rows.length} presets — 拖进剪辑即用: FCP(ProRes)/ Premiere(H.264)/ 剪映·CapCut(竖屏 H.264)/ overlay(VP9·ProRes 4444 alpha)`);
}

// ─── doctor printing ─────────────────────────────────────────────────────────

function printDoctor(result, json) {
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  const fmt = (dep) => (dep.ok ? `✓ ${dep.version ? dep.version : dep.path || "ok"}` : `✗ ${dep.hint || "missing"}`);
  console.log("motion doctor — 5th plane dependency check");
  console.log(`  node        ${fmt(result.deps.node)}`);
  console.log(`  chrome      ${fmt(result.deps.chrome)}`);
  console.log(`  ffmpeg      ${fmt(result.deps.ffmpeg)}`);
  console.log(`  hyperframes ${fmt(result.deps.hyperframes)}`);
  console.log(`  openDesign  ${fmt(result.deps.openDesign)}`);
  console.log(`  platform    ${result.platform.id}${result.platform.supported ? "" : " (unsupported for local render)"}`);
  for (const w of result.warnings) console.log(`  ⚠ ${w}`);
  console.log(result.ok ? "✓ motion plane ready to render" : "✗ missing dependencies — see hints above");
}

// ─── render user gate ────────────────────────────────────────────────────────

function confirmRender(opts) {
  // 渲染门控:用户门控动作(沿用 HyperFrames approve gate — P-005 §4.3)。
  if (opts.yes) return true;
  if (process.stdin && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question("已看 snapshot proof 帧?确认渲染 y/N: ", (answer) => {
        rl.close();
        resolve(/^y(es)?$/i.test(answer.trim()));
      });
    });
  }
  return false;
}

// ─── command dispatch ────────────────────────────────────────────────────────

async function motionCommand(ctx) {
  const { args, cwd, lang } = ctx;
  const opts = parseMotionArgs(args || []);

  if (opts.showHelp) {
    printHelp(lang);
    return 0;
  }
  if (!opts.sub || !SUBCOMMANDS.includes(opts.sub)) {
    printHelp(lang);
    process.exitCode = 2;
    return 2;
  }
  if (opts.portError) {
    console.error(`[motion] ✗ ${opts.portError}`);
    process.exitCode = 2;
    return 2;
  }

  const fail = (code, message) => {
    console.error(`[motion] ✗ ${message}`);
    process.exitCode = code;
    return code;
  };
  const ok = (message) => {
    console.log(`[motion] ✓ ${message}`);
    return 0;
  };

  try {
    switch (opts.sub) {
      case "doctor": {
        const result = await doctor.runDoctor({ cwd, env: process.env });
        printDoctor(result, opts.json);
        if (!result.ok) process.exitCode = 1;
        return result.ok ? 0 : 1;
      }
      case "presets": {
        const payload = presetsPayload(opts.kind);
        if (payload.error) return fail(2, payload.error);
        printPresets(payload, opts.json);
        return 0;
      }
      case "style-tokens": {
        const result = styleTokens.writeMotionTokens({
          cwd,
          motionId: opts.motionId,
          designSystemId: opts.designSystem,
          templateDir: ctx.templateDir,
        });
        if (opts.json) {
          process.stdout.write(JSON.stringify(result.tokens, null, 2) + "\n");
        } else {
          console.log(
            `[motion] ✓ motion style tokens → ${path.relative(cwd, result.path)} (derived_from ${result.tokens.derived_from.slice(0, 12)}…)`,
          );
        }
        return 0;
      }
      case "scaffold": {
        if (!opts.motionId) return fail(2, "scaffold 需要 --motion-id <id>");
        const result = scaffold.scaffoldComposition({
          cwd,
          motionId: opts.motionId,
          template: opts.template,
          style: opts.style,
          templateDir: ctx.templateDir,
        });
        console.log(`[motion] ✓ composition scaffolded → ${path.relative(cwd, result.compositionDir) || result.compositionDir}`);
        for (const f of result.files) console.log(`  · ${f}`);
        console.log("  只编辑 index.html 一处;其余文件由系统生成(锁定)。");
        console.log(`  · .gitignore → ${path.relative(cwd, result.gitignore)} (隐藏 .hyperframes-cache/)`);
        return 0;
      }
      case "lint":
      case "check": {
        if (!opts.motionId) return fail(2, `${opts.sub} 需要 --motion-id <id>`);
        const result = await verify.runCompositionCheck({
          cwd,
          motionId: opts.motionId,
          mode: opts.sub,
          env: process.env,
        });
        if (!result.ok) return fail(1, result.message);
        return ok(`hyperframes ${opts.sub} passed for ${opts.motionId}`);
      }
      case "snapshot": {
        if (!opts.motionId) return fail(2, "snapshot 需要 --motion-id <id>");
        const result = await snapshot.captureSnapshot({ cwd, motionId: opts.motionId, env: process.env });
        if (!result.ok) return fail(1, result.message);
        return ok(result.message);
      }
      case "preview": {
        if (!opts.motionId) return fail(2, "preview 需要 --motion-id <id>");
        const entry = preview.startPreview({ cwd, motionId: opts.motionId, port: opts.port, wait: false });
        if (!entry.ok) return fail(1, entry.message);
        console.log(`[motion] ✓ ${entry.message}`);
        // 保持进程存活直到 python3 http.server 退出(Ctrl-C);spawn 失败时优雅退出。
        await new Promise((resolve) => {
          entry.child.on("exit", resolve);
          entry.child.on("error", (err) => {
            console.error(`[motion] ✗ preview failed: ${err.message}`);
            process.exitCode = 1;
            resolve();
          });
        });
        return 0;
      }
      case "render": {
        if (!opts.motionId) return fail(2, "render 需要 --motion-id <id>");
        if (!opts.preset) return fail(2, "render 需要 --preset <id>(见 motion presets)");
        if (!editPresets.getPreset(opts.preset)) {
          return fail(2, `unknown --preset "${opts.preset}" — valid: ${editPresets.PRESET_IDS.join(", ")}`);
        }
        const confirmed = await confirmRender(opts);
        if (!confirmed) {
          return fail(
            2,
            "渲染是用户门控动作 — 先 `motion snapshot` 看 proof 帧,确认后用 --yes 渲染 (approve gate)",
          );
        }
        const result = await render.renderMotion({ cwd, motionId: opts.motionId, preset: opts.preset, env: process.env });
        if (!result.ok) return fail(1, result.message);
        return ok(result.message);
      }
      case "verify": {
        if (!opts.motionId) return fail(2, "verify 需要 --motion-id <id>");
        const result = await verify.verifyRender({
          cwd,
          motionId: opts.motionId,
          preset: opts.preset,
        });
        if (!result.ok) return fail(1, result.message);
        console.log(result.message);
        for (const c of result.checks) console.log(`  ✓ ${c}`);
        return 0;
      }
      default:
        printHelp(lang);
        process.exitCode = 2;
        return 2;
    }
  } catch (err) {
    return fail(1, err.message);
  }
}

module.exports = {
  motionCommand,
  // exposed for tests
  _internal: {
    parseMotionArgs,
    presetsPayload,
    printPresets,
    printDoctor,
    printHelp,
    confirmRender,
    SUBCOMMANDS,
    PRESET_KINDS,
  },
};
