#!/usr/bin/env node
/* eslint-disable */
// Zero-dependency validator for vendor.json files under .agent/global-shared-skills/*/
// Walks every <skill>/vendor.json under the given root, runs minimal structural checks
// matching _schema/vendor.schema.json. No ajv, no external deps.
//
// Usage:
//   node _schema/validate.js                      # default root: <state>/global-shared-skills
//   node _schema/validate.js <root>               # explicit root
//   node _schema/validate.js --resolve <sha> <root>  # also accept any resolved_sha == this
// Exit 0 on success, 1 on any failure.

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let resolveShaFilter = null;
let root = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--resolve' && args[i + 1]) {
    resolveShaFilter = args[++i];
  } else if (!root) {
    root = args[i];
  }
}

if (!root) {
  // Default: walk the symlinked vendor namespace. Caller is expected to chdir to .agent.
  root = path.join(process.cwd(), 'global-shared-skills');
}

const SCHEMA_REQUIRED = ['name', 'version', 'source', 'license', 'synced_at', 'compatibility'];
const SOURCE_REQUIRED = ['repo', 'ref', 'path'];
const COMPAT_REQUIRED_FIELDS = ['cortex_agent', 'harnesses', 'skill_standard'];
const LICENSE_ENUM = new Set([
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC',
  'MPL-2.0', 'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0',
  'AGPL-3.0', 'Unlicense', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0',
]);

const HARNESS_ENUM = new Set([
  'claude-code', 'codex', 'cursor', 'opencode', 'gemini-cli',
  'windsurf', 'antigravity', 'kiro', 'pi',
]);

const CATEGORY_ENUM = new Set([
  'core-methodology', 'llm-behavior', 'engineering-process',
  'design-aesthetics', 'token-optimization', 'security',
  'testing', 'debugging', 'frontend', 'backend', 'devops',
  'documentation', 'mcp-bridge',
]);

const errors = [];
const warnings = [];

function err(skill, msg) { errors.push(`[${skill}] ${msg}`); }
function warn(skill, msg) { warnings.push(`[${skill}] ${msg}`); }

function checkVendor(dir) {
  const name = path.basename(dir);
  const manifestPath = path.join(dir, 'vendor.json');
  if (!fs.existsSync(manifestPath)) {
    err(name, 'missing vendor.json');
    return;
  }
  let m;
  try {
    m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    err(name, `vendor.json is not valid JSON: ${e.message}`);
    return;
  }

  // Top-level required fields
  for (const k of SCHEMA_REQUIRED) {
    if (m[k] === undefined) err(name, `missing required field: ${k}`);
  }

  // name pattern + matches dir
  if (m.name !== undefined && m.name !== name) {
    err(name, `vendor.json name="${m.name}" does not match directory name`);
  }
  if (m.name !== undefined && !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(m.name)) {
    err(name, `name="${m.name}" does not match kebab-case pattern`);
  }

  // version pattern
  if (m.version !== undefined && !/^v?\d+\.\d+\.\d+([-.+][A-Za-z0-9.-]+)?$/.test(m.version)) {
    err(name, `version="${m.version}" is not a valid semver / release tag`);
  }

  // source block
  if (m.source) {
    for (const k of SOURCE_REQUIRED) {
      if (!m.source[k]) err(name, `source.${k} missing`);
    }
    if (m.source.repo && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(m.source.repo)) {
      err(name, `source.repo="${m.source.repo}" is not a valid owner/repo`);
    }
    if (m.source.resolved_sha && !/^[a-f0-9]{40}$/.test(m.source.resolved_sha)) {
      err(name, `source.resolved_sha="${m.source.resolved_sha}" must be a 40-char hex sha`);
    }
    if (resolveShaFilter && m.source.resolved_sha && m.source.resolved_sha !== resolveShaFilter) {
      warn(name, `source.resolved_sha=${m.source.resolved_sha} does not match filter ${resolveShaFilter}`);
    }
  }

  // license enum
  if (m.license && !LICENSE_ENUM.has(m.license)) {
    err(name, `license="${m.license}" is not in SPDX allowlist`);
  }

  // compatibility
  if (m.compatibility) {
    for (const k of COMPAT_REQUIRED_FIELDS) {
      if (m.compatibility[k] === undefined) err(name, `compatibility.${k} missing`);
    }
    if (m.compatibility.cortex_agent !== undefined &&
        !/^(?:[~^]|>=|>|<=|<|=)?\d+(?:\.\d+){0,2}$/.test(m.compatibility.cortex_agent)) {
      err(name, `compatibility.cortex_agent="${m.compatibility.cortex_agent}" is not a valid semver range (allow: bare/^/~/>=/>/<=/<=)`);
    }
    if (Array.isArray(m.compatibility.harnesses)) {
      for (const h of m.compatibility.harnesses) {
        if (!HARNESS_ENUM.has(h)) {
          err(name, `compatibility.harnesses contains unknown harness "${h}"`);
        }
      }
      if (m.compatibility.harnesses.length === 0) {
        err(name, 'compatibility.harnesses is empty');
      }
    } else if (m.compatibility.harnesses !== undefined) {
      err(name, 'compatibility.harnesses must be an array');
    }
  }

  // category
  if (m.category && !CATEGORY_ENUM.has(m.category)) {
    err(name, `category="${m.category}" is not in the curated category list`);
  }

  // declared skill_files exist
  if (Array.isArray(m.skill_files)) {
    for (const f of m.skill_files) {
      if (f.path && !fs.existsSync(path.join(dir, f.path))) {
        err(name, `declared skill_file "${f.path}" not found on disk`);
      }
    }
  }

  // synced_at is ISO-8601
  if (m.synced_at && Number.isNaN(Date.parse(m.synced_at))) {
    err(name, `synced_at="${m.synced_at}" is not a valid ISO-8601 date`);
  }

  // sanity: SKILL.md presence
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
    warn(name, 'no SKILL.md present (skill will not auto-activate)');
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) {
    err('<root>', `root not found: ${dir}`);
    return;
  }
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    err('<root>', `not a directory: ${dir}`);
    return;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === '_schema') continue;
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      const child = path.join(dir, e.name);
      if (fs.existsSync(path.join(child, 'vendor.json'))) {
        checkVendor(child);
      } else {
        // Recurse one more level — allow deeper nests for multi-file skills
        walk(child);
      }
    }
  }
}

console.log(`[validate] root: ${root}`);
walk(root);

if (warnings.length) {
  console.log(`\nWARN (${warnings.length}):`);
  for (const w of warnings) console.log('  ' + w);
}

if (errors.length) {
  console.error(`\nERROR (${errors.length}):`);
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}

console.log('\nOK: all vendor.json files pass structural checks.');
