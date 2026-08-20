"use strict";

// ─── 4-kind `design` dispatcher (P-001 MS-002 follow-up) ───────────────────────
//
// Routes `cortex-agent design ...` to per-kind handlers. Existing T-OD-001
// design-system flow is preserved verbatim via lib/design/cli.js (frozen).
//
// CLI shapes supported:
//   Legacy (backward compat — design-system):
//     cortex-agent design list [--available|--installed|--all] [--json]
//     cortex-agent design install <id>... [--yes] [--force] [--no-cache] [--json]
//     cortex-agent design upgrade [<id>] [--yes] [--no-cache] [--json]
//     cortex-agent design remove <id>... [--json]
//     cortex-agent design show <id> [--json]
//     cortex-agent design resolved [--json]
//     cortex-agent design refresh-catalog
//
//   New 4-kind:
//     cortex-agent design system <sub> [opts...]    (alias of legacy)
//     cortex-agent design plugin list [--available|--installed] [--json]
//     cortex-agent design plugin show <id> [--json]
//     cortex-agent design skill list [--available|--installed] [--json]
//     cortex-agent design skill show <id> [--json]
//     cortex-agent design template list [--available|--installed|--mode <mode>] [--json]
//     cortex-agent design template show <id> [--json]
//
//   Other 3 kinds (plugin / skill / template) are catalog-only in this MVP —
//   fetch/install come in MS-002 follow-up round 2 (when lib/catalog/fetch.js
//   lands). Show uses lib/catalog/resolve.readManifest for installed entries.
//
// Hard constraints:
//   - bin/cli.js must stay zero-dep.
//   - lib/design/cli.js is frozen; this dispatcher only re-exports.
//   - Exit codes match T-OD-001: 0 success / 1 generic / 2 user error / 3 network / 4 license.

const path = require("node:path");
const fs = require("node:fs");

const { KIND_LIST, getKind, hasKind } = require("../catalog/kind-map");
const registry = require("../catalog/registry");
const resolve = require("../catalog/resolve");
const license = require("../catalog/license");
const legacyDesign = require("../design/cli");

const KIND_ALIASES = Object.freeze({
  "system": "design-system",
  "design-system": "design-system",
  "plugin": "plugin",
  "skill": "skill",
  "template": "template",
});

// Subcommands that the legacy design-system accepts. When args[1] matches one
// of these, we treat it as the system subcommand (backward compat).
const LEGACY_SUBCOMMANDS = new Set([
  "list", "install", "upgrade", "remove", "show", "resolved", "refresh-catalog",
]);

function detectKind(args) {
  // args[0] may be 'design' (when routed from bin/cli.js) or already shifted.
  // Strip the leading 'design' if present.
  const argv = args[0] === "design" ? args.slice(1) : args;
  const first = argv[0];
  if (KIND_ALIASES[first]) return KIND_ALIASES[first];
  // Legacy: first token is a subcommand → default to design-system.
  if (LEGACY_SUBCOMMANDS.has(first)) return "design-system";
  return null;
}

