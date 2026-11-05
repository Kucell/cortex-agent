"use strict";

// ─── 租约作用域树语义（M-053 / MS-008 并行实例隔离）────────────────────────
//
// 精确键语义下，整机作用域与实例作用域互不相干，持有整机作用域的一线会挡住
// 本可并行的实例工作。作用域树语义是显式开启的：开启后父子作用域互斥，
// 兄弟作用域不受影响。未开启时行为与改造前完全一致。

const assert = require("node:assert/strict");
const test = require("node:test");
const { LeaseManager, createManualClock, scopeRelation } = require("../../lib/coordination/lease");

function mk() {
  return new LeaseManager({ clock: createManualClock(0) });
}

// ─── 1. 作用域关系判定 ─────────────────────────────────────────────────────

test("scopeRelation marks same, parent and child scopes", () => {
  assert.equal(scopeRelation("a", "a"), "same");
  assert.equal(scopeRelation("a:b", "a:b:c"), "parent");
  assert.equal(scopeRelation("a:b:c", "a:b"), "child");
});

test("sibling scopes have no relation", () => {
  assert.equal(scopeRelation("samhmi:windows:instance:a", "samhmi:windows:instance:b"), null);
  assert.equal(scopeRelation("samhmi:windows:desktop", "samhmi:windows:instance:a"), null);
});

test("a hyphen is not a scope separator", () => {
  assert.equal(scopeRelation("task:A", "task:A-2"), null);
});

// ─── 2. 默认行为：精确键不受影响 ───────────────────────────────────────────

test("without the option a parent scope does not block its child", () => {
  const m = mk();
  m.acquire("samhmi:windows", "owner-machine");
  const child = m.acquire("samhmi:windows:instance:a", "owner-a");
  assert.equal(child.scope, "samhmi:windows:instance:a");
  assert.equal(child.scopeTree, false);
});

test("without the option a child scope does not block its parent", () => {
  const m = mk();
  m.acquire("samhmi:windows:instance:a", "owner-a");
  const parent = m.acquire("samhmi:windows", "owner-machine");
  assert.equal(parent.scope, "samhmi:windows");
});

// ─── 3. 开启作用域树语义：父子互斥 ───────────────────────────────────────

test("a tree-scoped request is refused while a parent scope is held", () => {
  const m = mk();
  m.acquire("samhmi:windows", "owner-machine");
  assert.throws(
    () => m.acquire("samhmi:windows:instance:a", "owner-a", { scopeTree: true }),
    (error) => {
      assert.equal(error.key, "ERR_LEASE_CONFLICT");
      assert.equal(error.details.reason, "scope_tree_conflict");
      assert.equal(error.details.relation, "child");
      assert.equal(error.details.conflictingScope, "samhmi:windows");
      assert.equal(error.details.currentOwner, "owner-machine");
      return true;
    },
  );
});

test("a tree-scoped request is refused while a child scope is held", () => {
  const m = mk();
  m.acquire("samhmi:windows:instance:a", "owner-a", { scopeTree: true });
  assert.throws(
    () => m.acquire("samhmi:windows", "owner-machine", { scopeTree: true }),
    (error) => {
      assert.equal(error.details.reason, "scope_tree_conflict");
      assert.equal(error.details.relation, "parent");
      assert.equal(error.details.conflictingScope, "samhmi:windows:instance:a");
      return true;
    },
  );
});

test("sibling scopes stay independent under tree semantics", () => {
  const m = mk();
  m.acquire("samhmi:windows:instance:a", "owner-a", { scopeTree: true });
  const other = m.acquire("samhmi:windows:instance:b", "owner-b", { scopeTree: true });
  assert.equal(other.scope, "samhmi:windows:instance:b");
  assert.equal(other.owner, "owner-b");
});

test("an exact-key request is refused by a held tree-scoped parent", () => {
  const m = mk();
  m.acquire("samhmi:windows", "owner-machine", { scopeTree: true });
  assert.throws(
    () => m.acquire("samhmi:windows:instance:a", "owner-a"),
    (error) => error.details.reason === "scope_tree_conflict",
  );
});

test("an exact-key request is refused by a held tree-scoped child", () => {
  const m = mk();
  m.acquire("samhmi:windows:instance:a", "owner-a", { scopeTree: true });
  assert.throws(
    () => m.acquire("samhmi:windows", "owner-machine"),
    (error) => error.details.reason === "scope_tree_conflict",
  );
});

test("the same owner keeps its own scope hierarchy", () => {
  const m = mk();
  m.acquire("samhmi:windows", "owner-machine", { scopeTree: true });
  const child = m.acquire("samhmi:windows:instance:a", "owner-machine", { scopeTree: true });
  assert.equal(child.owner, "owner-machine");
});

test("a released parent scope stops blocking its children", () => {
  const m = mk();
  const parent = m.acquire("samhmi:windows", "owner-machine", { scopeTree: true });
  m.release(parent.leaseId);
  const child = m.acquire("samhmi:windows:instance:a", "owner-a", { scopeTree: true });
  assert.equal(child.scope, "samhmi:windows:instance:a");
});

// ─── 4. 审计与持久化 ───────────────────────────────────────────────────────

test("a tree conflict writes an ownership.conflict audit row", () => {
  const m = mk();
  m.acquire("samhmi:windows", "owner-machine", { scopeTree: true });
  assert.throws(() => m.acquire("samhmi:windows:instance:a", "owner-a", { scopeTree: true }));
  const conflicts = m.getAuditLog({ eventType: "ownership.conflict" });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, "scope_tree_conflict");
  assert.equal(conflicts[0].details.relation, "child");
  assert.equal(conflicts[0].details.conflictingScope, "samhmi:windows");
});

test("the tree flag survives a durable round trip", () => {
  const m = mk();
  m.acquire("samhmi:windows:instance:a", "owner-a", { scopeTree: true });
  const restored = LeaseManager.fromState(m.exportState(), { clock: createManualClock(0) });
  const [lease] = restored.listActiveLeases();
  assert.equal(lease.scopeTree, true);
});

test("a lease written without the option loads as exact-key", () => {
  const m = mk();
  m.acquire("samhmi:windows:instance:a", "owner-a");
  const state = m.exportState();
  delete state.leases[0].scopeTree;
  const restored = LeaseManager.fromState(state, { clock: createManualClock(0) });
  const [lease] = restored.listActiveLeases();
  assert.equal(lease.scopeTree, false);
});

test("a restored tree lease still blocks an unrelated child request", () => {
  const m = mk();
  m.acquire("samhmi:windows", "owner-machine", { scopeTree: true });
  const restored = LeaseManager.fromState(m.exportState(), { clock: createManualClock(0) });
  assert.throws(
    () => restored.acquire("samhmi:windows:instance:a", "owner-a", { scopeTree: true }),
    (error) => error.details.reason === "scope_tree_conflict",
  );
});
