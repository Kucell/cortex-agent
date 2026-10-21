"use strict";

// ─── migrate-task-state (T-TS-002 / MS-2) ─────────────────────────────────────
//
// One-shot migration that turns `.agent/plans/task-progress.md` from the only
// (and unbounded) task-state source into a derived view over structured task
// records.
//
// Why a separate module (not a parser tweak):
//   - the migration mutates user project files, so it needs its own
//     detect/apply separation and an explicit --confirm gate
//   - it must never guess a task status; unclassifiable IDs are archived
//   - it must be idempotent: a second run on a migrated project is a no-op
//
// Pattern mirrored from lib/commands/migrate-legacy-memory.js:
//   detectLegacyFiles -> planMigration -> applyMigration(plan, {confirm})
//
// CLI usage:
//   node bin/cli.js migrate-task-state detect [--project <path>]
//   node bin/cli.js migrate-task-state plan   [--project <path>]
//   node bin/cli.js migrate-task-state apply  [--project <path>] --confirm
//
// Upgrade hook (lib/commands/upgrade.js) calls detectTaskState() only — it
// reports, it never mutates. See P-001 §6.4.

const fs = require("node:fs");
const path = require("node:path");

const PROGRESS_REL = path.join(".agent", "plans", "task-progress.md");
const TASKS_REL = path.join(".agent", "tasks");
const ARCHIVE_REL = path.join(".agent", "plans", "task-progress-archive");
const SNAPSHOT_REL = path.join(".agent", "plans", "task-progress-archive", "_snapshots");

const TASK_ID_RE = /\b(?:T|M)-[A-Za-z0-9][A-Za-z0-9-]*\b/;
const TASK_FILE_RE = /^(T-[A-Za-z0-9][A-Za-z0-9._-]*)\.json$/;

// Table headers are matched by meaning, not by position: the same project can
// carry 4-column (id/priority/description/progress), 5-column
// (id/priority/milestone/description/progress), 6-column and 7-column tables
// in the same file (see P-001 §2 E11).
const HEADER_ALIASES = Object.freeze({
  id: [/^任务\s*id$/i, /^task\s*id$/i, /^id$/i],
  priority: [/^优先级$/, /^priority$/i],
  milestone: [/^milestone$/i, /^里程碑$/],
  description: [/^描述$/, /^说明$/, /^任务说明$/, /^description$/i, /^task$/i],
  progress: [/^进度$/, /^progress$/i],
  plan: [/^关联计划$/, /^计划$/, /^plan$/i],
});

function classifyHeader(cells) {
  const map = {};
  cells.forEach((cell, index) => {
    const text = String(cell || "").trim();
    for (const [key, patterns] of Object.entries(HEADER_ALIASES)) {
      if (map[key] !== undefined) continue;
      if (patterns.some((re) => re.test(text))) {
        map[key] = index;
        break;
      }
    }
  });
  return map;
}

function isSeparatorRow(cells) {
  return cells.every((cell) => /^:?-{2,}:?$/.test(String(cell || "").trim()));
}

function splitRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const inner = trimmed.slice(1, trimmed.endsWith("|") ? -1 : undefined);
  return inner.split("|").map((cell) => cell.trim());
}

// A table qualifies as a task table when its header row exposes an id column
// AND a progress column. A header without those is a milestone/SP table and
// must not be treated as a task list.
function parseTaskTables(source) {
  const lines = source.split(/\r?\n/);
  const tables = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const cells = splitRow(lines[index]);
    if (!cells) {
      if (current) { tables.push(current); current = null; }
      continue;
    }
    if (isSeparatorRow(cells)) continue;
    const header = classifyHeader(cells);
    // A header row never carries a task id; a data row always does. Without
    // this guard a data row can be mistaken for a header and reset the table
    // being collected.
    const headerLike = header.id !== undefined && header.progress !== undefined
      && !TASK_ID_RE.test(cells[header.id] || "");
    if (headerLike) {
      if (current) tables.push(current);
      current = { header, rows: [], line: index + 1 };
      continue;
    }
    if (!current) continue;
    // Data rows are read through the header captured when the table started;
    // re-classifying the row itself finds no aliases and loses the id column.
    const idCell = cells[current.header.id] || "";
    if (!TASK_ID_RE.test(idCell)) {
      if (current) { tables.push(current); current = null; }
      continue;
    }
    current.rows.push({ cells, line: index + 1 });
  }
  if (current) tables.push(current);
  return tables;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

