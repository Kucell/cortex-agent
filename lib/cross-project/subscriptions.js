"use strict";

// ─── Cross-Project Event Subscriptions (P-003 Phase 1) ──────────────────────
//
// Project-scoped subscription registry persisted at
//   <root>/.agent-runtime/cross-project/subscriptions.json
//
// Each subscription entry declares:
//   • source_project_id   — required, the project whose events we want
//   • correlation_group   — optional, restricts to one correlation group
//   • event_types         — required, list of event_type values to accept
//   • filter              — optional, a summary-payload-shape filter applied
//                            at sync time. Currently supported keys:
//                            `to_state` (list of acceptable to_state values,
//                                       used by task.state_changed events).
//
// This module owns the read / write / match layer. It does NOT call the
// inbox store or the network — the CLI glues them together via bridge-sync.
//
// Public API:
//   • subscriptionsPath(root)              → absolute path to subscriptions.json
//   • readSubscriptions(root)              → { subscriptions[] } (empty array
//                                            if file missing)
//   • addSubscription(root, sub)           → { ok, subscriptions, index }
//                                            (appends; validates the entry
//                                            and the post-write file)
//   • removeSubscription(root, index)      → { ok, removed, subscriptions }
//   • matchEvent(subscriptions, event)     → indices of subscriptions that
//                                            match the event (per P-003 §4.2
//                                            step 2: filter by event_types
//                                            and filter expressions)
//   • normalizeEventTypes(values)          → trim + de-dup helper used by CLI
//
// Source: P-003 §3.3 订阅配置, §4.2 同步流程 (step 2).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { validateSubscriptionsFile, validateSubscription } = require("./bridge-event-schema");
const { ensureRuntimeRoot } = require("./runtime-root");

function crossProjectDirFor(root) {
  return path.join(path.resolve(root), ".agent-runtime", "cross-project");
}

function subscriptionsPath(root) {
  return path.join(crossProjectDirFor(root), "subscriptions.json");
}

function readSubscriptions(root) {
  const target = subscriptionsPath(root);
  let raw;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { subscriptions: [] };
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const error = new Error(`readSubscriptions: subscriptions.json is not valid JSON`);
    error.code = "BRIDGE_SUBSCRIPTIONS_CORRUPT";
    error.cause = cause;
    throw error;
  }
  const result = validateSubscriptionsFile(parsed);
  if (!result.ok) {
    const error = new Error(`readSubscriptions: subscriptions.json is invalid: ${result.errors.join("; ")}`);
    error.code = "BRIDGE_SUBSCRIPTIONS_CORRUPT";
    error.details = result.errors;
    throw error;
  }
  return parsed;
}

function persistSubscriptions(root, payload) {
  const result = validateSubscriptionsFile(payload);
  if (!result.ok) {
    const error = new Error(`persistSubscriptions: ${result.errors.join("; ")}`);
    error.code = "BRIDGE_SUBSCRIPTIONS_INVALID";
    error.details = result.errors;
    throw error;
  }
  ensureRuntimeRoot(root);
  const dir = crossProjectDirFor(root);
  fs.mkdirSync(dir, { recursive: true });
  const target = subscriptionsPath(root);
  const suffix = crypto.randomBytes(8).toString("hex");
  const temp = `${target}.tmp.${process.pid}.${suffix}`;
  const data = `${JSON.stringify(payload, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    const dirFd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* renamed or best-effort cleanup */ }
  }
  return target;
}

function normalizeEventTypes(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function addSubscription(root, sub) {
  if (!sub || typeof sub !== "object") {
    const error = new Error("addSubscription: sub must be an object");
    error.code = "BRIDGE_SUBSCRIPTION_INVALID";
    throw error;
  }
  const candidate = {
    event_types: normalizeEventTypes(sub.event_types || []),
  };
  if (sub.source_project_id !== undefined) candidate.source_project_id = sub.source_project_id;
  if (sub.correlation_group !== undefined) candidate.correlation_group = sub.correlation_group;
  if (sub.filter && typeof sub.filter === "object" && Object.keys(sub.filter).length > 0) {
    candidate.filter = sub.filter;
  }
  const validation = validateSubscription(candidate);
  if (!validation.ok) {
    const error = new Error(`addSubscription: ${validation.errors.join("; ")}`);
    error.code = "BRIDGE_SUBSCRIPTION_INVALID";
    error.details = validation.errors;
    throw error;
  }
  const current = readSubscriptions(root);
  current.subscriptions.push(candidate);
  persistSubscriptions(root, current);
  return { ok: true, subscriptions: current.subscriptions, index: current.subscriptions.length - 1 };
}

function removeSubscription(root, index) {
  const current = readSubscriptions(root);
  if (!Number.isInteger(index) || index < 0 || index >= current.subscriptions.length) {
    const error = new Error(`removeSubscription: index ${index} out of range [0, ${current.subscriptions.length})`);
    error.code = "BRIDGE_SUBSCRIPTION_INDEX_OUT_OF_RANGE";
    throw error;
  }
  const removed = current.subscriptions.splice(index, 1)[0];
  persistSubscriptions(root, current);
  return { ok: true, removed, subscriptions: current.subscriptions };
}

// ─── Filter / match ────────────────────────────────────────────────────────
//
// matchEvent returns the array indices (within `current.subscriptions`) of
// every subscription that ACCEPTS the event:
//
//   1. source_project_id must match
//   2. event_type must be in subscription.event_types
//   3. if subscription.correlation_group is set, event.correlation_group
//      must match (events without a correlation_group never match)
//   4. if subscription.filter is set, every key/value pair must match the
//      event.summary (e.g. filter.to_state: ["READY_FOR_REVIEW", "BLOCKED"]
//      requires event.summary.to_state to be in that list).
//
// This is a pure function: it does not touch the filesystem or the inbox.

function summaryFieldMatches(filterValue, summaryValue) {
  if (Array.isArray(filterValue)) {
    if (Array.isArray(summaryValue)) {
      return filterValue.some((v) => summaryValue.includes(v));
    }
    return filterValue.includes(summaryValue);
  }
  return filterValue === summaryValue;
}

function subscriptionMatches(subscription, event) {
  if (subscription.source_project_id !== event.source_project_id) return false;
  if (!subscription.event_types.includes(event.event_type)) return false;
  if (subscription.correlation_group !== undefined) {
    if (!event.correlation_group) return false;
    if (event.correlation_group !== subscription.correlation_group) return false;
  }
  if (subscription.filter) {
    if (!event.summary || typeof event.summary !== "object") return false;
    for (const [key, expected] of Object.entries(subscription.filter)) {
      if (!summaryFieldMatches(expected, event.summary[key])) return false;
    }
  }
  return true;
}

function matchEvent(subscriptions, event) {
  if (!Array.isArray(subscriptions) || !event) return [];
  const matches = [];
  subscriptions.forEach((sub, idx) => {
    if (subscriptionMatches(sub, event)) matches.push(idx);
  });
  return matches;
}

module.exports = {
  subscriptionsPath,
  readSubscriptions,
  addSubscription,
  removeSubscription,
  matchEvent,
  normalizeEventTypes,
  // Exposed for tests
  subscriptionMatches,
  persistSubscriptions,
};
