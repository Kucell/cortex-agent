"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const subscriptions = require("../../lib/cross-project/subscriptions");

function withRoot(fn) {
  return (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bridge-subs-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return fn(t, root);
  };
}

function event(overrides = {}) {
  return {
    bridge_event_id: "BR-EVT-001",
    source_project_id: "cortex-agent",
    event_type: "task.state_changed",
    summary: { to_state: "READY_FOR_REVIEW" },
    propagated_at: "2026-08-05T00:00:01.000Z",
    ...overrides,
  };
}

// ─── path / read ──────────────────────────────────────────────────────────

test("subscriptionsPath follows the P-003 §3.3 layout", withRoot((t, root) => {
  assert.equal(
    subscriptions.subscriptionsPath(root),
    path.join(root, ".agent-runtime", "cross-project", "subscriptions.json"),
  );
}));

test("readSubscriptions returns an empty list when no file exists", withRoot((t, root) => {
  const result = subscriptions.readSubscriptions(root);
  assert.deepEqual(result, { subscriptions: [] });
}));

test("readSubscriptions parses an existing valid file", withRoot((t, root) => {
  const dir = path.join(root, ".agent-runtime", "cross-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "subscriptions.json"),
    JSON.stringify({
      subscriptions: [{ source_project_id: "cortex-agent", event_types: ["task.state_changed"] }],
    }),
  );
  const result = subscriptions.readSubscriptions(root);
  assert.equal(result.subscriptions.length, 1);
  assert.equal(result.subscriptions[0].source_project_id, "cortex-agent");
}));

