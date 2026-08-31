"use strict";

// ─── image — /image workflow CLI surface (P-003 §4.3) ────────────────────────
//
// `cortex-agent image <task-id> [--prompt "<text>"]
//                            [--model gpt-image-2|seedream-5.0|nano-banana-2.0]
//                            [--aspect 1:1|16:9|9:16]
//                            [--count 1]`
//
// Generates an image generation artifact at:
//   .agent/artifacts/<task-id>/images/
//   ├── prompt.md                 full prompt text + metadata
//   ├── manifest.json             od-image/v1 manifest (NO plaintext key)
//   ├── validation-contract.json  matching P-003 acceptance contract
//   └── README.md                 how to plug a BYOK key + actually render
//
// Exit codes (frozen, per proposal):
//   0  success
//   1  generic error
//   2  user error (invalid args)
//
// IMPORTANT: This command does NOT call any external API. It generates a
// prompt + manifest + README that an external BYOK routing layer (out of
// scope for the zero-dep CLI) can pick up to actually call the image
// generation provider. This keeps the CLI deterministic, zero-dep, and safe
// to run in CI. See lib/byok/registry.js for the credential probe that fills
// manifest.byok.keyRef when a key file is present.
//
// Boundaries:
//   In scope: argv parsing, prompt.md templating, manifest construction with
//             od-image/v1 schema, BYOK probe via lib/byok/registry, README
//             generation, validation contract.
//   Out of scope: network sockets, real provider calls, key value emission,
//                 image rendering, subprocess spawning.

const fs = require("node:fs");
const path = require("node:path");

const byok = require("../byok/registry");

const VALID_MODELS = new Set(["gpt-image-2", "seedream-5.0", "nano-banana-2.0"]);
const VALID_ASPECTS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4"]);

function modelProvider(model) {
  // Map the model id to the BYOK provider id. Kept explicit (no inference)
  // so we can change provider boundaries without surprises.
  switch (model) {
    case "gpt-image-2": return "openai";
    case "seedream-5.0": return "seedream";
    case "nano-banana-2.0": return "nano_banana";
    default: return null;
  }
}

function printImageHelp(isZh) {
  const text = isZh
    ? `\n用法:cortex-agent image <task-id> [options]\n\n` +
      `生成图像 prompt + manifest (P-003 §4.3)。零依赖,零网络调用;BYOK 实际生成由外部路由负责。\n\n` +
      `选项:\n` +
      `  --prompt "<text>"            提示词(默认:基于 task-id 生成占位文本)\n` +
      `  --model <gpt-image-2|seedream-5.0|nano-banana-2.0>  模型(默认 gpt-image-2)\n` +
      `  --aspect <1:1|16:9|9:16|4:3|3:4>   画幅比例(默认 1:1)\n` +
      `  --count <n>                  生成张数(默认 1;最大 4)\n` +
      `  --output-dir <path>          自定义输出目录(默认 .agent/artifacts/<task-id>/images/)\n` +
      `  --help                       显示本帮助\n\n` +
      `BYOK 配置路径:\n` +
      `  ~/.config/cortex-agent/byok/<provider>.env  (本命令仅探测,不修改你的 shell 环境)`
    : `\nUsage: cortex-agent image <task-id> [options]\n\n` +
      `Generate image prompt + manifest (P-003 §4.3). Zero-dep, zero network;\n` +
      `actual BYOK routing is handled by an external layer.\n\n` +
      `Options:\n` +
      `  --prompt "<text>"            Prompt text (default: placeholder derived from task-id)\n` +
      `  --model <gpt-image-2|seedream-5.0|nano-banana-2.0>  Model (default: gpt-image-2)\n` +
      `  --aspect <1:1|16:9|9:16|4:3|3:4>   Aspect ratio (default: 1:1)\n` +
      `  --count <n>                  Number of outputs (default 1; max 4)\n` +
      `  --output-dir <path>          Override output directory\n` +
      `  --help                       Show this help\n\n` +
      `BYOK config location:\n` +
      `  ~/.config/cortex-agent/byok/<provider>.env  (probed, not modified)`;
  console.log(text);
}

