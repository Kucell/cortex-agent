"use strict";

const path = require("path");

// A task record file is named after the task it holds: `T-<id>.json`.
//
// The name IS the identity — the renderer, the parser and the truth-source
// auditor must agree on which files are records. Restating the rule in each
// consumer is how a stray file (index.json, sample.json) silently becomes a
// task, so the rule lives here and is exported.
const TASK_FILE_RE = /^T-[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

// List the task record files of a tasks directory, sorted by name.
// Returns [] when the directory does not exist — a project without task
// records is a valid state, not an error.
function listTaskRecordFiles(tasksDir) {
  const fs = require("fs");
  let names = [];
  try { names = fs.readdirSync(tasksDir); } catch (_) { names = []; }
  return names.filter((name) => TASK_FILE_RE.test(name)).sort();
}

function validationStatusFromText(value) {
  const matches = [...String(value || "").matchAll(/\b(NOT_RUN|PARTIAL|PASS|FAIL)\b/gi)];
  return matches.length ? matches[matches.length - 1][1].toUpperCase() : "";
}

function hasExplicitTaskBlock(value) {
  const text = String(value || "")
    .replace(/\b(?:not[- ]blocked|non[- ]blocking)\b/gi, "")
    .replace(/(?:不|非|未)(?:会|应)?阻塞/g, "");
  return /\[(?:blocked|阻塞|暂停)\]|(?:status|状态)\s*[:：=]\s*(?:blocked|阻塞|暂停)|(?:^|[|;；])\s*(?:blocked|阻塞|暂停)\s*(?:$|[|;；])|⚠️|❌/i.test(text);
}

function extractMarkdownRefs(...values) {
  const refs = [];
  const seen = new Set();
  for (const value of values) {
    for (const match of String(value || "").matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const raw = match[1].trim().replace(/^<|>$/g, "").split(/[?#]/)[0];
      if (!raw || raw.startsWith("/") || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
      const normalized = path.posix.normalize(
        raw.startsWith(".agent/") || raw.startsWith("docs/")
          ? raw
          : path.posix.join(".agent/plans", raw),
      );
      if (normalized.startsWith("../") || seen.has(normalized)) continue;
      seen.add(normalized);
      refs.push(normalized);
    }
  }
  return refs;
}

// Table headers are matched by MEANING, not by position. The same project can
// carry 4-column (id/priority/description/progress), 5-column
// (id/priority/milestone/description/progress), 6-column and 7-column task
// tables in the same file (P-001 §2 E11). Taking a fixed index reads the
// description as if it were the progress.
const HEADER_ALIASES = Object.freeze({
  id: [/^任务\s*id$/i, /^task\s*id$/i, /^id$/i],
  priority: [/^优先级$/, /^priority$/i],
  milestone: [/^milestone$/i, /^里程碑$/],
  description: [/^描述$/, /^说明$/, /^任务说明$/, /^description$/i, /^task$/i],
  progress: [/^进度$/, /^progress$/i],
  plan: [/^关联计划$/, /^计划$/, /^plan$/i],
});

// Split a markdown table row into cells, honouring escaped pipes (`\|`).
// A literal pipe inside a cell (e.g. `templates/zh\|en/`) would otherwise
// split the row into the wrong number of columns and shift every value.
function splitTableRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|")) return null;
  const inner = trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed.slice(1);
  const cells = [];
  let current = "";
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === "\\" && inner[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}
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

// `header` maps a semantic column name to its index. When absent (a table
// without a recognizable header) the historical positional layout is used.
function taskFromTableCells(cells, header) {
  const idColumn = header && header.id !== undefined ? header.id : 0;
  const id = (String(cells[idColumn] || "").match(/\b(?:T|M)-[A-Za-z0-9-]+\b/) || [])[0];
  if (!id) return null;
  // When a header is known, a column the header does not declare does not
  // exist: reading it by position would return a neighbouring value (a 5
  // column table with no plan column must not report the progress as the
  // plan). Without a header, the historical positional layout is used.
  const cell = (name, fallbackIndex) => {
    if (header) {
      const index = header[name];
      return index === undefined ? "" : String(cells[index] || "");
    }
    return fallbackIndex === undefined ? "" : String(cells[fallbackIndex] || "");
  };
  const joined = cells.join(" ");
  const progressText = cell("progress", 3);
  const descriptionText = cell("description", 2);
  const planText = cell("plan", 4);
  const priorityText = cell("priority", 1);
  const progressMatch = progressText.match(/(\d+(?:\.\d+)?)\s*%/);
  const progressValue = progressMatch ? Number(progressMatch[1]) : null;
  const blocked = hasExplicitTaskBlock(joined);
  const done = progressValue === 100 || /\[[xX]\]|完成|Done|已合入|PASS/i.test(progressText + " " + descriptionText);
  const active = !done && !blocked && (
    progressValue !== null && progressValue > 0
    || /active|进行中|in[- ]progress|当前/i.test(joined)
  );
  const sourceRefs = extractMarkdownRefs(descriptionText, progressText, planText);
  return {
    id,
    priority: priorityText,
    title: descriptionText || id,
    progress: progressMatch ? `${progressMatch[1]}%` : progressText,
    plan: planText,
    source_refs: sourceRefs.length ? sourceRefs : [".agent/plans/task-progress.md"],
    status: done ? "done" : blocked ? "blocked" : active ? "active" : "open",
    validation_status: validationStatusFromText(joined),
  };
}

const ACTIVE_SECTION_HEADING_RE = /##\s*[^\n]*(?:当前活跃任务|Active Tasks)[^\n]*\n/gi;

// MS-1 (task-state-truth-source): long-lived files may contain the active-tasks
// heading more than once. Collect every section and let the LAST one yielding
// task rows win ("later write is newer"). A file that has the heading but no
// parseable task table is malformed and must NOT drop into the whole-file
// fallback — that path is what produced phantom tasks from history log lines.
function collectActiveSections(source) {
  const sections = [];
  for (const match of source.matchAll(ACTIVE_SECTION_HEADING_RE)) {
    const rest = source.slice(match.index + match[0].length);
    const end = rest.search(/\n##\s|\n---\s*$/);
    sections.push(end >= 0 ? rest.slice(0, end) : rest);
  }
  return sections;
}

// Parse the task table of one active-tasks section. The header row is
// remembered so data rows are read through the header semantics.
function tasksFromActiveSection(section) {
  const tasks = [];
  let header = null;
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || /^\|\s*:?-{3,}/.test(trimmed)) continue;
    const cells = splitTableRow(trimmed);
    if (cells.length < 3) continue;
    const candidate = classifyHeader(cells);
    // A header row never carries a task id; a data row always does.
    const headerLike = candidate.id !== undefined && candidate.progress !== undefined
      && !/\b(?:T|M)-[A-Za-z0-9-]+\b/.test(cells[candidate.id] || "");
    if (headerLike) {
      header = candidate;
      continue;
    }
    if (header) {
      const task = taskFromTableCells(cells, header);
      if (task) tasks.push(task);
      continue;
    }
    // No header seen: fall back to the historical positional layout, but
    // only for tables that look like task tables.
    if (cells.length < 4 || /任务\s*ID|Task\s*ID/i.test(cells[0])) continue;
    const task = taskFromTableCells(cells, null);
    if (task) tasks.push(task);
  }
  return tasks;
}

function fallbackTaskScan(source) {
  const seen = new Set();
  const tasks = [];
  let inFence = false;
  for (const line of source.split(/\r?\n/)) {
    // History logs live in blockquotes and code fences; neither is a task list.
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence || /^\s*>/.test(line)) continue;
    const id = (line.match(/\bT-[A-Za-z0-9-]+\b/) || [])[0];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const done = /\[[xX]\]|✅|完成|Done/i.test(line);
    const blocked = hasExplicitTaskBlock(line);
    const active = /active|进行中|in[- ]progress|当前/i.test(line);
    const sourceRefs = extractMarkdownRefs(line);
    tasks.push({
      id,
      title: line.replace(/^\s*[-*]\s*/, "").replace(/\*\*/g, "").slice(0, 180),
      priority: "",
      progress: "",
      plan: "",
      source_refs: sourceRefs.length ? sourceRefs : [".agent/plans/task-progress.md"],
      status: done ? "done" : blocked ? "blocked" : active ? "active" : "open",
      validation_status: validationStatusFromText(line),
    });
  }
  return tasks;
}

function parseTaskProgress(text) {
  const source = String(text || "");
  const sections = collectActiveSections(source);
  if (sections.length) {
    let tableTasks = [];
    for (const section of sections) {
      const rows = tasksFromActiveSection(section);
      if (rows.length) tableTasks = rows;
    }
    if (tableTasks.length) return tableTasks;
    // Non-enumerable diagnostics keep array shape and JSON output unchanged.
    return Object.defineProperties([], {
      malformed: { value: true },
      diagnostics: { value: "active_tasks_section_malformed" },
    });
  }
  return fallbackTaskScan(source);
}

// ─── Structured truth source projection (T-TS-003 / MS-3) ────────────────────
//
// `.agent/tasks/*.json` and `.agent/missions/*/mission.json` are the task
// state truth source (P-001 §7.2). This module projects them into the shape
// consumers already expect:
//
//   { id, priority, title, progress, plan, source_refs, status, validation_status }
//
// The markdown view stays a supported fallback so a project that has not run
// `migrate-task-state` keeps working unchanged.

// stage -> progress percentage. Shared with the view renderer so the two
// never disagree about what a stage is worth.
const STAGE_PROGRESS = Object.freeze({
  draft: 0, spec: 15, plan: 30, implement: 55, validate: 75, review: 90, done: 100,
});

// Where a mission record lives, relative to the project root.
const MISSION_REF_REL = ".agent/missions";

// The validation gate is the one that ends at `validate`. Its status maps
// onto the vocabulary consumers already use.
function validationStatusFromGates(gates) {
  if (!Array.isArray(gates)) return "";
  const validateGate = gates.find((gate) => gate && gate.to_stage === "validate");
  if (!validateGate) return "";
  const status = String(validateGate.status || "").toLowerCase();
  if (status === "passed") return "PASS";
  if (status === "blocked") return "FAIL";
  if (status === "waived") return "WAIVED";
  return "NOT_RUN";
}

function projectTaskRecord(record, options = {}) {
  if (!record || !record.task_id) return null;
  const stage = String(record.stage || "draft");
  const progress = options.progressOverride !== undefined
    ? options.progressOverride
    : (STAGE_PROGRESS[stage] !== undefined ? STAGE_PROGRESS[stage] + "%" : "0%");
  const status = record.status === "completed" || stage === "done"
    ? "done"
    : record.status === "blocked"
      ? "blocked"
      : record.status === "canceled"
        ? "canceled"
        : record.status === "superseded"
          ? "superseded"
          : record.status === "draft"
            ? "open"
            : "active";
  const refs = Array.isArray(record.source_refs) && record.source_refs.length
    ? record.source_refs.slice()
    : [".agent/plans/task-progress.md"];
  return {
    id: record.task_id,
    priority: record.priority || "",
    title: record.title || record.task_id,
    progress,
    plan: refs[0],
    source_refs: refs,
    status,
    validation_status: validationStatusFromGates(record.gates),
  };
}

function readJsonSafe(file) {
  try { return JSON.parse(require("fs").readFileSync(file, "utf8")); } catch (_) { return null; }
}

// ─── Mission projection ──────────────────────────────────────────────────────
//
// A mission record lives at `.agent/missions/<mission-id>/mission.json`. It
// projects into the same task shape, but two things differ from a T- record:
// its progress comes from its milestones, and its reference points at the
// mission record itself rather than at a task file that does not exist.

// A milestone that passed, or was explicitly waived, counts as done.
function missionProgress(record) {
  const milestones = Array.isArray(record.milestones) ? record.milestones : [];
  if (!milestones.length) return 0;
  const done = milestones.filter(
    (milestone) => milestone && (milestone.status === "passed" || milestone.status === "waived")
  ).length;
  return Math.round((done / milestones.length) * 100);
}

// A mission record projects into the same task shape as a T- record.
//
// Two shapes are accepted. The schema shape (mission.schema.json) carries
// `milestones` and no `stage`/`progress`, so its progress is derived from the
// milestones. An older task-shaped record carries `stage`/`progress` directly;
// when it does, those explicit values win.
function projectMissionRecord(record) {
  if (!record || !record.mission_id) return null;
  const status = record.status === "completed"
    ? "done"
    : record.status === "canceled"
      ? "canceled"
      : record.status === "superseded"
        ? "superseded"
        : record.status === "blocked"
          ? "blocked"
          : record.status === "draft"
            ? "open"
            : "active";
  const defaultRef = `${MISSION_REF_REL}/${record.mission_id}/mission.json`;
  const refs = Array.isArray(record.source_refs) && record.source_refs.length
    ? record.source_refs
    : [defaultRef];
  const progress = record.progress !== undefined
    ? String(record.progress)
    : record.stage !== undefined && STAGE_PROGRESS[record.stage] !== undefined
      ? STAGE_PROGRESS[record.stage] + "%"
      : missionProgress(record) + "%";
  return {
    id: record.mission_id,
    priority: record.priority || "",
    title: record.title || record.mission_id,
    progress,
    plan: refs[0],
    source_refs: refs,
    status,
    validation_status: validationStatusFromGates(record.gates),
  };
}

// Read the structured truth source. Returns null when the project has no
// task records at all, which is the signal for the caller to fall back to
// the markdown view.
function readStructuredTasks(options = {}) {
  const fs = require("fs");
  const path = require("path");
  const root = options.projectRoot || process.cwd();
  const tasksDir = path.join(root, ".agent", "tasks");
  const missionsDir = path.join(root, ".agent", "missions");
  const out = [];
  for (const name of listTaskRecordFiles(tasksDir)) {
    const record = readJsonSafe(path.join(tasksDir, name));
    if (!record || !record.task_id) continue;
    const projected = projectTaskRecord(record);
    if (projected) out.push(projected);
  }
  // Missions live in a per-mission directory: `.agent/missions/M-xxx/mission.json`.
  let missionDirs = [];
  try { missionDirs = fs.readdirSync(missionsDir); } catch (_) { missionDirs = []; }
  for (const dir of missionDirs) {
    const missionFile = path.join(missionsDir, dir, "mission.json");
    if (!fs.existsSync(missionFile)) continue;
    const record = readJsonSafe(missionFile);
    if (!record || !record.mission_id) continue;
    const projected = projectMissionRecord(record);
    if (projected) out.push(projected);
  }
  if (!out.length) return null;
  return out;
}

// The single entry point consumers should use: structured truth source first,
// markdown view as fallback. `source` reports which path produced the data.
// A view carrying generated regions was produced by `migrate-task-state` or
// `render-progress`: it is a pure projection of the structured records, so
// the structured source is complete and authoritative for it.
//
// The check looks for ANY `generated:*` region marker, not just the file
// header one. A view whose header marker was accidentally removed still
// has its generated regions, and treating it as a legacy view would let a
// hand-edited row leak back into the truth source projection — exactly the
// phantom-task failure mode MS-1 was written to eliminate.
const GENERATED_VIEW_MARKERS = Object.freeze([
  "<!-- generated:task-progress v1",
  "<!-- generated:active-tasks:start -->",
  "<!-- generated:archive-index:start -->",
]);

function isGeneratedView(text) {
  const source = String(text || "");
  return GENERATED_VIEW_MARKERS.some((marker) => source.includes(marker));
}

// Resolve the effective task set.
//
//   - generated view  -> the structured records are the whole truth; the
//                        markdown adds nothing (it IS a projection of them).
//   - legacy view     -> the markdown still carries tasks that were never
//                        migrated. Union them, letting the structured record
//                        win on an ID collision. This is what keeps an
//                        un-migrated project from silently losing tasks.
//
// `source` reports which path produced the result.
function resolveTaskState(options = {}) {
  const structured = readStructuredTasks(options);
  const text = options.text !== undefined
    ? options.text
    : readTaskProgressText(options);
  const markdown = parseTaskProgress(text);

  if (!structured) {
    return { tasks: markdown, source: "markdown" };
  }
  if (isGeneratedView(text)) {
    return { tasks: structured, source: "structured" };
  }

  const byId = new Map();
  for (const task of markdown) {
    if (task && task.id) byId.set(task.id, task);
  }
  for (const task of structured) {
    if (task && task.id) byId.set(task.id, task);
  }
  return { tasks: [...byId.values()], source: "merged" };
}

function resolveTasks(options = {}) {
  return resolveTaskState(options).tasks;
}

function readTaskProgressText(options = {}) {
  const fs = require("fs");
  const path = require("path");
  const root = options.projectRoot || process.cwd();
  try {
    return fs.readFileSync(path.join(root, ".agent", "plans", "task-progress.md"), "utf8");
  } catch (_) {
    return "";
  }
}

// Count of active tasks from the structured truth source. Returns null when
// no structured records exist, so the caller can fall back to the markdown
// count instead of silently reporting zero.
function countActiveTasksStructured(options = {}) {
  const structured = readStructuredTasks(options);
  if (!structured) return null;
  // A legacy (non-generated) view can still carry tasks that were never
  // migrated, so the count has to cover the merged set.
  const resolved = resolveTaskState(options);
  return resolved.tasks.filter((task) => task.status === "active" || task.status === "blocked").length;
}

module.exports = {
  extractMarkdownRefs,
  hasExplicitTaskBlock,
  parseTaskProgress,
  validationStatusFromText,
  projectTaskRecord,
  projectMissionRecord,
  missionProgress,
  MISSION_REF_REL,
  readStructuredTasks,
  resolveTasks,
  resolveTaskState,
  isGeneratedView,
  countActiveTasksStructured,
  validationStatusFromGates,
  STAGE_PROGRESS,
  TASK_FILE_RE,
  listTaskRecordFiles,
};

