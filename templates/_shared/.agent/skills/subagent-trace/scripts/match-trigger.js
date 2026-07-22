"use strict";

// ─── match-trigger (L1 subagent-fanout-trace — pure helper) ──────────────────
// Single-purpose pure function: given a free-text user prompt, return
// { matched, language, matchedKeyword } indicating whether the prompt
// is a fan-out directive (中英 first).
//
// This helper is consumed by:
//   - skills/subagent-trace/scripts/index.js (Phase 2 CLI)
//   - host-side adapters (Claude Code / Codex / Cursor) that want a
//     framework-blessed decision on whether to fan out
//   - agent SKILL.md documents that teach agents to detect fan-out
//     intents from the user's text
//
// Aligned with templates/{zh,en}/.agent/agent-protocols/subagent-fanout.md
// (Phase 1 protocol).  Add a keyword there + extend this function when
// you see a new genuine fan-out expression in the wild.

const KEYWORDS = {
  en: [
    "fan out",
    "fan-out",
    "subagent",
    "spawn agent",
    "parallel agents",
    "delegate",
  ],
  zh: [
    "分发子任务",
    "分发",
    "并行 agent",
    "并行子 agent",
    "并行 3 个",
    "并行 4 个",
    "子 agent 调查",
    "fan out 中文",
    "fàn chū",
    "派 3 个 agent",
  ],
};

// Normalize whitespace and case-fold for the comparison.  We want the
// user to type "Fan  out" or "FAN OUT" and still match.
function normalize(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchFanoutTrigger(text) {
  const normalized = normalize(text).toLowerCase();
  if (!normalized) return { matched: false, language: null, matchedKeyword: null };
  // zh first (the project is zh-first).  Mixed phrases like
  // "fan out 中文" should classify as zh so the dashboard shows
  // zh labels.  en-only phrases like "fan out 3 agents" still
  // match en, since they don't contain any zh keyword.
  for (const language of ["zh", "en"]) {
    for (const kw of (KEYWORDS[language] || [])) {
      if (normalized.includes(kw.toLowerCase())) {
        return { matched: true, language, matchedKeyword: kw };
      }
    }
  }
  return { matched: false, language: null, matchedKeyword: null };
}

// Convenience: list the keywords for a given language.  Hosts can use
// this for "did the framework just learn a new phrase?" introspection.
function listKeywords(language) {
  if (!language) return { en: KEYWORDS.en, zh: KEYWORDS.zh };
  return { [language]: KEYWORDS[language] || [] };
}

module.exports = { matchFanoutTrigger, listKeywords, KEYWORDS, normalize };
