/**
 * tests/host-adapter/pi-json-stream.test.js
 *
 * M-013 SP-003 / VC-002: Pi read/write/test event maps to bounded activity,
 * journal contains no body or arguments.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PiJsonStreamParser, normalizeCategory } = require('../../lib/host-adapter/pi-json-stream');

test('parser: turn_start event yields bounded event', () => {
  const p = new PiJsonStreamParser();
  const result = p.parseLine('{"type":"turn_start","timestamp":"2026-08-11T03:00:00.000Z"}');
  assert.equal(result.type, 'turn_start');
  assert.equal(result.timestamp, '2026-08-11T03:00:00.000Z');
  assert.ok(!('content' in result), 'no content field');
  assert.ok(!('text' in result), 'no text field');
});

test('parser: turn_end event yields bounded event', () => {
  const p = new PiJsonStreamParser();
  const result = p.parseLine('{"type":"turn_end","timestamp":"2026-08-11T03:00:01.000Z"}');
  assert.equal(result.type, 'turn_end');
});

test('parser: tool_start (read) yields category=read', () => {
  const p = new PiJsonStreamParser();
  const result = p.parseLine('{"type":"tool_start","timestamp":"2026-08-11T03:00:00.000Z","toolName":"read_file","success":true}');
  assert.equal(result.toolName, 'read_file');
  assert.equal(result.category, 'read');
  assert.equal(result.success, true);
  assert.ok(!('arguments' in result), 'no arguments field');
  assert.ok(!('args' in result), 'no args field');
});

test('parser: tool_start (write) yields category=write', () => {
  const p = new PiJsonStreamParser();
  const result = p.parseLine('{"type":"tool_start","toolName":"write_file","timestamp":"2026-08-11T03:00:00.000Z"}');
  assert.equal(result.category, 'write');
});

test('parser: tool_start (test) yields category=test', () => {
  const p = new PiJsonStreamParser();
  const result = p.parseLine('{"type":"tool_start","toolName":"run_tests_jest","timestamp":"2026-08-11T03:00:00.000Z"}');
  assert.equal(result.category, 'test');
});

test('parser: tool_start (exec) yields category=execute', () => {
  const p = new PiJsonStreamParser();
  const result = p.parseLine('{"type":"tool_start","toolName":"bash_command","timestamp":"2026-08-11T03:00:00.000Z"}');
  assert.equal(result.category, 'execute');
});

test('parser: tool_end carries success/failure + duration + errorCode', () => {
  const p = new PiJsonStreamParser();
  const result = p.parseLine('{"type":"tool_end","toolName":"bash_command","success":false,"durationMs":1234,"errorCode":"E_TIMEOUT","timestamp":"2026-08-11T03:00:00.000Z"}');
  assert.equal(result.success, false);
  assert.equal(result.durationMs, 1234);
  assert.equal(result.errorCode, 'E_TIMEOUT');
});

test('parser: REJECTED message_start event (no body leakage)', () => {
  const p = new PiJsonStreamParser();
  const result = p.parseLine('{"type":"message_start","content":"SECRET password=abc123"}');
  assert.ok(result.error, 'message_start must be rejected');
  assert.equal(result.error, 'rejected_message_event');
  assert.ok(!('content' in result), 'rejected result must not contain content');
});

test('parser: REJECTED message_update event', () => {
  const p = new PiJsonStreamParser();
  const result = p.parseLine('{"type":"message_update","text":"leaky text","thinking":"private"}');
  assert.equal(result.error, 'rejected_message_event');
});

test('parser: REJECTED thinking event', () => {
  const p = new PiJsonStreamParser();
  const result = p.parseLine('{"type":"thinking","thinking":"private reasoning chain"}');
  assert.ok(result.error, 'thinking must be rejected');
  assert.equal(result.error, 'rejected_thinking');
});

test('parser: 100 events stream yields bounded aggregate', () => {
  const p = new PiJsonStreamParser();
  const lines = [];
  for (let i = 0; i < 50; i++) {
    lines.push(`{"type":"turn_start","timestamp":"2026-08-11T03:00:0${i % 10}.000Z"}`);
    lines.push(`{"type":"tool_start","toolName":"read_file","timestamp":"2026-08-11T03:00:0${i % 10}.000Z"}`);
  }
  const stream = lines.join('\n');
  const { events, errors } = p.parseStream(stream);
  assert.equal(events.length, 100);
  assert.equal(errors.length, 0);
  const agg = p.getAggregate();
  assert.equal(agg.turnEventCount, 50);
  assert.equal(agg.toolEventCount, 50);
  assert.equal(agg.rejectedCount, 0);
});

test('parser: rejected events counted in aggregate', () => {
  const p = new PiJsonStreamParser();
  p.parseLine('{"type":"message_start","content":"x"}');
  p.parseLine('{"type":"thinking","thinking":"y"}');
  p.parseLine('{"type":"message_update","text":"z"}');
  assert.equal(p.getAggregate().rejectedCount, 3);
});

test('parser: malformed JSON returns parse_error, does not crash', () => {
  const p = new PiJsonStreamParser();
  const result = p.parseLine('not json{');
  assert.ok(result.error, 'malformed JSON returns error');
  assert.equal(result.error, 'parse_error');
});

test('parser: empty lines skipped silently', () => {
  const p = new PiJsonStreamParser();
  const r1 = p.parseLine('');
  const r2 = p.parseLine('   ');
  const r3 = p.parseLine(null);
  assert.equal(r1, null);
  assert.equal(r2, null);
  assert.equal(r3, null);
});

test('parser: tool event carries correlationId for worktree probe linking', () => {
  const p = new PiJsonStreamParser();
  const result = p.parseLine('{"type":"tool_start","toolName":"write_file","timestamp":"2026-08-11T03:00:00.000Z","correlationId":"wb-probe-001"}');
  assert.equal(result.correlationId, 'wb-probe-001');
});

test('parser: aggregate.lastTurnAt and lastToolAt are timestamps', () => {
  const p = new PiJsonStreamParser();
  p.parseLine('{"type":"turn_start","timestamp":"2026-08-11T03:00:00.000Z"}');
  p.parseLine('{"type":"tool_start","toolName":"read_file","timestamp":"2026-08-11T03:00:01.000Z"}');
  const agg = p.getAggregate();
  assert.equal(agg.lastTurnAt, '2026-08-11T03:00:00.000Z');
  assert.equal(agg.lastToolAt, '2026-08-11T03:00:01.000Z');
});

test('parser: stream JSONL with message_start + tool_start mixed — body never leaks', () => {
  const p = new PiJsonStreamParser();
  const stream = [
    '{"type":"turn_start","timestamp":"2026-08-11T03:00:00.000Z"}',
    '{"type":"message_start","content":"SECRET_API_KEY=sk-abc123def456ghi789jkl012mno"}',
    '{"type":"tool_start","toolName":"bash_command","timestamp":"2026-08-11T03:00:01.000Z"}',
    '{"type":"message_update","text":"SELECT password FROM users WHERE id=1"}',
    '{"type":"tool_end","toolName":"bash_command","timestamp":"2026-08-11T03:00:02.000Z","success":true}',
    '{"type":"turn_end","timestamp":"2026-08-11T03:00:03.000Z"}'
  ].join('\n');
  const { events, errors } = p.parseStream(stream);
  // 4 events: turn_start, tool_start, tool_end, turn_end
  assert.equal(events.length, 4);
  // 2 errors: message_start, message_update
  assert.equal(errors.length, 2);
  // CRITICAL: no event payload contains SECRET, password, or text content
  events.forEach((ev) => {
    const serialized = JSON.stringify(ev);
    assert.ok(!/SECRET_API_KEY/.test(serialized), 'event must not contain SECRET_API_KEY');
    assert.ok(!/sk-abc/.test(serialized), 'event must not contain sk-* API key');
    assert.ok(!/password/.test(serialized), 'event must not contain password keyword');
    assert.ok(!/SELECT/.test(serialized), 'event must not contain SQL text');
    assert.ok(!('message' in ev), 'event must not contain message field');
    assert.ok(!('content' in ev), 'event must not contain content field');
    assert.ok(!('text' in ev), 'event must not contain text field');
  });
});

test('normalizeCategory: returns read for read-like tools', () => {
  assert.equal(normalizeCategory('read_file'), 'read');
  assert.equal(normalizeCategory('cat_file'), 'read');
  assert.equal(normalizeCategory('ls_dir'), 'read');
  assert.equal(normalizeCategory('grep'), 'read');
  assert.equal(normalizeCategory('find'), 'read');
});

test('normalizeCategory: returns write for write-like tools', () => {
  assert.equal(normalizeCategory('write_file'), 'write');
  assert.equal(normalizeCategory('mv'), 'write');
  assert.equal(normalizeCategory('cp'), 'write');
  assert.equal(normalizeCategory('rm'), 'write');
});

test('normalizeCategory: returns unknown for unclassified tools', () => {
  assert.equal(normalizeCategory('unknown_tool'), 'unknown');
  assert.equal(normalizeCategory('foo_bar_baz'), 'unknown');
  assert.equal(normalizeCategory(''), 'unknown');
  assert.equal(normalizeCategory(null), 'unknown');
  assert.equal(normalizeCategory(undefined), 'unknown');
});
