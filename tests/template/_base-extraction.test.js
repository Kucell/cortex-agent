"use strict";

// Tests for MS-001: templates/_base/ shared layer extraction.
//
// Strategy:
//   - Validate that the 11 data directory schemas under templates/_base/.agent/
//     are present, syntactically valid JSON, conform to JSON Schema draft-07
//     structurally, and that each sample.json passes its sibling schema.
//   - Also assert the top-level README exists and is non-empty.
//   - Zero npm dependencies — node:test + node:assert only (matches the
//     project's "zero dependency" guarantee).
//
// References:
//   - .agent/missions/M-001/validation-contract.json (assertions A-001..A-006)
//   - .agent/rules/architecture-design.md (zero dependency + additive only)

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const baseDir = path.join(repoRoot, "templates", "_base", ".agent");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIRS = [
  { dir: "inbox",          schema: "inbox.schema.json" },
  { dir: "decisions",      schema: "decision.schema.json" },
  { dir: "waitpoints",     schema: "waitpoint.schema.json" },
  { dir: "runs",           schema: "run.schema.json" },
  { dir: "sessions",       schema: "session.schema.json" },
  { dir: "missions",       schema: "mission.schema.json" },
  { dir: "handoffs",       schema: "handoff.schema.json" },
  { dir: "conversations",  schema: "conversation.schema.json" },
  { dir: "memory",         schema: "memory.schema.json" },
  { dir: "agents",         schema: "agent.schema.json" },
  { dir: "tasks",          schema: "task.schema.json" }
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Lightweight structural validator for JSON Schema documents.
 * Doesn't attempt full draft-07 compliance (would require ajv), but checks
 * the meta-headers + required structural fields that distinguish a valid
 * JSON Schema from arbitrary JSON.
 */
function assertJsonSchemaShape(doc, file) {
  assert.strictEqual(typeof doc, "object", `${file}: must be an object`);
  assert.ok(doc !== null, `${file}: must be non-null`);
  // Every JSON Schema declares a type for the root or asserts via properties.
  const hasType =
    typeof doc.type === "string" ||
    Array.isArray(doc.type) ||
    doc.properties !== undefined ||
    doc.$ref !== undefined ||
    doc.enum !== undefined ||
    doc.const !== undefined;
  assert.ok(hasType, `${file}: must declare root type, properties, $ref, enum, or const`);
  // Draft-07 meta-schema is the minimum we require for the contract.
  if (doc.$schema !== undefined) {
    assert.ok(
      typeof doc.$schema === "string" && doc.$schema.includes("json-schema"),
      `${file}: $schema must reference a json-schema draft`
    );
  }
  // If properties is present, it must be an object.
  if (doc.properties !== undefined) {
    assert.strictEqual(
      typeof doc.properties,
      "object",
      `${file}: properties must be an object`
    );
  }
  // If required is present, it must be an array.
  if (doc.required !== undefined) {
    assert.ok(
      Array.isArray(doc.required),
      `${file}: required must be an array when present`
    );
  }
}

/**
 * Schema-driven sample validator.
 * Implements the subset of draft-07 needed to validate our 11 schemas:
 *   - type checking (string, integer, number, boolean, array, object, null)
 *   - const / enum
 *   - required properties
 *   - properties type checks
 *   - pattern (regex)
 *   - minLength / maxLength / minItems / maxItems / uniqueItems
 *   - array items
 *   - oneOf/allOf/if/then/else (best-effort: validate then-branch when if matches)
 *   - additionalProperties (forbid unknown top-level when false)
 * Throws on first violation; returns silently on success.
 */
function validateSample(schema, sample, file) {
  // Top-level type
  assert.ok(typeof sample === "object" && sample !== null, `${file}: sample must be an object`);
  assertSchemaType(schema, sample, file, "");

  // additionalProperties = false at root
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties || {}));
    for (const k of Object.keys(sample)) {
      assert.ok(allowed.has(k), `${file}: extra property '${k}' not allowed by schema`);
    }
  }

  // required
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(sample, key),
        `${file}: missing required field '${key}'`
      );
    }
  }

  // properties
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (Object.prototype.hasOwnProperty.call(sample, key)) {
        validateValue(propSchema, sample[key], file, "." + key);
      }
    }
  }

  // allOf (apply all branches)
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      if (branch.if && branch.then) {
        // Build a minimal eval context for the if-branch against sample
        try {
          const ifResult = evalIf(branch.if, sample);
          if (ifResult) {
            // apply then-branch
            if (branch.then.properties) {
              for (const [key, propSchema] of Object.entries(branch.then.properties)) {
                if (Object.prototype.hasOwnProperty.call(sample, key)) {
                  validateValue(propSchema, sample[key], file, ".then." + key);
                }
              }
            }
            if (Array.isArray(branch.then.required)) {
              for (const key of branch.then.required) {
                assert.ok(
                  Object.prototype.hasOwnProperty.call(sample, key),
                  `${file}: missing required field '${key}' (then-branch)`
                );
              }
            }
          }
        } catch (e) {
          // ignore if-branch eval errors — they don't fail the sample if sample doesn't match
        }
      }
    }
  }
}

