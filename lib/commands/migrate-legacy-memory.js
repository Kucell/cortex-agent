"use strict";

// ─── migrate-legacy-memory (M-LEGACY-MEM-001) ────────────────────────────────
//
// One-shot migration: scan `.agent/memory/{feedback,project,user,reference}/`
// for topic files using legacy `record_id` / `kind` / `distilled_at` /
// `generated_at` frontmatter (written by an early version of `act-proposer`
// and session residue capture before the 2026-09-28 memory-protocol compliance
// fix landed at `ef5815d9 fix(learning-loop)`), and rewrite their frontmatter
// to conform to `.agent/memory/memory.schema.json`.
//
// Why a separate module (not patching `lib/memory-validate.js`):
//   - V-3 (schema) is intentionally non-mutating per proposal §3.4
//   - schema violations can be ambiguous (collision, semantic rewrite, content
//     hash drift); auto-fix would silently corrupt provenance
//   - non-Latin filenames fail the slug pattern; operator-driven pass is safer
//
// State machine: [pending, dry_run, applied, completed, failed]
// Failure recovery: leave the file untouched; report `legacy_format` + reason
// Produces:
//   .agent/memory/{type}/<slug>.md (rewritten frontmatter, original body
//     preserved verbatim except for the leading `---` block)
//
// CLI usage:
//   node bin/cli.js migrate-legacy-memory
//   node bin/cli.js migrate-legacy-memory --apply --confirm
//
// Upgrade hook (lib/commands/upgrade.js):
//   const m = require("./migrate-legacy-memory");
//   const r = m.detectLegacyFiles({ projectRoot: cwd });
//   if (r.found > 0) console.warn(`legacy frontmatter: ${r.found} file(s)`);

const fs = require("node:fs");
const path = require("node:path");
const memoryValidate = require("../memory-validate");

const SCHEMA_TYPES = Object.freeze(["user", "feedback", "project", "reference"]);
const SLUG_PATTERN = /^[a-z0-9_][a-z0-9_-]*$/;
const LEGACY_KEYS = Object.freeze([
  "record_id", "kind", "distilled_at", "generated_at"
]);
// M-LEGACY-MEM-002: top-level keys NOT in the memory-protocol schema; treated
// as metadata candidates during migration (Pattern D). `metadata` itself is
// the canonical escape hatch, so anything outside this allow-list gets folded
// into the `metadata:` block.
const ALLOWED_TOP_LEVEL_KEYS = Object.freeze([
  "name", "description", "type", "created", "tags",
  "expires", "metadata", "source", "related"
]);
const REQUIRED_TOP_LEVEL_KEYS = Object.freeze([
  "name", "description", "type", "created", "tags"
]);

const KIND_TO_TYPE = Object.freeze({
  alert: "feedback",
  failure_recovery: "project",
  design_correction: "project",
  bug_fix: "project",
  fact: "reference",
  insight: "reference",
  procedural: "reference"
});

const DEFAULT_TAGS_BY_TYPE = Object.freeze({
  feedback: ["feedback", "legacy-frontmatter"],
  project: ["project", "legacy-frontmatter"],
  user: ["user", "legacy-frontmatter"],
  reference: ["reference", "legacy-frontmatter"]
});

const FEEDBACK_EXPIRY_DAYS = 90;

// ─── Frontmatter parser ─────────────────────────────────────────────────────

function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return null;
  const result = {};
  const lines = m[1].split(/\r?\n/);
  let currentKey = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (listItem && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(listItem[1].replace(/^["']|["']$/g, "").trim());
      continue;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    currentKey = key;
    let raw = kv[2];
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      raw = raw.slice(1, -1);
    } else if (raw.startsWith("[") && raw.endsWith("]")) {
      raw = raw.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
    } else if (raw === "") {
      raw = key === "metadata" ? {} : [];
    }
    result[key] = raw;
  }
  return result;
}

function splitFrontmatter(text) {
  const m = text.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
  if (m) return { header: m[0], body: text.slice(m[0].length) };
  return { header: "", body: text };
}

// ─── Slug helpers ────────────────────────────────────────────────────────────

function slugFromFilename(filename) {
  return filename
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 64);
}

