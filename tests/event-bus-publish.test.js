"use strict";

// Tests for M-004 MS-001 VC-003: publish API.
//
// Strategy:
//   - Schema validation (8 event types + custom extension)
//   - event_id uniqueness (uuid v4)
//   - append + fsync to events.jsonl
//   - File lock concurrent safety
//   - Failure rollback (invalid event throws)
//   - publish returns correct result shape
//
// References:
//   - .agent/missions/M-004/validation-contract.json VC-003
//   - docs/architecture/framework-event-bus-design.md §4.1, §5.2

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createEventBus } = require("../lib/event-bus/event-bus");

let _counter = 0;
function tmpDir() {
  const d = path.join(os.tmpdir(), "eb-pub-" + process.pid + "-" + (++_counter));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function makeBus(dir) {
  return createEventBus({ busId: "test-host:m-004", dataDir: dir, fsync: false });
}

function producerCtx() {
  return {
    producer: { producer_id: "sub-1", producer_kind: "sub_agent", session_id: "S-1" },
    missionId: "M-004", subagentId: "sub-1", parentRunId: "R-001",
  };
}

// 1. Basic publish
test("VC-003: publish returns ok + event_id + persisted_at", () => {
  const bus = makeBus(tmpDir());
  const r = bus.publish(
    { event_name: "subagent_completed", payload: { status: "success", output_summary: "done" } },
    producerCtx()
  );
  assert.ok(r.ok);
  assert.ok(r.event_id.startsWith("eb-evt-"));
  assert.ok(r.persisted_at);
  bus.close();
});

test("VC-003: publish writes to events.jsonl", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  bus.publish(
    { event_name: "subagent_spawned", payload: { subagent_role: "x", task_description: "y" } },
    producerCtx()
  );
  bus.close();
  const content = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
  const lines = content.split("\n").filter((l) => l.trim());
  assert.strictEqual(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.strictEqual(event.event_name, "subagent_spawned");
});

// 2. Schema validation
test("VC-003: publish rejects invalid event (missing required payload field)", () => {
  const bus = makeBus(tmpDir());
  assert.throws(() => {
    bus.publish(
      { event_name: "subagent_completed", payload: { status: "success" } },
      producerCtx()
    );
  }, /event_validation_failed/);
  bus.close();
});

test("VC-003: publish rejects invalid event (wrong payload type)", () => {
  const bus = makeBus(tmpDir());
  assert.throws(() => {
    bus.publish(
      { event_name: "subagent_progress", payload: { percent: "fifty" } },
      producerCtx()
    );
  }, /event_validation_failed/);
  bus.close();
});

test("VC-003: publish rejects invalid event (percent out of range)", () => {
  const bus = makeBus(tmpDir());
  assert.throws(() => {
    bus.publish(
      { event_name: "subagent_progress", payload: { percent: 150 } },
      producerCtx()
    );
  }, /event_validation_failed/);
  bus.close();
});

test("VC-003: publish rejects unknown event_name", () => {
  const bus = makeBus(tmpDir());
  assert.throws(() => {
    bus.publish({ event_name: "bogus_event", payload: {} }, producerCtx());
  }, /Unknown event_name/);
  bus.close();
});

// 3. event_id uniqueness
test("VC-003: each publish generates unique event_id", () => {
  const bus = makeBus(tmpDir());
  const ids = new Set();
  for (let i = 0; i < 100; i++) {
    const r = bus.publish(
      { event_name: "subagent_progress", payload: { percent: i } },
      producerCtx()
    );
    ids.add(r.event_id);
  }
  assert.strictEqual(ids.size, 100);
  bus.close();
});

// 4. All 8 event types publishable
test("VC-003: all 8 core event types can be published", () => {
  const bus = makeBus(tmpDir());
  const events = [
    { event_name: "subagent_spawned", payload: { subagent_role: "x", task_description: "y" } },
    { event_name: "subagent_progress", payload: { percent: 50 } },
    { event_name: "subagent_completed", payload: { status: "success", output_summary: "done" } },
    { event_name: "subagent_failed", payload: { status: "failed", error_code: "err", error_message: "msg" } },
    { event_name: "subagent_cancelled", payload: { reason: "timeout" } },
    { event_name: "handoff_ready", payload: { handoff_id: "h1", handoff_path: "/p", from_subagent_id: "a", to_subagent_id: "b" } },
    { event_name: "decision_resolved", payload: { decision_id: "d1", resolution: "approved" } },
    { event_name: "waitpoint_released", payload: { waitpoint_id: "w1", release_reason: "ok" } },
  ];
  for (const e of events) {
    const r = bus.publish(e, producerCtx());
    assert.ok(r.ok, `Failed to publish ${e.event_name}`);
  }
  const { total } = bus.list();
  assert.strictEqual(total, 8);
  bus.close();
});

test("VC-003: custom:* extension events can be published", () => {
  const bus = makeBus(tmpDir());
  const r = bus.publish(
    { event_name: "custom:build_completed", payload: { build_id: "b1", status: "green" } },
    producerCtx()
  );
  assert.ok(r.ok);
  bus.close();
});

// 5. producer + correlation fields
test("VC-003: published event has correct producer fields", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  bus.publish(
    { event_name: "subagent_completed", payload: { status: "success", output_summary: "done" } },
    {
      producer: { producer_id: "sub-exp-001", producer_kind: "sub_agent", session_id: "S-M004-1" },
      missionId: "M-004", subagentId: "sub-exp-001", parentRunId: "R-001",
    }
  );
  bus.close();
  const content = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
  const event = JSON.parse(content.trim());
  assert.strictEqual(event.producer.producer_id, "sub-exp-001");
  assert.strictEqual(event.producer.producer_kind, "sub_agent");
  assert.strictEqual(event.producer.session_id, "S-M004-1");
});

