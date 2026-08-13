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

// Lazy require: keep lib/commands.js startup cheap and avoid loading
// governed-tool (which transitively imports capability-aware-dispatch
// and operation-lifecycle) when only print/help/version are invoked.
let registerMinimaxCliDiscovery = null;
try {
  registerMinimaxCliDiscovery = require("../runtime-adapters/minimax-cli-governed-tool").registerWithInitUpdateDoctor;
} catch (_) {
  registerMinimaxCliDiscovery = null;
}

async function doctor(ctx) {
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

  // ── Graphify ──
  let graphifyCliOk = false;
  try { execSync("graphify --version", { stdio: "ignore" }); graphifyCliOk = true; } catch (_) {}
  const graphifyPluginExists = fs.existsSync(path.join(cwd, ".agent", "plugins", "graphify"));
  const graphifyGraphExists  = fs.existsSync(path.join(cwd, "graphify-out", "graph.json"));
  console.log(`\n[graphify]`);
  console.log(`  - ${isZh ? "CLI 已安装（机器级）" : "CLI installed (machine)"}: ${graphifyCliOk ? "yes" : "no"}`);
  console.log(`  - ${isZh ? "插件已配置（项目级）" : "plugin configured (project)"}: ${graphifyPluginExists ? "yes" : "no"}`);
  console.log(`  - ${isZh ? "知识图谱已生成" : "graph built"}: ${graphifyGraphExists ? "yes  → graphify-out/graph.json" : "no"}`);

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
            ? `${issue.path || `.agent/memory/MEMORY.md`}:${issue.line}`
            : issue.path || `.agent/memory/${issue.type}`;
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
              ? "运行 `cortex-agent memory-validate --fix --yes` 自动修复 drift/orphan/duplicate"
              : "run `cortex-agent memory-validate --fix --yes` to auto-fix drift/orphan/duplicate"
          }`
        );
      }
    } catch (err) {
      console.log(`\n[${isZh ? "memory-integrity" : "memory-integrity"}]`);
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
