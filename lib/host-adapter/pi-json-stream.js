/**
 * lib/host-adapter/pi-json-stream.js
 *
 * M-013 SP-003 / VC-002, VC-007j, VC-011j: Pi `--mode json` stream adapter.
 *
 * Pure JSONL parser + bounded activity classifier for Pi JSONL events.
 *
 * Per P-005 §5.1 (strict whitelist):
 *   - turn_start / turn_end timestamps ✓
 *   - tool name normalized category (read / write / execute / test / unknown) ✓
 *   - success/failure/duration/bounded error code ✓
 *   - tool event ↔ worktree probe correlation ID ✓
 *
 * Per P-005 §5.1 (explicit forbidden):
 *   - message_* events REJECTED (text body would leak)
 *   - thinking REJECTED (private reasoning chain)
 *   - tool arguments REJECTED (PII / secrets)
 *   - tool result body REJECTED (source code / secrets)
 *
 * This is a pure module: no I/O, no fs, no network. The caller feeds raw
 * JSONL lines; the module returns bounded activity events.
 */
'use strict';

class PiJsonStreamParser {
  constructor() {
    this.aggregate = {
      turnEvents: [],
      toolEvents: [],
      lastTurnAt: null,
      lastToolAt: null,
      rejectedCount: 0
    };
  }

  /**
   * Parse a single JSONL line. Returns bounded event or null.
   * @param {string} line
   * @returns {object|null} bounded event or { error, ... } or null
   */
  parseLine(line) {
    if (!line || typeof line !== 'string' || !line.trim()) return null;
    let event;
    try {
      event = JSON.parse(line);
    } catch (e) {
      return { error: 'parse_error', message: e.message?.slice(0, 200) };
    }

    if (!event || typeof event !== 'object') {
      return { error: 'invalid_event_shape' };
    }

    // Reject message_* events (would leak text body)
    if (typeof event.type === 'string' && event.type.startsWith('message_')) {
      this.aggregate.rejectedCount++;
      return { error: 'rejected_message_event', eventType: event.type };
    }

    // Reject thinking events (private reasoning)
    if (event.type === 'thinking' || event.thinking !== undefined) {
      this.aggregate.rejectedCount++;
      return { error: 'rejected_thinking', eventType: event.type || 'thinking' };
    }

    const ts = event.timestamp || new Date().toISOString();

    // Turn events
    if (event.type === 'turn_start' || event.type === 'turn_end') {
      this.aggregate.lastTurnAt = ts;
      const bounded = { type: event.type, timestamp: ts };
      this.aggregate.turnEvents.push(bounded);
      return bounded;
    }

    // Agent settled — closure marker (per P-005 §15.3 fake-host scenario):
    // the JSONL stream emits agent_settled when the agent has finished its
    // turn. The parser surfaces this verbatim so downstream code (evidence
    // ledger / reducer heartbeat adapter) can map it to its own semantics.
    if (event.type === 'agent_settled') {
      this.aggregate.lastTurnAt = ts;
      const bounded = { type: 'agent_settled', timestamp: ts };
      this.aggregate.turnEvents.push(bounded);
      return bounded;
    }

    // Tool events
    if (event.type === 'tool_start' || event.type === 'tool_end' || event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      const toolName = event.toolName || event.name || 'unknown';
      const category = normalizeCategory(toolName);
      const bounded = {
        type: event.type,
        timestamp: ts,
        toolName,
        category,
        success: event.success !== false,
        durationMs: typeof event.durationMs === 'number' ? event.durationMs : null,
        errorCode: event.errorCode || null,
        correlationId: event.correlationId || null
      };
      this.aggregate.lastToolAt = ts;
      this.aggregate.toolEvents.push(bounded);
      return bounded;
    }

    return { error: 'unknown_event', eventType: event.type || 'unknown' };
  }

  /**
   * Parse a complete JSONL stream. Returns events + errors.
   * @param {string} text
   * @returns {{events: object[], errors: object[]}}
   */
  parseStream(text) {
    if (typeof text !== 'string') return { events: [], errors: [] };
    const lines = text.split('\n');
    const events = [];
    const errors = [];
    for (const line of lines) {
      const result = this.parseLine(line);
      if (result === null) continue;
      if (result.error) errors.push(result);
      else events.push(result);
    }
    return { events, errors };
  }

  /** Return aggregate state (counters, not raw bodies). */
  getAggregate() {
    return {
      turnEventCount: this.aggregate.turnEvents.length,
      toolEventCount: this.aggregate.toolEvents.length,
      rejectedCount: this.aggregate.rejectedCount,
      lastTurnAt: this.aggregate.lastTurnAt,
      lastToolAt: this.aggregate.lastToolAt
    };
  }

  /** Reset aggregate. */
  reset() {
    this.aggregate = {
      turnEvents: [],
      toolEvents: [],
      lastTurnAt: null,
      lastToolAt: null,
      rejectedCount: 0
    };
  }
}

/**
 * Normalize tool name to bounded category.
 * @param {string} toolName
 * @returns {'read'|'write'|'execute'|'test'|'unknown'}
 */
function normalizeCategory(toolName) {
  if (typeof toolName !== 'string') return 'unknown';
  const lower = toolName.toLowerCase();
  if (lower.includes('read') || lower.startsWith('ls') || lower.startsWith('cat') || lower.startsWith('grep') || lower.startsWith('find')) return 'read';
  if (lower.includes('write') || lower.startsWith('echo') || lower.startsWith('mv') || lower.startsWith('cp') || lower.startsWith('rm')) return 'write';
  if (lower.includes('test') || lower.includes('pytest') || lower.includes('jest') || lower.includes('tap') || lower.includes('mocha')) return 'test';
  if (lower.startsWith('exec') || lower.startsWith('bash') || lower.startsWith('sh') || lower.startsWith('run')) return 'execute';
  return 'unknown';
}

module.exports = {
  PiJsonStreamParser,
  normalizeCategory
};
