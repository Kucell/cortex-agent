"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const QUERY_NAMES = ["runtime-state", "workspaces", "hook-runs", "resource-leases", "composite-workspaces", "resource-events", "guided-reviews", "benchmarks"];

function schema(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "runtime", "runtime-state-projection.schema.json"), "utf8"));
}

test("runtime projection query names and core response sections are frozen", () => {
  const value = schema(path.join(ROOT, ".agent"));
  assert.deepEqual(value.properties.query.enum, QUERY_NAMES);
  for (const field of ["ok", "query", "generated_at", "resources", "summary", "recent_events", "blocking", "evidence_readiness"]) {
    assert.ok(value.required.includes(field));
  }
});

test("projected resources preserve stable correlation, event, evidence, and next-action fields", () => {
  const item = schema(path.join(ROOT, ".agent")).properties.resources.items;
  for (const field of ["resource_type", "resource_id", "status", "relations", "updated_at", "evidence_refs"]) {
    assert.ok(item.required.includes(field));
  }
  for (const relation of ["task_id", "mission_id", "run_id", "session_id", "workspace_id", "composite_workspace_id", "repository_id"]) {
    assert.ok(item.properties.relations.properties[relation]);
  }
  assert.ok(item.properties.latest_event);
  assert.ok(item.properties.log_cursor_refs);
  assert.ok(item.properties.next_action);
});

test("projection schema remains byte-identical across local and distribution templates", () => {
  const relative = path.join("runtime", "runtime-state-projection.schema.json");
  const local = fs.readFileSync(path.join(ROOT, ".agent", relative), "utf8");
  assert.equal(fs.readFileSync(path.join(ROOT, "templates", "_shared", ".agent", relative), "utf8"), local);
});
