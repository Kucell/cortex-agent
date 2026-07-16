#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = process.cwd();
const agentRoot = path.join(root, ".agent");
const args = process.argv.slice(2);

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

function queryDashboardState() {
  const tasks = parseTasks();
  const worktrees = parseWorktrees();
  const agents = parseRegistry();
  const locks = parseLocks();
  const handoffs = parseHandoffs();
  const artifacts = parseArtifacts();
  const gitStatus = sh("git status --short --branch");
  const derived = deriveState({ worktrees, locks, handoffs, tasks, agents });

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
    locks,
    handoffs,
    artifacts,
    git_status: gitStatus,
    derived,
    summary: {
      active_tasks: tasks.filter((t) => t.status !== "done").length,
      held_locks: locks.filter((l) => !l.expired).length,
      non_main_worktrees: worktrees.filter((w) => !w.isMain).length,
    },
  };
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function main() {
  const [command, query] = args;
  if (command === "query" && query === "dashboard-state") {
    printJson(queryDashboardState());
    return;
  }

  printJson({
    ok: false,
    error: "unsupported_command",
    usage: "node .agent/skills/management-api/scripts/index.js query dashboard-state",
  });
  process.exitCode = 2;
}

main();
