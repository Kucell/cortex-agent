"use strict";

// ─── Session Schedule Store + Tick Loop (M-003 follow-up) ────────────────────
//
// Model-run scheduling that lives *inside* cortex, so a project does not need
// to hand-roll a cron entry that shells out to `cortex-agent agent ...`.
//
// Public surface (used by `cortex-agent schedule <add|list|remove|run|daemon>`):
//   • parseDuration(text)                  — "30s" / "15m" / "2h" / "1d" → ms
//   • cronMatches(expr, date)              — 5-field cron membership test
//   • validateSchedule(input)              — normalise + reject broken definitions
//   • loadSchedules(root) / readSchedule() / writeSchedule() / removeSchedule()
//   • isDue(definition, now, lastRunAt)
//   • tick({ projectRoot, now, force, only }) — run every due schedule once
//
// Design notes:
//   • Definitions live in `.agent/schedules/<id>.json` (tracked config).
//   • Run records live in `.agent/runtime/schedules/<id>/runs/<stamp>.json`
//     (local evidence; the directory is gitignored).
//   • Scheduling itself is deliberately clock-injected: `tick()` never sleeps,
//     `daemon` owns the loop. That keeps tests deterministic and makes the
//     command usable from an external timer *or* from `schedule daemon`.
//   • Execution reuses the normal dispatch path (`dispatchBatch`), so a
//     scheduled run produces the same journals, statuses, and exit-code
//     semantics as `agent dispatch-batch`.
//   • One writer at a time: `tick()` is not safe to run concurrently against
//     the same project. `schedule daemon` runs a single loop per process; a
//     second daemon on the same project is the caller's problem (documented).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SCHEMA = "agent-schedule/v1";
const TICK_SCHEMA = "agent-schedule-tick/v1";

class ScheduleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ScheduleError";
    this.code = code;
  }
}

function projectRootOf(root) {
  return path.resolve(root || process.cwd());
}

function schedulesDir(root) {
  return path.join(projectRootOf(root), ".agent", "schedules");
}

function schedulePath(root, id) {
  return path.join(schedulesDir(root), `${id}.json`);
}

function runsDir(root, id) {
  return path.join(projectRootOf(root), ".agent", "runtime", "schedules", id, "runs");
}

// ── cadence parsing ─────────────────────────────────────────────────────────

const DURATION_UNITS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

function parseDuration(text) {
  if (typeof text !== "string") {
    throw new ScheduleError("ERR_SCHEDULE_EVERY", "every must be a duration string like 30s, 15m, 2h, or 1d");
  }
  const match = text.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) {
    throw new ScheduleError("ERR_SCHEDULE_EVERY", `unrecognised duration "${text}" (expected e.g. 30s, 15m, 2h, 1d)`);
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (value <= 0) {
    throw new ScheduleError("ERR_SCHEDULE_EVERY", "every must be greater than zero");
  }
  return value * DURATION_UNITS[unit];
}

const CRON_FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

function expandCronField(field, spec) {
  const values = new Set();
  for (const part of field.split(",")) {
    const piece = part.trim();
    if (!piece) {
      throw new ScheduleError("ERR_SCHEDULE_CRON", `empty list item in ${spec.name} field`);
    }
    const [rangePart, stepPart] = piece.split("/");
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) {
        throw new ScheduleError("ERR_SCHEDULE_CRON", `invalid step "${stepPart}" in ${spec.name} field`);
      }
    }
    let start;
    let end;
    if (rangePart === "*") {
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes("-")) {
      const [rawStart, rawEnd] = rangePart.split("-");
      start = Number(rawStart);
      end = Number(rawEnd);
    } else {
      start = Number(rangePart);
      end = stepPart !== undefined ? spec.max : start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < spec.min || end > spec.max || start > end) {
      throw new ScheduleError(
        "ERR_SCHEDULE_CRON",
        `invalid ${spec.name} value "${rangePart}" (allowed ${spec.min}-${spec.max})`,
      );
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function parseCron(expr) {
  if (typeof expr !== "string") {
    throw new ScheduleError("ERR_SCHEDULE_CRON", "cron must be a 5-field string");
  }
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ScheduleError("ERR_SCHEDULE_CRON", `cron needs exactly 5 fields (got ${fields.length}): "${expr}"`);
  }
  const sets = CRON_FIELDS.map((spec, index) => expandCronField(fields[index], spec));
  // day-of-week accepts 7 as Sunday; normalise to 0.
  if (sets[4].has(7)) {
    sets[4].delete(7);
    sets[4].add(0);
  }
  return { expr: fields.join(" "), sets };
}

