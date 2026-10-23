"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { runOne, runParallel, printResult, summarizeResults } = require("../../scripts/test-runner.cjs");

function fixture(t, body, name = "probe.test.js", dir) {
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-spawn-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

// Model Node's failed-spawn event, not a running test's exit or stderr text.
function failedSpawn(code, started = false) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  if (started) child.pid = 123;
  queueMicrotask(() => {
    if (started) child.emit("spawn");
    child.emit("error", Object.assign(new Error(`injected ${code}`), { code }));
    child.emit("close", -1, null);
  });
  return child;
}

const passBody = "require('node:test')('passes', () => { console.log('real child ran'); });";

test("ordinary assertion fails once even if a second invocation would pass", async (t) => {
  const file = fixture(t, `const fs=require('node:fs'),path=require('node:path');
    const counter=path.join(__dirname,'counter');
    const seen=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0;
    fs.writeFileSync(counter,String(seen+1));
    require('node:test')('first invocation fails',()=>require('node:assert/strict').equal(seen,1,'EAGAIN text is not a spawn event'));`);
  const [first] = await runParallel([file], 1, 10, true, 0, 0);
  assert.equal(first.ok, false);
  assert.equal(first.retried, false);
  assert.equal(first.attempts.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), "counter"), "utf8"), "1");
  // Separate diagnostic invocation proves the tempting second result cannot wash the first green.
  const second = await runOne(file, 10, 0, 0);
  assert.equal(second.ok, true);
  assert.deepEqual(summarizeResults([first]), { pass: 0, fail: 1, timeouts: 0, retryPassed: 0, retryFailed: 0 });
});

for (const code of ["EAGAIN", "ENOMEM", "EMFILE", "ENFILE"]) {
  test(`${code} before spawn retries once then executes a real test process`, async (t) => {
    const file = fixture(t, passBody);
    let calls = 0;
    const r = await runOne(file, 10, 0, 0, (...args) => ++calls === 1 ? failedSpawn(code) : spawn(...args));
    assert.equal(r.ok, true);
    assert.equal(calls, 2);
    assert.equal(r.attempts.length, 2);
    assert.equal(r.firstFailure.spawnError.code, code);
    assert.match(r.firstFailure.stderr, new RegExp(`injected ${code}`));
    assert.match(r.attempts[1].stdout, /real child ran/);
    assert.equal(summarizeResults([r]).retryPassed, 1);
    assert.equal(summarizeResults([r]).retryFailed, 0);
  });
}

test("persistent resource failure stops at three attempts with every diagnostic intact", async (t) => {
  const file = fixture(t, passBody);
  let calls = 0;
  const r = await runOne(file, 10, 0, 0, () => { calls++; return failedSpawn("EAGAIN"); });
  assert.equal(calls, 3);
  assert.equal(r.ok, false);
  assert.equal(r.attempts.length, 3);
  for (const a of r.attempts) assert.match(a.stderr, /injected EAGAIN/);
  assert.deepEqual(summarizeResults([r]), { pass: 0, fail: 1, timeouts: 0, retryPassed: 0, retryFailed: 1 });
});

for (const [code, started] of [["EACCES", false], ["UNKNOWN", false], ["ENOMEM", true]]) {
  test(`does not retry ${code}, started=${started}`, async (t) => {
    const file = fixture(t, passBody);
    let calls = 0;
    const r = await runOne(file, 10, 0, 0, () => { calls++; return failedSpawn(code, started); });
    assert.equal(calls, 1);
    assert.equal(r.ok, false);
    assert.equal(r.retried, false);
  });
}

test("real child timeout is never retried", async (t) => {
  const file = fixture(t, "setInterval(() => {}, 1000);");
  const r = await runOne(file, 0.2, 0, 0);
  assert.equal(r.ok, false);
  assert.equal(r.killed, true);
  assert.equal(r.attempts.length, 1);
  assert.equal(summarizeResults([r]).timeouts, 1);
});

test("one worker runs real child processes serially without overlap", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-serial-evidence-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "events.jsonl");
  const files = ["a", "b"].map(name => fixture(t, `
    const fs=require('node:fs');
    const record=(event)=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({name:${JSON.stringify(name)},event,pid:process.pid})+'\\n');
    require('node:test')('real workload',async()=>{
      record('start');
      // A timed workload exposes overlap; the parent awaits actual child completion.
      await new Promise(resolve=>setTimeout(resolve,50));
      record('end');
    });`, name + ".test.js", dir));
  const results = await runParallel(files, 1, 10, true, 0, 0);
  assert.equal(results.every(r => r.ok && r.attempts.length === 1), true);
  const events = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map(e => e.name + ":" + e.event), ["a:start", "a:end", "b:start", "b:end"]);
  assert.notEqual(events[0].pid, events[2].pid);
});

