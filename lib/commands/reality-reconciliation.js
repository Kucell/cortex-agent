#!/usr/bin/env node
"use strict";

// Reality Reconciliation Gate
// 对比 Git 地面真值与 .agent 运行态记录，发现"现实有活动、运行态为空"的脱节。
// 只读 Git 与文件系统；repair_plan 只给人工补建建议，绝不自动生成或回填伪造的历史事件。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPORT_PATH = ".agent/metrics/reality-reconciliation-report.json";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function runGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, stdout: "", stderr: (result.stderr || "").trim() };
  }
  return { ok: true, stdout: result.stdout.trim(), stderr: "" };
}

// 读取 JSON 索引文件；文件缺失或解析失败一律记为 empty，不抛出异常。
function readIndex(root, relPath, listKeys) {
  const abs = path.join(root, relPath);
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    data = null;
  }
  for (const key of listKeys) {
    if (Array.isArray(data?.[key])) {
      return { count: data[key].length, items: data[key], missing: false };
    }
  }
  return { count: 0, items: [], missing: data === null };
}

// 采集 Git 地面真值（全部只读命令）。
function collectGitReality(root) {
  const reality = {
    worktree_count: 0,
    extra_worktrees: [],
    extra_worktrees_recent: [],
    agent_branches: [],
    agent_branches_recent: [],
    main_worktree_dirty: false,
    last_commit_at: null,
    errors: [],
  };

  const worktrees = runGit(root, ["worktree", "list", "--porcelain"]);
  if (worktrees.ok) {
    const entries = [];
    let current = null;
    for (const line of worktrees.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        current = { path: line.slice("worktree ".length), branch: null };
        entries.push(current);
      } else if (current && line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      }
    }
    reality.worktree_count = entries.length;
    // 第一条即主 worktree，其余视为活跃并行工作区。
    // 区分全部 extra_worktrees 与近期有 HEAD commit (7 天内) 的 worktree：
    // RR-001 只对近期活跃的 worktree 报错，识别为“现实有持续活动，运行态为空”。
    // 历史开发残留（HEAD > 7 天）不应触发 RR-001。
    const nowMs = Date.now();
    reality.extra_worktrees = entries
      .slice(1)
      .map((e) => {
        const headRes = runGit(root, [
          "-C",
          e.path,
          "log",
          "-1",
          "--format=%ct",
        ]);
        const headEpochSec = headRes.ok && headRes.stdout ? Number(headRes.stdout) : 0;
        const headAgeDays =
          headEpochSec > 0 ? (nowMs / 1000 - headEpochSec) / 86400 : Infinity;
        return { path: e.path, branch: e.branch, head_age_days: headAgeDays };
      });
    reality.extra_worktrees_recent = reality.extra_worktrees.filter(
      (e) => e.head_age_days !== Infinity && e.head_age_days <= 7
    );
  } else {
    reality.errors.push(`git worktree list 失败: ${worktrees.stderr}`);
  }

  const branches = runGit(root, ["branch", "--list", "agent/*"]);
  if (branches.ok) {
    const branchNames = branches.stdout
      .split("\n")
      .map((line) => line.replace(/^[*+\s]+/, "").trim())
      .filter(Boolean);
    // 同时记录全部与近期活跃 (HEAD <= 7 天) 的 agent 分支。
    // 仅最近 7 天有 HEAD commit 的分支视为活跃；其余归为历史开发残留。
    const nowMsLocal = Date.now();
    reality.agent_branches = branchNames.map((branch) => {
      const headRes = runGit(root, ["log", "-1", "--format=%ct", branch]);
      const headEpochSec = headRes.ok && headRes.stdout ? Number(headRes.stdout) : 0;
      const headAgeDays =
        headEpochSec > 0 ? (nowMsLocal / 1000 - headEpochSec) / 86400 : Infinity;
      return { branch, head_age_days: headAgeDays };
    });
    reality.agent_branches_recent = reality.agent_branches
      .filter((b) => b.head_age_days !== Infinity && b.head_age_days <= 7)
      .map((b) => b.branch);
  } else {
    reality.errors.push(`git branch --list 失败: ${branches.stderr}`);
  }

  const status = runGit(root, ["status", "--porcelain"]);
  if (status.ok) {
    reality.main_worktree_dirty = status.stdout.length > 0;
  } else {
    reality.errors.push(`git status 失败: ${status.stderr}`);
  }

  const lastCommit = runGit(root, ["log", "-1", "--format=%ci"]);
  if (lastCommit.ok && lastCommit.stdout) {
    const parsed = new Date(lastCommit.stdout);
    reality.last_commit_at = Number.isNaN(parsed.getTime())
      ? null
      : parsed.toISOString();
  } else {
    reality.errors.push(`git log -1 失败: ${lastCommit.stderr || "无提交记录"}`);
  }

  return reality;
}

