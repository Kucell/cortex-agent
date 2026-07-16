#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = process.cwd();
const agentRoot = path.join(root, ".agent");

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || !process.argv[idx + 1]) return fallback;
  return process.argv[idx + 1];
}

const outPath = path.resolve(root, arg("--out", ".agent/metrics/agent-dashboard.html"));

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

function queryManagementDashboardState() {
  const script = path.join(agentRoot, "skills", "management-api", "scripts", "index.js");
  if (!fs.existsSync(script)) return null;
  try {
    const raw = execSync(`node ${JSON.stringify(script)} query dashboard-state`, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const data = JSON.parse(raw);
    return data && data.ok ? data : null;
  } catch {
    return null;
  }
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

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

const I18N = {
  zh: {
    appTitle: "Agent 协作看板",
    subtitle: "任务、worktree、handoff、锁与多 Agent 状态",
    langLabel: "语言",
    generated: "生成时间",
    worktreeState: "Worktree 状态",
    activeTasks: "活跃任务",
    heldLocks: "持有锁",
    activeAgents: "活跃 Agent",
    nextAction: "推荐下一步",
    progressMap: "进度地图",
    kanban: "任务看板",
    collaboration: "协作现场",
    worktrees: "Worktrees",
    locks: "Locks",
    handoffs: "Handoffs",
    artifacts: "Artifacts",
    runs: "Runs",
    queues: "Queues",
    sessions: "Sessions",
    currentActivity: "当前活动",
    phase: "阶段",
    event: "事件",
    message: "消息",
    gitStatus: "Git 状态",
    stateWhy: "状态判断",
    empty: "暂无数据",
    clean: "干净",
    dirty: "有改动",
    path: "路径",
    branch: "分支",
    head: "HEAD",
    id: "ID",
    status: "状态",
    title: "标题",
    agent: "Agent",
    role: "角色",
    task: "任务",
    scope: "范围",
    heldBy: "持有者",
    expires: "过期时间",
    type: "类型",
    updated: "更新时间",
    count: "数量",
    latest: "最新产物",
    kind: "类型",
    started: "开始时间",
    heartbeat: "心跳",
    items: "条目",
    open: "打开",
    active: "进行中",
    done: "已完成",
    blocked: "阻塞",
    mainlineValidation: "主线验证",
    noGit: "干净或不可用",
    copied: "已复制",
  },
  en: {
    appTitle: "Agent Collaboration Dashboard",
    subtitle: "Tasks, worktrees, handoffs, locks, and multi-agent state",
    langLabel: "Language",
    generated: "Generated",
    worktreeState: "Worktree State",
    activeTasks: "Active Tasks",
    heldLocks: "Held Locks",
    activeAgents: "Active Agents",
    nextAction: "Recommended Next Action",
    progressMap: "Progress Map",
    kanban: "Task Board",
    collaboration: "Collaboration Scene",
    worktrees: "Worktrees",
    locks: "Locks",
    handoffs: "Handoffs",
    artifacts: "Artifacts",
    runs: "Runs",
    queues: "Queues",
    sessions: "Sessions",
    currentActivity: "Current Activity",
    phase: "Phase",
    event: "Event",
    message: "Message",
    gitStatus: "Git Status",
    stateWhy: "State Reasoning",
    empty: "No data",
    clean: "clean",
    dirty: "dirty",
    path: "Path",
    branch: "Branch",
    head: "HEAD",
    id: "ID",
    status: "Status",
    title: "Title",
    agent: "Agent",
    role: "Role",
    task: "Task",
    scope: "Scope",
    heldBy: "Held By",
    expires: "Expires",
    type: "Type",
    updated: "Updated",
    count: "Count",
    latest: "Latest",
    kind: "Kind",
    started: "Started",
    heartbeat: "Heartbeat",
    items: "Items",
    open: "Open",
    active: "Active",
    done: "Done",
    blocked: "Blocked",
    mainlineValidation: "Mainline Validation",
    noGit: "clean or unavailable",
    copied: "Copied",
  },
};

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

function deriveState({ worktrees, locks, handoffs, tasks, agents }) {
  const nonMainWorktrees = worktrees.filter((w) => !w.isMain);
  const dirty = worktrees.some((w) => w.dirty);
  const heldLocks = locks.filter((l) => !l.expired);
  const blockedTasks = tasks.filter((t) => t.status === "blocked");
  const activeTasks = tasks.filter((t) => t.status === "active" || t.status === "open");
  const activeAgents = agents.filter((a) => ["running", "active", "paused"].includes(a.status));

  if (blockedTasks.length) {
    return {
      state: "blocked",
      next: "先处理阻塞任务，必要时创建 /handoff 或回到 /plan 重新拆分。",
      nextEn: "Resolve blocked tasks first. Create /handoff or return to /plan if needed.",
      why: `发现 ${blockedTasks.length} 个阻塞任务。`,
      whyEn: `${blockedTasks.length} blocked task(s) detected.`,
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

function pill(value) {
  const cls = String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `<span class="pill ${cls}">${esc(value || "unknown")}</span>`;
}

function renderTable(headers, rows, emptyKey = "empty") {
  if (!rows.length) return `<div class="empty" data-i18n="${emptyKey}">${esc(I18N.zh[emptyKey])}</div>`;
  return `<table><thead><tr>${headers.map((h) => `<th data-i18n="${esc(h)}">${esc(I18N.zh[h] || h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function taskColumn(tasks, status, labelKey) {
  const items = tasks.filter((task) => task.status === status);
  return `<section class="lane">
    <h3 data-i18n="${labelKey}">${esc(I18N.zh[labelKey])}</h3>
    ${items.length ? items.map((task) => `<article class="task-card"><strong>${esc(task.id)}</strong><p>${esc(task.title)}</p><p class="mini">${[task.priority, task.progress, task.plan].filter(Boolean).map(esc).join(" · ")}</p></article>`).join("") : `<div class="empty" data-i18n="empty">${I18N.zh.empty}</div>`}
  </section>`;
}

function main() {
  const managed = queryManagementDashboardState();
  const tasks = managed?.tasks || parseTasks();
  const worktrees = managed?.worktrees || parseWorktrees();
  const agents = managed?.agents || parseRegistry();
  const locks = managed?.locks || parseLocks();
  const handoffs = managed?.handoffs || parseHandoffs();
  const artifacts = managed?.artifacts || parseArtifacts();
  const runs = Array.isArray(managed?.runs) ? managed.runs : [];
  const queues = Array.isArray(managed?.queues) ? managed.queues : [];
  const sessions = Array.isArray(managed?.sessions) ? managed.sessions : [];
  const gitStatus = typeof managed?.git_status === "string" ? managed.git_status : sh("git status --short --branch");
  const derived = managed?.derived || deriveState({ worktrees, locks, handoffs, tasks, agents });
  const generatedAt = new Date().toISOString();
  const activeTaskCount = tasks.filter((t) => t.status !== "done").length;
  const heldLockCount = locks.filter((l) => !l.expired).length;
  const nonMainWorktreeCount = worktrees.filter((w) => !w.isMain).length;
  const runningRuns = runs.filter((r) => r.status === "running");
  const currentActivity = runningRuns[0]?.activity || runningRuns[0]?.last_event?.message || derived.next || "";

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Dashboard</title>
<style>
:root{color-scheme:light dark;--bg:#0f1115;--panel:#171a21;--panel2:#11141a;--text:#e6e9ef;--muted:#9aa4b2;--line:#2a2f3a;--accent:#65a8ff;--ok:#58d68d;--warn:#f5b041;--bad:#ff6b6b}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{padding:22px 28px;border-bottom:1px solid var(--line);background:#12151b;display:flex;justify-content:space-between;gap:18px;align-items:flex-start}
h1{margin:0 0 6px;font-size:24px}h2{margin:0 0 12px;font-size:16px}h3{margin:0 0 10px;font-size:14px;color:var(--muted)}
.muted{color:var(--muted)}.toolbar{display:flex;align-items:center;gap:8px}.toolbar button{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:6px 10px;cursor:pointer}.toolbar button.active{border-color:var(--accent);color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px;padding:18px 28px}.card{grid-column:span 6;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;min-width:0}.wide{grid-column:span 12}.third{grid-column:span 4}
.stat{font-size:28px;font-weight:700}.next{font-size:16px;color:var(--accent)}.reason{margin-top:8px;color:var(--muted)}
.progress{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}.step{background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:10px}.step.active{border-color:var(--accent)}.step strong{display:block;margin-bottom:3px}
.lanes{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.lane{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:12px}.task-card{border:1px solid var(--line);border-radius:7px;padding:10px;margin-bottom:8px;background:#0d1016}.task-card p{margin:4px 0 0;color:var(--muted)}
table{width:100%;border-collapse:collapse}th,td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}th{color:var(--muted);font-weight:600}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#d9e7ff}.empty{color:var(--muted);padding:10px 0}.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted)}.done,.ready,.validated,.clean{color:var(--ok);border-color:rgba(88,214,141,.45)}.blocked,.validation_failed,.dirty{color:var(--bad);border-color:rgba(255,107,107,.45)}.active,.in_progress,.merge_ready,.handoff_required,.held{color:var(--warn);border-color:rgba(245,176,65,.45)}
pre{white-space:pre-wrap;background:#0d1016;border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto;max-height:260px}.mini{font-size:12px;color:var(--muted)}
@media(max-width:1000px){.card,.third{grid-column:span 12}.lanes,.progress{grid-template-columns:1fr}.grid{padding:14px}header{display:block}.toolbar{margin-top:12px}}
</style>
</head>
<body>
<header>
  <div>
    <h1 data-i18n="appTitle">${I18N.zh.appTitle}</h1>
    <div class="muted"><span data-i18n="subtitle">${I18N.zh.subtitle}</span> · ${esc(path.basename(root))}</div>
    <div class="mini"><span data-i18n="generated">${I18N.zh.generated}</span>: ${esc(generatedAt)}</div>
  </div>
  <div class="toolbar" aria-label="language switcher">
    <span class="muted" data-i18n="langLabel">${I18N.zh.langLabel}</span>
    <button type="button" data-lang="zh" class="active">中文</button>
    <button type="button" data-lang="en">EN</button>
  </div>
</header>
<main class="grid">
  <section class="card third"><h2 data-i18n="worktreeState">${I18N.zh.worktreeState}</h2><div class="stat">${pill(derived.state)}</div></section>
  <section class="card third"><h2 data-i18n="activeTasks">${I18N.zh.activeTasks}</h2><div class="stat">${activeTaskCount}</div></section>
  <section class="card third"><h2 data-i18n="heldLocks">${I18N.zh.heldLocks}</h2><div class="stat">${heldLockCount}</div></section>
  <section class="card wide"><h2 data-i18n="currentActivity">${I18N.zh.currentActivity}</h2><div class="next">${esc(currentActivity || I18N.zh.empty)}</div>${runningRuns[0]?.phase ? `<div class="reason"><span data-i18n="phase">${I18N.zh.phase}</span>: ${pill(runningRuns[0].phase)}</div>` : ""}</section>
  <section class="card wide"><h2 data-i18n="nextAction">${I18N.zh.nextAction}</h2><div class="next"><code data-next-zh="${esc(derived.next)}" data-next-en="${esc(derived.nextEn)}">${esc(derived.next)}</code></div><div class="reason" data-why-zh="${esc(derived.why)}" data-why-en="${esc(derived.whyEn)}">${esc(derived.why)}</div></section>
  <section class="card wide"><h2 data-i18n="progressMap">${I18N.zh.progressMap}</h2><div class="progress">
    <div class="step ${derived.state === "idle" ? "active" : ""}"><strong>1. Plan</strong><span>/plan · /worktree plan</span></div>
    <div class="step ${["planned","worktree_created"].includes(derived.state) ? "active" : ""}"><strong>2. Dispatch</strong><span>/worktree create · locks</span></div>
    <div class="step ${derived.state === "in_progress" ? "active" : ""}"><strong>3. Build</strong><span>/start-task · /parallel</span></div>
    <div class="step ${["merge_ready","merged"].includes(derived.state) ? "active" : ""}"><strong>4. Merge</strong><span>/ship · /worktree merge</span></div>
    <div class="step ${["validated","closed"].includes(derived.state) ? "active" : ""}"><strong>5. Validate</strong><span>/worktree validate · /update-refs</span></div>
  </div></section>
  <section class="card wide"><h2 data-i18n="kanban">${I18N.zh.kanban}</h2><div class="lanes">${taskColumn(tasks, "open", "open")}${taskColumn(tasks, "active", "active")}${taskColumn(tasks, "blocked", "blocked")}${taskColumn(tasks, "done", "done")}</div></section>
  <section class="card wide"><h2 data-i18n="worktrees">${I18N.zh.worktrees}</h2>${renderTable(["path","branch","status","head"], worktrees.map((w) => `<tr><td><code>${esc(w.path)}</code>${w.isMain ? ' <span class="mini">main</span>' : ""}</td><td>${esc(w.branch)}</td><td>${pill(w.dirty ? "dirty" : "clean")}</td><td><code>${esc(w.head.slice(0,12))}</code></td></tr>`))}</section>
  <section class="card"><h2 data-i18n="activeAgents">${I18N.zh.activeAgents}</h2>${renderTable(["agent","role","task","status"], agents.map((a) => `<tr><td>${esc(a.agent_id || a.id)}</td><td>${esc(a.role)}</td><td><code>${esc(a.task_id || "")}</code></td><td>${pill(a.status)}</td></tr>`))}</section>
  <section class="card"><h2 data-i18n="locks">${I18N.zh.locks}</h2>${renderTable(["scope","heldBy","expires","status"], locks.map((l) => `<tr><td><code>${esc(l.scope)}</code></td><td>${esc(l.held_by)}</td><td>${esc(l.expires_at)}</td><td>${pill(l.expired ? "expired" : "held")}</td></tr>`))}</section>
  <section class="card"><h2 data-i18n="handoffs">${I18N.zh.handoffs}</h2>${renderTable(["path","type","updated"], handoffs.map((h) => `<tr><td><code>${esc(h.path)}</code></td><td>${esc(h.type)}</td><td>${esc(h.updated)}</td></tr>`))}</section>
  <section class="card"><h2 data-i18n="artifacts">${I18N.zh.artifacts}</h2>${renderTable(["task","count","latest"], artifacts.map((a) => `<tr><td><code>${esc(a.task_id)}</code></td><td>${a.count}</td><td><code>${esc(a.latest)}</code></td></tr>`))}</section>
  <section class="card"><h2 data-i18n="sessions">${I18N.zh.sessions}</h2>${renderTable(["agent","role","status","phase","heartbeat"], sessions.map((s) => `<tr><td>${esc(s.agent_id || s.session_id)}</td><td>${esc(s.role || "")}</td><td>${pill(s.status)}</td><td>${s.phase ? pill(s.phase) : esc(s.activity || "")}</td><td>${esc(s.last_heartbeat_at || s.started_at || "")}</td></tr>`))}</section>
  <section class="card"><h2 data-i18n="runs">${I18N.zh.runs}</h2>${renderTable(["id","kind","status","phase","message"], runs.slice(0, 8).map((r) => `<tr><td><code>${esc(r.run_id || r.path)}</code></td><td>${esc(r.kind || "")}</td><td>${pill(r.status)}</td><td>${r.phase ? pill(r.phase) : ""}</td><td>${esc(r.activity || r.last_event?.message || "")}</td></tr>`))}</section>
  <section class="card wide"><h2 data-i18n="queues">${I18N.zh.queues}</h2>${renderTable(["id","status","items","currentActivity"], queues.map((q) => `<tr><td><code>${esc(q.queue_id || q.path)}</code></td><td>${pill(q.status)}</td><td>${Array.isArray(q.items) ? q.items.length : 0}</td><td>${esc((q.items || []).find((item) => item.state === "running")?.activity || "")}</td></tr>`))}</section>
  <section class="card wide"><h2 data-i18n="event">${I18N.zh.event}</h2>${renderTable(["id","phase","status","message"], runs.flatMap((r) => (Array.isArray(r.events) ? r.events.slice(-3).reverse().map((event) => ({ run: r, event })) : [])).slice(0, 12).map(({ run, event }) => `<tr><td><code>${esc(run.run_id || run.path)}</code></td><td>${event.phase ? pill(event.phase) : ""}</td><td>${event.status ? pill(event.status) : ""}</td><td>${esc(event.message || event.activity || event.type || "")}<div class="mini">${esc(event.at || "")}</div></td></tr>`))}</section>
  <section class="card wide"><h2 data-i18n="gitStatus">${I18N.zh.gitStatus}</h2><pre>${esc(gitStatus || I18N.zh.noGit)}</pre></section>
</main>
<script>
const i18n = ${JSON.stringify(I18N)};
function applyLang(lang) {
  const dict = i18n[lang] || i18n.zh;
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.getAttribute('data-i18n');
    if (dict[key]) node.textContent = dict[key];
  });
  document.querySelectorAll('[data-lang]').forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-lang') === lang));
  const next = document.querySelector('[data-next-zh]');
  if (next) next.textContent = lang === 'en' ? next.getAttribute('data-next-en') : next.getAttribute('data-next-zh');
  const why = document.querySelector('[data-why-zh]');
  if (why) why.textContent = lang === 'en' ? why.getAttribute('data-why-en') : why.getAttribute('data-why-zh');
  localStorage.setItem('agent-dashboard-lang', lang);
}
document.querySelectorAll('[data-lang]').forEach((btn) => btn.addEventListener('click', () => applyLang(btn.getAttribute('data-lang'))));
applyLang(localStorage.getItem('agent-dashboard-lang') || 'zh');
</script>
</body>
</html>`;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, "utf8");
  console.log(JSON.stringify({
    ok: true,
    output: path.relative(root, outPath),
    state: derived.state,
    next_action: derived.next,
    worktrees: nonMainWorktreeCount,
    active_tasks: activeTaskCount,
    held_locks: heldLockCount,
  }, null, 2));
}

main();
