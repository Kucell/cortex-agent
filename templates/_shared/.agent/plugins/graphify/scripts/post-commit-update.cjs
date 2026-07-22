#!/usr/bin/env node
"use strict";

/**
 * PostCommit hook: incrementally update the Graphify knowledge graph after each git commit.
 *
 * Runs only when:
 *   1. graphify CLI is installed (graphify --version succeeds)
 *   2. graphify-out/graph.json exists (graph has been initialized)
 * Exits silently when either condition is unmet — never blocks the commit.
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
    "--summary", `Graphify PostCommit incremental update (${nodes} nodes)`,
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
  console.log(`[graphify] Graph updated: ${nodes} nodes, ${edges} edges`);
  registerToArtifactBus(nodes, edges);
} else {
  // Update failed: warn but do NOT block the commit (exit 0)
  console.warn(`[graphify] Incremental update failed (exit ${result.status}). Run 'graphify update .' manually.`);
}

process.exit(0);
