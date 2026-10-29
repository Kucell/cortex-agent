"use strict";

// compact.js — 历史压缩为上下文摘要（提案 P2 / §10.2）
//
// 把按 history.jsonl 范式写入的多轮交互事件，压缩为一个稳定、低本的
// 上下文摘要，供 host 在长会话中替代「原文回放」，直接省下历史 token。
//
// history.jsonl 写入范式（§10.2）：
//   每行一个 JSON 事件，必含 { ts, role, kind, text }。
//     - role: user | assistant | system | tool
//     - kind: message | tool_call | tool_result | decision | error
//   本脚本同时提供 `append` 子命令以原子方式追加一行（供 host/agent 调用）。
//
// 用法：
//   node compact.js append  --file <history.jsonl> --role user --kind message --text "..."
//   node compact.js run     --file <history.jsonl> [--max-events N] [--out <compact.json>] [--dry-run]
//   node compact.js schema  [--out compact.schema.json]
//
// 压缩策略（零依赖启发式，不调用 LLM）：
//   1. 抽取所有 kind=decision 事件作为 key_decisions；
//   2. 抽取未闭合的 tool_call（无对应 tool_result）作为 open_threads；
//   3. 对 message 文本做去噪 + 截断，拼成 summary；
//   4. estimated_tokens 用与 select.js 一致的 tokenize 启发式估算。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCHEMA_VERSION = "1.0";
const VALID_ROLES = new Set(["user", "assistant", "system", "tool"]);
const VALID_KINDS = new Set(["message", "tool_call", "tool_result", "decision", "error"]);

function usage() {
  console.log(`Usage:
  node compact.js append  --file <history.jsonl> --role <user|assistant|system|tool> --kind <message|tool_call|tool_result|decision|error> --text "..."
  node compact.js run     --file <history.jsonl> [--max-events N] [--out <compact.json>] [--dry-run]
  node compact.js schema  [--out compact.schema.json]
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { args[key] = true; continue; }
    args[key] = next;
    i += 1;
  }
  return args;
}

function fail(message, details) {
  console.error(JSON.stringify({ ok: false, error: message, details: details || {} }, null, 2));
  process.exit(1);
}

function tokenize(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = text.replace(/[\u4e00-\u9fff]/g, "").length;
  return Math.ceil(cjk / 1.5 + latin / 4);
}

function resolveFile(file) {
  return path.resolve(process.cwd(), file);
}

function appendEvent(args) {
  const file = resolveFile(requireArg(args, "file"));
  const role = requireArg(args, "role");
  const kind = requireArg(args, "kind");
  const text = requireArg(args, "text");
  if (!VALID_ROLES.has(role)) fail("Invalid role", { role, valid: Array.from(VALID_ROLES) });
  if (!VALID_KINDS.has(kind)) fail("Invalid kind", { kind, valid: Array.from(VALID_KINDS) });

  const event = { ts: new Date().toISOString(), role, kind, text };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = `${JSON.stringify(event)}\n`;
  // 原子追加：写临时文件再 rename，避免并发截断。
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, line);
  fs.appendFileSync(file, line);
  fs.unlinkSync(tmp);

  if (args.quiet) return;
  console.log(JSON.stringify({ ok: true, action: "append", file: path.relative(process.cwd(), file), bytes: Buffer.byteLength(line) }, null, 2));
}

function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try { return JSON.parse(l); }
      catch (e) { return { ts: null, role: "unknown", kind: "message", text: `[unparseable line ${i + 1}]`, _error: e.message }; }
    });
}

function requireArg(args, key) {
  if (!args[key]) fail(`Missing required --${key}`);
  return args[key];
}

function compact(events, options) {
  const opts = options || {};
  const maxEvents = Number.isInteger(opts.maxEvents) ? opts.maxEvents : events.length;
  const window = events.slice(-maxEvents);

  const decisions = window.filter((e) => e.kind === "decision").map((e) => String(e.text).slice(0, 200));
  const toolCalls = window.filter((e) => e.kind === "tool_call");
  const toolResults = new Set(window.filter((e) => e.kind === "tool_result").map((e) => String(e.text).slice(0, 60)));
  const openThreads = toolCalls
    .filter((e) => !toolResults.has(String(e.text).slice(0, 60)))
    .map((e) => String(e.text).slice(0, 160));

  const messages = window
    .filter((e) => e.kind === "message" || e.kind === "error")
    .map((e) => `[${e.role}] ${e.text}`)
    .join("\n");

  const summaryLines = [];
  if (decisions.length) summaryLines.push("Key decisions:\n- " + decisions.join("\n- "));
  if (openThreads.length) summaryLines.push("Open threads:\n- " + openThreads.join("\n- "));
  if (messages) summaryLines.push("Conversation:\n" + messages.slice(0, 4000));
  const summary = summaryLines.join("\n\n") || "(no events)";

  const prevRef = opts.prevCompactRef || null;
  const estTokens = tokenize(summary) + decisions.length * 8 + openThreads.length * 8;

  return {
    schema_version: SCHEMA_VERSION,
    compacted_at: new Date().toISOString(),
    source_events: window.length,
    summary,
    key_decisions: decisions,
    open_threads: openThreads,
    estimated_tokens: estTokens,
    prev_compact_ref: prevRef,
  };
}

function runCompact(args) {
  const file = resolveFile(requireArg(args, "file"));
  const events = readEvents(file);
  const result = compact(events, {
    maxEvents: args["max-events"] ? Number(args["max-events"]) : undefined,
    prevCompactRef: args["prev-ref"] || null,
  });

  if (args["dry-run"]) {
    console.log(JSON.stringify({ ok: true, action: "run", dry_run: true, ...result }, null, 2));
    return;
  }

  const out = args.out ? resolveFile(args.out) : path.join(path.dirname(file), "compact.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  if (args.quiet) return;
  console.log(JSON.stringify({
    ok: true,
    action: "run",
    source_events: result.source_events,
    estimated_tokens: result.estimated_tokens,
    out: path.relative(process.cwd(), out),
  }, null, 2));
}

function emitSchema(args) {
  const schema = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Context Compact Summary",
    "type": "object",
    "required": ["schema_version", "compacted_at", "source_events", "summary"],
    "properties": {
      "schema_version": { "type": "string", "const": "1.0" },
      "compacted_at": { "type": "string", "format": "date-time" },
      "source_events": { "type": "integer", "minimum": 0 },
      "summary": { "type": "string", "minLength": 1 },
      "key_decisions": { "type": "array", "items": { "type": "string" } },
      "open_threads": { "type": "array", "items": { "type": "string" } },
      "estimated_tokens": { "type": "integer", "minimum": 0 },
      "prev_compact_ref": { "type": ["string", "null"] }
    },
    "additionalProperties": false,
  };
  const out = args.out ? resolveFile(args.out) : path.join(__dirname, "compact.schema.json");
  fs.writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, action: "schema", out: path.relative(process.cwd(), out) }, null, 2));
}

function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (command === "append") return appendEvent(args);
  if (command === "run") return runCompact(args);
  if (command === "schema") return emitSchema(args);
  usage();
  process.exit(command ? 1 : 0);
}

module.exports = { tokenize, readEvents, compact, appendEvent, runCompact, SCHEMA_VERSION };

if (require.main === module) main();
