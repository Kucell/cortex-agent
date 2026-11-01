"use strict";

// Independent development transport accounting. No worker/process-tree lease,
// authentication, JSON parser or integration with managed caller authority.
const accounts = new WeakMap();
function integer(value, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError("bounded positive integer required");
  return value;
}
class BoundedChannelError extends Error {
  constructor(code) { super(code); this.name = "BoundedChannelError"; this.code = code; }
}
function error(code) { return new BoundedChannelError("ERR_BOUNDED_" + code); }
class ByteBudget {
  constructor({ maxActive = 4, maxResidentBytes = 1048576, maxReceivedBytes = 4194304, maxSentBytes = 4194304 } = {}) {
    accounts.set(this, { maxActive: integer(maxActive, 64), maxResidentBytes: integer(maxResidentBytes, 67108864),
      maxReceivedBytes: integer(maxReceivedBytes, 67108864), maxSentBytes: integer(maxSentBytes, 67108864),
      active: 0, residentBytes: 0, retainedResultBytes: 0, receivedBytes: 0, pendingReadBytes: 0, sentBytes: 0 });
    Object.freeze(this);
  }
  snapshot() { return Object.freeze({ ...accounts.get(this) }); }
}
Object.freeze(ByteBudget.prototype);
function reserve(budget, capacity) {
  const a = accounts.get(budget);
  if (!a) throw new TypeError("shared ByteBudget required");
  if (a.active >= a.maxActive || capacity > a.maxResidentBytes - a.residentBytes) throw error("ADMISSION");
  a.active++; a.residentBytes += capacity;
  let closed = false, readCredit = 0;
  return Object.freeze({
    readCapacity(maximum) {
      if (readCredit) return readCredit;
      const grant = Math.min(maximum, a.maxReceivedBytes - a.receivedBytes - a.pendingReadBytes);
      if (grant < 1) throw error("TOTAL_RECEIVED");
      a.pendingReadBytes += grant; readCredit = grant;
      return grant;
    },
    received(n) {
      if (n > readCredit) throw error("READ_RUNTIME");
      a.pendingReadBytes -= readCredit; readCredit = 0;
      a.receivedBytes += n;
    },
    sent(n) {
      if (n > a.maxSentBytes - a.sentBytes) throw error("TOTAL_SENT");
      a.sentBytes += n;
    },
    closed(retainedBytes) {
      if (closed) return;
      closed = true; a.pendingReadBytes -= readCredit; readCredit = 0;
      a.active--;
      // Do NOT refund any byte reservation. Callers can retain a closed handle
      // or successful Buffer, and native write callbacks may still hold bytes.
      // This deliberately bounds lifetime buffer allocations, conservatively
      // stronger than a reusable resident pool; it is not an RSS measurement.
      a.retainedResultBytes += retainedBytes;
    },
  });
}
module.exports = { ByteBudget, BoundedChannelError, error, integer, reserve };
