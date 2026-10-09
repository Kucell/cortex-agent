"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  detectLegacyFiles,
  planMigration,
  applyMigration,
  parseFrontmatter,
  isLegacyFrontmatter,
  slugFromFilename,
  renderFrontmatter,
} = require("../../lib/commands/migrate-legacy-memory");

const { validateMemory } = require("../../lib/memory-validate");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function freshProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-miglegacy-"));
  const memoryRoot = path.join(root, ".agent", "memory");
  for (const type of ["user", "feedback", "project", "reference"]) {
    fs.mkdirSync(path.join(memoryRoot, type), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, memoryRoot };
}

function writeLegacyFile(dir, name, fm, body) {
  if (body === undefined) body = "# Title from body\n\nBody content.\n";
  const fmLines = Object.entries(fm)
    .map(([k, v]) => Array.isArray(v) ? `${k}: [${v.join(", ")}]` : `${k}: ${v}`)
    .join("\n");
  const file = path.join(dir, name);
  fs.writeFileSync(file, `---\n${fmLines}\n---\n\n${body}`);
}

function writeIndex(memoryRoot) {
  const lines = [
    "# Memory",
    "",
    "## feedback (0/100)",
    "",
    "## project (0/100)",
    "",
    "## user (0/100)",
    "",
    "## reference (0/100)",
    "",
  ];
  fs.writeFileSync(path.join(memoryRoot, "MEMORY.md"), lines.join("\n"));
}

const LEGACY_FM = {
  record_id: "rec-abc",
  kind: "design_correction",
  source: "session-x",
  distilled_at: "2026-09-24",
  tags: ["legacy", "design"]
};

// ─── Tests ───────────────────────────────────────────────────────────────────

test("detectLegacyFiles: skips well-formed (memory-protocol) frontmatter", (t) => {
  const { root, memoryRoot } = freshProject(t);
  writeIndex(memoryRoot);
  writeLegacyFile(
    path.join(memoryRoot, "project"),
    "good-topic.md",
    {
      name: "good-topic",
      description: "Already compliant with memory-protocol",
      type: "project",
      created: "2026-09-24",
      tags: ["project", "compliant"],
      source: "session-observation"
    }
  );
  const r = detectLegacyFiles({ projectRoot: root });
  assert.equal(r.ok, true);
  assert.equal(r.found, 0);
  assert.deepEqual(r.files, []);
});

test("detectLegacyFiles: flags record_id/kind/distilled_at legacy frontmatter", (t) => {
  const { root, memoryRoot } = freshProject(t);
  writeIndex(memoryRoot);
  writeLegacyFile(path.join(memoryRoot, "project"), "old-topic.md", LEGACY_FM);
  writeLegacyFile(
    path.join(memoryRoot, "feedback"),
    "alert-1.md",
    { record_id: "rec-x", kind: "alert", distilled_at: "2026-09-25" }
  );
  const r = detectLegacyFiles({ projectRoot: root });
  assert.equal(r.ok, true);
  assert.equal(r.found, 2);
  const names = r.files.map(f => f.name).sort();
  assert.deepEqual(names, ["alert-1.md", "old-topic.md"]);
});

test("isLegacyFrontmatter: null returns false; legacy key returns true", () => {
  assert.equal(isLegacyFrontmatter(null), false);
  assert.equal(isLegacyFrontmatter({ name: "x", description: "y" }), false);
  assert.equal(isLegacyFrontmatter({ record_id: "r" }), true);
  assert.equal(isLegacyFrontmatter({ kind: "alert" }), true);
  assert.equal(isLegacyFrontmatter({ distilled_at: "2026-09-24" }), true);
  assert.equal(isLegacyFrontmatter({ generated_at: "2026-09-24" }), true);
});

test("slugFromFilename: collapses non-ASCII to dash and trims 64 chars", () => {
  assert.equal(
    slugFromFilename("handoff-json-schema-与-artifact-wrapper-不匹配.md"),
    "handoff-json-schema-artifact-wrapper"
  );
  const s = slugFromFilename("a".repeat(80) + ".md");
  assert.ok(s.length <= 64);
  assert.ok(/^[a-z0-9_][a-z0-9_-]*$/.test(s));
});

