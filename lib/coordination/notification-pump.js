"use strict";

const {
  computeBackoff,
  deliveryKey,
  evaluateNotification,
  normalizeRetry,
  targetIdentity,
} = require("./notification-policy");

function targetMatches(target, selector) {
  if (!selector) return true;
  if (selector.actorId && target.actorId !== selector.actorId) return false;
  if (selector.kind && target.kind !== selector.kind) return false;
  return true;
}

class NotificationPump {
  constructor(options) {
    if (!options || !options.journal || !options.cursor || !options.adapter) {
      throw new TypeError("journal, cursor and adapter are required");
    }
    if (typeof options.adapter.deliver !== "function") {
      throw new TypeError("adapter.deliver must be a function");
    }
    this.journal = options.journal;
    this.cursor = options.cursor;
    this.adapter = options.adapter;
    this.consumerId = options.cursor.consumerId;
    this.target = options.target || null;
    this.clock = options.clock || Date.now;
    this.retry = normalizeRetry(options.retry);
    if (options.recoverExhausted !== false) this.cursor.resetExhausted();
  }

  async runOnce() {
    const events = this.journal.readAll();
    const report = { scanned: events.length, delivered: 0, acknowledged: 0, deferred: 0, failed: 0 };

    for (const event of events) {
      const policy = evaluateNotification(event);
      if (!policy.deliver) continue;
      for (const target of event.targets || []) {
        if (!targetMatches(target, this.target)) continue;
        const key = deliveryKey(event.eventId, this.consumerId, target);
        const current = this.cursor.read();
        if (current.acknowledged[key]) continue;
        const pending = current.pending[key];
        if (pending && (pending.exhausted || Date.parse(pending.nextAttemptAt) > this.clock())) {
          report.deferred += 1;
          continue;
        }
        const outcome = await this._deliver(event, target, key, policy, pending);
        report[outcome] += 1;
      }
    }
    this.cursor.advanceHighWater(events.length);
    return report;
  }

  acknowledge(eventId, target) {
    const key = deliveryKey(eventId, this.consumerId, target);
    return this.cursor.acknowledge(key, {
      eventId,
      target: targetIdentity(target),
    });
  }

  async _deliver(event, target, key, policy, previous) {
    const attempts = (previous ? previous.attempts : 0) + 1;
    try {
      const result = await this.adapter.deliver({
        event,
        target,
        consumerId: this.consumerId,
        deliveryKey: key,
        attempt: attempts,
        policy,
      });
      if (!policy.ackRequired || (result && result.acknowledged === true)) {
        this.cursor.acknowledge(key, {
          eventId: event.eventId,
          target: targetIdentity(target),
        });
        return "acknowledged";
      }
      this._recordRetry(event, target, key, attempts, null);
      return "delivered";
    } catch (error) {
      this._recordRetry(event, target, key, attempts, error);
      return "failed";
    }
  }

  _recordRetry(event, target, key, attempts, error) {
    const exhausted = attempts >= this.retry.maxAttempts;
    const delay = computeBackoff(attempts, this.retry);
    this.cursor.recordPending(key, {
      eventId: event.eventId,
      target: targetIdentity(target),
      attempts,
      exhausted,
      nextAttemptAt: new Date(this.clock() + delay).toISOString(),
      lastError: error ? String(error.code || error.message || "delivery_failed").slice(0, 256) : null,
    });
  }
}

module.exports = {
  NotificationPump,
  targetMatches,
};
