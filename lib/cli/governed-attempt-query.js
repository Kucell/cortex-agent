/**
 * lib/cli/governed-attempt-query.js
 *
 * M-013 SP-006 / VC-010: Focused query CLI for `cortex-agent query governed-attempt-*`.
 *
 * Per P-005 §8.3: 同时修复公共 task status / event list 对 Coordination projection
 * 的路由, 避免消费者退回读取内部文件.
 *
 * Projections:
 *   - governed-attempt-progress: latest V1 state (uses queryProgress)
 *   - governed-attempt-diagnostics: bounded diagnostics list (uses queryDiagnostics)
 *
 * The I/O layer (read journal files) is the responsibility of THIS module.
 * The pure projection layer is in lib/governed-attempt-progress/query.js.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  queryProgress,
  queryDiagnostics,
  MAX_DIAGNOSTICS
} = require('../governed-attempt-progress/query');

const PROJECTIONS = ['governed-attempt-progress', 'governed-attempt-diagnostics'];

/**
 * Read the latest progress state from .agent/governed-attempt-progress/.
 * Returns null if no valid V1 state found.
 */
function readLatestState(projectPath, launchId) {
  const dir = path.join(projectPath, '.agent', 'governed-attempt-progress');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('diagnostics-') && !f.startsWith('INTERNAL_'))
    .sort((a, b) => b.localeCompare(a));
  for (const f of files) {
    if (launchId && f !== `${launchId}.json`) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (data && data.schemaVersion === '1.0' && data.taskId) return data;
    } catch {
      // skip malformed
    }
  }
  return null;
}

function readDiagnostics(projectPath, launchId) {
  const dir = path.join(projectPath, '.agent', 'governed-attempt-progress');
  if (!fs.existsSync(dir)) return null;
  const target = launchId || 'latest';
  const file = path.join(dir, `diagnostics-${target}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function governedAttemptQuery(ctx) {
  const args = ctx.args || [];
  const projection = args[1];
  if (!PROJECTIONS.includes(projection)) {
    ctx.stderr?.(`query ${projection || '<missing>'}: unsupported projection (use one of ${PROJECTIONS.join(', ')})\n`);
    process.exitCode = 2;
    return;
  }

  let projectPath = process.cwd();
  let launchId = null;
  let limit = null;
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === '--project' && args[i + 1]) { projectPath = path.resolve(args[++i]); continue; }
    if (a && a.startsWith('--project=')) { projectPath = path.resolve(a.slice('--project='.length)); continue; }
    if (a === '--launch-id' && args[i + 1]) { launchId = args[++i]; continue; }
    if (a && a.startsWith('--launch-id=')) { launchId = a.slice('--launch-id='.length); continue; }
    if (a === '--limit' && args[i + 1]) { limit = Number(args[++i]); continue; }
    if (a && a.startsWith('--limit=')) { limit = Number(a.slice('--limit='.length)); continue; }
  }

  if (projection === 'governed-attempt-progress') {
    const state = readLatestState(projectPath, launchId);
    const projectionPayload = state ? queryProgress(state) : null;
    const payload = {
      ok: true,
      projection,
      project: projectPath,
      data: projectionPayload
    };
    ctx.stdout?.(JSON.stringify(payload, null, 2) + '\n');
    return;
  }

  if (projection === 'governed-attempt-diagnostics') {
    const list = readDiagnostics(projectPath, launchId);
    let diagnosticsPayload = [];
    if (list && typeof list === 'object') {
      const stateLike = { diagnostics: Array.isArray(list) ? list : (Array.isArray(list.diagnostics) ? list.diagnostics : []) };
      diagnosticsPayload = queryDiagnostics(stateLike, { limit: limit || MAX_DIAGNOSTICS });
    }
    const payload = {
      ok: true,
      projection,
      project: projectPath,
      data: diagnosticsPayload
    };
    ctx.stdout?.(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
}

module.exports = {
  governedAttemptQuery,
  readLatestState,
  readDiagnostics,
  PROJECTIONS
};
