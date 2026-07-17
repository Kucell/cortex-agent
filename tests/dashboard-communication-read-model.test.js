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

function project(fixture) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dashboard-communication-"));
  const dashboardDir = path.join(cwd, ".agent", "skills", "agent-dashboard", "scripts");
  const managementDir = path.join(cwd, ".agent", "skills", "management-api", "scripts");
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.mkdirSync(managementDir, { recursive: true });
  fs.copyFileSync(GENERATOR, path.join(dashboardDir, "generate.js"));
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

  assert.match(html, /class="task-card" data-task-id="T-preview"/);
  assert.match(html, /id="preview-dialog"/);
  assert.match(html, /id="overview-text"/);
  assert.match(html, /Content Overview/);
  assert.match(html, /Related Documents &amp; Proposals|Related Documents & Proposals/);
  assert.ok(html.includes(".agent/plans/proposals/preview/preview-proposal.md"));
  assert.ok(html.includes("T-related"));
  assert.match(html, /fetch\('\/api\/preview\?path='/);
  assert.match(html, /function renderMarkdown\(markdown\)/);
  assert.match(html, /function documentOverview\(content, path, lang\)/);
  assert.match(html, /The goal is: Preview task/);
  assert.match(html, /dict\.openPreview/);
  const browserScript = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
  assert.ok(browserScript, "missing dashboard browser script");
  assert.doesNotThrow(() => new vm.Script(browserScript));
  assert.doesNotMatch(html, /<button[^>]+(?:approve|release|resolve)/i);
});
