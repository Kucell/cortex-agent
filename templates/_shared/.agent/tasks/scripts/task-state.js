"use strict";

const path = require("path");

function validationStatusFromText(value) {
  const matches = [...String(value || "").matchAll(/\b(NOT_RUN|PARTIAL|PASS|FAIL)\b/gi)];
  return matches.length ? matches[matches.length - 1][1].toUpperCase() : "";
}

function hasExplicitTaskBlock(value) {
  const text = String(value || "")
    .replace(/\b(?:not[- ]blocked|non[- ]blocking)\b/gi, "")
    .replace(/(?:不|非|未)(?:会|应)?阻塞/g, "");
  return /\[(?:blocked|阻塞|暂停)\]|(?:status|状态)\s*[:：=]\s*(?:blocked|阻塞|暂停)|(?:^|[|;；])\s*(?:blocked|阻塞|暂停)\s*(?:$|[|;；])|⚠️|❌/i.test(text);
}

function extractMarkdownRefs(...values) {
  const refs = [];
  const seen = new Set();
  for (const value of values) {
    for (const match of String(value || "").matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const raw = match[1].trim().replace(/^<|>$/g, "").split(/[?#]/)[0];
      if (!raw || raw.startsWith("/") || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
      const normalized = path.posix.normalize(
        raw.startsWith(".agent/") || raw.startsWith("docs/")
          ? raw
          : path.posix.join(".agent/plans", raw),
      );
      if (normalized.startsWith("../") || seen.has(normalized)) continue;
      seen.add(normalized);
      refs.push(normalized);
    }
  }
  return refs;
}

function taskFromTableCells(cells) {
  const id = (cells[0].match(/\b(?:T|M)-[A-Za-z0-9-]+\b/) || [])[0];
  if (!id) return null;
  const joined = cells.join(" ");
  const progressMatch = cells[3].match(/(\d+(?:\.\d+)?)\s*%/);
  const progressValue = progressMatch ? Number(progressMatch[1]) : null;
  const blocked = hasExplicitTaskBlock(joined);
  const done = progressValue === 100 || /\[[xX]\]|完成|Done|已合入|PASS/i.test(cells[3]);
  const active = !done && !blocked && (
    progressValue !== null && progressValue > 0
    || /active|进行中|in[- ]progress|当前/i.test(joined)
  );
  const sourceRefs = extractMarkdownRefs(cells[2], cells[3], cells[4]);
  return {
    id,
    priority: cells[1] || "",
    title: cells[2] || id,
    progress: progressMatch ? `${progressMatch[1]}%` : cells[3] || "",
    plan: cells[4] || "",
    source_refs: sourceRefs.length ? sourceRefs : [".agent/plans/task-progress.md"],
    status: done ? "done" : blocked ? "blocked" : active ? "active" : "open",
    validation_status: validationStatusFromText(joined),
  };
}

const ACTIVE_SECTION_HEADING_RE = /##\s*[^\n]*(?:当前活跃任务|Active Tasks)[^\n]*\n/gi;

// MS-1 (task-state-truth-source): long-lived files may contain the active-tasks
// heading more than once. Collect every section and let the LAST one yielding
// task rows win ("later write is newer"). A file that has the heading but no
// parseable task table is malformed and must NOT drop into the whole-file
// fallback — that path is what produced phantom tasks from history log lines.
function collectActiveSections(source) {
  const sections = [];
  for (const match of source.matchAll(ACTIVE_SECTION_HEADING_RE)) {
    const rest = source.slice(match.index + match[0].length);
    const end = rest.search(/\n##\s|\n---\s*$/);
    sections.push(end >= 0 ? rest.slice(0, end) : rest);
  }
  return sections;
}

function tasksFromActiveSection(section) {
  return section.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || /^\|\s*:?-{3,}/.test(trimmed)) return [];
    const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells.length < 4 || /任务\s*ID|Task\s*ID/i.test(cells[0])) return [];
    const task = taskFromTableCells(cells);
    return task ? [task] : [];
  });
}

function fallbackTaskScan(source) {
  const seen = new Set();
  const tasks = [];
  let inFence = false;
  for (const line of source.split(/\r?\n/)) {
    // History logs live in blockquotes and code fences; neither is a task list.
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence || /^\s*>/.test(line)) continue;
    const id = (line.match(/\bT-[A-Za-z0-9-]+\b/) || [])[0];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const done = /\[[xX]\]|✅|完成|Done/i.test(line);
    const blocked = hasExplicitTaskBlock(line);
    const active = /active|进行中|in[- ]progress|当前/i.test(line);
    const sourceRefs = extractMarkdownRefs(line);
    tasks.push({
      id,
      title: line.replace(/^\s*[-*]\s*/, "").replace(/\*\*/g, "").slice(0, 180),
      priority: "",
      progress: "",
      plan: "",
      source_refs: sourceRefs.length ? sourceRefs : [".agent/plans/task-progress.md"],
      status: done ? "done" : blocked ? "blocked" : active ? "active" : "open",
      validation_status: validationStatusFromText(line),
    });
  }
  return tasks;
}

function parseTaskProgress(text) {
  const source = String(text || "");
  const sections = collectActiveSections(source);
  if (sections.length) {
    let tableTasks = [];
    for (const section of sections) {
      const rows = tasksFromActiveSection(section);
      if (rows.length) tableTasks = rows;
    }
    if (tableTasks.length) return tableTasks;
    // Non-enumerable diagnostics keep array shape and JSON output unchanged.
    return Object.defineProperties([], {
      malformed: { value: true },
      diagnostics: { value: "active_tasks_section_malformed" },
    });
  }
  return fallbackTaskScan(source);
}

module.exports = {
  extractMarkdownRefs,
  hasExplicitTaskBlock,
  parseTaskProgress,
  validationStatusFromText,
};