function cronMatches(expr, date) {
  const parsed = typeof expr === "string" ? parseCron(expr) : expr;
  const [minutes, hours, days, months, weekdays] = parsed.sets;
  return (
    minutes.has(date.getMinutes())
    && hours.has(date.getHours())
    && days.has(date.getDate())
    && months.has(date.getMonth() + 1)
    && weekdays.has(date.getDay())
  );
}

// ── definition validation ───────────────────────────────────────────────────

function slugify(id) {
  return String(id || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function validateSchedule(input) {
  if (!input || typeof input !== "object") {
    throw new ScheduleError("ERR_SCHEDULE_SHAPE", "schedule definition must be an object");
  }
  const id = slugify(input.id);
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw new ScheduleError("ERR_SCHEDULE_ID", "id must be a lowercase slug (letters, digits, dot, dash, underscore)");
  }
  const agentId = typeof input.agent_id === "string" ? input.agent_id.trim() : "";
  if (!agentId) {
    throw new ScheduleError("ERR_SCHEDULE_AGENT", "agent_id is required (for example dsh:worker)");
  }
  const task = typeof input.task === "string" ? input.task : "";
  const tasksFile = typeof input.tasks_file === "string" ? input.tasks_file.trim() : "";
  if (!task && !tasksFile) {
    throw new ScheduleError("ERR_SCHEDULE_TASK", "one of task or tasks_file is required");
  }
  if (task && tasksFile) {
    throw new ScheduleError("ERR_SCHEDULE_TASK", "task and tasks_file are mutually exclusive");
  }
  const hasEvery = input.every !== undefined && input.every !== null && input.every !== "";
  const hasCron = input.cron !== undefined && input.cron !== null && input.cron !== "";
  if (hasEvery === hasCron) {
    throw new ScheduleError("ERR_SCHEDULE_CADENCE", "exactly one of every or cron is required");
  }
  const definition = {
    schema: SCHEMA,
    id,
    agent_id: agentId,
    task: task || null,
    tasks_file: tasksFile || null,
    every: null,
    every_ms: null,
    cron: null,
    session_id: input.session_id ? String(input.session_id).trim() : null,
    concurrency: Math.max(1, Math.min(16, Number(input.concurrency) || 1)),
    timeout: Number(input.timeout) > 0 ? Number(input.timeout) : null,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    created_at: input.created_at || new Date().toISOString(),
    last_run_at: input.last_run_at || null,
    last_status: input.last_status || null,
    last_batch_id: input.last_batch_id || null,
  };
  if (hasEvery) {
    definition.every_ms = parseDuration(input.every);
    definition.every = String(input.every).trim();
  } else {
    // Validate eagerly so a broken expression is rejected at `schedule add`
    // time, not on the first tick.
    const parsed = parseCron(input.cron);
    definition.cron = parsed.expr;
  }
  return definition;
}

// ── store ───────────────────────────────────────────────────────────────────

function readSchedule(root, id) {
  const file = schedulePath(root, id);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    throw new ScheduleError("ERR_SCHEDULE_CORRUPT", `schedule definition is not valid JSON: ${file}`);
  }
  return parsed;
}