function isValidSlug(slug) {
  return typeof slug === "string" && SLUG_PATTERN.test(slug) && slug.length > 0 && slug.length <= 64;
}

// ─── Detection ───────────────────────────────────────────────────────────────

function isLegacyFrontmatter(frontmatter) {
  if (!frontmatter) return false;
  return LEGACY_KEYS.some(k => Object.prototype.hasOwnProperty.call(frontmatter, k));
}

// ─── v2 classification (M-LEGACY-MEM-002) ───────────────────────────────────
//
// Pattern A — legacy_keys          : has record_id/kind/distilled_at/generated_at
// Pattern B — no_frontmatter       : parseFrontmatter returned null
// Pattern C — partial_frontmatter  : frontmatter missing one or more of
//                                    name/description/type/created/tags
// Pattern D — unknown_keys         : frontmatter has keys outside
//                                    ALLOWED_TOP_LEVEL_KEYS (typical:
//                                    `updated`, `trigger`, `triggers`)
// Pattern CD — partial_and_unknown : C and D overlap
function classifyLegacyReason(text, type) {
  const fm = parseFrontmatter(text);
  if (!fm) return { reason: "no_frontmatter", frontmatter: null, hasFrontmatter: false };
  const hasLegacy = LEGACY_KEYS.some((k) => Object.prototype.hasOwnProperty.call(fm, k));
  if (hasLegacy) return { reason: "legacy_keys", frontmatter: fm, hasFrontmatter: true };
  const unknownKeys = Object.keys(fm).filter((k) => !ALLOWED_TOP_LEVEL_KEYS.includes(k));
  const missingKeys = REQUIRED_TOP_LEVEL_KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(fm, k));
  if (unknownKeys.length > 0 && missingKeys.length > 0) {
    return { reason: "partial_and_unknown", frontmatter: fm, hasFrontmatter: true, unknownKeys, missingKeys };
  }
  if (unknownKeys.length > 0) {
    return { reason: "unknown_keys", frontmatter: fm, hasFrontmatter: true, unknownKeys };
  }
  if (missingKeys.length > 0) {
    return { reason: "partial_frontmatter", frontmatter: fm, hasFrontmatter: true, missingKeys };
  }
  // Pattern E: value_violation - keys are all valid but values fail schema
  // (e.g., tags containing uppercase, description length > 200). We rely
  // on memory-validate for canonical value checks.
  const valueErrors = memoryValidate.validateFrontmatterValues(fm, type);
  if (valueErrors && valueErrors.length > 0) {
    return { reason: "value_violation", frontmatter: fm, hasFrontmatter: true, valueErrors };
  }
  return { reason: null, frontmatter: fm, hasFrontmatter: true };
}

function detectLegacyFiles({ projectRoot }) {
  const memoryRoot = path.join(projectRoot, ".agent", "memory");
  const found = [];
  if (!fs.existsSync(memoryRoot)) {
    return { ok: true, found: 0, files: [], memoryRoot };
  }
  for (const type of SCHEMA_TYPES) {
    const dir = path.join(memoryRoot, type);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const file = path.join(dir, name);
      const text = fs.readFileSync(file, "utf8");
      const cls = classifyLegacyReason(text, type);
      if (cls.reason) {
        found.push({
          type,
          file,
          name,
          reason: cls.reason,
          unknownKeys: cls.unknownKeys || [],
          missingKeys: cls.missingKeys || [],
          valueErrors: cls.valueErrors || [],
          hasFrontmatter: cls.hasFrontmatter
        });
      }
    }
  }
  return { ok: true, found: found.length, files: found, memoryRoot };
}

