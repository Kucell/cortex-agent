"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const GENERATOR = path.join(ROOT, ".agent", "skills", "agent-dashboard", "scripts", "generate.js");
const MARKDOWN_IT = path.join(ROOT, ".agent", "skills", "agent-dashboard", "vendor", "markdown-it.min.js");

function project(fixture) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dashboard-communication-"));
  const dashboardDir = path.join(cwd, ".agent", "skills", "agent-dashboard", "scripts");
  const managementDir = path.join(cwd, ".agent", "skills", "management-api", "scripts");
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.mkdirSync(managementDir, { recursive: true });
  fs.copyFileSync(GENERATOR, path.join(dashboardDir, "generate.js"));
  const taskScripts = path.join(cwd, ".agent", "tasks", "scripts");
  fs.mkdirSync(taskScripts, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, "templates", "_shared", ".agent", "tasks", "scripts", "task-state.js"),
    path.join(taskScripts, "task-state.js"),
  );
  const vendorDir = path.join(cwd, ".agent", "skills", "agent-dashboard", "vendor");
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.copyFileSync(MARKDOWN_IT, path.join(vendorDir, "markdown-it.min.js"));
  fs.writeFileSync(
    path.join(managementDir, "index.js"),
    `process.stdout.write(${JSON.stringify(JSON.stringify(fixture))});\n`,
    "utf8",
  );
  return cwd;
}

function generate(cwd) {
  const script = path.join(cwd, ".agent", "skills", "agent-dashboard", "scripts", "generate.js");
  const result = spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return {
    result: JSON.parse(result.stdout),
    html: fs.readFileSync(path.join(cwd, ".agent", "metrics", "agent-dashboard.html"), "utf8"),
  };
}

function baseFixture() {
  return {
    ok: true,
    tasks: Array.from({ length: 7 }, (_, index) => ({ id: `T-${index + 1}`, title: "blocked task", status: "blocked" })),
    worktrees: [],
    agents: [],
    runs: [],
    queues: [],
    sessions: [{ session_id: "S-dashboard", agent_id: "dashboard-manager", role: "dashboard-manager", status: "running", phase: "running_command", last_heartbeat_at: "2026-07-17T10:11:12Z" }],
    locks: [],
    handoffs: [],
    artifacts: [],
    prds: [],
    prd_summary: { status: "not_started", completeness: 0, missing: [] },
    git_status: "",
  };
}