// 读取 .agent 运行态索引，返回各面计数。
function readRuntimeState(root) {
  const runs = readIndex(root, ".agent/runs/index.json", ["runs"]);
  const sessions = readIndex(root, ".agent/sessions/index.json", ["sessions"]);
  const queues = readIndex(root, ".agent/queues/index.json", ["queues"]);
  const decisions = readIndex(root, ".agent/decisions/index.json", ["decisions"]);
  const waitpoints = readIndex(root, ".agent/waitpoints/index.json", ["waitpoints"]);
  const inbox = readIndex(root, ".agent/inbox/index.json", ["messages"]);

  const registry = readIndex(root, ".agent/registry/agents.json", ["agents"]);
  // 仅统计未过期 agent；已 expired 的历史 agent 不算活跃。
  const activeAgents = registry.items.filter(
    (agent) => agent && agent.status && agent.status !== "expired"
  );

  const locks = readIndex(root, ".agent/locks/lock-events.json", ["events"]);
  const lastLockEventAt = locks.items.reduce((latest, event) => {
    const ts = event?.timestamp ? new Date(event.timestamp) : null;
    if (!ts || Number.isNaN(ts.getTime())) return latest;
    return !latest || ts > latest ? ts : latest;
  }, null);

  // workspaces 运行记录：统计真实运行记录，需与 workspaces/scripts/workspace-runtime.js
  // 的写入契约对齐。该脚本将 identity/lease/composite 记录写入
  // .agent/workspaces/state/{identities,leases,composites}/*.json，而历史/兼容记录可能
  // 直接位于 .agent/workspaces 顶层。两处都要计入,否则按规范创建的记录无法消除 RR-002。
  const countJsonRecords = (dir) => {
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".json") && !name.endsWith(".schema.json")).length;
    } catch {
      return 0;
    }
  };
  const workspacesRoot = path.join(root, ".agent/workspaces");
  const workspaceStateRoot = path.join(workspacesRoot, "state");
  const workspaceRecords =
    countJsonRecords(workspacesRoot) +
    countJsonRecords(path.join(workspaceStateRoot, "identities")) +
    countJsonRecords(path.join(workspaceStateRoot, "leases")) +
    countJsonRecords(path.join(workspaceStateRoot, "composites"));

  return {
    runs: runs.count,
    sessions: sessions.count,
    queues: queues.count,
    decisions: decisions.count,
    waitpoints: waitpoints.count,
    inbox_messages: inbox.count,
    registry_total_agents: registry.count,
    registry_active_agents: activeAgents.length,
    lock_events: locks.count,
    last_lock_event_at: lastLockEventAt ? lastLockEventAt.toISOString() : null,
    workspace_records: workspaceRecords,
  };
}

// 扫描活跃 Mission：.agent/missions 下 M-* 目录（不归档即视为活跃）。
function collectMissions(root) {
  const missionsDir = path.join(root, ".agent/missions");
  const now = Date.now();
  const active = [];
  const active_recent = [];
  let recentCommandLog = false;
  let recentHandoffs = false;

  let entries = [];
  try {
    entries = fs.readdirSync(missionsDir, { withFileTypes: true });
  } catch {
    return { active, active_recent, recentCommandLog, recentHandoffs };
  }

  const isRecent = (mtime) => now - mtime.getTime() <= SEVEN_DAYS_MS;

  for (const entry of entries) {
    if (entry.isDirectory() && /^M-/.test(entry.name) && !/archive/i.test(entry.name)) {
      active.push(entry.name);
      const commandLog = path.join(missionsDir, entry.name, "command-log.md");
      try {
        const mtime = fs.statSync(commandLog).mtime;
        if (isRecent(mtime)) {
          recentCommandLog = true;
          active_recent.push(entry.name);
        }
      } catch {}
    }
  }

  const handoffsDir = path.join(missionsDir, "handoffs");
  try {
    for (const file of fs.readdirSync(handoffsDir)) {
      try {
        if (isRecent(fs.statSync(path.join(handoffsDir, file)).mtime)) {
          recentHandoffs = true;
          break;
        }
      } catch {}
    }
  } catch {}

  return { active, active_recent, recentCommandLog, recentHandoffs };
}

