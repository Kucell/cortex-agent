"use strict";

// ─── Friction Signal tests (P-003 / M-003A) ────────────────────────────────
// Pure node:test + node:assert/strict. Zero external deps.
//
// Covers:
//   - canonical redacted event validation
//   - closed-schema rejection (unknown top-level fields, free-form keys)
//   - enum / count / timestamp rejection
//   - signal_id format check
//   - recordFrictionEvent append-only behaviour (JSONL round-trip)
//   - readFrictionEvents skips malformed lines
//   - recordFrictionEvent refuses a fixture that smuggles free-form payload
//     (regression: the leak path must throw before the file is touched)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const signal = require("../../lib/friction/signal");
const cap = require("../../lib/runtime-adapters/capability-contract");
const { DshAdapter } = require("../../lib/agents/adapters/dsh");
const { detectPi } = require("../../lib/runtime-adapters/pi-adapter");

// ─── Vocabulary ────────────────────────────────────────────────────────────

test("vocabulary: signal types, observability, redaction postures are frozen", () => {
  for (const name of [
    "tool_denied",
    "tool_failed",
    "tool_retried",
    "user_interrupted",
    "user_correction",
    "lifecycle_stop",
  ]) {
    assert.ok(signal.FRICTION_SIGNAL_TYPES.includes(name), `missing signal type ${name}`);
  }
  for (const level of ["observed", "derived", "not_observed", "not_supported"]) {
    assert.ok(signal.FRICTION_OBSERVABILITY_LEVELS.includes(level), `missing observability ${level}`);
  }
  for (const posture of ["aggregate_only", "full"]) {
    assert.ok(signal.FRICTION_REDACTION_POSTURES.includes(posture), `missing redaction ${posture}`);
  }
  assert.ok(Object.isFrozen(signal.FRICTION_SIGNAL_TYPES));
  assert.ok(Object.isFrozen(signal.FRICTION_OBSERVABILITY_LEVELS));
  assert.ok(Object.isFrozen(signal.FRICTION_REDACTION_POSTURES));
  assert.equal(signal.FRICTION_EVENT_ID_PREFIX, "FS-");
  assert.equal(signal.FRICTION_EVENT_SCHEMA_VERSION, "1");
  assert.equal(signal.FRICTION_EVENT_DIR, ".agent/runtime-evidence/friction");
});

test("capability contract exposes the same friction vocabulary", () => {
  assert.deepEqual(signal.FRICTION_SIGNAL_TYPES, cap.FRICTION_SIGNAL_NAMES);
  assert.deepEqual(signal.FRICTION_OBSERVABILITY_LEVELS, cap.FRICTION_OBSERVABILITY);
  assert.deepEqual(signal.FRICTION_REDACTION_POSTURES, cap.FRICTION_REDACTION_LEVELS);
  assert.equal(cap.FRICTION_SIGNAL_NAMES_MAX, 6);
  assert.equal(cap.FRICTION_LIFECYCLE_EVENTS_MAX, 32);
});

// ─── Canonical event acceptance ────────────────────────────────────────────

function baseEvent(overrides) {
  return Object.assign(
    {
      schema_version: "1",
      signal_id: "FS-00000000-0000-4000-8000-000000000001",
      session_id: "S-test",
      host: "dsh",
      type: "tool_failed",
      observability: "derived",
      count: 1,
      occurred_at: "2026-09-08T00:00:00.000Z",
      evidence_ref: "run:R-001/event:42",
      redaction: "aggregate_only",
    },
    overrides || {}
  );
}

test("validateFrictionEvent accepts a canonical redacted event", () => {
  const out = signal.validateFrictionEvent(baseEvent(), { generateId: false });
  assert.equal(out.schema_version, "1");
  assert.equal(out.signal_id, "FS-00000000-0000-4000-8000-000000000001");
  assert.equal(out.type, "tool_failed");
  assert.equal(out.observability, "derived");
  assert.equal(out.count, 1);
  assert.equal(out.occurred_at, "2026-09-08T00:00:00.000Z");
  assert.equal(out.evidence_ref, "run:R-001/event:42");
  assert.equal(out.redaction, "aggregate_only");
  assert.equal(out.session_id, "S-test");
  assert.equal(out.host, "dsh");
  assert.equal(Object.isFrozen(out), true);
});

test("validateFrictionEvent auto-generates FS-<uuid> signal_id when missing", () => {
  const ev = baseEvent();
  delete ev.signal_id;
  const out = signal.validateFrictionEvent(ev);
  assert.ok(out.signal_id.startsWith("FS-"));
  // FS- + 36-char UUID
  assert.ok(/^FS-[0-9a-fA-F-]{8,}$/.test(out.signal_id));
});