// ─── Plan construction ───────────────────────────────────────────────────────

function inferTypeFromKind(kind) {
  if (!kind) return null;
  const key = String(kind).toLowerCase().replace(/-/g, "_");
  return KIND_TO_TYPE[key] || null;
}

function inferCreatedDate(frontmatter, statMtime) {
  const cand = frontmatter.distilled_at || frontmatter.generated_at || null;
  if (typeof cand === "string") {
    const dateOnly = cand.match(/^(\d{4}-\d{2}-\d{2})/);
    if (dateOnly) return dateOnly[1];
    const parsed = new Date(cand);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return statMtime.toISOString().slice(0, 10);
}

function buildMetadataFromLegacy(frontmatter) {
  const meta = {};
  for (const k of Object.keys(frontmatter || {})) {
    if (k === "name" || k === "description" || k === "type" || k === "created" || k === "tags" || k === "expires") continue;
    meta[k] = frontmatter[k];
  }
  return meta;
}

// M-LEGACY-MEM-002: for Pattern D (unknown keys), move top-level keys outside
// ALLOWED_TOP_LEVEL_KEYS into the metadata block. Allowed keys (including
// nested metadata block) are preserved as-is.
function buildMetadataFromUnknownKeys(frontmatter, existingMetadata) {
  const meta = { ...(existingMetadata || {}) };
  for (const k of Object.keys(frontmatter || {})) {
    if (!ALLOWED_TOP_LEVEL_KEYS.includes(k)) {
      meta[k] = frontmatter[k];
    }
  }
  return meta;
}

// M-LEGACY-MEM-002: when an existing tags array has invalid items (e.g.
// uppercase M-049), slugify the offenders so the array passes validation.
// Returns null if the result is empty.
function sanitizeTags(tags, fallback) {
  if (!Array.isArray(tags)) return null;
  const sanitized = [];
  const seen = new Set();
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const slug = t
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug && SLUG_PATTERN.test(slug) && slug.length <= 64 && !seen.has(slug)) {
      sanitized.push(slug);
      seen.add(slug);
    }
  }
  if (sanitized.length >= 1 && sanitized.length <= 10) return sanitized;
  return null;
}

