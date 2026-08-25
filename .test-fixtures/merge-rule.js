"use strict";
const fs = require("fs");

const ZH_SECTION = [
  "## 跨仓库 / 跨开发者共享",
  "项目级提案组（`projects/<project-slug>/`）是自包含目录，可以整体共享给另一个开发者或仓库：",
  "把目录放到对方的 `.agent/plans/proposals/projects/<slug>/` 标准路径后，`/approve`、`/plan`、",
  "`/mission`、`/publish-docs` 都能直接识别。",
  "注意事项（双仓联合提案尤其重要）：",
  "- `.agent/` 通常被 gitignore，**不能靠 git clone/push 传递**；用 tar/zip 打包或直接复制目录。",
  "- 双仓联合提案必须把两侧分册（后台仓 + 移动端仓的 `projects/<slug>/`）一起共享。",
  "- `cross_project_peers`、`relations.md`、`index.md`、topology `host_root` 中的绝对路径",
  "  在新机器上要改写为本地路径。",
  "- 用符号链接镜像的共享决策（如 `decisions/D-xxx`）打包后会打散，接手后要重建链接。",
  "一键打包 / 导入请使用 `/proposal-share`（`.agent/workflows/proposal-share.md`）：自动收集",
  "proposals + missions + validation-contract + topology + peer 分册，做绝对路径 token 化与符号链接",
  "重建；运行时状态（锁、分支、未合并 commit、Decision/Waitpoint/Run）走 `/handoff` 双格式产物。",
  "## 禁止事项",
].join("\n");

const EN_SECTION = [
  "## Cross-Repository / Cross-Developer Sharing",
  "Project proposal groups (`projects/<project-slug>/`) are self-contained directories and can be",
  "shared as a whole with another developer or repository: once placed at the standard path",
  "`.agent/plans/proposals/projects/<slug>/` on the receiving side, `/approve`, `/plan`,",
  "`/mission`, and `/publish-docs` recognize them directly.",
  "Notes (especially for dual-repo joint proposals):",
  "- `.agent/` is usually gitignored, so **git clone/push cannot transport it**; use tar/zip",
  "  packaging or direct directory copy.",
  "- A dual-repo joint proposal must share BOTH volumes (the backend repo and the mobile repo",
  "  `projects/<slug>/`).",
  "- Absolute paths in `cross_project_peers`, `relations.md`, `index.md`, and topology",
  "  `host_root` must be rewritten to local paths on the new machine.",
  "- Shared decisions mirrored via symlinks (e.g. `decisions/D-xxx`) are flattened by packaging and",
  "  must be re-linked after handover.",
  "For one-command packaging / import use `/proposal-share` (`.agent/workflows/proposal-share.md`):",
  "it collects proposals + missions + validation-contract + topology + peer volumes, tokenizes absolute",
  "paths and rebuilds symlinks; runtime state (locks, branches, unmerged commits,",
  "Decisions/Waitpoints/Runs) travels via the dual-format `/handoff` artifacts.",
  "## Forbidden",
].join("\n");

const targets = [
  { path: "/Users/workspace/code/csm-view-1/.agent/rules/proposal-structure.md", anchor: "## 禁止事项", section: ZH_SECTION, lang: "zh" },
  { path: "/Users/workspace/code/Samkoon APP/samkoonyun-mobile/.agent/rules/proposal-structure.md", anchor: "## 禁止事项", section: ZH_SECTION, lang: "zh" },
  { path: "/Users/workspace/code/HMI/SamHMI/.agent/rules/proposal-structure.md", anchor: "## 禁止事项", section: ZH_SECTION, lang: "zh" },
  { path: "/Users/workspace/code/HMI/hmi-platform/.agent/rules/proposal-structure.md", anchor: "## Forbidden", section: EN_SECTION, lang: "en" },
];

for (const t of targets) {
  let content = fs.readFileSync(t.path, "utf8");
  if (content.includes("跨仓库 / 跨开发者共享") || content.includes("Cross-Repository / Cross-Developer")) {
    console.log("SKIP (already has section):", t.path);
    continue;
  }
  const idx = content.indexOf(t.anchor);
  if (idx === -1) { console.log("ANCHOR NOT FOUND:", t.path, "| anchor:", t.anchor); continue; }
  content = content.slice(0, idx) + t.section + content.slice(idx + t.anchor.length);
  fs.writeFileSync(t.path, content, "utf8");
  console.log("MERGED:", t.lang, t.path);
}

for (const t of targets) {
  const c = fs.readFileSync(t.path, "utf8");
  const ok = t.lang === "zh" ? c.includes("跨仓库 / 跨开发者共享") : c.includes("Cross-Repository / Cross-Developer");
  console.log("verify:", ok ? "OK" : "FAIL", t.path);
}
