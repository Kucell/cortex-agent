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
const MISSIONS_REL = path.join(".agent", "missions");
const ARCHIVE_REL = path.join(".agent", "plans", "task-progress-archive");
const SNAPSHOT_REL = path.join(".agent", "plans", "task-progress-archive", "_snapshots");

// ─── Task-state rules (single source of truth) ───────────────────────────────
//
// Which files are task records, what a task id looks like and how a legacy
// markdown table is read are shipped rules, not migration details: the
// renderer, the parser and the truth-source auditor must agree on them.
//
// The implementation lives in `.agent/tasks/scripts/task-state.js`. This
// module loads it from the project and falls back to the CLI's template copy
// when the project predates the export — an upgraded project must still be
// migratable by the tool that upgrades it.
function resolveTaskStateModule(projectRoot) {
  const candidates = [
    path.join(projectRoot, ".agent", "tasks", "scripts", "task-state.js"),
    path.join(__dirname, "..", "..", "templates", "_shared", ".agent", "tasks", "scripts", "task-state.js"),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const loaded = require(candidate);
      if (typeof loaded.parseTaskTables === "function"
        && typeof loaded.listTaskRecordFiles === "function") {
        return loaded;
      }
    } catch (_) { /* try the next candidate */ }
  }
  return null;
}

// The module the CLI always has: its own template copy — the one it ships to
// projects. Used for the standalone helpers below, which have no project to
// resolve against.
function cliTaskStateModule() {
  const templateCopy = path.join(
    __dirname, "..", "..", "templates", "_shared", ".agent", "tasks", "scripts", "task-state.js"
  );
  if (!fs.existsSync(templateCopy)) return null;
  try {
    const loaded = require(templateCopy);
    return typeof loaded.parseTaskTables === "function" ? loaded : null;
  } catch (_) {
    return null;
  }
}

function requireTaskStateModule(projectRoot) {
  const loaded = resolveTaskStateModule(projectRoot);
  if (!loaded) {
    const error = new Error(
      "task-state rules not found: expected .agent/tasks/scripts/task-state.js in the project "
      + "or the CLI template copy"
    );
    error.code = "ERR_TASK_STATE_MODULE_NOT_FOUND";
    throw error;
  }
  return loaded;
}

