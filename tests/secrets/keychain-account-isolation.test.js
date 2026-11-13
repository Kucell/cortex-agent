'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const backend = path.join(root, 'templates/_shared/.agent/skills/secrets/scripts/backends/keychain.sh');

test('Keychain operations isolate accounts and preserve an entry on failure', () => {
  const dir = path.join(root, '.agent/runtime');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, 'keychain-test-'));
  try {
    fs.writeFileSync(path.join(tmp, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
    fs.writeFileSync(path.join(tmp, 'security'), `#!/usr/bin/env node
const fs=require('fs'); const p=process.env.MOCK_DB; let d=fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):{};
const a=process.argv.slice(2); if(!a.includes('-s')||!a.includes('-a'))process.exit(1);
const k=JSON.stringify([a[a.indexOf('-s')+1],a[a.indexOf('-a')+1]]);
if(process.env.MOCK_FAIL==='1' && a[0]==='add-generic-password')process.exit(1);
if(process.env.MOCK_FAIL==='2' && a[0]==='delete-generic-password')process.exit(1);
if(a[0]==='add-generic-password'){if(!a.includes('-U'))process.exit(1);d[k]=a[a.indexOf('-w')+1];fs.writeFileSync(p,JSON.stringify(d));}
else if(a[0]==='find-generic-password'){if(!(k in d))process.exit(44);console.log(d[k]);}
else if(a[0]==='delete-generic-password'){if(!(k in d))process.exit(44);delete d[k];fs.writeFileSync(p,JSON.stringify(d));}
`, { mode: 0o755 });
    function run(action, account, value, failing = false) {
      const payload = { action, ref: 'example', service: 'shared', account, value };
      const result = spawnSync(backend, [JSON.stringify(payload)], { encoding: 'utf8', env: { ...process.env, PATH: tmp + path.delimiter + process.env.PATH, MOCK_DB: path.join(tmp, 'db'), MOCK_FAIL: failing ? (action === 'delete' ? '2' : '1') : '0' } });
      return { status: result.status, body: JSON.parse(result.stdout) };
    }
    assert.equal(run('store', 'A', 'first').status, 0);
    assert.equal(run('store', 'B', 'second').status, 0);
    assert.equal(run('get', 'A').body.value, 'first');
    assert.notEqual(run('store', 'A', 'changed', true).status, 0);
    assert.equal(run('get', 'A').body.value, 'first');
    assert.notEqual(run('delete', 'B', undefined, true).status, 0);
    assert.equal(run('rotate', 'A').status, 0);
    assert.equal(run('get', 'A').body.error, 'not_found');
    assert.equal(run('get', 'B').body.value, 'second');
    assert.notEqual(run('store', undefined, 'x').status, 0);
    assert.equal(run('store', '引号"', '值"\\测试').status, 0);
    assert.equal(run('get', '引号"').body.value, '值"\\测试');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('upgrade replaces the published old backend but preserves a modified backend', () => {
  const sm = require('../../lib/script/manifest.js');
  const dir = path.join(root, '.agent/runtime');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, 'keychain-upgrade-test-'));
  const rel = 'skills/secrets/scripts/backends/keychain.sh';
  const dest = path.join(tmp, '.agent', rel);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures/keychain-service-only.sh'), dest);
    const index = path.join(tmp, '.agent/skills/secrets/scripts/index.js');
    fs.copyFileSync(path.join(__dirname, 'fixtures/secrets-index-service-override.js'), index);
    const args = { cwd: tmp, templateDir: path.join(root, 'templates/en'), lang: 'en', apply: true };
    const first = sm.reconcileScripts(args);
    assert.ok(first.applied.includes('skills/secrets/scripts/index.js'));
    assert.ok(first.applied.includes(rel));
    assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(backend));
    fs.writeFileSync(dest, '# user customization\n');
    assert.ok(!sm.reconcileScripts(args).applied.includes(rel));
    assert.equal(fs.readFileSync(dest, 'utf8'), '# user customization\n');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});


