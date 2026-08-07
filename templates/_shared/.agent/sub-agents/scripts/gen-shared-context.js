"use strict";

// gen-shared-context.js — 多 agent 共享上下文生成器（提案 C2 / 消除 B3）
//
// 由 main agent 在 /parallel 或 coordinator 启动时调用，生成一份 read-only
// 共享上下文（system + rules(分级) + L0 + L1 + 选中 L2），落到 Artifact Bus：
//   .agent/artifacts/<task-id>/shared-context.json
// sub-agent 不再各自重投固定前缀，而是通过 handoff 的 shared_context_ref
// 引用该文件（复用 Artifact Bus + Handoff 协议），节省 ~8–15k tokens × (N-1)。
//
// 用法：
//   node gen-shared-context.js --task-id <task> --agent-id <main-agent> \
//       [--prefix-epoch N] [--rules "uri1,uri2"] [--l0-uris ...] [--l1-uris ...] [--l2-uris ...]
//
// 复用既有 Artifact Bus（artifact-bus.js append --kind state）落盘与注册。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.cwd();
const ARTIFACT_BUS = path.join(ROOT, ".agent", "artifacts", "scripts", "artifact-bus.js");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { args[key] = true; continue; }
    args[key] = next;
    i += 1;
  }
  return args;
}

function splitList(v) {
  return String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function fail(message, details) {
  console.error(JSON.stringify({ ok: false, error: message, details: details || {} }, null, 2));
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv);
  const taskId = args["task-id"];
  const agentId = args["agent-id"];
  if (!taskId) fail("Missing --task-id");
  if (!agentId) fail("Missing --agent-id");

  const sharedContext = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    prefix_epoch: args["prefix-epoch"] ? Number(args["prefix-epoch"]) : 1,
    task_id: taskId,
    system: { tokens_estimate: 3000 },
    rules: splitList(args.rules),
    l0: splitList(args["l0-uris"]).map((uri) => ({ uri, tier: "L0" })),
    l1: splitList(args["l1-uris"]).map((uri) => ({ uri, tier: "L1" })),
    selected_l2: splitList(args["l2-uris"]),
    estimated_tokens: 0,
  };
  sharedContext.estimated_tokens =
    3000 + sharedContext.rules.length * 500 +
    sharedContext.l0.length * 100 + sharedContext.l1.length * 2000;

  if (!fs.existsSync(ARTIFACT_BUS)) fail("Artifact Bus script not found", { path: ARTIFACT_BUS });

  const taskDir = path.join(ROOT, ".agent", "artifacts", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const sharedFile = path.join(taskDir, "shared-context.json");
  fs.writeFileSync(sharedFile, `${JSON.stringify(sharedContext, null, 2)}\n`);

  // 通过 Artifact Bus 注册（kind=state，read-only 共享上下文）。
  const cmd = [
    process.execPath, ARTIFACT_BUS, "append",
    "--task-id", taskId,
    "--agent-id", agentId,
    "--kind", "state",
    "--summary", `shared-context (epoch ${sharedContext.prefix_epoch}, ${sharedContext.estimated_tokens}t)`,
    "--payload-file", path.relative(ROOT, sharedFile),
    "--refs", path.relative(ROOT, sharedFile),
    "--status", "active",
    "--next-action", "sub-agent 通过 shared_context_ref 复用此共享上下文",
  ];
  const result = spawnSync(cmd[0], cmd.slice(1), { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) fail("Artifact Bus publish failed", { stdout: result.stdout, stderr: result.stderr });

  let busResult;
  try { busResult = JSON.parse(result.stdout); } catch (e) { busResult = { raw: result.stdout }; }

  console.log(JSON.stringify({
    ok: true,
    action: "gen-shared-context",
    task_id: taskId,
    shared_context_ref: `.agent/artifacts/${taskId}/shared-context.json`,
    prefix_epoch: sharedContext.prefix_epoch,
    estimated_tokens: sharedContext.estimated_tokens,
    artifact_path: busResult.artifact_path || null,
  }, null, 2));
}

if (require.main === module) main();

module.exports = { parseArgs, splitList };
