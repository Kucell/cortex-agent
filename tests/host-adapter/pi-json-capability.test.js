/**
 * tests/host-adapter/pi-json-capability.test.js
 *
 * M-013 SP-003 / VC-007j: JSON mode does NOT expose control.steer or control.abort.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getCapabilities, hasCapability, listCapabilities, listDeniedCapabilities } = require('../../lib/host-adapter/pi-json-capability');

test('capability: stream.turn_events is enabled', () => {
  assert.equal(hasCapability('stream.turn_events'), true);
});

test('capability: stream.tool_events is enabled', () => {
  assert.equal(hasCapability('stream.tool_events'), true);
});

test('capability: control.steer is DISABLED in JSON mode', () => {
  assert.equal(hasCapability('control.steer'), false);
});

test('capability: control.abort is DISABLED in JSON mode', () => {
  assert.equal(hasCapability('control.abort'), false);
});

test('capability: control.get_state is DISABLED in JSON mode', () => {
  assert.equal(hasCapability('control.get_state'), false);
});

test('capability: evidence.worktree_probe is enabled', () => {
  assert.equal(hasCapability('evidence.worktree_probe'), true);
});

test('capability: evidence.validation_probe is enabled', () => {
  assert.equal(hasCapability('evidence.validation_probe'), true);
});

test('capability: listCapabilities returns only enabled', () => {
  const enabled = listCapabilities();
  assert.ok(enabled.includes('stream.turn_events'));
  assert.ok(enabled.includes('stream.tool_events'));
  assert.ok(enabled.includes('evidence.worktree_probe'));
  assert.ok(enabled.includes('evidence.validation_probe'));
  assert.ok(!enabled.includes('control.steer'));
  assert.ok(!enabled.includes('control.abort'));
  assert.ok(!enabled.includes('control.get_state'));
});

test('capability: listDeniedCapabilities returns control.* only', () => {
  const denied = listDeniedCapabilities();
  assert.ok(denied.includes('control.steer'));
  assert.ok(denied.includes('control.abort'));
  assert.ok(denied.includes('control.get_state'));
  assert.equal(denied.length, 3);
});

test('capability: getCapabilities returns a copy (not mutable reference)', () => {
  const a = getCapabilities();
  const b = getCapabilities();
  assert.notEqual(a, b);
  // PI_JSON_CAPABILITIES uses dot-notation keys (flat), not nested objects
  a['control.steer'] = true;
  assert.equal(hasCapability('control.steer'), false, 'mutation must not affect frozen source');
});
