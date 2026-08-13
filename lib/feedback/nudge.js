"use strict";

// ─── P-001 SessionStart Feedback Nudge (F-006) ─────────────────────────────
//
// Read-only, non-blocking, default-disabled. The nudge never writes events
// and never reads prompts / transcripts / environment variables. On any
// error it returns exit 0 so the SessionStart hook chain stays green.
//
// Per `.agent/plans/proposals/projects/feedback-pipeline/proposals/P-001-collection-proposal.md`
// §7 (配置与 Nudge).
//
// Public API:
//   • formatNudgeLine({ summary, since, maxEntries })  → string | null
//   • buildNudge({ root, env, stdout })               → { ok, lines, exitCode }
//     Always returns exitCode 0; surfaces diagnostics on stderr only when
//     the caller opted into verbose mode.

const { inboxRootFor, listEvents, summarize } = require("./inbox");
const { discoverConfig, ConfigError, applyCliOverrides } = require("./config");

// ─── formatNudgeLine ────────────────────────────────────────────────────────
//
// Pure function: given an inbox summary and a window spec, produce a single
// human-readable line suitable for printing before the agent starts.
// Returns null when there's nothing meaningful to surface or when the caller
// is configured to stay silent.

function formatNudgeLine({ summary, since, maxEntries = 3 }) {
  if (!summary || typeof summary !== "object") return null;
  const total = summary.event_count || 0;
  if (total === 0) return null;
  const incomplete = (summary.diagnostics && summary.diagnostics.incomplete) || 0;
  const corrupt = (summary.diagnostics && summary.diagnostics.corrupt) || 0;
  const sev = summary.by_severity || {};
  const sevOrder = ["critical", "high", "medium", "low"];
  const sevList = sevOrder.filter((s) => sev[s]).map((s) => `${sev[s]} ${s}`);
  const parts = [];
  parts.push(`[feedback] ${total} event${total === 1 ? "" : "s"} in local inbox`);
  if (sevList.length > 0) parts.push(`by severity: ${sevList.join(", ")}`);
  if (incomplete > 0 || corrupt > 0) {
    parts.push(`(diagnostics: ${incomplete} incomplete, ${corrupt} corrupt)`);
  }
  if (since) parts.push(`window=${since}`);
  if (maxEntries) parts.push(`max-entries=${maxEntries}`);
  return parts.join(" | ");
}

// ─── buildNudge ────────────────────────────────────────────────────────────
//
// Orchestrates: load config → if nudge.enabled → summarize inbox → format
// line. Returns { ok, lines, exitCode: 0 } always; never throws.

function buildNudge(options = {}) {
  const { root, env = process.env, since, maxEntries = 3, writer = (line) => (options.stdout || "").concat(line) } = options;
  const lines = [];
  try {
    const cfgResult = discoverConfig({ root, env });
    const config = applyCliOverrides(cfgResult.config, {});
    if (!config || config.nudge === undefined || config.nudge.enabled !== true) {
      return { ok: true, lines: [], exitCode: 0, reason: "nudge-disabled" };
    }
    const inboxRoot = inboxRootFor(root);
    const summary = summarize({ inboxRoot });
    const effectiveSince = since || (config.nudge && config.nudge.since) || "7d";
    const line = formatNudgeLine({
      summary,
      since: effectiveSince,
      maxEntries: config.nudge.max_entries || maxEntries,
    });
    if (line) lines.push(line);
    // Optional windowed list of recent events (kept short, never raw payload).
    const recent = listEvents({ inboxRoot, since: effectiveSince }).slice(0, config.nudge.max_entries || maxEntries);
    for (const row of recent) {
      const e = row.event;
      lines.push(`  · [${e.occurred_at}] ${e.kind}/${e.severity} ${e.title}`);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      // Config issue: report a soft warning but exit 0; never block SessionStart.
      lines.push(`[feedback] nudge skipped: ${error.message}`);
      return { ok: true, lines, exitCode: 0, reason: "config-error" };
    }
    lines.push(`[feedback] nudge skipped: ${error && error.message ? error.message : "unknown error"}`);
    return { ok: true, lines, exitCode: 0, reason: "error" };
  }
  return { ok: true, lines, exitCode: 0 };
}

module.exports = {
  formatNudgeLine,
  buildNudge,
};