test("validateFrictionEvent rejects signal_id without FS- prefix", () => {
  assert.throws(
    () => signal.validateFrictionEvent(baseEvent({ signal_id: "RB-001" }), { generateId: false }),
    (err) => err.code === "ERR_SIGNAL_ID_PREFIX_MISSING"
  );
});

// ─── Closed-schema rejection ────────────────────────────────────────────────

test("validateFrictionEvent rejects unknown top-level field", () => {
  assert.throws(
    () => signal.validateFrictionEvent(baseEvent({ freeform: "leak" }), { generateId: false }),
    (err) => err.code === "ERR_FIELD_UNKNOWN" && err.details.key === "freeform"
  );
});

test("validateFrictionEvent rejects free-form body/prompt/credential smuggling", () => {
  // Each of these keys is exactly the kind of field the REDACTION GUARD
  // refuses to admit. The validator must reject them as unknown before
  // they ever reach the JSONL writer.
  for (const smuggledKey of [
    "prompt",
    "body",
    "message",
    "details",
    "context",
    "args",
    "arguments",
    "output",
    "tool_output",
    "stdout",
    "stderr",
    "credential",
    "file_content",
    "correction_text",
  ]) {
    const ev = baseEvent({ [smuggledKey]: "forbidden payload" });
    let err;
    try {
      signal.validateFrictionEvent(ev, { generateId: false });
    } catch (caught) {
      err = caught;
    }
    assert.ok(err, `smuggled key ${smuggledKey} should throw`);
    assert.equal(err.code, "ERR_FIELD_UNKNOWN", `${smuggledKey} should fail closed`);
    assert.equal(err.details.key, smuggledKey);
  }
});

