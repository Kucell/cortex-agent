"use strict";

// ─── Memory CLI (M-002 MS-002) ────────────────────────────────────────────────
//
// `cortex-agent memory <recall|distill> [options]` — entry point for the
// memory subsystem. Mirrors `lib/coordination/cli.js` and `lib/dispatch-cli.js`
// patterns: thin argv parser + exit-code mapping, with all business logic
// delegated to `recall.js` / `distill.js`.
//
// Wired from `bin/cli.js` via direct require (per FAE-001 / M-013.P0 pattern —
// avoids touching `lib/commands.js` which is a binding contract).
//
// Exit codes:
//   - 0: success
//   - 2: usage error (missing required arg, bad flag)
//   - 3: plan/recall failed with --fail-on-conflict, or distill failed rollback
//
// Subcommand surface (matches templates/general/.agent/workflows/{memory-recall,memory-distill}.md):
//
//   memory recall <query> [--limit 5] [--type episodic,semantic,procedural]
//                       [--min-confidence 0.3] [--project <path>]
//                       [--output json|human] [--include-expired]
//
//   memory distill [--source sessions|conversations] [--since <ISO>]
//                 [--max-records 20] [--type episodic,semantic]
//                 [--candidates <file>] [--project <path>]
//                 [--output json|human] [--run-id <id>]

const path = require("node:path");
const fs = require("node:fs");
const { recall } = require("./recall");
const { distill } = require("./distill");
const { parseTypeList, TYPES, ALL_TYPES, WRITABLE_TYPES } = require("./types");
const { ALL_SCOPES, isValidScope } = require("./types");
const { listAllMemories } = require("./store");

// ─── argv parsing ────────────────────────────────────────────────────────────

function parseArgs(args) {
  const out = {
    subcommand: null,
    query: null,
    projectRoot: null,
    outputFormat: "human",
    outputJson: false,
    showHelp: false,
    fix: false,
    yes: false,
    // recall-specific
    limit: 5,
    minConfidence: 0,
    includeExpired: false,
    scope: null,            // P-007 §3.1: null = all scopes
    // distill-specific
    source: "sessions",
    since: null,
    maxRecords: 20,
    candidatesFile: null,
    runId: null,
  };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      out.showHelp = true;
      continue;
    }
    if (arg === "--fix") {
      out.fix = true;
      continue;
    }
    if (arg === "--yes") {
      out.yes = true;
      continue;
    }
    if (arg === "--json") {
      out.outputJson = true;
      out.outputFormat = "json";
      continue;
    }
    if (arg === "--output") {
      const v = args[i + 1];
      if (v === "json" || v === "human") {
        out.outputFormat = v;
        out.outputJson = v === "json";
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--output=")) {
      const v = arg.slice("--output=".length);
      if (v === "json" || v === "human") {
        out.outputFormat = v;
        out.outputJson = v === "json";
      }
      continue;
    }
    if (arg === "--project") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out.projectRoot = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--project=")) {
      out.projectRoot = arg.slice("--project=".length);
      continue;
    }
    if (arg === "--limit") {
      const v = args[i + 1];
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) {
        out.limit = n;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0) out.limit = n;
      continue;
    }
    if (arg === "--min-confidence") {
      const v = args[i + 1];
      const n = Number(v);
      if (Number.isFinite(n)) {
        out.minConfidence = n;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--min-confidence=")) {
      const n = Number(arg.slice("--min-confidence=".length));
      if (Number.isFinite(n)) out.minConfidence = n;
      continue;
    }
    if (arg === "--include-expired") {
      out.includeExpired = true;
      continue;
    }
    if (arg === "--scope") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        if (!isValidScope(v)) {
          throw new Error(
            `memory recall error: invalid scope "${v}". Valid: ${ALL_SCOPES.join(", ")}.`
          );
        }
        out.scope = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--scope=")) {
      const v = arg.slice("--scope=".length);
      if (!isValidScope(v)) {
        throw new Error(
          `memory recall error: invalid scope "${v}". Valid: ${ALL_SCOPES.join(", ")}.`
        );
      }
      out.scope = v;
      continue;
    }
    if (arg === "--source") {
      const v = args[i + 1];
      if (v === "sessions" || v === "conversations") {
        out.source = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--source=")) {
      const v = arg.slice("--source=".length);
      if (v === "sessions" || v === "conversations") out.source = v;
      continue;
    }
    if (arg === "--since") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out.since = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--since=")) {
      out.since = arg.slice("--since=".length);
      continue;
    }
    if (arg === "--max-records") {
      const v = args[i + 1];
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) {
        out.maxRecords = n;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--max-records=")) {
      const n = Number(arg.slice("--max-records=".length));
      if (Number.isFinite(n) && n > 0) out.maxRecords = n;
      continue;
    }
    if (arg === "--candidates") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out.candidatesFile = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--candidates=")) {
      out.candidatesFile = arg.slice("--candidates=".length);
      continue;
    }
    if (arg === "--run-id") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out.runId = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--run-id=")) {
      out.runId = arg.slice("--run-id=".length);
      continue;
    }
    if (arg && arg.startsWith("--type")) {
      // Will be re-parsed by subcommand for proper error context
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out._typeFlag = v;
        i++;
      } else {
        out._typeFlag = "";
      }
      continue;
    }
    if (arg && arg.startsWith("--type=")) {
      out._typeFlag = arg.slice("--type=".length);
      continue;
    }
    if (arg && arg.startsWith("--")) {
      // Unknown flag: ignore (keep surface permissive; matches FAE-001 rule)
      continue;
    }
    positional.push(arg);
  }
  out.subcommand = positional[0] || null;
  out.query = positional.slice(1).join(" ");
  return out;
}

