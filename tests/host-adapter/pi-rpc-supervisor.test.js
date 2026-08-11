/**
 * tests/host-adapter/pi-rpc-supervisor.test.js
 *
 * M-013 SP-004 / VC-007r, VC-008, VC-009: RPC supervisor + control port +
 * fencing + abort + extension UI.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PiRpcSupervisor } = require('../../lib/host-adapter/pi-rpc-supervisor');
const { ControlPort } = require('../../lib/host-adapter/control-port');
const { ExtensionUiHandler } = require('../../lib/host-adapter/extension-ui');
const { hasCapability, listCapabilities } = require('../../lib/host-adapter/pi-rpc-capability');

function makeSupervisor(authorized = true) {
  return new PiRpcSupervisor({
    fencingToken: 'fence-001',
    leaseId: 'lease-001',
    operationAttempt: 'op-001',
    authorized
  });
}

test('supervisor: agent_start transitions state to running', () => {
  const s = makeSupervisor();
  const result = s.processEvent('{"type":"agent_start"}');
  assert.equal(s.state, 'running');
  assert.equal(result.state, 'running');
});

test('supervisor: agent_settled is completion signal', () => {
  const s = makeSupervisor();
  s.processEvent('{"type":"agent_start"}');
  s.processEvent('{"type":"agent_settled"}');
  assert.equal(s.state, 'settled');
});

test('supervisor: agent_end does NOT mark completion (warning)', () => {
  const s = makeSupervisor();
  s.processEvent('{"type":"agent_start"}');
  const result = s.processEvent('{"type":"agent_end"}');
  assert.notEqual(s.state, 'settled');
  assert.equal(result.warning, 'agent_end_ignored');
});

test('supervisor: tool_execution events tracked (no body)', () => {
  const s = makeSupervisor();
  s.processEvent('{"type":"tool_execution_start","toolName":"read_file","category":"read"}');
  s.processEvent('{"type":"tool_execution_end","toolName":"read_file","category":"read"}');
  const timeline = s.getTimeline();
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].toolName, 'read_file');
  assert.equal(timeline[0].category, 'read');
  assert.ok(!('content' in timeline[0]), 'no content field');
  assert.ok(!('output' in timeline[0]), 'no output field');
});

test('steer: rejected without fencing token', () => {
  const s = new PiRpcSupervisor();
  const result = s.steer({ reason: 'no_progress', idempotencyKey: 'k-001' });
  assert.equal(result.error, 'gate_violation');
});

test('steer: rejected with missing reason', () => {
  const s = makeSupervisor();
  const result = s.steer({ idempotencyKey: 'k-001' });
  assert.equal(result.error, 'missing_params');
});

test('steer: rejected with missing idempotencyKey', () => {
  const s = makeSupervisor();
  const result = s.steer({ reason: 'no_progress' });
  assert.equal(result.error, 'missing_params');
});

test('steer: succeeds with all 4-gate + idempotency', () => {
  const s = makeSupervisor();
  const result = s.steer({ reason: 'no_progress', idempotencyKey: 'k-001' });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'steer');
  assert.equal(result.idempotencyKey, 'k-001');
});

test('abort: rejected without 4-gate', () => {
  const s = new PiRpcSupervisor();
  const result = s.abort({ reason: 'stuck', idempotencyKey: 'k-001' });
  assert.equal(result.error, 'gate_violation');
});

test('abort: succeeds with all 4-gate + idempotency + preserves worktree', () => {
  const s = makeSupervisor();
  const result = s.abort({ reason: 'stuck', idempotencyKey: 'k-001' });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'abort');
  assert.equal(result.worktreePreserved, true);
  assert.equal(result.journalPreserved, true);
  assert.equal(s.state, 'aborted');
});

test('abort: 1000 stale fencing tokens rejected 100%', () => {
  let rejected = 0;
  for (let i = 0; i < 1000; i++) {
    const s = new PiRpcSupervisor({ fencingToken: `stale-${i}`, leaseId: 'lease', operationAttempt: 'op', authorized: false });
    const result = s.steer({ reason: 'no_progress', idempotencyKey: `k-${i}` });
    if (result.error === 'gate_violation') rejected++;
  }
  assert.equal(rejected, 1000, 'all 1000 stale tokens must be rejected');
});

test('rpc-capability: before handshake has no control.*', () => {
  assert.equal(hasCapability('control.steer', 'before'), false);
  assert.equal(hasCapability('control.abort', 'before'), false);
  assert.equal(hasCapability('control.get_state', 'before'), false);
  assert.equal(hasCapability('stream.turn_events', 'before'), true);
  assert.equal(hasCapability('stream.tool_events', 'before'), true);
});

test('rpc-capability: after handshake has all control.*', () => {
  assert.equal(hasCapability('control.steer', 'after'), true);
  assert.equal(hasCapability('control.abort', 'after'), true);
  assert.equal(hasCapability('control.get_state', 'after'), true);
  assert.equal(hasCapability('evidence.worktree_probe', 'after'), true);
  assert.equal(hasCapability('evidence.validation_probe', 'after'), true);
});

test('control-port: status is read-only (no gate)', () => {
  const s = makeSupervisor();
  s.processEvent('{"type":"agent_start"}');
  const port = new ControlPort({ supervisor: s, hostCapabilities: {} });
  const result = port.status();
  assert.equal(result.state, 'running');
});

test('control-port: steer requires capability + supervisor', () => {
  const s = makeSupervisor();
  const portNoCap = new ControlPort({ supervisor: s, hostCapabilities: {} });
  const result = portNoCap.steer({ reason: 'r', idempotencyKey: 'k' });
  assert.equal(result.error, 'capability_denied');

  const portWithCap = new ControlPort({
    supervisor: s,
    hostCapabilities: { 'control.steer': true }
  });
  const result2 = portWithCap.steer({ reason: 'r', idempotencyKey: 'k2' });
  assert.equal(result2.ok, true);
});

test('control-port: abort requires capability', () => {
  const s = makeSupervisor();
  const port = new ControlPort({ supervisor: s, hostCapabilities: { 'control.abort': true } });
  const result = port.abort({ reason: 'stuck', idempotencyKey: 'k-abort' });
  assert.equal(result.ok, true);
  assert.equal(result.worktreePreserved, true);
});

test('extension-ui: dialog method (select) registers and awaits', () => {
  const ui = new ExtensionUiHandler();
  const result = ui.handleRequest({
    id: 'req-001',
    method: 'select',
    title: 'Allow?',
    options: ['yes', 'no'],
    timeout: 1000
  });
  assert.equal(result.action, 'await');
  assert.equal(result.id, 'req-001');
  assert.equal(result.timeout, 1000);
  assert.equal(ui.pendingCount(), 1);
});

test('extension-ui: fire-and-forget (notify) does not await', () => {
  const ui = new ExtensionUiHandler();
  const result = ui.handleRequest({
    id: 'req-002',
    method: 'notify',
    message: 'info'
  });
  assert.equal(result.action, 'fire_and_forget');
  assert.equal(ui.pendingCount(), 0);
});

test('extension-ui: cancel response removes pending', () => {
  const ui = new ExtensionUiHandler();
  ui.handleRequest({ id: 'req-003', method: 'confirm', title: 'OK?' });
  assert.equal(ui.pendingCount(), 1);
  const result = ui.receiveResponse({ id: 'req-003', cancelled: true });
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, true);
  assert.equal(ui.pendingCount(), 0);
});

test('extension-ui: late response is idempotent', () => {
  const ui = new ExtensionUiHandler();
  const result = ui.receiveResponse({ id: 'never-registered', value: 'blah' });
  assert.equal(result.ok, true);
  assert.equal(result.idempotent, true);
});

test('extension-ui: timeout auto-resolves', () => {
  const ui = new ExtensionUiHandler();
  // Use timeout 1ms; wait 10ms so tick expire threshold passes
  ui.handleRequest({ id: 'req-timeout', method: 'input', timeout: 1 });
  // Sync wait via sleeping in real time
  const start = Date.now();
  while (Date.now() - start < 5) { /* spin 5ms */ }
  const expired = ui.tick();
  assert.deepEqual(expired, ['req-timeout']);
  assert.equal(ui.pendingCount(), 0);
  const res = ui.getResponse('req-timeout');
  assert.ok(res.autoResolved);
});

test('rpc-capability: listCapabilities before/after handshake differs', () => {
  const before = listCapabilities('before');
  const after = listCapabilities('after');
  assert.ok(after.length > before.length, 'after handshake has more capabilities');
  assert.ok(after.includes('control.steer'));
  assert.ok(!before.includes('control.steer'));
});