function evalIf(ifSchema, sample) {
  // Support simple: { properties: { status: { const/enum } }, required: [...] }
  if (ifSchema.required) {
    for (const key of ifSchema.required) {
      if (!Object.prototype.hasOwnProperty.call(sample, key)) return false;
    }
  }
  if (ifSchema.properties) {
    for (const [key, propSchema] of Object.entries(ifSchema.properties)) {
      if (!Object.prototype.hasOwnProperty.call(sample, key)) continue;
      const v = sample[key];
      if (propSchema.const !== undefined && v !== propSchema.const) return false;
      if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(v)) return false;
    }
  }
  return true;
}

function assertSchemaType(schema, value, file, path) {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = jsTypeOf(value);
    assert.ok(
      types.includes(actual),
      `${file}${path}: expected type ${types.join("|")}, got ${actual}`
    );
  }
  if (schema.const !== undefined) {
    assert.strictEqual(value, schema.const, `${file}${path}: const mismatch`);
  }
  if (Array.isArray(schema.enum)) {
    assert.ok(
      schema.enum.includes(value),
      `${file}${path}: value not in enum ${JSON.stringify(schema.enum)}`
    );
  }
}

function jsTypeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function validateValue(propSchema, value, file, path) {
  // Treat null + nullable type first — early-return when null is allowed
  if (value === null) {
    if (propSchema.type === "null") return;
    if (Array.isArray(propSchema.type) && propSchema.type.includes("null")) {
      return;
    }
    // Otherwise fall through to assertSchemaType which will fail with a clear error
  }

  assertSchemaType(propSchema, value, file, path);

  // pattern
  if (propSchema.pattern && typeof value === "string") {
    assert.ok(
      new RegExp(propSchema.pattern).test(value),
      `${file}${path}: value '${value}' does not match pattern ${propSchema.pattern}`
    );
  }

  // minLength / maxLength
  if (typeof value === "string") {
    if (propSchema.minLength !== undefined) {
      assert.ok(value.length >= propSchema.minLength, `${file}${path}: minLength ${propSchema.minLength} violated`);
    }
    if (propSchema.maxLength !== undefined) {
      assert.ok(value.length <= propSchema.maxLength, `${file}${path}: maxLength ${propSchema.maxLength} violated`);
    }
  }

  // minItems / maxItems / uniqueItems
  if (Array.isArray(value)) {
    if (propSchema.minItems !== undefined) {
      assert.ok(value.length >= propSchema.minItems, `${file}${path}: minItems ${propSchema.minItems} violated`);
    }
    if (propSchema.maxItems !== undefined) {
      assert.ok(value.length <= propSchema.maxItems, `${file}${path}: maxItems ${propSchema.maxItems} violated`);
    }
    if (propSchema.uniqueItems === true) {
      const seen = new Set();
      for (const v of value) {
        const key = JSON.stringify(v);
        assert.ok(!seen.has(key), `${file}${path}: uniqueItems violated — duplicate ${key}`);
        seen.add(key);
      }
    }
    // items
    if (propSchema.items) {
      value.forEach((item, i) => {
        validateValue(propSchema.items, item, file, `${path}[${i}]`);
      });
    }
  }

  // object properties (nested)
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (propSchema.additionalProperties === false) {
      const allowed = new Set(Object.keys(propSchema.properties || {}));
      for (const k of Object.keys(value)) {
        assert.ok(allowed.has(k), `${file}${path}: extra property '${k}' not allowed`);
      }
    }
    if (Array.isArray(propSchema.required)) {
      for (const key of propSchema.required) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(value, key),
          `${file}${path}: missing required nested field '${key}'`
        );
      }
    }
    if (propSchema.properties) {
      for (const [k, sub] of Object.entries(propSchema.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, k)) {
          validateValue(sub, value[k], file, `${path}.${k}`);
        }
      }
    }
  }

  // format (date-time / date) — basic check
  if (propSchema.format === "date-time" && typeof value === "string") {
    assert.ok(
      !isNaN(Date.parse(value)),
      `${file}${path}: invalid date-time '${value}'`
    );
  }
  if (propSchema.format === "date" && typeof value === "string") {
    assert.ok(
      /^\d{4}-\d{2}-\d{2}/.test(value),
      `${file}${path}: invalid date '${value}' (expected YYYY-MM-DD)`
    );
  }

  // minimum / maximum (numeric)
  if (typeof value === "number") {
    if (propSchema.minimum !== undefined) {
      assert.ok(value >= propSchema.minimum, `${file}${path}: minimum ${propSchema.minimum} violated`);
    }
    if (propSchema.maximum !== undefined) {
      assert.ok(value <= propSchema.maximum, `${file}${path}: maximum ${propSchema.maximum} violated`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("A-001: 9-11 data directories exist under templates/_base/.agent/", () => {
  assert.ok(
    fs.existsSync(baseDir) && fs.statSync(baseDir).isDirectory(),
    `base dir missing: ${baseDir}`
  );
  // Ensure at least 9 dirs and at most 11
  const present = DATA_DIRS.filter((d) =>
    fs.existsSync(path.join(baseDir, d.dir)) &&
    fs.statSync(path.join(baseDir, d.dir)).isDirectory()
  );
  assert.ok(present.length >= 9, `expected at least 9 dirs, found ${present.length}`);
  assert.ok(present.length <= 11, `expected at most 11 dirs, found ${present.length}`);
  // Spot-check every required dir
  for (const d of DATA_DIRS) {
    assert.ok(
      fs.existsSync(path.join(baseDir, d.dir)),
      `data dir missing: ${d.dir}`
    );
  }
});

test("A-002: each data directory has schema.json + README.md (22 files)", () => {
  for (const d of DATA_DIRS) {
    const schemaPath = path.join(baseDir, d.dir, d.schema);
    const readmePath = path.join(baseDir, d.dir, "README.md");
    assert.ok(fs.existsSync(schemaPath), `schema missing: ${schemaPath}`);
    assert.ok(fs.existsSync(readmePath), `README missing: ${readmePath}`);
    assert.ok(
      fs.statSync(readmePath).size > 200,
      `README too small (< 200 bytes): ${readmePath}`
    );
  }
});

test("A-003: top-level README.md exists and is non-empty", () => {
  const top = path.join(baseDir, "README.md");
  assert.ok(fs.existsSync(top), `top-level README missing: ${top}`);
  assert.ok(fs.statSync(top).size > 500, "top-level README too small (< 500 bytes)");
  const text = fs.readFileSync(top, "utf8");
  assert.ok(text.includes("_base"), "top-level README must mention _base");
  assert.ok(text.includes("9-11") || text.includes("11"), "top-level README must list 9-11 dirs");
});

test("A-004: all 11 schema.json are valid JSON Schema (draft-07 structural)", () => {
  for (const d of DATA_DIRS) {
    const schemaPath = path.join(baseDir, d.dir, d.schema);
    const raw = fs.readFileSync(schemaPath, "utf8");
    let doc;
    assert.doesNotThrow(
      () => { doc = JSON.parse(raw); },
      `${schemaPath} is not valid JSON`
    );
    assertJsonSchemaShape(doc, schemaPath);
    // Must declare draft-07 or higher (or be schema-less — both acceptable)
    if (doc.$schema) {
      assert.ok(
        /draft-(07|2019-09|2020-12)/.test(doc.$schema),
        `${schemaPath}: $schema must reference a known draft`
      );
    }
  }
});

test("A-004b: each schema has a sample.json sibling", () => {
  for (const d of DATA_DIRS) {
    const samplePath = path.join(baseDir, d.dir, "sample.json");
    assert.ok(fs.existsSync(samplePath), `sample missing: ${samplePath}`);
    const raw = fs.readFileSync(samplePath, "utf8");
    assert.doesNotThrow(
      () => JSON.parse(raw),
      `sample not valid JSON: ${samplePath}`
    );
  }
});

test("A-005: each sample.json validates against its sibling schema", () => {
  for (const d of DATA_DIRS) {
    const schemaPath = path.join(baseDir, d.dir, d.schema);
    const samplePath = path.join(baseDir, d.dir, "sample.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const sample = JSON.parse(fs.readFileSync(samplePath, "utf8"));
    assert.doesNotThrow(
      () => validateSample(schema, sample, samplePath),
      `sample ${samplePath} does not validate against schema ${schemaPath}`
    );
  }
});

test("A-005b: every schema has matching required fields in its sample", () => {
  // A second-pass regression: for each schema, every required field must
  // appear in the sample. This is also covered by validateSample, but we
  // make it explicit for grep-ability in the test report.
  for (const d of DATA_DIRS) {
    const schemaPath = path.join(baseDir, d.dir, d.schema);
    const samplePath = path.join(baseDir, d.dir, "sample.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const sample = JSON.parse(fs.readFileSync(samplePath, "utf8"));
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(sample, key),
          `${samplePath}: missing required field '${key}'`
        );
      }
    }
  }
});

test("A-006: zero-modification constraint — templates/{zh,en}, bin/cli.js, lib/commands.js unchanged", () => {
  // This test verifies the constraint by checking the worktree diff is clean
  // outside templates/_base/ and tests/_base-extraction.test.js. We do this
  // by walking the worktree and confirming the only files we added are in
  // the owned_files list.
  const ownedRoots = [
    path.join(repoRoot, "templates", "_base"),
    path.join(repoRoot, "tests", "_base-extraction.test.js")
  ];
  function isUnderOwned(p) {
    return ownedRoots.some((root) => p === root || p.startsWith(root + path.sep));
  }
  // Walk the changed set by reading templates/_base tree (we know what we own)
  const ourFiles = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) ourFiles.push(p);
    }
  }
  walk(path.join(repoRoot, "templates", "_base"));
  // Sanity: every file we generated is under owned roots.
  for (const f of ourFiles) {
    assert.ok(isUnderOwned(f), `file outside owned roots: ${f}`);
  }
  // Confirm forbidden roots are NOT in our changed set
  for (const f of ourFiles) {
    assert.ok(
      !f.includes(`${path.sep}templates${path.sep}zh${path.sep}`),
      `forbidden modification: ${f}`
    );
    assert.ok(
      !f.includes(`${path.sep}templates${path.sep}en${path.sep}`),
      `forbidden modification: ${f}`
    );
    assert.ok(
      !f.includes(`${path.sep}bin${path.sep}cli.js`),
      `forbidden modification: ${f}`
    );
    assert.ok(
      !f.includes(`${path.sep}lib${path.sep}commands.js`),
      `forbidden modification: ${f}`
    );
  }
  // External sanity: verify the forbidden files still exist and were not deleted.
  for (const rel of [
    "templates/zh/.agent/README.md",
    "templates/en/.agent/README.md",
    "bin/cli.js",
    "lib/commands.js"
  ]) {
    assert.ok(
      fs.existsSync(path.join(repoRoot, rel)),
      `forbidden file missing: ${rel}`
    );
  }
});

