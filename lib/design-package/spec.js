"use strict";

// ─── spec — design-package input contract + arg parsing (SamHMI pilot) ───────
//
// Owns parsing of:
//
//   cortex-agent design-package <task-id> --from-pixso <dsl.json>
//       [--system <id>] [--template <id>] [--entry <name.html>]
//       [--lang zh|en] [--output-dir <path>] [--zip] [--preview] [--json]
//
// Exit codes (frozen for this pipeline):
//   0 success / 1 generic / 2 user error (bad args, missing/invalid DSL,
//   output traversal attempt)
//
// This module is pure parsing + validation. It never touches the filesystem
// except loading the requested Pixso DSL JSON (via readDslFile) and resolving
// the output directory against cwd (which stays inside the project).

const fs = require("node:fs");
const path = require("node:path");

const VALID_LANGS = new Set(["zh", "en"]);
const VALID_TEMPLATES = new Set(["samhmi-editor", "default"]);

const ENTRY_DEFAULT = "samhmi-editor.html";

function parseArgs(args, lang, cwd) {
  // args from bin/cli.js: ["design-package", <task-id>, --flags...]
  // or from tests: [<task-id>, --flags...]
  // `cwd` is the command context working directory (defaults to process.cwd())
  // so relative --from-pixso / --output-dir resolve against the project that
  // actually invokes the command, not the process's CWD.
  const base = cwd || process.cwd();
  let argv = args;
  if (argv[0] === "design-package") argv = argv.slice(1);

  const taskId = argv[0];
  const opts = {
    taskId,
    fromPixso: null,
    system: null,
    template: "samhmi-editor",
    entry: ENTRY_DEFAULT,
    lang: lang || "zh",
    outputDir: null,
    zip: false,
    preview: false,
    json: false,
    showHelp: taskId === "--help" || taskId === "-h",
  };

  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      opts.showHelp = true;
    } else if (a === "--zip") {
      opts.zip = true;
    } else if (a === "--preview") {
      opts.preview = true;
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "--from-pixso" && argv[i + 1]) {
      opts.fromPixso = path.resolve(base, argv[++i]);
    } else if (a.startsWith("--from-pixso=")) {
      opts.fromPixso = path.resolve(base, a.slice("--from-pixso=".length));
    } else if (a === "--system" && argv[i + 1]) {
      opts.system = argv[++i];
    } else if (a.startsWith("--system=")) {
      opts.system = a.slice("--system=".length);
    } else if (a === "--template" && argv[i + 1]) {
      opts.template = argv[++i];
    } else if (a.startsWith("--template=")) {
      opts.template = a.slice("--template=".length);
    } else if (a === "--entry" && argv[i + 1]) {
      opts.entry = argv[++i];
    } else if (a.startsWith("--entry=")) {
      opts.entry = a.slice("--entry=".length);
    } else if (a === "--lang" && argv[i + 1]) {
      opts.lang = argv[++i];
    } else if (a.startsWith("--lang=")) {
      opts.lang = a.slice("--lang=".length);
    } else if (a === "--output-dir" && argv[i + 1]) {
      opts.outputDir = path.resolve(base, argv[++i]);
    } else if (a.startsWith("--output-dir=")) {
      opts.outputDir = path.resolve(base, a.slice("--output-dir=".length));
    }
  }
  return opts;
}

// Reject path traversal in artifact `entry` filenames: only a plain
// basename with a .html suffix is accepted.
function validateEntry(entry) {
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error("design-package: --entry must be a non-empty filename");
  }
  if (entry !== path.basename(entry)) {
    throw new Error(`design-package: --entry must be a plain filename (no path): ${entry}`);
  }
  if (!entry.endsWith(".html")) {
    throw new Error(`design-package: --entry must end with .html: ${entry}`);
  }
  return entry;
}

function validateLang(lang) {
  if (!VALID_LANGS.has(lang)) {
    throw new Error(`design-package: --lang must be zh|en (got "${lang}")`);
  }
  return lang;
}

function validateTemplate(template) {
  if (!VALID_TEMPLATES.has(template)) {
    throw new Error(
      `design-package: unknown --template "${template}". Valid: ${[...VALID_TEMPLATES].join(", ")}`,
    );
  }
  return template;
}