test("mixed summary distinguishes recovered spawns, exhausted spawns and assertion failures", async (t) => {
  const file = fixture(t, passBody);
  let calls = 0;
  const recovered = await runOne(file, 10, 0, 0, (...args) => ++calls === 1 ? failedSpawn("ENOMEM") : spawn(...args));
  const exhausted = await runOne(file, 10, 0, 0, () => failedSpawn("EAGAIN"));
  const broken = fixture(t, "require('node:test')('assertion',()=>require('node:assert/strict').fail('real assertion'));", "broken.test.js");
  const failure = await runOne(broken, 10, 0, 0);
  assert.deepEqual(summarizeResults([recovered, exhausted, failure]), { pass: 1, fail: 2, timeouts: 0, retryPassed: 1, retryFailed: 1 });
});


test("recovered retry output retains both attempts and both streams", async (t) => {
  const file = fixture(t, "require('node:test')('streams',()=>{console.log('final stdout');console.error('final stderr');});");
  let calls = 0;
  const r = await runOne(file, 10, 0, 0, (...args) => ++calls === 1 ? failedSpawn("EAGAIN") : spawn(...args));
  const lines = [];
  t.mock.method(console, "log", (...args) => lines.push(args.join(" ")));
  t.mock.method(console, "error", (...args) => lines.push(args.join(" ")));
  printResult(r, 1, 1);
  const output = lines.join("\n");
  for (const text of ["attempt 1", "attempt 2", "injected EAGAIN", "final stdout", "final stderr", "启动资源错误重试成功"]) assert.ok(output.includes(text), text);
  assert.equal(output.includes("独占"), false);
});

function cliFixture(t, bodies) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.copyFileSync(path.resolve(__dirname, '../../scripts/test-runner.cjs'), path.join(root, 'scripts/test-runner.cjs'));
  for (const [name, body] of Object.entries(bodies)) fs.writeFileSync(path.join(root, 'tests', name), body);
  return root;
}

function runCli(root, args = [], preload) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = require('node:child_process').spawnSync(process.execPath,
    [...(preload ? ['--require', preload] : []), 'scripts/test-runner.cjs', '--max-time', '10', ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
}

test('CLI --serial runs real files without overlap and counts each file', (t) => {
  const body = (name) => `const fs=require('node:fs'),path=require('node:path');
    require('node:test')('${name}',async()=>{
      const log=path.join(__dirname,'../events');
      fs.appendFileSync(log,'${name}:start:'+process.pid+'\\n');
      await new Promise(r=>setTimeout(r,80));
      fs.appendFileSync(log,'${name}:end:'+process.pid+'\\n');
    });`;
  const root = cliFixture(t, { 'a.test.js': body('a'), 'b.test.js': body('b') });
  const result = runCli(root, ['--serial', '--workers', '4']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /mode=serial workers=1/);
  assert.match(result.output, /2\/2 passed/);
  const events = fs.readFileSync(path.join(root, 'events'), 'utf8').trim().split('\n');
  assert.deepEqual(events.map(e => e.split(':').slice(0, 2).join(':')), ['a:start', 'a:end', 'b:start', 'b:end']);
  assert.notEqual(events[0].split(':')[2], events[2].split(':')[2]);
});

test('CLI serial preserves ordinary failure and accurate mixed counts', (t) => {
  const root = cliFixture(t, {
    'a.test.js': `const fs=require('node:fs'),path=require('node:path');const p=path.join(__dirname,'../counter');
      const n=fs.existsSync(p)?Number(fs.readFileSync(p)):0;fs.writeFileSync(p,String(n+1));
      require('node:test')('first fails',()=>require('node:assert/strict').equal(n,1));`,
    'b.test.js': passBody,
  });
  const result = runCli(root, ['--serial']);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /1\/2 passed.*1 FAILED/);
  assert.equal(fs.readFileSync(path.join(root, 'counter'), 'utf8'), '1');
});

