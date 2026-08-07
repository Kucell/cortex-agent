"use strict";

// ─── teamPack — Team Pack CLI dispatcher (L2: .agent-shared/) ─────────────────
//
// Originally lived in lib/commands.js (line 2614–2924). Routes:
//   team init [--project <path>] [--name <name>] [--team]
//   team status [--project <path>] [--json]
//   team install [--project <path>] [--dry-run] [--report text|json]
//   team update [--project <path>] [--dry-run] [--report text|json]
//   team publish --paths <path...> [--project <path>] [--dry-run]
//   team verify [--project <path>] [--strict] [--json]
//
// Extracted so callers can require this CLI surface in isolation.

const fs = require("node:fs");
const path = require("node:path");
const teamPack = require("../team-pack/index");

function teamUsage(ctx) {
  const sub = ctx.args[1];
  switch (sub) {
    case "init":
      return "Usage: cortex-agent team init [--project <path>] [--name <name>] [--team]";
    case "status":
      return "Usage: cortex-agent team status [--project <path>] [--json]";
    case "install":
      return "Usage: cortex-agent team install [--project <path>] [--dry-run] [--report text|json]";
    case "update":
      return "Usage: cortex-agent team update [--project <path>] [--dry-run] [--report text|json]";
    case "publish":
      return "Usage: cortex-agent team publish --paths <path...> [--project <path>] [--dry-run]";
    case "verify":
      return "Usage: cortex-agent team verify [--project <path>] [--strict] [--json]";
    default:
      return "Usage: cortex-agent team <init|status|install|update|publish|verify> [options]";
  }
}

function teamResolveProject(ctx) {
  const project = ctx.options && ctx.options.project ? path.resolve(ctx.cwd, ctx.options.project) : ctx.cwd;
  return project;
}

async function teamInit(ctx) {
  const project = teamResolveProject(ctx);
  const name = (ctx.options && ctx.options.name) || path.basename(project) + "-team-pack";
  // Non-interactive default: do NOT auto-install. Interactive default: prompt
  // by auto-installing (best-effort). --team forces install regardless.
  const interactive = Boolean(process.stdin.isTTY);
  const optTeam = Boolean(ctx.options && ctx.options.team);
  const allowInstall = optTeam;
  const result = teamPack.initSkeleton(project, name);
  console.log(`✅ Created ${result.manifest_path}`);
  if (!allowInstall) {
    const hint = interactive
      ? "ℹ️  交互模式已创建骨架;如需立即安装请重新执行 `team install --team`。"
      : "ℹ️  非交互模式默认不自动安装 Team Pack。重新执行时使用 `--team` 触发 install。";
    console.log(hint);
    return;
  }
  await teamInstall({ ...ctx, options: { ...(ctx.options || {}), project: project === ctx.cwd ? "" : project } });
}