test("planMigration: empty slug (all non-ASCII) is skipped, not silently broken", (t) => {
  const { root, memoryRoot } = freshProject(t);
  writeIndex(memoryRoot);
  writeLegacyFile(
    path.join(memoryRoot, "project"),
    "中文.md",
    Object.assign({}, LEGACY_FM, { kind: "design_correction" })
  );
  const plan = planMigration({
    projectRoot: root,
    overrides: { "中文.md": { name: "" } }
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.planned.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /invalid slug/);
});

test("planMigration: override slug / description / tags are honored", (t) => {
  const { root, memoryRoot } = freshProject(t);
  writeIndex(memoryRoot);
  writeLegacyFile(path.join(memoryRoot, "project"), "旧-名.md", LEGACY_FM);
  const plan = planMigration({
    projectRoot: root,
    overrides: {
      "旧-名.md": {
        name: "renamed-slug",
        description: "Manual description from operator",
        tags: ["custom", "tag"]
      }
    }
  });
  assert.equal(plan.planned.length, 1);
  const rec = plan.planned[0];
  assert.equal(rec.targetSlug, "renamed-slug");
  assert.equal(rec.description, "Manual description from operator");
  assert.deepEqual(rec.tags, ["custom", "tag"]);
  assert.equal(rec.targetType, "project");
  assert.equal(rec.targetRelPath, path.join("project", "renamed-slug.md"));
  assert.equal(rec.requiresRename, true);
});

test("applyMigration: refuses without confirm and leaves files untouched", (t) => {
  const { root, memoryRoot } = freshProject(t);
  writeIndex(memoryRoot);
  const source = path.join(memoryRoot, "project", "old-topic.md");
  writeLegacyFile(path.join(memoryRoot, "project"), "old-topic.md", LEGACY_FM);
  const beforeStat = fs.statSync(source);
  const beforeText = fs.readFileSync(source, "utf8");
  const plan = planMigration({ projectRoot: root });
  const result = applyMigration(plan);
  assert.equal(result.ok, false);
  assert.equal(result.applied, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "ERR_CONFIRM_REQUIRED");
  const afterText = fs.readFileSync(source, "utf8");
  const afterStat = fs.statSync(source);
  assert.equal(afterText, beforeText);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
});

test("applyMigration: with confirm=true rewrites frontmatter and removes legacy source", (t) => {
  const { root, memoryRoot } = freshProject(t);
  writeIndex(memoryRoot);
  writeLegacyFile(path.join(memoryRoot, "project"), "old-topic.md", LEGACY_FM);
  const plan = planMigration({ projectRoot: root });
  const result = applyMigration(plan, { confirm: true });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1);
  const target = path.join(memoryRoot, "project", "old-topic.md");
  assert.ok(fs.existsSync(target));
  const text = fs.readFileSync(target, "utf8");
  const fm = parseFrontmatter(text);
  assert.equal(fm.record_id, undefined);
  assert.equal(fm.kind, undefined);
  assert.equal(fm.distilled_at, undefined);
  assert.equal(fm.name, "old-topic");
  assert.equal(fm.type, "project");
  assert.equal(fm.created, "2026-09-24");
  assert.deepEqual(fm.tags, ["legacy", "design"]);
  assert.match(text, /metadata:\n  record_id: rec-abc/);
  assert.match(text, /  kind: design_correction/);
  assert.match(text, /# Title from body/);
});

test("planMigration: feedback type auto-gets 90-day expires from created", (t) => {
  const { root, memoryRoot } = freshProject(t);
  writeIndex(memoryRoot);
  writeLegacyFile(
    path.join(memoryRoot, "feedback"),
    "alert-1.md",
    { record_id: "r1", kind: "alert", distilled_at: "2026-09-24" }
  );
  const plan = planMigration({ projectRoot: root });
  assert.equal(plan.planned.length, 1);
  const rec = plan.planned[0];
  assert.equal(rec.targetType, "feedback");
  assert.equal(rec.expiresStr, "2026-12-23");
});

test("integration: migrated file passes memory-validate with 0 schema issue", (t) => {
  const { root, memoryRoot } = freshProject(t);
  writeIndex(memoryRoot);
  writeLegacyFile(path.join(memoryRoot, "project"), "old-topic.md", LEGACY_FM);
  const plan = planMigration({ projectRoot: root });
  const result = applyMigration(plan, { confirm: true });
  assert.equal(result.ok, true);
  const indexPath = path.join(memoryRoot, "MEMORY.md");
  const indexText = fs.readFileSync(indexPath, "utf8")
    .replace(
      "## project (0/100)",
      "## project (1/100)\n- [old-topic](project/old-topic.md) — Migrated legacy project record (kind=design_correction); migrated from old frontmatter."
    );
  fs.writeFileSync(indexPath, indexText);
  const r = validateMemory({ projectRoot: root });
  const schemaIssues = (r.issues || []).filter(i => i.kind === "schema");
  assert.equal(schemaIssues.length, 0, JSON.stringify(schemaIssues, null, 2));
});

test("renderFrontmatter: deterministic shape with metadata block preserved", () => {
  const out = renderFrontmatter({
    name: "x",
    description: "desc",
    targetType: "project",
    created: "2026-09-24",
    tags: ["a", "b"],
    expiresStr: null,
    source: "session-observation",
    metadata: { record_id: "rec-1", kind: "alert", nested: { ok: 1 } }
  });
  assert.match(out, /^---\n/);
  assert.match(out, /---$/);
  assert.match(out, /^name: x$/m);
  assert.match(out, /^type: project$/m);
  assert.match(out, /^tags: \[a, b\]$/m);
  assert.match(out, /^metadata:$/m);
  assert.match(out, /^  record_id: rec-1$/m);
  assert.match(out, /^  nested:$/m);
  assert.match(out, /^    ok: 1$/m);
});