for (const code of ['EAGAIN', 'UNKNOWN']) {
  test(`CLI single file records ${code} startup attempt and respects eligibility`, (t) => {
    const root = cliFixture(t, { 'probe.test.js': passBody });
    const preload = path.join(root, 'inject.cjs');
    fs.writeFileSync(preload, `const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
      const spawn=cp.spawn;let calls=0;
      cp.spawn=function(...args){fs.appendFileSync(path.join(__dirname,'attempts'),'attempt\\n');
        if(++calls>1)return spawn(...args);
        const c=new(require('node:events').EventEmitter)();
        c.stdout=new(require('node:stream').PassThrough)();c.stderr=new(require('node:stream').PassThrough)();c.kill=()=>{};
        queueMicrotask(()=>{c.emit('error',Object.assign(new Error('CLI injected ${code}'),{code:'${code}'}));c.emit('close',-1,null);});return c;};`);
    const result = runCli(root, ['--file', 'probe.test.js'], preload);
    assert.equal(result.status, code === 'EAGAIN' ? 0 : 1, result.output);
    assert.match(result.output, /workers=1/);
    assert.match(result.output, /attempt 1:/);
    assert.match(result.output, new RegExp(`CLI injected ${code}`));
    assert.equal(fs.readFileSync(path.join(root, 'attempts'), 'utf8').trim().split('\n').length, code === 'EAGAIN' ? 2 : 1);
    if (code === 'EAGAIN') {
      assert.match(result.output, /attempt 2:/);
      assert.match(result.output, /1\/1 passed/);
      assert.match(result.output, /real child ran/);
    } else assert.match(result.output, /0\/1 passed/);
  });
}

test('CLI single file honors idle timeout without retry', (t) => {
  const root = cliFixture(t, { 'probe.test.js': 'setTimeout(() => {}, 2000);' });
  const result = runCli(root, ['--file', 'probe.test.js', '--idle-timeout', '1', '--timeout', '5']);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /idle-timeout\(1s-no-stdout\)/);
  assert.match(result.output, /0\/1 passed/);
  assert.doesNotMatch(result.output, /attempt 2:/);
});

test('CLI single file passes per-test timeout to Node', (t) => {
  const root = cliFixture(t, { 'probe.test.js': `require('node:test')('slow',async(t)=>{
    let timer;t.after(()=>clearTimeout(timer));await new Promise(r=>{timer=setTimeout(r,2000)});
  });` });
  const result = runCli(root, ['--file', 'probe.test.js', '--per-test-timeout', '100', '--timeout', '5']);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /test timed out after 100ms/);
  assert.match(result.output, /0\/1 passed/);
  assert.doesNotMatch(result.output, /attempt 2:/);
});

for (const mode of ['serial', 'single', 'parallel']) {
  for (const tty of [false, true]) {
    test(`CLI ${mode} ${tty ? 'real PTY' : 'pipe'} preserves color and exit/count behavior`, (t) => {
      const root = cliFixture(t, {
        'a.test.js': passBody,
        ...(mode === 'single' ? {} : { 'b.test.js': passBody }),
      });
      const probe = path.join(root, 'tty-probe.cjs');
      fs.writeFileSync(probe, "console.log('TTY_PROBE:'+Boolean(process.stdout.isTTY));");
      const args = ['--require', probe, 'scripts/test-runner.cjs', '--max-time', '10',
        ...(mode === 'serial' ? ['--serial'] : mode === 'single' ? ['--file', 'a.test.js'] : ['--parallel', '--workers', '2'])];
      const env = { ...process.env, TERM: 'xterm' };
      delete env.NODE_TEST_CONTEXT;
      const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
      const command = tty ? 'script' : process.execPath;
      const commandArgs = !tty ? args : process.platform === 'darwin'
        ? ['-q', '/dev/null', process.execPath, ...args]
        : ['-q', '-e', '-c', [process.execPath, ...args].map(quote).join(' '), '/dev/null'];
      const invoke = () => {
        const result = require('node:child_process').spawnSync(command, commandArgs,
          { cwd: root, env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
        assert.ifError(result.error);
        return { ...result, output: result.stdout + result.stderr };
      };
      const passed = invoke();
      assert.equal(passed.status, 0, passed.output);
      assert.match(passed.output, new RegExp(`TTY_PROBE:${tty}`));
      assert.match(passed.output, mode === 'single' ? /1\/1 passed/ : /2\/2 passed/);
      if (tty) {
        assert.match(passed.output, /\x1b\[2m/);
        assert.match(passed.output, /\x1b\[32m/);
        assert.match(passed.output, /\x1b\[0m/);
      } else assert.doesNotMatch(passed.output, /\x1b\[/);
      fs.writeFileSync(path.join(root, 'tests/a.test.js'), "require('node:test')('fails',()=>require('node:assert/strict').fail('expected CLI failure'));");
      const failed = invoke();
      assert.equal(failed.status, 1, failed.output);
      assert.match(failed.output, mode === 'single' ? /0\/1 passed/ : /1\/2 passed/);
      assert.match(failed.output, /expected CLI failure/);
      if (tty) assert.match(failed.output, /\x1b\[31m/);
      else assert.doesNotMatch(failed.output, /\x1b\[/);
    });
  }
}
