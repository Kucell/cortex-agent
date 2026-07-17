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
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
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

function optionalDateTime(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value);
  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!rfc3339.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    fail("invalid_date_time", `${field} must be an RFC 3339 date-time`);
  }
  return normalized;
}

function safeId(value, prefix) {
  const base = String(value || "").trim();
  if (base) return base.replace(/[^A-Za-z0-9_.:-]+/g, "-");
  return `${prefix}-${nowIso().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

function runFile(runId) {
  return path.join(agentRoot, "runs", `${safeId(runId, "R")}.json`);
}

function queueFile(queueId) {
  return path.join(agentRoot, "queues", `${safeId(queueId, "Q")}.json`);
}

function sessionFile(sessionId) {
  return path.join(agentRoot, "sessions", `${safeId(sessionId, "S")}.json`);
}

function prefixedId(value, prefix) {
  const normalized = safeId(value, prefix);
  return normalized.startsWith(`${prefix}-`) ? normalized : `${prefix}-${normalized}`;
}

function inboxFile(messageId) {
  return path.join(agentRoot, "inbox", `${prefixedId(messageId, "IM")}.json`);
}

function decisionFile(decisionId) {
  return path.join(agentRoot, "decisions", `${prefixedId(decisionId, "D")}.json`);
}

function waitpointFile(waitpointId) {
  return path.join(agentRoot, "waitpoints", `${prefixedId(waitpointId, "WP")}.json`);
}

function requireGate(allowed) {
  const gate = option("--gate");
  if (!allowed.includes(gate)) {
    fail("workflow_gate_required", `--gate must be one of: ${allowed.join(", ")}`);
  }
  return gate;
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

function stringList(value) {
  if (Array.isArray(value)) return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))];
  return [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
}

function emptyRelations(payload = {}) {
  const relations = payload && typeof payload === "object" ? payload : {};
  return {
    task_ids: stringList(relations.task_ids),
    mission_ids: stringList(relations.mission_ids),
    run_ids: stringList(relations.run_ids),
    queue_ids: stringList(relations.queue_ids),
    session_ids: stringList(relations.session_ids),
    artifact_refs: stringList(relations.artifact_refs),
    worktree_paths: stringList(relations.worktree_paths),
  };
}

function updateIndex(dirName, collection, idKey, data, file) {
  const indexFile = path.join(agentRoot, dirName, "index.json");
  const existing = readJson(indexFile) || { [collection]: [] };
  const items = Array.isArray(existing[collection]) ? existing[collection] : [];
  const entry = { ...data, path: rel(file) };
  const index = items.findIndex((item) => item[idKey] === entry[idKey]);
  const nextItems = [...items];
  if (index === -1) nextItems.push(entry);
  else nextItems[index] = { ...nextItems[index], ...entry };
  writeJson(indexFile, { ...existing, [collection]: nextItems });
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

function parseInbox() {
  return listJsonObjects(path.join(agentRoot, "inbox"))
    .map(({ file, data }) => ({ ...data, path: rel(file) }))
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
}

function parseDecisions() {
  return listJsonObjects(path.join(agentRoot, "decisions"))
    .map(({ file, data }) => ({ ...data, path: rel(file) }))
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
}

function parseWaitpoints() {
  const now = Date.now();
  return listJsonObjects(path.join(agentRoot, "waitpoints"))
    .map(({ file, data }) => {
      const expiresAt = Date.parse(data.expires_at);
      const expired = ["pending", "blocked"].includes(data.status) && Number.isFinite(expiresAt) && expiresAt <= now;
      return {
        ...data,
        path: rel(file),
        effective_status: expired ? "expired" : data.status,
        expired,
      };
    })
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
}

function deriveState({ worktrees, locks, handoffs, tasks, agents, runs, sessions, decisions, waitpoints }) {
  const nonMainWorktrees = worktrees.filter((w) => !w.isMain);
  const dirty = worktrees.some((w) => w.dirty);
  const heldLocks = locks.filter((l) => !l.expired);
  const blockedTasks = tasks.filter((t) => t.status === "blocked");
  const activeTasks = tasks.filter((t) => t.status === "active" || t.status === "open");
  const activeAgents = agents.filter((a) => ["running", "active", "paused"].includes(a.status));
  const runningRuns = (runs || []).filter((r) => r.status === "running");
  const staleSessions = (sessions || []).filter((s) => s.status === "stale");
  const openDecisions = (decisions || []).filter((decision) => decision.status === "open");
  const blockingWaitpoints = (waitpoints || []).filter((waitpoint) => ["pending", "blocked"].includes(waitpoint.effective_status || waitpoint.status));

  if (blockingWaitpoints.length || openDecisions.length) {
    return {
      state: "waiting_approval",
      next: "处理待决 Decision，并由 owning workflow 验证证据后释放 Waitpoint。",
      nextEn: "Resolve the pending Decision, then let the owning workflow validate evidence and release the Waitpoint.",
      why: `发现 ${openDecisions.length} 个待决 Decision 和 ${blockingWaitpoints.length} 个阻塞 Waitpoint。`,
      whyEn: `${openDecisions.length} open Decision(s) and ${blockingWaitpoints.length} blocking Waitpoint(s) detected.`,
    };
  }

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
  const inbox = parseInbox();
  const decisions = parseDecisions();
  const waitpoints = parseWaitpoints();
  const gitStatus = sh("git status --short --branch");
  const derived = deriveState({ worktrees, locks, handoffs, tasks, agents, runs, sessions, decisions, waitpoints });

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
    inbox,
    decisions,
    waitpoints,
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
      unread_messages: inbox.filter((message) => message.status === "unread").length,
      open_decisions: decisions.filter((decision) => decision.status === "open").length,
      blocking_waitpoints: waitpoints.filter((waitpoint) => ["pending", "blocked"].includes(waitpoint.effective_status || waitpoint.status)).length,
      active_phases: runs.filter((r) => r.status === "running" && r.phase).map((r) => r.phase),
      prds: prds.length,
      prd_completeness: prdSummary.completeness,
    },
  };
}

function queryRuns() {
  const runs = parseRuns();
  return {
    ok: true,
    query: "runs",
    generated_at: new Date().toISOString(),
    runs,
    summary: {
      total: runs.length,
      running: runs.filter((run) => run.status === "running").length,
      completed: runs.filter((run) => run.status === "completed").length,
      failed: runs.filter((run) => run.status === "failed").length,
      canceled: runs.filter((run) => run.status === "canceled").length,
    },
  };
}

function queryQueues() {
  const queues = parseQueues();
  return {
    ok: true,
    query: "queues",
    generated_at: new Date().toISOString(),
    queues,
    summary: {
      total: queues.length,
      active: queues.filter((queue) => queue.status === "active").length,
      paused: queues.filter((queue) => queue.status === "paused").length,
      drained: queues.filter((queue) => queue.status === "drained").length,
      items: queues.reduce((sum, queue) => sum + (Array.isArray(queue.items) ? queue.items.length : 0), 0),
    },
  };
}

function querySessions() {
  const sessions = parseSessions();
  return {
    ok: true,
    query: "sessions",
    generated_at: new Date().toISOString(),
    sessions,
    summary: {
      total: sessions.length,
      running: sessions.filter((session) => session.status === "running").length,
      paused: sessions.filter((session) => session.status === "paused").length,
      closed: sessions.filter((session) => session.status === "closed").length,
      stale: sessions.filter((session) => session.status === "stale").length,
    },
  };
}

function queryInbox() {
  const inbox = parseInbox();
  return {
    ok: true,
    query: "inbox",
    generated_at: nowIso(),
    inbox,
    summary: {
      total: inbox.length,
      unread: inbox.filter((message) => message.status === "unread").length,
      acknowledged: inbox.filter((message) => message.status === "acknowledged").length,
      archived: inbox.filter((message) => message.status === "archived").length,
    },
  };
}

function queryDecisions() {
  const decisions = parseDecisions();
  return {
    ok: true,
    query: "decisions",
    generated_at: nowIso(),
    decisions,
    summary: {
      total: decisions.length,
      open: decisions.filter((decision) => decision.status === "open").length,
      approved: decisions.filter((decision) => decision.status === "approved").length,
      rejected: decisions.filter((decision) => decision.status === "rejected").length,
      revision_requested: decisions.filter((decision) => decision.status === "revision_requested").length,
    },
  };
}

function queryWaitpoints() {
  const waitpoints = parseWaitpoints();
  return {
    ok: true,
    query: "waitpoints",
    generated_at: nowIso(),
    waitpoints,
    summary: {
      total: waitpoints.length,
      pending: waitpoints.filter((waitpoint) => waitpoint.effective_status === "pending").length,
      blocked: waitpoints.filter((waitpoint) => waitpoint.effective_status === "blocked").length,
      released: waitpoints.filter((waitpoint) => waitpoint.effective_status === "released").length,
      expired: waitpoints.filter((waitpoint) => waitpoint.effective_status === "expired").length,
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

function upsertQueue() {
  const gate = requireGate(["parallel", "worktree", "approve", "mission"]);
  const payload = parsePayload();
  const queueId = safeId(option("--queue-id", payload.queue_id), "Q");
  const file = queueFile(queueId);
  const existing = readJson(file) || {};
  const timestamp = nowIso();
  const next = {
    ...existing,
    ...payload,
    queue_id: queueId,
    name: option("--name", payload.name ?? existing.name ?? queueId),
    status: option("--status", payload.status ?? existing.status ?? "active"),
    concurrency_limit: Number(option("--concurrency-limit", payload.concurrency_limit ?? existing.concurrency_limit ?? 1)),
    items: Array.isArray(payload.items) ? payload.items : Array.isArray(existing.items) ? existing.items : [],
    updated_at: timestamp,
    updated_by_gate: gate,
  };
  if (!["active", "paused", "drained"].includes(next.status)) fail("invalid_queue_status", next.status);
  writeJson(file, next);
  printJson({ ok: true, action: "queues upsert", path: rel(file), queue: next });
}

function updateQueueItem() {
  const gate = requireGate(["parallel", "worktree", "approve", "mission"]);
  const payload = parsePayload();
  const queueId = safeId(option("--queue-id", payload.queue_id), "Q");
  const taskId = option("--task-id", payload.task_id);
  if (!taskId) fail("task_id_required", "--task-id is required");
  const file = queueFile(queueId);
  const existing = readJson(file);
  if (!existing) fail("queue_not_found", queueId, 1);
  const timestamp = nowIso();
  const item = {
    ...payload,
    task_id: taskId,
    state: option("--state", payload.state || "queued"),
    phase: option("--phase", payload.phase ?? null),
    activity: option("--activity", payload.activity ?? null),
    worktree_path: option("--worktree-path", payload.worktree_path ?? null),
    agent_id: option("--agent-id", payload.agent_id ?? null),
    run_id: option("--run-id", payload.run_id ?? null),
    updated_at: timestamp,
  };
  if (!["queued", "running", "blocked", "done"].includes(item.state)) fail("invalid_queue_item_state", item.state);
  const items = Array.isArray(existing.items) ? existing.items : [];
  const index = items.findIndex((candidate) => candidate.task_id === taskId);
  const nextItems = [...items];
  if (index === -1) nextItems.push(item);
  else nextItems[index] = { ...nextItems[index], ...item };
  const next = { ...existing, items: nextItems, updated_at: timestamp, updated_by_gate: gate };
  writeJson(file, next);
  printJson({ ok: true, action: "queues item", path: rel(file), item, queue: next });
}

function openSession() {
  const payload = parsePayload();
  const sessionId = safeId(option("--session-id", payload.session_id), "S");
  const agentId = option("--agent-id", payload.agent_id);
  const role = option("--role", payload.role);
  if (!agentId || !role) fail("session_owner_required", "--agent-id and --role are required");
  const file = sessionFile(sessionId);
  const existing = readJson(file);
  if (existing && existing.agent_id !== agentId) fail("session_owner_mismatch", sessionId, 1);
  const timestamp = nowIso();
  const next = {
    ...(existing || {}),
    ...payload,
    session_id: sessionId,
    agent_id: agentId,
    role,
    status: "running",
    phase: option("--phase", payload.phase ?? existing?.phase ?? null),
    activity: option("--activity", payload.activity ?? existing?.activity ?? null),
    current_run_id: option("--run-id", payload.current_run_id ?? existing?.current_run_id ?? null),
    current_task_id: option("--task-id", payload.current_task_id ?? existing?.current_task_id ?? null),
    worktree_path: option("--worktree-path", payload.worktree_path ?? existing?.worktree_path ?? null),
    started_at: existing?.started_at || option("--started-at", payload.started_at ?? timestamp),
    last_heartbeat_at: timestamp,
    updated_at: timestamp,
  };
  writeJson(file, next);
  printJson({ ok: true, action: "sessions open", path: rel(file), session: next });
}

function heartbeatSession() {
  const payload = parsePayload();
  const sessionId = safeId(option("--session-id", payload.session_id), "S");
  const agentId = option("--agent-id", payload.agent_id);
  const file = sessionFile(sessionId);
  const existing = readJson(file);
  if (!existing) fail("session_not_found", sessionId, 1);
  if (!agentId || existing.agent_id !== agentId) fail("session_owner_mismatch", sessionId, 1);
  const timestamp = nowIso();
  const next = {
    ...existing,
    phase: option("--phase", payload.phase ?? existing.phase ?? null),
    activity: option("--activity", payload.activity ?? existing.activity ?? null),
    current_run_id: option("--run-id", payload.current_run_id ?? existing.current_run_id ?? null),
    current_task_id: option("--task-id", payload.current_task_id ?? existing.current_task_id ?? null),
    status: existing.status === "paused" ? "paused" : "running",
    last_heartbeat_at: timestamp,
    updated_at: timestamp,
  };
  writeJson(file, next);
  printJson({ ok: true, action: "sessions heartbeat", path: rel(file), session: next });
}

function transitionSession(status) {
  const gate = requireGate(["owner", "handoff", "user", "mission"]);
  const payload = parsePayload();
  const sessionId = safeId(option("--session-id", payload.session_id), "S");
  const agentId = option("--agent-id", payload.agent_id);
  const file = sessionFile(sessionId);
  const existing = readJson(file);
  if (!existing) fail("session_not_found", sessionId, 1);
  if (gate === "owner" && (!agentId || existing.agent_id !== agentId)) fail("session_owner_mismatch", sessionId, 1);
  const timestamp = nowIso();
  const next = {
    ...existing,
    status,
    phase: option("--phase", payload.phase ?? existing.phase ?? null),
    activity: option("--activity", payload.activity ?? existing.activity ?? null),
    last_heartbeat_at: timestamp,
    updated_at: timestamp,
    updated_by_gate: gate,
  };
  if (status === "closed") next.closed_at = timestamp;
  writeJson(file, next);
  printJson({ ok: true, action: `sessions ${status === "closed" ? "close" : "pause"}`, path: rel(file), session: next });
}

function sendInboxMessage() {
  requireGate(["workflow", "handoff", "user"]);
  const payload = parsePayload();
  const messageId = prefixedId(option("--message-id", payload.message_id), "IM");
  const file = inboxFile(messageId);
  if (readJson(file)) fail("inbox_message_exists", messageId, 1);
  const senderId = option("--sender-id", payload.sender_id);
  const recipientIds = stringList(option("--recipient-ids", payload.recipient_ids));
  const subject = option("--subject", payload.subject);
  const type = option("--type", payload.type || "information");
  if (!senderId || !recipientIds.length || !subject) fail("inbox_fields_required", "--sender-id, --recipient-ids, and --subject are required");
  if (!["information", "request", "handoff", "decision_request", "alert"].includes(type)) fail("invalid_inbox_type", type);
  const timestamp = nowIso();
  const message = {
    schema_version: 1,
    message_id: messageId,
    type,
    status: "unread",
    sender_id: senderId,
    recipient_ids: recipientIds,
    subject,
    body: option("--body", payload.body || ""),
    artifact_refs: stringList(payload.artifact_refs),
    relations: emptyRelations(payload.relations),
    created_at: timestamp,
    updated_at: timestamp,
    read_at: null,
    acknowledged_at: null,
    archived_at: null,
  };
  writeJson(file, message);
  updateIndex("inbox", "messages", "message_id", {
    message_id: messageId,
    type,
    status: message.status,
    subject,
    updated_at: timestamp,
  }, file);
  printJson({ ok: true, action: "inbox send", path: rel(file), message });
}

function transitionInboxMessage() {
  const gate = requireGate(["recipient", "handoff", "workflow", "user"]);
  const payload = parsePayload();
  const messageId = prefixedId(option("--message-id", payload.message_id), "IM");
  const status = option("--status", payload.status);
  const file = inboxFile(messageId);
  const existing = readJson(file);
  if (!existing) fail("inbox_message_not_found", messageId, 1);
  const allowed = {
    unread: ["read", "acknowledged", "archived"],
    read: ["acknowledged", "archived"],
    acknowledged: ["archived"],
    archived: [],
  };
  if (!(allowed[existing.status] || []).includes(status)) fail("invalid_inbox_transition", `${existing.status} -> ${status}`);
  const actorId = option("--actor-id", payload.actor_id);
  if (gate === "recipient" && (!actorId || !existing.recipient_ids.includes(actorId))) fail("inbox_recipient_mismatch", messageId, 1);
  if (gate === "workflow" && (!actorId || existing.sender_id !== actorId || status !== "archived")) fail("inbox_workflow_mismatch", messageId, 1);
  const timestamp = nowIso();
  const next = {
    ...existing,
    status,
    updated_at: timestamp,
  };
  if (status === "read") next.read_at = timestamp;
  if (status === "acknowledged") {
    next.read_at = next.read_at || timestamp;
    next.acknowledged_at = timestamp;
  }
  if (status === "archived") next.archived_at = timestamp;
  writeJson(file, next);
  updateIndex("inbox", "messages", "message_id", {
    message_id: messageId,
    type: next.type,
    status,
    subject: next.subject,
    updated_at: timestamp,
  }, file);
  printJson({ ok: true, action: "inbox transition", path: rel(file), message: next });
}

function requestDecision() {
  requireGate(["approve", "mission", "worktree", "release", "risk", "checkpoint-merge", "arch-design", "user"]);
  const payload = parsePayload();
  const decisionId = prefixedId(option("--decision-id", payload.decision_id), "D");
  const file = decisionFile(decisionId);
  if (readJson(file)) fail("decision_exists", decisionId, 1);
  const requestedBy = option("--requested-by", payload.requested_by);
  const prompt = option("--prompt", payload.prompt);
  const type = option("--type", payload.type || "approval");
  const action = option("--action", payload.gate?.action);
  const resourceRef = option("--resource-ref", payload.gate?.resource_ref);
  const options = stringList(payload.options?.length ? payload.options : option("--options", "approve,reject,revise"));
  if (!requestedBy || !prompt || !action || !resourceRef) fail("decision_fields_required", "requested_by, prompt, gate action, and resource_ref are required");
  if (!["approval", "architecture", "merge", "release", "risk"].includes(type)) fail("invalid_decision_type", type);
  if (!["architecture", "merge", "release", "destructive", "credential", "external_side_effect"].includes(action)) fail("invalid_gate_action", action);
  if (!["approve", "reject", "revise"].every((value) => options.includes(value))) fail("decision_options_required", "options must include approve, reject, and revise");
  const timestamp = nowIso();
  const decision = {
    schema_version: 1,
    decision_id: decisionId,
    type,
    status: "open",
    requested_by: requestedBy,
    prompt,
    options,
    selected_option: null,
    resolved_by: null,
    resolved_at: null,
    rationale: "",
    gate: { action, resource_ref: resourceRef },
    relations: emptyRelations(payload.relations),
    superseded_by_decision_id: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  writeJson(file, decision);
  updateIndex("decisions", "decisions", "decision_id", {
    decision_id: decisionId,
    type,
    status: decision.status,
    gate_action: action,
    resource_ref: resourceRef,
    updated_at: timestamp,
  }, file);
  printJson({ ok: true, action: "decisions request", path: rel(file), decision });
}

function resolveDecision() {
  const payload = parsePayload();
  const status = option("--status", payload.status);
  const allowedStatuses = ["approved", "rejected", "revision_requested", "canceled"];
  if (!allowedStatuses.includes(status)) fail("invalid_decision_status", status || "missing");
  const gate = requireGate(status === "canceled" ? ["user", "requester"] : ["user"]);
  const decisionId = prefixedId(option("--decision-id", payload.decision_id), "D");
  const file = decisionFile(decisionId);
  const existing = readJson(file);
  if (!existing) fail("decision_not_found", decisionId, 1);
  if (existing.status !== "open") fail("decision_already_resolved", decisionId, 1);
  const resolvedBy = option("--resolved-by", payload.resolved_by);
  const rationale = option("--rationale", payload.rationale);
  if (!resolvedBy || !rationale) fail("decision_resolution_required", "--resolved-by and --rationale are required");
  if (gate === "requester" && resolvedBy !== existing.requested_by) fail("decision_requester_mismatch", decisionId, 1);
  const expectedOptions = { approved: "approve", rejected: "reject", revision_requested: "revise" };
  const selectedOption = status === "canceled" ? null : option("--selected-option", payload.selected_option || expectedOptions[status]);
  if (selectedOption && (!existing.options.includes(selectedOption) || selectedOption !== expectedOptions[status])) {
    fail("decision_option_mismatch", selectedOption, 1);
  }
  const timestamp = nowIso();
  const next = {
    ...existing,
    status,
    selected_option: selectedOption,
    resolved_by: resolvedBy,
    resolved_at: timestamp,
    rationale,
    updated_at: timestamp,
  };
  writeJson(file, next);
  updateIndex("decisions", "decisions", "decision_id", {
    decision_id: decisionId,
    type: next.type,
    status,
    gate_action: next.gate.action,
    resource_ref: next.gate.resource_ref,
    updated_at: timestamp,
  }, file);
  printJson({ ok: true, action: "decisions resolve", path: rel(file), decision: next });
}

function supersedeDecision() {
  requireGate(["requester"]);
  const payload = parsePayload();
  const decisionId = prefixedId(option("--decision-id", payload.decision_id), "D");
  const replacementId = prefixedId(option("--superseded-by-decision-id", payload.superseded_by_decision_id), "D");
  if (decisionId === replacementId) fail("decision_self_supersede", decisionId, 1);
  const file = decisionFile(decisionId);
  const replacementFile = decisionFile(replacementId);
  const existing = readJson(file);
  const replacement = readJson(replacementFile);
  if (!existing) fail("decision_not_found", decisionId, 1);
  if (!replacement) fail("replacement_decision_not_found", replacementId, 1);
  if (existing.status !== "open") fail("decision_already_resolved", decisionId, 1);
  if (replacement.status !== "open") fail("replacement_decision_not_open", replacementId, 1);
  const supersededBy = option("--superseded-by", payload.superseded_by);
  const rationale = option("--rationale", payload.rationale);
  if (!supersededBy || !rationale) fail("decision_supersede_required", "--superseded-by and --rationale are required");
  if (supersededBy !== existing.requested_by || replacement.requested_by !== existing.requested_by) {
    fail("decision_requester_mismatch", decisionId, 1);
  }
  if (replacement.type !== existing.type || replacement.gate?.action !== existing.gate?.action) {
    fail("replacement_decision_contract_mismatch", replacementId, 1);
  }
  const timestamp = nowIso();
  const next = {
    ...existing,
    status: "superseded",
    selected_option: null,
    resolved_by: supersededBy,
    resolved_at: timestamp,
    rationale,
    superseded_by_decision_id: replacementId,
    updated_at: timestamp,
  };
  writeJson(file, next);
  updateIndex("decisions", "decisions", "decision_id", {
    decision_id: decisionId,
    type: next.type,
    status: next.status,
    gate_action: next.gate.action,
    resource_ref: next.gate.resource_ref,
    updated_at: timestamp,
  }, file);
  printJson({ ok: true, action: "decisions supersede", path: rel(file), decision: next, replacement_ref: rel(replacementFile) });
}

function createWaitpoint() {
  requireGate(["approve", "mission", "worktree", "release", "risk", "checkpoint-merge", "arch-design"]);
  const payload = parsePayload();
  const waitpointId = prefixedId(option("--waitpoint-id", payload.waitpoint_id), "WP");
  const file = waitpointFile(waitpointId);
  if (readJson(file)) fail("waitpoint_exists", waitpointId, 1);
  const ownerWorkflow = option("--owner-workflow", payload.owner_workflow);
  const reason = option("--reason", payload.reason);
  const action = option("--action", payload.gate?.action);
  const resourceRef = option("--resource-ref", payload.gate?.resource_ref);
  if (!ownerWorkflow?.startsWith("/") || !reason || !action || !resourceRef) fail("waitpoint_fields_required", "owner_workflow, reason, gate action, and resource_ref are required");
  if (!["architecture", "merge", "release", "destructive", "credential", "external_side_effect"].includes(action)) fail("invalid_gate_action", action);
  const timestamp = nowIso();
  const waitpoint = {
    schema_version: 1,
    waitpoint_id: waitpointId,
    status: "blocked",
    owner_workflow: ownerWorkflow,
    reason,
    decision_id: option("--decision-id", payload.decision_id) ? prefixedId(option("--decision-id", payload.decision_id), "D") : null,
    evidence_refs: stringList(payload.evidence_refs),
    gate: { action, resource_ref: resourceRef },
    release_note: null,
    released_by: null,
    released_at: null,
    expires_at: optionalDateTime(option("--expires-at", payload.expires_at || null), "expires_at"),
    relations: emptyRelations(payload.relations),
    created_at: timestamp,
    updated_at: timestamp,
  };
  writeJson(file, waitpoint);
  updateIndex("waitpoints", "waitpoints", "waitpoint_id", {
    waitpoint_id: waitpointId,
    status: waitpoint.status,
    owner_workflow: ownerWorkflow,
    decision_id: waitpoint.decision_id,
    gate_action: action,
    resource_ref: resourceRef,
    updated_at: timestamp,
  }, file);
  printJson({ ok: true, action: "waitpoints create", path: rel(file), waitpoint });
}

function releaseWaitpoint() {
  requireGate(["owner"]);
  const payload = parsePayload();
  const waitpointId = prefixedId(option("--waitpoint-id", payload.waitpoint_id), "WP");
  const file = waitpointFile(waitpointId);
  const existing = readJson(file);
  if (!existing) fail("waitpoint_not_found", waitpointId, 1);
  if (!["pending", "blocked"].includes(existing.status)) fail("waitpoint_not_releasable", existing.status, 1);
  if (existing.expires_at) {
    const expiresAt = Date.parse(existing.expires_at);
    if (!Number.isFinite(expiresAt)) fail("waitpoint_invalid_expiry", waitpointId, 1);
    if (expiresAt <= Date.now()) fail("waitpoint_expired", waitpointId, 1);
  }
  const ownerWorkflow = option("--owner-workflow", payload.owner_workflow);
  if (!ownerWorkflow || ownerWorkflow !== existing.owner_workflow) fail("waitpoint_owner_mismatch", waitpointId, 1);
  const decisionId = prefixedId(option("--decision-id", payload.decision_id || existing.decision_id), "D");
  const decisionPath = decisionFile(decisionId);
  const decision = readJson(decisionPath);
  if (!decision) fail("decision_not_found", decisionId, 1);
  if (decision.status !== "approved" || decision.selected_option !== "approve" || !decision.resolved_by || !decision.resolved_at) {
    fail("decision_not_approved", decisionId, 1);
  }
  if (decision.gate?.action !== existing.gate?.action || decision.gate?.resource_ref !== existing.gate?.resource_ref) {
    fail("decision_gate_mismatch", decisionId, 1);
  }
  if (existing.decision_id && existing.decision_id !== decisionId) fail("waitpoint_decision_mismatch", decisionId, 1);
  const releasedBy = option("--released-by", payload.released_by);
  if (!releasedBy) fail("released_by_required", "--released-by is required");
  const timestamp = nowIso();
  const decisionRef = rel(decisionPath);
  const next = {
    ...existing,
    status: "released",
    decision_id: decisionId,
    evidence_refs: [...new Set([...(existing.evidence_refs || []), ...stringList(payload.evidence_refs), decisionRef])],
    release_note: option("--release-note", payload.release_note || "Approved Decision matched the protected action and resource."),
    released_by: releasedBy,
    released_at: timestamp,
    updated_at: timestamp,
  };
  writeJson(file, next);
  updateIndex("waitpoints", "waitpoints", "waitpoint_id", {
    waitpoint_id: waitpointId,
    status: next.status,
    owner_workflow: next.owner_workflow,
    decision_id: decisionId,
    gate_action: next.gate.action,
    resource_ref: next.gate.resource_ref,
    updated_at: timestamp,
  }, file);
  printJson({ ok: true, action: "waitpoints release", path: rel(file), waitpoint: next, decision_ref: decisionRef });
}

function transitionWaitpoint(status) {
  const gate = requireGate(status === "expired" ? ["owner", "mission"] : ["owner", "mission", "user"]);
  const payload = parsePayload();
  const waitpointId = prefixedId(option("--waitpoint-id", payload.waitpoint_id), "WP");
  const file = waitpointFile(waitpointId);
  const existing = readJson(file);
  if (!existing) fail("waitpoint_not_found", waitpointId, 1);
  if (!["pending", "blocked"].includes(existing.status)) fail("waitpoint_not_transitionable", existing.status, 1);
  const ownerWorkflow = option("--owner-workflow", payload.owner_workflow);
  if (gate === "owner" && (!ownerWorkflow || ownerWorkflow !== existing.owner_workflow)) fail("waitpoint_owner_mismatch", waitpointId, 1);
  if (status === "expired") {
    const expiresAt = Date.parse(existing.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) fail("waitpoint_not_expired", waitpointId, 1);
  }
  const timestamp = nowIso();
  const next = {
    ...existing,
    status,
    reason: option("--reason", payload.reason || existing.reason),
    updated_at: timestamp,
  };
  writeJson(file, next);
  updateIndex("waitpoints", "waitpoints", "waitpoint_id", {
    waitpoint_id: waitpointId,
    status,
    owner_workflow: next.owner_workflow,
    decision_id: next.decision_id,
    gate_action: next.gate.action,
    resource_ref: next.gate.resource_ref,
    updated_at: timestamp,
  }, file);
  printJson({ ok: true, action: `waitpoints ${status}`, path: rel(file), waitpoint: next });
}

function main() {
  const [command, query] = args;
  if (command === "query" && query === "dashboard-state") {
    printJson(queryDashboardState());
    return;
  }
  if (command === "query" && query === "runs") {
    printJson(queryRuns());
    return;
  }
  if (command === "query" && query === "queues") {
    printJson(queryQueues());
    return;
  }
  if (command === "query" && query === "sessions") {
    printJson(querySessions());
    return;
  }
  if (command === "query" && query === "inbox") {
    printJson(queryInbox());
    return;
  }
  if (command === "query" && query === "decisions") {
    printJson(queryDecisions());
    return;
  }
  if (command === "query" && query === "waitpoints") {
    printJson(queryWaitpoints());
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
  if (command === "queues" && query === "upsert") {
    upsertQueue();
    return;
  }
  if (command === "queues" && query === "item") {
    updateQueueItem();
    return;
  }
  if (command === "sessions" && query === "open") {
    openSession();
    return;
  }
  if (command === "sessions" && query === "heartbeat") {
    heartbeatSession();
    return;
  }
  if (command === "sessions" && query === "pause") {
    transitionSession("paused");
    return;
  }
  if (command === "sessions" && query === "close") {
    transitionSession("closed");
    return;
  }
  if (command === "inbox" && query === "send") {
    sendInboxMessage();
    return;
  }
  if (command === "inbox" && query === "transition") {
    transitionInboxMessage();
    return;
  }
  if (command === "decisions" && query === "request") {
    requestDecision();
    return;
  }
  if (command === "decisions" && query === "resolve") {
    resolveDecision();
    return;
  }
  if (command === "decisions" && query === "supersede") {
    supersedeDecision();
    return;
  }
  if (command === "waitpoints" && query === "create") {
    createWaitpoint();
    return;
  }
  if (command === "waitpoints" && query === "release") {
    releaseWaitpoint();
    return;
  }
  if (command === "waitpoints" && query === "cancel") {
    transitionWaitpoint("canceled");
    return;
  }
  if (command === "waitpoints" && query === "expire") {
    transitionWaitpoint("expired");
    return;
  }

  printJson({
    ok: false,
    error: "unsupported_command",
    usage: "node .agent/skills/management-api/scripts/index.js query dashboard-state|runs|queues|sessions|inbox|decisions|waitpoints | runs upsert|event|checkpoint | queues upsert|item | sessions open|heartbeat|pause|close | inbox send|transition | decisions request|resolve|supersede | waitpoints create|release|cancel|expire",
  });
  process.exitCode = 2;
}

main();
