"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawn, spawnSync } = require("child_process");
const {
  attachProject,
  formatQueryPayload,
  invokeManagementProject,
  queryManagementProject,
  resolveManagementProject,
} = require("./management-client");
const cliContract = require("./cli-contract");
const { phaseZeroAutomation } = require("./automation-stubs");
const { executeCoordinationCommand } = require("./coordination/cli");
const { executeNotificationCommand } = require("./coordination/notification-cli");
const { createNotificationHarness } = require("./coordination/notification-host");
const { executeBridgeCommand } = require("./host-event-bridge");
const { buildAnchor, PKG_VERSION: ANCHOR_PKG_VERSION } = require("./anchor");

// T-FOLLOW-002 v2 / module-split: every command-surface function has been
// extracted from this file into a focused module under lib/commands/. The
// public API of lib/commands.js is preserved byte-for-byte via the
// `module.exports` block at the bottom; this file is now a thin re-export
// shell plus a few shared cross-module requires. See also:
//   .agent/workflows/agent-update.md §5 "Test Gate" + "Module Split Gate".
const { applyPatches, writeVersionFile, readVersionFile } = require("./commands/patches");
const { askYesNo } = require("./commands/prompt");
const { writePublicAnchor, exportAnchor } = require("./commands/anchor");
const { init, initModeGeneral } = require("./commands/init");
const { addPlatforms, removePlatforms, listPlatforms } = require("./commands/platform");
const { untrackAgent, trackAgent, linkGlobal } = require("./commands/project");
const { minimaxCliReconcile } = require("./commands/reconcile");
const { cliHelp, printHelp } = require("./commands/help");
const { runSelfCheck, runScriptReconcile, upgrade } = require("./commands/upgrade");
const { doctor } = require("./commands/doctor");
// session.js was extracted from bin/cli.js — bin/cli.js will be updated in a
// follow-up commit to require it from here.
const { runSession, printSessionHelp } = require("./commands/session");
const {
  managementApiError, queryManagementApi, printManagementPayload, invalidManagementUsage,
} = require("./commands/management/api-helpers");
const { managementQuery } = require("./commands/management/query");
const {
  runs, queues, sessions, managementWrite,
  decisions, inbox, waitpoints,
} = require("./commands/management/write");
const { coordination } = require("./commands/management/coordination");
const {
  updateReportJson, updateProjectDescriptor, buildDryRunUpdateReport,
  updateReportId, writeUpdateReport, buildAppliedUpdateReport,
} = require("./commands/update/report");
const {
  collectSemanticMergeCandidates, verificationCheck, parseJsonCheck,
  runNodeJsonCheck, managementQueryCheck, withoutProjectArgs,
  runUpdateVerification, printUpdateVerification,
} = require("./commands/update/verify");
const { normalizeClaudeNativePayload, hook } = require("./commands/surface/hook");
const { mcp } = require("./commands/surface/mcp");
const { agent } = require("./commands/surface/agent");
const { dashboard } = require("./commands/surface/dashboard");
const { notification } = require("./commands/surface/notification");
const { lease } = require("./commands/surface/lease");
const { dispatchDryRun, dispatchExecute } = require("./commands/surface/dispatch");
const { dev } = require("./commands/surface/dev");
const {
  teamUsage, teamResolveProject, teamInit, teamStatus,
  applyPlanToProject, writeConflictArtifact, teamInstall, teamUpdate,
  teamPublish, parsePathsOption, normalizePublishDest, teamVerify, teamDispatch,
} = require("./commands/team-pack");

// Lazy require: keep lib/commands.js startup cheap and avoid loading
// governed-tool (which transitively imports capability-aware-dispatch
// and operation-lifecycle) when only print/help/version are invoked.
let registerMinimaxCliDiscovery = null;
try {
  registerMinimaxCliDiscovery = require("./runtime-adapters/minimax-cli-governed-tool").registerWithInitUpdateDoctor;
} catch (_) {
  registerMinimaxCliDiscovery = null;
}
const { PLATFORM_REGISTRY } = require("./registry");
const scriptManifest = require("./script-manifest");
const PKG_VERSION = require("../package.json").version;

// ─── patch engine — moved to lib/commands/patches.js (T-FOLLOW-002 v2) ──────
// Patch files live in templates/.agent/patches/*.patch.md
// Frontmatter fields:
//   id           – unique patch identifier (stored in .agent/.applied-patches)
//   target       – path relative to .agent/ (use ../ to reach project root)
//   anchor       – string that must NOT already exist in target (idempotency check)
//   insert_after – (optional) insert body after the line containing this string;
//                  if omitted or not found, body is appended to end of file
const {
  getInstalledPlatforms,
  saveInstalledPlatforms,
  getAllGeneratedPaths,
  installPlatform,
  removePlatform,
  selectPlatformsInteractive,
} = require("./platform");
const {
  copyRecursive,
  migrateOldConfigs,
  promoteImportedClaudeContext,
  ensureAgentEntryFile,
  ensureSessionBootstrapEntry,
  ensureGeminiEntryFile,
  ensureClaudeEntryFile,
  ensureAgentHooks,
  ensureClaudeSettings,
  ensureProjectionRegistry,
  ensureProjectAgentReadme,
  linkGlobalConfig,
  needsHookMerge,
  needsProjectionRegistryMerge,
  needsSessionBootstrapMerge,
  ensureCompatibilityAdapterBootstrapEntry,
  needsCompatibilityAdapterBootstrapMerge,
} = require("./setup");
const {
  isGitRepo,
  hasTrackedPath,
  getIgnoreSource,
  resolveGitExcludePath,
  applyGitExclusion,
  untrackGeneratedFilesFromGit,
} = require("./git");

