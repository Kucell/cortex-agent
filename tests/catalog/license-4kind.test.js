"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const license = require("../../lib/catalog/license");
const { KIND_LIST } = require("../../lib/catalog/kind-map");

// ─── normalizeLicense ────────────────────────────────────────────────────────

test("normalizeLicense: extracts license from open-design.json#/license (plugin)", () => {
  const r = license.normalizeLicense("plugin", {
    "open-design.json": { license: "Apache-2.0" },
  });
  assert.equal(r.value, "Apache-2.0");
  assert.equal(r.source, "open-design.json#/license");
});

test("normalizeLicense: falls through to SKILL.md frontmatter for plugin", () => {
  const r = license.normalizeLicense("plugin", {
    "SKILL.md": { frontmatter: { license: "MIT" } },
  });
  assert.equal(r.value, "MIT");
});

test("normalizeLicense: design-system uses DESIGN.md frontmatter", () => {
  const r = license.normalizeLicense("design-system", {
    "DESIGN.md": { frontmatter: { license: "Apache-2.0" } },
  });
  assert.equal(r.value, "Apache-2.0");
});

test("normalizeLicense: returns null when no match", () => {
  assert.equal(license.normalizeLicense("skill", {}), null);
  assert.equal(license.normalizeLicense("template", { "unrelated.json": {} }), null);
});

test("normalizeLicense: throws for unknown kind", () => {
  assert.throws(() => license.normalizeLicense("foo", {}), /unknown kind "foo"/);
});

test("normalizeLicense: skips empty/null license values", () => {
  const r = license.normalizeLicense("plugin", {
    "open-design.json": { license: "" },
    "SKILL.md": { frontmatter: { license: "MIT" } },
  });
  assert.equal(r.value, "MIT");
});

// ─── formatLicenseWarning ────────────────────────────────────────────────────

test("formatLicenseWarning: returns string for design-system (T-OD-001)", () => {
  const text = license.formatLicenseWarning(
    { id: "default", license: "MIT", category: "Starters" },
    "design-system",
  );
  assert.equal(typeof text, "string");
  assert.match(text, /About to install/);
  assert.match(text, /license:\s+MIT/);
});

test("formatLicenseWarning: returns string for plugin (no brand category)", () => {
  const text = license.formatLicenseWarning(
    { id: "od-x", license: "Apache-2.0" },
    "plugin",
  );
  assert.equal(typeof text, "string");
  assert.match(text, /About to install/);
  assert.match(text, /kind:\s+plugin/);
  assert.match(text, /license:\s+Apache-2\.0/);
});

test("formatLicenseWarning: warns when license missing", () => {
  const text = license.formatLicenseWarning({ id: "x" }, "skill");
  assert.match(text, /license is unknown/);
});

test("formatLicenseWarning: throws for unknown kind", () => {
  assert.throws(
    () => license.formatLicenseWarning({ id: "x" }, "foo"),
    /unknown kind/,
  );
});

// ─── isAcceptable ────────────────────────────────────────────────────────────

test("isAcceptable: design-system delegates to T-OD-001", () => {
  const r = license.isAcceptable({ id: "x", license: "MIT" }, "design-system", { force: true });
  assert.equal(r.acceptable, true);
  assert.equal(r.reason, "forced");
});

test("isAcceptable: design-system rejects when license missing without --force", () => {
  const r = license.isAcceptable({ id: "x" }, "design-system", {});
  assert.equal(r.acceptable, false);
  assert.match(r.reason, /unknown license/);
});

test("isAcceptable: plugin accepts a normal Apache-2.0 license", () => {
  const r = license.isAcceptable({ license: "Apache-2.0" }, "plugin", {});
  assert.equal(r.acceptable, true);
});

test("isAcceptable: plugin rejects empty/missing license", () => {
  assert.equal(license.isAcceptable({}, "plugin", {}).acceptable, false);
  assert.equal(license.isAcceptable({ license: "" }, "plugin", {}).acceptable, false);
});

test("isAcceptable: plugin rejects license not in allowedLicenses", () => {
  const r = license.isAcceptable(
    { license: "GPL-3.0" },
    "plugin",
    { allowedLicenses: ["Apache-2.0", "MIT"] },
  );
  assert.equal(r.acceptable, false);
  assert.match(r.reason, /not in allowedLicenses/);
});

test("isAcceptable: plugin accepts license in allowedLicenses", () => {
  const r = license.isAcceptable(
    { license: "MIT" },
    "plugin",
    { allowedLicenses: ["Apache-2.0", "MIT"] },
  );
  assert.equal(r.acceptable, true);
});

test("isAcceptable: rejects unknown kind", () => {
  const r = license.isAcceptable({ license: "MIT" }, "foo", {});
  assert.equal(r.acceptable, false);
  assert.match(r.reason, /unknown kind/);
});

// ─── promptAck ───────────────────────────────────────────────────────────────

test("promptAck: yes=true skips prompt", async () => {
  const ok = await license.promptAck({ id: "x", license: "MIT" }, "plugin", { yes: true });
  assert.equal(ok, true);
});

test("promptAck: yes answer returns true", async () => {
  const ok = await license.promptAck(
    { id: "x", license: "MIT" },
    "plugin",
    { prompt: async () => "y" },
  );
  assert.equal(ok, true);
});

test("promptAck: 'yes' (full word) returns true", async () => {
  const ok = await license.promptAck(
    { id: "x", license: "MIT" },
    "plugin",
    { prompt: async () => "yes" },
  );
  assert.equal(ok, true);
});

test("promptAck: 'n' returns false", async () => {
  const ok = await license.promptAck(
    { id: "x", license: "MIT" },
    "plugin",
    { prompt: async () => "n" },
  );
  assert.equal(ok, false);
});

test("promptAck: empty answer returns false", async () => {
  const ok = await license.promptAck(
    { id: "x", license: "MIT" },
    "plugin",
    { prompt: async () => "" },
  );
  assert.equal(ok, false);
});

test("promptAck: design-system prompt goes through T-OD-001", async () => {
  // Capture the prompt text — confirms T-OD-001's formatLicenseWarning is used.
  let captured = "";
  const ok = await license.promptAck(
    { id: "default", license: "MIT", category: "Starters" },
    "design-system",
    {
      prompt: async (text) => {
        captured = text;
        return "y";
      },
    },
  );
  assert.equal(ok, true);
  assert.match(captured, /About to install/);
  assert.match(captured, /Proceed\?/);
});

// ─── 4-kind coverage ─────────────────────────────────────────────────────────

test("normalizeLicense: works for all 4 kinds", () => {
  for (const kind of KIND_LIST) {
    const tree = kind === "skill"
      ? { "SKILL.md": { frontmatter: { license: "MIT" } } }
      : kind === "plugin"
      ? { "open-design.json": { license: "Apache-2.0" } }
      : kind === "template"
      ? { "SKILL.md": { frontmatter: { license: "Apache-2.0" } } }
      : { "DESIGN.md": { frontmatter: { license: "Apache-2.0" } } };
    const r = license.normalizeLicense(kind, tree);
    assert.ok(r, `${kind} should produce a license`);
  }
});