// ─── formatters ──────────────────────────────────────────────────────────────

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printHumanRecall(result) {
  const lines = [];
  lines.push(`memory recall query="${result.query}" types=${result.types.join(",")}`);
  lines.push(`scanned=${result.scanned} matched=${result.matched} returned=${result.returned}`);
  if (result.expired_skipped > 0) lines.push(`expired_skipped=${result.expired_skipped}`);
  if (result.low_confidence_skipped > 0) lines.push(`low_confidence_skipped=${result.low_confidence_skipped}`);
  lines.push("");
  for (const m of result.memories) {
    lines.push(`- ${m.memory_id} (${m.type}, conf=${m.confidence}, score=${m.score})`);
    if (m.title) lines.push(`    title: ${m.title}`);
    if (m.content) {
      const preview = m.content.length > 200 ? m.content.slice(0, 197) + "..." : m.content;
      lines.push(`    content: ${preview}`);
    }
    if (m.tags && m.tags.length > 0) lines.push(`    tags: ${m.tags.join(", ")}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printHumanDistill(result) {
  const lines = [];
  lines.push(`memory distill run_id=${result.run_id} source=${result.source}`);
  lines.push(`scanned=${result.scanned} written=${result.written.length} skipped=${result.skipped.length}`);
  if (result.error) {
    lines.push(`ERROR: ${result.error.code} — ${result.error.message}`);
  } else if (result.written.length > 0) {
    for (const w of result.written) {
      lines.push(`- wrote ${w.memory_id} (${w.type})`);
    }
  } else {
    lines.push("(no candidates — LLM extraction deferred to MS-004)");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printHelp() {
  const help = `Usage:
  cortex-agent memory recall <query> [options]
  cortex-agent memory distill [options]
  cortex-agent memory validate [--fix] [--yes] [--output json]
                                 [--project <path>]


Recall options:
  --limit <n>            Max results to return (1-50, default 5)
  --type <list>          Comma-separated types: episodic,semantic,procedural
                         (default: all)
  --scope <name>         P-007 §3.1: filter by scope; one of
                          user,project,skill,runtime,global
                          (default: all; legacy entries without scope
                          are treated as 'project')
  --min-confidence <n>   Minimum confidence threshold 0-1 (default 0)
  --include-expired      Include expired entries in results
  --project <path>       Target project root (default: cwd)
  --output json|human    Output format (default: human)
  --json                 Shortcut for --output json

Distill options:
  --source sessions|conversations   Source directory (default: sessions)
  --since <ISO>                     Only distill records since timestamp
  --max-records <n>                 Cap on source records to scan (default 20)
  --type <list>                     Comma-separated types: episodic,semantic
                                   (procedural deferred to v1.12)
  --candidates <file>               JSON file with pre-extracted candidates
                                   (LLM extraction deferred to MS-004)
  --run-id <id>                     Explicit run id (default: auto-gen)
  --project <path>                  Target project root (default: cwd)
  --output json|human               Output format (default: human)
  --json                            Shortcut for --output json

Exit codes:
  0  success
  2  usage error (missing arg, bad flag)
  3  distill rollback or plan conflict

Examples:
  cortex-agent memory recall "decision style" --limit 3
  cortex-agent memory recall "FAE-001" --type episodic,semantic --min-confidence 0.5
  cortex-agent memory recall "user prefers Chinese" --scope user --limit 3
  cortex-agent memory recall "M-025 phase B" --scope runtime
  cortex-agent memory distill --source sessions --since 2026-08-01T00:00:00Z
  cortex-agent memory distill --candidates ./candidates.json --json
`;
  process.stdout.write(help);
}

// ─── subcommand: recall ──────────────────────────────────────────────────────

function runRecall(parsed, lang) {
  if (parsed.query == null || parsed.query === "") {
    const usage = lang === "zh"
      ? "用法: memory recall <query> [--limit 5] [--type episodic,semantic,procedural] [...]\n错误: <query> required"
      : "Usage: memory recall <query> [--limit 5] [--type episodic,semantic,procedural] [...]\nError: <query> required";
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  const root = parsed.projectRoot ? path.resolve(parsed.projectRoot) : process.cwd();
  let types;
  try {
    types = parsed._typeFlag !== undefined ? parseTypeList(parsed._typeFlag) : [...ALL_TYPES];
  } catch (error) {
    process.stderr.write(`memory recall error: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  let result;
  try {
  result = recall({
    projectRoot: root,
    query: parsed.query,
    limit: parsed.limit,
    types,
    minConfidence: parsed.minConfidence,
    includeExpired: parsed.includeExpired,
    scope: parsed.scope,
  });
  } catch (error) {
    process.stderr.write(`memory recall error: ${error.message}\n`);
    process.exitCode = 3;
    return;
  }

  if (parsed.outputJson) {
    printJson(result);
  } else {
    printHumanRecall(result);
  }
  process.exitCode = 0;
}

// ─── subcommand: distill ─────────────────────────────────────────────────────

function loadCandidates(filePath) {
  if (!filePath) return [];
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    const err = new Error(`--candidates file not found: ${abs}`);
    err.code = "ERR_CANDIDATES_FILE_NOT_FOUND";
    throw err;
  }
  const raw = fs.readFileSync(abs, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const err = new Error(`--candidates file is not valid JSON: ${error.message}`);
    err.code = "ERR_CANDIDATES_FILE_INVALID_JSON";
    err.cause = error;
    throw err;
  }
  if (!Array.isArray(parsed)) {
    const err = new Error("--candidates file must be a JSON array");
    err.code = "ERR_CANDIDATES_NOT_ARRAY";
    throw err;
  }
  return parsed;
}

function autoRunId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `R-memory-distill-${ts}`;
}

