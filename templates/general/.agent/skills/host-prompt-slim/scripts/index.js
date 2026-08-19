#!/usr/bin/env node
// ─── host-prompt-slim: generic host-side system-prompt slimming ──────────────
// Scans any JSON model catalog (cc-switch, opencodex, custom) for prompt-like
// fields (base_instructions / model_messages.instructions_template /
// system_prompt / systemPrompt / instructions / prompt), classifies segments
// (protocol keep / prose trim / persona drop), and can apply slimming with
// backup + atomic write + verification + rollback. Zero dependencies.
//
// Usage:
//   node index.js scan    --catalog <path>                         # per-model report
//   node index.js audit   --catalog <path> --model <slug> [--field <path>]
//   node index.js slim    --catalog <path> --model <slug> [--field <path>] [--yes]
//   node index.js rollback --catalog <path>
//
// --dry-run is the default for `slim`; pass --yes to actually write.
// Target model matching: --model matches slug, display_name or index.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const rules = require("./rules.js");

// ── token estimation (cjk/1.5 + latin/4 — matches lib/memory/select.js) ──────
function tokenize(s) {
  if (typeof s !== "string") return 0;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = s.replace(/[\u4e00-\u9fff]/g, "").length;
  return Math.ceil(cjk / 1.5 + latin / 4);
}

// ── catalog structure discovery ───────────────────────────────────────────────
const PROMPT_FIELDS = [
  "base_instructions",
  "system_prompt",
  "systemPrompt",
  "instructions",
  "prompt",
  "model_messages.instructions_template",
];

function getField(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setField(obj, dotted, value) {
  const keys = dotted.split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
}

function detectPromptFields(entry) {
  return PROMPT_FIELDS.filter((f) => {
    const v = getField(entry, f);
    return typeof v === "string" && v.length > 50;
  });
}

// Normalize any reasonable catalog shape to [{entry, id}].
function enumerateModels(data) {
  const out = [];
  const push = (id, entry) => out.push({ id, entry });
  if (Array.isArray(data)) {
    data.forEach((e, i) => push(String(e?.slug ?? e?.name ?? i), e));
  } else if (data && typeof data === "object") {
    for (const key of ["models", "model", "entries", "providers"]) {
      if (Array.isArray(data[key])) {
        data[key].forEach((e, i) => push(String(e?.slug ?? e?.name ?? `${key}[${i}]`), e));
        return out;
      }
    }
    // object map: { slug: entry } or { provider: { models: [...] } }
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object") {
        if (Array.isArray(v)) v.forEach((e, i) => push(String(e?.slug ?? `${k}[${i}]`), e));
        else if (v.models && Array.isArray(v.models))
          v.models.forEach((e, i) => push(String(e?.slug ?? `${k}[${i}]`), e));
        else if (typeof v === "object" && !Array.isArray(v) && typeof v.base_instructions !== "string")
          push(k, v); // nested single entry (no prompt field at top level)
      }
    }
    if (out.length === 0 && data.base_instructions) push("default", data);
  }
  return out;
}

// ── segmentation + classification ─────────────────────────────────────────────
// Splits prompt text into segments at `#` / `##` / `###` headings, classifies
// each by title, and rewrites bodies (keep verbatim / trim sentences / drop).
function segment(text) {
  const lines = text.split("\n");
  const segs = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.+)$/);
    if (m) {
      if (cur) segs.push(cur);
      cur = { heading: m[2].trim(), level: m[1].length, body: [] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      // preamble before first heading
      if (!segs[0] || segs[0].preamble === undefined) {
        segs.unshift({ heading: "", level: 0, body: [line], preamble: true });
      } else {
        segs[0].body.push(line);
      }
    }
  }
  if (cur) segs.push(cur);
  return segs;
}

function slimPrompt(text) {
  const segs = segment(text);
  const out = [];
  const report = [];
  for (const seg of segs) {
    const action = rules.classifyTitle(seg.heading);
    const body = seg.body.join("\n");
    const before = tokenize(body);
    const kept = rules.transformBody(action, body, seg.heading);
    if (kept.trim()) {
      const heading = seg.heading ? `${"#".repeat(Math.max(seg.level, 1))} ${seg.heading}` : "";
      out.push(heading ? `${heading}\n${kept}` : kept);
    }
    report.push({
      heading: seg.heading || "(preamble)",
      action,
      before_tokens: before,
      after_tokens: tokenize(kept),
    });
  }
  return { text: out.join("\n\n"), report };
}

// ── backup / atomic write / verification / rollback ───────────────────────────
function backupPath(catalog) {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  // ms + pid make concurrent same-second backups collision-free
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${catalog}.bak-slim-${ts}-${ms}-${process.pid}`;
}

function backup(catalog) {
  const b = backupPath(catalog);
  fs.copyFileSync(catalog, b);
  return b;
}

function atomicWrite(target, content) {
  const tmp = `${target}.tmp-slim-${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  fs.writeSync(fd, content);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, target);
}

function verifyJson(target) {
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("catalog is not a JSON object");
  return parsed;
}

