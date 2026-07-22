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
const { spawnSync } = require("child_process");

const AGENT_ROOT = path.join(process.cwd(), ".agent");
const RUNS_DIR = path.join(AGENT_ROOT, "runs");
const CONTEXT_HOME = path.join(os.homedir(), ".agent", "contexts");

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
function archiveProject(project, note) {
  const dir = path.join(CONTEXT_HOME, project);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = ts();
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
    note?.done || "_(由主 Agent 填写)_",
    "",
    "## 🚧 进行中（卡点）",
    "",
    note?.blocked || "_(由主 Agent 填写)_",
    "",
    "## 📌 后续待开始",
    "",
    note?.next || "_(由主 Agent 填写)_",
    "",
    "## 🔑 关键决策",
    "",
    "| 决策 | 结论 | 理由 |",
    "| --- | --- | --- |",
    "|  |  |  |",
    "",
    "## ⚠️ 注意事项 & 踩坑记录",
    "",
    note?.pitfalls || "_(由主 Agent 填写)_",
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
  return { archivePath: file, latestPath: latest, stamp };
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

// ─── Mode 4 — status ─────────────────────────────────────────────────────────
function statusReport(project) {
  const dir = path.join(CONTEXT_HOME, project);
  if (!fs.existsSync(dir)) {
    return { ok: true, action: "status", project, exists: false };
  }
  const entries = listContexts(project);
  if (!entries.length) return { ok: true, action: "status", project, exists: true, count: 0 };
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

  if (mode === "assess") {
    requireGate([...GATES_TIGHT]);
    const desc = flag("--task-description", argv) || "";
    const out = assessBudget(desc);
    emit({ ok: true, action: "assess", task_words: desc.trim().split(/\s+/).filter(Boolean).length, ...out });
    return;
  }

  if (mode === "warm") {
    // warm is advisory only — emits a prompt string, no side effects.  No
    // gate required; hosts can call it freely.
    emit(warmPrompt());
    return;
  }

  const project = flag("--project", argv);
  if (!project) fail("missing_project", "--project is required.");

  if (mode === "archive") {
    requireGate([...GATES_DESTRUCTIVE]);
    const note = parseNote(argv);
    const stamp = ts();
    let archived;
    try {
      archived = archiveProject(project, note);
    } catch (err) {
      fail("archive_failed", err.message);
      return;
    }
    appendRunEvent({
      type: "session_archived",
      project,
      archive_path: archived.archivePath,
    });
    emit({ ok: true, action: "archive", project, ...archived });
    return;
  }

  if (mode === "restore") {
    const wantList = argv.includes("--list");
    if (!wantList) requireGate([...GATES_TIGHT]);
    emit(loadContext(project, wantList ? "list" : "load"));
    if (!wantList) appendRunEvent({ type: "session_restored", project });
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
    "Usage: runtime-continuity {assess|archive|restore|status|warm} [--project P] [--gate user] ...",
  );
}

if (require.main === module) main();
module.exports = {
  assessBudget,
  archiveProject,
  listContexts,
  resolveLatest,
  loadContext,
  statusReport,
  warmPrompt,
  findActiveRunId,
};
