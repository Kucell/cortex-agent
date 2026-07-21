"use strict";

// ─── session-triage (L1 audit-trail Phase 1) ───────────────────────────────────
// Decide whether to open Mission + Run for the current session, and append
// typed events (`human_observation`, `tool_failure`, `investigation_step`)
// to an existing run.  Pure stdlib + spawnSync to management-api (single
// process boundary; management-api already enforces requireGate + safeId).
//
// Why spawnSync (not require)? management-api exports its surface only as
// a CLI binary.  Inlining require() would re-implement command parsing;
// spawning avoids dual maintenance.
//
// Idempotency: `triage` with the same `slug` re-running within 24h skips
// re-opening (presence of `runs/R-<slug>-*.json` in last 24h).
//
// See templates/{zh,en}/.agent/skills/session-triage/SKILL.md

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const AGENT_ROOT = path.join(process.cwd(), ".agent");

// ─── signal detection ─────────────────────────────────────────────────────────

const INVESTIGATION_KEYWORDS = /排查|调试|debug|investigate|探索|为什么|怎么回|看样子|why|how come/i;
const TOOL_FAILURE_HINT = /tool_failure|exit[^0]|stderr|失败|failed/i;
const USER_QUESTION_HINT = /^[\s]*?(为什么|怎么|what|why|how|排查)/i;

function decideOpen(signals, threshold) {
  const turns = Number(signals.turns) || 0;
  const text = String(signals.text || "");
  const toolFailures = Number(signals.tool_failures) || 0;
  const userQuestions = Number(signals.user_questions) || 0;
  const investigation = INVESTIGATION_KEYWORDS.test(text) || TOOL_FAILURE_HINT.test(text);
  const userSignals = USER_QUESTION_HINT.test(text) || userQuestions > 0;

  if (turns < threshold) {
    return { open: false, reason: `turns<${threshold}` };
  }
  if (!investigation && toolFailures === 0 && !userSignals) {
    return { open: false, reason: "no_signal" };
  }
  return { open: true, reason: "investigation_or_failure" };
}

// ─── id allocation ───────────────────────────────────────────────────────────

function listIds(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => {
      const m = name.match(/(\d+)/);
      return m ? Number(m[1]) : 0;
    })
    .filter((n) => n > 0);
}

function nextMissionId() {
  return listIds(path.join(AGENT_ROOT, "missions"), /^M-/) + 1;
}

function slugifyRunId(text) {
  // ASCII-only — macOS filenames accept CJK but the run-id is also used
  // as a filesystem prefix, a graphql field, and a wire-protocol header,
  // all of which prefer ASCII. Non-ASCII becomes '-'.
  const slug = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "session";
}

function nextRunId(slug) {
  // Pattern R-<slug>-NNN to allow multiple runs under same slug, with a
  // numeric suffix that increases past collisions.
  const safeSlug = slugifyRunId(slug);
  const runsDir = path.join(AGENT_ROOT, "runs");
  let existing = [];
  try { existing = fs.readdirSync(runsDir); } catch { return `R-${safeSlug}-001`; }
  const nums = existing
    .filter((name) => name.startsWith(`R-${safeSlug}-`))
    .map((name) => Number(name.match(/-(\d+)\.json$/)?.[1] || 0))
    .filter((n) => n > 0);
  const max = nums.length ? Math.max(...nums) : 0;
  return `R-${safeSlug}-${String(max + 1).padStart(3, "0")}`;
}

// ─── idempotency check (24h) ──────────────────────────────────────────────────

function recentlyOpened(slug, hoursWindow = 24) {
  // slug here has already been slugified; we pass the raw text + slugify
  // here defensively so any caller passing either form lands on the same
  // filesystem prefix.
  const safeSlug = slugifyRunId(slug);
  const runsDir = path.join(AGENT_ROOT, "runs");
  if (!fs.existsSync(runsDir)) return false;
  const cutoff = Date.now() - hoursWindow * 60 * 60 * 1000;
  return fs
    .readdirSync(runsDir)
    .filter((name) => name.startsWith(`R-${safeSlug}-`))
    .some((name) => {
      try {
        const stat = fs.statSync(path.join(runsDir, name));
        return stat.mtimeMs >= cutoff;
      } catch {
        return false;
      }
    });
}

// ─── management-api shim ─────────────────────────────────────────────────────

function callMgmt(args) {
  // Use a sibling env var to ensure spawn picks the right cwd.  mgmt already
  // resolves `.agent` from cwd so this is a no-op for it.
  const script = path.join(AGENT_ROOT, "skills", "management-api", "scripts", "index.js");
  if (!fs.existsSync(script)) {
    return { ok: false, error: "management_api_missing", stdout: "", stderr: "" };
  }
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  let body = {};
  try {
    body = JSON.parse(result.stdout || "{}");
  } catch (_) {
    body = { ok: false, error: "unparseable_response", raw: result.stdout };
  }
  return body;
}

function nextIdCheck() {
  // Defensive: .agent/ must exist in cwd; if not, all calls no-op.
  return fs.existsSync(AGENT_ROOT);
}

// ─── mission folder scaffold ─────────────────────────────────────────────────

