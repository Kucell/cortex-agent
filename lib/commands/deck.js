"use strict";

// ─── deck — /deck workflow CLI surface (P-003 MS-001) ────────────────────────
//
// `cortex-agent deck <task-id> [--format <fmt>] [--template <id>] [--lang <zh|en>]`
//
// Generates a slide deck artifact at .agent/artifacts/<task-id>/deck/ in one or
// more formats. Default formats: html + pptx + md. Content resolution:
//
//   1. <cwd>/.agent/<task-id>/deck-brief.json   (if present, use as-is)
//   2. <cwd>/.agent/decks/<task-id>.json         (alt location)
//   3. Otherwise: 4-slide starter generated from task-id
//
// Exit codes (frozen, per proposal):
//   0  success
//   1  generic error
//   2  user error (invalid args, malformed brief)
//   3  no brief resolvable (when --require-brief is set)
//
// Boundaries:
//   In scope: argv parsing, brief resolution, dispatch to lib/templates/{pptx,
//             html-deck, md-deck}, writing artifacts + validation-contract.
//   Out of scope: subprocess spawning, network sockets, credential access.

const fs = require("node:fs");
const path = require("node:path");

const { buildPptx } = require("../templates/pptx");
const { buildHtmlDeck } = require("../templates/html-deck");
const { buildMdDeck } = require("../templates/md-deck");
const { pixsoDslFileToBrief } = require("../templates/pixso-deck-adapter");
const { openDesignHtmlFileToBrief } = require("../templates/open-design-deck-adapter");

const VALID_FORMATS = new Set(["html", "pptx", "md", "all"]);
const VALID_TEMPLATES = new Set(["default-deck"]);

function printDeckHelp(isZh) {
  const text = isZh
    ? `\n用法:cortex-agent deck <task-id> [options]\n\n` +
      `生成幻灯片 artifact (P-003 MS-001)。零依赖,产出 HTML / PPTX / Markdown。\n\n` +
      `选项:\n` +
      `  --format <html|pptx|md|all>    输出格式(默认 all)\n` +
      `  --template <id>                模板 id(默认 default-deck,本版本仅支持该模板)\n` +
      `  --lang <zh|en>                 语言(默认 zh)\n` +
      `  --output-dir <path>            自定义输出目录(默认 .agent/artifacts/<task-id>/deck/)\n` +
      `  --from-pixso <dsl.json>         从 Pixso get_node_dsl JSON 生成 brief(优先于 deck-brief.json)\n` +
      `  --from-open-design <html>       从 Open Design 渲染产物 HTML 生成 brief(同优先级)\n` +
      `  --require-brief                没有 deck-brief.json 时报错(退出码 3)\n` +
      `  --help                         显示本帮助\n\n` +
      `Brief 解析顺序:\n` +
      `  1. --from-pixso <dsl.json>   (Pixso 稿 → slide,见 pixso-deck-adapter)\n` +
      `  2. --from-open-design <html> (Open Design 产物 → slide,见 open-design-deck-adapter)\n` +
      `  3. <cwd>/.agent/<task-id>/deck-brief.json\n` +
      `  4. <cwd>/.agent/decks/<task-id>.json\n` +
      `  5. 否则使用默认 4 页 starter\n`
    : `\nUsage: cortex-agent deck <task-id> [options]\n\n` +
      `Generate slide deck artifact (P-003 MS-001). Zero-dep; outputs HTML / PPTX / Markdown.\n\n` +
      `Options:\n` +
      `  --format <html|pptx|md|all>    Output format (default: all)\n` +
      `  --template <id>                Template id (default: default-deck; only one supported)\n` +
      `  --lang <zh|en>                 Language (default: zh)\n` +
      `  --output-dir <path>            Override output directory\n` +
      `  --from-pixso <dsl.json>        Build brief from a Pixso get_node_dsl JSON (beats deck-brief.json)\n` +
      `  --from-open-design <html>      Build brief from an Open Design rendered HTML artifact\n` +
      `  --require-brief                Fail (exit 3) when no deck-brief.json is found\n` +
      `  --help                         Show this help\n\n` +
      `Brief resolution order:\n` +
      `  1. --from-pixso <dsl.json>    (Pixso design → slides, see pixso-deck-adapter)\n` +
      `  2. --from-open-design <html>  (Open Design artifact → slides)\n` +
      `  3. <cwd>/.agent/<task-id>/deck-brief.json\n` +
      `  4. <cwd>/.agent/decks/<task-id>.json\n` +
      `  5. Default 4-slide starter\n`;
  console.log(text);
}

