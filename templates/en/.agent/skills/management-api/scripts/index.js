#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = process.cwd();
const agentRoot = path.join(root, ".agent");
const args = process.argv.slice(2);

const RUN_PHASES = new Set([
  "initializing",
  "briefing",
  "decomposing",
  "planning",
  "queueing",
  "creating_worktree",
  "acquiring_lock",
  "invoking_agent",
  "reading",
  "editing",
  "running_command",
  "validating",
  "handoff",
  "merging",
  "publishing",
  "waiting",
  "blocked",
  "completed",
]);

function sh(command, cwd = root) {
  try {
    return execSync(command, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function read(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function readJson(file) {
  try { return JSON.parse(read(file)); } catch { return null; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function option(name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx === -1 || !args[idx + 1]) return fallback;
  return args[idx + 1];
}

function flag(name) {
  return args.includes(name);
}

function parsePayload() {
  const raw = option("--payload-json");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail("invalid_payload_json", err.message);
    return {};
  }
}

function nowIso() {
  return new Date().toISOString();
}

function safeId(value, prefix) {
  const base = String(value || "").trim();
  if (base) return base.replace(/[^A-Za-z0-9_.:-]+/g, "-");
  return `${prefix}-${nowIso().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

function runFile(runId) {
  return path.join(agentRoot, "runs", `${safeId(runId, "R")}.json`);
}

function normalizePhase(phase) {
  if (!phase) return null;
  const normalized = String(phase).trim();
  return RUN_PHASES.has(normalized) ? normalized : normalized;
}

function compactEvent(event) {
  const payload = { ...event };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === "") delete payload[key];
  }
  return payload;
}

function listFiles(dir, filter) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => !filter || filter(name))
      .map((name) => path.join(dir, name))
      .sort();
  } catch {
    return [];
  }
}

function listJsonObjects(dir, options = {}) {
  const skip = new Set(options.skip || ["index.json"]);
  return listFiles(dir, (name) => {
    if (!name.endsWith(".json")) return false;
    if (skip.has(name)) return false;
    if (name.endsWith(".schema.json")) return false;
    return true;
  }).map((file) => ({ file, data: readJson(file) })).filter((item) => item.data);
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function parseTasks() {
  const file = path.join(agentRoot, "plans", "task-progress.md");
  const text = read(file);
  const activeSection = (text.match(/##\s*[^\n]*(?:当前活跃任务|Active Tasks)[^\n]*\n([\s\S]*?)(?=\n##\s|\n---\s*$|$)/i) || [])[1] || "";
  const tableTasks = [];
  for (const line of activeSection.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || /^\|\s*:?-{3,}/.test(trimmed)) continue;
    const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells.length < 4 || /任务\s*ID|Task\s*ID/i.test(cells[0])) continue;
    const id = (cells[0].match(/\b(?:T|M)-[A-Za-z0-9-]+\b/) || [])[0];
    if (!id) continue;
    const joinedCells = cells.join(" ");
    const progressMatch = cells[3].match(/(\d+(?:\.\d+)?)\s*%/);
    const progress = progressMatch ? Number(progressMatch[1]) : null;
    const blocked = /blocked|阻塞|暂停|NOT_RUN|待执行|⚠️|❌/i.test(joinedCells);
    const done = progress === 100 || /\[[xX]\]|完成|Done|已合入|PASS/i.test(cells[3]);
    const active = !done && !blocked && (progress !== null && progress > 0 || /active|进行中|in[- ]progress|当前/i.test(joinedCells));
    tableTasks.push({
      id,
      priority: cells[1] || "",
      title: cells[2] || id,
      progress: progressMatch ? `${progressMatch[1]}%` : cells[3] || "",
      plan: cells[4] || "",
      status: done ? "done" : blocked ? "blocked" : active ? "active" : "open",
    });
  }
  if (tableTasks.length) return tableTasks;

  const tasks = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const id = (line.match(/\bT-[A-Za-z0-9-]+\b/) || [])[0];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const done = /\[[xX]\]|✅|完成|Done/i.test(line);
    const blocked = /blocked|阻塞|暂停|⚠️|❌/i.test(line);
    const active = /active|进行中|in[- ]progress|当前/i.test(line);
    tasks.push({
      id,
      title: line.replace(/^\s*[-*]\s*/, "").replace(/\*\*/g, "").slice(0, 180),
      priority: "",
      progress: "",
      plan: "",
      status: done ? "done" : blocked ? "blocked" : active ? "active" : "open",
    });
  }
  return tasks;
}

function parseWorktrees() {
  const raw = sh("git worktree list --porcelain");
  const blocks = raw ? raw.split(/\n(?=worktree )/) : [];
  return blocks.map((block) => {
    const item = {};
    for (const line of block.split(/\r?\n/)) {
      const [key, ...rest] = line.split(" ");
      if (!key) continue;
      item[key] = rest.join(" ");
    }
    const status = item.worktree ? sh("git status --short --branch", item.worktree) : "";
    return {
      path: item.worktree || "",
      branch: item.branch ? item.branch.replace(/^refs\/heads\//, "") : item.detached ? "detached" : "",
      head: item.HEAD || "",
      bare: Boolean(item.bare),
      status,
      dirty: status.split(/\r?\n/).some((line) => line && !line.startsWith("##")),
      isMain: item.worktree ? path.resolve(item.worktree) === root : false,
    };
  });
}

function parseRegistry() {
  const data = readJson(path.join(agentRoot, "registry", "agents.json"));
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  return agents.filter((agent) => ["running", "paused", "active"].includes(agent.status));
}

function parseLocks() {
  const dir = path.join(agentRoot, "locks");
  const files = listFiles(dir, (name) => name.endsWith(".lock.json"));
  return files.map((file) => {
    const lock = readJson(file) || {};
    const expires = Date.parse(lock.expires_at);
    return {
      ...lock,
      path: rel(file),
      expired: Number.isFinite(expires) ? expires <= Date.now() : false,
    };
  });
}

function parseHandoffs() {
  const dir = path.join(agentRoot, "handoffs");
  return listFiles(dir, (name) => {
    if (!(name.endsWith(".md") || name.endsWith(".json"))) return false;
    if (/^(README|handoff\.schema)\./i.test(name)) return false;
    return /^H-|^\d{8,}[-_]/.test(name);
  })
    .slice(-12)
    .map((file) => {
      const stat = fs.statSync(file);
      return {
        path: rel(file),
        type: file.endsWith(".json") ? "json" : "markdown",
        updated: stat.mtime.toISOString(),
      };
    });
}

function parseArtifacts() {
  const dir = path.join(agentRoot, "artifacts");
  const taskDirs = listFiles(dir, (name) => {
    try { return fs.statSync(path.join(dir, name)).isDirectory(); } catch { return false; }
  });
  return taskDirs.map((taskDir) => {
    const state = readJson(path.join(taskDir, "state.json")) || {};
    return {
      task_id: path.basename(taskDir),
      latest: state.latest_artifact || "",
      count: Array.isArray(state.artifacts) ? state.artifacts.length : 0,
      updated: state.updated_at || state.last_updated || "",
    };
  });
}

function parsePrds() {
  const roots = [path.join(agentRoot, "prd"), path.join(agentRoot, "prds")];
  const prds = [];
  for (const prdRoot of roots) {
    const index = readJson(path.join(prdRoot, "index.json"));
    const indexed = Array.isArray(index?.prds) ? index.prds : [];
    for (const item of indexed) {
      const dir = item.path ? path.resolve(prdRoot, item.path) : path.join(prdRoot, item.prd_id || item.id || "");
      const state = readJson(path.join(dir, "state.json")) || {};
      prds.push(normalizePrd({ ...item, ...state }, dir));
    }
    for (const dir of listFiles(prdRoot, (name) => {
      try { return fs.statSync(path.join(prdRoot, name)).isDirectory(); } catch { return false; }
    })) {
      const state = readJson(path.join(dir, "state.json"));
      if (!state) continue;
      const id = state.prd_id || path.basename(dir);
      if (prds.some((prd) => prd.id === id)) continue;
      prds.push(normalizePrd(state, dir));
    }
  }
  return prds.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))).slice(0, 12);
}

function normalizePrd(data, dir) {
  const design = data.design && typeof data.design === "object" ? data.design : {};
  const review = data.review && typeof data.review === "object" ? data.review : {};
  return {
    id: data.prd_id || data.id || path.basename(dir),
    title: data.title || data.name || data.prd_id || path.basename(dir),
    status: data.status || "idea",
    owner: data.owner || "",
    summary: data.summary || "",
    path: rel(dir),
    updated_at: data.updated_at || "",
    related_mission_id: data.related_mission_id || null,
    related_tasks: Array.isArray(data.related_tasks) ? data.related_tasks : [],
    design: {
      tool: design.tool || "",
      status: design.status || "not_started",
      url: design.url || "",
      local_path: design.local_path || "",
      screen_count: design.screen_count ?? null,
      export_target: design.export_target || "",
    },
    review: {
      status: review.status || "",
      decision_id: review.decision_id || "",
      reviewer: review.reviewer || "",
    },
    missing: prdMissingFields(dir),
  };
}

function prdMissingFields(dir) {
  const checks = [
    ["context", ["prd.md"]],
    ["user stories", ["user-stories.md", "stories.md"]],
    ["flows", ["flows.md", "user-flow.md"]],
    ["screens", ["screens.md", "screen-map.json"]],
    ["acceptance criteria", ["acceptance-criteria.md", "validation-contract.json"]],
    ["decisions", ["decisions.md"]],
  ];
  return checks
    .filter(([, files]) => !files.some((file) => fs.existsSync(path.join(dir, file))))
    .map(([name]) => name);
}

function summarizePrds(prds) {
  if (!prds.length) {
    return {
      status: "not_started",
      design: "not_started",
      review: "open",
      completeness: 0,
      missing: ["prd", "user stories", "flows", "screens", "acceptance criteria"],
      current_id: null,
    };
  }
  const current = prds[0];
  const total = current.missing.length + 6;
  return {
    status: current.status,
    design: current.design.status || "not_started",
    review: current.review.status || "open",
    completeness: Math.round(((total - current.missing.length) / total) * 100),
    missing: current.missing,
    current_id: current.id,
  };
}

function parseRuns() {
  return listJsonObjects(path.join(agentRoot, "runs"))
    .map(({ file, data }) => ({
      ...data,
      path: rel(file),
      events: Array.isArray(data.events) ? data.events : [],
      last_event: data.last_event || (Array.isArray(data.events) ? data.events[data.events.length - 1] : null) || null,
    }))
    .sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")))
    .slice(0, 20);
}

function parseQueues() {
  return listJsonObjects(path.join(agentRoot, "queues"))
    .map(({ file, data }) => ({
      ...data,
      path: rel(file),
      items: Array.isArray(data.items) ? data.items : [],
    }))
    .sort((a, b) => String(a.queue_id || a.path).localeCompare(String(b.queue_id || b.path)));
}

function parseSessions() {
  const staleAfterMs = 5 * 60 * 1000;
  const now = Date.now();
  return listJsonObjects(path.join(agentRoot, "sessions"))
    .map(({ file, data }) => {
      const heartbeat = Date.parse(data.last_heartbeat_at || data.started_at);
      const stale = ["running", "paused"].includes(data.status) && Number.isFinite(heartbeat) && now - heartbeat > staleAfterMs;
      return {
        ...data,
        path: rel(file),
        status: stale ? "stale" : data.status,
        activity: stale ? "Session heartbeat is stale." : data.activity,
        stale,
      };
    })
    .sort((a, b) => String(b.last_heartbeat_at || b.started_at || "").localeCompare(String(a.last_heartbeat_at || a.started_at || "")));
}

function deriveState({ worktrees, locks, handoffs, tasks, agents, runs, sessions }) {
  const nonMainWorktrees = worktrees.filter((w) => !w.isMain);
  const dirty = worktrees.some((w) => w.dirty);
  const heldLocks = locks.filter((l) => !l.expired);
  const blockedTasks = tasks.filter((t) => t.status === "blocked");
  const activeTasks = tasks.filter((t) => t.status === "active" || t.status === "open");
  const activeAgents = agents.filter((a) => ["running", "active", "paused"].includes(a.status));
  const runningRuns = (runs || []).filter((r) => r.status === "running");
  const staleSessions = (sessions || []).filter((s) => s.status === "stale");

  if (runningRuns.length) {
    const run = runningRuns[0];
    const action = run.activity || run.last_event?.message || run.phase || "Agent run is active.";
    return {
      state: "in_progress",
      next: action,
      nextEn: action,
      why: `Run ${run.run_id || run.path} 正在执行${run.phase ? `：${run.phase}` : ""}。`,
      whyEn: `Run ${run.run_id || run.path} is running${run.phase ? `: ${run.phase}` : ""}.`,
    };
  }

  if (blockedTasks.length) {
    return {
      state: "blocked",
      next: "先处理阻塞任务，必要时创建 /handoff 或回到 /plan 重新拆分。",
      nextEn: "Resolve blocked tasks first. Create /handoff or return to /plan if needed.",
      why: `发现 ${blockedTasks.length} 个阻塞任务。`,
      whyEn: `${blockedTasks.length} blocked task(s) detected.`,
    };
  }
  if (staleSessions.length) {
    return {
      state: "stale_sessions",
      next: "/agent-dashboard --serve 或关闭 stale session 后重新 /briefing。",
      nextEn: "/agent-dashboard --serve or close stale sessions, then run /briefing again.",
      why: `发现 ${staleSessions.length} 个 stale session。`,
      whyEn: `${staleSessions.length} stale session(s) detected.`,
    };
  }
  if (!nonMainWorktrees.length && !heldLocks.length && !activeAgents.length) {
    const ids = activeTasks.slice(0, 3).map((t) => t.id).join(" ");
    return {
      state: "idle",
      next: ids ? `/worktree plan ${ids}` : "/plan <大需求> 或 /briefing",
      nextEn: ids ? `/worktree plan ${ids}` : "/plan <large requirement> or /briefing",
      why: "还没有非主 worktree、活动锁或活跃 Agent。",
      whyEn: "No non-main worktree, active lock, or active agent yet.",
    };
  }
  if (handoffs.length && !heldLocks.length && !dirty) {
    return {
      state: "handoff_required",
      next: "/handoff resume <handoff>，恢复后重新获取 lock。",
      nextEn: "/handoff resume <handoff>, then re-acquire the lock.",
      why: "存在 handoff，但当前没有持有锁。",
      whyEn: "Handoff exists, but no lock is currently held.",
    };
  }
  if (dirty || activeAgents.length) {
    return {
      state: "in_progress",
      next: "继续当前 worktree 任务；达到可验证点后运行 /worktree commit <task-id>。",
      nextEn: "Continue current worktree task; after a verifiable point run /worktree commit <task-id>.",
      why: "检测到工作区改动或活跃 Agent。",
      whyEn: "Detected worktree changes or active agents.",
    };
  }
  if (heldLocks.length) {
    return {
      state: "merge_ready",
      next: "/worktree merge <task-id>，合并后立即 /worktree validate <task-id>。",
      nextEn: "/worktree merge <task-id>, then immediately /worktree validate <task-id>.",
      why: "有持有锁且当前没有检测到未提交改动。",
      whyEn: "A lock is held and no uncommitted changes were detected.",
    };
  }
  return {
    state: "planned",
    next: "/worktree status 或 /start-task <task-id>，开始前获取 task/file lock。",
    nextEn: "/worktree status or /start-task <task-id>; acquire task/file lock before writing.",
    why: "已有基础协作状态，但尚未进入明确执行阶段。",
    whyEn: "Coordination state exists, but execution has not clearly started.",
  };
}

function queryDashboardState() {
  const tasks = parseTasks();
  const worktrees = parseWorktrees();
  const agents = parseRegistry();
  const locks = parseLocks();
  const handoffs = parseHandoffs();
  const artifacts = parseArtifacts();
  const prds = parsePrds();
  const prdSummary = summarizePrds(prds);
  const runs = parseRuns();
  const queues = parseQueues();
  const sessions = parseSessions();
  const gitStatus = sh("git status --short --branch");
  const derived = deriveState({ worktrees, locks, handoffs, tasks, agents, runs, sessions });

  return {
    ok: true,
    query: "dashboard-state",
    generated_at: new Date().toISOString(),
    project: {
      name: path.basename(root),
      root,
    },
    tasks,
    worktrees,
    agents,
    runs,
    queues,
    sessions,
    locks,
    handoffs,
    artifacts,
    prds,
    prd_summary: prdSummary,
    git_status: gitStatus,
    derived,
    summary: {
      active_tasks: tasks.filter((t) => t.status !== "done").length,
      held_locks: locks.filter((l) => !l.expired).length,
      non_main_worktrees: worktrees.filter((w) => !w.isMain).length,
      running_runs: runs.filter((r) => r.status === "running").length,
      active_queues: queues.filter((q) => q.status === "active").length,
      stale_sessions: sessions.filter((s) => s.status === "stale").length,
      active_phases: runs.filter((r) => r.status === "running" && r.phase).map((r) => r.phase),
      prds: prds.length,
      prd_completeness: prdSummary.completeness,
    },
  };
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(error, message, code = 2) {
  printJson({ ok: false, error, message });
  process.exit(code);
}

function upsertRun() {
  const payload = parsePayload();
  const runId = safeId(option("--run-id", payload.run_id), "R");
  const file = runFile(runId);
  const existing = readJson(file) || {};
  const timestamp = nowIso();
  const patch = {
    ...payload,
    run_id: runId,
    task_id: option("--task-id", payload.task_id ?? existing.task_id ?? null),
    mission_id: option("--mission-id", payload.mission_id ?? existing.mission_id ?? null),
    agent_id: option("--agent-id", payload.agent_id ?? existing.agent_id ?? null),
    role: option("--role", payload.role ?? existing.role ?? null),
    kind: option("--kind", payload.kind ?? existing.kind ?? "implement"),
    status: option("--status", payload.status ?? existing.status ?? "running"),
    phase: normalizePhase(option("--phase", payload.phase ?? existing.phase ?? null)),
    activity: option("--activity", payload.activity ?? existing.activity ?? null),
    worktree_path: option("--worktree-path", payload.worktree_path ?? existing.worktree_path ?? null),
    branch: option("--branch", payload.branch ?? existing.branch ?? null),
    started_at: option("--started-at", payload.started_at ?? existing.started_at ?? timestamp),
    finished_at: option("--finished-at", payload.finished_at ?? existing.finished_at ?? null),
    updated_at: timestamp,
  };
  if (["completed", "failed", "canceled"].includes(patch.status) && !patch.finished_at) {
    patch.finished_at = timestamp;
    if (!patch.phase || patch.status === "completed") patch.phase = patch.status === "completed" ? "completed" : patch.phase;
  }
  const events = Array.isArray(existing.events) ? existing.events : [];
  const next = { ...existing, ...patch, events };
  if (!Array.isArray(next.commands)) next.commands = Array.isArray(payload.commands) ? payload.commands : [];
  if (!Array.isArray(next.artifacts)) next.artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
  if (!next.validation || typeof next.validation !== "object") next.validation = {};
  if (flag("--event") || option("--message") || patch.activity !== existing.activity || patch.phase !== existing.phase || patch.status !== existing.status) {
    const event = compactEvent({
      type: option("--event-type", flag("--event") ? "state_changed" : "run_updated"),
      phase: patch.phase,
      status: patch.status,
      activity: patch.activity,
      message: option("--message", patch.activity),
      at: timestamp,
    });
    next.events = [...events, event].slice(-200);
    next.last_event = event;
  } else if (existing.last_event) {
    next.last_event = existing.last_event;
  }
  writeJson(file, next);
  printJson({ ok: true, action: "runs upsert", path: rel(file), run: next });
}

function appendRunEvent() {
  const payload = parsePayload();
  const runId = safeId(option("--run-id", payload.run_id), "R");
  const file = runFile(runId);
  const existing = readJson(file) || {
    run_id: runId,
    kind: option("--kind", payload.kind || "implement"),
    status: "running",
    started_at: nowIso(),
  };
  const timestamp = nowIso();
  const event = compactEvent({
    ...payload,
    type: option("--type", payload.type || "event"),
    phase: normalizePhase(option("--phase", payload.phase || existing.phase || null)),
    status: option("--status", payload.status || existing.status || null),
    activity: option("--activity", payload.activity || null),
    message: option("--message", payload.message || null),
    at: option("--at", payload.at || timestamp),
  });
  const next = {
    ...existing,
    status: event.status || existing.status,
    phase: event.phase || existing.phase || null,
    activity: event.activity || event.message || existing.activity || null,
    updated_at: timestamp,
    events: [...(Array.isArray(existing.events) ? existing.events : []), event].slice(-200),
    last_event: event,
  };
  if (["completed", "failed", "canceled"].includes(next.status) && !next.finished_at) next.finished_at = timestamp;
  writeJson(file, next);
  printJson({ ok: true, action: "runs event", path: rel(file), event, run: next });
}

function checkpointRun() {
  const payload = parsePayload();
  const runId = safeId(option("--run-id", payload.run_id), "R");
  const file = runFile(runId);
  const existing = readJson(file) || {};
  const timestamp = nowIso();
  const status = option("--status", payload.status ?? existing.status ?? "running");
  const phase = normalizePhase(option("--phase", payload.phase ?? existing.phase ?? null));
  const activity = option("--activity", payload.activity ?? option("--message", payload.message ?? existing.activity ?? null));
  const eventType = option("--type", payload.type || payload.event_type || "state_changed");
  const message = option("--message", payload.message || activity || eventType);
  const patch = {
    ...payload,
    run_id: runId,
    task_id: option("--task-id", payload.task_id ?? existing.task_id ?? null),
    mission_id: option("--mission-id", payload.mission_id ?? existing.mission_id ?? null),
    agent_id: option("--agent-id", payload.agent_id ?? existing.agent_id ?? null),
    role: option("--role", payload.role ?? existing.role ?? null),
    kind: option("--kind", payload.kind ?? existing.kind ?? "implement"),
    status,
    phase,
    activity,
    worktree_path: option("--worktree-path", payload.worktree_path ?? existing.worktree_path ?? null),
    branch: option("--branch", payload.branch ?? existing.branch ?? null),
    started_at: option("--started-at", payload.started_at ?? existing.started_at ?? timestamp),
    finished_at: option("--finished-at", payload.finished_at ?? existing.finished_at ?? null),
    updated_at: timestamp,
  };
  if (["completed", "failed", "canceled"].includes(patch.status) && !patch.finished_at) {
    patch.finished_at = timestamp;
    if (!patch.phase || patch.status === "completed") patch.phase = patch.status === "completed" ? "completed" : patch.phase;
  }

  const event = compactEvent({
    type: eventType,
    phase: patch.phase,
    status: patch.status,
    activity: patch.activity,
    message,
    at: option("--at", payload.at || timestamp),
  });
  const events = Array.isArray(existing.events) ? existing.events : [];
  const next = {
    ...existing,
    ...patch,
    events: [...events, event].slice(-200),
    last_event: event,
  };
  if (!Array.isArray(next.commands)) next.commands = Array.isArray(payload.commands) ? payload.commands : [];
  if (!Array.isArray(next.artifacts)) next.artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
  if (!next.validation || typeof next.validation !== "object") next.validation = {};

  writeJson(file, next);
  printJson({ ok: true, action: "runs checkpoint", path: rel(file), event, run: next });
}

function main() {
  const [command, query] = args;
  if (command === "query" && query === "dashboard-state") {
    printJson(queryDashboardState());
    return;
  }
  if (command === "runs" && query === "upsert") {
    upsertRun();
    return;
  }
  if (command === "runs" && query === "event") {
    appendRunEvent();
    return;
  }
  if (command === "runs" && query === "checkpoint") {
    checkpointRun();
    return;
  }

  printJson({
    ok: false,
    error: "unsupported_command",
    usage: "node .agent/skills/management-api/scripts/index.js query dashboard-state | runs upsert | runs event | runs checkpoint",
  });
  process.exitCode = 2;
}

main();