function parseImageArgs(args, lang) {
  // When invoked from bin/cli.js: args = ["image", <task-id>, --flags...]
  // When invoked directly from a test: args = [<task-id>, --flags...]
  // Detect by peeking: if args[0] === "image", drop it.
  let argv = args;
  if (argv[0] === "image") argv = argv.slice(1);

  const taskId = argv[0];
  const opts = {
    taskId,
    prompt: null,
    model: "gpt-image-2",
    aspect: "1:1",
    count: 1,
    outputDir: null,
    lang: lang || "zh",
    showHelp: taskId === "--help" || taskId === "-h",
  };

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.showHelp = true;
    else if (a === "--prompt" && argv[i + 1]) {
      opts.prompt = argv[++i];
    } else if (a.startsWith("--prompt=")) {
      opts.prompt = a.slice("--prompt=".length);
    } else if (a === "--model" && argv[i + 1]) {
      opts.model = argv[++i];
    } else if (a.startsWith("--model=")) {
      opts.model = a.slice("--model=".length);
    } else if (a === "--aspect" && argv[i + 1]) {
      opts.aspect = argv[++i];
    } else if (a.startsWith("--aspect=")) {
      opts.aspect = a.slice("--aspect=".length);
    } else if (a === "--count" && argv[i + 1]) {
      opts.count = Number(argv[++i]);
    } else if (a.startsWith("--count=")) {
      opts.count = Number(a.slice("--count=".length));
    } else if (a === "--output-dir" && argv[i + 1]) {
      opts.outputDir = path.resolve(argv[++i]);
    } else if (a.startsWith("--output-dir=")) {
      opts.outputDir = path.resolve(a.slice("--output-dir=".length));
    }
  }

  return opts;
}

function defaultPrompt(taskId, model, aspect, count, isZh) {
  const head = isZh
    ? "# 自动生成的图像提示词"
    : "# Auto-generated image prompt";
  const ctx = isZh
    ? "项目: " + taskId + "\n模型: " + model + "\n画幅: " + aspect + "\n数量: " + count
    : "Task: " + taskId + "\nModel: " + model + "\nAspect: " + aspect + "\nCount: " + count;
  const placeholder = isZh
    ? "请用一段描述性英文提示词替换本段。 建议覆盖:主体 / 场景 / 风格 / 光线 / 镜头 / 色调 / 构图。\n\n" +
      "Subject: a hero illustration for " + taskId + "\n" +
      "Style: cinematic, soft volumetric light, minimal palette\n" +
      "Composition: rule of thirds, generous negative space\n" +
      "Mood: confident, calm"
    : "Replace this with a descriptive prompt covering subject / scene /\n" +
      "style / lighting / lens / palette / composition.\n\n" +
      "Subject: a hero illustration for " + taskId + "\n" +
      "Style: cinematic, soft volumetric light, minimal palette\n" +
      "Composition: rule of thirds, generous negative space\n" +
      "Mood: confident, calm";
  return [head, "", ctx, "", placeholder].join("\n") + "\n";
}

function buildManifest(opts, byokRecord) {
  return {
    schema: "od-image/v1",
    workflow: "image",
    workflow_ref: "P-003 design-workflow-chain / §4.3",
    task_id: opts.taskId,
    model: opts.model,
    aspect: opts.aspect,
    count: opts.count,
    prompt: {
      text: opts.prompt,
      // Length is bytes for the prompt text — useful for downstream sanity
      // checks (e.g. seedream imposes limits, gpt-image-2 has soft caps).
      bytes: Buffer.byteLength(opts.prompt || "", "utf8"),
    },
    outputs: Array.from({ length: opts.count }, (_, i) => ({
      index: i,
      status: "pending",
      // Renderer fills this once the BYOK route has produced the file.
      file: null,
    })),
    byok: {
      provider: modelProvider(opts.model),
      keyRef: byokRecord && byokRecord.present ? byokRecord.keyRef : null,
      configured: !!(byokRecord && byokRecord.present),
      // Diagnostic fields — never include the actual key value.
      probe: byokRecord
        ? {
            configPath: byokRecord.configPath,
            present: byokRecord.present,
            reason: byokRecord.reason,
          }
        : null,
    },
    fetched_at: null,
    produced_at: new Date().toISOString(),
  };
}

function buildPromptMd(opts) {
  const head = opts.lang === "en" ? "Image Prompt" : "图像提示词";
  const lines = [
    "# " + head + ": " + opts.taskId,
    "",
    "- " + (opts.lang === "en" ? "Model" : "模型") + ": `" + opts.model + "`",
    "- " + (opts.lang === "en" ? "Aspect" : "画幅") + ": `" + opts.aspect + "`",
    "- " + (opts.lang === "en" ? "Count" : "数量") + ": `" + opts.count + "`",
    "- " + (opts.lang === "en" ? "Produced" : "生成时间") + ": " + new Date().toISOString(),
    "",
    "## " + (opts.lang === "en" ? "Prompt" : "提示词正文"),
    "",
    opts.prompt,
  ];
  return lines.join("\n");
}