function parseDeckArgs(args, lang) {
  // When invoked from bin/cli.js: args = ["deck", <task-id>, --flags...]
  // When invoked directly from a test: args = [<task-id>, --flags...]
  // Detect by peeking: if args[0] === "deck", drop it.
  let argv = args;
  if (argv[0] === "deck") argv = argv.slice(1);

  const taskId = argv[0];
  const opts = {
    taskId,
    format: "all",
    template: "default-deck",
    lang: lang || "zh",
    outputDir: null,
    requireBrief: false,
    fromPixso: null,
    fromOpenDesign: null,
    showHelp: taskId === "--help" || taskId === "-h",
  };

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.showHelp = true;
    else if (a === "--require-brief") opts.requireBrief = true;
    else if (a === "--format" && argv[i + 1]) {
      opts.format = argv[++i];
    } else if (a.startsWith("--format=")) {
      opts.format = a.slice("--format=".length);
    } else if (a === "--template" && argv[i + 1]) {
      opts.template = argv[++i];
    } else if (a.startsWith("--template=")) {
      opts.template = a.slice("--template=".length);
    } else if (a === "--lang" && argv[i + 1]) {
      opts.lang = argv[++i];
    } else if (a.startsWith("--lang=")) {
      opts.lang = a.slice("--lang=".length);
    } else if (a === "--output-dir" && argv[i + 1]) {
      opts.outputDir = path.resolve(argv[++i]);
    } else if (a.startsWith("--output-dir=")) {
      opts.outputDir = path.resolve(a.slice("--output-dir=".length));
    } else if (a === "--from-pixso" && argv[i + 1]) {
      opts.fromPixso = path.resolve(argv[++i]);
    } else if (a.startsWith("--from-pixso=")) {
      opts.fromPixso = path.resolve(a.slice("--from-pixso=".length));
    } else if (a === "--from-open-design" && argv[i + 1]) {
      opts.fromOpenDesign = path.resolve(argv[++i]);
    } else if (a.startsWith("--from-open-design=")) {
      opts.fromOpenDesign = path.resolve(a.slice("--from-open-design=".length));
    }
  }

  return opts;
}

function resolveBrief(taskId, cwd) {
  const candidates = [
    path.join(cwd, ".agent", taskId, "deck-brief.json"),
    path.join(cwd, ".agent", "decks", `${taskId}.json`),
  ];
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw);
      return { source: candidate, brief: parsed };
    } catch (_) {
      // not found or malformed — try next
    }
  }
  return null;
}