function teamStatus(ctx) {
  const project = teamResolveProject(ctx);
  const loaded = teamPack.loadPack(project);
  const receipt = teamPack.readReceipt(project);
  const report = {
    schema_version: 1,
    project,
    pack: loaded.ok ? { name: loaded.manifest.name, version: loaded.manifest.version, manifest_sha256: loaded.manifestSha256 } : null,
    pack_present: loaded.ok,
    receipt_present: Boolean(receipt),
    files_declared: loaded.ok ? loaded.manifest.files.length : 0,
    files_installed: receipt ? receipt.files.length : 0,
  };
  if ((ctx.options && ctx.options.json) || ctx.command.endsWith("status")) {
    // Always emit JSON when --json is requested or when invoked via CLI route
    if (ctx.options && ctx.options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
  }
  console.log(
    `Pack: ${report.pack ? `${report.pack.name}@${report.pack.version}` : "(missing)"} | Files declared: ${report.files_declared} | Receipt: ${report.receipt_present ? "present" : "missing"}`,
  );
}

function applyPlanToProject(project, manifest, plan) {
  const applied = [];
  const conflicts = plan.items
    .filter((it) => it.decision === "conflict")
    .map((it) => ({ path: it.path, base: it.base, local: it.local, incoming: it.incoming }));
  const eligible = plan.items.filter((it) => it.decision === "apply" || it.decision === "add");
  const transactionId = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const backupRoot = path.join(project, teamPack.BACKUP_DIR, transactionId);
  const staged = [];

  for (const it of eligible) {
    const src = path.join(project, ".agent-shared", it.path);
    const dest = path.join(project, ".agent", it.path);
    if (
      !fs.existsSync(src)
      || teamPack.hasSymlinkInPath(project, src)
      || teamPack.hasSymlinkInPath(project, dest, { includeLeaf: false })
      || !fs.lstatSync(src).isFile()
      || fs.lstatSync(src).nlink > 1
      || (fs.existsSync(dest) && (fs.lstatSync(dest).isSymbolicLink() || fs.lstatSync(dest).nlink > 1))
      || teamPack.hashFile(src) !== it.incoming
    ) {
      throw new Error(`incoming Team Pack file changed during apply: ${it.path}`);
    }
  }

  try {
    for (const it of eligible) {
      const src = path.join(project, ".agent-shared", it.path);
      const dest = path.join(project, ".agent", it.path);
      const existed = fs.existsSync(dest);
      const backup = path.join(backupRoot, it.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const temp = `${dest}.team-tmp-${process.pid}-${staged.length}`;
      fs.copyFileSync(src, temp);
      staged.push({ dest, backup, existed, temp });
      if (existed) {
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(dest, backup);
      }
      fs.renameSync(temp, dest);
      applied.push(it.path);
    }
  } catch (error) {
    for (const entry of [...staged].reverse()) {
      try {
        if (fs.existsSync(entry.temp)) fs.unlinkSync(entry.temp);
        if (entry.existed && fs.existsSync(entry.backup)) fs.copyFileSync(entry.backup, entry.dest);
        else if (!entry.existed && fs.existsSync(entry.dest)) fs.unlinkSync(entry.dest);
      } catch (_) {}
    }
    throw new Error(`Team Pack apply rolled back: ${error.message}`);
  }

  return {
    applied,
    conflicts,
    backup_dir: eligible.some((it) => fs.existsSync(path.join(backupRoot, it.path))) ? backupRoot : null,
  };
}

function writeConflictArtifact(project, conflicts) {
  if (!conflicts.length) return null;
  fs.mkdirSync(path.join(project, teamPack.CONFLICT_DIR), { recursive: true });
  const file = path.join(
    project,
    teamPack.CONFLICT_DIR,
    `${Date.now()}-${conflicts.length}-conflict.json`,
  );
  fs.writeFileSync(file, `${JSON.stringify({ schema_version: 1, conflicts }, null, 2)}\n`, "utf8");
  return file;
}

async function teamInstall(ctx) {
  const project = teamResolveProject(ctx);
  const dryRun = Boolean(ctx.options && ctx.options.dryRun);
  const loaded = teamPack.loadPack(project);
  if (!loaded.ok) {
    console.error(`❌ Team Pack manifest invalid or missing: ${loaded.reason}`);
    process.exitCode = 2;
    return;
  }
  const receipt = teamPack.readReceipt(project);
  const plan = teamPack.buildMergePlan(loaded.manifest, receipt, project, { dryRun });
  if (dryRun) {
    if (ctx.options && ctx.options.report === "json") {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      const summary = plan.items.map((it) => `  ${it.decision.padEnd(10)} ${it.path} (${it.reason})`).join("\n");
      console.log(`[dry-run] plan:\n${summary}`);
    }
    return;
  }
  const { applied, conflicts } = applyPlanToProject(project, loaded.manifest, plan);
  const receipt2 = teamPack.buildReceiptFromPlan(loaded.manifest, loaded.manifestSha256, plan, receipt);
  teamPack.writeReceiptAtomic(project, receipt2);
  const conflictFile = writeConflictArtifact(project, conflicts);
  if (ctx.options && ctx.options.report === "json") {
    console.log(
      JSON.stringify(
        { schema_version: 1, mode: "apply", applied, conflicts: conflicts.length, conflict_artifact: conflictFile, receipt: receipt2 },
        null,
        2,
      ),
    );
  } else {
    console.log(`✅ Installed ${applied.length} file(s)` + (conflicts.length ? `, ${conflicts.length} conflict(s) preserved` : ""));
    if (conflictFile) console.log(`⚠️  Conflict artifact: ${conflictFile}`);
  }
}

async function teamUpdate(ctx) {
  // update == install for MS-002 (same three-way merge).
  return teamInstall(ctx);
}

function teamPublish(ctx) {
  const project = teamResolveProject(ctx);
  const items = parsePathsOption(ctx);
  if (!items || items.length === 0) {
    console.error("❌ `team publish` requires --paths <path...>.");
    process.exitCode = 2;
    return;
  }
  const dryRun = Boolean(ctx.options && ctx.options.dryRun);
  const manifest = teamPack.readManifest(project) || {
    name: path.basename(project) + "-team-pack",
    version: "0.1.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: { mode: "git_committers", allowed_committers: [], fallback: "reject" },
    includes: [],
    excludes: teamPack.DEFAULT_EXCLUDES,
  };
  const tuples = items.map((p) => ({ source: p, dest: normalizePublishDest(p) }));
  const result = teamPack.publishPack(project, tuples, {
    name: manifest.name,
    version: manifest.version,
    requires: manifest.requires,
    signers: manifest.signers,
    includes: manifest.includes || [],
    excludes: manifest.excludes || teamPack.DEFAULT_EXCLUDES,
    dryRun,
  });
  if (!result.ok) {
    console.error(`❌ publish rejected ${result.skipped.length} item(s):`);
    for (const s of result.skipped) console.error(`   - ${s.source} -> ${s.dest}: ${s.reason}`);
    process.exitCode = 3;
    return;
  }
  console.log(`✅ Published ${result.applied.length} file(s)` + (dryRun ? " (dry-run)" : ""));
}

function parsePathsOption(ctx) {
  const argv = (ctx.args || []).slice();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--paths") {
      const out = [];
      let j = i + 1;
      while (j < argv.length && !argv[j].startsWith("--")) out.push(argv[j++]);
      return out;
    }
    if (argv[i] && argv[i].startsWith("--paths=")) {
      return argv[i].slice("--paths=".length).split(",").filter(Boolean);
    }
  }
  return [];
}

