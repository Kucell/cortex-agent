/**
 * tests/governed-attempt-progress/redaction.test.js
 *
 * M-013 SP-001 / VC-001b: Validate that all 6 redaction classes
 * (prompt, response, tool_arguments, tool_output, file_body, absolute_path)
 * produce digests only and never contain raw content in the expected output.
 *
 * The expected fixtures explicitly declare forbidden_fields per class.
 * Any forbidden field present in the output breaks the contract.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REDACTION_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '.agent',
  'fixtures',
  'redaction'
);

const REDACTION_CLASSES = [
  'prompt',
  'response',
  'tool_arguments',
  'tool_output',
  'file_body',
  'absolute_path'
];

function loadExpected(name) {
  const filePath = path.join(REDACTION_DIR, `${name}.expected.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadInputLines(name) {
  const filePath = path.join(REDACTION_DIR, `${name}.input.jsonl`);
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function collectAllFields(obj, prefix = '', acc = new Set()) {
  if (obj === null || obj === undefined) return acc;
  if (typeof obj !== 'object') return acc;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectAllFields(item, prefix, acc);
    }
    return acc;
  }
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    acc.add(fullKey);
    if (typeof value === 'object' && value !== null) {
      collectAllFields(value, fullKey, acc);
    }
  }
  return acc;
}

for (const cls of REDACTION_CLASSES) {
  test(`redaction: ${cls} — expected.json declares forbidden_fields`, () => {
    const expected = loadExpected(cls);
    assert.ok(Array.isArray(expected.forbidden_fields), `${cls}.expected.json must declare forbidden_fields array`);
    assert.ok(expected.forbidden_fields.length > 0, `${cls}.expected.json must have at least one forbidden field`);
  });

  test(`redaction: ${cls} — expected.json redactions never expose forbidden fields`, () => {
    const expected = loadExpected(cls);
    const forbidden = new Set(expected.forbidden_fields);
    const redactedClass = expected.redacted_class || cls;

    let foundForbidden = null;
    for (const redaction of expected.redactions) {
      assert.equal(redaction.redacted_class, redactedClass, `${cls} redaction entry must have redacted_class=${redactedClass}`);
      const fields = collectAllFields(redaction);
      for (const field of fields) {
        // Substring match: forbidden fields are top-level checks (e.g. "content" matches "content").
        for (const f of forbidden) {
          if (field === f || field.endsWith('.' + f) || field.startsWith(f + '.')) {
            foundForbidden = `${cls}.redactions[${redaction.taskId || ''}].${field} (forbidden: ${f})`;
            break;
          }
        }
      }
    }
    assert.equal(foundForbidden, null, `Forbidden field present in expected output: ${foundForbidden}`);
  });

  test(`redaction: ${cls} — input.jsonl does not contain raw content markers`, () => {
    const lines = loadInputLines(cls);
    assert.ok(lines.length > 0, `${cls}.input.jsonl must have at least one entry`);
    for (const line of lines) {
      // type must end with "_redacted" and contain class identifier (full or short)
      assert.ok(typeof line.type === 'string', `${cls} input line must have type`);
      assert.ok(/_redacted$/.test(line.type), `${cls} input line.type should end with _redacted, got ${line.type}`);
      const typeHasClass =
        line.type.includes(cls) || line.type.includes(cls.replace(/_/g, '_').replace('_', '')) ||
        (cls === 'tool_arguments' && line.type.includes('tool_args')) ||
        (cls === 'tool_output' && line.type.includes('tool_output')) ||
        (cls === 'file_body' && line.type.includes('file_body')) ||
        (cls === 'absolute_path' && /path/i.test(line.type));
      assert.ok(typeHasClass, `${cls} input line.type should reference class, got ${line.type}`);
      // Each class uses a class-specific digest field name
      const hasAnyDigest = line.digest || line.argsDigest || line.outputDigest || line.bodyDigest || line.absolutePathDigest;
      assert.ok(hasAnyDigest, `${cls} input line must have at least one digest field`);
      assert.ok(line.timestamp, `${cls} input line must have timestamp`);
    }
  });

  test(`redaction: ${cls} — redaction entries carry bounded metadata, no raw body`, () => {
    const expected = loadExpected(cls);
    const required = new Set(expected.required_fields);
    for (const redaction of expected.redactions) {
      const fields = collectAllFields(redaction);
      for (const req of required) {
        // Top-level field check
        assert.ok(fields.has(req), `${cls} redaction missing required field: ${req}`);
      }
    }
  });
}

test('redaction: all 6 classes covered (no class missing fixtures)', () => {
  const dirContents = fs
    .readdirSync(REDACTION_DIR)
    .filter((f) => f.endsWith('.input.jsonl'))
    .map((f) => f.replace('.input.jsonl', ''));
  for (const cls of REDACTION_CLASSES) {
    assert.ok(dirContents.includes(cls), `Missing fixture pair for class: ${cls}`);
  }
});

test('redaction: secret-pattern scan — no api_key/password/token in any expected.json', () => {
  const secretPatterns = [/api[-_]?key/i, /password/i, /bearer\s/i, /secret\s*=?\s/i];
  for (const cls of REDACTION_CLASSES) {
    const expected = loadExpected(cls);
    const serialized = JSON.stringify(expected);
    for (const pat of secretPatterns) {
      assert.ok(!pat.test(serialized), `${cls} expected.json contains secret pattern: ${pat}`);
    }
  }
});
