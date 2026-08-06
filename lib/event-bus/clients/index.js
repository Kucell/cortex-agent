"use strict";

/**
 * lib/event-bus/clients/index.js
 *
 * M-004 MS-003 / F-006b — clients registry.
 *
 * 4 个 client 槽位 (per FAE-002 §3.1 / design spec):
 *   - parent-resume       (本 MS 实施, 默认注册)
 *   - coordination-sync   (MS-004 实施)
 *   - dashboard-push      (MS-004 实施)
 *   - notification-pump   (MS-004 实施)
 *
 * API:
 *   clients.register(name, handler)  - 注册 client
 *   clients.handle(event, ctx)       - fan-out 到所有 registered client
 *   clients.list()                   - 当前注册列表
 *
 * 每个 client handler 签名为 (event, ctx) => { ack: bool, ... }
 * 注册表按 insertion order fan-out (跟 subagent fan-out 行为一致).
 *
 * 零依赖 — 纯 in-memory Map + Array.
 *
 * Reference:
 *   - docs/architecture/framework-event-bus-design.md §3.1, §4.4
 */

const _registry = new Map(); // name -> handler
let _defaultRegistered = false;

function _ensureDefaults() {
  if (_defaultRegistered) return;
  try {
    const parentResume = require("./parent-resume");
    // parent-resume 没有 1-arg handler 形式, 但我们注册一个 fan-out adapter
    _registry.set("parent-resume", function parentResumeFanout(event, ctx) {
      return parentResume.handle(event, ctx);
    });
  } catch (_) { /* parent-resume not loaded yet — caller may register manually */ }
  _defaultRegistered = true;
}

function register(name, handler) {
  if (!name || typeof name !== "string") {
    throw new Error("clients.register: name must be a non-empty string");
  }
  if (typeof handler !== "function") {
    throw new Error("clients.register: handler must be a function");
  }
  _registry.set(name, handler);
}

function unregister(name) {
  return _registry.delete(name);
}

function get(name) {
  _ensureDefaults();
  return _registry.get(name) || null;
}

/**
 * Fan-out: invoke every registered client handler in insertion order.
 * Aggregates per-client results; never throws (each handler is wrapped).
 * @param {object} event
 * @param {object} ctx
 * @returns {{ ok: boolean, results: Array<{ name, ok, error?, payload? }> }}
 */
function handle(event, ctx) {
  _ensureDefaults();
  const results = [];
  for (const [name, handler] of _registry.entries()) {
    let payload = null;
    let error = null;
    let ok = false;
    try {
      const r = handler(event, ctx);
      if (r && typeof r.then === "function") {
        // async handler — for fan-out, we treat as deferred (ack will be called by handler
        // out-of-band). Surface pending status.
        r.then(
          function (v) { /* fire-and-forget for fan-out path */ },
          function (e) { /* swallow */ },
        );
        ok = false; // pending
        payload = { pending: true };
      } else {
        ok = !!(r && r.ack);
        payload = r || null;
      }
    } catch (e) {
      error = e && e.message ? e.message : String(e);
    }
    results.push({ name, ok, error, payload });
  }
  return {
    ok: results.every((r) => r.ok || r.pending),
    results,
  };
}

function list() {
  _ensureDefaults();
  return Array.from(_registry.keys()).map((name) => ({ name, handler: _registry.get(name) }));
}

function clear() {
  _registry.clear();
  _defaultRegistered = false;
}

// Register defaults on require so consumer doesn't have to.
_ensureDefaults();

module.exports = {
  register,
  unregister,
  get,
  handle,
  list,
  clear,
};
