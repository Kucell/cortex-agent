// ─── Memory integrity validator (T-ISSUE-2 / M-MEM-VAL-001) ─────────────────
//
// Single source of truth for `.agent/memory/MEMORY.md` ↔ filesystem ↔
// frontmatter-schema validation. Used by:
//   - `cortex-agent doctor` (memory-integrity section)
//   - `cortex-agent knowledge-lint` (memory-integrity sub-task)
//   - `cortex-agent memory-validate` (CLI entry, --fix support)
//
// Five checks (per `.agent/plans/proposals/memory/cortex-agent-memory-
// integrity-validation-proposal.md` §3.1):
//   V-1  drift         MEMORY.md declared count vs actual indexed items
//   V-2  missing       indexed [name](path) target does not exist or is empty
//   V-3  schema        topic file frontmatter missing required keys
//   V-4  orphan        topic file on disk but not indexed
//   V-5  duplicate / over-cap
//                     - duplicate: same path indexed multiple times
//                     - over-cap: items.length > hard cap for the type
//
// `.gitkeep` is treated as a legal placeholder (no V-2 report).
// Pure Node built-ins only. No mutation in normal mode; --fix is opt-in.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

// ─── Constants ─────────────────────────────────────────────────────────────────

// Hard caps per the proposal §3.1 — also the schema enforces them. The
// validator reports `over-cap` so doctor / lint can surface drift before
// schema-level rejects fire.
const HARD_CAPS = Object.freeze({
  user: 10,
  feedback: 30,
  project: 20,
  reference: 50,
});

const ALL_TYPES = Object.freeze(["user", "feedback", "project", "reference"]);

// Required frontmatter keys (mirrors `templates/.../memory.schema.json`).
const REQUIRED_FRONTMATTER_KEYS = Object.freeze([
  "name",
  "description",
  "type",
  "created",
  "tags",
]);

// ─── Default path resolution ──────────────────────────────────────────────────

function defaultMemoryRoot(projectRoot) {
  return path.join(projectRoot, ".agent", "memory");
}

// ─── MEMORY.md parser (V-1 / V-2 / V-5 sources) ──────────────────────────────

function parseMemoryIndex(memoryRoot) {
  const indexPath = path.join(memoryRoot, "MEMORY.md");
  if (!fs.existsSync(indexPath)) {
    return { ok: false, reason: "MEMORY.md missing", memoryRoot };
  }
  const text = fs.readFileSync(indexPath, "utf8");
  const lines = text.split(/\r?\n/);
  /** @type {Record<string, {line:number, declaredCount:number, declaredCap:number, items: Array}>} */
  const sections = {};

  let currentType = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sectionMatch = line.match(
      /^##\s+(user|feedback|project|reference)\s*\((\d+)\s*\/\s*(\d+)\)\s*$/
    );
    if (sectionMatch) {
      currentType = sectionMatch[1];
      sections[currentType] = {
        line: i + 1,
        declaredCount: parseInt(sectionMatch[2], 10),
        declaredCap: parseInt(sectionMatch[3], 10),
        items: [],
      };
      continue;
    }
    if (line.match(/^#{1,2}\s/)) {
      currentType = null;
      continue;
    }
    if (currentType) {
      const itemMatch = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:—|--|-|:\s*)(.*)$/);
      if (itemMatch) {
        sections[currentType].items.push({
          line: i + 1,
          name: itemMatch[1],
          path: itemMatch[2],
          description: itemMatch[3] || "",
        });
      }
    }
  }
  return { ok: true, sections, lines, indexPath, text, memoryRoot };
}

// ─── Frontmatter parser (V-3 source) ──────────────────────────────────────────
//
// Lightweight YAML frontmatter parser — handles the subset of YAML that
// `.agent/memory/` topic files use in practice:
//   - bare scalars (`name: reply-zh`)
//   - quoted scalars (`description: "中文回复偏好"`)
//   - inline arrays (`tags: [pnpm, package-manager, scripts]`)
//   - boolean / null literals (`metadata: null`)
// Anything fancier (block arrays, anchors, multi-line) is out of scope.
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return null;
  const result = {};
  const lines = m[1].split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let raw = kv[2];
    // Strip trailing inline comment after a quoted value.
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      raw = raw.slice(1, -1);
    } else if (raw.startsWith("[") && raw.endsWith("]")) {
      raw = raw.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (raw === "true" || raw === "false" || raw === "null" || raw === "") {
      // Keep as-is.
    }
    result[key] = raw;
  }
  return result;
}

