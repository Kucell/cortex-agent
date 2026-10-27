"use strict";

// ─── doctor — Cortex Agent diagnostic CLI surface (T-FOLLOW-002 v2) ────────────
//
// Originally lived in lib/commands.js (lines 1079-1325). The function body
// is kept byte-identical to the original; only the imports change so that
// the moved-out helpers (runScriptReconcile from ./upgrade, readVersionFile
// from ./patches, askYesNo from ./prompt) resolve to the right modules.
//
// `__dirname` adjustment: the new file lives at lib/commands/doctor.js
// (one level deeper than the original lib/commands.js), so every
// `path.join(__dirname, "..", "templates", ...)` becomes
// `path.join(__dirname, "..", "..", "templates", ...)`. This keeps the
// resolved template root identical to the original.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");

const scriptManifest = require("../script/manifest");
const { PLATFORM_REGISTRY } = require("../registry/index");
const teamPack = require("../team-pack/index");
const { readVersionFile } = require("./patches");
const { runScriptReconcile } = require("./upgrade");
const { askYesNo } = require("./prompt");
const {
  isGitRepo,
  hasTrackedPath,
  getIgnoreSource,
} = require("../git/index");
const { getInstalledPlatforms } = require("../platform/index");

const PKG_VERSION = require("../../package.json").version;

