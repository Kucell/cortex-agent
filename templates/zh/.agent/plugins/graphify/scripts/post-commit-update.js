#!/usr/bin/env node
"use strict";

/**
 * PostCommit 钩子：在每次 git commit 后自动增量更新 Graphify 图谱。
 *
 * 触发条件：
 *   1. graphify CLI 已安装（graphify --version 成功）
 *   2. graphify-out/graph.json 已存在（已初始化图谱）
 * 均不满足时静默退出，不影响 commit 流程。
 */

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const cwd = process.cwd();
const graphPath = path.join(cwd, "graphify-out", "graph.json");

function graphifyAvailable() {
  try {
    execSync("graphify --version", { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

function graphExists() {
  return fs.existsSync(graphPath);
}

function readGraphCounts() {
  try {
    const graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));
    return {
      nodes: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
      edges: Array.isArray(graph.links) ? graph.links.length : 0,
    };
  } catch (_) {
    return { nodes: 0, edges: 0 };
  }
}

function registerToArtifactBus(nodes, edges) {
  const artifactBus = path.join(cwd, ".agent", "artifacts", "scripts", "artifact-bus.js");
  if (!fs.existsSync(artifactBus)) return;

  const payload = JSON.stringify({
    graphify_version: "1.x",
    map_path: "graphify-out/graph.json",
    generated_at: new Date().toISOString(),
    total_nodes: nodes,
    total_edges: edges,
    trigger: "PostCommit",
  });

  spawnSync(process.execPath, [
    artifactBus,
    "append",
    "--task-id", "global",
    "--agent-id", "graphify",
    "--kind", "knowledge-graph",
    "--summary", `Graphify PostCommit 增量更新（${nodes} nodes）`,
    "--refs", "graphify-out/graph.json",
    "--payload-json", payload,
  ], { cwd, encoding: "utf8", stdio: "ignore" });
}

if (!graphifyAvailable() || !graphExists()) {
  process.exit(0);
}

const result = spawnSync("graphify", ["update", "."], {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 120_000,
});

if (result.status === 0) {
  const { nodes, edges } = readGraphCounts();
  console.log(`[graphify] 图谱已更新：${nodes} 节点，${edges} 边`);
  registerToArtifactBus(nodes, edges);
} else {
  // 更新失败：打印警告但不阻断 commit（exit 0）
  console.warn(`[graphify] 增量更新失败（exit ${result.status}），请手动运行 graphify update .`);
}

process.exit(0);
