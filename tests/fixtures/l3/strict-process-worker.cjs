'use strict';

// Fixed trusted cooperative fixture: no imports, filesystem, network, shell,
// descendants, arbitrary command arguments or environment. Only IPC proposals.
// Runtime evidence does not assert Task or acceptance completion.
const PROTOCOL = 'cortex-l3-fixture/v1';
const TASKS = new Set(['T-FIXTURE-1', 'T-FIXTURE-2', 'T-FIXTURE-3']);
const RUN = /^strict-fixture-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REF = /^fixture-evidence:[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
let started = false, received = false, runId = null, taskId = null, proposalId = null;
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function fail() { process.exit(70); }
const watchdog = setTimeout(fail, 10000);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
process.on('disconnect', () => process.exit(received ? 0 : 71));
process.on('message', (message) => {
  if (!started) {
    if (!exact(message, ['type', 'protocol', 'run_id', 'task_id'])
        || message.type !== 'start' || message.protocol !== PROTOCOL
        || typeof message.run_id !== 'string' || !RUN.test(message.run_id)
        || !TASKS.has(message.task_id) || typeof process.send !== 'function') { fail(); return; }
    started = true; runId = message.run_id; taskId = message.task_id; proposalId = 'P-FIXTURE-' + taskId.slice(-1);
    process.send({ type: 'proposal', protocol: PROTOCOL, run_id: runId, task_id: taskId, proposal_id: proposalId },
      (failure) => { if (failure) fail(); });
    return;
  }
  if (received || !exact(message, ['type', 'protocol', 'run_id', 'task_id', 'proposal_id', 'evidence'])
      || message.type !== 'proposal_result' || message.protocol !== PROTOCOL
      || message.run_id !== runId || message.task_id !== taskId || message.proposal_id !== proposalId) { fail(); return; }
  const receipt = message.evidence;
  if (!exact(receipt, ['kind', 'run_ref', 'task_id', 'proposal_id', 'evidence_refs'])
      || receipt.kind !== 'runtime_evidence' || receipt.run_ref !== 'run:' + runId
      || receipt.task_id !== taskId || receipt.proposal_id !== proposalId
      || !Array.isArray(receipt.evidence_refs) || receipt.evidence_refs.length < 1 || receipt.evidence_refs.length > 8
      || receipt.evidence_refs.some((ref) => typeof ref !== 'string' || !REF.test(ref))
      || new Set(receipt.evidence_refs).size !== receipt.evidence_refs.length) { fail(); return; }
  received = true; clearTimeout(watchdog);
  if (process.connected) process.disconnect();
  setImmediate(() => process.exit(0));
});
if (typeof process.send !== 'function' || !process.connected) fail();