function listTaskFiles(tasksDir) {
  if (!fs.existsSync(tasksDir)) return [];
  return fs.readdirSync(tasksDir)
    .map((name) => ({ name, match: name.match(TASK_FILE_RE) }))
    .filter((entry) => entry.match)
    .map((entry) => ({ taskId: entry.match[1], file: path.join(tasksDir, entry.name) }));
}

// ─── Detection ───────────────────────────────────────────────────────────────

function detectTaskState({ projectRoot }) {
  const progressFile = path.join(projectRoot, PROGRESS_REL);
  const tasksDir = path.join(projectRoot, TASKS_REL);
  const findings = [];
  const existingTasks = listTaskFiles(tasksDir);
  const existingIds = new Set(existingTasks.map((entry) => entry.taskId));

  if (!fs.existsSync(progressFile)) {
    return {
      ok: true,
      found: 0,
      needsMigration: false,
      reason: "missing_task_progress",
      findings: [],
      progressFile,
      tasksDir,
      existingTaskCount: existingTasks.length,
    };
  }

  const source = fs.readFileSync(progressFile, "utf8");
  const tables = parseTaskTables(source);
  const tableIds = new Set();
  for (const table of tables) {
    for (const row of table.rows) {
      const idCell = row.cells[table.header.id] || "";
      const match = idCell.match(TASK_ID_RE);
      if (match) tableIds.add(match[0]);
    }
  }

  // Everything outside the active task tables: closeout logs, roadmaps,
  // milestone tables. These are the history that must be archived.
  const historyBlocks = splitHistoryBlocks(source);

  const lineCount = source.split(/\r?\n/).length;
  const byteSize = Buffer.byteLength(source, "utf8");

  const isGeneratedView = source.includes("<!-- generated:task-progress v1");
  if (!isGeneratedView && (lineCount > 200 || historyBlocks.length > 0 || tableIds.size > 0)) {
    findings.push({
      kind: "legacy_progress_file",
      detail: `${lineCount} lines / ${byteSize} bytes / ${tableIds.size} task rows / ${historyBlocks.length} history blocks`,
    });
  }

  // index.json drift: task files that never made it into the discovery index.
  const indexFile = path.join(tasksDir, "index.json");
  const index = readJson(indexFile);
  const indexedIds = new Set(
    (index && Array.isArray(index.tasks) ? index.tasks : []).map((entry) => entry.task_id)
  );
  const missingFromIndex = existingTasks
    .map((entry) => entry.taskId)
    .filter((id) => !indexedIds.has(id));
  if (missingFromIndex.length > 0) {
    findings.push({
      kind: "task_index_drift",
      detail: `${missingFromIndex.length} task file(s) absent from index.json: ${missingFromIndex.join(", ")}`,
      ids: missingFromIndex,
    });
  }

  // Task rows without a structured record.
  const withoutRecord = [...tableIds].filter((id) => !existingIds.has(id));
  if (withoutRecord.length > 0) {
    findings.push({
      kind: "task_rows_without_record",
      detail: `${withoutRecord.length} task row(s) have no .agent/tasks/<id>.json`,
      ids: withoutRecord,
    });
  }

  return {
    ok: true,
    found: findings.length,
    needsMigration: findings.length > 0,
    reason: findings.length > 0 ? "migration_available" : "already_migrated",
    findings,
    progressFile,
    tasksDir,
    existingTaskCount: existingTasks.length,
    lineCount,
    byteSize,
    tableTaskIds: [...tableIds],
    withoutRecord,
    missingFromIndex,
  };
}