function buildReadme(opts, byokRecord) {
  const isZh = opts.lang !== "en";
  const provider = modelProvider(opts.model);
  const byokPath = byok.defaultConfigRoot() + "/byok/" + provider + ".env";
  const t = [];
  if (isZh) {
    t.push("# 图像 artifact 实际生成说明");
    t.push("");
    t.push("本目录由 `cortex-agent image` 生成, 仅产出 prompt + manifest + 占位说明;");
    t.push("实际调用图像生成 API 需要在 BYOK 路径下放置凭证文件后, 由外部路由完成。");
    t.push("");
    t.push("## 1. 放置 BYOK 凭证");
    t.push("");
    t.push("```bash");
    t.push("mkdir -p " + path.dirname(byokPath));
    t.push("cat > " + byokPath + " <<'EOF'");
    const def = byok.PROVIDERS[provider];
    const keys = def ? def.keys : ["<KEY>"];
    t.push(keys[0] + "=<your-key>");
    t.push("EOF");
    t.push("# 权限建议 0600");
    t.push("chmod 600 " + byokPath);
    t.push("```");
    t.push("");
    t.push("## 2. 触发实际生成");
    t.push("");
    t.push("由 BYOK 路由层(超出本 CLI 范围)读取 manifest.json + prompt.md, 调");
    t.push("用对应的 provider API, 把结果写回本目录的 outputs[<index>].file。");
    t.push("完成后回填 manifest.outputs[*].status = 'ready' 与 manifest.fetched_at。");
    t.push("");
    t.push("## 3. 当前状态");
    t.push("");
    t.push("- 模型: `" + opts.model + "`");
    t.push("- BYOK provider: `" + provider + "`");
    t.push("- BYOK configured: `" + (byokRecord && byokRecord.present ? "yes" : "no") + "`");
    if (byokRecord && !byokRecord.present) {
      t.push("- BYOK 缺失原因: `" + (byokRecord.reason || "unknown") + "`");
    }
    t.push("- Prompt bytes: `" + Buffer.byteLength(opts.prompt || "", "utf8") + "`");
    t.push("");
    t.push("## 4. 不修改 shell 环境");
    t.push("");
    t.push("本命令不会触碰 ~/.zshrc / ~/.bashrc / process.env; BYOK 文件就足够。");
  } else {
    t.push("# Image Artifact — Actual Generation Notes");
    t.push("");
    t.push("This directory is produced by `cortex-agent image` and only contains");
    t.push("the prompt + manifest + README. Actual generation requires placing");
    t.push("a credential file at the BYOK path below; the external route picks");
    t.push("it up from there.");
    t.push("");
    t.push("## 1. Drop your BYOK credential");
    t.push("");
    t.push("```bash");
    t.push("mkdir -p " + path.dirname(byokPath));
    t.push("cat > " + byokPath + " <<'EOF'");
    const def = byok.PROVIDERS[provider];
    const keys = def ? def.keys : ["<KEY>"];
    t.push(keys[0] + "=<your-key>");
    t.push("EOF");
    t.push("# recommend 0600");
    t.push("chmod 600 " + byokPath);
    t.push("```");
    t.push("");
    t.push("## 2. Trigger actual generation");
    t.push("");
    t.push("The BYOK route (out of scope for this CLI) reads manifest.json and");
    t.push("prompt.md, calls the provider, writes outputs back into this");
    t.push("directory, then updates manifest.outputs[*].status and");
    t.push("manifest.fetched_at.");
    t.push("");
    t.push("## 3. Current state");
    t.push("");
    t.push("- Model: `" + opts.model + "`");
    t.push("- BYOK provider: `" + provider + "`");
    t.push("- BYOK configured: `" + (byokRecord && byokRecord.present ? "yes" : "no") + "`");
    if (byokRecord && !byokRecord.present) {
      t.push("- BYOK missing reason: `" + (byokRecord.reason || "unknown") + "`");
    }
    t.push("- Prompt bytes: `" + Buffer.byteLength(opts.prompt || "", "utf8") + "`");
    t.push("");
    t.push("## 4. No shell environment mutation");
    t.push("");
    t.push("This command never touches ~/.zshrc / ~/.bashrc / process.env; the");
    t.push("BYOK file at the path above is sufficient.");
  }
  return t.join("\n") + "\n";
}