// Resolve a path to the real path of its nearest existing ancestor, then
// re-append any non-existing suffix. This canonicalizes symlink aliases
// (e.g. macOS /tmp → /private/tmp) while keeping the final logical path.
function canonicalizePath(filePath) {
  let current = path.resolve(filePath);
  const suffix = [];
  while (true) {
    try {
      const real = fs.realpathSync(current);
      return path.join(real, ...suffix.reverse());
    } catch (_) {
      const parent = path.dirname(current);
      if (parent === current) break;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(filePath);
}

// Output directory must stay inside the project (no traversal out of cwd).
// Containment is checked on canonical (realpath-normalized) paths so that
// symlink aliases of a path physically inside the project are accepted,
// while paths that genuinely escape the project are still rejected.
function resolveOutputDir(outputDir, taskId, cwd) {
  const base = outputDir || path.join(cwd, ".agent", "artifacts", taskId, "package");
  const resolved = path.resolve(base);
  const root = path.resolve(cwd);
  const canonicalResolved = canonicalizePath(resolved);
  const canonicalRoot = canonicalizePath(root);
  if (
    canonicalResolved !== canonicalRoot &&
    !canonicalResolved.startsWith(canonicalRoot + path.sep)
  ) {
    throw new Error(
      `design-package: output dir escapes project root: ${resolved}`,
    );
  }
  return resolved;
}

function readDslFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`design-package: cannot read --from-pixso ${filePath}: ${err.message}`);
  }
  let dsl;
  try {
    dsl = JSON.parse(raw);
  } catch (err) {
    throw new Error(`design-package: --from-pixso ${filePath} is not valid JSON: ${err.message}`);
  }
  return validateDsl(dsl);
}

// Minimal deterministic validation of the compact Pixso DSL contract.
function validateDsl(dsl) {
  if (!dsl || typeof dsl !== "object") {
    throw new Error('design-package: Pixso DSL must be an object with a non-empty "roots" array');
  }
  if (!Array.isArray(dsl.roots) || dsl.roots.length === 0) {
    throw new Error('design-package: Pixso DSL must contain a non-empty "roots" array');
  }
  return dsl;
}

function printHelp(isZh) {
  const text = isZh
    ? `\n用法:cortex-agent design-package <task-id> --from-pixso <dsl.json> [options]\n\n` +
      `从 Pixso compact DSL 生成 Open Design 风格设计资源包(P-00X pilot)。\n` +
      `产物默认位于 .agent/artifacts/<task-id>/package/:\n` +
      `  <entry>              可运行单文件 HTML(SamHMI 桌面工作台外壳)\n` +
      `  brand-spec.md        设计规范(色板 / 字体 / 状态语义)\n` +
      `  <entry>.artifact.json Open Design v1 风格元数据\n` +
      `  validation-contract.json  本产线的验收契约\n\n` +
      `选项:\n` +
      `  --from-pixso <dsl.json>   必填:Pixso get_node_dsl compact 输出\n` +
      `  --system <id>             (可选)已安装 design-system id(只读校验)\n` +
      `  --template <id>           模板 id(默认 samhmi-editor;可用 default)\n` +
      `  --entry <name.html>       输出入口文件名(默认 samhmi-editor.html)\n` +
      `  --lang <zh|en>            语言(默认 zh)\n` +
      `  --output-dir <path>       覆盖输出目录(必须仍在项目内)\n` +
      `  --zip                     额外生成零依赖 STORE zip\n` +
      `  --preview                 尝试生成预览;本机无 Chromium 时优雅降级为“不支持”\n` +
      `  --json                    以 JSON 输出摘要\n` +
      `  --help                    显示本帮助\n\n` +
      `退出码:0 成功 / 1 通用错误 / 2 用户错误(参数 / DSL / 越界输出)\n`
    : `\nUsage: cortex-agent design-package <task-id> --from-pixso <dsl.json> [options]\n\n` +
      `Build an Open Design-style design resource package from a Pixso compact DSL.\n` +
      `Default output: .agent/artifacts/<task-id>/package/\n` +
      `  <entry>              runnable single-file HTML (SamHMI desktop shell)\n` +
      `  brand-spec.md        design spec (colors / fonts / state semantics)\n` +
      `  <entry>.artifact.json  Open Design v1-style metadata\n` +
      `  validation-contract.json  acceptance contract\n\n` +
      `Options:\n` +
      `  --from-pixso <dsl.json>   Required: Pixso get_node_dsl compact output\n` +
      `  --system <id>            (Optional) installed design-system id (read-only check)\n` +
      `  --template <id>          Template id (default samhmi-editor; or default)\n` +
      `  --entry <name.html>      Output entry filename (default samhmi-editor.html)\n` +
      `  --lang <zh|en>           Language (default zh)\n` +
      `  --output-dir <path>      Override output dir (must stay inside project)\n` +
      `  --zip                    Also emit a zero-dep STORE zip\n` +
      `  --preview                Try preview; gracefully degrades to unsupported\n` +
      `  --json                   Emit a JSON summary\n` +
      `  --help                   Show this help\n\n` +
      `Exit codes: 0 success / 1 generic / 2 user error (args / DSL / traversal)\n`;
  console.log(text);
}

module.exports = {
  parseArgs,
  validateEntry,
  validateLang,
  validateTemplate,
  resolveOutputDir,
  readDslFile,
  validateDsl,
  printHelp,
  ENTRY_DEFAULT,
  VALID_LANGS,
  VALID_TEMPLATES,
};