test('custom entry point prevents updating the dependent Keychain backend', () => {
  const sm = require('../../lib/script/manifest.js');
  const dir = path.join(root, '.agent/runtime'); fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, 'keychain-custom-test-'));
  try {
    const rel = 'skills/secrets/scripts/backends/keychain.sh';
    const dest = path.join(tmp, '.agent', rel); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures/keychain-service-only.sh'), dest);
    fs.writeFileSync(path.join(tmp, '.agent/skills/secrets/scripts/index.js'), '// custom entry point\n');
    const result = sm.reconcileScripts({ cwd: tmp, templateDir: path.join(root, 'templates/en'), lang: 'en', apply: true });
    assert.ok(result.skipped.some(x => x.path === rel && x.reason === 'secrets_entrypoint_not_updated'));
    assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(path.join(__dirname, 'fixtures/keychain-service-only.sh')));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('ambiguous account configuration is rejected before invoking a backend', () => {
  const dir = path.join(root, '.agent/runtime'); fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, 'keychain-config-test-'));
  try {
    const source = path.join(root, 'templates/_shared/.agent/skills/secrets/scripts');
    const scripts = path.join(tmp, '.agent/skills/secrets/scripts');
    fs.mkdirSync(path.join(scripts, 'backends'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.agent/config'), { recursive: true });
    for (const f of ['index.js', 'redact.js']) fs.copyFileSync(path.join(source, f), path.join(scripts, f));
    const sentinel = path.join(tmp, 'backend-was-invoked');
    fs.writeFileSync(path.join(scripts, 'backends/keychain.sh'), `#!/bin/sh\nprintf '%s' "$1" > '${sentinel}'\n`, { mode: 0o755 });
    for (const account of ['"ops#prod"', 'ops#prod', "'ops''prod'", "'incomplete"]) {
      fs.writeFileSync(path.join(tmp, '.agent/config/secrets.yml'), `default_backend: keychain\nsecrets:\n  - ref: demo\n    service: shared\n    account: ${account}\n`);
      const result = spawnSync(process.execPath, [path.join(scripts, 'index.js'), 'delete', '--ref', 'demo', '--gate', 'user'], { cwd: tmp, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.equal(JSON.parse(result.stdout).error, 'unsupported_identity_scalar');
      assert.equal(fs.existsSync(sentinel), false);
    }
    fs.writeFileSync(path.join(tmp, '.agent/config/secrets.yml'), `default_backend: keychain\nsecrets:\n  - ref: demo\n    service: shared\n    account: ops'\n`);
    spawnSync(process.execPath, [path.join(scripts, 'index.js'), 'delete', '--ref', 'demo', '--gate', 'user'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(JSON.parse(fs.readFileSync(sentinel, 'utf8')).account, "ops'");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('known-bad versions are replaced even with an unverified legacy ledger', () => {
  const sm = require('../../lib/script/manifest.js');
  const crypto = require('node:crypto');
  const dir = path.join(root, '.agent/runtime'); fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, 'keychain-legacy-test-'));
  try {
    const rel = 'skills/secrets/scripts/backends/keychain.sh';
    const entry = 'skills/secrets/scripts/index.js';
    const files = [[rel, 'keychain-service-only.sh'], [entry, 'secrets-index-service-override.js']];
    const ledger = { schema_version: 1, scripts: {} };
    for (const [name, fixture] of files) {
      const dest = path.join(tmp, '.agent', name); fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(__dirname, 'fixtures', fixture), dest);
      ledger.scripts[name] = { origin_hash: crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex') };
    }
    fs.writeFileSync(path.join(tmp, '.agent/.script-manifest.json'), JSON.stringify(ledger));
    const result = sm.reconcileScripts({ cwd: tmp, templateDir: path.join(root, 'templates/en'), lang: 'en', apply: true });
    assert.ok(result.applied.includes(entry)); assert.ok(result.applied.includes(rel));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