function writeMissionScaffold(missionId, signals, runId) {
  const missionDir = path.join(AGENT_ROOT, "missions", missionId);
  fs.mkdirSync(missionDir, { recursive: true });
  const goal = String(signals.text || "(no user text yet)").slice(0, 280);
  const ts = new Date().toISOString();
  fs.writeFileSync(
    path.join(missionDir, "mission-plan.md"),
    `# ${missionId}\n\n` +
      `> **Goal**: ${goal}\n` +
      `> **Current State**: session just opened by session-triage (turns=${signals.turns ?? "?"}, tool_failures=${signals.tool_failures ?? 0}).\n` +
      `> **Investigation Log**: see \`.agent/runs/${runId}.json\` events.\n` +
      `> **Acceptance**: 1) reproduce / explain issue; 2) document fix or handoff to \`handoffs/H-${missionId}.md\`.\n\n` +
      `---\n\n` +
      `_auto-generated by session-triage at ${ts}_\n`,
    "utf8",
  );
  fs.mkdirSync(path.join(missionDir, "milestones"), { recursive: true });
  return missionDir;
}

// ─── CLI dispatch ────────────────────────────────────────────────────────────

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

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

function main() {
  const argv = process.argv.slice(2);
  const [command] = argv;

  // ─── triage ────────────────────────────────────────────────────────────
  if (command === "triage") {
    if (!nextIdCheck()) fail("agent_missing", "Run from a project root with .agent initialized.");
    const threshold = Number(flag("--threshold", argv) || 3);
    const signalFile = flag("--signal-file", argv);
    const signals = signalFile
      ? JSON.parse(fs.readFileSync(signalFile, "utf8"))
      : readStdinJson();
    const decision = decideOpen(signals, threshold);

    if (!decision.open) {
      emit({ ok: true, open: false, reason: decision.reason });
      return;
    }

    const slug = slugifyRunId(signals.text);
    if (recentlyOpened(slug)) {
      emit({ ok: true, open: false, reason: "slug_already_recent", slug });
      return;
    }

    const missionId = `M-${String(nextMissionId()).padStart(3, "0")}`;
    const runId = nextRunId(slug);
    writeMissionScaffold(missionId, signals, runId);

    // Create run with triage phase marker.
    const upsert = callMgmt([
      "runs",
      "upsert",
      "--gate",
      "user",
      "--run-id",
      runId,
      "--kind",
      "investigate",
      "--status",
      "running",
      "--phase",
      "triage",
      "--mission-id",
      missionId,
    ]);
    if (!upsert.ok) {
      fail("run_upsert_failed", upsert.error || upsert.stderr || "see run upsert output");
    }

    // Append an investigation_step event marking the triage decision.
    callMgmt([
      "runs",
      "event",
      "--gate",
      "user",
      "--run-id",
      runId,
      "--type",
      "investigation_step",
      "--message",
      `session-triage opened ${missionId}: ${decision.reason}`,
    ]);

    emit({
      ok: true,
      open: true,
      reason: decision.reason,
      mission_id: missionId,
      run_id: runId,
      slug,
    });
    return;
  }

  // ─── observe / record-tool / step — shared shape ───────────────────────
  if (command === "observe" || command === "step") {
    if (!nextIdCheck()) fail("agent_missing", "Run from a project root with .agent initialized.");
    const runId = flag("--run-id", argv);
    if (!runId) fail("missing_run_id", "--run-id is required.");
    const message = flag("--message", argv);
    if (!message) fail("missing_message", "--message is required.");
    const phase = flag("--phase", argv) || null;
    const type = command === "observe" ? "human_observation" : "investigation_step";
    const args = ["runs", "event", "--gate", "user", "--run-id", runId, "--type", type, "--message", message];
    if (phase) args.push("--phase", phase);
    const out = callMgmt(args);
    if (!out.ok) fail("event_append_failed", out.error || "see run event output");
    emit({ ok: true, action: `runs event (${type})`, run_id: runId, message });
    return;
  }

  if (command === "record-tool") {
    if (!nextIdCheck()) fail("agent_missing", "Run from a project root with .agent initialized.");
    const runId = flag("--run-id", argv);
    const tool = flag("--tool", argv);
    const exitCode = Number(flag("--exit", argv) || 1);
    const stderr = flag("--stderr", argv) || "";
    const phase = flag("--phase", argv) || null;
    if (!runId || !tool) fail("missing_args", "--run-id and --tool are required.");
    const message = `tool=${tool} exit=${exitCode} stderr="${stderr.slice(0, 200)}"`;
    const args = ["runs", "event", "--gate", "user", "--run-id", runId, "--type", "tool_failure", "--message", message];
    if (phase) args.push("--phase", phase);
    const out = callMgmt(args);
    if (!out.ok) fail("event_append_failed", out.error || "see run event output");
    emit({ ok: true, action: "runs event (tool_failure)", run_id: runId, message });
    return;
  }

  fail(
    "unknown_command",
    "Usage: node session-triage/index.js {triage|observe|record-tool|step}",
  );
}

if (require.main === module) main();
module.exports = {
  decideOpen,
  nextMissionId,
  nextRunId,
  slugifyRunId,
  recentlyOpened,
  writeMissionScaffold,
};