function runReconciliation(root) {
  const now = new Date();
  const git = collectGitReality(root);
  const runtime = readRuntimeState(root);
  const missions = collectMissions(root);

  const findings = [];
  const addFinding = (id, severity, message, evidence) =>
    findings.push({ id, severity, message, evidence });

  const hasActiveWork =
    git.extra_worktrees_recent.length >= 1 || git.agent_branches_recent.length >= 1;

  // 规则 1：现实有活跃 worktree/分支，且 runs/sessions/registry 三个面**全部**为空。
  // OR 条件 (任一为空) 过于宽松：只要有任意 agent registry 即视为运行态非空，
  // 因为 agent registry 是更稳定的"已注册"信号，能区分"运行态空" vs "运行态有但 runs/sessions 子索引未及时落地"。
  if (
    hasActiveWork &&
    runtime.runs === 0 &&
    runtime.sessions === 0 &&
    runtime.registry_active_agents === 0
  ) {
    addFinding(
      "RR-001",
      "critical",
      "现实存在活跃 worktree/agent 分支，但 runs/sessions/registry 运行记录为空，属于“现实有活动、运行态为空”。",
      {
        extra_worktrees: git.extra_worktrees,
        agent_branches: git.agent_branches,
        runs: runtime.runs,
        sessions: runtime.sessions,
        registry_active_agents: runtime.registry_active_agents,
        registry_total_agents: runtime.registry_total_agents,
      }
    );
  }

  // 规则 2：现实有活跃 Mission (7 天内 command-log 有改动)，但 workspaces 运行记录为空。
  // 历史 mission (command-log 长期未动) 不应触发 RR-002，因为 workspace 记录只在真实启动时创建。
  if (missions.active_recent.length >= 1 && runtime.workspace_records === 0) {
    addFinding(
      "RR-002",
      "critical",
      "存在活跃 Mission（非归档），但 workspaces 下没有任何运行记录。",
      {
        active_missions: missions.active,
        workspace_records: runtime.workspace_records,
      }
    );
  }

  // 规则 3：近期有提交活动而 decisions/waitpoints 为空。
  const lastCommit = git.last_commit_at ? new Date(git.last_commit_at) : null;
  const recentCommitActivity =
    lastCommit && now - lastCommit.getTime() <= SEVEN_DAYS_MS;

  if (
    (missions.recentCommandLog || missions.recentHandoffs) &&
    runtime.decisions === 0
  ) {
    addFinding(
      "RR-003",
      "critical",
      "Mission command-log 或 handoffs 近 7 天有修改，但 decisions 索引为空，批准/决策动作未留痕。",
      {
        recent_command_log: missions.recentCommandLog,
        recent_handoffs: missions.recentHandoffs,
        active_recent: missions.active_recent,
        decisions: runtime.decisions,
      }
    );
  } else if (
    recentCommitActivity &&
    runtime.decisions === 0 &&
    runtime.waitpoints === 0
  ) {
    addFinding(
      "RR-004",
      "warning",
      "近 7 天有 git 提交活动，但 decisions/waitpoints 索引为空；无法仅从 git 证明必有批准动作，记为警告。",
      {
        last_commit_at: git.last_commit_at,
        decisions: runtime.decisions,
        waitpoints: runtime.waitpoints,
      }
    );
  }

  // 规则 4：锁事件远早于最近提交且存在多 worktree。
  if (
    runtime.last_lock_event_at &&
    lastCommit &&
    git.extra_worktrees.length >= 1
  ) {
    const lastLockEvent = new Date(runtime.last_lock_event_at);
    if (lastCommit - lastLockEvent > SEVEN_DAYS_MS) {
      addFinding(
        "RR-005",
        "warning",
        "locks 最后事件时间早于最近提交 7 天以上，且存在多个 worktree，锁事件流可能长期未接入实际协作。",
        {
          last_lock_event_at: runtime.last_lock_event_at,
          last_commit_at: git.last_commit_at,
          extra_worktrees: git.extra_worktrees.length,
        }
      );
    }
  }

  if (findings.length === 0) {
    addFinding("RR-000", "ok", "Git 地面真值与运行态记录一致。", {});
  }

  const hasCritical = findings.some((f) => f.severity === "critical");
  const hasWarning = findings.some((f) => f.severity === "warning");
  const overallStatus = hasCritical ? "critical" : hasWarning ? "warn" : "pass";

  // 修复计划：只建议“补建哪些记录、由谁执行”，由真实工作流在执行实际工作时产生记录。
  const repairPlan = [];
  if (hasCritical || hasWarning) {
    repairPlan.push({
      step: 1,
      action: "为当前活跃 Mission/分支补建 Run 与 Session 记录",
      owner: "各 Mission 负责人在继续实际开发时通过 .agent/runs、.agent/sessions 对应工作流创建，禁止手工回填伪造历史事件",
    });
    if (runtime.registry_active_agents === 0 && hasActiveWork) {
      repairPlan.push({
        step: 2,
        action: "为当前活跃 worktree 对应的真实 agent 执行 registry check-in",
        owner: "各 worktree 内实际执行工作的 agent，通过 .agent/registry/scripts/agent-registry.js 正常入口登记",
      });
    }
    if (runtime.workspace_records === 0 && missions.active.length > 0) {
      repairPlan.push({
        step: 3,
        action: "为活跃 Mission 建立 workspace 运行记录（lease/identity）",
        owner: "Mission 负责人在实际占用 workspace 时通过 .agent/workspaces/scripts 下既有工作流创建",
      });
    }
    if (runtime.decisions === 0) {
      repairPlan.push({
        step: 4,
        action: "对后续真实发生的批准/放行动作写入 Decision/Waitpoint 记录",
        owner: "执行批准动作的人类或协调 agent，通过 .agent/decisions、.agent/waitpoints 对应工作流写入",
      });
    }
    repairPlan.push({
      step: repairPlan.length + 1,
      action: "补建完成后重跑 reality-reconciliation 与 self-check 验证 overall_status 恢复 pass",
      owner: "维护者执行 node .agent/skills/self-check/scripts/reality-reconciliation.js 复核",
    });
  }

  return {
    gate: "reality-reconciliation",
    generated_at: now.toISOString(),
    overall_status: overallStatus,
    git_reality: git,
    runtime_state: runtime,
    missions: {
      active: missions.active,
      recent_command_log: missions.recentCommandLog,
      recent_handoffs: missions.recentHandoffs,
    },
    findings,
    repair_plan: repairPlan,
  };
}