test("readSubscriptions rejects a corrupt file with a structured error", withRoot((t, root) => {
  const dir = path.join(root, ".agent-runtime", "cross-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "subscriptions.json"), "not json");
  assert.throws(
    () => subscriptions.readSubscriptions(root),
    (err) => err.code === "BRIDGE_SUBSCRIPTIONS_CORRUPT",
  );
}));

test("readSubscriptions rejects a file that does not match the schema", withRoot((t, root) => {
  const dir = path.join(root, ".agent-runtime", "cross-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "subscriptions.json"), JSON.stringify({ subscriptions: [{ source_project_id: "x" }] }));
  assert.throws(
    () => subscriptions.readSubscriptions(root),
    (err) => err.code === "BRIDGE_SUBSCRIPTIONS_CORRUPT",
  );
}));

// ─── addSubscription ──────────────────────────────────────────────────────

test("addSubscription appends a valid entry and returns its index", withRoot((t, root) => {
  const result = subscriptions.addSubscription(root, {
    source_project_id: "cortex-agent",
    event_types: ["task.state_changed", "decision.resolved"],
    filter: { to_state: ["READY_FOR_REVIEW", "BLOCKED"] },
  });
  assert.equal(result.ok, true);
  assert.equal(result.index, 0);
  const current = subscriptions.readSubscriptions(root);
  assert.equal(current.subscriptions.length, 1);
  assert.deepEqual(current.subscriptions[0], {
    source_project_id: "cortex-agent",
    event_types: ["task.state_changed", "decision.resolved"],
    filter: { to_state: ["READY_FOR_REVIEW", "BLOCKED"] },
  });
}));

test("addSubscription trims and de-dupes event types via normalizeEventTypes", withRoot((t, root) => {
  subscriptions.addSubscription(root, {
    source_project_id: "cortex-agent",
    event_types: subscriptions.normalizeEventTypes([" task.state_changed ", "task.state_changed", "", "  "]),
  });
  const current = subscriptions.readSubscriptions(root);
  assert.deepEqual(current.subscriptions[0].event_types, ["task.state_changed"]);
}));

test("addSubscription rejects an entry missing event_types", withRoot((t, root) => {
  assert.throws(
    () => subscriptions.addSubscription(root, { source_project_id: "cortex-agent", event_types: [] }),
    (err) => err.code === "BRIDGE_SUBSCRIPTION_INVALID",
  );
}));

test("addSubscription rejects an entry missing source_project_id", withRoot((t, root) => {
  assert.throws(
    () => subscriptions.addSubscription(root, { event_types: ["task.state_changed"] }),
    (err) => err.code === "BRIDGE_SUBSCRIPTION_INVALID",
  );
}));

test("addSubscription persists atomically (no temp files after success)", withRoot((t, root) => {
  subscriptions.addSubscription(root, { source_project_id: "cortex-agent", event_types: ["task.state_changed"] });
  const dir = path.join(root, ".agent-runtime", "cross-project");
  const stragglers = fs.readdirSync(dir).filter((n) => n.includes(".tmp."));
  assert.equal(stragglers.length, 0, `unexpected temp files: ${stragglers.join(",")}`);
}));

test("addSubscription appends to existing file (does not overwrite)", withRoot((t, root) => {
  subscriptions.addSubscription(root, { source_project_id: "cortex-agent", event_types: ["task.state_changed"] });
  subscriptions.addSubscription(root, { source_project_id: "SamHMI", event_types: ["decision.resolved"] });
  const current = subscriptions.readSubscriptions(root);
  assert.equal(current.subscriptions.length, 2);
  assert.deepEqual(current.subscriptions.map((s) => s.source_project_id), ["cortex-agent", "SamHMI"]);
}));

// ─── removeSubscription ───────────────────────────────────────────────────

test("removeSubscription removes by index and returns the removed entry", withRoot((t, root) => {
  subscriptions.addSubscription(root, { source_project_id: "cortex-agent", event_types: ["task.state_changed"] });
  subscriptions.addSubscription(root, { source_project_id: "SamHMI", event_types: ["decision.resolved"] });
  const result = subscriptions.removeSubscription(root, 0);
  assert.equal(result.ok, true);
  assert.equal(result.removed.source_project_id, "cortex-agent");
  assert.equal(result.subscriptions.length, 1);
  assert.equal(result.subscriptions[0].source_project_id, "SamHMI");
}));

test("removeSubscription rejects out-of-range index", withRoot((t, root) => {
  subscriptions.addSubscription(root, { source_project_id: "cortex-agent", event_types: ["task.state_changed"] });
  assert.throws(
    () => subscriptions.removeSubscription(root, 1),
    (err) => err.code === "BRIDGE_SUBSCRIPTION_INDEX_OUT_OF_RANGE",
  );
  assert.throws(
    () => subscriptions.removeSubscription(root, -1),
    (err) => err.code === "BRIDGE_SUBSCRIPTION_INDEX_OUT_OF_RANGE",
  );
  assert.throws(
    () => subscriptions.removeSubscription(root, 1.5),
    (err) => err.code === "BRIDGE_SUBSCRIPTION_INDEX_OUT_OF_RANGE",
  );
}));

// ─── matchEvent / subscriptionMatches ─────────────────────────────────────

test("matchEvent: source_project_id mismatch excludes event", () => {
  const subs = [{ source_project_id: "cortex-agent", event_types: ["task.state_changed"] }];
  assert.deepEqual(subscriptions.matchEvent(subs, event({ source_project_id: "SamHMI" })), []);
});

test("matchEvent: event_type not in event_types excludes event", () => {
  const subs = [{ source_project_id: "cortex-agent", event_types: ["task.state_changed"] }];
  assert.deepEqual(subscriptions.matchEvent(subs, event({ event_type: "decision.resolved" })), []);
});

test("matchEvent: matching subscription is returned by its index", () => {
  const subs = [
    { source_project_id: "cortex-agent", event_types: ["decision.resolved"] },
    { source_project_id: "cortex-agent", event_types: ["task.state_changed", "decision.resolved"] },
  ];
  assert.deepEqual(subscriptions.matchEvent(subs, event({ event_type: "task.state_changed" })), [1]);
});

test("matchEvent: correlation_group filter excludes events without a group", () => {
  const subs = [{ source_project_id: "cortex-agent", event_types: ["task.state_changed"], correlation_group: "XPC-DASHBOARD-PRD" }];
  assert.deepEqual(subscriptions.matchEvent(subs, event()), []);
});

test("matchEvent: correlation_group filter excludes events with a different group", () => {
  const subs = [{ source_project_id: "cortex-agent", event_types: ["task.state_changed"], correlation_group: "XPC-A" }];
  const ev = event({ correlation_group: "XPC-B" });
  assert.deepEqual(subscriptions.matchEvent(subs, ev), []);
});

test("matchEvent: correlation_group filter matches events with the same group", () => {
  const subs = [{ source_project_id: "cortex-agent", event_types: ["task.state_changed"], correlation_group: "XPC-DASHBOARD-PRD" }];
  const ev = event({ correlation_group: "XPC-DASHBOARD-PRD" });
  assert.deepEqual(subscriptions.matchEvent(subs, ev), [0]);
});

test("matchEvent: filter.to_state as list (any-match)", () => {
  const subs = [{ source_project_id: "cortex-agent", event_types: ["task.state_changed"], filter: { to_state: ["READY_FOR_REVIEW", "BLOCKED"] } }];
  assert.deepEqual(subscriptions.matchEvent(subs, event({ summary: { to_state: "READY_FOR_REVIEW" } })), [0]);
  assert.deepEqual(subscriptions.matchEvent(subs, event({ summary: { to_state: "EXECUTING" } })), []);
});

test("matchEvent: filter expects summary object; non-object excludes", () => {
  const subs = [{ source_project_id: "cortex-agent", event_types: ["task.state_changed"], filter: { to_state: ["READY_FOR_REVIEW"] } }];
  const ev = event();
  ev.summary = "broken";
  assert.deepEqual(subscriptions.matchEvent(subs, ev), []);
});

test("matchEvent: returns indices of every matching subscription", () => {
  const subs = [
    { source_project_id: "cortex-agent", event_types: ["task.state_changed"] },
    { source_project_id: "cortex-agent", event_types: ["task.state_changed"], correlation_group: "XPC-A" },
    { source_project_id: "SamHMI", event_types: ["task.state_changed"] },
  ];
  const ev = event({ correlation_group: "XPC-A" });
  assert.deepEqual(subscriptions.matchEvent(subs, ev), [0, 1]);
});

test("subscriptionMatches: direct unit-level behavior for filter.equals", () => {
  // Scalar filter (not list) means strict equality.
  const sub = { source_project_id: "x", event_types: ["y"], filter: { to_state: "READY_FOR_REVIEW" } };
  assert.equal(subscriptions.subscriptionMatches(sub, { source_project_id: "x", event_type: "y", summary: { to_state: "READY_FOR_REVIEW" } }), true);
  assert.equal(subscriptions.subscriptionMatches(sub, { source_project_id: "x", event_type: "y", summary: { to_state: "BLOCKED" } }), false);
});

// ─── normalizeEventTypes ──────────────────────────────────────────────────

test("normalizeEventTypes: trims, drops empties, de-dupes", () => {
  assert.deepEqual(
    subscriptions.normalizeEventTypes([" a ", "b", "a", "", "  ", null, undefined, 42, "c", "b"]),
    ["a", "b", "c"],
  );
});

test("normalizeEventTypes: non-array input returns empty list", () => {
  assert.deepEqual(subscriptions.normalizeEventTypes(undefined), []);
  assert.deepEqual(subscriptions.normalizeEventTypes(null), []);
  assert.deepEqual(subscriptions.normalizeEventTypes("string"), []);
});