function buildValidationContract(opts, outputDir, generated) {
  return {
    type: "validation_contract",
    workflow: "image",
    workflow_ref: "P-003 design-workflow-chain / §4.3",
    task_id: opts.taskId,
    model: opts.model,
    aspect: opts.aspect,
    count: opts.count,
    byok_configured: !!(generated.byokRecord && generated.byokRecord.present),
    output_dir: outputDir,
    files: generated.files,
    notes: [
      "CLI does not call any external API; prompt + manifest + README are emitted for an external BYOK route.",
      "manifest.byok.keyRef references the credential file by stable id; the key value is NEVER included.",
      "Re-running with the same arguments regenerates a byte-identical manifest (sans produced_at).",
    ],
    produced_at: new Date().toISOString(),
  };
}

async function imageCommand(ctx) {
  const { args, cwd, lang } = ctx;
  const opts = parseImageArgs(args || [], lang);

  if (opts.showHelp || !opts.taskId) {
    printImageHelp(lang === "zh");
    return opts.taskId ? 0 : 2;
  }
  if (!VALID_MODELS.has(opts.model)) {
    console.error("[cortex-agent] ✗ unknown --model: " + opts.model);
    console.error("  Valid: " + [...VALID_MODELS].join(", "));
    process.exitCode = 2;
    return 2;
  }
  if (!VALID_ASPECTS.has(opts.aspect)) {
    console.error("[cortex-agent] ✗ invalid --aspect: " + opts.aspect);
    console.error("  Valid: " + [...VALID_ASPECTS].join(", "));
    process.exitCode = 2;
    return 2;
  }
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > 4) {
    console.error("[cortex-agent] ✗ invalid --count: " + opts.count + " (must be integer 1..4)");
    process.exitCode = 2;
    return 2;
  }

  // Default prompt when the user omits --prompt. The placeholder is a
  // short Markdown block with explicit guidance so the user knows what to
  // fill in.
  const isZh = opts.lang !== "en";
  if (!opts.prompt || opts.prompt.trim() === "") {
    opts.prompt = defaultPrompt(opts.taskId, opts.model, opts.aspect, opts.count, isZh);
  }

  const provider = modelProvider(opts.model);
  const byokRecord = byok.probeProvider(provider);

  const outputDir = opts.outputDir || path.join(cwd, ".agent", "artifacts", opts.taskId, "images");
  fs.mkdirSync(outputDir, { recursive: true });

  // 1) prompt.md
  const promptMd = buildPromptMd(opts);
  const promptPath = path.join(outputDir, "prompt.md");
  fs.writeFileSync(promptPath, promptMd, "utf8");

  // 2) manifest.json
  const manifest = buildManifest(opts, byokRecord);
  const manifestPath = path.join(outputDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  // 3) README.md
  const readme = buildReadme(opts, byokRecord);
  const readmePath = path.join(outputDir, "README.md");
  fs.writeFileSync(readmePath, readme, "utf8");

  // 4) validation-contract.json
  const generated = {
    files: {
      "prompt.md": { path: promptPath, bytes: Buffer.byteLength(promptMd, "utf8") },
      "manifest.json": { path: manifestPath, bytes: Buffer.byteLength(JSON.stringify(manifest), "utf8") },
      "README.md": { path: readmePath, bytes: Buffer.byteLength(readme, "utf8") },
    },
    byokRecord,
  };
  const vc = buildValidationContract(opts, outputDir, generated);
  const vcPath = path.join(outputDir, "validation-contract.json");
  fs.writeFileSync(vcPath, JSON.stringify(vc, null, 2), "utf8");

  console.log("[cortex-agent] ✓ image artifact written to " + (path.relative(cwd, outputDir) || outputDir));
  for (const k of Object.keys(generated.files)) {
    const entry = generated.files[k];
    console.log("  · " + k.padEnd(16) + " " + path.relative(cwd, entry.path) + "  (" + entry.bytes + " bytes)");
  }
  console.log("  · vc               validation-contract.json");
  if (!byokRecord.present) {
    console.log("");
    console.log(byok.guidanceForProvider(provider, isZh));
  }

  return 0;
}

module.exports = {
  imageCommand,
  // exposed for tests
  _internal: {
    parseImageArgs,
    buildManifest,
    buildPromptMd,
    buildReadme,
    buildValidationContract,
    defaultPrompt,
    modelProvider,
    VALID_MODELS,
    VALID_ASPECTS,
  },
};