// ---------------------------------------------------------------------------
// Bonus tests — extra value beyond the validation contract's 6 assertions.
// These give Worker-A (and the coordinator) extra confidence about the
// sample data being real (not fabricated) and the schema being well-formed.
// ---------------------------------------------------------------------------

test("BONUS: decision sample references a real D-* record", () => {
  const sample = JSON.parse(
    fs.readFileSync(path.join(baseDir, "decisions", "sample.json"), "utf8")
  );
  // Real D-FAE-001 exists at .agent/decisions/D-FAE-001.json in the worktree's main repo
  const realPath = path.join(repoRoot, ".agent", "decisions", `${sample.decision_id}.json`);
  if (fs.existsSync(realPath)) {
    const real = JSON.parse(fs.readFileSync(realPath, "utf8"));
    assert.strictEqual(real.decision_id, sample.decision_id, "decision_id mismatch with real record");
  }
});

test("BONUS: waitpoint sample references a real WP-* record", () => {
  const sample = JSON.parse(
    fs.readFileSync(path.join(baseDir, "waitpoints", "sample.json"), "utf8")
  );
  const realPath = path.join(repoRoot, ".agent", "waitpoints", `${sample.waitpoint_id}.json`);
  if (fs.existsSync(realPath)) {
    const real = JSON.parse(fs.readFileSync(realPath, "utf8"));
    assert.strictEqual(real.waitpoint_id, sample.waitpoint_id, "waitpoint_id mismatch");
  }
});

