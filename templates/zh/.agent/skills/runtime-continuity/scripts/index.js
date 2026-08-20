"use strict";

// ─── runtime-continuity (L1 — CLI shell for sub-agents/session-manager) ────
// Implements 5-mode protocol from .agent/sub-agents/session-manager.md as
// a CLI.   Invoked by host agents (Claude Code / Cursor / Codex) via shell
// rather than via Sub-Agent spawn.
//
// Source-of-truth note: session-manager.md owns the *what*.   This file
// owns only the *how (CLI mechanics, argument shape, return envelopes, error
// codes)*.   Any new mode or behavior change MUST land on session-manager.md
// first; this file only follows.
//
// Effects on .agent/ state:
//   - archive writes ~/.agent/contexts/<project>/ctx_<ts>.md (existing path,
//     not invented by this skill).
//   - archive / restore / status each append a `session_*` event into
//     `runs/<active-run>.json#events[]` for audit correlation.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const AGENT_ROOT = path.join(process.cwd(), ".agent");
const RUNS_DIR = path.join(AGENT_ROOT, "runs");
const CONTEXT_HOME = path.join(os.homedir(), ".agent", "contexts");
const RC_ROOT = path.join(AGENT_ROOT, "runtime-continuity");
const RC_EVENTS_DIR = path.join(RC_ROOT, "events");
const RC_ARCHIVES_DIR = path.join(RC_ROOT, "archives");
const RC_GUARD_DIR = path.join(RC_ROOT, "guard");
const GUARD_STATE_FILE = path.join(RC_GUARD_DIR, "state.json");
const GUARD_PID_FILE = path.join(RC_GUARD_DIR, "guard.pid");
const GUARD_LOCK_DIR = path.join(RC_GUARD_DIR, "guard.lock");

const DEFAULT_ARCHIVE_INTERVAL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_GUARD_WINDOW_MS = 5 * 60 * 60 * 1000;
const DEFAULT_GUARD_POLL_MS = 60 * 1000;
const GUARD_START_GRACE_MS = 5000;

// resume-bundle --auto --inject (P-002 / MS-002) budget defaults:
//   - DEFAULT_BUDGET_PERCENT: summarization threshold expressed as a
//     percentage of the context window (40% ceiling per context-budget).
//   - DEFAULT_CONTEXT_WINDOW_TOKENS: conservative assumed window when neither
//     --budget-tokens nor CORTEX_CONTEXT_WINDOW_TOKENS is provided.
const DEFAULT_BUDGET_PERCENT = 40;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;
// Milestone states considered "done" when scanning for the current milestone.
const DONE_MILESTONE_STATES = new Set([
  "VALIDATE_PASSED", "VALIDATED", "COMPLETED", "COMPLETE", "DONE",
  "CLOSED", "PASSED", "SHIPPED", "CANCELLED", "REJECTED", "WAIVED",
]);
// Decision statuses considered "resolved" (no longer the current decision).
const DECISION_DONE_STATUSES = new Set([
  "approved", "rejected", "closed", "cancelled", "superseded", "resolved", "waived",
]);
// Mission-plan states that exclude a mission from the active-mission heuristic
// (P-003 方案 C, M-030 MS-003).  Case-insensitive; a mission whose
// mission-plan.md carries no matched state line defaults to ACTIVE
// (presence heuristic — "mission-plan 目录存在性启发式").
const MISSION_DONE_STATES = new Set(["done", "blocked", "completed", "complete"]);

const GATES_TIGHT = new Set(["user", "agent"]);
const GATES_DESTRUCTIVE = new Set(["user"]);

function flag(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function fail(error, message, code = 2) {
  emit({ ok: false, error, message });
  process.exit(code);
}

function requireGate(allowed) {
  const argv = process.argv.slice(2);
  const gate = flag("--gate", argv);
  if (!allowed.includes(gate)) {
    fail("workflow_gate_required", `--gate must be one of: ${allowed.join(", ")}`);
  }
  return gate;
}

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}_${String(d.getUTCMilliseconds()).padStart(3, "0")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function safeSlug(value, fallback) {
  const base = String(value || fallback || "item").trim();
  return base.replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || fallback || "item";
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.renameSync(temp, file);
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

function positiveEnvMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function pidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_) {
    return false;
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function guardConfig() {
  return {
    archive_interval_ms: positiveEnvMs("CORTEX_CONTINUITY_ARCHIVE_INTERVAL_MS", DEFAULT_ARCHIVE_INTERVAL_MS),
    window_ms: positiveEnvMs("CORTEX_CONTINUITY_WINDOW_MS", DEFAULT_GUARD_WINDOW_MS),
    poll_ms: positiveEnvMs("CORTEX_CONTINUITY_POLL_MS", DEFAULT_GUARD_POLL_MS),
  };
}

function csvFlag(name, argv) {
  const raw = flag(name, argv);
  if (!raw) return [];
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function asList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === "") return [];
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);
}

function renderList(value) {
  const items = asList(value);
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "_(由主 Agent 填写)_";
}