function runDistill(parsed, lang) {
  const root = parsed.projectRoot ? path.resolve(parsed.projectRoot) : process.cwd();

  let types;
  try {
    types = parsed._typeFlag !== undefined ? parseTypeList(parsed._typeFlag) : [...WRITABLE_TYPES];
  } catch (error) {
    process.stderr.write(`memory distill error: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  // Filter out procedural if user requested it (not writable in MS-002)
  const writable = types.filter((t) => WRITABLE_TYPES.includes(t));
  if (writable.length === 0) {
    const usage = lang === "zh"
      ? "错误: procedural memory 写操作推到 v1.12,本任务只支持 episodic / semantic"
      : "Error: procedural memory write is deferred to v1.12; this command supports episodic and semantic only.";
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }

  let candidates = [];
  try {
    candidates = loadCandidates(parsed.candidatesFile);
  } catch (error) {
    process.stderr.write(`memory distill error: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  // Hard cap per --max-records (defensive; mostly relevant when LLM extraction
  // is wired in MS-004 and returns more than asked).
  if (candidates.length > parsed.maxRecords) {
    candidates = candidates.slice(0, parsed.maxRecords);
  }

  const runId = parsed.runId || autoRunId();
  let result;
  try {
    result = distill({
      projectRoot: root,
      runId,
      candidates,
      source: parsed.source,
      since: parsed.since,
    });
  } catch (error) {
    process.stderr.write(`memory distill error: ${error.message}\n`);
    process.exitCode = 3;
    return;
  }

  if (parsed.outputJson) {
    printJson(result);
  } else {
    printHumanDistill(result);
  }
  // Exit 0 on success, 3 on rollback (per memory-distill.md §3)
  process.exitCode = result.error ? 3 : 0;
}

// ─── dispatcher entry point ──────────────────────────────────────────────────

function memoryCommand(ctx) {
  // ctx.args is process.argv.slice(2) starting with "memory" itself.
  // Strip the leading "memory" so parseArgs sees subcommand + args.
  const rawArgs = Array.isArray(ctx.args) ? ctx.args : [];
  const args = rawArgs[0] === "memory" ? rawArgs.slice(1) : rawArgs;
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (parsed.showHelp || !parsed.subcommand) {
    printHelp();
    process.exitCode = parsed.showHelp ? 0 : 2;
    if (!parsed.subcommand && !parsed.showHelp) {
      process.stderr.write("Error: subcommand required (recall|distill|validate)\n");
    }
    return;
  }

  if (parsed.subcommand === "recall") {
    return runRecall(parsed, ctx.lang);
  }
  if (parsed.subcommand === "distill") {
    return runDistill(parsed, ctx.lang);
  }
  if (parsed.subcommand === "validate") {
    return runMemoryValidate(parsed, ctx);
  }

  // Unknown subcommand
  process.stderr.write(`Error: unknown memory subcommand "${parsed.subcommand}". Valid: recall, distill, validate.\n`);
  printHelp();
  process.exitCode = 2;
}

// memory validate (T-ISSUE-2 / M-MEM-VAL-001)
async function runMemoryValidate(parsed, ctx) {
  const memoryValidate = require("../memory-validate");
  const fix = parsed.fix;
  const yes = parsed.yes;
  const json = parsed.outputJson;
  const cwd = ctx.cwd || process.cwd();
  const projectRoot = parsed.projectRoot ? path.resolve(cwd, parsed.projectRoot) : cwd;
  const memoryRoot = path.join(projectRoot, ".agent", "memory");
  const result = memoryValidate.validateMemory({ projectRoot, memoryRoot });
  if (!result.ok) {
    process.stderr.write(`memory validate: ${result.reason}\n`);
    process.exitCode = 1;
    return;
  }
  if (result.issues.length === 0) {
    printValidatePayload({ json, result, memoryRoot });
    process.exitCode = 0;
    return;
  }
  if (!fix) {
    printValidatePayload({ json, result, memoryRoot });
    process.stderr.write(
      "\nRun with --fix to auto-fix drift/orphan/duplicate.\n" +
      "missing / schema / over-cap are NOT auto-fixable (see proposal §3.4).\n"
    );
    process.exitCode = 1;
    return;
  }
  const plan = memoryValidate.buildFixPlan(result.parsed, result.issues, memoryRoot);
  if (!json) {
    printHumanValidateReport(result);
    printHumanFixPlan(plan);
  }
  if (!yes) {
    if (json) printValidatePayload({ json, result, memoryRoot, plan });
    process.stderr.write("\nRefusing to mutate MEMORY.md without --yes.\n");
    process.exitCode = 2;
    return;
  }
  const apply = memoryValidate.applyFixPlan(result.parsed, plan, { confirm: true });
  if (apply.ok) {
    const after = memoryValidate.validateMemory({ projectRoot, memoryRoot });
    if (json) printValidatePayload({ json, result, memoryRoot, plan, apply, after });
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`applyFixPlan failed\n`);
  process.exitCode = 1;
}

function printValidatePayload({ json, result, memoryRoot, plan, apply, after }) {
  if (!json) {
    printHumanValidateReport(result);
    return;
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    issues: result.issues,
    summary: result.summary,
    memoryRoot,
    ...(plan ? { plan } : {}),
    ...(apply ? { apply: { ok: apply.ok, applied: apply.applied } } : {}),
    ...(after ? { after: { issues: after.issues, summary: after.summary } } : {}),
  }, null, 2) + "\n");
}

