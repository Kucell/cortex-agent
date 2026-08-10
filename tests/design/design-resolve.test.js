'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveCascade,
  effectiveDesign,
  findLayer1,
  findLayer2,
  findLayer3,
  findLayer4,
  exists,
} = require("../../lib/design/resolve");
const { addSystem } = require("../../lib/design/lockfile");

function makeTmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-design-resolve-'));
}

function makeTmpTemplateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-design-resolve-tpl-'));
}

// -- exists -----------------------------------------------------------------

test('exists: file exists', () => {
  const tmp = makeTmpCwd();
  try {
    const p = path.join(tmp, 'a.txt');
    fs.writeFileSync(p, 'x');
    assert.equal(exists(p), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('exists: missing file', () => {
  const tmp = makeTmpCwd();
  try {
    assert.equal(exists(path.join(tmp, 'no-such')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('exists: directory is not a file', () => {
  const tmp = makeTmpCwd();
  try {
    assert.equal(exists(tmp), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// -- findLayer1 -------------------------------------------------------------

test('findLayer1: returns entry when <cwd>/DESIGN.md exists', () => {
  const cwd = makeTmpCwd();
  try {
    fs.writeFileSync(path.join(cwd, 'DESIGN.md'), '# Custom');
    const r = findLayer1(cwd);
    assert.equal(r.length, 1);
    assert.equal(r[0].layer, 1);
    assert.equal(r[0].kind, 'user-override');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('findLayer1: empty when missing', () => {
  const cwd = makeTmpCwd();
  try {
    assert.equal(findLayer1(cwd).length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// -- findLayer2 -------------------------------------------------------------

test('findLayer2: returns entry when <cwd>/.agent/DESIGN.md exists', () => {
  const cwd = makeTmpCwd();
  try {
    fs.mkdirSync(path.join(cwd, '.agent'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.agent', 'DESIGN.md'), '# Agent');
    const r = findLayer2(cwd);
    assert.equal(r.length, 1);
    assert.equal(r[0].layer, 2);
    assert.equal(r[0].kind, 'agent-context');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// -- findLayer3 (LIFO) ------------------------------------------------------

test('findLayer3: LIFO order — last installed wins', () => {
  const cwd = makeTmpCwd();
  try {
    // Add 2 systems
    addSystem(cwd, { id: 'first', license: 'A' });
    addSystem(cwd, { id: 'second', license: 'B' });
    // Write their DESIGN.md files
    fs.mkdirSync(path.join(cwd, '.agent', 'design-systems', 'first'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.agent', 'design-systems', 'first', 'DESIGN.md'), '# First');
    fs.mkdirSync(path.join(cwd, '.agent', 'design-systems', 'second'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.agent', 'design-systems', 'second', 'DESIGN.md'), '# Second');

    const r = findLayer3(cwd);
    assert.equal(r.length, 2);
    // LIFO: 'second' was added after 'first', so it should be first
    assert.equal(r[0].id, 'second');
    assert.equal(r[1].id, 'first');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('findLayer3: missing DESIGN.md file is skipped', () => {
  const cwd = makeTmpCwd();
  try {
    addSystem(cwd, { id: 'no-file', license: 'A' });
    // Don't write DESIGN.md
    const r = findLayer3(cwd);
    assert.equal(r.length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('findLayer3: missing lockfile returns empty', () => {
  const cwd = makeTmpCwd();
  try {
    assert.equal(findLayer3(cwd).length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// -- findLayer4 (starter) ---------------------------------------------------

test('findLayer4: finds zh starter', () => {
  const tmp = makeTmpTemplateDir();
  try {
    const dir = path.join(tmp, 'zh', '.agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'DESIGN.md'), '# Starter');
    const r = findLayer4(tmp);
    assert.ok(r);
    assert.equal(r.layer, 4);
    assert.equal(r.kind, 'starter');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findLayer4: finds en starter when zh missing', () => {
  const tmp = makeTmpTemplateDir();
  try {
    const dir = path.join(tmp, 'en', '.agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'DESIGN.md'), '# Starter');
    const r = findLayer4(tmp);
    assert.ok(r);
    assert.equal(r.source, path.join(dir, 'DESIGN.md'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findLayer4: null when no starter found', () => {
  const tmp = makeTmpTemplateDir();
  try {
    assert.equal(findLayer4(tmp), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findLayer4: null when templateDir is null', () => {
  assert.equal(findLayer4(null), null);
  assert.equal(findLayer4(undefined), null);
});

// -- resolveCascade (full) --------------------------------------------------

test('resolveCascade: empty project — only starter layer 4', () => {
  const cwd = makeTmpCwd();
  const tmp = makeTmpTemplateDir();
  try {
    fs.mkdirSync(path.join(tmp, 'zh', '.agent'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'zh', '.agent', 'DESIGN.md'), '# Starter');
    const layers = resolveCascade({ cwd, templateDir: tmp });
    assert.equal(layers.length, 1);
    assert.equal(layers[0].layer, 4);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveCascade: 4 layers all present, in order', () => {
  const cwd = makeTmpCwd();
  const tmp = makeTmpTemplateDir();
  try {
    // Layer 1: project root
    fs.writeFileSync(path.join(cwd, 'DESIGN.md'), '# Project');
    // Layer 2: .agent/
    fs.mkdirSync(path.join(cwd, '.agent'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.agent', 'DESIGN.md'), '# Agent');
    // Layer 3: installed
    addSystem(cwd, { id: 'default', license: 'Apache-2.0' });
    fs.mkdirSync(path.join(cwd, '.agent', 'design-systems', 'default'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.agent', 'design-systems', 'default', 'DESIGN.md'), '# Default');
    // Layer 4: starter
    fs.mkdirSync(path.join(tmp, 'en', '.agent'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'en', '.agent', 'DESIGN.md'), '# Starter');

    const layers = resolveCascade({ cwd, templateDir: tmp });
    assert.equal(layers.length, 4);
    assert.equal(layers[0].layer, 1);
    assert.equal(layers[0].kind, 'user-override');
    assert.equal(layers[1].layer, 2);
    assert.equal(layers[1].kind, 'agent-context');
    assert.equal(layers[2].layer, 3);
    assert.equal(layers[2].kind, 'installed');
    assert.equal(layers[2].id, 'default');
    assert.equal(layers[3].layer, 4);
    assert.equal(layers[3].kind, 'starter');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveCascade: layer 1 wins (effective)', () => {
  const cwd = makeTmpCwd();
  const tmp = makeTmpTemplateDir();
  try {
    fs.writeFileSync(path.join(cwd, 'DESIGN.md'), '# Project');
    fs.mkdirSync(path.join(tmp, 'en', '.agent'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'en', '.agent', 'DESIGN.md'), '# Starter');

    const eff = effectiveDesign({ cwd, templateDir: tmp });
    assert.equal(eff.layer, 1);
    assert.equal(eff.kind, 'user-override');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveCascade: when no files, effective is null', () => {
  const cwd = makeTmpCwd();
  try {
    assert.equal(effectiveDesign({ cwd, templateDir: null }), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveCascade: layer 2 wins when layer 1 missing', () => {
  const cwd = makeTmpCwd();
  const tmp = makeTmpTemplateDir();
  try {
    fs.mkdirSync(path.join(cwd, '.agent'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.agent', 'DESIGN.md'), '# Agent');
    fs.mkdirSync(path.join(tmp, 'en', '.agent'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'en', '.agent', 'DESIGN.md'), '# Starter');

    const eff = effectiveDesign({ cwd, templateDir: tmp });
    assert.equal(eff.layer, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