function printJson(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

function printText(s) {
  process.stdout.write(s);
}

function printHelp() {
  const lines = [
    "Usage: cortex-agent design <subcommand|kind> [options]",
    "",
    "Kinds (P-001 MS-002):",
    "  system (alias: design-system)   Open Design 4-level cascade [shipped]",
    "  plugin                          open-design plugin (catalog-only MVP) [shipped]",
    "  skill                           open-design skill  (catalog-only MVP) [shipped]",
    "  template                        open-design template (catalog-only MVP) [shipped]",
    "",
    "Subcommands (design-system, T-OD-001):",
    "  list [--available|--installed|--all] [--json]",
    "  install <id>... [--yes] [--force] [--no-cache] [--json]",
    "  upgrade [<id>] [--yes] [--no-cache] [--json]",
    "  remove <id>... [--json]",
    "  show <id> [--json]",
    "  resolved [--json]",
    "  refresh-catalog",
    "",
    "Subcommands (plugin|skill|template, MVP — list + show only):",
    "  <kind> list [--available|--installed] [--json]",
    "  <kind> show <id> [--json]",
    "",
    "Examples:",
    "  cortex-agent design list                    # design-system installed",
    "  cortex-agent design system list --available",
    "  cortex-agent design plugin list --installed",
    "  cortex-agent design template list --mode prototype",
    "",
    "Exit codes: 0 success / 1 generic / 2 user error / 3 network / 4 license rejected.",
  ];
  printText(lines.join("\n") + "\n");
}

async function designCommand(ctx) {
  const args = ctx.args || [];
  if (
    args.length === 0 ||
    args.includes("--help") ||
    args.includes("-h") ||
    (args.length === 1 && args[0] === "help")
  ) {
    printHelp();
    return;
  }
  const kind = detectKind(args);
  if (!kind) {
    printHelp();
    process.exitCode = 2;
    return;
  }
  if (kind === "design-system") {
    // If the user used the explicit kind prefix (`design system ...`), strip
    // the leading "system" / "design-system" token before forwarding to legacy,
    // so legacy parseDesignArgs sees the real subcommand as args[1].
    const argv = args[0] === "design" ? args.slice(1) : args;
    let forwardedArgs = argv;
    if (argv[0] === "system" || argv[0] === "design-system") {
      forwardedArgs = ["design", ...argv.slice(1)];
    } else {
      forwardedArgs = ["design", ...argv];
    }
    return legacyDesign.designCommand({ ...ctx, args: forwardedArgs });
  }
  return handleNonSystemKind(kind, ctx);
}

async function handleNonSystemKind(kind, ctx) {
  const args = ctx.args || [];
  // Drop leading 'design' if present, then drop the kind token.
  const argv = args[0] === "design" ? args.slice(1) : args.slice();
  const sub = argv[1]; // argv[0] is the kind
  const showJson = args.includes("--json") || argv.includes("--json");
  const showAvailable = argv.includes("--available");
  const showInstalled = argv.includes("--installed");
  const listMode = showAvailable ? "available" : showInstalled ? "installed" : "all";
  const mode = getModeFlag(argv);
  const id = argv.slice(2).find((a) => !a.startsWith("--") && !a.includes("="));
  switch (sub) {
    case "list":
      return listKind(kind, { listMode, mode, showJson });
    case "show":
      if (!id) {
        console.error(`design ${kind} show: id required`);
        process.exitCode = 2;
        return;
      }
      return showKind(kind, id, { showJson });
    case "install":
      console.error(`design ${kind} install: fetch not yet implemented in MVP — see P-001 MS-002 follow-up round 2 (lib/catalog/fetch.js).`);
      process.exitCode = 1;
      return;
    default:
      console.error(`Unknown design ${kind} subcommand: ${sub}`);
      console.error(`Valid: list | show${kind !== "skill" ? " | install" : ""}`);
      process.exitCode = 2;
      return;
  }
}

function getModeFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mode" && i + 1 < argv.length) return argv[i + 1];
    if (argv[i] && argv[i].startsWith("--mode=")) return argv[i].slice("--mode=".length);
  }
  return null;
}

async function listKind(kind, opts) {
  opts = opts || {};
  const cwd = process.cwd();
  // Build a 4-kind index (sync — uses starter fallback).
  const idx = registry.loadAllKinds();
  const all = idx.kinds[kind]?.entries || [];
  const installed = resolve.listInstalled(kind, cwd).map((e) => e.id);
  let filtered = all;
  if (opts.listMode === "installed") {
    filtered = all.filter((e) => installed.includes(e.id));
  } else if (opts.listMode === "available") {
    filtered = all.filter((e) => !installed.includes(e.id));
  }
  if (opts.mode && kind === "template") {
    // When --mode is specified, filter strictly to entries whose mode matches.
    // Entries without a mode field are excluded (they don't advertise a mode).
    filtered = filtered.filter((e) => e.mode === opts.mode);
  }
  if (opts.showJson) {
    printJson({
      kind,
      source: idx.kinds[kind]?.source || "starter",
      installed,
      listMode: opts.listMode,
      mode: opts.mode,
      count: filtered.length,
      entries: filtered,
    });
    return;
  }
  if (filtered.length === 0) {
    printText(`(${kind}: none)\n`);
    return;
  }
  printText(`${kind} (${filtered.length}):\n`);
  for (const e of filtered) {
    const tag = installed.includes(e.id) ? "* " : "  ";
    const mode = e.mode ? `\t${e.mode}` : "";
    printText(`  ${tag}${e.id}${mode}\n`);
  }
  printText(`\n(${installed.length} installed · ${filtered.length - installed.filter((i) => filtered.find((f) => f.id === i)).length} available upstream)\n`);
}

async function showKind(kind, id, opts) {
  opts = opts || {};
  const cwd = process.cwd();
  const verify = resolve.verifyInstall(kind, id, cwd);
  if (!verify.present) {
    console.error(`design ${kind} show: ${id} not installed (missing ${verify.missing.join(", ")})`);
    process.exitCode = 2;
    return;
  }
  const manifest = resolve.readManifest(kind, id, cwd);
  if (opts.showJson) {
    printJson({
      kind,
      id,
      root: verify.root,
      missing: verify.missing,
      manifest,
    });
    return;
  }
  printText(`id:       ${id}\n`);
  printText(`kind:     ${kind}\n`);
  printText(`root:     ${verify.root}\n`);
  if (typeof manifest === "string") {
    printText("\n--- manifest (text) ---\n");
    printText(manifest);
    printText("\n");
  } else if (manifest && typeof manifest === "object") {
    printText("\n--- manifest (json) ---\n");
    printText(JSON.stringify(manifest, null, 2));
    printText("\n");
  }
}

module.exports = {
  designCommand,
  detectKind,
  KIND_ALIASES,
  // exposed for tests
  _internal: { listKind, showKind, handleNonSystemKind },
};