function buildStarterBrief(taskId, lang) {
  const isZh = lang !== "en";
  return {
    title: taskId,
    author: "cortex-agent",
    subject: taskId,
    lang: isZh ? "zh-CN" : "en",
    slides: [
      {
        title: isZh ? `项目:${taskId}` : `Project: ${taskId}`,
        subtitle: isZh ? "自动生成的起始 deck" : "Auto-generated starter deck",
        bullets: isZh
          ? ["替换为真实内容", "运行 /deck 重新生成", "或提供 .agent/<task-id>/deck-brief.json"]
          : ["Replace with real content", "Re-run /deck to regenerate", "Or supply .agent/<task-id>/deck-brief.json"],
      },
      {
        title: isZh ? "现状" : "Context",
        body: isZh ? "编辑 deck-brief.json 来定制 deck 内容。" : "Edit deck-brief.json to customize the deck content.",
      },
      {
        title: isZh ? "下一步" : "Next steps",
        bullets: isZh
          ? ["/prototype --mode doc  产出文档原型", "/prototype --mode ui   产出 UI 原型", "/arch-design           进入架构提案"]
          : ["/prototype --mode doc  Produce doc prototype", "/prototype --mode ui   Produce UI prototype", "/arch-design           Enter architecture proposal"],
      },
      {
        title: isZh ? "参考" : "Reference",
        body: "P-003 /deck · MS-001 · cortex-agent design chain",
      },
    ],
  };
}

function normalizeBrief(rawBrief, taskId) {
  const brief = { ...rawBrief };
  if (!brief.title) brief.title = taskId;
  if (!brief.author) brief.author = "cortex-agent";
  if (!Array.isArray(brief.slides) || brief.slides.length === 0) {
    throw new Error(`deck-brief.json must contain non-empty "slides" array`);
  }
  brief.slides.forEach((s, i) => {
    if (typeof s !== "object" || s === null) {
      throw new Error(`deck-brief.json slides[${i}] must be an object`);
    }
    if (!s.title) s.title = `Slide ${i + 1}`;
  });
  return brief;
}

function buildValidationContract(opts, brief, outputDir, formats, generated) {
  return {
    type: "validation_contract",
    workflow: "deck",
    workflow_ref: "P-003 design-workflow-chain / MS-001",
    task_id: opts.taskId,
    template: opts.template,
    lang: opts.lang,
    brief_source: opts.briefSource || "(starter)",
    output_dir: outputDir,
    formats: generated,
    slide_count: brief.slides.length,
    slide_titles: brief.slides.map((s) => s.title),
    notes: [
      "PPTX produced via lib/templates/pptx.js (zero npm deps).",
      "HTML is single-file with inlined CSS — print-to-PDF via browser.",
      "MD is a Markdown summary suitable for README / speaker notes.",
      "Validation: every format regenerates byte-identical for the same brief.",
    ],
    produced_at: new Date().toISOString(),
  };
}

