"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ensureProjectDescriptor,
  readDescriptor,
  updateBinding,
  attach,
  detach,
} = require("../../lib/governance/lifecycle");

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-governance-lifecycle-"));
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  return root;
}

test("ensureProjectDescriptor creates stable identity once", (t) => {
  const root = project();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = ensureProjectDescriptor(root);
  const second = ensureProjectDescriptor(root);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.descriptor.project_id, second.descriptor.project_id);
  assert.deepEqual(second.descriptor.governance, {
    kind: "filesystem",
    locator: ".agent",
    ref: null,
  });
});

test("binding update uses expected-current CAS", (t) => {
  const root = project();
  const detached = path.join(root, "agent-store");
  fs.mkdirSync(detached);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  ensureProjectDescriptor(root);
  assert.throws(
    () => updateBinding(root, {
      kind: "filesystem",
      locator: "agent-store",
      ref: null,
    }, {
      expected_current: { kind: "git", locator: "github://org/repo-agent", ref: "main" },
    }),
    (error) => error.code === "ERR_GOVERNANCE_BINDING_CONFLICT",
  );
});

test("embedded to remote attach requires MS-008 migration", (t) => {
  const root = project();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  ensureProjectDescriptor(root);

  assert.throws(
    () => attach(root, { kind: "git", locator: "github://org/repo-agent", ref: "main" }),
    (error) => error.code === "ERR_GOVERNANCE_MIGRATION_REQUIRED",
  );
});

test("detach refuses embedded authority and never deletes .agent", (t) => {
  const root = project();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  ensureProjectDescriptor(root);

  assert.throws(
    () => detach(root),
    (error) => error.code === "ERR_GOVERNANCE_EMBEDDED_DETACH_UNSUPPORTED",
  );
  assert.equal(fs.existsSync(path.join(root, ".agent")), true);
  assert.equal(readDescriptor(root).governance.locator, ".agent");
});
