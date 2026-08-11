/**
 * tests/governed-attempt-progress/schema.test.js
 *
 * M-013 SP-001 / VC-001 + VC-001a: Validate that all 5 progress fixtures
 * (alive, active, productive, verified, blocked) conform to the V1 schema,
 * AND that the schema itself has the required P-005 §3.1 contract fields.
 *
 * Pure Node.js validator (no external deps). Hand-rolled subset of JSON Schema 2020-12.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '.agent',
  'schemas',
  'governed-attempt-progress.v1.json'
);
const FIXTURES_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '.agent',
  'fixtures',
  'governed-attempt-progress'
);

const EXPECTED_EVIDENCE_LEVELS = ['alive', 'active', 'productive', 'verified'];
const EXPECTED_PHASES = ['observing', 'editing', 'testing', 'ready', 'blocked', 'failed'];
const EXPECTED_VALIDATION_STATUSES = ['not_run', 'running', 'passed', 'failed'];
const REQUIRED_FIELDS = [
  'taskId',
  'operationId',
  'launchId',
  'attempt',
  'phase',
  'evidenceLevel',
  'lastActivityAt'
];

function loadSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

function loadFixture(name) {
  const filePath = path.join(FIXTURES_DIR, `${name}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Pure Node.js validator (subset of JSON Schema 2020-12)
function validate(schema, data, path_ = '') {
  const errors = [];

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    let actualType = Array.isArray(data) ? 'array' : (data === null ? 'null' : typeof data);
    if (actualType === 'number' && types.includes('integer')) {
      actualType = 'integer';
    }
    const matched = types.some((t) => {
      if (t === 'integer') return actualType === 'integer' || actualType === 'number';
      if (t === 'number') return actualType === 'number' || actualType === 'integer';
      return t === actualType;
    });
    if (!matched) {
      errors.push(`${path_ || '<root>'}: expected type ${JSON.stringify(types)}, got ${actualType}`);
      return errors;
    }
  }

  if (schema.const !== undefined && data !== schema.const) {
    errors.push(`${path_ || '<root>'}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
  }

  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${path_ || '<root>'}: expected enum ${JSON.stringify(schema.enum)}, got ${JSON.stringify(data)}`);
  }

  if (schema.type === 'string' && schema.minLength !== undefined && typeof data === 'string' && data.length < schema.minLength) {
    errors.push(`${path_ || '<root>'}: string length ${data.length} < minLength ${schema.minLength}`);
  }

  if (schema.type === 'string' && schema.format === 'date-time' && typeof data === 'string') {
    if (isNaN(Date.parse(data))) {
      errors.push(`${path_ || '<root>'}: expected date-time, got ${JSON.stringify(data)}`);
    }
  }

  if (schema.type === 'integer' && schema.minimum !== undefined && typeof data === 'number' && data < schema.minimum) {
    errors.push(`${path_ || '<root>'}: ${data} < minimum ${schema.minimum}`);
  }

  if (schema.type === 'object' && typeof data === 'object' && data !== null) {
    if (schema.required) {
      for (const req of schema.required) {
        if (!(req in data)) {
          errors.push(`${path_ || '<root>'}: missing required field '${req}'`);
        }
      }
    }
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in data) {
          const subPath = path_ ? `${path_}.${key}` : key;
          errors.push(...validate(propSchema, data[key], subPath));
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(data)) {
        if (!allowed.has(key)) {
          errors.push(`${path_ || '<root>'}: additional property '${key}' not allowed`);
        }
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(data)) {
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      errors.push(`${path_ || '<root>'}: array length ${data.length} > maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      for (let i = 0; i < data.length; i++) {
        const subPath = `${path_}[${i}]`;
        errors.push(...validate(schema.items, data[i], subPath));
      }
    }
  }

  return errors;
}

test('schema: exists at expected path', () => {
  assert.ok(fs.existsSync(SCHEMA_PATH), `Schema not found: ${SCHEMA_PATH}`);
});

test('schema: all required fields are declared in schema.required', () => {
  const schema = loadSchema();
  const required = schema.required || [];
  for (const field of REQUIRED_FIELDS) {
    assert.ok(required.includes(field), `Missing required field: ${field}`);
  }
});

test('schema: all required fields are defined in schema.properties', () => {
  const schema = loadSchema();
  for (const field of REQUIRED_FIELDS) {
    assert.ok(schema.properties[field], `Missing properties.${field}`);
  }
});

test('schema: evidenceLevel enum matches P-005 §3.1 4 levels', () => {
  const schema = loadSchema();
  assert.deepEqual(schema.properties.evidenceLevel.enum, EXPECTED_EVIDENCE_LEVELS);
});

test('schema: phase enum matches P-005 §3.2 6 phases', () => {
  const schema = loadSchema();
  assert.deepEqual(schema.properties.phase.enum, EXPECTED_PHASES);
});

test('schema: validation.status enum matches P-005 §3.2 4 statuses', () => {
  const schema = loadSchema();
  assert.deepEqual(
    schema.properties.validation.properties.status.enum,
    EXPECTED_VALIDATION_STATUSES
  );
});

test('schema: additionalProperties=false at root prevents field drift', () => {
  const schema = loadSchema();
  assert.equal(schema.additionalProperties, false);
});

test('schema: activity counters are non-negative integers', () => {
  const schema = loadSchema();
  const activityProps = schema.properties.activity.properties;
  for (const k of ['readOnlyToolCount', 'writeToolCount', 'testToolCount', 'failedToolCount']) {
    assert.equal(activityProps[k].type, 'integer');
    assert.equal(activityProps[k].minimum, 0);
  }
});

test('schema: worktree counters are non-negative integers', () => {
  const schema = loadSchema();
  const worktreeProps = schema.properties.worktree.properties;
  for (const k of ['changedFileCount', 'insertions', 'deletions']) {
    assert.equal(worktreeProps[k].type, 'integer');
    assert.equal(worktreeProps[k].minimum, 0);
  }
});

test('schema: diagnostics bounded to 50 items', () => {
  const schema = loadSchema();
  assert.equal(schema.properties.diagnostics.maxItems, 50);
});

test('fixture alive: validates against V1 schema', () => {
  const schema = loadSchema();
  const data = loadFixture('alive');
  const errors = validate(schema, data);
  assert.equal(errors.length, 0, `alive fixture failed: ${JSON.stringify(errors)}`);
});

test('fixture alive: evidenceLevel=alive, lastProductiveAt=null', () => {
  const data = loadFixture('alive');
  assert.equal(data.evidenceLevel, 'alive');
  assert.equal(data.lastProductiveAt, null);
});

test('fixture alive: no percentage or in_progress markers (VC-001)', () => {
  const data = loadFixture('alive');
  const serialized = JSON.stringify(data);
  assert.ok(!/in_progress/i.test(serialized), 'alive should not contain in_progress');
  assert.ok(!/percent/i.test(serialized), 'alive should not contain percent');
  assert.ok(!/%/.test(serialized), 'alive should not contain %');
});

test('fixture active: validates against V1 schema with evidenceLevel=active', () => {
  const schema = loadSchema();
  const data = loadFixture('active');
  const errors = validate(schema, data);
  assert.equal(errors.length, 0, `active fixture failed: ${JSON.stringify(errors)}`);
  assert.equal(data.evidenceLevel, 'active');
  assert.equal(data.activity.readOnlyToolCount, 5);
  assert.equal(data.worktree.changedFileCount, 0);
});

test('fixture productive: validates with evidenceLevel=productive + worktree diff', () => {
  const schema = loadSchema();
  const data = loadFixture('productive');
  const errors = validate(schema, data);
  assert.equal(errors.length, 0, `productive fixture failed: ${JSON.stringify(errors)}`);
  assert.equal(data.evidenceLevel, 'productive');
  assert.ok(data.worktree.changedFileCount > 0, 'productive must have changed files');
  assert.ok(data.worktree.diffDigest !== data.worktree.baselineHead, 'productive must have diff');
});

test('fixture verified: validates with validation.status=passed', () => {
  const schema = loadSchema();
  const data = loadFixture('verified');
  const errors = validate(schema, data);
  assert.equal(errors.length, 0, `verified fixture failed: ${JSON.stringify(errors)}`);
  assert.equal(data.evidenceLevel, 'verified');
  assert.equal(data.validation.status, 'passed');
  assert.ok(data.validation.evidenceRef, 'verified must have evidenceRef');
});

test('fixture blocked: validates with phase=blocked + failed tool', () => {
  const schema = loadSchema();
  const data = loadFixture('blocked');
  const errors = validate(schema, data);
  assert.equal(errors.length, 0, `blocked fixture failed: ${JSON.stringify(errors)}`);
  assert.equal(data.phase, 'blocked');
  assert.ok(data.activity.failedToolCount > 0, 'blocked must have failed tools');
  assert.equal(data.validation.status, 'failed');
  assert.ok(data.diagnostics.length > 0, 'blocked must have diagnostics');
});

test('all 5 fixtures: validate against V1 schema simultaneously', () => {
  const schema = loadSchema();
  for (const name of ['alive', 'active', 'productive', 'verified', 'blocked']) {
    const data = loadFixture(name);
    const errors = validate(schema, data);
    assert.equal(errors.length, 0, `${name} fixture failed: ${JSON.stringify(errors)}`);
  }
});