function writeSchedule(root, definition) {
  const dir = schedulesDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = schedulePath(root, definition.id);
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(definition, null, 2)}\n`);
  fs.renameSync(temporary, file);
  return file;
}

function loadSchedules(root) {
  const dir = schedulesDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.includes(".tmp-"))
    .map((name) => {
      const file = path.join(dir, name);
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (cause) {
        throw new ScheduleError("ERR_SCHEDULE_CORRUPT", `schedule definition is not valid JSON: ${file}`);
      }
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function removeSchedule(root, id) {
  const file = schedulePath(root, slugify(id));
  if (!fs.existsSync(file)) {
    throw new ScheduleError("ERR_SCHEDULE_NOT_FOUND", `no schedule named "${id}"`);
  }
  fs.unlinkSync(file);
  return file;
}

// ── due calculation ─────────────────────────────────────────────────────────

function sameMinute(a, b) {
  return (
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
    && a.getHours() === b.getHours()
    && a.getMinutes() === b.getMinutes()
  );
}

function isDue(definition, now, lastRunAt) {
  if (!definition || definition.enabled === false) return false;
  const last = lastRunAt ? new Date(lastRunAt) : null;
  if (definition.cron) {
    if (!cronMatches(definition.cron, now)) return false;
    // A cron schedule is due once per matching minute: a tick that runs
    // again in the same minute (short interval, manual + daemon) must not
    // re-fire it.
    return !(last && sameMinute(last, now));
  }
  if (definition.every_ms) {
    if (!last || Number.isNaN(last.getTime())) return true;
    return now.getTime() - last.getTime() >= definition.every_ms;
  }
  return false;
}

// ── execution ───────────────────────────────────────────────────────────────

function tasksFor(definition, projectRoot) {
  const { loadTasksFile } = require("../agents/batch-dispatch");
  if (definition.tasks_file) {
    const file = path.resolve(projectRoot, definition.tasks_file);
    return loadTasksFile(file).map((item) => item);
  }
  const item = {
    label: definition.id,
    agent_id: definition.agent_id,
    task: definition.task,
  };
  if (definition.session_id) item.session_id = definition.session_id;
  if (definition.timeout) item.timeout = definition.timeout;
  return [item];
}

function recordRun(root, definition, payload) {
  const dir = runsDir(root, definition.id);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = payload.started_at.replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

async function runSchedule(definition, options = {}) {
  const projectRoot = projectRootOf(options.projectRoot);
  const dispatchBatch = options.dispatchBatch || require("../agents/batch-dispatch").dispatchBatch;
  const startedAt = new Date(options.now || Date.now()).toISOString();
  const base = {
    schema: "agent-schedule-run/v1",
    schedule_id: definition.id,
    agent_id: definition.agent_id,
    started_at: startedAt,
    finished_at: null,
    status: "failed",
    batch_id: null,
    counts: null,
    error: null,
    run_record: null,
  };
  try {
    const summary = await dispatchBatch({
      projectRoot,
      tasks: tasksFor(definition, projectRoot),
      concurrency: definition.concurrency,
      timeout: definition.timeout || undefined,
    });
    base.finished_at = new Date().toISOString();
    base.status = summary.status;
    base.batch_id = summary.batch_id;
    base.counts = summary.counts;
  } catch (error) {
    base.finished_at = new Date().toISOString();
    base.status = "failed";
    base.error = { code: error.code || "ERR_SCHEDULE_RUN", message: error.message };
  }
  base.run_record = recordRun(projectRoot, definition, base);
  const updated = {
    ...definition,
    last_run_at: base.started_at,
    last_status: base.status,
    last_batch_id: base.batch_id,
  };
  writeSchedule(projectRoot, updated);
  return base;
}

/**
 * Run every due schedule once. Callers own the loop (`schedule daemon`) and
 * the clock (`options.now`), which keeps this function deterministic.
 */
async function tick(options = {}) {
  const projectRoot = projectRootOf(options.projectRoot);
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new ScheduleError("ERR_SCHEDULE_NOW", `invalid --now value: ${options.now}`);
  }
  const definitions = loadSchedules(projectRoot);
  const results = [];
  for (const definition of definitions) {
    if (options.only && definition.id !== options.only) continue;
    const due = options.force === true || isDue(definition, now, definition.last_run_at);
    if (!due) {
      results.push({ id: definition.id, status: "skipped", reason: "not_due" });
      continue;
    }
    const run = await runSchedule(definition, {
      projectRoot,
      now,
      dispatchBatch: options.dispatchBatch,
    });
    results.push({
      id: definition.id,
      status: run.status,
      batch_id: run.batch_id,
      run_record: run.run_record,
      error: run.error,
      counts: run.counts,
    });
  }
  const counts = { total: results.length, ran: 0, ok: 0, partial: 0, failed: 0, skipped: 0 };
  for (const result of results) {
    if (result.status === "skipped") {
      counts.skipped += 1;
      continue;
    }
    counts.ran += 1;
    const bucket = result.status === "ok" || result.status === "partial" ? result.status : "failed";
    counts[bucket] += 1;
  }
  return {
    schema: TICK_SCHEMA,
    ticked_at: now.toISOString(),
    project_root: projectRoot,
    counts,
    results,
  };
}

module.exports = {
  SCHEMA,
  TICK_SCHEMA,
  ScheduleError,
  parseDuration,
  parseCron,
  cronMatches,
  validateSchedule,
  schedulesDir,
  schedulePath,
  runsDir,
  readSchedule,
  writeSchedule,
  loadSchedules,
  removeSchedule,
  isDue,
  tasksFor,
  runSchedule,
  tick,
};