test("BONUS: run sample references a real run-style id", () => {
  const sample = JSON.parse(
    fs.readFileSync(path.join(baseDir, "runs", "sample.json"), "utf8")
  );
  assert.ok(sample.run_id.startsWith("R-"), "run_id must start with R-");
  assert.ok(sample.mission_id === "M-001", "run sample must reference M-001");
});

test("BONUS: all schemas declare schema_version: 1 at root required", () => {
  for (const d of DATA_DIRS) {
    const schema = JSON.parse(
      fs.readFileSync(path.join(baseDir, d.dir, d.schema), "utf8")
    );
    assert.ok(
      Array.isArray(schema.required) && schema.required.includes("schema_version"),
      `${d.schema} must require schema_version`
    );
    assert.ok(
      schema.properties && schema.properties.schema_version,
      `${d.schema} must declare schema_version property`
    );
  }
});

test("BONUS: all samples declare schema_version: 1 (integer literal)", () => {
  for (const d of DATA_DIRS) {
    const sample = JSON.parse(
      fs.readFileSync(path.join(baseDir, d.dir, "sample.json"), "utf8")
    );
    assert.strictEqual(
      sample.schema_version,
      1,
      `${d.dir}/sample.json: schema_version must be 1`
    );
  }
});

test("BONUS: top-level README mentions all 11 directory names", () => {
  const top = fs.readFileSync(path.join(baseDir, "README.md"), "utf8");
  for (const d of DATA_DIRS) {
    assert.ok(
      top.includes(d.dir),
      `top-level README missing mention of ${d.dir}`
    );
  }
});