test("recordFrictionEvent rejects a fixture carrying prompt text before touching disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friction-test-"));
  try {
    const ev = baseEvent({ prompt: "please delete /etc/passwd" });
    let caught;
    try {
      signal.recordFrictionEvent(dir, ev);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "recordFrictionEvent should throw on smuggled field");
    assert.equal(caught.code, "ERR_FIELD_UNKNOWN");
    // The file path should NOT have been created — the validator must fail
    // before fs.mkdirSync / fs.appendFileSync runs.
    const filePath = signal.signalFilePath(dir);
    assert.equal(fs.existsSync(filePath), false, "file must not be created on validation failure");
    const dirPath = path.join(dir, signal.FRICTION_EVENT_DIR);
    assert.equal(fs.existsSync(dirPath), false, "directory must not be created on validation failure");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recordFrictionEvent rejects a fixture carrying a credential before touching disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friction-test-"));
  try {
    const ev = baseEvent({ credential: "AKIAIOSFODNN7EXAMPLE" });
    assert.throws(
      () => signal.recordFrictionEvent(dir, ev),
      (err) => err.code === "ERR_FIELD_UNKNOWN"
    );
    assert.equal(fs.existsSync(signal.signalFilePath(dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Enum / count / timestamp rejection ─────────────────────────────────────

test("validateFrictionEvent rejects unknown observability", () => {
  assert.throws(
    () => signal.validateFrictionEvent(baseEvent({ observability: "maybe" }), { generateId: false }),
    (err) => err.code === "ERR_OBSERVABILITY_UNKNOWN"
  );
});

test("validateFrictionEvent rejects unknown signal type", () => {
  assert.throws(
    () => signal.validateFrictionEvent(baseEvent({ type: "tool_weird" }), { generateId: false }),
    (err) => err.code === "ERR_SIGNAL_TYPE_UNKNOWN"
  );
});

test("validateFrictionEvent rejects unknown redaction posture", () => {
  assert.throws(
    () => signal.validateFrictionEvent(baseEvent({ redaction: "verbose" }), { generateId: false }),
    (err) => err.code === "ERR_REDACTION_UNKNOWN"
  );
});

test("validateFrictionEvent rejects non-positive count", () => {
  for (const bad of [0, -1, -100, 1.5, NaN, Infinity, "1", null, undefined]) {
    assert.throws(
      () => signal.validateFrictionEvent(baseEvent({ count: bad }), { generateId: false }),
      (err) => err.code === "ERR_COUNT_INVALID",
      `expected ${String(bad)} to be rejected as count`
    );
  }
});

test("validateFrictionEvent rejects bad occurred_at timestamp", () => {
  for (const bad of ["2026-09-08", "not-a-date", "", null, undefined, 12345]) {
    assert.throws(
      () => signal.validateFrictionEvent(baseEvent({ occurred_at: bad }), { generateId: false }),
      (err) => err.code === "ERR_TIMESTAMP_INVALID",
      `expected ${String(bad)} to fail timestamp check`
    );
  }
});

test("validateFrictionEvent rejects missing required fields", () => {
  const required = [
    "schema_version",
    "session_id",
    "host",
    "type",
    "observability",
    "count",
    "occurred_at",
    "evidence_ref",
    "redaction",
  ];
  for (const key of required) {
    const ev = baseEvent();
    delete ev[key];
    if (key === "schema_version") {
      assert.throws(
        () => signal.validateFrictionEvent(ev, { generateId: false }),
        (err) => err.code === "ERR_FIELD_NOT_STRING",
        `expected ${key} to be required`
      );
    } else if (key === "count") {
      assert.throws(
        () => signal.validateFrictionEvent(ev, { generateId: false }),
        (err) => err.code === "ERR_COUNT_INVALID",
        `expected ${key} to be required`
      );
    } else if (key === "occurred_at") {
      assert.throws(
        () => signal.validateFrictionEvent(ev, { generateId: false }),
        (err) => err.code === "ERR_TIMESTAMP_INVALID",
        `expected ${key} to be required`
      );
    } else {
      assert.throws(
        () => signal.validateFrictionEvent(ev, { generateId: false }),
        (err) => err.code === "ERR_FIELD_NOT_STRING",
        `expected ${key} to be required`
      );
    }
  }
});

test("validateFrictionEvent rejects bad schema_version", () => {
  assert.throws(
    () => signal.validateFrictionEvent(baseEvent({ schema_version: "2" }), { generateId: false }),
    (err) => err.code === "ERR_SCHEMA_VERSION_UNKNOWN"
  );
});

test("validateFrictionEvent rejects non-object input", () => {
  for (const bad of [null, undefined, "string", 42, true, [1, 2, 3]]) {
    assert.throws(
      () => signal.validateFrictionEvent(bad),
      (err) => err.code === "ERR_EVENT_NOT_OBJECT",
      `expected ${String(bad)} to fail object check`
    );
  }
});

// ─── recordFrictionEvent append-only ───────────────────────────────────────

test("recordFrictionEvent appends JSONL lines and readFrictionEvents reads them back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friction-test-"));
  try {
    const ev1 = baseEvent({
      signal_id: "FS-aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      type: "tool_failed",
      count: 1,
    });
    const ev2 = baseEvent({
      signal_id: "FS-bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      type: "tool_retried",
      count: 3,
      occurred_at: "2026-09-08T00:01:00.000Z",
    });
    signal.recordFrictionEvent(dir, ev1);
    signal.recordFrictionEvent(dir, ev2);

    const filePath = signal.signalFilePath(dir);
    assert.equal(fs.existsSync(filePath), true);

    const text = fs.readFileSync(filePath, { encoding: "utf8" });
    const lines = text.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 2, "should have 2 JSONL lines");
    for (const line of lines) {
      assert.ok(line.endsWith("}"), "each line is a single JSON object");
      // Must NOT contain forbidden fields even after round-trip.
      assert.equal(/"prompt"/.test(line), false);
      assert.equal(/"credential"/.test(line), false);
      assert.equal(/"body"/.test(line), false);
    }

    const read = signal.readFrictionEvents(dir);
    assert.equal(read.events.length, 2);
    assert.equal(read.malformed, 0);
    assert.equal(read.events[0].signal_id, ev1.signal_id);
    assert.equal(read.events[0].type, "tool_failed");
    assert.equal(read.events[1].signal_id, ev2.signal_id);
    assert.equal(read.events[1].type, "tool_retried");
    assert.equal(read.events[1].count, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recordFrictionEvent is append-only (does not truncate prior lines)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friction-test-"));
  try {
    signal.recordFrictionEvent(dir, baseEvent({ signal_id: "FS-aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
    signal.recordFrictionEvent(dir, baseEvent({ signal_id: "FS-bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
    const read = signal.readFrictionEvents(dir);
    assert.equal(read.events.length, 2);
    // Both signal_ids are still there
    const ids = read.events.map((e) => e.signal_id);
    assert.deepEqual(ids, [
      "FS-aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "FS-bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readFrictionEvents skips malformed lines but counts them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friction-test-"));
  try {
    // Write a hand-crafted file: one good, one malformed JSON, one good.
    signal.recordFrictionEvent(dir, baseEvent({ signal_id: "FS-11111111-1111-4111-8111-111111111111" }));
    const filePath = signal.signalFilePath(dir);
    fs.appendFileSync(filePath, "this is not json\n", "utf8");
    signal.recordFrictionEvent(dir, baseEvent({ signal_id: "FS-22222222-2222-4222-8222-222222222222" }));

    const read = signal.readFrictionEvents(dir);
    assert.equal(read.events.length, 2);
    assert.equal(read.malformed, 1);
    assert.equal(read.events[0].signal_id, "FS-11111111-1111-4111-8111-111111111111");
    assert.equal(read.events[1].signal_id, "FS-22222222-2222-4222-8222-222222222222");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readFrictionEvents returns empty result when no file exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friction-test-"));
  try {
    const read = signal.readFrictionEvents(dir);
    assert.deepEqual(read.events, []);
    assert.equal(read.malformed, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("signalFilePath produces an absolute path under FRICTION_EVENT_DIR", () => {
  const filePath = signal.signalFilePath("/tmp/friction-probe");
  assert.equal(filePath, path.join("/tmp/friction-probe", signal.FRICTION_EVENT_DIR, "signals.jsonl"));
});

test("validateFrictionEvent returned envelope is deep-frozen", () => {
  const out = signal.validateFrictionEvent(baseEvent(), { generateId: false });
  assert.equal(Object.isFrozen(out), true);
  // mutation must throw under "use strict"
  assert.throws(() => {
    out.signal_id = "FS-evil";
  });
  assert.throws(() => {
    out.count = 99;
  });
});

// ─── Friction extension on capability descriptor (descriptor-side test) ─────

test("capability descriptor accepts the friction extension when keys are valid", () => {
  const desc = {
    schema_version: cap.CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    host: { adapter_id: "friction-host", vendor: "acme", version: "0.1.0" },
    detected_at: "2026-09-08T00:00:00.000Z",
    capabilities: {},
    friction_signals: {
      tool_denied: "not_supported",
      tool_failed: "observed",
      tool_retried: "derived",
      user_interrupted: "not_observed",
      user_correction: "not_observed",
      lifecycle_stop: "observed",
    },
    friction_lifecycle_events: ["Stop"],
    redaction_level: "aggregate_only",
  };
  const out = cap.validateCapabilityDescriptor(desc);
  assert.equal(out.friction_signals.tool_failed, "observed");
  assert.equal(out.friction_lifecycle_events[0], "Stop");
  assert.equal(out.redaction_level, "aggregate_only");
  assert.equal(Object.isFrozen(out.friction_signals), true);
});

test("capability descriptor rejects an unknown friction signal name", () => {
  const desc = {
    schema_version: cap.CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    host: { adapter_id: "x", vendor: "x", version: "0.0.1" },
    detected_at: "2026-09-08T00:00:00.000Z",
    capabilities: {},
    friction_signals: { made_up_signal: "observed" },
  };
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) => err.code === "ERR_FIELD_UNKNOWN" && err.details.key === "made_up_signal"
  );
});

test("capability descriptor rejects unknown friction observability value", () => {
  const desc = {
    schema_version: cap.CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    host: { adapter_id: "x", vendor: "x", version: "0.0.1" },
    detected_at: "2026-09-08T00:00:00.000Z",
    capabilities: {},
    friction_signals: { tool_failed: "probably" },
  };
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) => err.code === "ERR_FRICTION_OBSERVABILITY_UNKNOWN"
  );
});

test("capability descriptor rejects unknown redaction_level value", () => {
  const desc = {
    schema_version: cap.CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    host: { adapter_id: "x", vendor: "x", version: "0.0.1" },
    detected_at: "2026-09-08T00:00:00.000Z",
    capabilities: {},
    redaction_level: "verbose",
  };
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) => err.code === "ERR_REDACTION_LEVEL_UNKNOWN"
  );
});

test("DSH adapter descriptor validates with the friction extension", () => {
  const adapter = new DshAdapter({ bin: "/bin/true" });
  const descriptor = adapter.discover().capability_descriptor;
  const out = cap.validateCapabilityDescriptor(descriptor);
  assert.equal(out.friction_signals.tool_failed, "derived");
  assert.equal(out.friction_signals.lifecycle_stop, "derived");
  assert.equal(out.friction_signals.tool_denied, "not_observed");
  assert.deepEqual(out.friction_lifecycle_events, ["session.end"]);
  assert.equal(out.redaction_level, "aggregate_only");
});

test("Pi absent descriptor validates with the friction extension", () => {
  const probe = detectPi({ binary: "definitely-not-a-real-binary-xyz", timeoutMs: 250 });
  const out = probe.descriptor;
  for (const name of cap.FRICTION_SIGNAL_NAMES) {
    assert.equal(out.friction_signals[name], "not_supported", `signal ${name} must be not_supported`);
  }
  assert.deepEqual(out.friction_lifecycle_events, []);
  assert.equal(out.redaction_level, "full");
});