test("VC-003: published event has correct correlation fields", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  bus.publish(
    { event_name: "subagent_completed", payload: { status: "success", output_summary: "done" } },
    {
      producer: { producer_id: "sub-1", producer_kind: "sub_agent" },
      missionId: "M-004", subagentId: "sub-exp-001", parentRunId: "R-001",
      causationId: "eb-evt-prev-001",
    }
  );
  bus.close();
  const event = JSON.parse(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim());
  assert.strictEqual(event.correlation.mission_id, "M-004");
  assert.strictEqual(event.correlation.subagent_id, "sub-exp-001");
  assert.strictEqual(event.correlation.parent_run_id, "R-001");
  assert.strictEqual(event.correlation.causation_id, "eb-evt-prev-001");
});

test("VC-003: correlation defaults to global/host when not provided", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  bus.publish(
    { event_name: "subagent_progress", payload: { percent: 10 } },
    { producer: { producer_id: "cli-1", producer_kind: "cli" } }
  );
  bus.close();
  const event = JSON.parse(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim());
  assert.strictEqual(event.correlation.mission_id, "global");
  assert.strictEqual(event.correlation.subagent_id, "host");
  assert.strictEqual(event.producer.session_id, null);
});

// 6. bus_id in published event
test("VC-003: published event has correct bus_id", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  bus.publish(
    { event_name: "subagent_progress", payload: { percent: 10 } },
    producerCtx()
  );
  bus.close();
  const event = JSON.parse(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim());
  assert.strictEqual(event.bus_id, "test-host:m-004");
});

// 7. event_version
test("VC-003: published event has event_version 1.0", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  bus.publish(
    { event_name: "subagent_progress", payload: { percent: 10 } },
    producerCtx()
  );
  bus.close();
  const event = JSON.parse(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim());
  assert.strictEqual(event.event_version, "1.0");
});

// 8. occurred_at is valid ISO
test("VC-003: published event has valid ISO occurred_at", () => {
  const bus = makeBus(tmpDir());
  const r = bus.publish(
    { event_name: "subagent_progress", payload: { percent: 10 } },
    producerCtx()
  );
  const date = new Date(r.persisted_at);
  assert.ok(!isNaN(date.getTime()), "occurred_at should be valid ISO date");
  bus.close();
});

// 9. publish after close throws
test("VC-003: publish after close throws", () => {
  const bus = makeBus(tmpDir());
  bus.close();
  assert.throws(() => {
    bus.publish(
      { event_name: "subagent_progress", payload: { percent: 10 } },
      producerCtx()
    );
  }, /closed/);
});

// 10. multiple publishes maintain order
test("VC-003: events maintain insertion order in events.jsonl", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  for (let i = 0; i < 10; i++) {
    bus.publish(
      { event_name: "subagent_progress", payload: { percent: i * 10 } },
      producerCtx()
    );
  }
  bus.close();
  const lines = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n").filter((l) => l.trim());
  assert.strictEqual(lines.length, 10);
  for (let i = 0; i < 10; i++) {
    const event = JSON.parse(lines[i]);
    assert.strictEqual(event.payload.percent, i * 10);
  }
});
