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

function parseTasks() {
  const file = path.join(agentRoot, "plans", "task-progress.md");
  const text = read(file);
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
      title: line.replace(/^\s*[-*]\s*/, "").slice(0, 180),
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
  return listFiles(dir, (name) => name.endsWith(".md") || name.endsWith(".json"))
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

function deriveState({ worktrees, locks, handoffs, tasks }) {
  const nonMainWorktrees = worktrees.filter((w) => w.path && path.resolve(w.path) !== root);
  const dirty = worktrees.some((w) => w.dirty);
  const heldLocks = locks.filter((l) => !l.expired);
  const blockedTasks = tasks.filter((t) => t.status === "blocked");
  const activeTasks = tasks.filter((t) => t.status === "active" || t.status === "open");

  if (blockedTasks.length) {
    return {
      state: "blocked",
      next: "先处理阻塞任务，必要时创建 /handoff 或回到 /plan 重新拆分。",
    };
  }
  if (!nonMainWorktrees.length) {
    return {
      state: "idle",
      next: activeTasks.length
        ? `/worktree plan ${activeTasks.slice(0, 3).map((t) => t.id).join(" ")}`
        : "/plan <大需求> 或 /briefing",
    };
  }
  if (handoffs.length && !heldLocks.length) {
    return {
      state: "handoff_required",
      next: "/handoff resume <handoff>，恢复后重新获取 lock。",
    };
  }
  if (dirty) {
    return {
      state: "in_progress",
      next: "继续当前 worktree 任务；达到可验证点后运行 /worktree commit <task-id>。",
    };
  }
  if (heldLocks.length) {
    return {
      state: "merge_ready",
      next: "/worktree merge <task-id>，合并后立即 /worktree validate <task-id>。",
    };
  }
  return {
    state: "planned",
    next: "/worktree status 或 /start-task <task-id>，开始前获取 task/file lock。",
  };
}

function pill(value) {
  const cls = String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `<span class="pill ${cls}">${esc(value || "unknown")}</span>`;
}

function renderTable(headers, rows) {
  if (!rows.length) return `<div class="empty">暂无数据</div>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function main() {
  const tasks = parseTasks();
  const worktrees = parseWorktrees();
  const agents = parseRegistry();
  const locks = parseLocks();
  const handoffs = parseHandoffs();
  const artifacts = parseArtifacts();
  const gitStatus = sh("git status --short --branch");
  const derived = deriveState({ worktrees, locks, handoffs, tasks });
  const generatedAt = new Date().toISOString();

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Dashboard</title>
<style>
:root{color-scheme:light dark;--bg:#0f1115;--panel:#171a21;--text:#e6e9ef;--muted:#9aa4b2;--line:#2a2f3a;--accent:#65a8ff;--ok:#58d68d;--warn:#f5b041;--bad:#ff6b6b}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{padding:24px 28px;border-bottom:1px solid var(--line);background:#12151b}
h1{margin:0 0 6px;font-size:24px}
h2{margin:0 0 12px;font-size:16px}
.muted{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px;padding:18px 28px}
.card{grid-column:span 6;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;min-width:0}
.wide{grid-column:span 12}.third{grid-column:span 4}
.stat{font-size:28px;font-weight:700}.next{font-size:16px;color:var(--accent)}
table{width:100%;border-collapse:collapse}th,td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}th{color:var(--muted);font-weight:600}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#d9e7ff}.empty{color:var(--muted);padding:10px 0}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted)}
.done,.ready,.validated{color:var(--ok);border-color:rgba(88,214,141,.45)}.blocked,.validation_failed{color:var(--bad);border-color:rgba(255,107,107,.45)}
.active,.in_progress,.merge_ready,.handoff_required{color:var(--warn);border-color:rgba(245,176,65,.45)}
pre{white-space:pre-wrap;background:#0d1016;border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto}
@media(max-width:900px){.card,.third{grid-column:span 12}.grid{padding:14px}}
</style>
</head>
<body>
<header>
  <h1>Agent Dashboard</h1>
  <div class="muted">${esc(path.basename(root))} · ${esc(generatedAt)}</div>
</header>
<main class="grid">
  <section class="card third"><h2>Worktree State</h2><div class="stat">${pill(derived.state)}</div></section>
  <section class="card third"><h2>Active Tasks</h2><div class="stat">${tasks.filter((t) => t.status !== "done").length}</div></section>
  <section class="card third"><h2>Held Locks</h2><div class="stat">${locks.filter((l) => !l.expired).length}</div></section>
  <section class="card wide"><h2>Recommended Next Action</h2><div class="next"><code>${esc(derived.next)}</code></div></section>
  <section class="card wide"><h2>Git Status</h2><pre>${esc(gitStatus || "clean or unavailable")}</pre></section>
  <section class="card wide"><h2>Tasks</h2>${renderTable(["ID","Status","Title"], tasks.map((t) => `<tr><td><code>${esc(t.id)}</code></td><td>${pill(t.status)}</td><td>${esc(t.title)}</td></tr>`))}</section>
  <section class="card wide"><h2>Worktrees</h2>${renderTable(["Path","Branch","Dirty","HEAD"], worktrees.map((w) => `<tr><td><code>${esc(w.path)}</code></td><td>${esc(w.branch)}</td><td>${pill(w.dirty ? "dirty" : "clean")}</td><td><code>${esc(w.head.slice(0,12))}</code></td></tr>`))}</section>
  <section class="card"><h2>Active Agents</h2>${renderTable(["Agent","Role","Task","Status"], agents.map((a) => `<tr><td>${esc(a.agent_id || a.id)}</td><td>${esc(a.role)}</td><td><code>${esc(a.task_id || "")}</code></td><td>${pill(a.status)}</td></tr>`))}</section>
  <section class="card"><h2>Locks</h2>${renderTable(["Scope","Held By","Expires","State"], locks.map((l) => `<tr><td><code>${esc(l.scope)}</code></td><td>${esc(l.held_by)}</td><td>${esc(l.expires_at)}</td><td>${pill(l.expired ? "expired" : "held")}</td></tr>`))}</section>
  <section class="card"><h2>Handoffs</h2>${renderTable(["Path","Type","Updated"], handoffs.map((h) => `<tr><td><code>${esc(h.path)}</code></td><td>${esc(h.type)}</td><td>${esc(h.updated)}</td></tr>`))}</section>
  <section class="card"><h2>Artifacts</h2>${renderTable(["Task","Count","Latest"], artifacts.map((a) => `<tr><td><code>${esc(a.task_id)}</code></td><td>${a.count}</td><td><code>${esc(a.latest)}</code></td></tr>`))}</section>
</main>
</body>
</html>`;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, "utf8");
  console.log(JSON.stringify({ ok: true, output: path.relative(root, outPath), state: derived.state, next_action: derived.next }, null, 2));
}

main();