function normalizePublishDest(source) {
  // MS-003 convenience: if user passes a path whose first segment is not in
  // PACK_TOP_ALLOWLIST, attempt to remap to the closest allowlist directory.
  // Examples:
  //   src/rules/foo.md   -> rules/foo.md
  //   my-rules/foo.md    -> rules/foo.md
  //   rules/foo.md       -> rules/foo.md (unchanged)
  if (!source) return source;
  const segs = source.split("/").filter(Boolean);
  const top = segs[0];
  const ALLOW = new Set(["team-pack.json", "README.md", "rules", "workflows", "skills", "references", "schemas", "coordination"]);
  if (ALLOW.has(top)) return source;
  // Drop the leading non-allowlist segment(s) until the next segment is allowlist.
  for (let i = 1; i < segs.length; i += 1) {
    if (ALLOW.has(segs[i])) return segs.slice(i).join("/");
  }
  // No allowlist segment found; default to rules/
  return ["rules", ...segs].join("/");
}

function teamVerify(ctx) {
  const project = teamResolveProject(ctx);
  const strict = Boolean(ctx.options && ctx.options.strict);
  const loaded = teamPack.loadPack(project);
  if (!loaded.ok) {
    console.error(`❌ Team Pack manifest invalid or missing: ${loaded.reason}`);
    process.exitCode = 2;
    return;
  }
  const report = teamPack.verifyStrict(loaded.manifest, project);
  const json = Boolean(ctx.options && ctx.options.json);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(strict ? "🔍 Strict verify:" : "🔍 Verify:");
    for (const c of report.checks) {
      console.log(`  ${c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "⚠"} ${c.id}: ${c.reason}`);
    }
  }
  if (!report.ok) process.exitCode = 3;
}

async function teamDispatch(ctx) {
  const sub = ctx.args[1];
  switch (sub) {
    case "init": return teamInit(ctx);
    case "status": return teamStatus(ctx);
    case "install": return teamInstall(ctx);
    case "update": return teamUpdate(ctx);
    case "publish": return teamPublish(ctx);
    case "verify": return teamVerify(ctx);
    case undefined:
    case "--help":
    case "-h":
      console.log(teamUsage(ctx));
      return;
    default:
      console.error(`Unknown team subcommand: ${sub}`);
      console.log(teamUsage(ctx));
      process.exitCode = 2;
  }
}

module.exports = {
  teamUsage,
  teamResolveProject,
  teamInit,
  teamStatus,
  applyPlanToProject,
  writeConflictArtifact,
  teamInstall,
  teamUpdate,
  teamPublish,
  parsePathsOption,
  normalizePublishDest,
  teamVerify,
  teamDispatch,
};