// ─── init ─────────────────────────────────────────────────────────────────────
// ─── export-anchor / writePublicAnchor ────────────────────────────────────────
// The cross-tool anchor is a small, versioned markdown snippet that any AI
// coding tool (Claude Code, Codex, Cursor, Aider, Pi agent, …) can paste into
// its long-term memory. It tells the tool:
//
//   - this project is managed by cortex-agent
//   - the real rules / workflows / skills live in ./AGENTS.md + ./.agent/
//   - prefer cortex-agent CLI / workflows over inventing new scripts
//
// The anchor is written to docs/cortex-agent/anchor.md (in version control)
// by `init`, and can be re-emitted to stdout at any time via `export-anchor`.
// `.agent/` itself is gitignored, so this public anchor is the only way
// other tools can identify a cortex-agent project without installing the CLI.
// ─── add / remove / list ──────────────────────────────────────────────────────
// ─── upgrade ──────────────────────────────────────────────────────────────────
// ─── L1 script reconcile (shared by upgrade / doctor) ──────────────────────────
// Plans or applies safe updates to managed L1 skill scripts. See lib/script-manifest.js.
// apply=false → dry-run (report candidates only). Returns the reconcile report.
// ─── track / untrack ─────────────────────────────────────────────────────────
// ─── doctor ───────────────────────────────────────────────────────────────────
// ─── link-global ─────────────────────────────────────────────────────────────
// ─── minimax-cli reconcile (ARI P-005 / M-011) ────────────────────────────
// Read-only reconcile: re-run the safe-probe and skill discovery, print a
// structured summary.  Never invokes a forbidden mmx subcommand and never
// mutates any host file.
// ─── management queries ──────────────────────────────────────────────────────
// ─── Public ownership lease CLI (FAE-007 / M-013 MS-002) ──────────────
// ─── Dispatch dry-run (FAE-003 / M-013 MS-004) ────────────────────────────
// ─── Dispatch execute (FAE-004 / M-013 MS-005) ────────────────────────────
// ─── lease (Public Ownership Lease CLI) ─────────────────────────────────────
//
// This is intentionally a thin argument adapter over coordination/lease-cli.
// LeaseManager remains the only owner of fencing, TTL, idempotency and durable
// state.  In particular, this command never creates a task or starts a host.
// ─── agent (Host Event Bridge, T-ACN-016) ────────────────────────────────────
// ─── hook ─────────────────────────────────────────────────────────────────────
//
// Public CLI for Claude Code hooks. Routes hook events through the Agent
// Reporter via claude-hook-cli.js (never direct createEvent/submit).
//
// CLI:  cortex-agent hook claude <HookName>  < bounded-stdin.json
//       cortex-agent hook claude <HookName> --stdin <json>
//
// The hook command uses the same .agent-runtime/coordination service root as
// the rest of the coordination CLI. Identity is derived from
// CORTEX_LAUNCH_CONTEXT (context-only, never from CLI args).
//
// Safety contract:
//   - Only "claude" subcommand is supported (extensible for future hosts)
//   - Stdin or --stdin payload is validated, governance fields rejected
//   - SessionStart validates context, never submits (launcher authoritative)
//   - Stop/SubagentStop: nonterminal, never submit events
//   - Receipt: only ok/code/eventType/emitted/timestamp; never sensitive data

// Claude Code sends a host-owned envelope, not the small Cortex hook payload
// used by the internal adapter.  Accepting that envelope verbatim would either
// reject every real hook invocation (its fields are snake_case) or leak the
// transcript, cwd, prompt and tool payload into coordination state.  This
// normalizer validates the event name, derives only the two bounded signals we
// need, then discards the envelope before the normal adapter validates it.
const CLAUDE_NATIVE_EVENT_NAMES = Object.freeze({
  SessionStart: "SessionStart",
  PostToolUse: "PostToolUse",
  Notification: "Notification",
  Permission: "PermissionRequest",
  Stop: "Stop",
  SubagentStop: "SubagentStop",
});
// ─── help ─────────────────────────────────────────────────────────────────────
// ─── Team Pack CLI (L2: .agent-shared/) ──────────────────────────────────────
// Routes:
//   team init [--project <path>] [--name <name>] [--team]
//   team status [--project <path>] [--json]
//   team install [--project <path>] [--dry-run] [--report text|json]
//   team update [--project <path>] [--dry-run] [--report text|json]
//   team publish --paths <path...> [--project <path>] [--dry-run]
//   team verify [--project <path>] [--strict] [--json]

const teamPack = require("./team-pack");
module.exports = {
  init,
  addPlatforms,
  removePlatforms,
  listPlatforms,
  upgrade,
  exportAnchor,
  trackAgent,
  untrackAgent,
  linkGlobal,
  doctor,
  minimaxCliReconcile,
  runs,
  queues,
  sessions,
  decisions,
  inbox,
  waitpoints,
  coordination,
  lease,
  notification,
  mcp,
  agent,
  hook,
  managementQuery,
  phaseZeroAutomation,
  dashboard,
  lease,
  dispatchDryRun,
  dispatchExecute,
  dev,
  cliHelp,
  printHelp,
  teamPack: teamDispatch,
  secrets: require("./secrets-cli").secretsCommand,
  bridge: require("./commands/bridge").bridgeCommand,
};