// ─── Validators ─────────────────────────────────────────────────────────────────

function validateDrift(parsed) {
  const issues = [];
  for (const type of ALL_TYPES) {
    const section = parsed.sections[type];
    if (!section) continue;
    if (section.declaredCount !== section.items.length) {
      issues.push({
        kind: "drift",
        type,
        line: section.line,
        detail: `MEMORY.md declared "${type} (${section.declaredCount}/${section.declaredCap})" but found ${section.items.length} indexed items`,
      });
    }
  }
  return issues;
}

function validateMissing(parsed, memoryRoot) {
  const issues = [];
  for (const type of ALL_TYPES) {
    const section = parsed.sections[type];
    if (!section) continue;
    for (const item of section.items) {
      const fullPath = path.join(memoryRoot, item.path);
      let stat = null;
      try { stat = fs.statSync(fullPath); } catch (_) {}
      const placeholder = path.basename(item.path) === ".gitkeep";
      if (placeholder) continue;
      if (!stat || !stat.isFile() || stat.size === 0) {
        issues.push({
          kind: "missing",
          type,
          line: item.line,
          path: item.path,
          detail: `MEMORY.md references ${item.path} but the file does not exist or is empty`,
        });
      }
    }
  }
  return issues;
}

function validateSchema(memoryRoot) {
  const issues = [];
  for (const type of ALL_TYPES) {
    const typeDir = path.join(memoryRoot, type);
    let entries;
    try { entries = fs.readdirSync(typeDir); } catch (_) { continue; }
    for (const file of entries) {
      if (!file.endsWith(".md")) continue;
      if (file === ".gitkeep") continue;
      const fullPath = path.join(typeDir, file);
      let stat = null;
      try { stat = fs.statSync(fullPath); } catch (_) { continue; }
      if (!stat.isFile() || stat.size === 0) continue;
      const text = fs.readFileSync(fullPath, "utf8");
      const fm = parseFrontmatter(text);
      if (!fm) {
        issues.push({
          kind: "schema",
          type,
          path: path.join(type, file),
          detail: `topic file has no YAML frontmatter; expected at minimum: ${REQUIRED_FRONTMATTER_KEYS.join(", ")}`,
        });
        continue;
      }
      const missingKeys = REQUIRED_FRONTMATTER_KEYS.filter((k) => !(k in fm));
      if (missingKeys.length > 0) {
        issues.push({
          kind: "schema",
          type,
          path: path.join(type, file),
          detail: `topic file is missing frontmatter keys: ${missingKeys.join(", ")}`,
        });
      }
    }
  }
  return issues;
}

function validateOrphan(parsed, memoryRoot) {
  const issues = [];
  for (const type of ALL_TYPES) {
    const section = parsed.sections[type];
    const typeDir = path.join(memoryRoot, type);
    let entries;
    try { entries = fs.readdirSync(typeDir); } catch (_) { continue; }
    const indexed = new Set((section?.items || []).map((it) => it.path));
    for (const file of entries) {
      if (!file.endsWith(".md")) continue;
      if (file === ".gitkeep") continue;
      const relPath = path.join(type, file);
      if (!indexed.has(relPath)) {
        issues.push({
          kind: "orphan",
          type,
          path: relPath,
          detail: `topic file exists on disk but is not indexed in MEMORY.md`,
        });
      }
    }
  }
  return issues;
}

function validateDuplicateAndCap(parsed) {
  const issues = [];
  for (const type of ALL_TYPES) {
    const section = parsed.sections[type];
    if (!section) continue;
    const seen = new Map();
    for (const item of section.items) {
      const prev = seen.get(item.path);
      if (prev) {
        issues.push({
          kind: "duplicate",
          type,
          line: item.line,
          path: item.path,
          detail: `${item.path} is indexed at line ${prev} and again at line ${item.line}`,
        });
      } else {
        seen.set(item.path, item.line);
      }
    }
    const cap = HARD_CAPS[type];
    if (section.items.length > cap) {
      issues.push({
        kind: "over-cap",
        type,
        line: section.line,
        detail: `${type} section has ${section.items.length} items, exceeding the hard cap of ${cap}`,
      });
    }
  }
  return issues;
}

