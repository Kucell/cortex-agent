#!/usr/bin/env node
/**
 * extract-subgraph.js
 * 从 Graphify 完整图谱中裁剪与任务相关的子图，
 * 并注册到 Artifact Bus（kind: knowledge-graph）。
 *
 * 用法：
 *   node .agent/plugins/graphify/scripts/extract-subgraph.js \
 *     --task T-C06 \
 *     --files "lib/commands.js,.agent/skills/handoff/SKILL.md" \
 *     [--depth 3] [--max-nodes 50]
 */

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const CONFIG_PATH = path.join(root, '.agent/plugins/graphify/config.yml');
const GRAPHIFY_MAP = path.join(root, '.graphify/map.json');

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { task: null, files: [], depth: 3, maxNodes: 50 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--task' && args[i + 1]) result.task = args[++i];
    else if (args[i] === '--files' && args[i + 1]) result.files = args[++i].split(',').map(f => f.trim());
    else if (args[i] === '--depth' && args[i + 1]) result.depth = parseInt(args[++i], 10);
    else if (args[i] === '--max-nodes' && args[i + 1]) result.maxNodes = parseInt(args[++i], 10);
  }
  return result;
}

// ── Graphify availability check ───────────────────────────────────────────────

function checkGraphifyAvailable() {
  if (!fs.existsSync(GRAPHIFY_MAP)) {
    console.warn('⚠️  Graphify map not found (.graphify/map.json). Run: npx graphify scan');
    console.warn('    Skipping subgraph extraction (fallback: skip).');
    return false;
  }
  return true;
}

// ── Subgraph extraction ───────────────────────────────────────────────────────

function extractSubgraph(mapData, entryFiles, maxDepth, maxNodes) {
  const nodes = new Map();
  const edges = [];

  const allNodes = mapData.nodes || [];
  const allEdges = mapData.edges || [];

  // Build adjacency
  const adj = {};
  for (const node of allNodes) {
    adj[node.id] = [];
  }
  for (const edge of allEdges) {
    if (adj[edge.from]) adj[edge.from].push(edge.to);
  }

  // BFS from entry files
  const queue = [];
  for (const node of allNodes) {
    if (entryFiles.some(f => node.path && node.path.includes(f.replace(/^\.\//, '')))) {
      queue.push({ id: node.id, depth: 0 });
      nodes.set(node.id, node);
    }
  }

  while (queue.length > 0 && nodes.size < maxNodes) {
    const { id, depth } = queue.shift();
    if (depth >= maxDepth) continue;

    for (const neighborId of (adj[id] || [])) {
      if (!nodes.has(neighborId)) {
        const neighbor = allNodes.find(n => n.id === neighborId);
        if (neighbor) {
          nodes.set(neighborId, neighbor);
          queue.push({ id: neighborId, depth: depth + 1 });
          if (nodes.size >= maxNodes) break;
        }
      }
    }
  }

  // Collect relevant edges
  for (const edge of allEdges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) {
      edges.push(edge);
    }
  }

  return {
    nodes: [...nodes.values()],
    edges,
    entry_files: entryFiles,
    extracted_at: new Date().toISOString(),
    total_nodes: nodes.size,
    total_edges: edges.length,
  };
}

// ── Artifact Bus registration ─────────────────────────────────────────────────

function registerToArtifactBus(taskId, subgraphPath, subgraph) {
  const artifactBusScript = path.join(root, '.agent/artifacts/scripts/artifact-bus.js');
  if (!fs.existsSync(artifactBusScript)) return;

  try {
    const artifactBus = require(artifactBusScript);
    artifactBus.append({
      task_id: taskId,
      agent_id: 'graphify',
      kind: 'knowledge-graph',
      summary: `Graphify subgraph for ${taskId} (${subgraph.total_nodes} nodes)`,
      refs: [path.relative(root, subgraphPath)],
      payload: {
        graphify_version: '1.x',
        map_path: path.relative(root, GRAPHIFY_MAP),
        subgraph_path: path.relative(root, subgraphPath),
        entry_files: subgraph.entry_files,
        generated_at: subgraph.extracted_at,
        total_nodes: subgraph.total_nodes,
        total_edges: subgraph.total_edges,
      },
    });
    console.log(`✅ Registered to Artifact Bus as kind=knowledge-graph`);
  } catch {
    // artifact-bus not available, skip silently
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const { task, files, depth, maxNodes } = parseArgs();

  if (!task) {
    console.error('❌ --task is required. Example: --task T-C06');
    process.exit(1);
  }

  if (!checkGraphifyAvailable()) process.exit(0);

  const mapData = JSON.parse(fs.readFileSync(GRAPHIFY_MAP, 'utf8'));
  const subgraph = extractSubgraph(mapData, files.length ? files : [], depth, maxNodes);

  // Output path
  const artifactsDir = path.join(root, '.agent/artifacts', task);
  fs.mkdirSync(artifactsDir, { recursive: true });
  const subgraphPath = path.join(artifactsDir, 'graphify-subgraph.json');
  fs.writeFileSync(subgraphPath, JSON.stringify(subgraph, null, 2));

  console.log(`\n🕸  Graphify subgraph extracted for ${task}:`);
  console.log(`   Nodes: ${subgraph.total_nodes} / ${maxNodes}  Edges: ${subgraph.total_edges}`);
  console.log(`   Entry files: ${files.join(', ') || '(none specified)'}`);
  console.log(`   Output: ${path.relative(root, subgraphPath)}`);

  registerToArtifactBus(task, subgraphPath, subgraph);
}

main();