function printHumanValidateReport(result) {
  if (result.issues.length === 0) {
    process.stdout.write("memory validate: ok (no issues)\n");
    return;
  }
  process.stdout.write(`memory validate: ${result.issues.length} issue(s) found\n`);
  for (const issue of result.issues) {
    const locator = issue.line
      ? `${issue.path || "MEMORY.md"}:${issue.line}`
      : (issue.path || issue.type);
    process.stdout.write(`  - ${issue.kind}: ${locator}  ${issue.detail}\n`);
  }
  const s = result.summary;
  process.stdout.write(`summary: drift=${s.drift}, missing=${s.missing}, schema=${s.schema}, orphan=${s.orphan}, duplicate=${s.duplicate}, over-cap=${s["over-cap"]}\n`);
}

function printHumanFixPlan(plan) {
  if (!plan.ok) {
    process.stdout.write(`fix plan: ${plan.reason}\n`);
    return;
  }
  if (plan.edits.length === 0 && plan.skipReasons.length === 0) {
    process.stdout.write("fix plan: no auto-fixable edits\n");
    return;
  }
  process.stdout.write(`fix plan: ${plan.edits.length} edit(s), ${plan.skipReasons.length} skip(s)\n`);
  for (const edit of plan.edits) {
    process.stdout.write(`  - ${edit.kind} @ line ${edit.line}: ${edit.summary}\n`);
    if (edit.before) process.stdout.write(`    -: ${edit.before}\n`);
    if (edit.after) process.stdout.write(`    +: ${edit.after}\n`);
  }
  for (const skip of plan.skipReasons) {
    process.stdout.write(`  skip: ${skip.reason}\n`);
  }
}

module.exports = {
  memoryCommand,
  parseArgs,
  // exposed for tests
  _runRecall: runRecall,
  _runDistill: runDistill,
};
