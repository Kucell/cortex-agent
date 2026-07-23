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

function parseTaskProgress(text) {
  const source = String(text || "");
  const activeSection = (
    source.match(/##\s*[^\n]*(?:当前活跃任务|Active Tasks)[^\n]*\n([\s\S]*?)(?=\n##\s|\n---\s*$|$)/i)
    || []
  )[1] || "";
  const tableTasks = activeSection.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || /^\|\s*:?-{3,}/.test(trimmed)) return [];
    const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells.length < 4 || /任务\s*ID|Task\s*ID/i.test(cells[0])) return [];
    const task = taskFromTableCells(cells);
    return task ? [task] : [];
  });
  if (tableTasks.length) return tableTasks;

  const seen = new Set();
  return source.split(/\r?\n/).flatMap((line) => {
    const id = (line.match(/\bT-[A-Za-z0-9-]+\b/) || [])[0];
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const done = /\[[xX]\]|✅|完成|Done/i.test(line);
    const blocked = hasExplicitTaskBlock(line);
    const active = /active|进行中|in[- ]progress|当前/i.test(line);
    const sourceRefs = extractMarkdownRefs(line);
    return [{
      id,
      title: line.replace(/^\s*[-*]\s*/, "").replace(/\*\*/g, "").slice(0, 180),
      priority: "",
      progress: "",
      plan: "",
      source_refs: sourceRefs.length ? sourceRefs : [".agent/plans/task-progress.md"],
      status: done ? "done" : blocked ? "blocked" : active ? "active" : "open",
      validation_status: validationStatusFromText(line),
    }];
  });
}

module.exports = {
  extractMarkdownRefs,
  hasExplicitTaskBlock,
  parseTaskProgress,
  validationStatusFromText,
};
