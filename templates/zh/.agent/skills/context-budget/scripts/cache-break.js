"use strict";

// cache-break.js — 前缀缓存失效检测器
//
// 提案 P1 配套：对 prefix-builder 生成的 prefix_region 计算稳定哈希，
// 与上一轮持久化的哈希比较。若内容变化（含 cache_version bump），
// 输出 cache_break=true 并提示 host 端丢弃旧前缀 KV 缓存、重建。
//
// 用法：
//   node cache-break.js detect --uris "u1,u2,..." [--cache-version N] [--state-file .agent/.../prefix-cache.state.json]
//   node cache-break.js reset  [--state-file ...]
//
// 退出码：detect 在「发生缓存失效」时返回 0（ok:true, cache_break:true）；
//         无变化时 ok:true, cache_break:false。脚本本身不因缓存失效而非零退出，
//         是否刷新缓存交由调用方决定是否读取返回值。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function usage() {
  console.log(`Usage:
  node cache-break.js detect --uris "<u1>,<u2>,..." [--cache-version N] [--state-file <path>]
  node cache-break.js reset [--state-file <path>]
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
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

function defaultStateFile() {
  return path.join(process.cwd(), ".agent", "skills", "context-budget", "prefix-cache.state.json");
}

function hashOf(uris, cacheVersion) {
  const payload = JSON.stringify({ v: cacheVersion || 0, uris: (uris || []).slice().sort() });
  return `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (error) {
    return null;
  }
}

function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, stateFile);
}

function detect(args) {
  const uris = String(args.uris || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cacheVersion = args["cache-version"] ? Number(args["cache-version"]) : 0;
  const stateFile = args["state-file"] || defaultStateFile();
  const current = hashOf(uris, cacheVersion);
  const prev = readState(stateFile);

  const broke = !prev || prev.hash !== current || prev.cache_version !== cacheVersion;
  const state = {
    hash: current,
    cache_version: cacheVersion,
    uris,
    updated_at: new Date().toISOString(),
  };
  writeState(stateFile, state);

  console.log(JSON.stringify({
    ok: true,
    action: "detect",
    cache_break: broke,
    reason: broke ? (prev ? "prefix_region_changed" : "no_previous_state") : "stable",
    current_hash: current,
    previous_hash: prev ? prev.hash : null,
    cache_version: cacheVersion,
    state_file: path.relative(process.cwd(), stateFile),
  }, null, 2));
}

function reset(args) {
  const stateFile = args["state-file"] || defaultStateFile();
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  console.log(JSON.stringify({ ok: true, action: "reset", state_file: path.relative(process.cwd(), stateFile) }, null, 2));
}

function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (command === "detect") return detect(args);
  if (command === "reset") return reset(args);
  usage();
  process.exit(command ? 1 : 0);
}

module.exports = { hashOf, readState, writeState };

if (require.main === module) main();
