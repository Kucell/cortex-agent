"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, ".agent", "skills", "agent-dashboard", "scripts", "generate.js");
const OUT = path.join(ROOT, ".agent/metrics/agent-dashboard.html");

// Generate once (against real cortex-agent state) and reuse across tests
function runGenerate() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  execFileSync("node", [SCRIPT, "--out", OUT], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
  return fs.readFileSync(OUT, "utf8");
}

const HTML = runGenerate();

// === 1) Function-level test: load enrichSessionAttachments from generate.js source ===
test("P-002d: enrichSessionAttachments aggregates handoff + artifact counts by current_task_id", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const start = src.indexOf("function enrichSessionAttachments(");
  assert.notEqual(start, -1, "enrichSessionAttachments must be defined");
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  const fnCode = src.slice(start, i);
  const fn = eval("(function(){" + fnCode + "; return enrichSessionAttachments;})()");

  const sessions = [
    { session_id: "S-A", current_task_id: "T-A" },
    { session_id: "S-B", current_task_id: "T-B" },
    { session_id: "S-C" },
  ];
  const handoffs = [{ task_id: "T-A" }, { task_id: "T-A" }, { task_id: "T-B" }];
  const artifacts = [{ task_id: "T-A", count: 1 }, { task_id: "T-B", count: 3 }];
  const result = fn(sessions, handoffs, artifacts);
  assert.equal(result.length, 3);
  assert.equal(result[0].handoff_count, 2);
  assert.equal(result[0].artifact_count, 1);
  assert.equal(result[1].handoff_count, 1);
  assert.equal(result[1].artifact_count, 3);
  assert.equal(result[2].handoff_count, 0);
  assert.equal(result[2].artifact_count, 0);
});

test("P-002d: enrichSessionAttachments handles empty / null inputs", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const start = src.indexOf("function enrichSessionAttachments(");
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  const fnCode = src.slice(start, i);
  const fn = eval("(function(){" + fnCode + "; return enrichSessionAttachments;})()");
  assert.deepEqual(fn([], [], []), []);
  assert.deepEqual(fn(null, [], []), []);
  assert.deepEqual(fn(undefined, null, null), []);
});

// === 2) HTML-level tests using real dashboard ===
test("P-002d: sessions panel renders 7 columns (agent, role, status, phase, metadata, attachments, heartbeat)", () => {
  const panelStart = HTML.indexOf('data-i18n="sessions">');
  assert.notEqual(panelStart, -1, "sessions panel must exist");
  const theadEnd = HTML.indexOf("</thead>", panelStart);
  const thead = HTML.slice(panelStart, theadEnd);
  for (const col of ["agent", "role", "status", "phase", "metadata", "attachments", "heartbeat"]) {
    assert.ok(thead.includes("data-i18n=\"" + col + "\""), "missing column: " + col);
  }
});

test("P-002d: zh labels rendered inline: metadata=元数据, attachments=附件, run=运行, worktree=工作树", () => {
  assert.match(HTML, /data-i18n="metadata">元数据</);
  assert.match(HTML, /data-i18n="attachments">附件</);
  assert.match(HTML, /data-i18n="run">运行</);
  assert.match(HTML, /data-i18n="worktree">工作树</);
  assert.match(HTML, /data-i18n="noneAttach">-/);
});

test("P-002d: CSS defines .session-meta, .session-meta-row, .attachments, .attach-badge", () => {
  assert.match(HTML, /\.session-meta\{display:grid/);
  assert.match(HTML, /\.session-meta-row/);
  assert.match(HTML, /\.attachments\{display:flex/);
  assert.match(HTML, /\.attach-badge\{display:inline-block/);
});

test("P-002d: at least one session row renders metadata + attachments cells", () => {
  // Find first session row (not the decisions table tbody which is the first tbody overall)
  const sessionsPanelStart = HTML.indexOf('data-i18n="sessions">');
  assert.notEqual(sessionsPanelStart, -1);
  const tbodyStart = HTML.indexOf("<tbody>", sessionsPanelStart);
  assert.notEqual(tbodyStart, -1, "sessions panel must have tbody");
  const firstRowEnd = HTML.indexOf("</tr>", tbodyStart);
  const firstRow = HTML.slice(tbodyStart, firstRowEnd);
  assert.ok(firstRow.includes("session-meta"), "first session row must include session-meta div");
  const hasBadge = /class="attach-badge"/.test(firstRow);
  const hasEmpty = firstRow.includes('data-i18n="noneAttach">-</span>');
  assert.ok(hasBadge || hasEmpty, "expected attach-badge or noneAttach in first session row");
});