// M-LEGACY-MEM-002: derive a description for files without one (Pattern B/C).
// Falls back to first 200 chars of body after the first H1.
function deriveDescriptionFallback(text, fm) {
  if (fm && typeof fm.description === "string" && fm.description.length > 0) {
    return fm.description.length > 200 ? fm.description.slice(0, 197) + "..." : fm.description;
  }
  const title = deriveTitleFromBody(text);
  if (title) return title;
  const bodyMatch = text.match(/^#+\s*[^\n]*\n+([\s\S]+?)(?:\n\n|$)/);
  if (bodyMatch) {
    const first = bodyMatch[1].trim().split(/\r?\n/)[0] || "";
    return first.slice(0, 200);
  }
  return "Migrated from legacy/missing frontmatter.";
}


function deriveTitleFromBody(text) {
  const m = text.match(/^#\s+(.+?)\s*$/m);
  if (!m) return null;
  return m[1].trim().slice(0, 200);
}

function planMigration({ projectRoot, overrides = {} }) {
  const detection = detectLegacyFiles({ projectRoot });
  if (!detection.ok || detection.found === 0) {
    return { ok: true, applied: 0, planned: [], skipped: [], detection };
  }
  const memoryRoot = detection.memoryRoot;
  const planned = [];
  const skipped = [];
  for (const entry of detection.files) {
    const file = entry.file;
    const stat = fs.statSync(file);
    const text = fs.readFileSync(file, "utf8");
    const cls = classifyLegacyReason(text, entry.type);
    if (!cls.reason) {
      skipped.push({ file, reason: "no longer legacy (concurrent edit?)" });
      continue;
    }
    const fm = cls.frontmatter;

    // ─── Target type ────────────────────────────────────────────────────
    // Pattern A: kind → inferred type
    // Patterns B/C/D: parent dir → SCHEMA_TYPES, or override
    let targetType;
    if (cls.reason === "legacy_keys") {
      targetType = overrides[entry.name]?.type || inferTypeFromKind(fm && fm.kind) || entry.type || "reference";
    } else {
      targetType = overrides[entry.name]?.type || entry.type;
    }
    if (!SCHEMA_TYPES.includes(targetType)) {
      skipped.push({ file, reason: `unknown target type "${targetType}"` });
      continue;
    }

    // ─── Target slug ────────────────────────────────────────────────────
    // Pattern B uses null as override on existing fm.name (file has no
    // frontmatter); otherwise prefer override, then existing name, then filename.
    const autoSlug = slugFromFilename(entry.name);
    let targetSlug;
    if (overrides[entry.name]?.name) targetSlug = overrides[entry.name].name;
    else if (fm && typeof fm.name === "string" && isValidSlug(fm.name)) targetSlug = fm.name;
    else targetSlug = autoSlug;
    if (!isValidSlug(targetSlug)) {
      skipped.push({ file, reason: `invalid slug "${targetSlug}"` });
      continue;
    }

    // ─── Description ────────────────────────────────────────────────────
    const description =
      overrides[entry.name]?.description ||
      deriveDescriptionFallback(text, fm);
    if (description.length > 200) {
      skipped.push({ file, reason: `description length ${description.length} > 200` });
      continue;
    }

    // ─── Created date ───────────────────────────────────────────────────
    let created;
    if (cls.reason === "legacy_keys") {
      created = inferCreatedDate(fm, stat.mtime);
    } else if (fm && typeof fm.created === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fm.created)) {
      created = fm.created;
    } else {
      created = stat.mtime.toISOString().slice(0, 10);
    }

    // ─── Tags ──────────────────────────────────────────────────────────
    let tags = overrides[entry.name]?.tags;
    if (!tags) {
      tags = sanitizeTags(fm && fm.tags, DEFAULT_TAGS_BY_TYPE[targetType].slice());
      if (!tags) tags = DEFAULT_TAGS_BY_TYPE[targetType].slice();
    }
    if (tags.length === 0 || tags.length > 10) {
      skipped.push({ file, reason: `invalid tags length ${tags.length}` });
      continue;
    }

    // ─── expires (feedback only) ────────────────────────────────────────
    const expiresMs =
      targetType === "feedback"
        ? new Date(created + "T00:00:00Z").getTime() + FEEDBACK_EXPIRY_DAYS * 86400000
        : null;
    const expiresStr = expiresMs ? new Date(expiresMs).toISOString().slice(0, 10) : null;

    // ─── Metadata ──────────────────────────────────────────────────────
    let metadata;
    if (cls.reason === "legacy_keys") {
      metadata = buildMetadataFromLegacy(fm);
    } else {
      metadata = buildMetadataFromUnknownKeys(fm || {}, fm && fm.metadata);
    }

    // Pattern B (no frontmatter) → source: agent-bootstrap or agent-update
    let source;
    if (overrides[entry.name]?.source) source = overrides[entry.name].source;
    else if (cls.reason === "no_frontmatter") source = "session-observation";
    else if (fm && typeof fm.source === "string") source = fm.source;
    else source = "session-observation";

    planned.push({
      sourceFile: file,
      sourceRelPath: path.relative(memoryRoot, file),
      targetType,
      targetSlug,
      targetRelPath: path.join(targetType, targetSlug + ".md"),
      name: targetSlug,
      description,
      created,
      tags,
      expiresStr,
      source,
      metadata,
      reason: cls.reason,
      unknownKeys: cls.unknownKeys || [],
      missingKeys: cls.missingKeys || [],
      valueErrors: cls.valueErrors || [],
      requiresRename: entry.name !== (targetSlug + ".md") || entry.type !== targetType
    });
  }
  return { ok: true, applied: 0, planned, skipped, detection };
}

// ─── Frontmatter rendering ───────────────────────────────────────────────────

function yamlEscape(value) {
  if (typeof value !== "string") return value;
  if (/^[A-Za-z0-9_.\-]+$/.test(value)) return value;
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function renderFrontmatter(record) {
  const lines = ["---"];
  lines.push("name: " + yamlEscape(record.name));
  lines.push("description: " + yamlEscape(record.description));
  lines.push("type: " + record.targetType);
  lines.push("created: " + record.created);
  lines.push("tags: [" + record.tags.map(yamlEscape).join(", ") + "]");
  if (record.expiresStr) lines.push("expires: " + record.expiresStr);
  lines.push("source: " + yamlEscape(record.source));
  if (Object.keys(record.metadata).length > 0) {
    lines.push("metadata:");
    for (const [k, v] of Object.entries(record.metadata)) {
      if (typeof v === "string") {
        lines.push("  " + k + ": " + yamlEscape(v));
      } else if (Array.isArray(v)) {
        lines.push("  " + k + ": [" + v.map(yamlEscape).join(", ") + "]");
      } else if (v && typeof v === "object") {
        lines.push("  " + k + ":");
        for (const [k2, v2] of Object.entries(v)) {
          if (typeof v2 === "string") lines.push("    " + k2 + ": " + yamlEscape(v2));
          else lines.push("    " + k2 + ": " + JSON.stringify(v2));
        }
      } else {
        lines.push("  " + k + ": " + JSON.stringify(v));
      }
    }
  }
  lines.push("---");
  return lines.join("\n");
}

// ─── Apply ───────────────────────────────────────────────────────────────────

function applyMigration(plan, { confirm = false } = {}) {
  if (!plan || !plan.ok) {
    return { ok: false, applied: 0, errors: [{ code: "ERR_PLAN_INVALID" }] };
  }
  if (!confirm && plan.planned.length > 0) {
    return {
      ok: false,
      applied: 0,
      errors: [{ code: "ERR_CONFIRM_REQUIRED", message: "refusing to migrate without confirm=true. Pass --confirm or review plan first." }]
    };
  }
  const written = [];
  const errors = [];
  for (const record of plan.planned) {
    try {
      const memoryRoot = path.resolve(record.sourceFile, "..", "..");
      const targetFile = path.join(memoryRoot, record.targetRelPath);
      const { body } = splitFrontmatter(fs.readFileSync(record.sourceFile, "utf8"));
      const newContent = renderFrontmatter(record) + "\n" + body.replace(/^\n+/, "");
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      const tmp = targetFile + ".tmp-" + process.pid + "-" + Date.now();
      fs.writeFileSync(tmp, newContent);
      fs.renameSync(tmp, targetFile);
      if (record.sourceFile !== targetFile && fs.existsSync(record.sourceFile)) {
        fs.unlinkSync(record.sourceFile);
      }
      written.push({ source: record.sourceFile, target: targetFile, name: record.name });
    } catch (error) {
      errors.push({ file: record.sourceFile, code: error.code || "ERR_APPLY_FAILED", message: error.message });
    }
  }
  return { ok: errors.length === 0, applied: written.length, written, errors };
}

module.exports = {
  detectLegacyFiles,
  planMigration,
  applyMigration,
  parseFrontmatter,
  isLegacyFrontmatter,
  classifyLegacyReason,
  slugFromFilename,
  inferTypeFromKind,
  inferCreatedDate,
  sanitizeTags,
  buildMetadataFromUnknownKeys,
  deriveDescriptionFallback,
  renderFrontmatter,
  SCHEMA_TYPES,
  KIND_TO_TYPE,
  LEGACY_KEYS,
  ALLOWED_TOP_LEVEL_KEYS,
  REQUIRED_TOP_LEVEL_KEYS
};
