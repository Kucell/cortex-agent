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

function walkFiles(dir, filter) {
  const files = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walkFiles(file, filter));
      else if (!filter || filter(file)) files.push(file);
    }
  } catch {}
  return files.sort();
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

function formatLocalTime(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDisplayTime(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : formatLocalTime(date);
}

const I18N = {
  zh: {
    appTitle: "Agent 协作看板",
    subtitle: "PRD、任务、运行态、worktree 与验证状态",
    overview: "总览",
    prdStudio: "PRD 工作台",
    delivery: "交付看板",
    runtime: "运行现场",
    knowledge: "知识与文档",
    projectHealth: "项目健康",
    prdStatus: "PRD 状态",
    designStatus: "设计状态",
    runtimeStatus: "运行态",
    deliveryStatus: "交付状态",
    prdHealth: "PRD 完整度",
    missing: "缺失项",
    visualDesign: "视觉设计",
    reviewStatus: "评审状态",
    relatedTasks: "关联任务",
    deliveryChain: "交付链路",
    publishReadiness: "发布就绪度",
    taskStatus: "任务状态",
    runStatus: "Run 状态",
    validation: "验证",
    evidence: "验证证据",
    latestArtifact: "最新产物",
    publishDocs: "发布文档",
    linkedTasks: "关联任务",
    linkedRuns: "关联 Runs",
    validationsPassed: "验证通过",
    unlinked: "未关联",
    notReady: "未就绪",
    needsValidation: "待验证",
    needsEvidence: "待补证据",
    published: "已发布",
    blockedDecisions: "阻塞决策",
    executionSignal: "执行信号",
    eventTimeline: "事件时间线",
    ready: "就绪",
    unknown: "未知",
    notStarted: "未开始",
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
    communication: "通信与审批",
    inbox: "Inbox",
    openDecisions: "待决决策",
    blockingWaitpoints: "阻塞等待点",
    unreadMessages: "未读消息",
    action: "动作",
    resource: "资源",
    requesterOwner: "请求人 / Owner",
    reviewMessage: "查看并确认消息",
    resolveDecision: "等待用户明确决策",
    releaseWaitpoint: "由所属工作流验证证据后释放",
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
    taskDetails: "任务详情",
    contentOverview: "内容概述",
    informationCompleteness: "信息完整度",
    missingInformation: "待补信息",
    documentSections: "文档章节",
    relatedDocuments: "关联文档与提案",
    relatedTaskLinks: "关联任务",
    markdownPreview: "Markdown 预览",
    openPreview: "打开任务预览",
    closePreview: "关闭预览",
    loadingPreview: "正在读取文档...",
    previewError: "无法读取文档",
    noRelations: "暂无关联文档",
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
    subtitle: "PRD, tasks, runtime, worktrees, and validation state",
    overview: "Overview",
    prdStudio: "PRD Studio",
    delivery: "Delivery",
    runtime: "Runtime",
    knowledge: "Knowledge",
    projectHealth: "Project Health",
    prdStatus: "PRD Status",
    designStatus: "Design Status",
    runtimeStatus: "Runtime Status",
    deliveryStatus: "Delivery Status",
    prdHealth: "PRD Health",
    missing: "Missing",
    visualDesign: "Visual Design",
    reviewStatus: "Review Status",
    relatedTasks: "Related Tasks",
    deliveryChain: "Delivery Chain",
    publishReadiness: "Publish Readiness",
    taskStatus: "Task Status",
    runStatus: "Run Status",
    validation: "Validation",
    evidence: "Validation Evidence",
    latestArtifact: "Latest Artifact",
    publishDocs: "Publish Docs",
    linkedTasks: "Linked Tasks",
    linkedRuns: "Linked Runs",
    validationsPassed: "Validations Passed",
    unlinked: "Unlinked",
    notReady: "Not Ready",
    needsValidation: "Needs Validation",
    needsEvidence: "Needs Evidence",
    published: "Published",
    blockedDecisions: "Blocked Decisions",
    executionSignal: "Execution Signal",
    eventTimeline: "Event Timeline",
    ready: "Ready",
    unknown: "Unknown",
    notStarted: "Not Started",
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
    communication: "Communication & Approvals",
    inbox: "Inbox",
    openDecisions: "Open Decisions",
    blockingWaitpoints: "Blocking Waitpoints",
    unreadMessages: "Unread Messages",
    action: "Action",
    resource: "Resource",
    requesterOwner: "Requester / Owner",
    reviewMessage: "Review and acknowledge the message",
    resolveDecision: "Await an explicit user decision",
    releaseWaitpoint: "Owning workflow validates evidence, then releases",
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
    taskDetails: "Task Details",
    contentOverview: "Content Overview",
    informationCompleteness: "Information Completeness",
    missingInformation: "Missing Information",
    documentSections: "Document Sections",
    relatedDocuments: "Related Documents & Proposals",
    relatedTaskLinks: "Related Tasks",
    markdownPreview: "Markdown Preview",
    openPreview: "Open task preview",
    closePreview: "Close preview",
    loadingPreview: "Loading document...",
    previewError: "Unable to load document",
    noRelations: "No related documents",
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

function normalizedPreviewRef(value) {
  const match = String(value || "").match(/(?:^|[(\s`])((?:\.agent|docs)\/[A-Za-z0-9_./-]+\.(?:md|markdown|json|txt))(?:#[^)\s`]*)?/i);
  return match ? match[1] : "";
}

function refsFromValues(values) {
  const refs = [];
  for (const value of values.flat(Infinity)) {
    const text = typeof value === "string" ? value : value?.ref || value?.path || "";
    const direct = normalizedPreviewRef(text);
    if (direct) refs.push(direct);
    for (const match of String(text).matchAll(/(?:\.agent|docs)\/[A-Za-z0-9_./-]+\.(?:md|markdown|json|txt)/gi)) refs.push(match[0]);
  }
  return [...new Set(refs)];
}

function proposalDocuments() {
  return walkFiles(path.join(agentRoot, "plans", "proposals"), (file) => /\.(?:md|markdown)$/i.test(file))
    .map((file) => ({ path: rel(file), content: read(file) }));
}

function taskPreviewMarkdown(task) {
  const lines = [
    `# ${task.id} ${task.title || ""}`.trim(),
    "",
    `- **Status:** ${task.status || "unknown"}`,
    `- **Stage:** ${task.stage || "not recorded"}`,
    `- **Priority:** ${task.priority || "not recorded"}`,
    `- **Progress:** ${task.progress || "not recorded"}`,
  ];
  if (task.description) lines.push("", "## Description", "", task.description);
  if (task.acceptance_criteria?.length) lines.push("", "## Acceptance Criteria", "", ...task.acceptance_criteria.map((item) => `- ${item}`));
  if (task.related_tasks?.length) lines.push("", "## Related Tasks", "", ...task.related_tasks.map((id) => `- ${id}`));
  if (task.preview_refs?.length) lines.push("", "## Related Documents", "", ...task.preview_refs.map((ref) => `- \`${ref}\``));
  return lines.join("\n");
}

function cleanTaskTitle(title, id) {
  return String(title || id || "")
    .replace(/^\s*\[[ xX]\]\s*/, "")
    .replace(new RegExp(`\\s*[（(]${String(id || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[）)]\\s*$`), "")
    .trim();
}

function taskOverview(task) {
  const goal = cleanTaskTitle(task.title, task.id) || task.id;
  const missing = [];
  if (!task.description) missing.push("description");
  if (!task.acceptance_criteria?.length) missing.push("acceptance criteria");
  if (!task.stage) missing.push("stage");
  if (!task.priority) missing.push("priority");
  if (!task.proposal_refs?.length) missing.push("proposal");
  const completeness = Math.round(((5 - missing.length) / 5) * 100);
  const zhStatus = { open: "待开始", active: "进行中", blocked: "阻塞", done: "已完成" }[task.status] || task.status || "未知";
  const enStatus = { open: "not started", active: "in progress", blocked: "blocked", done: "completed" }[task.status] || task.status || "unknown";
  const relationZh = `已关联 ${task.proposal_refs?.length || 0} 个提案、${task.preview_refs?.length || 0} 份文档和 ${task.related_tasks?.length || 0} 个任务。`;
  const relationEn = `Linked to ${task.proposal_refs?.length || 0} proposal(s), ${task.preview_refs?.length || 0} document(s), and ${task.related_tasks?.length || 0} task(s).`;
  return {
    completeness,
    missing,
    zh: `目标是${goal}。当前${zhStatus}${task.progress ? `，进度记录为 ${task.progress}` : ""}。${relationZh}`,
    en: `The goal is: ${goal}. The task is ${enStatus}${task.progress ? ` with recorded progress ${task.progress}` : ""}. ${relationEn}`,
  };
}

function enrichTasks(tasks) {
  const proposals = proposalDocuments();
  return tasks.map((task) => {
    const id = task.id || task.task_id;
    const taskFile = path.join(agentRoot, "tasks", `${id}.json`);
    const canonical = readJson(taskFile) || {};
    const relatedTasks = [...new Set([
      ...(canonical.dependencies || []),
      ...(canonical.subtasks || []),
      ...(task.dependencies || []),
      ...(task.subtasks || []),
    ].filter(Boolean))];
    const refs = refsFromValues([
      canonical.source_refs || [],
      (canonical.artifacts || []).map((item) => item.ref),
      (canonical.gates || []).flatMap((gate) => gate.evidence_refs || []),
      task.source_refs || [],
      task.artifacts || [],
      task.plan || "",
    ]);
    if (fs.existsSync(taskFile)) refs.unshift(rel(taskFile));
    const proposalRefs = proposals
      .filter((proposal) => new RegExp(`(^|[^A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9-]|$)`).test(proposal.content))
      .map((proposal) => proposal.path);
    const previewRefs = [...new Set([...refs, ...proposalRefs])];
    if (!previewRefs.length && fs.existsSync(path.join(agentRoot, "plans", "task-progress.md"))) previewRefs.push(".agent/plans/task-progress.md");
    const rawStatus = task.status || canonical.status || "open";
    const normalizedStatus = rawStatus === "completed" ? "done" : rawStatus === "draft" ? "open" : rawStatus;
    const enriched = {
      ...task,
      ...canonical,
      id,
      title: canonical.title || task.title || id,
      status: normalizedStatus,
      related_tasks: relatedTasks,
      preview_refs: previewRefs,
      proposal_refs: [...new Set([...refs.filter((ref) => ref.includes("/plans/proposals/")), ...proposalRefs])],
    };
    enriched.preview_markdown = taskPreviewMarkdown(enriched);
    enriched.overview = taskOverview(enriched);
    return enriched;
  });
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
        updated: formatDisplayTime(stat.mtime),
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
    path: rel(dir),
    updated_at: data.updated_at || "",
    related_tasks: Array.isArray(data.related_tasks) ? data.related_tasks : [],
    design: {
      tool: design.tool || "",
      status: design.status || "not_started",
      url: design.url || "",
      local_path: design.local_path || "",
      screen_count: design.screen_count ?? null,
    },
    review: {
      status: review.status || "",
      decision_id: review.decision_id || "",
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

function prdSummary(prds) {
  if (!prds.length) {
    return {
      status: "not_started",
      design: "not_started",
      review: "open",
      completeness: 0,
      missing: ["prd", "user stories", "flows", "screens", "acceptance criteria"],
      current: null,
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
    current,
  };
}

function prdSummaryFromManaged(summary, prds) {
  if (!summary || typeof summary !== "object") return prdSummary(prds);
  return {
    status: summary.status || "not_started",
    design: summary.design || "not_started",
    review: summary.review || "open",
    completeness: Number.isFinite(Number(summary.completeness)) ? Number(summary.completeness) : 0,
    missing: Array.isArray(summary.missing) ? summary.missing : [],
    current: prds.find((item) => item.id === summary.current_id) || prds[0] || null,
  };
}

function deriveState({ worktrees, locks, handoffs, tasks, agents, decisions = [], waitpoints = [] }) {
  const nonMainWorktrees = worktrees.filter((w) => !w.isMain);
  const dirty = worktrees.some((w) => w.dirty);
  const heldLocks = locks.filter((l) => !l.expired);
  const blockedTasks = tasks.filter((t) => t.status === "blocked");
  const activeTasks = tasks.filter((t) => t.status === "active" || t.status === "open");
  const activeAgents = agents.filter((a) => ["running", "active", "paused"].includes(a.status));
  const openDecisions = decisions.filter((decision) => decision.status === "open");
  const blockingWaitpoints = waitpoints.filter((waitpoint) => ["pending", "blocked"].includes(waitpoint.effective_status || waitpoint.status));

  if (openDecisions.length || blockingWaitpoints.length) {
    return {
      state: "waiting_approval",
      next: "处理待决 Decision，并由所属工作流验证证据后释放 Waitpoint。",
      nextEn: "Resolve the pending Decision, then let the owning workflow validate evidence and release the Waitpoint.",
      why: `发现 ${openDecisions.length} 个待决 Decision 和 ${blockingWaitpoints.length} 个阻塞 Waitpoint。`,
      whyEn: `${openDecisions.length} open Decision(s) and ${blockingWaitpoints.length} blocking Waitpoint(s) detected.`,
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

function communicationResource(item) {
  const relations = item?.relations || {};
  return item?.gate?.resource_ref
    || item?.resource_ref
    || item?.artifact_refs?.[0]
    || relations.artifact_refs?.[0]
    || relations.task_ids?.[0]
    || relations.mission_ids?.[0]
    || relations.worktree_paths?.[0]
    || item?.subject
    || "";
}

function renderCommunicationTable(items, config) {
  const rows = items.slice(0, 12).map((item) => `<tr>
    <td><code>${esc(item[config.id])}</code></td>
    <td>${esc(config.action(item))}</td>
    <td><code>${esc(communicationResource(item))}</code></td>
    <td>${esc(config.owner(item))}</td>
    <td>${pill(item.effective_status || item.status)}</td>
    <td>${esc(formatDisplayTime(item.updated_at || item.created_at))}</td>
    <td data-i18n="${config.nextActionKey}">${esc(I18N.zh[config.nextActionKey])}</td>
  </tr>`);
  return renderTable(["id", "action", "resource", "requesterOwner", "status", "updated", "nextAction"], rows);
}

function taskColumn(tasks, status, labelKey) {
  const items = tasks.filter((task) => task.status === status);
  const visible = items.slice(0, 12);
  const remaining = items.length - visible.length;
  return `<section class="lane">
    <h3><span data-i18n="${labelKey}">${esc(I18N.zh[labelKey])}</span> <span class="mini">${items.length}</span></h3>
    ${visible.length ? visible.map((task) => `<button type="button" class="task-card" data-task-id="${esc(task.id)}" aria-label="${esc(`${I18N.zh.openPreview}: ${task.id}`)}"><strong>${esc(task.id)}</strong><p>${esc(task.title)}</p><p class="mini">${[task.priority, task.progress, task.plan].filter(Boolean).map(esc).join(" · ")}</p>${task.proposal_refs?.length ? `<span class="relation-count">${task.proposal_refs.length} proposal</span>` : ""}</button>`).join("") : `<div class="empty" data-i18n="empty">${I18N.zh.empty}</div>`}
    ${remaining > 0 ? `<div class="mini">+${remaining}</div>` : ""}
  </section>`;
}

function metric(labelKey, value, detail, tone = "") {
  return `<section class="metric ${esc(tone)}"><div class="metric-label" data-i18n="${labelKey}">${esc(I18N.zh[labelKey] || labelKey)}</div><div class="metric-value">${value}</div>${detail ? `<div class="metric-detail">${detail}</div>` : ""}</section>`;
}

function statusDot(value) {
  const cls = String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `<span class="status-dot ${cls}"></span>${esc(value || I18N.zh.unknown)}`;
}

function navItem(id, labelKey) {
  return `<a href="#${id}" data-i18n="${labelKey}">${esc(I18N.zh[labelKey])}</a>`;
}

function phaseRail(activePhase) {
  const phases = [
    ["decomposing", "拆分"],
    ["creating_worktree", "Worktree"],
    ["acquiring_lock", "锁定"],
    ["invoking_agent", "Agent"],
    ["editing", "编辑"],
    ["validating", "验证"],
    ["merging", "合并"],
  ];
  const activeIdx = Math.max(0, phases.findIndex(([phase]) => phase === activePhase));
  return `<div class="phase-rail">${phases.map(([phase, label], index) => `<div class="phase-node ${phase === activePhase ? "active" : index < activeIdx ? "done" : ""}"><span></span><strong>${esc(label)}</strong><small>${esc(phase)}</small></div>`).join("")}</div>`;
}

function prdCard(prd) {
  if (!prd) {
    return `<div class="empty-panel"><strong data-i18n="notStarted">${I18N.zh.notStarted}</strong><p>/prd create</p></div>`;
  }
  return `<article class="prd-item">
    <div><strong>${esc(prd.id)}</strong><p>${esc(prd.title)}</p><span class="mini">${esc(prd.path)}</span></div>
    <div>${pill(prd.status)}</div>
  </article>`;
}

function normalizedId(value) {
  return String(value || "").trim().toLowerCase();
}

function runsForTask(taskId, runs) {
  const id = normalizedId(taskId);
  return runs.filter((run) => normalizedId(run.task_id) === id);
}

function validationStatus(run) {
  if (!run) return "not_recorded";
  const events = Array.isArray(run.events) ? [...run.events].reverse() : [];
  const event = events.find((item) => ["validation_passed", "validation_failed", "validation_started"].includes(item.type));
  if (event?.type === "validation_failed") return "failed";
  if (event?.type === "validation_passed") return "passed";
  const result = String(run.validation?.status || run.validation?.result || "").toLowerCase();
  if (/fail|error|invalid/.test(result)) return "failed";
  if (/pass|success|valid/.test(result)) return "passed";
  if (event?.type === "validation_started" || run.phase === "validating") return "in_progress";
  if (run.kind === "validate" && run.status === "failed") return "failed";
  return "not_recorded";
}

function validationArtifact(run) {
  const items = Array.isArray(run?.artifacts) ? [...run.artifacts].reverse() : [];
  const match = items.find((item) => {
    const kind = typeof item === "object" && item ? item.kind : "";
    const file = typeof item === "string" ? item : item?.path || item?.ref || "";
    return kind === "validation" || /validation/i.test(file);
  });
  if (typeof match === "string") return match;
  return match?.path || match?.ref || "";
}

function hasPublishCompleted(runs) {
  return runs.some((run) => (run.events || []).some((event) => event.type === "publish_completed"));
}

function taskTrace(taskId, tasks, runs, artifacts) {
  const task = tasks.find((item) => normalizedId(item.id) === normalizedId(taskId));
  const linkedRuns = runsForTask(taskId, runs);
  const latestRun = linkedRuns[0] || null;
  const validationRun = linkedRuns.find((run) => validationStatus(run) !== "not_recorded") || latestRun;
  const artifact = artifacts.find((item) => normalizedId(item.task_id) === normalizedId(taskId)) || null;
  const validation = validationStatus(validationRun);
  const evidence = validationArtifact(linkedRuns.find((run) => validationArtifact(run)));
  let publish = "not_ready";
  if (hasPublishCompleted(linkedRuns)) publish = "published";
  else if (task?.status === "blocked" || validation === "failed") publish = "blocked";
  else if (task?.status === "done" && validation === "passed" && evidence) publish = "ready";
  else if (task?.status === "done" && validation === "passed") publish = "needs_evidence";
  else if (task?.status === "done") publish = "needs_validation";
  return { taskId, task, runs: linkedRuns, latestRun, validation, evidence, artifact, publish };
}

function buildPrdTrace(prd, tasks, runs, artifacts) {
  const taskIds = Array.isArray(prd?.related_tasks) ? prd.related_tasks : [];
  const rows = taskIds.map((taskId) => taskTrace(taskId, tasks, runs, artifacts));
  let readiness = "unlinked";
  if (prd?.status === "published") readiness = "published";
  else if (rows.some((row) => row.publish === "blocked")) readiness = "blocked";
  else if (rows.length && rows.every((row) => row.publish === "published")) readiness = "published";
  else if (rows.length && rows.every((row) => ["ready", "published"].includes(row.publish))) readiness = "ready";
  else if (rows.some((row) => !row.task || row.task.status !== "done")) readiness = "in_progress";
  else if (rows.some((row) => row.publish === "needs_evidence")) readiness = "needs_evidence";
  else if (rows.length) readiness = "needs_validation";
  return { rows, readiness };
}

function traceStage(labelKey, value, detail) {
  return `<div class="trace-stage"><span data-i18n="${labelKey}">${esc(I18N.zh[labelKey])}</span><strong>${value}</strong><small>${esc(detail)}</small></div>`;
}

function renderTraceSummary(prd, trace) {
  if (!prd || !trace.rows.length) return `<div class="empty" data-i18n="unlinked">${I18N.zh.unlinked}</div>`;
  const runCount = trace.rows.reduce((count, row) => count + row.runs.length, 0);
  const doneCount = trace.rows.filter((row) => row.task?.status === "done").length;
  const passedCount = trace.rows.filter((row) => row.validation === "passed").length;
  return `<div class="trace-summary">
    ${traceStage("prdStatus", pill(prd.status), prd.id)}
    ${traceStage("linkedTasks", `${doneCount}/${trace.rows.length}`, "PRD -> task")}
    ${traceStage("linkedRuns", pill(runCount ? "linked" : "not_recorded"), `${runCount} run(s)`)}
    ${traceStage("validationsPassed", `${passedCount}/${trace.rows.length}`, "run -> validation")}
    ${traceStage("publishDocs", pill(trace.readiness), trace.readiness === "ready" ? "/publish-docs" : "publish gate")}
  </div>`;
}

function renderTraceTable(trace) {
  const rows = trace.rows.map((row) => {
    const run = row.latestRun;
    const artifactDetail = row.evidence || row.artifact?.latest || "";
    const artifactCount = row.artifact?.count ? `<span class="mini">${row.artifact.count}</span> ` : "";
    const artifactLabel = artifactDetail && !row.evidence ? `<span class="mini" data-i18n="latestArtifact">${I18N.zh.latestArtifact}</span> ` : "";
    return `<tr><td><code>${esc(row.taskId)}</code></td><td>${pill(row.task?.status || "unknown")}</td><td>${run ? `<code>${esc(run.run_id || run.path)}</code>` : `<span class="mini">-</span>`}</td><td>${pill(run?.status || "not_recorded")}</td><td>${pill(row.validation)}</td><td>${artifactDetail ? `${artifactLabel}${artifactCount}<code>${esc(artifactDetail)}</code>` : `<span class="mini">-</span>`}</td><td>${pill(row.publish)}</td></tr>`;
  });
  return `<div class="trace-table">${renderTable(["task", "taskStatus", "runs", "runStatus", "validation", "evidence", "publishReadiness"], rows, "unlinked")}</div>`;
}

function main() {
  const managed = queryManagementDashboardState();
  const tasks = enrichTasks(managed?.tasks || parseTasks());
  const worktrees = managed?.worktrees || parseWorktrees();
  const agents = managed?.agents || parseRegistry();
  const locks = managed?.locks || parseLocks();
  const handoffs = managed?.handoffs || parseHandoffs();
  const artifacts = managed?.artifacts || parseArtifacts();
  const prds = Array.isArray(managed?.prds) ? managed.prds : parsePrds();
  const prd = managed?.prd_summary ? prdSummaryFromManaged(managed.prd_summary, prds) : prdSummary(prds);
  const runs = Array.isArray(managed?.runs) ? managed.runs : [];
  const queues = Array.isArray(managed?.queues) ? managed.queues : [];
  const sessions = Array.isArray(managed?.sessions) ? managed.sessions : [];
  const inbox = Array.isArray(managed?.inbox) ? managed.inbox : [];
  const decisions = Array.isArray(managed?.decisions) ? managed.decisions : [];
  const waitpoints = Array.isArray(managed?.waitpoints) ? managed.waitpoints : [];
  const summary = managed?.summary && typeof managed.summary === "object" ? managed.summary : {};
  const openDecisions = decisions.filter((decision) => decision.status === "open");
  const blockingWaitpoints = waitpoints.filter((waitpoint) => ["pending", "blocked"].includes(waitpoint.effective_status || waitpoint.status));
  const summaryCount = (key, fallback) => Number.isFinite(Number(summary[key])) ? Number(summary[key]) : fallback;
  const unreadMessageCount = summaryCount("unread_messages", inbox.filter((message) => message.status === "unread").length);
  const openDecisionCount = summaryCount("open_decisions", openDecisions.length);
  const blockingWaitpointCount = summaryCount("blocking_waitpoints", blockingWaitpoints.length);
  const gitStatus = typeof managed?.git_status === "string" ? managed.git_status : sh("git status --short --branch");
  const baseDerived = managed?.derived || deriveState({ worktrees, locks, handoffs, tasks, agents, decisions, waitpoints });
  const derived = openDecisionCount || blockingWaitpointCount
    ? {
        state: "waiting_approval",
        next: "处理待决 Decision，并由所属工作流验证证据后释放 Waitpoint。",
        nextEn: "Resolve the pending Decision, then let the owning workflow validate evidence and release the Waitpoint.",
        why: `发现 ${openDecisionCount} 个待决 Decision 和 ${blockingWaitpointCount} 个阻塞 Waitpoint。`,
        whyEn: `${openDecisionCount} open Decision(s) and ${blockingWaitpointCount} blocking Waitpoint(s) detected.`,
      }
    : baseDerived;
  const generatedAt = formatLocalTime();
  const activeTaskCount = tasks.filter((t) => t.status !== "done").length;
  const heldLockCount = locks.filter((l) => !l.expired).length;
  const nonMainWorktreeCount = worktrees.filter((w) => !w.isMain).length;
  const runningRuns = runs.filter((r) => r.status === "running");
  const activeAgents = agents.filter((agent) => ["running", "active", "paused"].includes(agent.status));
  const dirtyWorktrees = worktrees.filter((worktree) => worktree.dirty);
  const currentActivity = derived.state === "waiting_approval"
    ? derived.next
    : runningRuns[0]?.activity || runningRuns[0]?.last_event?.message || activeAgents[0]?.activity || derived.next || "";
  const activePhase = runningRuns[0]?.phase || sessions.find((s) => s.phase)?.phase || "";
  const blockedTasks = tasks.filter((t) => t.status === "blocked");
  const validationReady = tasks.length && tasks.every((t) => t.status === "done");
  const deliveryState = blockedTasks.length ? "blocked" : validationReady ? "ready" : activeTaskCount ? "in_progress" : "idle";
  const runtimeState = sessions.some((s) => s.status === "stale")
    ? "stale"
    : runningRuns.length
      ? "running"
      : activeAgents.length
        ? "active"
        : "idle";
  const worktreeState = dirtyWorktrees.length
    ? "dirty"
    : heldLockCount
      ? "locked"
      : nonMainWorktreeCount
        ? "active"
        : "idle";
  const recentEvents = runs.flatMap((r) => (Array.isArray(r.events) ? r.events.slice(-4).reverse().map((event) => ({ run: r, event })) : [])).slice(0, 16);
  const prdTrace = buildPrdTrace(prd.current, tasks, runs, artifacts);

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Dashboard</title>
<style>
:root{color-scheme:light dark;--bg:#0f1115;--rail:#11141a;--panel:#171a21;--panel2:#101319;--text:#e7ebf2;--muted:#9aa4b2;--line:#2a303b;--accent:#5aa7ff;--ok:#58d68d;--warn:#f1b44c;--bad:#ff6b6b;--cyan:#61d6d6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}.shell{min-height:100vh;display:grid;grid-template-columns:236px minmax(0,1fr)}
aside{position:sticky;top:0;height:100vh;background:var(--rail);border-right:1px solid var(--line);padding:20px 16px}aside h1{font-size:18px;margin:0 0 6px}aside .project{color:var(--muted);font-size:12px;margin-bottom:22px;overflow:hidden;text-overflow:ellipsis}nav{display:grid;gap:6px}nav a{color:var(--muted);text-decoration:none;padding:9px 10px;border-radius:7px}nav a:hover{background:var(--panel);color:var(--text)}.toolbar{margin-top:18px;display:flex;gap:8px}.toolbar button{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:6px 9px;cursor:pointer}.toolbar button.active{border-color:var(--accent);color:var(--accent)}
main{min-width:0}.topbar{padding:20px 28px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:18px;align-items:flex-start;background:#12151b}.topbar h2{font-size:22px;margin:0 0 4px}.muted,.mini{color:var(--muted)}.mini{font-size:12px}
.section{padding:20px 28px;border-bottom:1px solid var(--line)}.section h2{font-size:16px;margin:0 0 14px}.section-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}.panel{grid-column:span 6;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;min-width:0;overflow-x:auto}.wide{grid-column:span 12}.third{grid-column:span 4}.quarter{grid-column:span 3}
.status-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.metric{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:13px}.metric-label{color:var(--muted);font-size:12px;margin-bottom:8px}.metric-value{font-size:24px;font-weight:750;line-height:1.15}.metric-detail{margin-top:7px;color:var(--muted);font-size:12px}.metric.blocked{border-color:rgba(255,107,107,.55)}.metric.running,.metric.in_progress{border-color:rgba(90,167,255,.6)}.metric.ready,.metric.approved,.metric.validated{border-color:rgba(88,214,141,.55)}
.command-panel{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(280px,.7fr);gap:14px}.current{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:18px}.current .label{color:var(--muted);font-size:12px;margin-bottom:10px}.current .activity{font-size:20px;color:var(--accent);overflow-wrap:anywhere}.reason{margin-top:10px;color:var(--muted)}.signal-list{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;display:grid;gap:10px}.signal{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding-bottom:8px}.signal:last-child{border-bottom:0;padding-bottom:0}
.phase-rail{display:grid;grid-template-columns:repeat(7,1fr);gap:8px}.phase-node{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px;min-height:76px}.phase-node span{display:block;width:10px;height:10px;border-radius:50%;background:var(--muted);margin-bottom:8px}.phase-node.active{border-color:var(--accent)}.phase-node.active span{background:var(--accent)}.phase-node.done span{background:var(--ok)}.phase-node strong{display:block}.phase-node small{display:block;color:var(--muted);margin-top:3px;overflow-wrap:anywhere}
.lanes{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.lane{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:12px}.lane h3{margin:0 0 10px;color:var(--muted);font-size:13px}.task-card{display:block;width:100%;min-height:96px;border:1px solid var(--line);border-radius:7px;padding:10px;margin:0 0 8px;background:#0d1016;color:var(--text);font:inherit;text-align:left;cursor:pointer}.task-card:hover,.task-card:focus-visible{border-color:var(--accent);outline:0}.task-card p{margin:4px 0 0;color:var(--muted)}.relation-count{display:inline-block;margin-top:8px;color:var(--accent);font-size:12px}
.prd-item{display:flex;justify-content:space-between;gap:14px;border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--panel2)}.prd-item p{margin:3px 0}.empty-panel{border:1px dashed var(--line);border-radius:8px;padding:18px;color:var(--muted)}.check-list{display:grid;gap:8px}.check-list div{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding-bottom:7px}.check-list div:last-child{border-bottom:0}
.trace-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--line);border-radius:8px;overflow:hidden}.trace-stage{min-width:0;padding:11px 12px;background:var(--panel2);border-right:1px solid var(--line)}.trace-stage:last-child{border-right:0}.trace-stage>span,.trace-stage small{display:block;color:var(--muted);font-size:12px}.trace-stage strong{display:block;margin:5px 0;overflow-wrap:anywhere}.trace-table{margin:14px 0 18px;overflow-x:auto}.trace-table code{white-space:normal;overflow-wrap:anywhere}.trace-table table{min-width:820px}
.timeline{display:grid;gap:10px}.timeline-item{display:grid;grid-template-columns:140px minmax(0,1fr);gap:12px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:11px}.timeline-item p{margin:2px 0;color:var(--muted)}
table{width:100%;border-collapse:collapse}th,td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}th{color:var(--muted);font-weight:600}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#d9e7ff}.empty{color:var(--muted);padding:10px 0}.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted);white-space:nowrap}.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--muted);margin-right:7px}.status-dot.running,.status-dot.in_progress,.status-dot.invoking_agent{background:var(--accent)}.status-dot.done,.status-dot.ready,.status-dot.clean,.status-dot.approved{background:var(--ok)}.status-dot.blocked,.status-dot.dirty,.status-dot.stale{background:var(--bad)}
.done,.ready,.validated,.clean,.approved,.published,.released,.acknowledged{color:var(--ok);border-color:rgba(88,214,141,.45)}.blocked,.validation_failed,.failed,.dirty,.stale,.rejected,.expired{color:var(--bad);border-color:rgba(255,107,107,.45)}.active,.in_progress,.running,.locked,.merge_ready,.handoff_required,.held,.draft,.review,.needs_validation,.needs_evidence,.not_ready,.waiting_approval,.open,.pending,.unread{color:var(--warn);border-color:rgba(241,180,76,.45)}pre{white-space:pre-wrap;background:#0d1016;border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto;max-height:260px}
.preview-dialog{width:min(760px,92vw);height:100dvh;max-height:none;margin:0 0 0 auto;padding:0;border:0;border-left:1px solid var(--line);background:var(--panel);color:var(--text)}.preview-dialog::backdrop{background:rgba(0,0,0,.62)}.preview-shell{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr)}.preview-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px 20px;border-bottom:1px solid var(--line)}.preview-header h2{font-size:18px;margin:0}.preview-path{margin-top:3px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.icon-button{width:36px;height:36px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:24px;line-height:1;cursor:pointer}.preview-content{overflow:auto;padding:20px}.preview-relations{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid var(--line)}.preview-relations h3{font-size:13px;margin:0 0 9px;color:var(--muted)}.relation-list{display:flex;flex-wrap:wrap;gap:7px}.relation-link{max-width:100%;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--accent);padding:6px 9px;font:inherit;font-size:12px;text-align:left;overflow-wrap:anywhere;cursor:pointer}.relation-link:hover,.relation-link:focus-visible{border-color:var(--accent);outline:0}.markdown-body{line-height:1.65;overflow-wrap:anywhere}.markdown-body h1{font-size:24px;margin:0 0 16px}.markdown-body h2{font-size:18px;margin:24px 0 10px}.markdown-body h3{font-size:15px;margin:20px 0 8px}.markdown-body p{margin:9px 0}.markdown-body ul,.markdown-body ol{padding-left:24px}.markdown-body blockquote{margin:12px 0;padding-left:12px;border-left:3px solid var(--accent);color:var(--muted)}.markdown-body pre{max-height:none}.preview-error{color:var(--bad)}
@media(max-width:1100px){.shell{display:block}aside{position:static;height:auto}.status-strip,.command-panel,.phase-rail,.lanes,.trace-summary{grid-template-columns:1fr}.trace-stage{border-right:0;border-bottom:1px solid var(--line)}.trace-stage:last-child{border-bottom:0}.panel,.third,.quarter{grid-column:span 12}.section,.topbar{padding:16px}.timeline-item{grid-template-columns:1fr}.preview-dialog{width:100vw}.preview-relations{grid-template-columns:1fr}}
.content-overview{margin-bottom:18px;padding-bottom:18px;border-bottom:1px solid var(--line)}.overview-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin-bottom:8px}.overview-label{color:var(--muted);font-size:12px;font-weight:650}.overview-score{color:var(--accent);font-size:12px}.overview-text{margin:0;font-size:15px;line-height:1.65}.overview-meta{margin-top:9px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.preview-dialog{max-width:none}
@media(max-width:1100px){.preview-dialog{width:100%;margin:0}}
</style>
</head>
<body>
<div class="shell">
  <aside>
    <h1 data-i18n="appTitle">${I18N.zh.appTitle}</h1>
    <div class="project">${esc(path.basename(root))}</div>
    <nav>
      ${navItem("overview", "overview")}
      ${navItem("prd", "prdStudio")}
      ${navItem("delivery", "delivery")}
      ${navItem("runtime", "runtime")}
      ${navItem("communication", "communication")}
      ${navItem("knowledge", "knowledge")}
    </nav>
    <div class="toolbar" aria-label="language switcher">
      <button type="button" data-lang="zh" class="active">中文</button>
      <button type="button" data-lang="en">EN</button>
    </div>
  </aside>
  <main>
    <header class="topbar">
      <div>
        <h2 data-i18n="overview">${I18N.zh.overview}</h2>
        <div class="muted"><span data-i18n="subtitle">${I18N.zh.subtitle}</span></div>
        <div class="mini"><span data-i18n="generated">${I18N.zh.generated}</span>: ${esc(generatedAt)}</div>
      </div>
      <div>${pill(derived.state)}</div>
    </header>

    <section id="overview" class="section">
      <div class="status-strip">
        ${metric("prdStatus", pill(prd.status), `${prd.completeness}% · ${esc(prd.current?.id || I18N.zh.notStarted)}`, prd.status)}
        ${metric("deliveryStatus", pill(deliveryState), `${activeTaskCount} active · ${blockedTasks.length} blocked`, deliveryState)}
        ${metric("runtimeStatus", pill(runtimeState), `${runningRuns.length} runs · ${sessions.length} sessions · ${activeAgents.length} agents`, runtimeState)}
        ${metric("worktreeState", pill(worktreeState), `${nonMainWorktreeCount} worktrees · ${heldLockCount} locks`, worktreeState)}
      </div>
    </section>

    <section class="section">
      <div class="command-panel">
        <div class="current">
          <div class="label" data-i18n="currentActivity">${I18N.zh.currentActivity}</div>
          <div class="activity">${esc(currentActivity || I18N.zh.empty)}</div>
          <div class="reason"><code data-next-zh="${esc(derived.next)}" data-next-en="${esc(derived.nextEn)}">${esc(derived.next)}</code></div>
          <div class="reason" data-why-zh="${esc(derived.why)}" data-why-en="${esc(derived.whyEn)}">${esc(derived.why)}</div>
        </div>
        <div class="signal-list">
          <div class="signal"><span data-i18n="phase">${I18N.zh.phase}</span><strong>${statusDot(activePhase || runtimeState)}</strong></div>
          <div class="signal"><span data-i18n="prdHealth">${I18N.zh.prdHealth}</span><strong>${prd.completeness}%</strong></div>
          <div class="signal"><span data-i18n="openDecisions">${I18N.zh.openDecisions}</span><strong>${openDecisionCount}</strong></div>
          <div class="signal"><span data-i18n="blockingWaitpoints">${I18N.zh.blockingWaitpoints}</span><strong>${blockingWaitpointCount}</strong></div>
          <div class="signal"><span data-i18n="activeAgents">${I18N.zh.activeAgents}</span><strong>${activeAgents.length}</strong></div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 data-i18n="progressMap">${I18N.zh.progressMap}</h2><span class="mini" data-i18n="executionSignal">${I18N.zh.executionSignal}</span></div>
      ${phaseRail(activePhase)}
    </section>

    <section id="prd" class="section">
      <div class="section-head"><h2 data-i18n="prdStudio">${I18N.zh.prdStudio}</h2><span>${pill(prd.status)}</span></div>
      <div class="grid">
        <div class="panel third">${prdCard(prd.current)}</div>
        <div class="panel third"><h2 data-i18n="prdHealth">${I18N.zh.prdHealth}</h2><div class="metric-value">${prd.completeness}%</div><div class="mini"><span data-i18n="missing">${I18N.zh.missing}</span>: ${esc(prd.missing.slice(0, 5).join(", ") || I18N.zh.ready)}</div></div>
        <div class="panel third"><h2 data-i18n="visualDesign">${I18N.zh.visualDesign}</h2><div>${pill(prd.design)}</div><div class="mini">${esc(prd.current?.design.tool || prd.current?.design.local_path || prd.current?.design.url || I18N.zh.notStarted)}</div></div>
        <div class="panel wide"><div class="section-head"><h2 data-i18n="deliveryChain">${I18N.zh.deliveryChain}</h2><span>${pill(prdTrace.readiness)}</span></div>${renderTraceSummary(prd.current, prdTrace)}</div>
      </div>
    </section>

    <section id="delivery" class="section">
      <div class="section-head"><h2 data-i18n="delivery">${I18N.zh.delivery}</h2><span>${pill(deliveryState)}</span></div>
      <div class="section-head"><h2 data-i18n="deliveryChain">${I18N.zh.deliveryChain}</h2><span><span data-i18n="publishReadiness">${I18N.zh.publishReadiness}</span> ${pill(prdTrace.readiness)}</span></div>
      ${renderTraceTable(prdTrace)}
      <div class="lanes">${taskColumn(tasks, "open", "open")}${taskColumn(tasks, "active", "active")}${taskColumn(tasks, "blocked", "blocked")}${taskColumn(tasks, "done", "done")}</div>
    </section>

    <section id="runtime" class="section">
      <div class="section-head"><h2 data-i18n="runtime">${I18N.zh.runtime}</h2><span>${pill(runtimeState)}</span></div>
      <div class="grid">
        <section class="panel wide"><h2 data-i18n="eventTimeline">${I18N.zh.eventTimeline}</h2>${recentEvents.length ? `<div class="timeline">${recentEvents.map(({ run, event }) => `<div class="timeline-item"><div><code>${esc(run.run_id || run.path)}</code><div class="mini">${esc(formatDisplayTime(event.at))}</div></div><div>${event.phase ? pill(event.phase) : ""} ${event.status ? pill(event.status) : ""}<p>${esc(event.message || event.activity || event.type || "")}</p></div></div>`).join("")}</div>` : `<div class="empty" data-i18n="empty">${I18N.zh.empty}</div>`}</section>
        <section class="panel"><h2 data-i18n="sessions">${I18N.zh.sessions}</h2>${renderTable(["agent","role","status","phase","heartbeat"], sessions.map((s) => `<tr><td>${esc(s.agent_id || s.session_id)}</td><td>${esc(s.role || "")}</td><td>${pill(s.status)}</td><td>${s.phase ? pill(s.phase) : esc(s.activity || "")}</td><td data-volatile="heartbeat">${esc(formatDisplayTime(s.last_heartbeat_at || s.started_at))}</td></tr>`))}</section>
        <section class="panel"><h2 data-i18n="runs">${I18N.zh.runs}</h2>${renderTable(["id","kind","status","phase","message"], runs.slice(0, 8).map((r) => `<tr><td><code>${esc(r.run_id || r.path)}</code></td><td>${esc(r.kind || "")}</td><td>${pill(r.status)}</td><td>${r.phase ? pill(r.phase) : ""}</td><td>${esc(r.activity || r.last_event?.message || "")}</td></tr>`))}</section>
        <section class="panel wide"><h2 data-i18n="queues">${I18N.zh.queues}</h2>${renderTable(["id","status","items","currentActivity"], queues.map((q) => `<tr><td><code>${esc(q.queue_id || q.path)}</code></td><td>${pill(q.status)}</td><td>${Array.isArray(q.items) ? q.items.length : 0}</td><td>${esc((q.items || []).find((item) => item.state === "running")?.activity || "")}</td></tr>`))}</section>
        <section class="panel wide"><h2 data-i18n="worktrees">${I18N.zh.worktrees}</h2>${renderTable(["path","branch","status","head"], worktrees.map((w) => `<tr><td><code>${esc(w.path)}</code>${w.isMain ? ' <span class="mini">main</span>' : ""}</td><td>${esc(w.branch)}</td><td>${pill(w.dirty ? "dirty" : "clean")}</td><td><code>${esc(w.head.slice(0,12))}</code></td></tr>`))}</section>
        <section class="panel"><h2 data-i18n="activeAgents">${I18N.zh.activeAgents}</h2>${renderTable(["agent","role","task","status"], agents.map((a) => `<tr><td>${esc(a.agent_id || a.id)}</td><td>${esc(a.role)}</td><td><code>${esc(a.task_id || "")}</code></td><td>${pill(a.status)}</td></tr>`))}</section>
        <section class="panel"><h2 data-i18n="locks">${I18N.zh.locks}</h2>${renderTable(["scope","heldBy","expires","status"], locks.map((l) => `<tr><td><code>${esc(l.scope)}</code></td><td>${esc(l.held_by)}</td><td>${esc(formatDisplayTime(l.expires_at))}</td><td>${pill(l.expired ? "expired" : "held")}</td></tr>`))}</section>
      </div>
    </section>

    <section id="communication" class="section">
      <div class="section-head"><h2 data-i18n="communication">${I18N.zh.communication}</h2><span>${pill(derived.state === "waiting_approval" ? "waiting_approval" : "clear")}</span></div>
      <div class="grid">
        <section class="panel wide"><div class="section-head"><h2 data-i18n="inbox">${I18N.zh.inbox}</h2><span class="mini"><span data-i18n="unreadMessages">${I18N.zh.unreadMessages}</span>: ${unreadMessageCount}</span></div>${renderCommunicationTable(inbox, { id: "message_id", action: (item) => item.type || "message", owner: (item) => item.sender_id || "", nextActionKey: "reviewMessage" })}</section>
        <section class="panel wide"><div class="section-head"><h2 data-i18n="openDecisions">${I18N.zh.openDecisions}</h2><span class="mini">${openDecisionCount}</span></div>${renderCommunicationTable(openDecisions, { id: "decision_id", action: (item) => [item.type, item.gate?.action].filter(Boolean).join(" / "), owner: (item) => item.requested_by || "", nextActionKey: "resolveDecision" })}</section>
        <section class="panel wide"><div class="section-head"><h2 data-i18n="blockingWaitpoints">${I18N.zh.blockingWaitpoints}</h2><span class="mini">${blockingWaitpointCount}</span></div>${renderCommunicationTable(blockingWaitpoints, { id: "waitpoint_id", action: (item) => item.gate?.action || "", owner: (item) => item.owner_workflow || "", nextActionKey: "releaseWaitpoint" })}</section>
      </div>
    </section>

    <section id="knowledge" class="section">
      <div class="grid">
        <section class="panel"><h2 data-i18n="handoffs">${I18N.zh.handoffs}</h2>${renderTable(["path","type","updated"], handoffs.map((h) => `<tr><td><code>${esc(h.path)}</code></td><td>${esc(h.type)}</td><td>${esc(formatDisplayTime(h.updated))}</td></tr>`))}</section>
        <section class="panel"><h2 data-i18n="artifacts">${I18N.zh.artifacts}</h2>${renderTable(["task","count","latest"], artifacts.map((a) => `<tr><td><code>${esc(a.task_id)}</code></td><td>${a.count}</td><td><code>${esc(a.latest)}</code></td></tr>`))}</section>
        <section class="panel wide"><h2 data-i18n="gitStatus">${I18N.zh.gitStatus}</h2><pre>${esc(gitStatus || I18N.zh.noGit)}</pre></section>
      </div>
    </section>
  </main>
</div>
<dialog id="preview-dialog" class="preview-dialog" aria-labelledby="preview-title">
  <div class="preview-shell">
    <header class="preview-header">
      <div><h2 id="preview-title" data-i18n="taskDetails">${I18N.zh.taskDetails}</h2><div id="preview-path" class="preview-path"></div></div>
      <button type="button" id="preview-close" class="icon-button" aria-label="${esc(I18N.zh.closePreview)}" title="${esc(I18N.zh.closePreview)}">&times;</button>
    </header>
    <div class="preview-content">
      <section class="content-overview" aria-labelledby="overview-label">
        <div class="overview-head"><span id="overview-label" class="overview-label" data-i18n="contentOverview">${I18N.zh.contentOverview}</span><strong id="overview-score" class="overview-score"></strong></div>
        <p id="overview-text" class="overview-text"></p>
        <div id="overview-meta" class="overview-meta"></div>
      </section>
      <div class="preview-relations">
        <section><h3 data-i18n="relatedDocuments">${I18N.zh.relatedDocuments}</h3><div id="preview-documents" class="relation-list"></div></section>
        <section><h3 data-i18n="relatedTaskLinks">${I18N.zh.relatedTaskLinks}</h3><div id="preview-tasks" class="relation-list"></div></section>
      </div>
      <article id="markdown-preview" class="markdown-body"></article>
    </div>
  </div>
</dialog>
<script>
const i18n = ${JSON.stringify(I18N)};
const taskDetails = ${JSON.stringify(Object.fromEntries(tasks.map((task) => [task.id, task]))).replace(/</g, "\\u003c")};
const previewDialog = document.getElementById('preview-dialog');
const previewTitle = document.getElementById('preview-title');
const previewPath = document.getElementById('preview-path');
const previewBody = document.getElementById('markdown-preview');
const previewDocuments = document.getElementById('preview-documents');
const previewTasks = document.getElementById('preview-tasks');
const overviewScore = document.getElementById('overview-score');
const overviewText = document.getElementById('overview-text');
const overviewMeta = document.getElementById('overview-meta');
let activeTaskId = null;
let activeDocument = null;

function previewEscape(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function previewInline(value) {
  return previewEscape(value)
    .replace(/\\x60([^\\x60]+)\\x60/g, '<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
}

function renderMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\\r/g, '').split('\\n');
  const html = [];
  let inCode = false;
  let code = [];
  let list = '';
  const closeList = () => { if (list) { html.push('</' + list + '>'); list = ''; } };
  for (const line of lines) {
    if (line.startsWith('\\x60\\x60\\x60')) {
      closeList();
      if (inCode) { html.push('<pre><code>' + previewEscape(code.join('\\n')) + '</code></pre>'); code = []; }
      inCode = !inCode;
      continue;
    }
    if (inCode) { code.push(line); continue; }
    const heading = line.match(/^(#{1,4})\\s+(.+)$/);
    if (heading) { closeList(); const level = heading[1].length; html.push('<h' + level + '>' + previewInline(heading[2]) + '</h' + level + '>'); continue; }
    const unordered = line.match(/^\\s*[-*]\\s+(.+)$/);
    const ordered = line.match(/^\\s*\\d+[.]\\s+(.+)$/);
    if (unordered || ordered) {
      const nextList = unordered ? 'ul' : 'ol';
      if (list !== nextList) { closeList(); list = nextList; html.push('<' + list + '>'); }
      html.push('<li>' + previewInline((unordered || ordered)[1]) + '</li>');
      continue;
    }
    closeList();
    if (!line.trim()) continue;
    if (line.startsWith('> ')) html.push('<blockquote>' + previewInline(line.slice(2)) + '</blockquote>');
    else html.push('<p>' + previewInline(line) + '</p>');
  }
  closeList();
  if (code.length) html.push('<pre><code>' + previewEscape(code.join('\\n')) + '</code></pre>');
  return html.join('');
}

function relationButton(label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'relation-link';
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

function updateTaskOverview(task, lang) {
  const dict = i18n[lang] || i18n.zh;
  const overview = task.overview || {};
  const missingZh = { description: '任务说明', 'acceptance criteria': '验收标准', stage: '任务阶段', priority: '优先级', proposal: '关联提案' };
  overviewText.textContent = lang === 'en' ? overview.en : overview.zh;
  overviewScore.textContent = dict.informationCompleteness + ': ' + (overview.completeness || 0) + '%';
  const missing = (overview.missing || []).map((item) => lang === 'en' ? item : (missingZh[item] || item));
  overviewMeta.textContent = missing.length ? dict.missingInformation + ': ' + missing.join(', ') : '';
}

function documentOverview(content, path, lang) {
  const lines = String(content || '').replace(/\\r/g, '').split('\\n');
  const headings = lines.map((line) => line.match(/^#{1,6}\\s+(.+)$/)).filter(Boolean).map((match) => match[1].replace(/\\*+/g, '').trim());
  const paragraphs = lines
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:#{1,6}\\s|\\x60\\x60\\x60|[|:-]{3,})/.test(line))
    .map((line) => line.replace(/^[-*>\\d.\\s]+/, '').replace(/\\*+/g, '').replace(/\\x60/g, '').trim())
    .filter((line) => line.length >= 18);
  const topic = headings[0] || path.split('/').pop() || path;
  const excerpt = paragraphs.slice(0, 2).join(' ').slice(0, 320);
  const summary = lang === 'en'
    ? 'This document focuses on "' + topic + '"' + (excerpt ? '. ' + excerpt : '.')
    : '该文档围绕“' + topic + '”展开' + (excerpt ? '。' + excerpt : '。');
  return { summary, sections: headings.length, headings: headings.slice(0, 4) };
}

function updateDocumentOverview(documentState, lang) {
  const dict = i18n[lang] || i18n.zh;
  const overview = documentOverview(documentState.content, documentState.path, lang);
  overviewText.textContent = overview.summary;
  overviewScore.textContent = dict.documentSections + ': ' + overview.sections;
  overviewMeta.textContent = overview.headings.length ? overview.headings.join(' · ') : '';
}

function refreshOverview(lang) {
  if (activeDocument) updateDocumentOverview(activeDocument, lang);
  else if (activeTaskId && taskDetails[activeTaskId]) updateTaskOverview(taskDetails[activeTaskId], lang);
}

function showTask(taskId, restoreRef) {
  const task = taskDetails[taskId];
  if (!task) return;
  activeTaskId = taskId;
  activeDocument = null;
  previewTitle.textContent = task.id + ' · ' + (task.title || task.id);
  previewPath.textContent = task.stage ? task.status + ' / ' + task.stage : task.status || '';
  previewBody.innerHTML = renderMarkdown(task.preview_markdown);
  previewDocuments.replaceChildren();
  previewTasks.replaceChildren();
  const lang = localStorage.getItem('agent-dashboard-lang') || 'zh';
  const dict = i18n[lang] || i18n.zh;
  updateTaskOverview(task, lang);
  for (const ref of task.preview_refs || []) previewDocuments.appendChild(relationButton(ref, () => openDocument(taskId, ref)));
  if (!(task.preview_refs || []).length) previewDocuments.textContent = dict.noRelations;
  for (const relatedId of task.related_tasks || []) {
    previewTasks.appendChild(relationButton(relatedId, () => taskDetails[relatedId] ? showTask(relatedId) : openDocument(taskId, '.agent/tasks/' + relatedId + '.json')));
  }
  if (!(task.related_tasks || []).length) previewTasks.textContent = dict.empty;
  if (!previewDialog.open) previewDialog.showModal();
  sessionStorage.setItem('agent-dashboard-preview', JSON.stringify({ taskId, ref: restoreRef || null }));
  if (restoreRef) openDocument(taskId, restoreRef);
}

async function openDocument(taskId, ref) {
  const lang = localStorage.getItem('agent-dashboard-lang') || 'zh';
  const dict = i18n[lang] || i18n.zh;
  previewPath.textContent = ref;
  previewBody.textContent = dict.loadingPreview;
  try {
    const response = await fetch('/api/preview?path=' + encodeURIComponent(ref), { headers: { Accept: 'application/json' } });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || response.statusText);
    let markdown = payload.content;
    if (payload.format === 'json') {
      try { markdown = '# ' + payload.path + '\\n\\n\\x60\\x60\\x60json\\n' + JSON.stringify(JSON.parse(payload.content), null, 2) + '\\n\\x60\\x60\\x60'; } catch (_) {}
    }
    previewBody.innerHTML = renderMarkdown(markdown);
    activeDocument = { content: payload.content, path: payload.path };
    updateDocumentOverview(activeDocument, lang);
    sessionStorage.setItem('agent-dashboard-preview', JSON.stringify({ taskId, ref }));
  } catch (error) {
    previewBody.innerHTML = '<p class="preview-error">' + previewEscape(dict.previewError + ': ' + error.message) + '</p>';
  }
}

document.querySelectorAll('[data-task-id]').forEach((card) => card.addEventListener('click', () => showTask(card.getAttribute('data-task-id'))));
document.getElementById('preview-close').addEventListener('click', () => previewDialog.close());
previewDialog.addEventListener('close', () => sessionStorage.removeItem('agent-dashboard-preview'));
previewDialog.addEventListener('click', (event) => { if (event.target === previewDialog) previewDialog.close(); });
function applyLang(lang) {
  const dict = i18n[lang] || i18n.zh;
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.getAttribute('data-i18n');
    if (dict[key]) node.textContent = dict[key];
  });
  document.querySelectorAll('[data-lang]').forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-lang') === lang));
  document.querySelectorAll('[data-task-id]').forEach((card) => card.setAttribute('aria-label', dict.openPreview + ': ' + card.getAttribute('data-task-id')));
  const closePreview = document.getElementById('preview-close');
  closePreview.setAttribute('aria-label', dict.closePreview);
  closePreview.setAttribute('title', dict.closePreview);
  const next = document.querySelector('[data-next-zh]');
  if (next) next.textContent = lang === 'en' ? next.getAttribute('data-next-en') : next.getAttribute('data-next-zh');
  const why = document.querySelector('[data-why-zh]');
  if (why) why.textContent = lang === 'en' ? why.getAttribute('data-why-en') : why.getAttribute('data-why-zh');
  localStorage.setItem('agent-dashboard-lang', lang);
  refreshOverview(lang);
}
document.querySelectorAll('[data-lang]').forEach((btn) => btn.addEventListener('click', () => applyLang(btn.getAttribute('data-lang'))));
applyLang(localStorage.getItem('agent-dashboard-lang') || 'zh');
try {
  const previewState = JSON.parse(sessionStorage.getItem('agent-dashboard-preview') || 'null');
  if (previewState?.taskId) showTask(previewState.taskId, previewState.ref);
} catch (_) {}
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
