"use strict";

// ─── reconcile — MiniMax CLI read-only reconcile (ARI P-005 / M-011) ──────────
//
// Originally lived in lib/commands.js (T-FOLLOW-002 v2 module-split). Body is
// kept byte-identical to the original; only the imports change so the lazy
// adapter (`./runtime-adapters/minimax-cli-governed-tool`) is re-loaded
// per-module (it stays a top-level local so the cheap-path check works).

const path = require("node:path");

// Lazy require: keep lib/commands.js startup cheap and avoid loading
// governed-tool (which transitively imports capability-aware-dispatch
// and operation-lifecycle) when only print/help/version are invoked.
let registerMinimaxCliDiscovery = null;
try {
  registerMinimaxCliDiscovery = require("../runtime-adapters/minimax-cli-governed-tool").registerWithInitUpdateDoctor;
} catch (_) {
  registerMinimaxCliDiscovery = null;
}

function minimaxCliReconcile(ctx) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";
  if (!registerMinimaxCliDiscovery) {
    console.warn(isZh
      ? "⚠️  MiniMax CLI governed-tool adapter 未注册。检查 lib/runtime-adapters/minimax-cli-governed-tool.js 是否存在。"
      : "⚠️  MiniMax CLI governed-tool adapter not registered. Check lib/runtime-adapters/minimax-cli-governed-tool.js is present.");
    return;
  }
  const hooks = registerMinimaxCliDiscovery({
    projectRoot: cwd,
    // Note: lib/commands/ → ../../templates (was `..` before f7d4100 reorg).
    templatesRoot: path.join(__dirname, "..", "..", "templates"),
  });
  const rec = hooks.onReconcileRun({ cwd, lang });
  const skills = hooks.enumerateSkills();
  console.log("");
  console.log("🛰️  MiniMax CLI reconcile (ARI P-005 / M-011)");
  console.log(`  - ${isZh ? "二进制版本" : "binary version"}: ${rec.binary_version || "(unavailable)"}`);
  console.log(`  - ${isZh ? "认证状态" : "auth state"}: ${rec.auth_state}`);
  console.log(`  - ${isZh ? "探测白名单" : "probe allow-list"}: ${rec.probe_families.join(" / ")}`);
  console.log(`  - ${isZh ? "便携 Skill 路径" : "portable skill paths"}: ${skills.filter((s) => s.present).length}/${skills.length} ${isZh ? "已就位" : "present"}`);
  console.log(`  - ${isZh ? "snapshot_id" : "snapshot_id"}: ${rec.snapshot_id}`);
  console.log(`  - ${isZh ? "只读 reconcile：未持久化任何文件" : "read-only reconcile: no files persisted"}`);
}

module.exports = {
  minimaxCliReconcile,
};