function rel(file) {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

function listJsonRel(dir, limit) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "index.json" && !name.endsWith(".schema.json"))
    .map((name) => {
      const file = path.join(dir, name);
      return { file, mtime: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((item) => rel(item.file));
}

function listHandoffs(limit) {
  const dir = path.join(AGENT_ROOT, "handoffs");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => (name.endsWith(".json") || name.endsWith(".md")) && (/^H-/.test(name) || /^\d{8,}/.test(name)))
    .map((name) => {
      const file = path.join(dir, name);
      return { file, mtime: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((item) => rel(item.file));
}

function listArtifactStates(limit) {
  const dir = path.join(AGENT_ROOT, "artifacts");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, "state.json");
    if (fs.existsSync(file)) out.push({ file, mtime: fs.statSync(file).mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((item) => rel(item.file));
}

function latestArchiveJson() {
  const latest = path.join(RC_ARCHIVES_DIR, "latest.json");
  if (fs.existsSync(latest)) return latest;
  if (!fs.existsSync(RC_ARCHIVES_DIR)) return null;
  const archives = fs.readdirSync(RC_ARCHIVES_DIR)
    .filter((name) => name.startsWith("RC-") && name.endsWith(".json"))
    .map((name) => {
      const file = path.join(RC_ARCHIVES_DIR, name);
      return { file, mtime: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return archives[0]?.file || null;
}

function findLatestSessionId(project) {
  const sessionsDir = path.join(AGENT_ROOT, "sessions");
  if (!fs.existsSync(sessionsDir)) return null;
  const files = fs.readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".json") && name !== "index.json" && !name.endsWith(".schema.json"))
    .map((name) => {
      const file = path.join(sessionsDir, name);
      const body = readJson(file) || {};
      return { file, body, mtime: fs.statSync(file).mtimeMs };
    })
    .filter((item) => !project || item.body.project === project || item.body.current_task_id?.includes?.(project));
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0]?.body?.session_id || null;
}

function buildSummaryFromArgs(argv, note = {}) {
  return {
    done: asList(flag("--done", argv) || note.done),
    in_progress: flag("--in-progress", argv) || note.in_progress || note.blocked || null,
    next: asList(flag("--next", argv) || note.next),
    blockers: asList(flag("--blockers", argv) || note.blockers || note.pitfalls),
  };
}

function createRuntimeEvent(project, argv, defaults = {}) {
  const stamp = ts();
  const eventId = `RCE-${stamp}`;
  const note = parseNote(argv);
  const command = flag("--command", argv);
  const exitCodeRaw = flag("--exit-code", argv);
  const commands = command ? [{
    command,
    exit_code: exitCodeRaw == null ? null : Number(exitCodeRaw),
    summary: flag("--command-summary", argv) || "",
  }] : [];
  // MS-003 (方案 C): mission_context carried into the checkpoint / log event
  // payload via `--mission-context-json` (additive; null when absent).
  const missionContextRaw = flag("--mission-context-json", argv) || defaults.mission_context_raw || null;
  let missionContext = null;
  if (missionContextRaw) {
    try { missionContext = JSON.parse(missionContextRaw); } catch (_) { missionContext = null; }
  }
  const event = {
    event_id: eventId,
    project,
    host: flag("--host", argv) || defaults.host || "unknown",
    agent_id: flag("--agent-id", argv) || defaults.agent_id || null,
    run_id: flag("--run-id", argv) || defaults.run_id || findActiveRunId(),
    session_id: flag("--session-id", argv) || defaults.session_id || findLatestSessionId(project),
    task_id: flag("--task-id", argv) || defaults.task_id || null,
    mission_id: flag("--mission-id", argv) || defaults.mission_id || null,
    ...(missionContext ? { mission_context: missionContext } : {}),
    type: defaults.type || flag("--type", argv) || "work_log",
    phase: flag("--phase", argv) || defaults.phase || null,
    message: flag("--message", argv) || defaults.message || "",
    summary: buildSummaryFromArgs(argv, note),
    refs: {
      files: csvFlag("--files", argv),
      commands,
      artifacts: csvFlag("--artifacts", argv),
      handoffs: csvFlag("--handoffs", argv),
    },
    created_at: nowIso(),
  };
  fs.mkdirSync(RC_EVENTS_DIR, { recursive: true });
  const file = path.join(RC_EVENTS_DIR, `${stamp}-event.json`);
  writeJsonAtomic(file, event);
  writeJsonAtomic(path.join(RC_ROOT, "state.json"), {
    project,
    latest_event: rel(file),
    latest_archive: latestArchiveJson() ? rel(latestArchiveJson()) : null,
    updated_at: event.created_at,
  });
  appendRunEvent({
    type: event.type === "checkpoint" ? "runtime_checkpoint" : "runtime_log",
    project,
    runtime_event: rel(file),
    phase: event.phase,
    message: event.message,
    ...(event.mission_context ? { mission_context: event.mission_context } : {}),
  });
  return { event, eventPath: file };
}

// ─── Mode 1 — assess ───────────────────────────────────────────────────────────
function assessBudget(taskDescription) {
  // Crude heuristic.  Long task description → long budget; very short → short.
  // Output is advisory, not contractual — humans still decide to split.
  const words = String(taskDescription || "").trim().split(/\s+/).filter(Boolean).length;
  let optimistic = 0.5, pessimistic = 1;
  if (words < 10) { optimistic = 0.25; pessimistic = 0.5; }
  else if (words < 50) { optimistic = 0.5; pessimistic = 1.5; }
  else if (words < 200) { optimistic = 1; pessimistic = 3; }
  else { optimistic = 2; pessimistic = 5; }
  const avg = (optimistic + pessimistic) / 2;
  const risk = avg > 3 ? "high" : avg > 1.5 ? "medium" : "low";
  // 3-hour checkpoint logic mirrors session-manager §assess "阶段 ≤3小时 + 存档检查点".
  const phases = Math.ceil(pessimistic / 3);
  return { optimistic, pessimistic, avg, risk, phases };
}

// ─── Mode 2 — archive ──────────────────────────────────────────────────────────
function createStructuredArchive(project, note, opts, markdownArchive) {
  const stamp = opts.stamp || ts();
  const archiveId = `RC-${stamp}`;
  const cwd = process.cwd();
  function git(cmd) {
    try {
      return spawnSync("git", cmd.split(" "), { cwd, encoding: "utf8" })
        .stdout?.trim() || "";
    } catch { return ""; }
  }
  const latestEvents = listJsonRel(RC_EVENTS_DIR, 12).filter((file) => file.endsWith("-event.json"));
  const archive = {
    archive_id: archiveId,
    project,
    created_at: nowIso(),
    source_host: opts.source_host || null,
    target_host: opts.target_host || null,
    reason: opts.reason || null,
    git: {
      root: cwd,
      branch: git("rev-parse --abbrev-ref HEAD"),
      head: git("rev-parse --short HEAD"),
      status_short: git("status --short"),
    },
    state: {
      current_goal: note?.goal || note?.current_goal || null,
      done: asList(note?.done),
      in_progress: note?.in_progress || note?.blocked || null,
      next: asList(note?.next),
      blockers: asList(note?.blockers || note?.pitfalls),
    },
    refs: {
      latest_events: latestEvents,
      runs: listJsonRel(RUNS_DIR, 5),
      sessions: listJsonRel(path.join(AGENT_ROOT, "sessions"), 5),
      handoffs: listHandoffs(8),
      artifacts: listArtifactStates(8),
      dirty_files: git("diff --name-only HEAD").split(/\r?\n/).filter(Boolean),
    },
    restore: {
      read_first: [
        "AGENTS.md",
        ".agent/rules/core-principles.md",
        ".agent/rules/ai-behavior.md",
        ".agent/rules/code-standards.md",
        ".agent/runtime-continuity/archives/latest.json",
      ],
      commands: [
        `node .agent/skills/runtime-continuity/scripts/index.js resume-bundle --project ${project}`,
      ],
      next_action: asList(note?.next)[0] || note?.blocked || "Read the resume bundle and continue from the latest recorded state.",
    },
  };
  fs.mkdirSync(RC_ARCHIVES_DIR, { recursive: true });
  const archivePath = path.join(RC_ARCHIVES_DIR, `${archiveId}.json`);
  const latestPath = path.join(RC_ARCHIVES_DIR, "latest.json");
  writeJsonAtomic(archivePath, archive);
  writeJsonAtomic(latestPath, archive);
  writeJsonAtomic(path.join(RC_ROOT, "state.json"), {
    project,
    latest_event: latestEvents[0] || null,
    latest_archive: rel(archivePath),
    latest_markdown_archive: markdownArchive ? markdownArchive.latestPath : null,
    updated_at: archive.created_at,
  });
  return { archive, archiveJsonPath: archivePath, latestJsonPath: latestPath };
}

function archiveProject(project, note, opts = {}) {
  const dir = path.join(CONTEXT_HOME, project);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = opts.stamp || ts();
  const file = path.join(dir, `ctx_${stamp}.md`);
  const latest = path.join(dir, "latest.md");

  // Branch / commit info: only when cwd is a git repo (don't fabricate).
  const cwd = process.cwd();
  function git(cmd) {
    try {
      return spawnSync("git", cmd.split(" "), { cwd, encoding: "utf8" })
        .stdout?.trim() || "";
    } catch { return ""; }
  }
  const branch = git("rev-parse --abbrev-ref HEAD");
  const recentLog = git("log --oneline -3");
  const dirtyFiles = git("diff --name-only HEAD");

  // Body template inherits from session-manager sub-agent §模式 B.
  const body = [
    `# 会话存档 - ${project} - ${stamp}`,
    "",
    "## 📍 当前位置",
    `- **目录**: ${cwd}`,
    `- **分支**: ${branch || "(非 Git 目录)"}`,
    `- **最近提交**:`,
    "```",
    recentLog || "(无 git 历史)",
    "```",
    "",
    "## ✅ 本次已完成",
    "",
    renderList(note?.done),
    "",
    "## 🚧 进行中（卡点）",
    "",
    note?.in_progress || note?.blocked || "_(由主 Agent 填写)_",
    "",
    "## 📌 后续待开始",
    "",
    renderList(note?.next),
    "",
    "## 🔑 关键决策",
    "",
    "| 决策 | 结论 | 理由 |",
    "| --- | --- | --- |",
    "|  |  |  |",
    "",
    "## ⚠️ 注意事项 & 踩坑记录",
    "",
    renderList(note?.blockers || note?.pitfalls),
    "",
    "## 🔗 关键文件清单",
    "",
    "```",
    dirtyFiles || "(无)",
    "```",
    "",
    "## 💬 新会话恢复指令",
    "",
    "请阅读以上内容,确认当前进度后,列出接下来的 3 个具体步骤。",
  ].join("\n");

  fs.writeFileSync(file, body, "utf8");
  // Update latest.md symlink atomically: rm + symlink avoids EEXIST on re-link.
  try { fs.unlinkSync(latest); } catch (_) {}
  try { fs.symlinkSync(file, latest); }
  catch (_) { fs.copyFileSync(file, latest); }
  const markdownArchive = { archivePath: file, latestPath: latest, stamp };
  const structured = createStructuredArchive(project, note || {}, opts, markdownArchive);
  return { ...markdownArchive, ...structured };
}

function latestArchiveAgeMs() {
  const file = latestArchiveJson();
  if (!file || !fs.existsSync(file)) return Infinity;
  const archive = readJson(file);
  const createdAt = archive && Date.parse(archive.created_at);
  return Date.now() - (Number.isFinite(createdAt) ? createdAt : fs.statSync(file).mtimeMs);
}

function automaticArchiveNote(project) {
  const runId = findActiveRunId();
  const run = runId ? readJson(path.join(RUNS_DIR, `${runId}.json`)) : null;
  const events = Array.isArray(run?.events) ? run.events : [];
  const latest = events.at(-1) || {};
  const runtimeState = readJson(path.join(RC_ROOT, "state.json")) || {};
  const latestRuntimeEvent = runtimeState.latest_event
    ? readJson(path.resolve(process.cwd(), runtimeState.latest_event))
    : null;
  const summary = latestRuntimeEvent?.summary || {};
  return {
    goal: run?.mission_id || run?.task_id || run?.current_task_id || `Maintain continuity for ${project}`,
    done: asList(summary.done),
    in_progress: summary.in_progress || latest.message || latest.type || "Session is active; automatic continuity checkpoint created.",
    next: asList(summary.next),
    blockers: asList(summary.blockers),
  };
}

function updateGuardState(leaseId, patch) {
  const current = readJson(GUARD_STATE_FILE);
  if (!current || current.lease_id !== leaseId) return false;
  writeJsonAtomic(GUARD_STATE_FILE, { ...current, ...patch, updated_at: nowIso() });
  return true;
}

function releaseGuard(leaseId, reason) {
  const current = readJson(GUARD_STATE_FILE);
  if (current && current.lease_id === leaseId) {
    writeJsonAtomic(GUARD_STATE_FILE, {
      ...current,
      status: "stopped",
      stop_reason: reason,
      stopped_at: nowIso(),
      updated_at: nowIso(),
    });
    try { fs.unlinkSync(GUARD_PID_FILE); } catch (_) {}
    try { fs.rmSync(GUARD_LOCK_DIR, { recursive: true, force: true }); } catch (_) {}
  }
}

function runContinuityGuard(project, leaseId) {
  if (process.env.CORTEX_CONTINUITY_GUARD !== "1") {
    fail("internal_guard_only", "The continuity guard can only be launched by SessionStart warm --auto.");
  }
  const state = readJson(GUARD_STATE_FILE);
  if (!state || state.lease_id !== leaseId) {
    fail("invalid_guard_lease", "Continuity guard lease is missing or superseded.");
  }
  const config = state.config || guardConfig();
  fs.writeFileSync(GUARD_PID_FILE, `${process.pid}\n`, "utf8");
  updateGuardState(leaseId, { pid: process.pid, status: "running", heartbeat_at: nowIso() });
  let stopped = false;

  const stop = (reason) => {
    if (stopped) return;
    stopped = true;
    releaseGuard(leaseId, reason);
    process.exit(0);
  };

  const tick = () => {
    const current = readJson(GUARD_STATE_FILE);
    if (!current || current.lease_id !== leaseId) return stop("superseded");
    if (Date.now() >= Date.parse(current.renew_until)) return stop("window_expired");
    const patch = { heartbeat_at: nowIso(), status: "running", pid: process.pid };
    if (latestArchiveAgeMs() >= config.archive_interval_ms) {
      try {
        const archived = archiveProject(project, automaticArchiveNote(project), {
          source_host: "session-start-guard",
          reason: "continuity_guard_interval",
          full: true,
        });
        appendRunEvent({
          type: "session_archived",
          project,
          via: "continuity_guard",
          archive_path: archived.archivePath,
          archive_json_path: archived.archiveJsonPath,
        });
        patch.last_archive_at = archived.archive.created_at;
        patch.last_archive_path = rel(archived.archiveJsonPath);
        patch.last_error = null;
      } catch (err) {
        patch.last_error = { message: err.message, at: nowIso() };
      }
    }
    updateGuardState(leaseId, patch);
  };

  process.once("SIGTERM", () => stop("sigterm"));
  process.once("SIGINT", () => stop("sigint"));
  tick();
  setInterval(tick, Math.max(25, config.poll_ms));
}

function startOrRenewContinuityGuard(project) {
  const config = guardConfig();
  fs.mkdirSync(RC_GUARD_DIR, { recursive: true });
  const renew = (current) => {
    const renewUntil = new Date(Date.now() + config.window_ms).toISOString();
    writeJsonAtomic(GUARD_STATE_FILE, {
      ...current,
      config,
      renew_until: renewUntil,
      last_session_start_at: nowIso(),
      updated_at: nowIso(),
    });
    return { started: false, renewed: true, pid: current.pid, renew_until: renewUntil, state_path: rel(GUARD_STATE_FILE) };
  };
  const current = readJson(GUARD_STATE_FILE);
  if (current && current.status === "running" && pidAlive(current.pid)) {
    return renew(current);
  }

  let lockAcquired = false;
  for (let attempt = 0; attempt < 120 && !lockAcquired; attempt += 1) {
    try {
      fs.mkdirSync(GUARD_LOCK_DIR);
      lockAcquired = true;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const existing = readJson(GUARD_STATE_FILE);
      if (existing && existing.status === "running" && pidAlive(existing.pid)) return renew(existing);
      let lockAge = Infinity;
      try { lockAge = Date.now() - fs.statSync(GUARD_LOCK_DIR).mtimeMs; } catch (_) {}
      const stateAge = existing?.updated_at ? Date.now() - Date.parse(existing.updated_at) : Infinity;
      if (lockAge <= GUARD_START_GRACE_MS || stateAge <= GUARD_START_GRACE_MS) {
        sleepMs(50);
        continue;
      }
      try { fs.rmSync(GUARD_LOCK_DIR, { recursive: true, force: true }); } catch (_) {}
    }
  }
  if (!lockAcquired) throw new Error("continuity_guard_lock_timeout");
  const now = Date.now();
  const leaseId = `RCG-${ts()}-${process.pid}`;
  const renewUntil = new Date(now + config.window_ms).toISOString();
  writeJsonAtomic(GUARD_STATE_FILE, {
    schema_version: 1,
    project,
    lease_id: leaseId,
    pid: null,
    status: "starting",
    started_at: nowIso(),
    last_session_start_at: nowIso(),
    heartbeat_at: null,
    renew_until: renewUntil,
    config,
  });
  const child = spawn(process.execPath, [__filename, "__guard", "--project", project, "--lease-id", leaseId], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CORTEX_CONTINUITY_GUARD: "1" },
  });
  child.unref();
  updateGuardState(leaseId, { pid: child.pid, status: "running", heartbeat_at: nowIso() });
  fs.writeFileSync(GUARD_PID_FILE, `${child.pid}\n`, "utf8");
  return { started: true, renewed: false, pid: child.pid, renew_until: renewUntil, state_path: rel(GUARD_STATE_FILE) };
}

// ─── Mode 3 — restore ────────────────────────────────────────────────────────
function listContexts(project) {
  const dir = path.join(CONTEXT_HOME, project);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.startsWith("ctx_") && n.endsWith(".md"))
    .map((n) => ({
      name: n,
      mtime: fs.statSync(path.join(dir, n)).mtimeMs,
      isLatest: false,
    }))
    .sort((a, b) => b.mtime - a.mtime);
}

function resolveLatest(project) {
  const dir = path.join(CONTEXT_HOME, project);
  const latest = path.join(dir, "latest.md");
  if (fs.existsSync(latest)) return latest;
  const entries = listContexts(project);
  if (!entries.length) return null;
  return path.join(dir, entries[0].name);
}

function loadContext(project, mode) {
  if (mode === "list") {
    return { ok: true, action: "list", project, contexts: listContexts(project) };
  }
  if (mode === "auto") {
    const markdown = resolveLatest(project);
    const archiveFile = latestArchiveJson();
    const archive = archiveFile ? readJson(archiveFile) : null;
    return {
      ok: Boolean(markdown || archive),
      action: "restore",
      mode: "auto",
      project,
      markdown_path: markdown,
      archive_json_path: archiveFile,
      archive,
      resume_bundle_command: `node .agent/skills/runtime-continuity/scripts/index.js resume-bundle --project ${project}`,
      error: markdown || archive ? undefined : "no_archive_for_project",
    };
  }
  const file = resolveLatest(project);
  if (!file) {
    return { ok: false, action: "restore", project, error: "no_archive_for_project" };
  }
  const stat = fs.statSync(file);
  return {
    ok: true,
    action: "restore",
    project,
    path: file,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    body: fs.readFileSync(file, "utf8"),
  };
}

function buildResumeBundle(project) {
  const archiveFile = latestArchiveJson();
  const archive = archiveFile ? readJson(archiveFile) : null;
  const markdown = resolveLatest(project);
  function git(cmd) {
    try {
      return spawnSync("git", cmd.split(" "), { cwd: process.cwd(), encoding: "utf8" })
        .stdout?.trim() || "";
    } catch { return ""; }
  }
  const runs = listJsonRel(RUNS_DIR, 8);
  const sessions = listJsonRel(path.join(AGENT_ROOT, "sessions"), 8);
  const handoffs = listHandoffs(12);
  const artifacts = listArtifactStates(12);
  const events = listJsonRel(RC_EVENTS_DIR, 12).filter((file) => file.endsWith("-event.json"));
  return {
    ok: true,
    action: "resume-bundle",
    project,
    generated_at: nowIso(),
    latest_archive: archiveFile ? rel(archiveFile) : null,
    latest_markdown_archive: markdown || null,
    archive,
    runtime_events: events,
    runs,
    sessions,
    pending_handoffs: handoffs,
    artifact_states: artifacts,
    git: {
      branch: git("rev-parse --abbrev-ref HEAD"),
      head: git("rev-parse --short HEAD"),
      status_short: git("status --short"),
    },
    read_first: archive?.restore?.read_first || [
      "AGENTS.md",
      ".agent/rules/core-principles.md",
      ".agent/rules/ai-behavior.md",
      ".agent/rules/code-standards.md",
    ],
    next_action: archive?.restore?.next_action || "No structured archive found. Run /briefing and inspect git status before continuing.",
    recommended_commands: [
      `node .agent/skills/runtime-continuity/scripts/index.js status --project ${project}`,
      handoffs[0] ? `node .agent/handoffs/scripts/handoff-protocol.js resume-prompt --payload-file ${handoffs[0]}` : null,
      artifacts[0] ? `node .agent/artifacts/scripts/artifact-bus.js validate --task-id <task-id>` : null,
    ].filter(Boolean),
  };
}

// ─── resume-bundle --auto --inject (P-002 / MS-002) ─────────────────────────
// SessionStart auto-injection path: `resume-bundle --auto --inject
// [--budget-percent <0-100>] [--budget-tokens <N>]`.  Read-only — same data
// as the plain `resume-bundle`, but emits a `[CORTEX-RESUME]` block (marker
// line + JSON) and, when the estimated bundle size exceeds the budget share
// of the context window, replaces the payload with summarizeForResume()'s
// tiered digest.  --auto makes any failure graceful (exit 0 + stderr log) so
// SessionStart hooks are never blocked.

function parsePercent(value, fallback) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, 100);
}