// 控制台中文人类可读摘要。
function printSummary(report) {
  const git = report.git_reality;
  const rt = report.runtime_state;
  console.log("== Reality Reconciliation 摘要 ==");
  console.log(
    `Git 地面真值: worktree=${git.worktree_count}（额外 ${git.extra_worktrees.length}）, ` +
      `agent 分支=${git.agent_branches.length}, 主工作区${git.main_worktree_dirty ? "有" : "无"}未提交改动, ` +
      `最近提交=${git.last_commit_at || "未知"}`
  );
  console.log(
    `运行态计数: runs=${rt.runs}, sessions=${rt.sessions}, queues=${rt.queues}, ` +
      `decisions=${rt.decisions}, waitpoints=${rt.waitpoints}, inbox=${rt.inbox_messages}, ` +
      `registry 活跃=${rt.registry_active_agents}/${rt.registry_total_agents}, ` +
      `workspace 记录=${rt.workspace_records}`
  );
  console.log(`活跃 Mission: ${report.missions.active.join(", ") || "无"}`);
  for (const finding of report.findings) {
    console.log(`[${finding.severity}] ${finding.id}: ${finding.message}`);
  }
  console.log(`总体状态: ${report.overall_status}`);
  if (report.repair_plan.length > 0) {
    console.log("修复建议（须由真实工作流执行，禁止伪造回填）:");
    for (const step of report.repair_plan) {
      console.log(`  ${step.step}. ${step.action} —— ${step.owner}`);
    }
  }
}

function writeReport(root, report) {
  const abs = path.join(root, REPORT_PATH);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(report, null, 2));
}

if (require.main === module) {
  const root = process.cwd();
  const report = runReconciliation(root);
  writeReport(root, report);
  printSummary(report);
  console.log(`报告已写入: ${REPORT_PATH}`);
  process.exit(report.overall_status === "critical" ? 1 : 0);
}

module.exports = { runReconciliation, collectGitReality, readRuntimeState, writeReport, REPORT_PATH };