// ─── History block extraction ────────────────────────────────────────────────

// A closeout block starts with a blockquote line carrying a bold date and
// ends at the next blockquote line that starts a new dated block. Blocks are
// the archival unit; `items` counts them, not lines.
function splitHistoryBlocks(source) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  let current = null;
  const DATE_BLOCK_RE = /^>\s*\*\*\d{4}-\d{2}-\d{2}/;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (DATE_BLOCK_RE.test(line)) {
      if (current) blocks.push(current);
      current = { date: line.match(/\d{4}-\d{2}-\d{2}/)[0], lines: [line], start: index + 1 };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);
  // Trim trailing blank lines from each block.
  for (const block of blocks) {
    while (block.lines.length && !block.lines[block.lines.length - 1].trim()) block.lines.pop();
  }
  return blocks;
}

// ─── View rendering ─────────────────────────────────────────────────────────

const MANUAL_SECTIONS = Object.freeze([
  { key: "roadmap", heading: "🗺️ 路线图", marker: "manual:roadmap" },
  { key: "backlog", heading: "⏳ 未处理事项", marker: "manual:backlog" },
  { key: "resume", heading: "🔌 断点续接", marker: "manual:resume" },
]);

function escapeCell(text) {
  return String(text == null ? "" : text).replace(/\|/g, "\\|").trim();
}

// Pull the body of a manual section out of the original document. The section
// runs from its heading to the next level-2 heading; marker comments are
// preserved verbatim when they exist.
function extractManualSection(original, heading) {
  const lines = original.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) { end = index; break; }
  }
  const body = lines.slice(start + 1, end);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return body.join("\n");
}

function renderProgressView({ original, tasks, archives, now }) {
  const date = String(now).slice(0, 10);
  const active = tasks.filter((task) => task.status !== "completed");
  const done = tasks.filter((task) => task.status === "completed");
  const total = tasks.length;
  const overall = total > 0
    ? Math.round((done.length / total) * 100)
    : 0;

  const out = [];
  out.push("# 任务进度", "");
  out.push("<!-- generated:task-progress v1; source=.agent/tasks/index.json; 请勿手改生成区 -->", "");
  out.push(`> **总体进度**: ${overall}%（由真源推导）`);
  out.push(`> **最后更新时间**: ${date}`, "");

  // roadmap: manual, preserved
  const roadmap = extractManualSection(original, "## 🗺️ 路线图");
  out.push("## 🗺️ 路线图", "<!-- manual:roadmap:start -->");
  out.push(roadmap === null ? "" : roadmap);
  out.push("<!-- manual:roadmap:end -->", "");

  // active tasks: generated
  out.push("## 🔥 当前活跃任务", "<!-- generated:active-tasks:start -->");
  out.push("| 任务 ID | 优先级 | 任务说明 | 进度 | 关联计划 |");
  out.push("| :--- | :--- | :--- | :--- | :--- |");
  for (const task of active) {
    const progress = STAGE_PROGRESS[task.stage] !== undefined
      ? `${STAGE_PROGRESS[task.stage]}%`
      : "0%";
    out.push(`| ${escapeCell(task.task_id)} | ${escapeCell(task.priority)} | ${escapeCell(task.title)} | ${progress} | [.agent/tasks/${task.task_id}.json](.agent/tasks/${task.task_id}.json) |`);
  }
  out.push("<!-- generated:active-tasks:end -->", "");

  // backlog: manual, preserved
  const backlog = extractManualSection(original, "## ⏳ 未处理事项");
  out.push("## ⏳ 未处理事项", "<!-- manual:backlog:start -->");
  out.push(backlog === null ? "- (none)" : backlog);
  out.push("<!-- manual:backlog:end -->", "");

  // resume: manual, preserved (ai-behavior.md §7 contract)
  const resume = extractManualSection(original, "## 🔌 断点续接");
  out.push("## 🔌 断点续接", "<!-- manual:resume:start -->");
  out.push(resume === null ? "- (none)" : resume);
  out.push("<!-- manual:resume:end -->", "");

  // archive index: generated
  out.push("## 📚 历史归档", "<!-- generated:archive-index:start -->");
  for (const archive of archives) {
    out.push(`- [${archive.dateRange[0]}--${archive.dateRange[1]}](task-progress-archive/${archive.fileName})（${archive.items} 条收口）`);
  }
  out.push("<!-- generated:archive-index:end -->", "");

  // Preserve every unrecognised marker block (e.g. progress-reconcile drift).
  const drift = original.match(/<!--\s*progress-reconcile:drift[\s\S]*?(?:-->|\n\n)/);
  if (drift) {
    out.push("<!-- progress-reconcile:drift -->");
  }

  return out.join("\n");
}

