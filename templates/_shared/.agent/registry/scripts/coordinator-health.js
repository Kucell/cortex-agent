const fs = require('fs');
const path = require('path');

const root = process.cwd();
const registryPath = path.join(root, '.agent', 'registry', 'agents.json');
const lockEventsPath = path.join(root, '.agent', 'locks', 'lock-events.json');
const handoffsDir = path.join(root, '.agent', 'handoffs');
const artifactsDir = path.join(root, '.agent', 'artifacts');
const metricsDir = path.join(root, '.agent', 'metrics');
const outputPath = path.join(metricsDir, 'coordinator-health.json');

const STALE_THRESHOLD_MS = 30 * 60 * 1000;   // 30 min
const EXPIRED_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 h

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function classifyAge(lastHeartbeat) {
  const age = Date.now() - new Date(lastHeartbeat).getTime();
  if (age > EXPIRED_THRESHOLD_MS) return 'expired';
  if (age > STALE_THRESHOLD_MS) return 'stale';
  return 'fresh';
}

function humanAge(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m ago`;
  return `${m}m ago`;
}

function analyzeAgents(registry) {
  if (!registry) return { active: [], handed_off: [], stale: [], expired: [], total: 0 };

  const active = [], handed_off = [], stale = [], expired = [];
  for (const agent of (registry.agents || [])) {
    const ageClass = classifyAge(agent.last_heartbeat);
    const entry = {
      agent_id: agent.agent_id,
      task_id: agent.task_id,
      model: agent.model,
      status: agent.status,
      last_heartbeat: agent.last_heartbeat,
      age: humanAge(agent.last_heartbeat),
    };
    if (agent.status === 'active') {
      if (ageClass === 'expired') expired.push(entry);
      else if (ageClass === 'stale') stale.push({ ...entry, warning: 'heartbeat overdue' });
      else active.push(entry);
    } else if (agent.status === 'handed_off') {
      handed_off.push(entry);
    }
  }
  return { active, handed_off, stale, expired, total: (registry.agents || []).length };
}

function analyzeHeldLocks(lockEvents) {
  if (!lockEvents) return [];
  const scopeLastEvent = {};
  for (const ev of (lockEvents.events || [])) {
    scopeLastEvent[ev.scope] = ev;
  }
  return Object.values(scopeLastEvent)
    .filter(ev => ev.type === 'acquire')
    .map(ev => ({
      scope: ev.scope,
      held_by: ev.agent_id,
      since: ev.timestamp,
      age: humanAge(ev.timestamp),
    }));
}

function countPendingHandoffs() {
  if (!fs.existsSync(handoffsDir)) return 0;
  return fs.readdirSync(handoffsDir)
    .filter(f => f.startsWith('H-') && f.endsWith('.json'))
    .length;
}

function countRecentArtifacts() {
  if (!fs.existsSync(artifactsDir)) return 0;
  let count = 0;
  for (const task of fs.readdirSync(artifactsDir)) {
    const taskDir = path.join(artifactsDir, task);
    if (fs.statSync(taskDir).isDirectory()) {
      count += fs.readdirSync(taskDir).filter(f => f.endsWith('.json')).length;
    }
  }
  return count;
}

function computeHealthScore(agents, heldLocks) {
  let score = 100;
  score -= agents.expired.length * 20;
  score -= agents.stale.length * 10;
  score -= heldLocks.length * 5;
  return Math.max(0, score);
}

function main() {
  const registry = readJson(registryPath);
  const lockEvents = readJson(lockEventsPath);

  const agents = analyzeAgents(registry);
  const heldLocks = analyzeHeldLocks(lockEvents);
  const pendingHandoffs = countPendingHandoffs();
  const recentArtifacts = countRecentArtifacts();
  const healthScore = computeHealthScore(agents, heldLocks);

  const status = healthScore >= 90 ? 'healthy' : healthScore >= 70 ? 'degraded' : 'critical';

  const result = {
    scan: 'coordinator-health',
    generated_at: new Date().toISOString(),
    health_score: healthScore,
    status,
    summary: {
      total_agents: agents.total,
      active: agents.active.length,
      handed_off: agents.handed_off.length,
      stale: agents.stale.length,
      expired: agents.expired.length,
      held_locks: heldLocks.length,
      pending_handoffs: pendingHandoffs,
      total_artifacts: recentArtifacts,
    },
    agents,
    held_locks: heldLocks,
    warnings: [
      ...agents.expired.map(a => `🔴 Agent ${a.agent_id} (${a.task_id}) expired — last seen ${a.age}`),
      ...agents.stale.map(a => `⚠️  Agent ${a.agent_id} (${a.task_id}) stale — ${a.age}`),
      ...heldLocks.map(l => `⚠️  Lock held on ${l.scope} by ${l.held_by} since ${l.age}`),
    ],
  };

  fs.mkdirSync(metricsDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

  // console output
  const icon = status === 'healthy' ? '✅' : status === 'degraded' ? '⚠️ ' : '🔴';
  console.log(`\n${icon} Coordinator Health: ${healthScore}/100 (${status})\n`);
  console.log(`  Agents   — active: ${agents.active.length}  handed_off: ${agents.handed_off.length}  stale: ${agents.stale.length}  expired: ${agents.expired.length}`);
  console.log(`  Locks    — held: ${heldLocks.length}`);
  console.log(`  Handoffs — pending: ${pendingHandoffs}  artifacts: ${recentArtifacts}`);

  if (result.warnings.length) {
    console.log('\nWarnings:');
    result.warnings.forEach(w => console.log(' ', w));
  }
  console.log(`\n📄 Report: ${outputPath}`);
}

main();