test("renders bilingual read-only communication and approval state from Management API", (t) => {
  const fixture = {
    ...baseFixture(),
    inbox: [{
      message_id: "IM-001",
      type: "decision_request",
      status: "unread",
      sender_id: "planner-agent",
      subject: "Review integration order",
      updated_at: "2026-07-17T10:11:12",
    }],
    decisions: [
      { decision_id: "D-001", type: "merge", status: "open", requested_by: "mission-agent", gate: { action: "merge", resource_ref: "refs/heads/integration" }, updated_at: "2026-07-17T10:12:13" },
      { decision_id: "D-002", type: "release", status: "open", requested_by: "release-agent", gate: { action: "release", resource_ref: "release/v1.5" }, updated_at: "2026-07-17T10:13:14" },
      { decision_id: "D-closed", type: "risk", status: "approved", requested_by: "risk-agent", gate: { action: "external_side_effect", resource_ref: "external/api" }, updated_at: "2026-07-17T10:14:15" },
    ],
    waitpoints: [
      { waitpoint_id: "WP-001", status: "pending", effective_status: "blocked", owner_workflow: "/checkpoint-merge", gate: { action: "merge", resource_ref: "refs/heads/integration" }, updated_at: "2026-07-17T10:15:16" },
      { waitpoint_id: "WP-released", status: "released", effective_status: "released", owner_workflow: "/ship", gate: { action: "release", resource_ref: "release/v1.4" }, updated_at: "2026-07-17T10:16:17" },
    ],
    summary: { unread_messages: 1, open_decisions: 2, blocking_waitpoints: 1 },
    derived: { state: "blocked", next: "stale value", nextEn: "stale value", why: "stale value", whyEn: "stale value" },
  };
  const cwd = project(fixture);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const { result, html } = generate(cwd);

  assert.equal(result.state, "waiting_approval");
  assert.match(html, /<span class="pill waiting_approval">waiting_approval<\/span>/);
  assert.match(html, /data-i18n="openDecisions">待决决策<\/span><strong>2<\/strong>/);
  assert.match(html, /data-i18n="blockingWaitpoints">阻塞等待点<\/span><strong>1<\/strong>/);
  assert.doesNotMatch(html, /data-i18n="openDecisions">待决决策<\/span><strong>7<\/strong>/);

  for (const marker of ["通信与审批", "Communication & Approvals", "Inbox", "待决决策", "Open Decisions", "阻塞等待点", "Blocking Waitpoints"]) {
    assert.ok(html.includes(marker), `missing bilingual marker: ${marker}`);
  }
  for (const value of ["IM-001", "D-001", "D-002", "WP-001", "refs/heads/integration", "mission-agent", "/checkpoint-merge", "2026-07-17 10:15:16"]) {
    assert.ok(html.includes(value), `missing read model value: ${value}`);
  }
  assert.ok(!html.includes("D-closed"), "resolved Decisions must not appear in Open Decisions");
  assert.ok(!html.includes("WP-released"), "released Waitpoints must not appear in Blocking Waitpoints");

  const languageButtons = [...html.matchAll(/<button\b[^>]*data-lang="[^"]+"[^>]*>(.*?)<\/button>/g)].map((match) => match[1]);
  assert.deepEqual(languageButtons, ["中文", "EN"]);
  assert.doesNotMatch(html, /decisions\s+resolve|waitpoints\s+release|management-api[^<]*(approve|release)/i);
  assert.doesNotMatch(html, /location\.reload\s*\(/);
  assert.match(html, /\.panel\{[^}]*min-width:0;overflow-x:auto\}/);
  assert.match(html, /<td data-volatile="heartbeat">/);
});

test("degrades missing communication fields to empty read-only sections", (t) => {
  const cwd = project(baseFixture());
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const { result, html } = generate(cwd);

  assert.equal(result.state, "blocked");
  assert.match(html, /id="communication"/);
  assert.match(html, /data-i18n="openDecisions">待决决策<\/h2><span class="mini">0<\/span>/);
  assert.match(html, /data-i18n="blockingWaitpoints">阻塞等待点<\/h2><span class="mini">0<\/span>/);
  assert.ok((html.match(/data-i18n="empty"/g) || []).length >= 3);
});

test("task cards open a read-only Markdown preview with related proposals and tasks", (t) => {
  const fixture = {
    ...baseFixture(),
    tasks: [{
      id: "T-preview",
      title: "Preview task",
      status: "active",
      priority: "P1",
      progress: "40%",
      source_refs: [".agent/plans/proposals/preview/preview-proposal.md"],
      dependencies: ["T-related"],
    }],
  };
  const cwd = project(fixture);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const proposalDir = path.join(cwd, ".agent", "plans", "proposals", "preview");
  fs.mkdirSync(proposalDir, { recursive: true });
  fs.writeFileSync(path.join(proposalDir, "preview-proposal.md"), "# Preview proposal\n\nImplements T-preview.\n", "utf8");

  const { html } = generate(cwd);

  assert.match(html, /class="task-card"[^>]*role="button"[^>]*data-task-id="T-preview"/);
  assert.match(html, /id="preview-dialog"/);
  assert.match(html, /id="overview-text"/);
  assert.match(html, /Content Overview/);
  assert.doesNotMatch(html, /id="related-docs"/);
  assert.ok(html.includes(".agent/plans/proposals/preview/preview-proposal.md"));
  assert.ok(html.includes("T-related"));
  assert.match(html, /fetch\('\/api\/preview\?path='/);
  assert.match(html, /function renderMarkdown\(markdown\)/);
  assert.match(html, /cortex_document_references/);
  assert.match(html, /function resolvePreviewReference\(href, currentPath\)/);
  assert.match(html, /#preview-body a\[data-markdown-reference\]/);
  assert.match(html, /window\.__cortexPreviewPath = data\.path/);
  assert.match(html, /data-vendor="markdown-it@14\.3\.0"/);
  assert.match(html, /window\.markdownit\(\{ html: false/);
  assert.match(html, /class="markdown-body"/);
  assert.match(html, /function documentOverview\(content, path, lang\)/);
  assert.match(html, /function loadPreview\(path\)/);
  assert.match(html, /task\.refs && task\.refs\[0\]/);
  assert.match(html, /event\.key !== 'Enter'/);
  assert.match(html, /The goal is: Preview task/);
  assert.match(html, /dict\.openPreview/);
  const browserScript = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
  assert.ok(browserScript, "missing dashboard browser script");
  assert.doesNotThrow(() => new vm.Script(browserScript));
  assert.doesNotMatch(html, /<button[^>]+(?:approve|release|resolve)/i);

  const resolverStart = html.indexOf("function resolvePreviewReference");
  const resolverEnd = html.indexOf("function scrollPreviewAnchor", resolverStart);
  const resolverSource = html.slice(resolverStart, resolverEnd);
  const context = {};
  vm.runInNewContext(resolverSource, context);
  assert.deepEqual(
    { ...context.resolvePreviewReference("../../plans/proposal.md#Goal", ".agent/missions/M-001/mission-plan.md") },
    { path: ".agent/plans/proposal.md", hash: "Goal" },
  );
  assert.deepEqual(
    { ...context.resolvePreviewReference(".agent/references/guide.md", ".agent/missions/M-001/mission-plan.md") },
    { path: ".agent/references/guide.md", hash: "" },
  );
  assert.deepEqual(
    { ...context.resolvePreviewReference("#Scope", ".agent/missions/M-001/mission-plan.md") },
    { path: "", hash: "Scope" },
  );
  assert.equal(context.resolvePreviewReference("https://example.com", ".agent/missions/M-001/mission-plan.md"), null);
  assert.equal(context.resolvePreviewReference("../../../../escape.md", ".agent/missions/M-001/mission-plan.md"), null);

  const renderStart = html.indexOf("function renderMarkdown");
  const renderEnd = html.indexOf("function resolvePreviewReference", renderStart);
  const renderContext = { window: {} };
  renderContext.self = renderContext.window;
  vm.createContext(renderContext);
  vm.runInContext(fs.readFileSync(MARKDOWN_IT, "utf8"), renderContext);
  renderContext.window.markdownit = renderContext.markdownit;
  vm.runInContext(html.slice(renderStart, renderEnd), renderContext);
  const linkedPath = renderContext.renderMarkdown("Source: `.agent/plans/proposal.md`");
  assert.match(linkedPath, /<a href="\.agent\/plans\/proposal\.md" data-markdown-reference="true"><code>\.agent\/plans\/proposal\.md<\/code><\/a>/);
});

test("task table Markdown links become preview references when API tasks omit them", (t) => {
  const fixture = { ...baseFixture(), tasks: [{ id: "T-linked", title: "Linked task", status: "active" }] };
  const cwd = project(fixture);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const plansDir = path.join(cwd, ".agent", "plans");
  fs.mkdirSync(path.join(plansDir, "proposals", "linked"), { recursive: true });
  fs.writeFileSync(path.join(plansDir, "task-progress.md"), [
    "| ID | Priority | Task | Progress | Plan |",
    "| --- | --- | --- | --- | --- |",
    "| T-linked | P1 | Linked task | 20% | [Proposal](proposals/linked/proposal.md) |",
  ].join("\n"), "utf8");

  const { html } = generate(cwd);
  assert.ok(html.includes(".agent/plans/proposals/linked/proposal.md"));
});

test("Markdown validation outcomes render as evidence without blocking active tasks", (t) => {
  const fixture = { ...baseFixture(), tasks: null };
  const cwd = project(fixture);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const plansDir = path.join(cwd, ".agent", "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, "task-progress.md"), [
    "# Task progress",
    "",
    "## Active Tasks",
    "",
    "| Task ID | Priority | Task | Progress | Plan |",
    "| --- | --- | --- | --- | --- |",
    "| M-005 | P1 | Observability | 94% | VC-017 PARTIAL |",
    "| T-004 | P1 | Target benchmark | 65% | Target environments NOT_RUN |",
  ].join("\n"), "utf8");

  const { result, html } = generate(cwd);
  assert.notEqual(result.state, "blocked");
  assert.match(html, /data-task-id="M-005"[\s\S]*?<span class="pill partial">PARTIAL<\/span>/);
  assert.match(html, /data-task-id="T-004"[\s\S]*?<span class="pill not_run">NOT_RUN<\/span>/);
  assert.match(html, /data-i18n="blocked">阻塞<\/span> <span class="mini">0<\/span>/);
});