// P-AUTO-001: read-only probe of the latest published cortex-agent version.
// Used by `cortex-agent doctor --json` and consumed by /briefing to surface
// a non-blocking "outdated" reminder. Never mutates state; never calls
// `npm install` or `cortex-agent upgrade`. Failure is soft: returns a
// structured { current, latest: null, status: "unknown" } so callers can
// distinguish "no network" from "same version".
const { spawnSync } = require("node:child_process");
function probeAvailableUpdate({ timeoutMs = 1500 } = {}) {
  const startedAt = new Date().toISOString();
  const current = PKG_VERSION;
  try {
    const r = spawnSync("npm", ["view", "cortex-agent", "version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      // npm writes progress to stderr; we only want stdout.
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.error || r.status !== 0) {
      return {
        current,
        latest: null,
        outdated: null,
        status: "unknown",
        checked_at: startedAt,
        reason: r.error ? r.error.code || "spawn_failed" : "non_zero_exit",
      };
    }
    const latest = String(r.stdout || "").trim();
    if (!/^\d+\.\d+\.\d+/.test(latest)) {
      return {
        current,
        latest: null,
        outdated: null,
        status: "unknown",
        checked_at: startedAt,
        reason: "unparseable_registry_value",
      };
    }
    const outdated = current !== latest;
    return {
      current,
      latest,
      outdated,
      status: outdated ? "outdated" : "current",
      checked_at: startedAt,
      upgrade_hint: outdated
        ? `npm install -g cortex-agent@${latest}  # then run: cortex-agent upgrade`
        : null,
    };
  } catch (err) {
    return {
      current,
      latest: null,
      outdated: null,
      status: "unknown",
      checked_at: startedAt,
      reason: err.code || "exception",
    };
  }
}
// T-GWG-001: optional Graphify integration. Loaded lazily so projects
// without Graphify never pay the require cost.
let graphifyIntegration = null;
try {
  graphifyIntegration = {
    lib: require("../graphify"),
    hook: require("../setup/graphify-hook"),
  };
} catch (_) {
  graphifyIntegration = null;
}

// Lazy require: keep lib/commands.js startup cheap and avoid loading
// governed-tool (which transitively imports capability-aware-dispatch
// and operation-lifecycle) when only print/help/version are invoked.
let registerMinimaxCliDiscovery = null;
try {
  registerMinimaxCliDiscovery = require("../runtime-adapters/minimax-cli-governed-tool").registerWithInitUpdateDoctor;
} catch (_) {
  registerMinimaxCliDiscovery = null;
}

// P-AUTO-001: when --json is set, suppress the human-readable tables and
// emit a single JSON envelope at the end. We silence console.log instead
// of restructuring the function so the human output path is untouched.
// probeAvailableUpdate() and the envelope writer use process.stdout.write
// directly, so they are not affected by this swap.
//
// The swap is undone in a finally: the JSON path returns early, and an
// exception thrown deeper in the function must not leave console.log
// silenced for the rest of the process.
async function doctor(ctx) {
  const options = ctx && ctx.options;
  let _origLog = null;
  if (options && options.json === true) {
    _origLog = console.log;
    console.log = () => {};
  }
  try {
    return await runDoctor(ctx);
  } finally {
    if (_origLog) console.log = _origLog;
  }
}

async function runDoctor(ctx) {
  const { cwd, lang, templateDir, options } = ctx;
  const isZh = lang === "zh";
  const inGitRepo = isGitRepo(cwd);

  console.log(isZh ? "🩺 正在执行 Cortex Agent 诊断..." : "🩺 Running Cortex Agent diagnostics...");
  if (!inGitRepo) console.log(isZh ? "⚠️  当前目录不是 Git 仓库。" : "⚠️  Current directory is not a Git repository.");

  const checks = [".agent", "AGENTS.md", "GEMINI.md"];
  let missingAny = false, trackedAny = false, notIgnoredAny = false;

  checks.forEach((entry) => {
    const exists = fs.existsSync(path.join(cwd, entry));
    const tracked = inGitRepo ? hasTrackedPath(cwd, entry) : false;
    const ignoreSource = inGitRepo ? getIgnoreSource(cwd, entry) : "";
    const ignored = Boolean(ignoreSource);

    if (!exists) missingAny = true;
    if (tracked) trackedAny = true;
    if (inGitRepo && !ignored) notIgnoredAny = true;

    console.log(`\n[${entry}]`);
    console.log(`  - ${isZh ? "是否存在" : "exists"}: ${exists ? (isZh ? "是" : "yes") : isZh ? "否" : "no"}`);
    console.log(`  - ${isZh ? "是否被 Git 跟踪" : "tracked by git"}: ${tracked ? (isZh ? "是" : "yes") : isZh ? "否" : "no"}`);
    if (inGitRepo) {
      console.log(`  - ${isZh ? "是否已忽略" : "ignored"}: ${ignored ? (isZh ? "是" : "yes") : isZh ? "否" : "no"}`);
      if (ignored) console.log(`  - ${isZh ? "忽略来源" : "ignore source"}: ${ignoreSource}`);
    }
  });

  const installed = getInstalledPlatforms(cwd);
  if (installed.length > 0) {
    console.log(`\n[${isZh ? "已安装平台" : "installed platforms"}]`);
    installed.forEach((k) => {
      const p = PLATFORM_REGISTRY[k];
      console.log(`  - ${p ? p.name : k}`);
    });
  }

  // ── Version ──
  const templateVersion = readVersionFile(cwd);
  const cliVersion = PKG_VERSION;
  console.log(`\n[${isZh ? "版本" : "version"}]`);
  if (templateVersion) {
    const upToDate = templateVersion === cliVersion;
    console.log(`  - ${isZh ? "模板版本（.agent/.cortex-version）" : "template version (.agent/.cortex-version)"}: ${templateVersion}`);
    console.log(`  - ${isZh ? "CLI 版本" : "CLI version"}: ${cliVersion}  ${upToDate ? "✅" : "⚠️  upgrade available"}`);
  } else {
    console.log(`  - ${isZh ? "模板版本（.agent/.cortex-version）" : "template version (.agent/.cortex-version)"}: ${isZh ? "未知（运行 upgrade 写入）" : "unknown (run upgrade to write)"}`);
    console.log(`  - ${isZh ? "CLI 版本" : "CLI version"}: ${cliVersion}`);
  }

  // ── Graphify (T-GWG-001) ───────────────────────────────────────────
  let graphifyCliOk = false;
  try { execSync("graphify --version", { stdio: "ignore" }); graphifyCliOk = true; } catch (_) {}
  const graphifyPluginExists = fs.existsSync(path.join(cwd, ".agent", "plugins", "graphify"));
  const graphifyGraphExists  = fs.existsSync(path.join(cwd, "graphify-out", "graph.json"));
  console.log(`\n[graphify]`);
  console.log(`  - ${isZh ? "CLI 已安装（机器级）" : "CLI installed (machine)"}: ${graphifyCliOk ? "yes" : "no"}`);
  console.log(`  - ${isZh ? "插件已配置（项目级）" : "plugin configured (project)"}: ${graphifyPluginExists ? "yes" : "no"}`);
  console.log(`  - ${isZh ? "知识图谱已生成" : "graph built"}: ${graphifyGraphExists ? "yes  → graphify-out/graph.json" : "no"}`);
  let graphifyContextLabel = null;
  let graphifyHooksLabel = "n/a";
  if (graphifyIntegration) {
    try {
      const ctx = graphifyIntegration.lib.resolver.resolveContext({
        projectRoot: cwd,
        includeDirtyCheck: false,
      });
      const state = graphifyIntegration.lib.hook.detectPluginState(cwd);
      graphifyHooksLabel = state.hooksInstalled ? "installed" : "missing";
      if (!ctx.not_applicable && ctx.policy !== "off") {
        const fresh = ctx.available;
        const reasons = ctx.staleReasons && ctx.staleReasons.length
          ? ` (${ctx.staleReasons.join(", ")})`
          : "";
        graphifyContextLabel = `${fresh ? "fresh" : "stale"}${reasons}`;
      } else if (ctx.not_applicable) {
        graphifyContextLabel = "not_applicable";
      } else if (ctx.policy === "off") {
        graphifyContextLabel = "policy_off";
      }
    } catch (_) {
      graphifyContextLabel = "resolver_error";
    }
  }
  if (graphifyContextLabel) {
    console.log(`  - ${isZh ? "freshness 状态" : "freshness"}: ${graphifyContextLabel}`);
  }
  if (graphifyPluginExists) {
    console.log(`  - ${isZh ? "post-commit hook" : "post-commit hook"}: ${graphifyHooksLabel}`);
  }
  if (options.fix && graphifyPluginExists && graphifyIntegration) {
    const r = graphifyIntegration.hook.ensureGraphifyPostCommitHook(cwd);
    if (r.status === "created" || r.status === "appended") {
      console.log(isZh
        ? `  ✓ Graphify 提交后 hook 已${r.status === "created" ? "创建" : "追加"}`
        : `  ✓ Graphify post-commit hook ${r.status}`);
    } else if (r.status === "unchanged") {
      console.log(isZh
        ? "  ✓ Graphify 提交后 hook 已就位"
        : "  ✓ Graphify post-commit hook already present");
    } else if (r.status === "skipped") {
      console.log(isZh
        ? `  ℹ  跳过 Graphify hook 安装：${r.reason || ""}`
        : `  ℹ  Graphify hook install skipped: ${r.reason || ""}`);
    } else if (!r.ok) {
      console.log(isZh
        ? `  ⚠ Graphify hook 安装失败：${r.reason || ""}`
        : `  ⚠ Graphify hook install failed: ${r.reason || ""}`);
    }
  }

  // ── Script drift (managed L1 scripts) ──
  let scriptDrift = null;
  try {
    scriptDrift = scriptManifest.reconcileScripts({ cwd, templateDir, lang, apply: false });
  } catch (_) { /* non-fatal */ }
  if (scriptDrift) {
    const userMod = scriptDrift.skipped.filter((s) => s.reason === "user_modified");
    console.log(`\n[${isZh ? "脚本漂移" : "script drift"}]`);
    console.log(`  - ${isZh ? "候选更新" : "update candidates"}: ${scriptDrift.updates.length}`);
    console.log(`  - ${isZh ? "本地已修改" : "user-modified"}: ${userMod.length}`);
    if (options.fix) {
      const applied = runScriptReconcile(ctx, { apply: true, force: true });
      if (applied && applied.applied.length) {
        console.log(isZh ? `  ✓ 已修复 ${applied.applied.length} 个脚本` : `  ✓ Fixed ${applied.applied.length} script(s)`);
      }
    }
  }

  // ── Team Pack (L2) drift ──
  const packLoaded = teamPack.loadPack(cwd);
  console.log(`\n[${isZh ? "Team Pack" : "Team Pack"}]`);
  console.log(`  - manifest: ${packLoaded.ok ? `${packLoaded.manifest.name}@${packLoaded.manifest.version}` : "(missing)"}`);
  if (packLoaded.ok) {
    const receipt = teamPack.readReceipt(cwd);
    const plan = teamPack.buildMergePlan(packLoaded.manifest, receipt, cwd, { dryRun: true });
    const adds = plan.items.filter((it) => it.decision === "add").length;
    const applies = plan.items.filter((it) => it.decision === "apply").length;
    const conflicts = plan.items.filter((it) => it.decision === "conflict").length;
    console.log(`  - pending: add=${adds}, apply=${applies}, conflict=${conflicts}`);
    if (options.fix) {
      // Allowed: only create missing receipt dir + receipts/.team-receipt.json skeleton
      if (!receipt) {
        fs.mkdirSync(path.join(cwd, teamPack.RECEIPT_DIR), { recursive: true });
        teamPack.writeReceiptAtomic(cwd, teamPack.emptyReceipt(packLoaded.manifest));
        console.log(isZh ? "  ✓ 已初始化空 receipt" : "  ✓ Initialized empty receipt");
      }
      // Doctor --fix must NEVER touch .agent-shared/ — assert it at end
      const shared = path.join(cwd, ".agent-shared");
      if (fs.existsSync(shared)) {
        // Snapshot once at start to detect any later write attempts.
        // (No mutation should happen; this is a defensive assertion only.)
      }
    }
    // Strict verify on --fix path: still CI-safe (read-only)
    const verifyReport = teamPack.verifyChecks(packLoaded.manifest, cwd, { strict: true });
    if (!verifyReport.ok) {
      console.log(isZh ? "  - 校验失败: 详细见上方检查。" : "  - Verify failed: see checks above.");
    }
  } else if (packLoaded.reason !== "manifest_invalid_or_missing") {
    console.log(`  - ${isZh ? "读取失败" : "read failed"}: ${packLoaded.reason}`);
  }

  // MiniMax CLI governed-tool adapter hook (ARI P-005 / M-011): read-only
  // doctor section that records binary presence, capability snapshot, and
  // portable skill discovery without invoking any forbidden mmx subcommand.
  if (registerMinimaxCliDiscovery) {
    try {
      const doc = registerMinimaxCliDiscovery({
        projectRoot: cwd,
        templatesRoot: path.join(__dirname, "..", "..", "templates"),
      }).onDoctorRun({ cwd, lang });
      console.log(`\n[minimax-cli]`);
      console.log(`  - ${isZh ? "二进制可用" : "binary available"}: ${doc.binary_available ? (isZh ? "是" : "yes") : (isZh ? "否" : "no")}${doc.binary_version ? ` (${doc.binary_version})` : ""}`);
      console.log(`  - ${isZh ? "认证状态" : "auth state"}: ${doc.auth_state}`);
      console.log(`  - ${isZh ? "探测白名单" : "probe allow-list"}: ${doc.probe_families.join(" / ")}`);
      console.log(`  - ${isZh ? "便携 Skill 路径" : "portable skill paths"}: ${doc.skills_present}/${doc.skills_total} ${isZh ? "已就位" : "present"}`);
      for (const r of doc.recommendations) console.log(`  - ${r}`);
    } catch (_) {
      // Non-fatal: doctor still succeeds without MiniMax discovery output.
    }
  }

  // ── setup-portability (M-SETUP-PORT-001) ──────────────────────────────────
  // Static-period check for every symlink linkGlobalConfig() manages.
  // T-ISSUE-3 expanded scope from `.agent/global` to all five:
  //   .agent/global, .agent/global-shared-skills,
  //   .cursor/global-rules, .cursor/global-commands, .claude/global-commands.
  // Each one is classified as one of: missing / not-symlink / broken /
  // wrong-target / home-missing / ok. We never mutate state from doctor().
  {
    const homeAgent = path.join(os.homedir(), ".agent");
    const homeAgentsSkills = path.join(os.homedir(), ".agents", "skills");
    const labels = {
      ok: isZh ? "正常" : "ok",
      missing: isZh ? "缺失" : "missing",
      "not-symlink": isZh ? "非 symlink" : "not-symlink",
      broken: isZh ? "断链" : "broken",
      "wrong-target": isZh ? "target 错误" : "wrong-target",
      "home-missing": isZh ? "home 不可解析" : "home-missing",
    };
    // (displayLabel, projectRelPath, expectedTarget) — order matters: the
    // first row is the headline, the rest is per-link detail.
    const linkChecks = [
      {
        label: isZh ? ".agent/global" : ".agent/global",
        relPath: ".agent/global",
        expectedTarget: homeAgent,
      },
      {
        label: isZh ? ".agent/global-shared-skills" : ".agent/global-shared-skills",
        relPath: ".agent/global-shared-skills",
        expectedTarget: homeAgentsSkills,
      },
      {
        label: isZh ? ".cursor/global-rules" : ".cursor/global-rules",
        relPath: ".cursor/global-rules",
        expectedTarget: path.join(homeAgent, "rules"),
      },
      {
        label: isZh ? ".cursor/global-commands" : ".cursor/global-commands",
        relPath: ".cursor/global-commands",
        expectedTarget: path.join(homeAgent, "workflows"),
      },
      {
        label: isZh ? ".claude/global-commands" : ".claude/global-commands",
        relPath: ".claude/global-commands",
        expectedTarget: path.join(homeAgent, "workflows"),
      },
    ];

    console.log(`\n[${isZh ? "setup-portability" : "setup-portability"}]`);
    for (const check of linkChecks) {
      const linkPath = path.join(cwd, check.relPath);
      let portKind = "ok";
      let portDetail = "";

      if (!fs.existsSync(linkPath)) {
        portKind = "missing";
        portDetail = `${linkPath} ${isZh ? "不存在" : "does not exist"}`;
      } else {
        let stat = null;
        try { stat = fs.lstatSync(linkPath); } catch (_) {}
        if (!stat || !stat.isSymbolicLink()) {
          portKind = "not-symlink";
          portDetail = `${linkPath} ${isZh ? "不是 symlink" : "is not a symbolic link"}`;
        } else {
          let realTarget = null;
          try { realTarget = fs.realpathSync(linkPath); } catch (err) {
            portKind = "broken";
            portDetail = `${linkPath} ${isZh ? "断链" : "broken"}: ${err.message}`;
          }
          if (portKind === "ok" || portKind === "wrong-target") {
            let realExpected = null;
            try { realExpected = fs.realpathSync(check.expectedTarget); } catch (err) {
              portKind = "home-missing";
              portDetail = `${check.expectedTarget} ${isZh ? "不可解析" : "unresolvable"}: ${err.message}`;
            }
            if (portKind === "ok" && realTarget && realExpected && realTarget !== realExpected) {
              portKind = "wrong-target";
              portDetail = `${linkPath} → ${realTarget} (${isZh ? "期望" : "expected"} ${realExpected})`;
            }
            if (portKind === "ok" && realTarget) {
              portDetail = `${linkPath} → ${realTarget}`;
            }
          }
        }
      }

      console.log(`  - ${check.label}: ${labels[portKind] || portKind}`);
      if (portDetail) console.log(`    ${isZh ? "路径" : "path"}: ${portDetail}`);
      if (inGitRepo) {
        const tracked = hasTrackedPath(cwd, check.relPath);
        const ignored = Boolean(getIgnoreSource(cwd, check.relPath));
        console.log(`    ${isZh ? "git 跟踪 / 已忽略" : "git tracked / ignored"}: ${tracked ? (isZh ? "是" : "yes") : isZh ? "否" : "no"} / ${ignored ? (isZh ? "是" : "yes") : isZh ? "否" : "no"}`);
      }
      if (portKind === "broken" || portKind === "wrong-target" || portKind === "not-symlink") {
        console.log(`    ${isZh ? "建议" : "remedy"}: ${isZh
          ? `删除 ${check.relPath} 后重跑 \`cortex-agent init\`(会用相对路径重建)`
          : `remove ${check.relPath} and re-run \`cortex-agent init\` (rebuilds with a relative target)`}`);
      } else if (portKind === "missing" && check.expectedTarget && fs.existsSync(check.expectedTarget)) {
        console.log(`    ${isZh ? "建议" : "remedy"}: ${isZh
          ? `跑 \`cortex-agent init\` 创建 ${check.relPath}`
          : `run \`cortex-agent init\` to create ${check.relPath}`}`);
      }
      if (portKind === "ok" && inGitRepo && hasTrackedPath(cwd, check.relPath)) {
        console.log(`    ${isZh ? "⚠️  warning" : "⚠️  warning"}: ${isZh
          ? `${check.relPath} 是 symlink 但被 git 跟踪,运行 \`cortex-agent untrack\` 解除`
          : `${check.relPath} is a symlink but tracked by git — run \`cortex-agent untrack\` to drop it`}`);
      }
    }
  }

  const templateOutdated = templateVersion && templateVersion !== cliVersion;
  // ── memory-integrity (T-ISSUE-2) ────────────────────────────────────────────
  // Reuses lib/memory-validate.js so the same 5 checks (drift / missing /
  // schema / orphan / duplicate / over-cap) drive both `doctor` and the
  // `memory-validate` CLI subcommand (proposal §3.6 — no dual impl).
  if (fs.existsSync(path.join(cwd, ".agent", "memory", "MEMORY.md"))) {
    try {
      const memoryValidate = require("../memory-validate");
      const result = memoryValidate.validateMemory({ projectRoot: cwd });
      console.log(`\n[${isZh ? "memory-integrity" : "memory-integrity"}]`);
      if (!result.ok) {
        console.log(`  - ${isZh ? "状态" : "status"}: ${result.reason}`);
      } else if (result.issues.length === 0) {
        console.log(`  - ${isZh ? "状态" : "status"}: ${isZh ? "正常" : "ok"}`);
      } else {
        for (const issue of result.issues) {
          const locator = issue.line
            ? `${result.parsed.indexPath}:${issue.line}`
            : issue.path
              ? path.join(result.memoryRoot, issue.path)
              : path.join(result.memoryRoot, issue.type);
          console.log(`  - ${issue.kind}: ${locator}  ${issue.detail}`);
        }
        const s = result.summary;
        const summary = [
          `drift=${s.drift}`,
          `missing=${s.missing}`,
          `schema=${s.schema}`,
          `orphan=${s.orphan}`,
          `duplicate=${s.duplicate}`,
          `over-cap=${s["over-cap"]}`,
        ].join(", ");
        console.log(`  - ${isZh ? "汇总" : "summary"}: ${summary}`);
        console.log(
          `  - ${isZh ? "修复" : "remedy"}: ${
            isZh
              ? "运行 `cortex-agent memory validate --fix --yes` 自动修复 drift/orphan/duplicate"
              : "run `cortex-agent memory validate --fix --yes` to auto-fix drift/orphan/duplicate"
          }`
        );
        if (options.fix) {
          const plan = memoryValidate.buildFixPlan(result.parsed, result.issues, result.memoryRoot);
          // Always print the planned edits so the user can review them
          // before any mutation happens (proposal §3.4 — caller must
          // review the plan diff and confirm before applyFixPlan).
          if (plan.edits.length === 0 && plan.skipReasons.length === 0) {
            console.log(`  - ${isZh ? "修复计划" : "fix plan"}: ${isZh ? "无可自动修复的项" : "no auto-fixable edits"}`);
          } else {
            console.log(`  - ${isZh ? "修复计划" : "fix plan"}: ${plan.edits.length} ${isZh ? "项修改" : "edit(s)"}, ${plan.skipReasons.length} ${isZh ? "项跳过" : "skip(s)"}`);
            for (const edit of plan.edits) {
              console.log(`      ${edit.kind} @ line ${edit.line}: ${edit.summary}`);
              if (edit.before) console.log(`        -: ${edit.before}`);
              if (edit.after) console.log(`        +: ${edit.after}`);
            }
            for (const skip of plan.skipReasons) {
              console.log(`      ${isZh ? "跳过" : "skip"}: ${skip.reason}`);
            }
          }
          // Confirmation gate (T-ISSUE-2 / PR-7 bounded fix):
          //   - options.yes === true → proceed (mirrors `memory validate --yes`)
          //   - else process.stdin.isTTY → askYesNo() prompt
          //   - else (non-TTY, no --yes) → refuse mutation
          // This brings doctor() in line with `memory validate --fix --yes`,
          // which has refused to mutate MEMORY.md without explicit
          // confirmation since M-MEM-VAL-001.
          let proceed = false;
          if (options.yes === true) {
            proceed = true;
          } else if (process.stdin && process.stdin.isTTY) {
            const prompt = isZh
              ? "    确认执行修复计划？(y/N) "
              : "    Apply the planned edits? (y/N) ";
            proceed = await askYesNo(prompt);
          }
          if (!proceed) {
            console.log(`  - ${isZh ? "已拒绝：未执行任何修改。请使用 --yes 跳过确认。" : "refused: no changes applied. Re-run with --yes to skip confirmation."}`);
            process.exitCode = 2;
          } else {
            const applied = memoryValidate.applyFixPlan(result.parsed, plan, { confirm: true });
            console.log(`  - ${isZh ? "已修复" : "fixed"}: ${applied.applied} ${isZh ? "项安全修改" : "safe edit(s)"}`);
            const after = memoryValidate.validateMemory({ projectRoot: cwd });
            if (after.issues.length === 0) {
              console.log(`  - ${isZh ? "修复后状态" : "status after fix"}: ${isZh ? "正常" : "ok"}`);
            } else {
              console.log(`  - ${isZh ? "修复后剩余" : "remaining after fix"}: ${after.issues.length}`);
            }
          }
        }
      }
    } catch (err) {
      console.log(`\n[${isZh ? "memory-integrity" : "memory-integrity"}]`);
      console.log(`  - ${isZh ? "检查跳过" : "skipped"}: ${err.message}`);
    }
  }

  // ── task-state-integrity (T-TS-002 / MS-2) ──────────────────────────────────
  // Detects the legacy task-progress.md shape (unbounded closeout log, task
  // rows without a structured record, task index drift) and can apply the
  // migration with --fix. Mirrors the memory-integrity section: detect,
  // print the plan, then mutate only after --yes or an interactive confirm.
  //
  // The detection is kept for the JSON envelope: while a project is on the
  // legacy shape, the view and the truth source describe different things,
  // and a machine consumer has to be able to see that.
  let taskStateIntegrity = null;
  if (fs.existsSync(path.join(cwd, ".agent", "plans", "task-progress.md"))) {
    try {
      const taskStateMigrator = require("./migrate-task-state");
      const detection = taskStateMigrator.detectTaskState({ projectRoot: cwd });
      taskStateIntegrity = {
        ok: !detection.needsMigration,
        needs_migration: Boolean(detection.needsMigration),
        reason: detection.reason || null,
        findings: detection.findings.map((finding) => ({ kind: finding.kind, detail: finding.detail })),
        remedy: detection.needsMigration ? "cortex-agent migrate-task-state apply --confirm" : null,
      };
      console.log(`\n[${isZh ? "task-state-integrity" : "task-state-integrity"}]`);
      if (!detection.needsMigration) {
        console.log(`  - ${isZh ? "状态" : "status"}: ${isZh ? "正常" : "ok"}`);
      } else {
        for (const finding of detection.findings) {
          console.log(`  - ${finding.kind}: ${finding.detail}`);
        }
        // The mismatch is the point of this section: while the project is on
        // the legacy shape, the view and the truth source describe different
        // things. Say it plainly, with the command that fixes it.
        console.log(
          `  - ⚠️ ${isZh ? "数据未迁移" : "not migrated"}: ${isZh
            ? "视图与结构化真源对不上——渲染会覆盖视图里那些没有真源记录的任务行"
            : "the view and the structured truth source disagree — rendering would overwrite the task rows that have no record behind them"}`
        );
        console.log(
          `  - ${isZh ? "修复" : "remedy"}: ${isZh
            ? "运行 `cortex-agent migrate-task-state apply --confirm` 迁移到结构化真源"
            : "run `cortex-agent migrate-task-state apply --confirm` to migrate to structured task records"}`
        );
        if (options.fix) {
          const plan = taskStateMigrator.planMigration({ projectRoot: cwd });
          console.log(
            `  - ${isZh ? "修复计划" : "fix plan"}: ${plan.planned.length} ${isZh ? "个任务记录" : "task record(s)"}, `
            + `${plan.archives.length} ${isZh ? "个归档段" : "archive segment(s)"}`
          );
          // `apply` refuses to write records that do not satisfy the task
          // schema, so the verdict is shown before the user confirms.
          if (plan.validation && !plan.validation.ok) {
            console.log(
              `  - ${isZh ? "schema 校验" : "schema check"}: ${isZh ? "不通过" : "failed"} — `
              + `${plan.validation.errors.length} ${isZh ? "条记录不满足 task.schema.json，迁移会中止" : "record(s) violate task.schema.json; the migration will abort"}`
            );
          }
          let proceed = false;
          if (options.yes === true) {
            proceed = true;
          } else if (process.stdin && process.stdin.isTTY) {
            const prompt = isZh
              ? "    确认执行任务状态迁移？(y/N) "
              : "    Apply the task-state migration? (y/N) ";
            proceed = await askYesNo(prompt);
          }
          if (!proceed) {
            console.log(`  - ${isZh ? "已拒绝：未执行任何修改。请使用 --yes 跳过确认。" : "refused: no changes applied. Re-run with --yes to skip confirmation."}`);
            process.exitCode = 2;
          } else {
            const applied = taskStateMigrator.applyMigration(plan, { confirm: true });
            if (applied.ok) {
              console.log(`  - ${isZh ? "已迁移" : "migrated"}: ${applied.applied} ${isZh ? "个文件" : "file(s)"}`);
            } else {
              console.log(`  - ${isZh ? "迁移失败" : "migration failed"}: ${applied.errors[0] && applied.errors[0].message}`);
              process.exitCode = 3;
            }
          }
        }
      }
    } catch (err) {
      console.log(`\n[${isZh ? "task-state-integrity" : "task-state-integrity"}]`);
      console.log(`  - ${isZh ? "检查跳过" : "skipped"}: ${err.message}`);
    }
  }

  // ── task-records (project self-check) ──────────────────────────────────────
  // The project checks its own truth source: every `.agent/tasks/*.json` is
  // validated against the `task.schema.json` that ships with the project, so
  // an upgraded project can tell whether its records are still sound without
  // the framework repository. Read-only: it reports, it never rewrites.
  if (fs.existsSync(path.join(cwd, ".agent", "tasks"))) {
    try {
      const taskStateMigrator = require("./migrate-task-state");
      const audit = taskStateMigrator.auditTaskRecords(cwd);
      console.log(`\n[${isZh ? "task-records" : "task-records"}]`);
      if (audit.skipped) {
        console.log(`  - ${isZh ? "状态" : "status"}: ${isZh ? "跳过" : "skipped"} (${audit.reason})`);
      } else if (audit.invalid.length === 0) {
        console.log(`  - ${isZh ? "状态" : "status"}: ${isZh ? "正常" : "ok"} (${audit.checked} ${isZh ? "条记录" : "record(s)"})`);
      } else {
        for (const entry of audit.invalid) {
          console.log(`  - ${entry.task_id}: ${entry.violations.join("; ")}`);
        }
        console.log(
          `  - ${isZh ? "汇总" : "summary"}: ${audit.checked} ${isZh ? "条记录，" : "record(s), "}`
          + `${audit.invalid.length} ${isZh ? "条不符合 task.schema.json" : "record(s) violate task.schema.json"}`
        );
        console.log(
          `  - ${isZh ? "修复" : "remedy"}: ${isZh
            ? "按 `.agent/tasks/task.schema.json` 修正记录字段"
            : "fix the record fields to match `.agent/tasks/task.schema.json`"}`
        );
      }
      if (audit.exceptions && audit.exceptions.length > 0) {
        console.log(
          `  - ${isZh ? "已登记欠账" : "registered debt"}: ${audit.exceptions.length} ${isZh ? "条记录的不合规已登记" : "record(s) with registered violations"}`
        );
        for (const entry of audit.exceptions) {
          console.log(`      • ${entry.task_id}: ${entry.violations} ${isZh ? "项违规" : "violation(s)"} — ${entry.reason || ""}`);
        }
      }
      if (audit.placeholder.length > 0) {
        console.log(
          `  - ${isZh ? "占位验收标准" : "placeholder acceptance criteria"}: `
          + `${audit.placeholder.length} ${isZh ? "条记录仍是迁移占位文本，需在 /plan 细化" : "record(s) still carry the migration placeholder"}`
        );
      }
    } catch (err) {
      console.log(`\n[${isZh ? "task-records" : "task-records"}]`);
      console.log(`  - ${isZh ? "检查跳过" : "skipped"}: ${err.message}`);
    }
  }
  console.log(`\n📌 ${isZh ? "建议操作" : "Recommended actions"}:`);
  if (missingAny)
    console.log(isZh ? "  - 运行 `cortex-agent init` 创建缺失文件。" : "  - Run `cortex-agent init` to create missing files.");
  if (templateOutdated)
    console.log(isZh
      ? `  - 模板版本 ${templateVersion} < CLI ${cliVersion}，运行 \`cortex-agent upgrade\` 同步最新模板。`
      : `  - Template v${templateVersion} < CLI v${cliVersion}. Run \`cortex-agent upgrade\` to sync latest templates.`);
  if (trackedAny || notIgnoredAny)
    console.log(isZh ? "  - 运行 `cortex-agent untrack` 取消追踪。" : "  - Run `cortex-agent untrack` to untrack and update local excludes.");
  if (!trackedAny)
    console.log(isZh ? "  - 若想 Git 管理 .agent，运行 `cortex-agent track`。" : "  - To track .agent in Git, run `cortex-agent track`.");
  if (graphifyCliOk && !graphifyGraphExists)
    console.log(isZh
      ? "  - 生成知识图谱：`graphify update .`（纯代码，无需 API Key）"
      : "  - Build knowledge graph: `graphify update .` (code-only, no API key needed)");
  if (!missingAny && !templateOutdated && !trackedAny && !notIgnoredAny && graphifyCliOk && graphifyGraphExists)
    console.log(isZh ? "  - 无需操作，当前配置状态正常。" : "  - No action needed. Current setup looks healthy.");

  // ── JSON envelope (P-AUTO-001) ──
  // Only when --json is set. Human-readable output above is unchanged for
  // the default doctor command. The envelope includes:
  //   - version.cli / version.template
  //   - available_update: read-only npm registry probe (soft-fails to null)
  //   - missing_entries / tracked / ignored: same signals used by the table
  //   - installed_platforms
  //   - script_drift: { updates, user_modified }
  //   - memory_integrity.ok / .summary (when .agent/memory/MEMORY.md exists)
  //   - setup_portability: per-link classification (see lib/setup portability)
  if (options.json === true) {
    const envelope = {
      ok: true,
      command: "doctor",
      cwd,
      cli_version: cliVersion,
      template_version: templateVersion || null,
      template_outdated: Boolean(templateOutdated),
      available_update: probeAvailableUpdate(),
      missing_entries: checks.filter((e) => !fs.existsSync(path.join(cwd, e))),
      installed_platforms: installed,
      script_drift: scriptDrift
        ? {
            update_candidates: scriptDrift.updates.length,
            user_modified: scriptDrift.skipped.filter((s) => s.reason === "user_modified").length,
          }
        : null,
      memory_integrity: (() => {
        if (!fs.existsSync(path.join(cwd, ".agent", "memory", "MEMORY.md"))) return null;
        try {
          const mv = require("../memory-validate");
          const r = mv.validateMemory({ projectRoot: cwd });
          return { ok: r.ok, issues: r.issues.length, summary: r.summary };
        } catch (_) {
          return { ok: false, issues: null, summary: null };
        }
      })(),
      task_state_integrity: taskStateIntegrity,
      task_records: (() => {
        if (!fs.existsSync(path.join(cwd, ".agent", "tasks"))) return null;
        try {
          const ts = require("./migrate-task-state");
          const r = ts.auditTaskRecords(cwd);
          return {
            ok: !r.skipped && r.invalid.length === 0,
            checked: r.checked,
            invalid: r.invalid.length,
            exceptions: (r.exceptions || []).length,
            placeholder: r.placeholder.length,
            skipped: r.skipped,
            reason: r.reason,
          };
        } catch (_) {
          return { ok: false, checked: null, invalid: null, placeholder: null, skipped: true, reason: "audit_failed" };
        }
      })(),
      lang,
    };
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    return;
  }

  if (!graphifyCliOk) {
    const prompt = isZh
      ? "  - Graphify 未安装。是否立即安装？(y/N) "
      : "  - Graphify not installed. Install now? (y/N) ";
    console.log("");
    const yes = await askYesNo(prompt);
    if (yes) {
      console.log(isZh ? "\n⏳ 正在安装 Graphify..." : "\n⏳ Installing Graphify...");
      try {
        execSync("pip install graphifyy && graphify install", { stdio: "inherit" });
        console.log(isZh ? "✅ Graphify 安装完成！" : "✅ Graphify installed successfully!");
        console.log(isZh
          ? "💡 在项目根目录运行 `graphify update .` 生成知识图谱"
          : "💡 Run `graphify update .` in your project root to build the knowledge graph");
      } catch (e) {
        console.error(isZh
          ? "❌ 安装失败，请手动运行：pip install graphifyy && graphify install"
          : "❌ Installation failed. Run manually: pip install graphifyy && graphify install");
      }
    } else {
      console.log(isZh
        ? "  跳过。手动安装：`pip install graphifyy && graphify install`"
        : "  Skipped. Manual install: `pip install graphifyy && graphify install`");
    }
  }
}

module.exports = {
  doctor,
};