function buildSummary(issues) {
  const summary = {
    drift: 0, missing: 0, schema: 0, orphan: 0, duplicate: 0, "over-cap": 0,
  };
  for (const issue of issues) {
    if (Object.prototype.hasOwnProperty.call(summary, issue.kind)) {
      summary[issue.kind] += 1;
    }
  }
  return summary;
}

// ─── Main entry ───────────────────────────────────────────────────────────────
//
// Returns `{ ok, issues, parsed, memoryRoot, summary }`.
// `ok=false` only when MEMORY.md itself is missing — caller should still
// inspect issues (which may be empty in that case).
function validateMemory({ projectRoot, memoryRoot: memRoot } = {}) {
  if (!projectRoot && !memRoot) {
    throw new Error("validateMemory: projectRoot or memoryRoot is required");
  }
  const memoryRoot = memRoot || defaultMemoryRoot(projectRoot);
  const parsed = parseMemoryIndex(memoryRoot);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason,
      issues: [],
      parsed,
      memoryRoot,
      summary: buildSummary([]),
    };
  }
  const issues = [
    ...validateDrift(parsed),
    ...validateMissing(parsed, memoryRoot),
    ...validateSchema(memoryRoot),
    ...validateOrphan(parsed, memoryRoot),
    ...validateDuplicateAndCap(parsed),
  ];
  return {
    ok: true,
    issues,
    parsed,
    memoryRoot,
    summary: buildSummary(issues),
  };
}

// ─── Fix planner (--fix mode) ─────────────────────────────────────────────────
//
// `buildFixPlan` returns a *plan* describing safe edits to MEMORY.md:
//   - drift    → rewrite the section header count
//   - orphan   → append a new `- [name](path) — <description>` line under
//                the matching section, before the next `## ` heading
//   - duplicate → drop the duplicate line (keep the first occurrence)
//   - missing / schema / over-cap → NEVER auto-fixed (must be handled
//                manually; plan records the skip reason so the caller can
//                print a clear summary).
//
// The caller must review the plan diff and confirm before invoking
// `applyFixPlan` (which mutates MEMORY.md). This is a defense-in-depth
// guard — the proposal §3.4 explicitly forbids auto-deleting topic bodies
// or rewriting frontmatter, and a noop `applyFixPlan` is impossible if
// the caller skips the plan review.

