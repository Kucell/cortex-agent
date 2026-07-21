#!/usr/bin/env node

"use strict";

const path = require("path");
const fs = require("fs");

const {
  init,
  addPlatforms,
  removePlatforms,
  listPlatforms,
  upgrade,
  trackAgent,
  untrackAgent,
  linkGlobal,
  doctor,
  runs,
  queues,
  sessions,
  dev,
  printHelp,
} = require("../lib/commands");

// ─── Context ──────────────────────────────────────────────────────────────────

const cwd = process.cwd();
const args = process.argv.slice(2);
const command = args[0];

if (command === "--version" || command === "-v") {
  const { version } = require("../package.json");
  console.log(version);
  process.exit(0);
}

const options = { track: false };
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--lang" || arg === "-l") {
    options.lang = args[i + 1];
  } else if (arg && arg.startsWith("--lang=")) {
    options.lang = arg.split("=")[1];
  }
  if (arg === "--global" || arg === "-g") {
    options.global = true;
  }
  if (arg === "--track") {
    options.track = true;
  }
  if (arg === "--platforms" || arg === "-p") {
    options.platforms = args[i + 1];
  } else if (arg && arg.startsWith("--platforms=")) {
    options.platforms = arg.split("=")[1];
  }
  if (arg === "--update-scripts") {
    options.updateScripts = true;
  }
  if (arg === "--force-scripts") {
    options.forceScripts = true;
  }
  if (arg === "--fix") {
    options.fix = true;
  }
  if (arg === "--dry-run") {
    // For upgrade: report what would change; for subcommands that also honor
    // it (none today besides upgrade), the flag is read from ctx.options.dryRun.
    // Adding it here is a no-op cost when absent; honest reporting when present.
    options.dryRun = true;
  }
}

function detectLangFromProject(dir) {
  try {
    const content = fs.readFileSync(path.join(dir, ".agent", "rules", "language.md"), "utf8");
    if (/中文|zh[-_]CN|首选语言.*中/i.test(content)) return "zh";
    if (/English|en[-_]US/i.test(content)) return "en";
  } catch (_) {}
  return null;
}

const defaultLang =
  process.env.LANG && process.env.LANG.startsWith("zh") ? "zh" : "en";
const lang = options.lang || detectLangFromProject(cwd) || defaultLang;
const templateDir = path.join(__dirname, "../templates", lang);

const ctx = { cwd, args, command, options, lang, templateDir };

// ─── Dispatch ─────────────────────────────────────────────────────────────────

(async () => {
  switch (command) {
    case "init":        await init(ctx); break;
    case "add":         await addPlatforms(ctx); break;
    case "remove":      await removePlatforms(ctx); break;
    case "list":        listPlatforms(ctx); break;
    case "upgrade":     await upgrade(ctx); break;
    case "track":       trackAgent(ctx); break;
    case "untrack":     untrackAgent(ctx); break;
    case "link-global": linkGlobal(ctx); break;
    case "doctor":      await doctor(ctx); break;
    case "runs":        runs(ctx); break;
    case "queues":      queues(ctx); break;
    case "sessions":    sessions(ctx); break;
    case "dev":         await dev(ctx); break;
    default:            printHelp(); break;
  }
})();