// The task record files of a tasks directory, with the id each file carries.
// The name IS the identity (L1 rule), so the id is the file name.
function listTaskFiles(tasksDir, taskStateModule) {
  const mod = taskStateModule || cliTaskStateModule();
  if (!mod) return [];
  return mod.listTaskRecordFiles(tasksDir).map((name) => ({
    name,
    taskId: name.replace(/\.json$/, ""),
    file: path.join(tasksDir, name),
  }));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

// ─── Namespaces ──────────────────────────────────────────────────────────────
//
// Two namespaces share the task-progress table: `T-` ids are tasks
// (`.agent/tasks/<id>.json`) and `M-` ids are missions
// (`.agent/missions/<id>/mission.json`). They are different records with
// different schemas, so a row must be routed to the namespace it belongs to.
// Reading an `M-` row as a missing task record would report every project
// that has missions as "not migrated" — a permanent false alarm that trains
// people to ignore the reminder — and migrating it would write mission ids
// into the task namespace.

function isMissionId(id) {
  return /^M-/.test(String(id || ""));
}

// The mission ids a project already owns. Both layouts are accepted: the
// nested `<id>/mission.json` and the flat `<id>.json`.
function listMissionIds(projectRoot) {
  const missionsDir = path.join(projectRoot, MISSIONS_REL);
  const ids = new Set();
  let names = [];
  try { names = fs.readdirSync(missionsDir); } catch (_) { return ids; }
  for (const name of names) {
    if (fs.existsSync(path.join(missionsDir, name, "mission.json"))) {
      ids.add(name);
      continue;
    }
    if (!/^M-[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name)) continue;
    ids.add(name.replace(/\.json$/, ""));
  }
  return ids;
}

// ─── Detection ───────────────────────────────────────────────────────────────

function detectTaskState({ projectRoot }) {
  const progressFile = path.join(projectRoot, PROGRESS_REL);
  const tasksDir = path.join(projectRoot, TASKS_REL);
  const findings = [];
  const taskStateModule = requireTaskStateModule(projectRoot);
  const existingTasks = listTaskFiles(tasksDir, taskStateModule);
  const existingIds = new Set(existingTasks.map((entry) => entry.taskId));
  const existingMissionIds = listMissionIds(projectRoot);

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
  const tables = taskStateModule.parseTaskTables(source);
  const tableIds = new Set();
  for (const table of tables) {
    for (const row of table.rows) {
      if (row.id) tableIds.add(row.id);
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

  // Task rows without a structured record. Mission rows are checked against
  // their own namespace — an `M-` row is not a missing task record.
  const withoutRecord = [...tableIds].filter((id) => !isMissionId(id) && !existingIds.has(id));
  if (withoutRecord.length > 0) {
    findings.push({
      kind: "task_rows_without_record",
      detail: `${withoutRecord.length} task row(s) have no .agent/tasks/<id>.json`,
      ids: withoutRecord,
    });
  }

  // Mission rows without a mission record. Reported apart: the migration
  // does not create missions, so these need the mission pipeline, not this
  // one.
  const missionRowsWithoutRecord = [...tableIds]
    .filter((id) => isMissionId(id) && !existingMissionIds.has(id));
  if (missionRowsWithoutRecord.length > 0) {
    findings.push({
      kind: "mission_rows_without_record",
      detail: `${missionRowsWithoutRecord.length} mission row(s) have no .agent/missions/<id>/mission.json`,
      ids: missionRowsWithoutRecord,
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

// The acceptance criterion a migrated record carries. The old markdown had no
// acceptance criteria, so any concrete value would be fabricated — the
// placeholder says so instead, and stays recognizable so the debt can be
// counted (a migrated task whose criteria still read like this was never
// specified).
const MIGRATED_CRITERION_PLACEHOLDER = "Migrated from task-progress.md; refine acceptance criteria during /plan";
// The marker a migrated record carries until /plan refines its acceptance
// criteria. Detection uses the marker, not the full sentence, so the text
// can be reworded without hiding the debt.
const MIGRATED_CRITERION_MARKER = "Migrated from task-progress.md";

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
    acceptance_criteria: [MIGRATED_CRITERION_PLACEHOLDER],
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
  const taskStateModule = requireTaskStateModule(projectRoot);
  const tables = taskStateModule.parseTaskTables(source);
  const existingTaskFiles = listTaskFiles(detection.tasksDir, taskStateModule);
  const existingIds = new Set(existingTaskFiles.map((entry) => entry.taskId));

  // --- classify task rows -------------------------------------------------
  const plannedTasks = [];
  const skippedTasks = [];
  for (const table of tables) {
    for (const row of table.rows) {
      if (!row.id) continue;
      const id = row.id;
      // An `M-` row is a mission, not a task. Writing it as a task record
      // would put mission ids into the task namespace with a task-shaped
      // schema — the two namespaces have different records and different
      // pipelines. The mission truth source is built by the mission
      // generator, not here.
      if (isMissionId(id)) {
        skippedTasks.push({ id, reason: "mission_namespace" });
        continue;
      }
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
    // Read-only preview of what `apply` will promise: the records the
    // migration would write satisfy the task schema.
    validation: validatePlannedRecords(plannedTasks, projectRoot),
  };
}

// ─── Canonical renderer + schema resolution ──────────────────────────────────
//
// The migration writes the very files the project will live with from then on:
// the task records, the index and the view. Two rules follow from that:
//
//   1. The view must be produced by the SAME renderer the project uses every
//      day. A second implementation here writes a view the canonical renderer
//      considers drifted — the project would start its post-upgrade life with
//      a red gate, and "just re-render it" would move sections around.
//   2. The records must satisfy `task.schema.json`. The schema ships with the
//      project, so the project can keep checking its own truth source after
//      the upgrade without depending on this CLI.
//
// The project's own copy wins; the CLI's template copy is the fallback.

function resolveProjectFile(projectRoot, relative, templateRelative) {
  const candidates = [
    path.join(projectRoot, relative),
    path.join(__dirname, "..", "..", "templates", "_shared", templateRelative),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveRenderer(projectRoot) {
  return resolveProjectFile(
    projectRoot,
    path.join(".agent", "tasks", "scripts", "render-progress.js"),
    path.join(".agent", "tasks", "scripts", "render-progress.js")
  );
}

function resolveTaskSchema(projectRoot) {
  return resolveProjectFile(
    projectRoot,
    path.join(".agent", "tasks", "task.schema.json"),
    path.join(".agent", "tasks", "task.schema.json")
  );
}

function resolveSchemaValidator(projectRoot) {
  return resolveProjectFile(
    projectRoot,
    path.join(".agent", "scripts", "json-schema.js"),
    path.join(".agent", "scripts", "json-schema.js")
  );
}

// Validate the records the migration is about to write, BEFORE anything is
// written. A migration that produces records the schema rejects must not
// leave them behind — the project would carry a broken truth source forward.
function validatePlannedRecords(records, projectRoot) {
  const schemaFile = resolveTaskSchema(projectRoot);
  const validatorFile = resolveSchemaValidator(projectRoot);
  if (!schemaFile) {
    return { ok: true, skipped: true, reason: "task_schema_not_found", errors: [] };
  }
  if (!validatorFile) {
    return { ok: true, skipped: true, reason: "schema_validator_not_found", errors: [] };
  }
  const schema = readJson(schemaFile);
  if (!schema) {
    return { ok: true, skipped: true, reason: "task_schema_unreadable", errors: [] };
  }
  const { validateRecord } = require(validatorFile);
  const errors = [];
  for (const record of records) {
    const result = validateRecord(record, schema, "task.schema.json");
    if (!result.ok) errors.push({ task_id: record.task_id, violations: result.errors });
  }
  return {
    ok: errors.length === 0,
    skipped: false,
    errors,
    schema: schemaFile,
    validator: validatorFile,
  };
}

// Audit the task records a project currently holds.
//
// This is the project's own self-check: it runs against the schema and the
// validator that ship with the project, so an upgraded project can tell
// whether its truth source is still sound without depending on the framework
// repository.
//
// When the project ships its own truth-source auditor
// (`.agent/scripts/validate-tasks.js`), that auditor owns the audit: the
// exception registry and its stale detection live there, and restating them
// here would create a second rule for the same debt. The built-in audit below
// is the fallback for projects that do not ship one.
//
// Returns { checked, invalid, exceptions, placeholder, skipped, reason }.
function auditTaskRecords(projectRoot) {
  const projectAuditor = path.join(projectRoot, ".agent", "scripts", "validate-tasks.js");
  if (fs.existsSync(projectAuditor)) {
    try {
      const { audit } = require(projectAuditor);
      const report = audit({ project: projectRoot, staleDays: 90, failOnStale: false });
      return {
        checked: report.records || 0,
        invalid: (report.errors || []).map((entry) => ({
          task_id: entry.task_id,
          violations: Array.isArray(entry.violations) ? entry.violations : [entry.detail].filter(Boolean),
        })),
        exceptions: report.known_debt || [],
        placeholder: [],
        skipped: Boolean(report.skipped),
        reason: report.reason || null,
      };
    } catch (_) { /* fall back to the built-in audit */ }
  }
  return auditTaskRecordsBuiltin(projectRoot);
}

function auditTaskRecordsBuiltin(projectRoot) {
  const tasksDir = path.join(projectRoot, TASKS_REL);
  const taskStateModule = resolveTaskStateModule(projectRoot);
  const files = listTaskFiles(tasksDir, taskStateModule);
  const schemaFile = resolveTaskSchema(projectRoot);
  const validatorFile = resolveSchemaValidator(projectRoot);
  const result = { checked: 0, invalid: [], exceptions: [], placeholder: [], skipped: false, reason: null };

  if (!schemaFile) {
    result.skipped = true;
    result.reason = "task_schema_not_found";
    return result;
  }
  if (!validatorFile) {
    result.skipped = true;
    result.reason = "schema_validator_not_found";
    return result;
  }
  const schema = readJson(schemaFile);
  if (!schema) {
    result.skipped = true;
    result.reason = "task_schema_unreadable";
    return result;
  }
  const { validateRecord } = require(validatorFile);

  for (const entry of files) {
    const record = readJson(entry.file);
    if (!record) {
      result.invalid.push({ task_id: entry.taskId, violations: ["record is not valid JSON"] });
      continue;
    }
    result.checked += 1;
    const validation = validateRecord(record, schema, "task.schema.json");
    if (!validation.ok) {
      result.invalid.push({ task_id: entry.taskId, violations: validation.errors });
    }
    const criteria = Array.isArray(record.acceptance_criteria) ? record.acceptance_criteria : [];
    if (criteria.some((item) => String(item).includes(MIGRATED_CRITERION_MARKER))) {
      result.placeholder.push(entry.taskId);
    }
  }
  return result;
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
  const warnings = [];

  // Validate the records BEFORE anything is written. A migration that cannot
  // promise a compliant truth source must stop here, not half-way.
  const validation = validatePlannedRecords(plan.planned, projectRoot);
  if (!validation.ok) {
    return {
      ok: false,
      applied: 0,
      written: [],
      errors: [{
        code: "ERR_RECORDS_NOT_COMPLIANT",
        message: `the migration would write ${validation.errors.length} record(s) that do not satisfy task.schema.json`,
        violations: validation.errors,
      }],
    };
  }
  if (validation.skipped) {
    warnings.push({
      code: "WARN_SCHEMA_NOT_CHECKED",
      message: `task schema compliance was not checked (${validation.reason})`,
    });
  }

  // Keep the pre-migration content so a failure half-way through can be undone.
  const progressFile = path.join(projectRoot, PROGRESS_REL);
  const indexFile = path.join(projectRoot, TASKS_REL, "index.json");
  const originalView = fs.existsSync(progressFile) ? fs.readFileSync(progressFile, "utf8") : null;
  const originalIndex = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, "utf8") : null;

  try {
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
    const onDisk = listTaskFiles(tasksDir, requireTaskStateModule(projectRoot));
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

    // 5. rebuild the view with the SAME renderer the project uses every day.
    //    A second implementation would write a view the canonical renderer
    //    considers drifted — the project would start its post-upgrade life with
    //    a red gate.
    const renderer = resolveRenderer(projectRoot);
    if (renderer) {
      const { buildView } = require(renderer);
      const { view } = buildView(projectRoot, now);
      fs.writeFileSync(progressFile, view, "utf8");
    } else {
      // No canonical renderer available (a project that predates it): fall
      // back to this module's own renderer and say so, because the view may
      // differ from what the canonical renderer would produce.
      const view = renderProgressView({
        original: originalView || "",
        tasks: plan.planned,
        archives: plan.archives,
        now,
      });
      fs.writeFileSync(progressFile, view, "utf8");
      warnings.push({
        code: "WARN_FALLBACK_RENDERER",
        message: "no canonical renderer found; the view was written by the migration's own renderer and may differ from the canonical one",
      });
    }
    written.push({ path: PROGRESS_REL.split(path.sep).join("/"), kind: "view" });

    return {
      ok: true,
      applied: written.length,
      written,
      errors,
      warnings,
      snapshot: path.relative(projectRoot, snapshotFile),
      validation: { ok: validation.ok, skipped: validation.skipped },
    };
  } catch (error) {
    // Undo what this run wrote: an upgrade must not leave a project half
    // migrated. The snapshot of the original view is kept either way.
    for (const entry of written) {
      if (entry.kind === "task" || entry.kind === "archive") {
        try { fs.unlinkSync(path.join(projectRoot, entry.path)); } catch (_) { /* already gone */ }
      }
    }
    if (originalView !== null) {
      try { fs.writeFileSync(progressFile, originalView, "utf8"); } catch (_) { /* nothing else to try */ }
    }
    if (originalIndex !== null) {
      try { fs.writeFileSync(indexFile, originalIndex, "utf8"); } catch (_) { /* nothing else to try */ }
    }
    errors.push({ code: error.code || "ERR_APPLY_FAILED", message: error.message });
    return { ok: false, applied: 0, written: [], errors, warnings, rolled_back: true };
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

// The task-state rules are re-exported from the single implementation so
// callers (and older consumers of this module) keep one source of truth.
function cliTaskStateRules() {
  const mod = cliTaskStateModule();
  if (!mod) {
    const error = new Error("task-state rules not found in the CLI template copy");
    error.code = "ERR_TASK_STATE_MODULE_NOT_FOUND";
    throw error;
  }
  return mod;
}

module.exports = {
  detectTaskState,
  planMigration,
  applyMigration,
  auditTaskRecords,
  renderProgressView,
  buildTaskRecord,
  groupHistoryBlocks,
  archiveFileName,
  progressToStage,
  parseProgressValue,
  parseTaskTables: (source) => cliTaskStateRules().parseTaskTables(source),
  classifyHeader: (cells) => cliTaskStateRules().classifyHeader(cells),
  splitHistoryBlocks,
  autoRepairEnabled,
  readAutoRepairConfig,
  resolveTaskStateModule,
  PROGRESS_REL,
  TASKS_REL,
  ARCHIVE_REL,
  SNAPSHOT_REL,
  AUTO_REPAIR_REL,
  get TASK_ID_RE() { return cliTaskStateRules().TASK_ID_RE; },
};
