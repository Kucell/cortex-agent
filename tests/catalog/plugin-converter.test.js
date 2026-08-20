"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const converter = require("../../lib/catalog/plugin-converter");
const {
  validateOpenDesign,
  toCortexAgentManifest,
  fromCortexAgentManifest,
  kindFromOpenDesignPath,
} = converter;

// ─── validateOpenDesign ──────────────────────────────────────────────────────

test("validateOpenDesign: ok for valid plugin shape", () => {
  const r = validateOpenDesign({
    od: { kind: "plugin", name: "od-x", version: "1.0.0" },
  });
  assert.equal(r.ok, true);
});

test("validateOpenDesign: rejects non-object input", () => {
  assert.equal(validateOpenDesign(null).ok, false);
  assert.equal(validateOpenDesign("string").ok, false);
  assert.equal(validateOpenDesign(undefined).ok, false);
});

test("validateOpenDesign: rejects missing od.kind", () => {
  const r = validateOpenDesign({ od: { name: "x", version: "1.0.0" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /od\.kind/);
});

test("validateOpenDesign: rejects missing od.name", () => {
  const r = validateOpenDesign({ od: { kind: "plugin", version: "1.0.0" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /od\.name/);
});

test("validateOpenDesign: rejects missing od.version", () => {
  const r = validateOpenDesign({ od: { kind: "plugin", name: "x" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /od\.version/);
});

test("validateOpenDesign: rejects unsupported od.kind", () => {
  const r = validateOpenDesign({
    od: { kind: "alien", name: "x", version: "1.0.0" },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not in supported set/);
});

test("validateOpenDesign: rejects empty string values", () => {
  const r = validateOpenDesign({
    od: { kind: "plugin", name: "", version: "1.0.0" },
  });
  assert.equal(r.ok, false);
});

// ─── toCortexAgentManifest ───────────────────────────────────────────────────

test("toCortexAgentManifest: basic conversion", () => {
  const od = {
    od: {
      kind: "plugin",
      name: "od-figma-migration",
      version: "1.2.3",
      description: "Migrate Figma designs to cortex-agent",
      mode: "ui",
      taskKind: "figma-migration",
      capabilities: ["read-figma", "export-html"],
      inputs: [{ name: "fileUrl", type: "string", required: true }],
    },
    license: "Apache-2.0",
  };
  const m = toCortexAgentManifest(od);
  assert.equal(m.id, "od-figma-migration");
  assert.equal(m.name, "od-figma-migration");
  assert.equal(m.version, "1.2.3");
  assert.equal(m.license, "Apache-2.0");
  assert.equal(m.source, "open-design");
  assert.equal(m.mode, "ui");
  assert.equal(m.taskKind, "figma-migration");
  assert.deepEqual(m.capabilities, ["read-figma", "export-html"]);
  assert.equal(m.inputs.length, 1);
  assert.equal(m.installPath, ".agent/plugins/od-figma-migration");
  assert.match(m.convertedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("toCortexAgentManifest: sanitizes id (lowercase + safe chars)", () => {
  const m = toCortexAgentManifest({
    od: { kind: "plugin", name: "My Plugin @ 2025!", version: "1.0.0" },
  });
  assert.equal(m.id, "my-plugin---2025-");
});

test("toCortexAgentManifest: preserves unknown od.* fields in x-open-design", () => {
  const m = toCortexAgentManifest({
    od: {
      kind: "plugin",
      name: "x",
      version: "1.0.0",
      customField: { foo: "bar" },
      repository: "https://example.com",
    },
  });
  assert.ok(m["x-open-design"]);
  assert.deepEqual(m["x-open-design"].customField, { foo: "bar" });
  // `repository` is a known key — should NOT appear in x-open-design
  assert.equal(m["x-open-design"].repository, undefined);
});

test("toCortexAgentManifest: license override wins over od.license", () => {
  const m = toCortexAgentManifest(
    {
      od: { kind: "plugin", name: "x", version: "1.0.0" },
      license: "MIT",
    },
    { license: "Apache-2.0" },
  );
  assert.equal(m.license, "Apache-2.0");
});

test("toCortexAgentManifest: defaults license when missing", () => {
  const m = toCortexAgentManifest({
    od: { kind: "plugin", name: "x", version: "1.0.0" },
  });
  assert.equal(m.license, "Apache-2.0"); // kind-map.licenseDefault
});

test("toCortexAgentManifest: defaults mode to 'code' when missing", () => {
  const m = toCortexAgentManifest({
    od: { kind: "plugin", name: "x", version: "1.0.0" },
  });
  assert.equal(m.mode, "code");
});

test("toCortexAgentManifest: invalid input throws", () => {
  assert.throws(
    () => toCortexAgentManifest({ od: { kind: "plugin", name: "x" } }),
    /missing required field "od.version"/,
  );
});

test("toCortexAgentManifest: punctuation-only name throws (no alphanumerics survive)", () => {
  // `!@#$%` sanitizes to `-----` which has no alphanumeric char → rejected.
  assert.throws(
    () => toCortexAgentManifest({ od: { kind: "plugin", name: "!@#$%", version: "1.0.0" } }),
    /must produce a non-empty id/,
  );
});

test("toCortexAgentManifest: whitespace-only name throws", () => {
  assert.throws(
    () => toCortexAgentManifest({ od: { kind: "plugin", name: "   ", version: "1.0.0" } }),
    /must produce a non-empty id/,
  );
});

// ─── fromCortexAgentManifest (round-trip) ────────────────────────────────────

test("fromCortexAgentManifest: returns null for non-open-design manifest", () => {
  assert.equal(fromCortexAgentManifest({ source: "local" }), null);
});

test("fromCortexAgentManifest: round-trips a basic manifest", () => {
  const od = {
    od: {
      kind: "plugin",
      name: "x",
      version: "1.0.0",
      mode: "ui",
      capabilities: ["a", "b"],
    },
    license: "Apache-2.0",
  };
  const m = toCortexAgentManifest(od);
  const back = fromCortexAgentManifest(m);
  assert.equal(back.od.kind, "plugin");
  assert.equal(back.od.name, "x");
  assert.equal(back.od.version, "1.0.0");
  assert.deepEqual(back.od.capabilities, ["a", "b"]);
  assert.equal(back.license, "Apache-2.0");
});

// ─── kindFromOpenDesignPath ──────────────────────────────────────────────────

test("kindFromOpenDesignPath: plugins/_official/<id>/...", () => {
  assert.equal(
    kindFromOpenDesignPath("plugins/_official/od-x/open-design.json"),
    "plugin",
  );
});

test("kindFromOpenDesignPath: skills/<id>/SKILL.md", () => {
  assert.equal(kindFromOpenDesignPath("skills/some-skill/SKILL.md"), "skill");
});

test("kindFromOpenDesignPath: design-templates/<id>/SKILL.md", () => {
  assert.equal(
    kindFromOpenDesignPath("design-templates/saas-landing/SKILL.md"),
    "template",
  );
});

test("kindFromOpenDesignPath: design-systems/<id>/manifest.json", () => {
  assert.equal(
    kindFromOpenDesignPath("design-systems/linear-app/manifest.json"),
    "design-system",
  );
});

test("kindFromOpenDesignPath: returns null for unknown paths", () => {
  assert.equal(kindFromOpenDesignPath("unknown/foo/bar"), null);
  assert.equal(kindFromOpenDesignPath(""), null);
  assert.equal(kindFromOpenDesignPath("single"), null);
});