function latestBackup(catalog) {
  const dir = path.dirname(catalog);
  const base = path.basename(catalog);
  const list = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.bak-slim-`))
    .sort()
    .reverse();
  return list.length ? path.join(dir, list[0]) : null;
}

function rollback(catalog) {
  const b = latestBackup(catalog);
  if (!b) return { ok: false, reason: "no .bak-slim-* backup found" };
  const before = fs.statSync(catalog).size;
  fs.copyFileSync(b, catalog);
  verifyJson(catalog);
  return { ok: true, restored_from: b, size_before: before, size_after: fs.statSync(catalog).size };
}

// ── find a model by slug / name / index ───────────────────────────────────────
function findModel(models, target) {
  const t = String(target);
  return models.find(
    (m) =>
      m.entry?.slug === t ||
      m.entry?.name === t ||
      m.entry?.display_name === t ||
      m.id === t,
  );
}

// ── command implementations ───────────────────────────────────────────────────
function cmdScan(catalogPath) {
  const data = verifyJson(catalogPath);
  const models = enumerateModels(data);
  const rows = [];
  for (const m of models) {
    const fields = detectPromptFields(m.entry);
    for (const f of fields) {
      const v = getField(m.entry, f);
      rows.push({
        model: m.entry?.slug ?? m.id,
        field: f,
        chars: v.length,
        tokens: tokenize(v),
        segments: segment(v).length,
      });
    }
  }
  rows.sort((a, b) => b.tokens - a.tokens);
  console.log(JSON.stringify({ catalog: catalogPath, models: models.length, prompt_fields: rows }, null, 2));
  return rows;
}

function cmdAudit(catalogPath, model, field) {
  const data = verifyJson(catalogPath);
  const models = enumerateModels(data);
  const m = findModel(models, model);
  if (!m) throw new Error(`model not found: ${model}`);
  const fields = field ? [field] : detectPromptFields(m.entry);
  if (!fields.length) throw new Error(`no prompt fields found for ${m.id}`);
  const result = { model: m.entry?.slug ?? m.id, fields: {} };
  for (const f of fields) {
    const v = getField(m.entry, f);
    const { text, report } = slimPrompt(v);
    result.fields[f] = {
      before_tokens: tokenize(v),
      after_tokens: tokenize(text),
      segments: report,
    };
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function cmdSlim(catalogPath, model, field, yes) {
  const data = verifyJson(catalogPath);
  const models = enumerateModels(data);
  const m = findModel(models, model);
  if (!m) throw new Error(`model not found: ${model}`);
  const fields = field ? [field] : detectPromptFields(m.entry);
  if (!fields.length) throw new Error(`no prompt fields found for ${m.id}`);

  let totalBefore = 0;
  let totalAfter = 0;
  for (const f of fields) totalBefore += tokenize(getField(m.entry, f));

  const preview = { model: m.entry?.slug ?? m.id, fields: {} };
  for (const f of fields) {
    const v = getField(m.entry, f);
    const { text, report } = slimPrompt(v);
    preview.fields[f] = { before_tokens: tokenize(v), after_tokens: tokenize(text), segments: report };
    totalAfter += tokenize(text);
  }

  if (!yes) {
    console.log(JSON.stringify({ dry_run: true, preview, total_before: totalBefore, total_after: totalAfter, note: "pass --yes to apply" }, null, 2));
    return { dry_run: true, preview };
  }

  const b = backup(catalogPath);
  const data2 = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const models2 = enumerateModels(data2);
  const m2 = findModel(models2, model);
  for (const f of fields) {
    const v = getField(m2.entry, f);
    const { text } = slimPrompt(v);
    setField(m2.entry, f, text);
  }
  atomicWrite(catalogPath, JSON.stringify(data2, null, 2) + "\n");
  verifyJson(catalogPath);
  console.log(JSON.stringify({ applied: true, backup: b, total_before: totalBefore, total_after: totalAfter }, null, 2));
  return { applied: true, backup: b };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function option(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] !== undefined ? process.argv[idx + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(name);
}

function main() {
  const [,, cmd] = process.argv;
  const catalog = option("--catalog");
  if (!catalog) {
    console.error("usage: node index.js <scan|audit|slim|rollback> --catalog <path> [--model slug] [--field f] [--yes]");
    process.exit(1);
  }
  const catalogPath = path.resolve(catalog);
  if (!fs.existsSync(catalogPath)) {
    console.error(`catalog not found: ${catalogPath}`);
    process.exit(1);
  }
  try {
    if (cmd === "scan") cmdScan(catalogPath);
    else if (cmd === "audit") cmdAudit(catalogPath, option("--model"), option("--field"));
    else if (cmd === "slim") cmdSlim(catalogPath, option("--model"), option("--field"), flag("--yes"));
    else if (cmd === "rollback") console.log(JSON.stringify(rollback(catalogPath), null, 2));
    else {
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = {
  tokenize,
  getField,
  enumerateModels,
  detectPromptFields,
  segment,
  slimPrompt,
  backup,
  atomicWrite,
  verifyJson,
  rollback,
  findModel,
  cmdScan,
  cmdAudit,
  cmdSlim,
};
