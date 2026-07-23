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
  const event = {
    event_id: eventId,
    project,
    host: flag("--host", argv) || defaults.host || "unknown",
    agent_id: flag("--agent-id", argv) || defaults.agent_id || null,
    run_id: flag("--run-id", argv) || defaults.run_id || findActiveRunId(),
    session_id: flag("--session-id", argv) || defaults.session_id || findLatestSessionId(project),
    task_id: flag("--task-id", argv) || defaults.task_id || null,
    mission_id: flag("--mission-id", argv) || defaults.mission_id || null,
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

  const project = flag("--project", argv);
  if (!project) fail("missing_project", "--project is required for archive / restore / status / host-switch.");

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
    emit(buildResumeBundle(project));
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
    requireGate([...GATES_DESTRUCTIVE]);
    const fromHost = flag("--from-host", argv) || "unknown";
    const toHost = flag("--to-host", argv) || "unknown";
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
    emit({
      ok: true,
      action: "host-switch",
      project,
      from_host: fromHost,
      to_host: toHost,
      reason,
      archive: archived,
      session_id: sid,
      next_steps_for_new_host: [
        "1. Read archive body via: runtime-continuity restore --project <P> --load latest",
        "2. Pick up active run via: read .agent/runs/<id>.json events[] (latest host_switch_initiated tells you where to resume)",
        "3. If the new host uses the same ~/.agent/contexts/, no extra import is required — the latest.md symlink is already in place.",
        "4. host-only reattach: the archive does NOT carry hook secrets; re-establish Authorization: token ${secret://<ref>} via the secrets skill if needed.",
      ],
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
    "Usage: runtime-continuity {assess|log|checkpoint|archive|restore|status|warm|host-switch|resume-bundle|list-contexts} [--project P] [--gate user|agent] ...",
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
};