function buildFixPlan(parsed, issues, memoryRoot) {
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, edits: [], skipReasons: [] };
  }
  /** @type {Array<{kind:string, summary:string, before:string, after:string}>} */
  const edits = [];
  const skipReasons = [];

  // First pass: figure out which orphans we'll auto-append, so the drift
  // computation sees the *post-fix* item count (otherwise appending N
  // orphans to a section with declaredCount=K would still leave drift).
  const orphanAppendCount = Object.create(null);
  for (const issue of issues) {
    if (issue.kind !== "orphan") continue;
    orphanAppendCount[issue.type] = (orphanAppendCount[issue.type] || 0) + 1;
  }

  // drift: rewrite section headers
  for (const type of ALL_TYPES) {
    const section = parsed.sections[type];
    if (!section) continue;
    const projectedItems = section.items.length + (orphanAppendCount[type] || 0);
    if (section.declaredCount !== projectedItems) {
      const newHeader = `## ${type} (${projectedItems}/${section.declaredCap})`;
      edits.push({
        kind: "drift",
        type,
        line: section.line,
        summary: `rewrite MEMORY.md:${section.line} section header count`,
        before: `## ${type} (${section.declaredCount}/${section.declaredCap})`,
        after: newHeader,
      });
    }
  }

  // orphan: append a new index line before the next ## heading or EOF.
  const orphanByType = {};
  for (const issue of issues) {
    if (issue.kind !== "orphan") continue;
    if (!orphanByType[issue.type]) orphanByType[issue.type] = [];
    orphanByType[issue.type].push(issue);
  }
  for (const type of ALL_TYPES) {
    const orphans = orphanByType[type];
    if (!orphans || orphans.length === 0) continue;
    const section = parsed.sections[type];
    if (!section) {
      skipReasons.push({ type, reason: `no ${type} section in MEMORY.md; cannot auto-append orphan` });
      continue;
    }
    for (const orphan of orphans) {
      // Pull name / description from the topic file's frontmatter when present.
      const fullPath = path.join(memoryRoot, orphan.path);
      let name = path.basename(orphan.path, ".md");
      let description = "";
      try {
        const text = fs.readFileSync(fullPath, "utf8");
        const fm = parseFrontmatter(text);
        if (fm && typeof fm.name === "string") name = fm.name;
        if (fm && typeof fm.description === "string") description = fm.description;
      } catch (_) {}
      edits.push({
        kind: "orphan",
        type,
        line: section.line,
        summary: `append index entry for ${orphan.path}`,
        before: "",
        after: `- [${name}](${orphan.path}) — ${description || "auto-indexed"}`,
      });
    }
  }

  // duplicate: drop the duplicate line (keep first occurrence)
  const duplicateLines = new Set();
  const seen = new Set();
  for (const type of ALL_TYPES) {
    const section = parsed.sections[type];
    if (!section) continue;
    seen.clear();
    for (const item of section.items) {
      if (seen.has(item.path)) {
        duplicateLines.add(item.line);
        edits.push({
          kind: "duplicate",
          type,
          line: item.line,
          summary: `remove duplicate index entry at line ${item.line} for ${item.path}`,
          before: parsed.lines[item.line - 1],
          after: "",
        });
      } else {
        seen.add(item.path);
      }
    }
  }

  // missing / schema / over-cap: skip; explain why.
  for (const issue of issues) {
    if (issue.kind === "missing") {
      skipReasons.push({ issue, reason: "missing target file; cannot auto-create (would fabricate content)" });
    } else if (issue.kind === "schema") {
      skipReasons.push({ issue, reason: "frontmatter incomplete; cannot auto-fill (would fabricate metadata)" });
    } else if (issue.kind === "over-cap") {
      skipReasons.push({ issue, reason: "over-cap is a hard limit; auto-archiving is out of scope (per proposal §6)" });
    }
  }

  return { ok: true, edits, skipReasons };
}

function applyFixPlan(parsed, plan, { confirm = false } = {}) {
  if (!confirm) {
    throw new Error(
      "applyFixPlan: refusing to mutate MEMORY.md without confirm=true. " +
      "Review the plan via buildFixPlan first; this is the proposal §3.4 safety bound."
    );
  }
  if (!plan || !plan.ok) return { ok: false, applied: 0 };
  const lines = parsed.lines.slice();
  // Apply drift (replace header)
  for (const edit of plan.edits) {
    if (edit.kind === "drift") {
      lines[edit.line - 1] = edit.after;
    }
  }
  // Apply orphan (insert after the section header). Find the next "## "
  // boundary for each edit before inserting.
  const orphanInsertions = plan.edits
    .filter((e) => e.kind === "orphan")
    // Process in reverse line order so earlier insertions do not shift
    // later line numbers.
    .sort((a, b) => b.line - a.line);
  for (const edit of orphanInsertions) {
    const section = parsed.sections[edit.type];
    let insertAt = edit.line; // after header line
    while (insertAt < lines.length && !lines[insertAt].match(/^##\s/)) {
      insertAt += 1;
    }
    lines.splice(insertAt, 0, edit.after);
  }
  // Apply duplicate (remove line). Process in reverse order so deletions
  // do not shift earlier line numbers.
  const duplicateDeletions = plan.edits
    .filter((e) => e.kind === "duplicate")
    .sort((a, b) => b.line - a.line);
  for (const edit of duplicateDeletions) {
    if (edit.line >= 1 && edit.line <= lines.length) {
      lines.splice(edit.line - 1, 1);
    }
  }
  const newText = lines.join("\n") + (parsed.text.endsWith("\n") ? "" : "\n");
  fs.writeFileSync(parsed.indexPath, newText);
  return { ok: true, applied: plan.edits.length, newText };
}

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  HARD_CAPS,
  ALL_TYPES,
  REQUIRED_FRONTMATTER_KEYS,
  defaultMemoryRoot,
  parseMemoryIndex,
  parseFrontmatter,
  validateMemory,
  buildFixPlan,
  applyFixPlan,
  buildSummary,
};