function contextWindowTokens() {
  const env = Number(process.env.CORTEX_CONTEXT_WINDOW_TOKENS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

// Estimate the token cost of a bundle.  Primary: context-budget skill
// estimator CLI if it exists (contract below); fallback: ~4 chars/token
// heuristic — built-in, zero npm deps, never depends on the skill existing.
//   node .agent/skills/context-budget/scripts/estimate-tokens.js --json -
//     → stdout {"ok":true,"tokens":<n>}
function estimateBundleTokens(obj) {
  const json = JSON.stringify(obj);
  const estimator = path.join(AGENT_ROOT, "skills", "context-budget", "scripts", "estimate-tokens.js");
  if (fs.existsSync(estimator)) {
    try {
      const res = spawnSync(process.execPath, [estimator, "--json", "-"], {
        input: json,
        encoding: "utf8",
        timeout: 3000,
      });
      if (res.status === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout);
        const tokens = Number(parsed && parsed.tokens);
        if (Number.isFinite(tokens) && tokens >= 0) return tokens;
      }
    } catch (_) { /* fall through to heuristic */ }
  }
  return Math.ceil(json.length / 4);
}

function excerptFile(file, maxChars) {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/\s+/g, " ").trim();
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  } catch (_) {
    return "";
  }
}

function readActiveRunSummary() {
  const runId = findActiveRunId();
  if (!runId) return null;
  const run = readJson(path.join(RUNS_DIR, `${runId}.json`));
  if (!run) return null;
  const events = Array.isArray(run.events) ? run.events : [];
  const typeCounts = {};
  for (const e of events) {
    const t = e && e.type ? String(e.type) : "unknown";
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  const recent = events.slice(-5).map((e) => ({
    type: e && e.type ? String(e.type) : null,
    phase: e && e.phase ? String(e.phase) : null,
    at: (e && (e.at || e.created_at)) || null,
    message: e && e.message ? String(e.message).slice(0, 120) : null,
  }));
  return {
    run_id: run.run_id || runId,
    status: run.status || null,
    phase: run.phase || null,
    mission_id: run.mission_id || null,
    task_id: run.task_id || null,
    updated_at: run.updated_at || null,
    events_recent: recent,
    event_type_counts: typeCounts,
  };
}

function milestoneStateDone(state) {
  const upper = String(state || "").toUpperCase().trim();
  if (!upper) return false;
  for (const token of DONE_MILESTONE_STATES) {
    if (upper.startsWith(token)) return true;
  }
  return false;
}

function scanCurrentMilestone(missionId) {
  const dir = path.join(AGENT_ROOT, "missions", missionId, "milestones");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  for (const file of files) {
    let text = "";
    try { text = fs.readFileSync(path.join(dir, file), "utf8"); } catch (_) { continue; }
    const stateMatch = text.match(/^## Status[\s\S]*?^- State:\s*(.+)$/m);
    const state = stateMatch ? stateMatch[1].trim() : "";
    if (milestoneStateDone(state)) continue;
    const goalMatch = text.match(/^## Goal\s*\n+([\s\S]*?)(?=^## )/m);
    const goal = (goalMatch ? goalMatch[1].trim() : "").split(/\n/)[0].slice(0, 200);
    return {
      mission_id: missionId,
      milestone: file.replace(/\.md$/, ""),
      pointer: rel(path.join(dir, file)),
      state: state || null,
      goal: goal || null,
    };
  }
  return null;
}

function readCurrentMilestone(activeMissionId) {
  if (activeMissionId) {
    const direct = scanCurrentMilestone(activeMissionId);
    if (direct) return direct;
  }
  const missionsDir = path.join(AGENT_ROOT, "missions");
  if (!fs.existsSync(missionsDir)) return null;
  const missions = fs.readdirSync(missionsDir)
    .filter((n) => /^M-\d/.test(n))
    .filter((n) => { try { return fs.statSync(path.join(missionsDir, n)).isDirectory(); } catch (_) { return false; } })
    .sort((a, b) => {
      try {
        return fs.statSync(path.join(missionsDir, b)).mtimeMs - fs.statSync(path.join(missionsDir, a)).mtimeMs;
      } catch (_) { return 0; }
    });
  for (const missionId of missions) {
    const found = scanCurrentMilestone(missionId);
    if (found) return found;
  }
  return null;
}

function readCurrentDecision() {
  const indexFile = path.join(AGENT_ROOT, "decisions", "index.json");
  const index = readJson(indexFile);
  if (!index || !Array.isArray(index.decisions) || !index.decisions.length) return null;
  const open = index.decisions.filter((d) => {
    const s = String((d && d.status) || "").toLowerCase();
    return !DECISION_DONE_STATUSES.has(s);
  });
  const pool = open.length ? open : index.decisions;
  const latest = pool.slice().sort((a, b) => {
    const at = String((a && a.updated_at) || "");
    const bt = String((b && b.updated_at) || "");
    return bt.localeCompare(at);
  })[0];
  return {
    decision_id: (latest && latest.decision_id) || null,
    status: (latest && latest.status) || null,
    type: (latest && latest.type) || null,
    path: latest && latest.path ? rel(latest.path) : null,
    updated_at: (latest && latest.updated_at) || null,
    open_count: open.length,
    pointer: rel(indexFile),
  };
}

function summarizeArtifacts(paths) {
  const list = Array.isArray(paths) ? paths : [];
  const byStatus = {};
  let readable = 0;
  for (const p of list) {
    const state = readJson(path.resolve(process.cwd(), p));
    if (!state) continue;
    readable += 1;
    const s = String(state.status || state.state || "unknown");
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  return { count: list.length, readable, by_status: byStatus };
}

// Tiered digest per P-002 §2.3.  Kept high-priority fields + latest_archive
// metadata verbatim; long bodies/events/artifact lists collapsed to excerpts,
// counts, and pointers; raw stdout / full commit log / giant nested JSON
// dropped.  Only paths, summaries and pointers — no host private state.
function summarizeForResume(bundle, context = {}) {
  const archive = bundle.archive || {};
  const archiveState = archive.state || {};
  const activeRun = context.activeRun != null ? context.activeRun : readActiveRunSummary();
  const milestone = context.milestone != null ? context.milestone : readCurrentMilestone(activeRun ? activeRun.mission_id : null);
  const decision = context.decision != null ? context.decision : readCurrentDecision();
  const artifacts = summarizeArtifacts(bundle.artifact_states || []);
  const markdownPath = bundle.latest_markdown_archive;
  const bodyExcerpt = markdownPath ? excerptFile(markdownPath, 200) : "";
  return {
    ok: true,
    action: "resume-bundle",
    inject: true,
    summarized: true,
    project: bundle.project,
    generated_at: nowIso(),
    latest_archive: {
      path: bundle.latest_archive,
      archive_id: archive.archive_id || null,
      created_at: archive.created_at || null,
      source_host: archive.source_host || null,
      target_host: archive.target_host || null,
      reason: archive.reason || null,
      current_goal: archiveState.current_goal || null,
      in_progress: archiveState.in_progress || null,
      body_excerpt: bodyExcerpt || null,
      body_pointer: bodyExcerpt ? "see .agent/runtime-continuity/archives/latest.md" : null,
      markdown_path: markdownPath,
    },
    pending_handoffs: bundle.pending_handoffs || [],
    runs: activeRun
      ? {
          active: {
            run_id: activeRun.run_id,
            status: activeRun.status,
            phase: activeRun.phase,
            mission_id: activeRun.mission_id,
            task_id: activeRun.task_id,
            updated_at: activeRun.updated_at,
            events_recent: activeRun.events_recent,
            event_type_counts: activeRun.event_type_counts,
          },
        }
      : { active: null },
    current_milestone: milestone,
    current_decision: decision,
    artifact_states: artifacts,
    runtime_events_count: Array.isArray(bundle.runtime_events) ? bundle.runtime_events.length : 0,
    sessions_count: Array.isArray(bundle.sessions) ? bundle.sessions.length : 0,
    git: bundle.git ? { branch: bundle.git.branch, head: bundle.git.head } : null,
    next_action: bundle.next_action || null,
    read_first: bundle.read_first || [],
    recommended_commands: bundle.recommended_commands || [],
  };
}

// Under-budget inject block: the full bundle plus the mission/decision/run
// pointers the [CORTEX-RESUME] block format always carries (P-002 §2.1).
function enrichResumeBlock(bundle, context) {
  const activeRun = context.activeRun;
  const milestone = context.milestone;
  const decision = context.decision;
  return {
    ...bundle,
    inject: true,
    summarized: false,
    active_run: activeRun
      ? {
          run_id: activeRun.run_id,
          status: activeRun.status,
          phase: activeRun.phase,
          mission_id: activeRun.mission_id,
          task_id: activeRun.task_id,
          updated_at: activeRun.updated_at,
        }
      : null,
    current_milestone: milestone,
    current_decision: decision,
  };
}

// Build the `[CORTEX-RESUME]` block.  Under budget → full bundle tagged with
// inject markers + mission/decision pointers; over budget → summarizeForResume()
// digest.  Budget metadata is always attached so the host / agent can see how
// the decision was made.
function buildResumeBlock(bundle, { budgetPercent = DEFAULT_BUDGET_PERCENT, budgetTokens = null } = {}) {
  const windowTokens = budgetTokens || contextWindowTokens();
  const estimated = estimateBundleTokens(bundle);
  const limitTokens = Math.round(windowTokens * (budgetPercent / 100));
  const over = estimated > limitTokens;
  const activeRun = readActiveRunSummary();
  const context = {
    activeRun,
    milestone: readCurrentMilestone(activeRun ? activeRun.mission_id : null),
    decision: readCurrentDecision(),
  };
  const block = over
    ? summarizeForResume(bundle, context)
    : enrichResumeBlock(bundle, context);
  block.budget = {
    estimated_tokens: estimated,
    window_tokens: windowTokens,
    budget_percent: budgetPercent,
    limit_tokens: limitTokens,
    summarized: over,
  };
  return block;
}

// Emit the graceful-degrade envelope shared by the --auto failure path.
function degradedResumeBundle(project, error, inject) {
  const envelope = {
    ok: false,
    action: "resume-bundle",
    project,
    degraded: true,
    error,
    generated_at: nowIso(),
  };
  process.stderr.write(`[runtime-continuity] resume-bundle --auto graceful degrade: ${error}\n`);
  if (inject) process.stdout.write("[CORTEX-RESUME]\n");
  emit(envelope);
}

// ─── Mode 4 — status ─────────────────────────────────────────────────────────
function continuityGuardStatus() {
  const state = readJson(GUARD_STATE_FILE);
  if (!state) return { exists: false, active: false };
  const active = state.status === "running" && pidAlive(state.pid) && Date.now() < Date.parse(state.renew_until);
  return {
    exists: true,
    active,
    status: active ? "running" : state.status,
    pid: state.pid || null,
    heartbeat_at: state.heartbeat_at || null,
    renew_until: state.renew_until || null,
    last_archive_at: state.last_archive_at || null,
    last_archive_path: state.last_archive_path || null,
    last_error: state.last_error || null,
  };
}

function statusReport(project) {
  const dir = path.join(CONTEXT_HOME, project);
  if (!fs.existsSync(dir)) {
    return { ok: true, action: "status", project, exists: false, guard: continuityGuardStatus() };
  }
  const entries = listContexts(project);
  if (!entries.length) return { ok: true, action: "status", project, exists: true, count: 0, guard: continuityGuardStatus() };
  const mostRecent = path.join(dir, entries[0].name);
  const stat = fs.statSync(mostRecent);
  const ageHrs = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
  // Mirrors session-manager §模式 D "距上次存档 >2h 强烈建议立即存档".
  return {
    ok: true,
    action: "status",
    project,
    latest: entries[0].name,
    mtime: stat.mtime.toISOString(),
    age_hours: Number(ageHrs.toFixed(2)),
    stale_recommendation: ageHrs > 2 ? "archive_now" : "ok",
    count: entries.length,
    guard: continuityGuardStatus(),
  };
}

// ─── Mode 5 — warm ───────────────────────────────────────────────────────────
// Output the exact prompt session-manager §模式 E says the host should
// paste into its chat to start the 5-hour rolling window timer.
function warmPrompt() {
  return {
    ok: true,
    action: "warm",
    prompt_for_host_paste: [
      "---",
      "🟢 会话预热消息（请发送此消息以启动 5 小时计时窗口）",
      "---",
      "准备就绪，等候工作指令。",
    ].join("\n"),
    session_continuity_skill_hint: "/Users/xueyq/.agent/contexts/",
    duration_hours: 5,
    checkpoint_reminder_hours: 4,
  };
}

// ─── list-contexts — cross-project aggregation (Phase 3 prep) ────────────────
function listContextsAll({ since, format }) {
  if (!fs.existsSync(CONTEXT_HOME)) {
    return { ok: true, action: "list-contexts", exists: false, projects: [] };
  }
  const sinceMs = since ? Date.parse(since) : null;
  if (since && Number.isNaN(sinceMs)) {
    return { ok: false, action: "list-contexts", error: "invalid_since_iso", since };
  }
  const projects = [];
  for (const project of fs.readdirSync(CONTEXT_HOME)) {
    const dir = path.join(CONTEXT_HOME, project);
    if (!fs.statSync(dir).isDirectory()) continue;
    const archives = listContexts(project);
    const recent = archives.filter((a) => !sinceMs || a.mtime >= sinceMs);
    if (archives.length && recent.length) {
      projects.push({
        project,
        total_archives: archives.length,
        recent_archives: recent.length,
        last_mtime: new Date(Math.max(...archives.map((a) => a.mtime))).toISOString(),
      });
    }
  }
  projects.sort((a, b) => String(b.last_mtime).localeCompare(String(a.last_mtime)));
  // Lightweight "table" formatting for human readers; defaults to JSON
  // envelopes which downstream tools parse cleanly.
  if (format === "table") {
    const lines = ["project\tarchives\tlast_archive"];
    for (const p of projects) lines.push(`${p.project}\t${p.total_archives}\t${p.last_mtime}`);
    return { ok: true, action: "list-contexts", format: "table", table: lines.join("\n"), count: projects.length };
  }
  return { ok: true, action: "list-contexts", format: "json", projects, count: projects.length };
}

// ─── markSessionLastHost (Phase 2) ──────────────────────────────────────────
// Update sessions/<S>.json#last_host + last_switch_at.  Idempotent: if
// no active session exists, we synthesize a minimal record so future
// resume commands can read the host trace.
function markSessionLastHost(project, toHost) {
  const sessionsDir = path.join(AGENT_ROOT, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const stamp = ts();
  const sessionId = `S-${project}-${stamp}`;
  const file = path.join(sessionsDir, `${sessionId}.json`);
  const now = new Date().toISOString();
  // Existing session-triage creates S-*.json; we just append fields.
  // If a session for this project already exists, prefer to update
  // most-recent one rather than fragment.
  let target = null;
  if (fs.existsSync(sessionsDir)) {
    for (const name of fs.readdirSync(sessionsDir)) {
      if (!name.startsWith("S-") || !name.endsWith(".json")) continue;
      const path2 = path.join(sessionsDir, name);
      try {
        const body = JSON.parse(fs.readFileSync(path2, "utf8"));
        const isProjectMatch = body.project === project || body.current_task_id?.includes?.(project);
        const isOpen = body.status === "running" || body.status === "paused";
        if (isProjectMatch && isOpen) { target = path2; break; }
      } catch (_) { /* ignore */ }
    }
  }
  if (!target) {
    target = file;
    fs.writeFileSync(file, JSON.stringify({ session_id: sessionId, project, status: "running", started_at: now, last_host: toHost, last_switch_at: now }, null, 2), "utf8");
    return sessionId;
  }
  let body = {};
  try { body = JSON.parse(fs.readFileSync(target, "utf8")); } catch (_) {}
  body.last_host = toHost;
  body.last_switch_at = now;
  if (body.status === "closed" || !body.status) body.status = "running";
  fs.writeFileSync(target, JSON.stringify(body, null, 2), "utf8");
  return body.session_id || sessionId;
}

// ─── mission 上下文检测 (P-003 方案 C, M-030 MS-003) ────────────────────────
// Mission-plan 目录存在性启发式：扫描 `.agent/missions/<M-xxx>/mission-plan.md`，
// 状态行（`> **状态**:` / `> **State**:` / `**State**:` / `> State:`，不区分
// 大小写、中英文、空格容忍，兼容仓库实际使用的 `> **Status**:` 变体）非
// done/blocked/completed/complete → 视为活跃；无状态行 → 默认活跃（存在性
// 启发式）。零 schema 变更：只读 missions/，不写 sessions/tasks/runs。

// Match a mission-plan status line.  Tolerates optional list markers (`-`/`*`),
// blockquote `>`, bold `**`, and whitespace around the colon; labels 状态 /
// State / Status (case-insensitive).
const MISSION_STATE_LINE_RE = /^\s*(?:[-*]\s*)?(?:>\s*)?(?:\*\*)?(状态|State|Status)\s*(?:\*\*)?\s*:\s*(.+)$/i;

function missionStateExcluded(state) {
  if (!state) return false; // no matched state line → active (presence heuristic)
  const cleaned = String(state).replace(/[*`>]/g, "").trim();
  const lower = cleaned.toLowerCase();
  for (const token of MISSION_DONE_STATES) {
    if (lower === token || lower.startsWith(`${token} `) || lower.startsWith(`${token}-`) || lower.startsWith(`${token}_`)) {
      return true;
    }
  }
  return false;
}

// Read only the first 8 KiB of a mission-plan (state lines live near the top;
// bounded read keeps the scan < 50ms for ≤10 missions) and return the matched
// state value, or null when no state line matched.
function readMissionPlanState(planFile) {
  let head = "";
  try {
    const fd = fs.openSync(planFile, "r");
    try {
      const buf = Buffer.alloc(8192);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString("utf8", 0, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return null;
  }
  const lines = head.split(/\r?\n/).slice(0, 20);
  for (const line of lines) {
    const match = line.match(MISSION_STATE_LINE_RE);
    if (match) return match[2].replace(/[*`>]/g, "").trim();
  }
  return null;
}

function findActiveMissionHeuristic() {
  const missionsDir = path.join(AGENT_ROOT, "missions");
  const scannedAt = nowIso();
  try {
    if (!fs.existsSync(missionsDir)) {
      return { active_missions: [], heuristic_version: "v1", scanned_at: scannedAt };
    }
    const active = [];
    for (const name of fs.readdirSync(missionsDir)) {
      if (!/^M-/.test(name)) continue;
      const missionDir = path.join(missionsDir, name);
      try {
        if (!fs.statSync(missionDir).isDirectory()) continue;
      } catch (_) { continue; }
      const plan = path.join(missionDir, "mission-plan.md");
      if (!fs.existsSync(plan)) continue;
      const state = readMissionPlanState(plan);
      if (missionStateExcluded(state)) continue;
      active.push({
        mission_id: name,
        mission_dir: rel(missionDir),
        state: state || null,
        plan_pointer: rel(plan),
      });
    }
    active.sort((a, b) => String(a.mission_id).localeCompare(String(b.mission_id)));
    return { active_missions: active, heuristic_version: "v1", scanned_at: scannedAt };
  } catch (err) {
    return { active_missions: [], heuristic_version: "v1", error: err.message, scanned_at: scannedAt };
  }
}

// mission 上下文解析（方案 C）：--mission-id 显式 > 启发式检测 > null。
// host-switch 与 pre-departure 共用。显式时跳过启发式（不扫描）。
function buildMissionContext(argv) {
  const explicit = flag("--mission-id", argv);
  if (explicit) {
    return {
      mission_id: explicit,
      heuristic_version: "v1",
      source: "explicit",
      scanned_at: nowIso(),
    };
  }
  const heuristic = findActiveMissionHeuristic();
  if (!heuristic || heuristic.error) return null;
  return {
    heuristic_version: heuristic.heuristic_version,
    scanned_at: heuristic.scanned_at,
    active_missions: heuristic.active_missions || [],
  };
}

// ─── handoff JSON 自动生成 (P-003 方案 C, M-030 MS-003) ────────────────────
// writeHandoffFromSwitch() 在 host-switch 时按 handoff.schema.json 必填字段
// 自动生成 `.agent/handoffs/H-<ts>-host-switch-<from>-<to>.json`（既有惯例：
// H- 前缀 + ts，listHandoffs 的 `^H-` 过滤器可直接拾取），并调用
// handoff-protocol.js validate 校验。source/target/payload 语义映射到
// schema 字段：from.agent_id = "runtime-continuity:auto-<host>"、produced_at =
// source.timestamp、to.role/model_pref = target.kind/to_host、
// artifacts.* = payload 指针。MS-003 附加元数据（kind / mission_context /
// candidates）以文档化键写入（见 SKILL.md §11），不在 handoff.schema.json
// property set 内；去除这些键后严格满足 schema。
function writeHandoffFromSwitch({ project, fromHost, toHost, reason, missionId, missionContext, kind, candidates, note, sessionId, archive }) {
  const stamp = ts();
  const handoffId = `H-${stamp}-host-switch-${safeSlug(fromHost)}-${safeSlug(toHost)}`;
  const file = path.join(AGENT_ROOT, "handoffs", `${handoffId}.json`);
  const latestJson = archive && archive.archiveJsonPath ? archive.archiveJsonPath : latestArchiveJson();
  const latestMd = archive && archive.latestPath ? archive.latestPath : resolveLatest(project);
  const done = asList(note && note.done);
  const next = asList(note && note.next);
  const inProgress = (note && (note.in_progress || note.blocked)) || "Resume on the new host from the latest archive.";
  const payload = {
    handoff_id: handoffId,
    mode: "AGENT_RESUME",
    from: {
      agent_id: `runtime-continuity:auto-${fromHost}`,
      model: "runtime-continuity",
      session_id: sessionId || null,
    },
    to: {
      role: "session-start",
      model_pref: [toHost || "unknown"].filter(Boolean),
      required_capabilities: ["resume-bundle"],
    },
    task_id: project || "host-switch",
    mission_id: missionId || null,
    task_progress: {
      current_step: `Host switch ${fromHost} → ${toHost}${missionId ? ` (mission ${missionId})` : ""}`,
      completed_steps: done.length ? done : [`Archive created: ${latestJson ? rel(latestJson) : "n/a"}`],
      in_progress: inProgress,
      remaining_steps: next.length ? next : ["Run resume-bundle on the new host to pick up state"],
    },
    artifacts: {
      completed: done,
      context_snapshot_ref: latestJson ? rel(latestJson) : "",
      markdown_ref: latestMd ? rel(latestMd) : "",
      artifact_refs: [],
    },
    next_action: `New host (${toHost}): run \`node .agent/skills/runtime-continuity/scripts/index.js resume-bundle --project ${project}\` then continue from the latest archive.`,
    constraints: [
      "Auto-generated by runtime-continuity host-switch (M-030 MS-003, 方案 C)",
      reason ? `reason: ${reason}` : null,
    ].filter(Boolean),
    verification: {
      commands_run: [],
      commands_needed: [
        `node .agent/skills/runtime-continuity/scripts/index.js resume-bundle --project ${project}`,
      ],
      known_failures: [],
    },
    graphify_context: null,
    context_budget_hint: null,
    produced_at: nowIso(),
  };
  // MS-003 additive metadata (documented; outside handoff.schema.json property set):
  payload.kind = kind || "host-switch";
  if (missionContext) payload.mission_context = missionContext;
  if (candidates) payload.candidates = candidates;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, payload);
  let validation = null;
  try {
    const proto = path.join(AGENT_ROOT, "handoffs", "scripts", "handoff-protocol.js");
    if (fs.existsSync(proto)) {
      const res = spawnSync(process.execPath, [proto, "validate", "--payload-file", rel(file)], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 5000,
      });
      validation = { exit_code: res.status, ok: res.status === 0, output: String(res.stdout || "").trim() };
    }
  } catch (err) {
    validation = { exit_code: null, ok: false, error: err.message };
  }
  return { file, payload, validation };
}

// ─── run event appender ──────────────────────────────────────────────────────
function findActiveRunId() {
  if (!fs.existsSync(RUNS_DIR)) return null;
  const files = fs.readdirSync(RUNS_DIR)
    .filter((n) => n.endsWith(".json") && n !== "index.json" && !n.endsWith(".schema.json"));
  if (!files.length) return null;
  const enriched = files.map((name) => {
    const file = path.join(RUNS_DIR, name);
    try { return { name, mtime: fs.statSync(file).mtimeMs, status: JSON.parse(fs.readFileSync(file, "utf8")).status }; }
    catch { return { name, mtime: 0, status: null }; }
  });
  enriched.sort((a, b) => b.mtime - a.mtime);
  for (const f of enriched) if (f.status === "running" || f.status === "queued") return f.name.replace(/\.json$/, "");
  return enriched[0] ? enriched[0].name.replace(/\.json$/, "") : null;
}

function appendRunEvent(eventObj) {
  const runId = findActiveRunId();
  if (!runId) return false;
  const file = path.join(RUNS_DIR, `${runId}.json`);
  if (!fs.existsSync(file)) return false;
  let run = {};
  try { run = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return false; }
  if (!Array.isArray(run.events)) run.events = [];
  const now = new Date().toISOString();
  run.events = [...run.events, { ...eventObj, at: eventObj.at || now }].slice(-200);
  run.last_event = run.events[run.events.length - 1];
  run.updated_at = now;
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + "\n", "utf8");
  return true;
}

// ─── dispatch ───────────────────────────────────────────────────────────────
function parseNote(argv) {
  const raw = flag("--note-json", argv);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function main() {
  const argv = process.argv.slice(2);
  const [mode] = argv;

  if (mode === "__guard") {
    const project = flag("--project", argv);
    const leaseId = flag("--lease-id", argv);
    if (!project || !leaseId) fail("invalid_guard_start", "Internal guard requires project and lease id.");
    runContinuityGuard(project, leaseId);
    return;
  }

  if (mode === "assess") {
    requireGate([...GATES_TIGHT]);
    const desc = flag("--task-description", argv) || "";
    const out = assessBudget(desc);
    emit({ ok: true, action: "assess", task_words: desc.trim().split(/\s+/).filter(Boolean).length, ...out });
    return;
  }

  if (mode === "warm") {
    // warm is advisory by default — emits a prompt string, no side effects.
    // No gate required; hosts can call it freely.
    //
    // --auto + --project: also writes a session_started run event so the
    // framework knows when the session timer began (driven by SessionStart
    // hook).  This is the only side effect; it does NOT create files in
    // ~/.agent/contexts/.
    const project = flag("--project", argv);
    const auto = argv.includes("--auto");
    const result = warmPrompt();
    if (auto) {
      if (process.env.CORTEX_SESSION_START !== "1") {
        fail("session_start_only", "warm --auto may only be invoked by the SessionStart hook.");
      }
      if (!project) fail("missing_project", "--project is required for SessionStart automatic mode.");
      const eventRecorded = appendRunEvent({
        type: "session_started",
        via: "warm_auto_init",
        project,
      });
      const guard = startOrRenewContinuityGuard(project);
      result.auto_init = true;
      result.event_recorded = eventRecorded;
      result.guard = guard;
    }
    emit(result);
    return;
  }

  // list-contexts can run without --project (lists all projects in
  // ~/.agent/contexts/); admit early.  Default format is json; pass
  // --format=table to get a human-readable TSV.
  if (mode === "list-contexts") {
    const sinceIso = flag("--since", argv);
    const format = flag("--format", argv) || "json";
    const out = listContextsAll({ since: sinceIso, format });
    emit(out);
    return;
  }

  // --auto (host-switch / pre-departure automation path) tolerates a missing
  // --project by defaulting to the current directory basename; resume-bundle
  // --auto keeps its own graceful-degrade for a missing project (MS-002).
  // Every other mode keeps the strict missing-project error.
  let project = flag("--project", argv);
  const autoProjectOk = (mode === "host-switch" || mode === "pre-departure") && argv.includes("--auto");
  if (!project && autoProjectOk) project = path.basename(process.cwd());
  if (!project && !(mode === "resume-bundle" && argv.includes("--auto"))) {
    fail("missing_project", "--project is required for archive / restore / status / host-switch / pre-departure / resume-bundle.");
  }

  if (mode === "log" || mode === "checkpoint") {
    requireGate([...GATES_TIGHT]);
    const result = createRuntimeEvent(project, argv, {
      type: mode === "checkpoint" ? "checkpoint" : (flag("--type", argv) || "work_log"),
    });
    emit({
      ok: true,
      action: mode,
      project,
      event_path: result.eventPath,
      event: result.event,
    });
    return;
  }

  if (mode === "resume-bundle") {
    // Existing behavior (no flags): emit the full bundle JSON, read-only.
    // New flags (P-002 §2.1, additive):
    //   --auto            any failure → graceful degrade (exit 0 + stderr log)
    //   --inject          emit a `[CORTEX-RESUME]` marker line + JSON block
    //   --budget-percent  summarization threshold (% of context window, def 40)
    //   --budget-tokens   explicit context window size (tokens), optional
    const auto = argv.includes("--auto");
    const inject = argv.includes("--inject");
    const budgetPercent = parsePercent(flag("--budget-percent", argv), DEFAULT_BUDGET_PERCENT);
    const budgetTokensRaw = Number(flag("--budget-tokens", argv));
    const budgetTokens = Number.isFinite(budgetTokensRaw) && budgetTokensRaw > 0 ? budgetTokensRaw : null;
    try {
      if (!project) {
        degradedResumeBundle(project, "missing --project (auto mode)", inject);
        return; // exit 0 — never block SessionStart
      }
      const bundle = buildResumeBundle(project);
      if (inject) {
        const block = buildResumeBlock(bundle, { budgetPercent, budgetTokens });
        process.stdout.write("[CORTEX-RESUME]\n");
        emit(block);
      } else {
        emit(bundle);
      }
    } catch (err) {
      if (auto) {
        degradedResumeBundle(project, err.message, inject);
        return; // exit 0 — graceful degrade, never block SessionStart
      }
      fail("resume_bundle_failed", err.message);
    }
    return;
  }

  if (mode === "host-switch") {
    // Cross-host switch bus (Phase 2).  Triggered when user wants to move
    // work from one host (claude-code / cursor / codex / unknown) to
    // another.  This mode:
    //   1. calls archive() so the outgoing host's state is captured
    //   2. updates sessions/<active>.json with last_host / last_switch_at
    //   3. writes host_switch_initiated event to active run
    //   4. emits a hand-off package the new host can use to resume
    // MS-003 (P-003 方案 C, additive): mission 上下文检测 + handoff JSON 自动
    // 生成。--mission-id 显式 > 启发式检测 > null。--auto（runtime-continuity
    // 自动链路）跳过 user gate 并在缺 --project 时以 cwd basename 兜底；
    // 手动调用仍需 --gate user。既有 archive / session / 事件行为不变。
    const hostSwitchAuto = argv.includes("--auto");
    if (!hostSwitchAuto) requireGate([...GATES_DESTRUCTIVE]);
    const fromHost = flag("--from-host", argv) || "unknown";
    const toHost = flag("--to-host", argv) || flag("--next-host", argv) || "unknown";
    const reason = flag("--reason", argv) || "";
    let archived;
    try {
      archived = archiveProject(project, parseNote(argv), {
        source_host: fromHost,
        target_host: toHost,
        reason,
      });
    } catch (err) {
      fail("host_switch_archive_failed", err.message);
      return;
    }
    const sid = markSessionLastHost(project, toHost);
    appendRunEvent({
      type: "host_switch_initiated",
      project,
      from_host: fromHost,
      to_host: toHost,
      reason,
      archive_path: archived.archivePath,
      archive_json_path: archived.archiveJsonPath,
    });

    // MS-003: mission 上下文检测（方案 C）→ handoff JSON 自动生成
    const missionIdFlag = flag("--mission-id", argv);
    let missionId = missionIdFlag;
    let missionContext = null;
    let handoffKind = "host-switch";
    let candidates = null;
    if (missionIdFlag) {
      // 显式指定：跳过启发式，直接关联
      missionContext = {
        mission_id: missionIdFlag,
        heuristic_version: "v1",
        source: "explicit",
        scanned_at: nowIso(),
      };
    } else {
      const heuristic = findActiveMissionHeuristic();
      if (heuristic && heuristic.error) {
        handoffKind = "host-switch-without-mission";
        missionContext = {
          heuristic_version: "v1",
          error: heuristic.error,
          scanned_at: nowIso(),
        };
      } else if (heuristic) {
        missionContext = {
          heuristic_version: heuristic.heuristic_version,
          scanned_at: heuristic.scanned_at,
          active_missions: heuristic.active_missions || [],
        };
        const active = heuristic.active_missions || [];
        if (active.length === 0) {
          handoffKind = "host-switch-without-mission";
        } else if (active.length === 1) {
          missionId = active[0].mission_id;
          handoffKind = "host-switch";
        } else {
          // ≥2 活跃 mission：不自动选，写 ambiguous handoff 交由后续 disambiguation
          handoffKind = "host-switch-multi-mission-ambiguous";
          candidates = active.map((m) => ({
            mission_id: m.mission_id,
            state: m.state || null,
            plan_pointer: m.plan_pointer,
          }));
        }
      }
    }
    let handoff = null;
    let handoffError = null;
    try {
      handoff = writeHandoffFromSwitch({
        project,
        fromHost,
        toHost,
        reason,
        missionId,
        missionContext,
        kind: handoffKind,
        candidates,
        note: parseNote(argv),
        sessionId: sid,
        archive: archived,
      });
      appendRunEvent({
        type: "host_switch_handoff",
        project,
        handoff_path: rel(handoff.file),
        mission_id: handoff.payload.mission_id,
        kind: handoff.payload.kind,
      });
    } catch (err) {
      handoffError = err.message;
      appendRunEvent({ type: "host_switch_handoff_error", project, error: err.message });
    }

    emit({
      ok: true,
      action: "host-switch",
      project,
      from_host: fromHost,
      to_host: toHost,
      reason,
      archive: archived,
      session_id: sid,
      mission_context: missionContext,
      handoff: handoff ? {
        path: rel(handoff.file),
        mission_id: handoff.payload.mission_id,
        kind: handoff.payload.kind,
        candidates: handoff.payload.candidates || null,
        validation: handoff.validation,
      } : null,
      handoff_error: handoffError,
      next_steps_for_new_host: [
        "1. Read archive body via: runtime-continuity restore --project <P> --load latest",
        "2. Pick up active run via: read .agent/runs/<id>.json events[] (latest host_switch_initiated tells you where to resume)",
        "3. If the new host uses the same ~/.agent/contexts/, no extra import is required — the latest.md symlink is already in place.",
        "4. host-only reattach: the archive does NOT carry hook secrets; re-establish Authorization: token ${secret://<ref>} via the secrets skill if needed.",
        "5. Auto handoff JSON (M-030 MS-003): run handoff-protocol.js resume-prompt --payload-file <path> on the new host for the resume prompt.",
      ],
    });
    return;
  }

  if (mode === "pre-departure") {
    // Pre-departure trigger (P-001 / MS-001): SessionEnd hooks call this so
    // the outgoing host writes a checkpoint + host_switch_initiated event
    // before the session closes.  Auto path (--gate agent) — NEVER blocks
    // session close:
    //   1. checkpoint event (phase=session_ending) via createRuntimeEvent
    //   2. host_switch_initiated event (from_host/to_host/reason/archive_pending)
    //   3. if 1 or 2 throws -> degrade to archiveProject(source_host='auto-pre-departure')
    //      + pre_departure_fallback event
    //   4. any exception -> graceful degrade: record pre_departure_graceful_degrade
    //      event (if possible) and ALWAYS exit 0 — never propagate to the hook layer
    // MS-003 (P-003 方案 C, additive): --mission-id flag + mission_context 注入
    // checkpoint 事件 payload（--mission-id 显式 > 启发式检测）。--auto 跳过
    // gate 并在缺 --project 时以 cwd basename 兜底；手动调用仍需 --gate。
    if (!argv.includes("--auto")) requireGate([...GATES_TIGHT]);
    const fromHost = flag("--from-host", argv) || flag("--host", argv) || "unknown";
    const toHost = flag("--next-host", argv) || process.env.CORTEX_NEXT_HOST || "unknown";
    const reason = flag("--reason", argv) || "session_end_auto";
    const events = [];
    const problems = [];
    let degraded = false;
    const missionContext = buildMissionContext(argv);
    const checkpointArgv = missionContext ? [...argv, "--mission-context-json", JSON.stringify(missionContext)] : argv;

    const recordProblem = (step, message) => {
      degraded = true;
      problems.push({ step, error: message });
    };

    // Degrade path: capture a structured archive + pre_departure_fallback event.
    const fallbackArchive = (step, err) => {
      recordProblem(step, err.message);
      try {
        const archived = archiveProject(project, parseNote(argv), {
          source_host: "auto-pre-departure",
          target_host: toHost,
          reason: `pre_departure_fallback: ${reason}`,
        });
        appendRunEvent({
          type: "pre_departure_fallback",
          project,
          from_host: fromHost,
          to_host: toHost,
          reason,
          archive_path: archived.archivePath,
          archive_json_path: archived.archiveJsonPath,
        });
        events.push("pre_departure_fallback");
      } catch (err2) {
        recordProblem("pre_departure_fallback_archive", err2.message);
      }
    };

    // 1. checkpoint 事件（phase=session_ending；MS-003 附带 mission_context）
    try {
      createRuntimeEvent(project, checkpointArgv, {
        type: "checkpoint",
        phase: "session_ending",
        message: reason || "session ending (pre-departure)",
        host: fromHost,
      });
      events.push("checkpoint");
    } catch (err) {
      fallbackArchive("pre_departure_checkpoint", err);
    }

    // 2. host_switch_initiated 事件（archive_pending=true）
    try {
      const recorded = appendRunEvent({
        type: "host_switch_initiated",
        project,
        from_host: fromHost,
        to_host: toHost,
        reason,
        archive_pending: true,
        via: "pre_departure",
      });
      if (recorded) events.push("host_switch_initiated");
      else recordProblem("host_switch_initiated_run_append", "no active run to append host_switch_initiated");
    } catch (err) {
      fallbackArchive("host_switch_initiated", err);
    }

    // 3/4. graceful degrade：任何残留异常只记录、绝不抛出、绝不退出非 0
    try {
      if (degraded) {
        appendRunEvent({
          type: "pre_departure_graceful_degrade",
          project,
          from_host: fromHost,
          to_host: toHost,
          reason,
          problems,
        });
        events.push("pre_departure_graceful_degrade");
      }
    } catch (_) { /* never block session close */ }

    emit({
      ok: true,
      action: "pre-departure",
      project,
      from_host: fromHost,
      to_host: toHost,
      reason,
      events,
      problems,
      mission_context: missionContext,
    });
    return;
  }

  if (mode === "archive") {
    requireGate([...GATES_DESTRUCTIVE]);
    const note = parseNote(argv);
    let archived;
    try {
      archived = archiveProject(project, note, {
        source_host: flag("--from-host", argv) || flag("--host", argv) || null,
        target_host: flag("--to-host", argv) || null,
        reason: flag("--reason", argv) || null,
        full: argv.includes("--full"),
      });
    } catch (err) {
      fail("archive_failed", err.message);
      return;
    }
    appendRunEvent({
      type: "session_archived",
      project,
      archive_path: archived.archivePath,
      archive_json_path: archived.archiveJsonPath,
    });
    emit({ ok: true, action: "archive", project, ...archived });
    return;
  }

  if (mode === "restore") {
    const wantList = argv.includes("--list");
    const wantAuto = argv.includes("--auto");
    if (!wantList && !wantAuto) requireGate([...GATES_TIGHT]);
    emit(loadContext(project, wantList ? "list" : wantAuto ? "auto" : "load"));
    if (!wantList) appendRunEvent({ type: "session_restored", project, mode: wantAuto ? "auto" : "load" });
    return;
  }

  if (mode === "status") {
    const out = statusReport(project);
    emit(out);
    appendRunEvent({ type: "session_status_queried", project, ...(out.age_hours != null ? { age_hours: out.age_hours } : {}) });
    return;
  }

  fail(
    "unknown_command",
    "Usage: runtime-continuity {assess|log|checkpoint|archive|restore|status|warm|host-switch|pre-departure|resume-bundle|list-contexts} [--project P] [--gate user|agent] ...; host-switch extra flags: [--auto --mission-id <M-xxx> --next-host <H>]; pre-departure extra flags: [--auto --mission-id <M-xxx>]; resume-bundle extra flags: [--auto --inject --budget-percent <0-100> --budget-tokens <N>]",
  );
}

if (require.main === module) main();
module.exports = {
  assessBudget,
  archiveProject,
  listContexts,
  listContextsAll,
  resolveLatest,
  loadContext,
  createRuntimeEvent,
  buildResumeBundle,
  statusReport,
  warmPrompt,
  automaticArchiveNote,
  latestArchiveAgeMs,
  startOrRenewContinuityGuard,
  continuityGuardStatus,
  markSessionLastHost,
  findActiveRunId,
  // resume-bundle --auto --inject (P-002 / MS-002)
  estimateBundleTokens,
  summarizeForResume,
  buildResumeBlock,
  readActiveRunSummary,
  readCurrentMilestone,
  readCurrentDecision,
  // mission 上下文检测 + handoff JSON 自动生成 (P-003 方案 C / MS-003)
  findActiveMissionHeuristic,
  buildMissionContext,
  writeHandoffFromSwitch,
};