// ─── Plan construction ───────────────────────────────────────────────────────

const STAGE_PROGRESS = Object.freeze({
  draft: 0, spec: 15, plan: 30, implement: 55, validate: 75, review: 90, done: 100,
});

function progressToStage(progress) {
  if (progress === null || progress === undefined) return null;
  if (progress >= 100) return "done";
  if (progress >= 75) return "validate";
  if (progress >= 55) return "implement";
  if (progress >= 30) return "plan";
  if (progress >= 15) return "spec";
  return "draft";
}

function parseProgressValue(text) {
  const match = String(text || "").match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
}

function extractTitle(cell) {
  return String(cell || "")
    .replace(/\s*\|\s*$/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .trim();
}

function buildTaskRecord({ id, priority, description: rawDescription, progressText, planRef, sourceRef, timestamp }) {
  const progressValue = parseProgressValue(progressText);
  const stage = progressToStage(progressValue) || "draft";
  const status = progressValue !== null && progressValue >= 100 ? "completed" : "active";
  const description = extractTitle(rawDescription);
  return {
    task_id: id,
    title: description || id,
    description: description
      ? `Migrated from ${sourceRef}: ${description}`
      : `Migrated from ${sourceRef}; refine during /plan.`,
    status,
    stage,
    priority: ["P0", "P1", "P2", "P3"].includes(String(priority || "").trim())
      ? String(priority).trim()
      : "P2",
    owner: "cortex-agent",
    collaborators: [],
    acceptance_criteria: [
      "Migrated from task-progress.md; refine acceptance criteria during /plan",
    ],
    dependencies: [],
    subtasks: [],
    source_refs: [sourceRef],
    validation_commands: [],
    architecture_required: false,
    required_artifacts: [],
    artifacts: [],
    gates: [],
    stage_history: [
      { stage: "draft", entered_at: timestamp, gate_evidence_refs: [] },
    ],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function buildIndexEntry(task) {
  return {
    task_id: task.task_id,
    path: `${TASKS_REL.split(path.sep).join("/")}/${task.task_id}.json`,
    title: task.title,
    status: task.status,
    stage: task.stage,
    priority: task.priority,
    updated_at: task.updated_at,
  };
}

// Archive segments are keyed by the closeout event date, so a file name can
// never collide with a sibling segment and the range stays reproducible.
function archiveFileName(start, end) {
  return start === end ? `${start}.md` : `${start}--${end}.md`;
}

function groupHistoryBlocks(blocks) {
  if (blocks.length === 0) return [];
  const sorted = blocks.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const groups = [];
  let current = null;
  for (const block of sorted) {
    if (current && current.end === block.date) {
      current.blocks.push(block);
      continue;
    }
    if (current) groups.push(current);
    current = { start: block.date, end: block.date, blocks: [block] };
  }
  if (current) groups.push(current);
  return groups;
}

function planMigration({ projectRoot, now = new Date().toISOString() }) {
  const detection = detectTaskState({ projectRoot });
  if (!detection.ok) {
    return { ok: false, error: "ERR_DETECT_FAILED", detection };
  }
  if (detection.reason === "missing_task_progress") {
    return { ok: true, planned: [], skipped: [], archives: [], tasks: [], detection, alreadyMigrated: true };
  }

  // A project whose detection reports no findings is already migrated: the
  // view is generated, the records exist and the index matches disk. The plan
  // must be empty so a second apply stays a no-op.
  if (!detection.needsMigration) {
    return { ok: true, projectRoot, planned: [], skipped: [], archives: [], detection, alreadyMigrated: true };
  }

  const progressFile = detection.progressFile;
  const source = fs.readFileSync(progressFile, "utf8");
  const tables = parseTaskTables(source);
  const existingTaskFiles = listTaskFiles(detection.tasksDir);
  const existingIds = new Set(existingTaskFiles.map((entry) => entry.taskId));

  // --- classify task rows -------------------------------------------------
  const plannedTasks = [];
  const skippedTasks = [];
  for (const table of tables) {
    for (const row of table.rows) {
      const idCell = row.cells[table.header.id] || "";
      const match = idCell.match(TASK_ID_RE);
      if (!match) continue;
      const id = match[0];
      if (existingIds.has(id)) {
        skippedTasks.push({ id, reason: "record_exists" });
        continue;
      }
      const description = table.header.description !== undefined
        ? row.cells[table.header.description]
        : row.cells[table.header.id];
      const progressText = table.header.progress !== undefined
        ? row.cells[table.header.progress]
        : "";
      const priority = table.header.priority !== undefined
        ? row.cells[table.header.priority]
        : "";
      const planRef = table.header.plan !== undefined ? row.cells[table.header.plan] : "";
      const record = buildTaskRecord({
        id, priority, description, progressText, planRef,
        sourceRef: PROGRESS_REL.split(path.sep).join("/"),
        timestamp: now,
      });
      plannedTasks.push(record);
    }
  }

  // --- classify history blocks ---------------------------------------------
  const blocks = splitHistoryBlocks(source);
  const groups = groupHistoryBlocks(blocks);
  const archives = groups.map((group) => ({
    fileName: archiveFileName(group.start, group.end),
    dateRange: [group.start, group.end],
    items: group.blocks.length,
    body: group.blocks
      .map((block) => block.lines.join("\n"))
      .join("\n\n"),
  }));

  return {
    ok: true,
    planned: plannedTasks,
    skipped: skippedTasks,
    projectRoot,
    archives,
    detection,
    alreadyMigrated: false,
  };
}

// ─── Apply ──────────────────────────────────────────────────────────────────

function archiveFrontmatter(archive, migratedBy) {
  return [
    "---",
    `title: "task-progress 归档 ${archive.dateRange[0]}--${archive.dateRange[1]}"`,
    "kind: task-progress-archive",
    `date_range: [${archive.dateRange[0]}, ${archive.dateRange[1]}]`,
    `items: ${archive.items}`,
    `migrated_by: ${migratedBy}`,
    "---",
    "",
  ].join("\n");
}

function applyMigration(plan, { confirm = false, now = new Date().toISOString() } = {}) {
  if (!plan || !plan.ok) {
    return { ok: false, applied: 0, errors: [{ code: "ERR_PLAN_INVALID" }] };
  }
  if (plan.alreadyMigrated) {
    return { ok: true, applied: 0, written: [], errors: [], reason: "already_migrated" };
  }
  if (!confirm) {
    return {
      ok: false,
      applied: 0,
      errors: [{
        code: "ERR_CONFIRM_REQUIRED",
        message: "refusing to migrate without confirm=true. Pass --confirm or review the plan first.",
      }],
    };
  }

  const projectRoot = plan.projectRoot;
  const written = [];
  const errors = [];
  try {
    const progressFile = path.join(projectRoot, PROGRESS_REL);
    const snapshotDir = path.join(projectRoot, SNAPSHOT_REL);
    const archiveDir = path.join(projectRoot, ARCHIVE_REL);
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });

    // 1. snapshot the original file before any mutation
    const stamp = now.replace(/[:.]/g, "-");
    const snapshotFile = path.join(snapshotDir, `task-progress-${stamp}.md.bak`);
    fs.copyFileSync(progressFile, snapshotFile);
    written.push({ path: path.relative(projectRoot, snapshotFile), kind: "snapshot" });

    // 2. write structured task records
    const tasksDir = path.join(projectRoot, TASKS_REL);
    fs.mkdirSync(tasksDir, { recursive: true });
    for (const record of plan.planned) {
      const target = path.join(tasksDir, `${record.task_id}.json`);
      fs.writeFileSync(target, JSON.stringify(record, null, 2) + "\n", "utf8");
      written.push({ path: path.relative(projectRoot, target), kind: "task" });
    }

    // 3. write archive segments
    const version = require("../../package.json").version;
    for (const archive of plan.archives) {
      const target = path.join(archiveDir, archive.fileName);
      fs.writeFileSync(target, archiveFrontmatter(archive, `migrate-task-state@${version}`) + archive.body + "\n", "utf8");
      written.push({ path: path.relative(projectRoot, target), kind: "archive" });
    }

    // 4. rebuild index.json from the files actually on disk
    const indexFile = path.join(tasksDir, "index.json");
    const index = readJson(indexFile) || { tasks: [] };
    const byId = new Map();
    for (const entry of Array.isArray(index.tasks) ? index.tasks : []) {
      if (entry && entry.task_id) byId.set(entry.task_id, entry);
    }
    for (const record of plan.planned) byId.set(record.task_id, buildIndexEntry(record));
    const onDisk = listTaskFiles(tasksDir);
    for (const entry of onDisk) {
      if (byId.has(entry.taskId)) continue;
      const task = readJson(entry.file);
      if (!task) continue;
      byId.set(entry.taskId, buildIndexEntry(task));
    }
    const tasks = [...byId.values()].sort((a, b) =>
      String(a.task_id).localeCompare(String(b.task_id)));
    fs.writeFileSync(indexFile, JSON.stringify({ tasks }, null, 2) + "\n", "utf8");
    written.push({ path: path.relative(projectRoot, indexFile), kind: "index" });

    // 5. rebuild the view: generated sections from records, manual sections
    //    preserved verbatim from the original file.
    const view = renderProgressView({
      original: fs.readFileSync(progressFile, "utf8"),
      tasks: plan.planned,
      archives: plan.archives,
      now,
    });
    fs.writeFileSync(progressFile, view, "utf8");
    written.push({ path: PROGRESS_REL.split(path.sep).join("/"), kind: "view" });

    return { ok: true, applied: written.length, written, errors, snapshot: path.relative(projectRoot, snapshotFile) };
  } catch (error) {
    errors.push({ code: error.code || "ERR_APPLY_FAILED", message: error.message });
    return { ok: false, applied: written.length, written, errors };
  }
}

// ─── Opt-in auto repair ──────────────────────────────────────────────────────

// `.agent/config/auto-repair.json` lets a project pre-authorize the task-state
// migration so `upgrade` can apply it without an interactive prompt. The flag
// is opt-in and defaults to off: the plain upgrade path stays read-only
// (architecture-design.md §3 — additive only).
const AUTO_REPAIR_REL = path.join(".agent", "config", "auto-repair.json");

function readAutoRepairConfig(projectRoot) {
  const file = path.join(projectRoot, AUTO_REPAIR_REL);
  if (!fs.existsSync(file)) return { taskState: false };
  const data = readJson(file);
  if (!data) return { taskState: false };
  return { taskState: data.task_state === true };
}

function autoRepairEnabled(projectRoot) {
  return readAutoRepairConfig(projectRoot).taskState === true;
}

module.exports = {
  detectTaskState,
  planMigration,
  applyMigration,
  renderProgressView,
  buildTaskRecord,
  groupHistoryBlocks,
  archiveFileName,
  progressToStage,
  parseProgressValue,
  parseTaskTables,
  classifyHeader,
  splitHistoryBlocks,
  autoRepairEnabled,
  readAutoRepairConfig,
  PROGRESS_REL,
  TASKS_REL,
  ARCHIVE_REL,
  SNAPSHOT_REL,
  AUTO_REPAIR_REL,
  TASK_ID_RE,
};
