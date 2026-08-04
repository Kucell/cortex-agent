"use strict";

/**
 * lib/event-bus/event-bus.js
 *
 * Framework Event Bus - core integration layer.
 *
 * Ties together:
 *   - event-types.js  (schema validation, event building, ID generation)
 *   - persistence.js  (JSONL append, rotate, flock, subs, acks, dedupe)
 *   - fs-watcher.js   (cross-platform file watching for fan-out)
 *
 * Public API (per design spec §4.1):
 *   createEventBus({ busId, dataDir, opts })
 *     -> { busId, publish, subscribe, ack, list, history, close }
 *
 * Zero npm dependencies - node:fs, node:path, node:crypto only.
 *
 * References:
 *   - docs/architecture/framework-event-bus-design.md §4.1
 *   - .agent/missions/M-004/validation-contract.json VC-003, VC-005
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const et = require("./event-types");
const { createPersistence } = require("./persistence");
const { createFsWatcher } = require("./fs-watcher");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ACK_TIMEOUT_MS = 30000;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_DATA_DIR_PREFIX = ".agent/event-bus";

// ---------------------------------------------------------------------------
// Event bus factory
// ---------------------------------------------------------------------------

function createEventBus(opts) {
  return new EventBus(opts);
}

class EventBus {
  constructor(opts) {
    this.busId = opts.busId;
    this.dataDir = opts.dataDir || path.join(process.cwd(), DEFAULT_DATA_DIR_PREFIX, this.busId);

    this._persistence = createPersistence({
      dataDir: this.dataDir,
      fsync: opts.fsync !== false,
      archiveCapBytes: opts.archiveCapBytes,
      totalCapBytes: opts.totalCapBytes,
    });

    this._defaultAckTimeoutMs = opts.defaultAckTimeoutMs || DEFAULT_ACK_TIMEOUT_MS;
    this._defaultRetryCount = opts.defaultRetryCount || DEFAULT_RETRY_COUNT;

    // In-memory subscriber handlers (not persisted - functions can't be serialized)
    this._handlers = new Map(); // subscription_id -> { handler, filter, opts }

    // Watcher
    this._watcher = null;
    this._closed = false;

    // Initialize
    this._persistence.init();
  }

  // -------------------------------------------------------------------------
  // publish
  // -------------------------------------------------------------------------

  /**
   * Publish an event to the bus.
   * @param {object} eventInput - { event_name, payload, correlation? }
   * @param {object} ctx        - { producer, sessionId?, busId, missionId?, ... }
   * @returns {{ ok: boolean, event_id: string, persisted_at: string, deduped?: boolean }}
   */
  publish(eventInput, ctx) {
    if (this._closed) throw new Error("EventBus is closed");

    const fullCtx = Object.assign({}, ctx, { busId: ctx.busId || this.busId });
    const event = et.buildEvent(eventInput, fullCtx);

    const validation = et.validateEvent(event);
    if (!validation.valid) {
      throw new Error("event_validation_failed: " + validation.errors.join("; "));
    }

    if (this._persistence.isDuplicate(event.event_id)) {
      return { ok: true, event_id: event.event_id, persisted_at: event.occurred_at, deduped: true };
    }

    const result = this._persistence.append(event);
    this._fanOut(event);
    return result;
  }

  // -------------------------------------------------------------------------
  // subscribe
  // -------------------------------------------------------------------------

  /**
   * Subscribe to events matching a filter.
   * @param {object} filter - { event_names?, namespace?, correlation? }
   * @param {function} handler - (event, ctx) => { ack: boolean, error?: Error }
   * @param {object} [opts] - { ackTimeoutMs?, retryCount? }
   * @returns {string} subscription_id
   */
  subscribe(filter, handler, opts) {
    if (this._closed) throw new Error("EventBus is closed");
    opts = opts || {};
    const subscriptionId = "sub-" + crypto.randomUUID();

    const sub = {
      subscription_id: subscriptionId,
      filter: filter,
      handler: handler.name || "anonymous",
      ack_timeout_ms: opts.ackTimeoutMs || this._defaultAckTimeoutMs,
      retry_count: opts.retryCount !== undefined ? opts.retryCount : this._defaultRetryCount,
      last_read_offset: this._persistence.getEventsSize(),
      created_at: new Date().toISOString(),
      last_ack_at: null,
    };

    this._persistence.upsertSub(sub);
    this._handlers.set(subscriptionId, { handler: handler, filter: filter, opts: opts });
    this._ensureWatcher();
    return subscriptionId;
  }

  // -------------------------------------------------------------------------
  // ack
  // -------------------------------------------------------------------------

  ack(subscriptionId, eventId, status) {
    const ackRecord = {
      event_id: eventId,
      status: status,
      acked_at: new Date().toISOString(),
    };
    this._persistence.writeAck(subscriptionId, ackRecord);

    const subs = this._persistence.readSubs();
    const sub = subs.subscriptions.find((s) => s.subscription_id === subscriptionId);
    if (sub) {
      sub.last_ack_at = ackRecord.acked_at;
      this._persistence.upsertSub(sub);
    }
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  list(filter) {
    const result = this._persistence.readEvents(filter);
    const limit = (filter && filter.limit) || 0;
    const offset = (filter && filter.offset) || 0;
    const nextOffset = (limit > 0 && (offset + limit) < result.total) ? offset + limit : 0;
    return { events: result.events, total: result.total, next_offset: nextOffset };
  }

  // -------------------------------------------------------------------------
  // history
  // -------------------------------------------------------------------------

  history(subscriptionId, opts) {
    opts = opts || {};
    let acks = this._persistence.readAcks(subscriptionId);
    if (opts.since) acks = acks.filter((a) => a.acked_at >= opts.since);
    if (opts.until) acks = acks.filter((a) => a.acked_at <= opts.until);
    if (opts.limit) acks = acks.slice(0, opts.limit);

    const subs = this._persistence.readSubs();
    const sub = subs.subscriptions.find((s) => s.subscription_id === subscriptionId);

    let events = [];
    if (sub) {
      const filter = {};
      if (sub.filter && sub.filter.event_names && sub.filter.event_names.length === 1) {
        filter.event_name = sub.filter.event_names[0];
      }
      if (sub.filter && sub.filter.correlation) {
        filter.correlation = sub.filter.correlation;
      }
      if (opts.since) filter.since = opts.since;
      if (opts.until) filter.until = opts.until;
      events = this._persistence.readEvents(filter).events;
    }

    const stats = {
      total: events.length,
      acked: acks.filter((a) => a.status === "success").length,
      retried: acks.filter((a) => a.status === "rejected").length,
      escalated: acks.filter((a) => a.status === "escalated").length,
    };

    return { acks, events, stats };
  }

  // -------------------------------------------------------------------------
  // Fan-out (internal)
  // -------------------------------------------------------------------------

  _ensureWatcher() {
    if (this._watcher) return;
    const eventsPath = path.join(this.dataDir, "events.jsonl");
    this._watcher = createFsWatcher({
      filePath: eventsPath,
      onChange: () => this._onFileChange(),
      pollFallbackMs: 1000,
      debounceMs: 25,
    });
    this._watcher.start();
  }

  _onFileChange() {
    const subs = this._persistence.readSubs();
    for (const sub of subs.subscriptions) {
      const handlerEntry = this._handlers.get(sub.subscription_id);
      if (!handlerEntry) continue;
      const newEvents = this._persistence.readEventsFromOffset(sub.last_read_offset || 0);
      if (newEvents.length === 0) continue;
      for (const event of newEvents) {
        if (this._matchesFilter(event, handlerEntry.filter)) {
          this._deliver(sub, event, handlerEntry);
        }
      }
      this._persistence.updateSubOffset(sub.subscription_id, this._persistence.getEventsSize());
    }
  }

  _fanOut(event) {
    const subs = this._persistence.readSubs();
    for (const sub of subs.subscriptions) {
      const handlerEntry = this._handlers.get(sub.subscription_id);
      if (!handlerEntry) continue;
      if (this._matchesFilter(event, handlerEntry.filter)) {
        this._deliver(sub, event, handlerEntry);
      }
      this._persistence.updateSubOffset(sub.subscription_id, this._persistence.getEventsSize());
    }
  }

  _deliver(sub, event, handlerEntry) {
    const maxRetries = sub.retry_count !== undefined ? sub.retry_count : this._defaultRetryCount;
    const ackRequired = et.requiresAck(event.event_name);
    const ctx = {
      subscription_id: sub.subscription_id,
      mission_id: event.correlation ? event.correlation.mission_id : undefined,
      subagent_id: event.correlation ? event.correlation.subagent_id : undefined,
      ack_timeout_ms: sub.ack_timeout_ms || this._defaultAckTimeoutMs,
    };

    let attempt = 0;
    const self = this;
    const attemptDelivery = () => {
      attempt++;
      try {
        const result = handlerEntry.handler(event, ctx);
        if (result && typeof result.then === "function") {
          result.then(function(res) {
            if (res && res.ack) {
              self.ack(sub.subscription_id, event.event_id, "success");
            } else if (ackRequired) {
              if (attempt < maxRetries) {
                setTimeout(attemptDelivery, 10);
              } else {
                self.ack(sub.subscription_id, event.event_id, "escalated");
              }
            } else {
              self.ack(sub.subscription_id, event.event_id, "success");
            }
          }).catch(function() {
            if (attempt < maxRetries) {
              setTimeout(attemptDelivery, 10);
            } else if (ackRequired) {
              self.ack(sub.subscription_id, event.event_id, "escalated");
            }
          });
        } else {
          if (result && result.ack) {
            self.ack(sub.subscription_id, event.event_id, "success");
          } else if (ackRequired) {
            if (attempt < maxRetries) {
              setTimeout(attemptDelivery, 10);
            } else {
              self.ack(sub.subscription_id, event.event_id, "escalated");
            }
          } else {
            self.ack(sub.subscription_id, event.event_id, "success");
          }
        }
      } catch (e) {
        if (attempt < maxRetries) {
          setTimeout(attemptDelivery, 10);
        } else if (ackRequired) {
          self.ack(sub.subscription_id, event.event_id, "escalated");
        }
      }
    };
    attemptDelivery();
  }

  _matchesFilter(event, filter) {
    if (!filter) return true;
    if (filter.event_names && filter.event_names.length > 0) {
      const matched = filter.event_names.some(function(name) {
        if (name.indexOf("*") !== -1) {
          var prefix = name.replace(/\*$/, "");
          return event.event_name.startsWith(prefix);
        }
        return event.event_name === name;
      });
      if (!matched) return false;
    }
    if (filter.namespace) {
      if (filter.namespace === "custom:*" && event.event_name.indexOf("custom:") !== 0) return false;
      if (filter.namespace === "subagent_*" && event.event_name.indexOf("subagent_") !== 0) return false;
    }
    if (filter.correlation) {
      if (filter.correlation.mission_id && (!event.correlation || event.correlation.mission_id !== filter.correlation.mission_id)) return false;
      if (filter.correlation.subagent_id && (!event.correlation || event.correlation.subagent_id !== filter.correlation.subagent_id)) return false;
      if (filter.correlation.parent_run_id && (!event.correlation || event.correlation.parent_run_id !== filter.correlation.parent_run_id)) return false;
    }
    return true;
  }

  unsubscribe(subscriptionId) {
    this._handlers.delete(subscriptionId);
    this._persistence.removeSub(subscriptionId);
  }

  close() {
    this._closed = true;
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    this._handlers.clear();
    this._persistence.close();
  }
}

module.exports = {
  createEventBus,
  EventBus,
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_RETRY_COUNT,
};