async function deckCommand(ctx) {
  const { args, cwd, lang } = ctx;
  const opts = parseDeckArgs(args || [], lang);

  if (opts.showHelp || !opts.taskId) {
    printDeckHelp(lang === "zh");
    return opts.taskId ? 0 : 2;
  }
  if (!VALID_TEMPLATES.has(opts.template)) {
    console.error(`[cortex-agent] ✗ unknown template: ${opts.template}`);
    console.error(`  Valid: ${[...VALID_TEMPLATES].join(", ")}`);
    return 2;
  }
  if (!VALID_FORMATS.has(opts.format)) {
    console.error(`[cortex-agent] ✗ invalid --format: ${opts.format}`);
    console.error(`  Valid: ${[...VALID_FORMATS].join(", ")}`);
    return 2;
  }

  let brief;
  if (opts.fromPixso) {
    // Pixso get_node_dsl JSON → deck-brief (path B: design → deck bridge).
    try {
      brief = normalizeBrief(pixsoDslFileToBrief(opts.fromPixso, { lang: opts.lang }), opts.taskId);
      opts.briefSource = `pixso-dsl:${opts.fromPixso}`;
    } catch (err) {
      console.error(`[cortex-agent] ✗ --from-pixso failed: ${err.message}`);
      return 2;
    }
    console.log(`[cortex-agent] ✓ brief built from Pixso DSL (${brief.slides.length} slides) — ${opts.fromPixso}`);
  } else if (opts.fromOpenDesign) {
    // Open Design rendered HTML artifact → deck-brief (path C).
    try {
      brief = normalizeBrief(
        openDesignHtmlFileToBrief(opts.fromOpenDesign, { lang: opts.lang }),
        opts.taskId,
      );
      opts.briefSource = `open-design-html:${opts.fromOpenDesign}`;
    } catch (err) {
      console.error(`[cortex-agent] ✗ --from-open-design failed: ${err.message}`);
      return 2;
    }
    console.log(`[cortex-agent] ✓ brief built from Open Design artifact (${brief.slides.length} slides) — ${opts.fromOpenDesign}`);
  } else {
    const resolved = resolveBrief(opts.taskId, cwd);
    if (resolved) {
      try {
        brief = normalizeBrief(resolved.brief, opts.taskId);
        opts.briefSource = resolved.source;
      } catch (err) {
        console.error(`[cortex-agent] ✗ malformed brief at ${resolved.source}: ${err.message}`);
        return 2;
      }
      console.log(`[cortex-agent] ✓ brief loaded from ${path.relative(cwd, resolved.source)}`);
    } else if (opts.requireBrief) {
      console.error(`[cortex-agent] ✗ --require-brief set; no deck-brief.json found for ${opts.taskId}`);
      return 3;
    } else {
      brief = buildStarterBrief(opts.taskId, opts.lang);
      console.log(`[cortex-agent] ⚠ no deck-brief.json; using starter`);
    }
  }

  const outputDir = opts.outputDir || path.join(cwd, ".agent", "artifacts", opts.taskId, "deck");
  fs.mkdirSync(outputDir, { recursive: true });

  const requested = opts.format === "all" ? ["html", "pptx", "md"] : [opts.format];
  const generated = {};

  for (const fmt of requested) {
    if (fmt === "html") {
      const html = buildHtmlDeck({
        slides: brief.slides,
        meta: {
          title: brief.title,
          author: brief.author,
          subject: brief.subject,
          lang: brief.lang,
        },
        options: { theme: "default" },
      });
      const htmlPath = path.join(outputDir, "deck.html");
      fs.writeFileSync(htmlPath, html, "utf8");
      generated.html = { path: htmlPath, bytes: Buffer.byteLength(html, "utf8") };
    } else if (fmt === "pptx") {
      const buffer = buildPptx({
        slides: brief.slides,
        meta: {
          title: brief.title,
          author: brief.author,
          company: brief.company || "",
          subject: brief.subject || "",
        },
      });
      const pptxPath = path.join(outputDir, "deck.pptx");
      fs.writeFileSync(pptxPath, buffer);
      generated.pptx = { path: pptxPath, bytes: buffer.length };
    } else if (fmt === "md") {
      const md = buildMdDeck({
        slides: brief.slides,
        meta: {
          title: brief.title,
          author: brief.author,
          subject: brief.subject,
        },
      });
      const mdPath = path.join(outputDir, "deck.md");
      fs.writeFileSync(mdPath, md, "utf8");
      generated.md = { path: mdPath, bytes: Buffer.byteLength(md, "utf8") };
    }
  }

  const vc = buildValidationContract(opts, brief, outputDir, requested, generated);
  const vcPath = path.join(outputDir, "validation-contract.json");
  fs.writeFileSync(vcPath, JSON.stringify(vc, null, 2), "utf8");

  console.log(`[cortex-agent] ✓ deck written to ${path.relative(cwd, outputDir) || outputDir}`);
  for (const fmt of Object.keys(generated)) {
    const entry = generated[fmt];
    console.log(`  · ${fmt.padEnd(5)} ${path.relative(cwd, entry.path)}  (${entry.bytes} bytes)`);
  }
  console.log(`  · vc    validation-contract.json`);

  return 0;
}

module.exports = {
  deckCommand,
  // exposed for tests
  _internal: {
    parseDeckArgs,
    resolveBrief,
    buildStarterBrief,
    normalizeBrief,
    buildValidationContract,
    VALID_FORMATS,
    VALID_TEMPLATES,
  },
};
