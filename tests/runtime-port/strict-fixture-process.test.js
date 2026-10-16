'use strict';
// Mock-only process contracts, not a real canary or process-tree proof.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createStrictFixtureProcessRuntime: create } = require('../../lib/runtime-port/strict-fixture-process.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const code = (fn, expected) => assert.throws(fn,e => e && e.code === expected);
function proof(v,stage) {
  const out = {kind:'runtime_evidence',run_ref:v.run_ref,task_id:v.task_id,evidence_refs:['fixture-evidence:' + stage + ':' + v.task_id]};
  if (stage === 'effect') out.proposal_id = v.proposal_id; return out;
}
class FakeChild extends EventEmitter {
  constructor(pid) { super(); this.pid = pid; this.connected = true; this.sent = []; this.done = false; }
  send(value,callback) { this.sent.push(value); queueMicrotask(() => { if (callback) callback(null); }); }
  exit(exitCode = 0, signal = null) { if (this.done) return; this.done = true; this.connected = false; this.emit('exit',exitCode,signal); this.emit('disconnect'); }
  proposal(extra = {}) {
    const start = this.sent.find(v => v.type === 'start'); assert.ok(start,'fake child received start');
    this.emit('message',{type:'proposal',protocol:'cortex-l3-fixture/v1',run_id:start.run_id,task_id:start.task_id,proposal_id:'P-FIXTURE-' + start.task_id.slice(-1),...extra});
  }
}
function harness(t,overrides = {},mode = {}) {
  const cwd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'cortex-l3-fixture-'));
  const children = [], spawns = [], kills = [], starts = [], effects = [], stops = []; let controller;
  t.mock.method(cp,'spawn',(executable,args,options) => {
    spawns.push({executable,args,options}); if (mode.spawnThrow) throw new Error('PRIVATE_SPAWN_ERROR');
    const child = new FakeChild(mode.spawnError ? undefined : 41000 + children.length); children.push(child);
    setImmediate(() => { if (!child.done) child.emit(mode.spawnError ? 'error' : 'spawn',mode.spawnError ? new Error('PRIVATE_CHILD_ERROR') : undefined); });
    return child;
  });
  t.mock.method(process,'kill',(pid,signal) => {
    kills.push({pid,signal}); if (mode.killError) throw Object.assign(new Error('PRIVATE_KILL_ERROR'),{code:mode.killError});
    const child = children.find(c => -c.pid === pid); assert.ok(child,'only a fake negative process-group PID may be signalled');
    if (mode.autoExit !== false) queueMicrotask(() => child.exit(null,signal)); return true;
  });
  const options = {enabled:true,fixtureOnly:true,cwd,maxTaskMs:5000,maxTotalMs:10000,cancelGraceMs:5,
    onStart:v => { starts.push(v); v.assertActive(); return proof(v,'start'); },
    onBeforeSpawn:v => { v.assertActive(); return proof(v,'spawn'); },
    onBeforeSend:v => { v.assertActive(); return proof(v,'send'); },
    onProposal:v => { effects.push(v); v.assertActive(); return proof(v,'effect'); },
    onStop:v => { stops.push(v); return proof(v,'stop'); },...overrides};
  t.after(async () => {
    mode.autoExit = true; delete mode.killError;
    for (const child of children) if (!child.done) child.exit(null,'SIGKILL');
    if (controller) await controller.close();
    fs.rmSync(cwd,{recursive:true,force:true});
  });
  controller = create(options);
  return {controller,port:controller.port,options,mode,cwd,children,spawns,kills,starts,effects,stops};
}
async function running(h,task = 'T-FIXTURE-1') {
  const result = h.port.createRun({task_id:task}); await flush(); await flush();
  return {result,ref:result.run_ref,child:h.children.at(-1)};
}
async function completed(h,task = 'T-FIXTURE-1') {
  const run = await running(h,task); run.child.proposal(); run.child.exit();
  return { ...run,status:await h.port.wait(run.ref) };
}
test('strict fixture process: mock-only contracts',{skip:process.platform === 'win32',concurrency:false},async t => {
  await t.test('OFF has no fs inspection, spawn, callback, or inherited capability',async st => {
    st.mock.method(fs,'realpathSync',() => { throw new Error('unexpected filesystem access'); });
    st.mock.method(cp,'spawn',() => { throw new Error('unexpected spawn'); });
    const c = create({onBeforeSend:() => assert.fail('OFF must not call send gate')}); assert.equal(c.port.health().ready,false); code(() => c.port.createRun({task_id:'T-FIXTURE-1'}),'ERR_FIXTURE_DISABLED');
    code(() => c.port.send('anything'),'ERR_RUNTIME_CAPABILITY_UNSUPPORTED'); const p = c.close(); assert.equal(c.close(),p); assert.equal((await p).process_tree_verified,false);
  });
  await t.test('factory rejects configuration widening and invalid locations',async st => {
    const h = harness(st); for (const [change,expected] of [
      [{env:{PATH:'/bad'}},'ERR_FIXTURE_OPTIONS_INVALID'],[{fixtureOnly:false},'ERR_FIXTURE_ONLY_REQUIRED'],
      [{cwd:'relative'},'ERR_FIXTURE_CWD_REQUIRED'],[{cwd:os.tmpdir()},'ERR_FIXTURE_CWD_OUTSIDE_TEMP_ROOT'],
      [{maxTaskMs:10001},'ERR_FIXTURE_TASK_BUDGET'],[{maxTotalMs:60001},'ERR_FIXTURE_TOTAL_BUDGET'],
      [{cancelGraceMs:2001},'ERR_FIXTURE_CANCEL_GRACE'],[{onStop:null},'ERR_FIXTURE_CALLBACK_REQUIRED'],
      [{onBeforeSend:null},'ERR_FIXTURE_CALLBACK_REQUIRED']
    ]) code(() => create({...h.options,...change}),expected); assert.equal(h.spawns.length,0);
    const original = fs.lstatSync;
    const lstatMock = st.mock.method(fs,'lstatSync',p => p === path.resolve(h.cwd) ? {isSymbolicLink:() => true} : original(p));
    try { code(() => create(h.options),'ERR_FIXTURE_CWD_OUTSIDE_TEMP_ROOT'); }
    finally { lstatMock.mock.restore(); }
  });
  await t.test('payload cannot contain paths, bodies, code, commands, or callbacks',async st => {
    const h = harness(st); for (const extra of [{path:'/tmp/a'},{body:'x'},{code:'x'},{shell:true},{onProposal:() => true}]) code(() => h.port.createRun({task_id:'T-FIXTURE-1',...extra}),'ERR_FIXTURE_TASK_INVALID');
    code(() => h.port.createRun({task_id:'T-REAL-1'}),'ERR_FIXTURE_TASK_INVALID'); assert.equal(h.spawns.length,0);
  });
  await t.test('run_ref registered before deferred spawn; fixed invocation; runtime evidence only',async st => {
    const h = harness(st); const accepted = h.port.createRun({task_id:'T-FIXTURE-1'}); assert.equal(accepted.accepted,true); assert.equal(h.spawns.length,0); assert.equal(h.starts.length,1);
    assert.equal(h.port.getStatus(accepted.run_ref).status,'accepted'); code(() => h.port.createRun({task_id:'T-FIXTURE-2'}),'ERR_FIXTURE_PARALLEL_LIMIT');
    await flush(); await flush(); const child = h.children[0], call = h.spawns[0]; assert.equal(call.executable,process.execPath);
    assert.deepEqual(call.args,[fs.realpathSync(path.resolve(__dirname,'../fixtures/l3/strict-process-worker.cjs'))]);
    assert.deepEqual(call.options.env,{LANG:'C',LC_ALL:'C',TZ:'UTC'}); assert.deepEqual(call.options.stdio,['ignore','ignore','ignore','ipc']);
    assert.equal(call.options.detached,true); assert.equal(call.options.shell,false); child.proposal(); assert.equal(h.effects.length,1);
    assert.deepEqual(h.effects[0].proposal,{kind:'fixture.record',task_id:'T-FIXTURE-1'}); assert.equal(h.effects[0].assertActive(),undefined); child.exit();
    const result = await h.port.wait(accepted.run_ref); assert.equal(result.status,'exited'); assert.equal(result.task_completion_asserted,false); assert.equal(result.process_tree_verified,false);
    assert.equal(result.runtime_outcome,'EVIDENCE_RECORDED'); assert.equal(h.stops.length,1); assert.equal(h.stops[0].status,'exited');
    assert.deepEqual(Object.keys(result.start_evidence).sort(),['evidence_refs','kind','run_ref','task_id']);
    assert.deepEqual(Object.keys(result.stop_evidence).sort(),['evidence_refs','kind','run_ref','task_id']);
    code(() => h.port.createRun({task_id:'T-FIXTURE-1'}),'ERR_FIXTURE_ATTEMPT_LIMIT');
  });
  await t.test('factory captures callbacks; later options mutation cannot replace them',async st => {
    const h = harness(st); h.options.onStart = () => false; h.options.onBeforeSpawn = () => false; h.options.onBeforeSend = () => false; h.options.onProposal = () => false; h.options.onStop = () => false;
    assert.equal((await completed(h)).status.status,'exited'); assert.equal(h.effects.length,1); assert.equal(h.stops.length,1);
  });
  await t.test('three mocked identities maximum; no actual worker or canary',async st => {
    const h = harness(st); for (const task of ['T-FIXTURE-1','T-FIXTURE-2','T-FIXTURE-3']) assert.equal((await completed(h,task)).status.status,'exited');
    assert.equal(h.spawns.length,3); code(() => h.port.createRun({task_id:'T-FIXTURE-3'}),'ERR_FIXTURE_ATTEMPT_LIMIT'); code(() => h.port.createRun({task_id:'T-FIXTURE-4'}),'ERR_FIXTURE_TASK_INVALID');
  });
  for (const [label,fn] of [['throw',() => { throw new Error('PRIVATE_CALLBACK'); }],['boolean',() => true],['thenable',() => ({then() { throw new Error('must not be invoked'); }})],['wrong identity',v => ({...proof(v,'start'),run_ref:'run:wrong'})]]) {
    await t.test('onStart ' + label + ': UNKNOWN, no spawn, no automatic retry',async st => {
      const h = harness(st,{onStart:fn}); const accepted = h.port.createRun({task_id:'T-FIXTURE-1'}); assert.equal(accepted.status,'UNKNOWN'); await flush(); assert.equal(h.spawns.length,0);
      const result = h.port.getStatus(accepted.run_ref); assert.equal(result.spawned,false); assert.equal(h.stops.length,1); assert.equal(JSON.stringify(result).includes('PRIVATE_CALLBACK'),false);
      code(() => h.port.createRun({task_id:'T-FIXTURE-2'}),'ERR_FIXTURE_QUARANTINED');
    });
  }
  for (const [label,fn] of [['throw',() => { throw new Error('PRIVATE_CALLBACK'); }],['boolean',() => true],['promise',() => Promise.reject(new Error('PRIVATE_PROMISE'))],['wrong receipt',v => ({...proof(v,'effect'),proposal_id:'P-WRONG'})]]) {
    await t.test('onProposal ' + label + ': close admission and ignore late IPC',async st => {
      let entered = 0, guard; const h = harness(st,{onProposal:v => { entered++; guard = v.assertActive; return fn(v); }}); const r = await running(h); r.child.proposal();
      const result = await h.port.wait(r.ref); assert.equal(result.status,'UNKNOWN'); code(guard,'ERR_FIXTURE_EFFECT_ADMISSION_CLOSED'); r.child.proposal(); assert.equal(entered,1);
      assert.equal(h.stops.length,1); code(() => h.port.createRun({task_id:'T-FIXTURE-2'}),'ERR_FIXTURE_QUARANTINED');
    });
  }
  await t.test('canonical revoke denial performs no sink; later proposals never reenter',async st => {
    let revoked = false, entries = 0, sinkWrites = 0; const h = harness(st,{onProposal:v => { entries++; if (revoked) throw new Error('fixture authority revoked'); v.assertActive(); sinkWrites++; return proof(v,'effect'); }});
    const r = await running(h); revoked = true; r.child.proposal(); assert.equal((await h.port.wait(r.ref)).status,'UNKNOWN'); r.child.proposal(); assert.equal(entries,1); assert.equal(sinkWrites,0);
  });
  for (const extra of [{path:'/not-allowed'},{task_id:'T-FIXTURE-2'},{type:'completed'}]) await t.test('unknown IPC fails closed',async st => {
    const h = harness(st); const r = await running(h); r.child.proposal(extra); assert.equal((await h.port.wait(r.ref)).status,'UNKNOWN'); r.child.proposal(); assert.equal(h.effects.length,0);
  });
  await t.test('duplicate proposal cannot repeat the effect',async st => {
    const h = harness(st); const r = await running(h); r.child.proposal(); r.child.proposal(); assert.equal((await h.port.wait(r.ref)).status,'UNKNOWN'); assert.equal(h.effects.length,1);
  });
  for (const [exitCode,signal] of [[0,null],[1,null],[null,'SIGSEGV']]) await t.test('leader exits before evidence: UNKNOWN and late IPC ignored',async st => {
    const h = harness(st); const r = await running(h); r.child.exit(exitCode,signal); const result = await h.port.wait(r.ref); assert.equal(result.status,'UNKNOWN'); assert.equal(result.process_exited,true); assert.equal(result.process_tree_verified,false);
    r.child.proposal(); assert.equal(h.effects.length,0); assert.equal(h.stops.length,1);
  });
  await t.test('cancel before deferred spawn never creates a process',async st => {
    const h = harness(st); const r = h.port.createRun({task_id:'T-FIXTURE-1'}); const canceled = h.port.cancel(r.run_ref); assert.equal(canceled.status,'canceled'); await flush(); assert.equal(h.spawns.length,0); assert.equal(h.stops.length,1);
    code(h.starts[0].assertActive,'ERR_FIXTURE_EFFECT_ADMISSION_CLOSED');
  });
  await t.test('cancel closes effects before TERM and waits for actual leader exit',async st => {
    const h = harness(st,{}, {autoExit:false}); const r = await running(h); const answer = h.port.cancel(r.ref); assert.equal(answer.status,'stopping'); assert.equal(answer.cancelled,false);
    assert.deepEqual(h.kills[0],{pid:-r.child.pid,signal:'SIGTERM'}); code(h.starts[0].assertActive,'ERR_FIXTURE_EFFECT_ADMISSION_CLOSED'); r.child.proposal(); assert.equal(h.effects.length,0); assert.equal(h.stops.length,0);
    r.child.exit(null,'SIGTERM'); const result = await h.port.wait(r.ref); assert.equal(result.status,'canceled'); assert.equal(result.process_tree_verified,false); r.child.proposal(); assert.equal(h.effects.length,0);
  });
  await t.test('KILL escalation is a signal observation, not tree proof',async st => {
    const h = harness(st,{cancelGraceMs:0},{autoExit:false}); const r = await running(h); h.port.cancel(r.ref); await sleep(10); assert.ok(h.kills.some(k => k.pid === -r.child.pid && k.signal === 'SIGKILL'));
    assert.equal(h.port.getStatus(r.ref).status,'stopping'); assert.equal(h.stops.length,0); r.child.exit(null,'SIGKILL'); assert.equal((await h.port.wait(r.ref)).status,'canceled');
  });
  await t.test('ESRCH/no observed exit stays UNKNOWN; late exit cannot become success',async st => {
    const h = harness(st,{cancelGraceMs:0},{autoExit:false,killError:'ESRCH'}); const r = await running(h); h.port.cancel(r.ref);
    const result = await h.port.wait(r.ref,{timeout_ms:2500}); assert.equal(result.status,'UNKNOWN'); assert.equal(result.process_exited,false); assert.equal(result.wait_timed_out,false);
    const closed = await h.controller.close(); assert.equal(closed.all_workers_exited,false); assert.equal(closed.process_tree_verified,false); r.child.exit(null,'SIGKILL');
    assert.equal(h.port.getStatus(r.ref).status,'UNKNOWN'); assert.equal(h.port.getStatus(r.ref).process_exited,true); r.child.proposal(); assert.equal(h.effects.length,0);
  });
  await t.test('task timeout stops effects and ignores late proposals',async st => {
    const h = harness(st,{maxTaskMs:75,maxTotalMs:1000}); const r = await running(h); const result = await h.port.wait(r.ref); assert.equal(result.status,'timed_out');
    assert.equal(result.process_exited,true); r.child.proposal(); assert.equal(h.effects.length,0); code(h.starts[0].assertActive,'ERR_FIXTURE_EFFECT_ADMISSION_CLOSED');
  });
  await t.test('total deadline also covers idle gaps between accepted runs',async st => {
    const h = harness(st,{maxTaskMs:1000,maxTotalMs:150}); assert.equal((await completed(h)).status.status,'exited'); await sleep(180);
    code(() => h.port.createRun({task_id:'T-FIXTURE-2'}),'ERR_FIXTURE_TOTAL_DEADLINE'); assert.equal(h.spawns.length,1);
  });
  await t.test('wait observation timeout does not cancel the run',async st => {
    const h = harness(st); const r = await running(h); const result = await h.port.wait(r.ref,{timeout_ms:0}); assert.equal(result.wait_timed_out,true); assert.equal(result.status,'running'); assert.equal(h.kills.length,0);
  });
  for (const [label,fn] of [['throw',() => { throw new Error('PRIVATE_STOP'); }],['promise',() => Promise.resolve(true)],['boolean',() => true]]) await t.test('onStop ' + label + ': UNKNOWN cannot resume',async st => {
    let stops = 0; const h = harness(st,{onStop:v => { stops++; return fn(v); }}); const r = await completed(h); assert.equal(r.status.status,'UNKNOWN');
    r.child.proposal(); assert.equal(h.effects.length,1); assert.equal(stops,1); code(() => h.port.createRun({task_id:'T-FIXTURE-2'}),'ERR_FIXTURE_QUARANTINED'); await h.controller.close(); assert.equal(stops,1);
  });
  await t.test('close is idempotent and awaits observed worker exit',async st => {
    const h = harness(st,{}, {autoExit:false}); const r = await running(h); const p = h.controller.close(); assert.equal(h.controller.close(),p); let resolved = false; p.then(() => { resolved = true; }); await flush(); assert.equal(resolved,false);
    r.child.proposal(); assert.equal(h.effects.length,0); r.child.exit(null,'SIGTERM'); const result = await p; assert.equal(result.all_workers_exited,true); assert.equal(result.process_tree_verified,false);
    code(() => h.port.createRun({task_id:'T-FIXTURE-2'}),'ERR_FIXTURE_CLOSED');
  });
  for (const mode of [{spawnThrow:true},{spawnError:true}]) await t.test('spawn failure has a registered UNKNOWN run and sanitized errors',async st => {
    const h = harness(st,{},mode); const r = h.port.createRun({task_id:'T-FIXTURE-1'}); await flush(); await flush(); const result = await h.port.wait(r.run_ref);
    assert.equal(result.status,'UNKNOWN'); assert.equal(h.stops.length,1); assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
  });
  await t.test('synchronous cancellation during onStart never schedules spawn',async st => {
    let h;
    h = harness(st,{onStart:v => { h.port.cancel(v.run_ref); return proof(v,'start'); }});
    const accepted = h.port.createRun({task_id:'T-FIXTURE-1'});
    assert.equal(accepted.status,'canceled'); await flush(); assert.equal(h.spawns.length,0);
    assert.equal(h.stops.length,1);
  });
  await t.test('callback failure after synchronous cancellation stays UNKNOWN',async st => {
    let h;
    h = harness(st,{onStart:v => { h.port.cancel(v.run_ref); return false; }});
    const accepted = h.port.createRun({task_id:'T-FIXTURE-1'});
    assert.equal(accepted.status,'UNKNOWN'); await flush(); assert.equal(h.spawns.length,0);
    assert.equal(h.stops.length,1); assert.equal(h.port.health().quarantined,true);
  });
  await t.test('onStop may reenter close without recursive stop or extra callback',async st => {
    let h, nested, stops = 0;
    h = harness(st,{onStop:v => { stops++; nested = h.controller.close(); return proof(v,'stop'); }});
    h.port.createRun({task_id:'T-FIXTURE-1'});
    const outer = h.controller.close();
    assert.equal(outer,nested); assert.equal((await outer).all_workers_exited,true);
    assert.equal(stops,1); await flush(); assert.equal(h.spawns.length,0);
  });

  await t.test('latest authority denial at pre-spawn gate prevents child creation',async st => {
    const h = harness(st,{onBeforeSpawn:() => { throw new Error('fixture revoked after createRun'); }});
    const accepted = h.port.createRun({task_id:'T-FIXTURE-1'});
    assert.equal(accepted.status,'accepted');
    await flush();
    assert.equal(h.spawns.length,0);
    assert.equal(h.port.getStatus(accepted.run_ref).status,'UNKNOWN');
    assert.equal(h.stops.length,1);
  });

  await t.test('a pre-spawn callback that exhausts its deadline still cannot spawn',async st => {
    let entered = 0;
    const h = harness(st,{maxTaskMs:1000,maxTotalMs:5000,onBeforeSpawn:v => {
      entered++;
      const until = require('node:perf_hooks').performance.now() + 1100;
      while (require('node:perf_hooks').performance.now() < until) { /* bounded synchronous mock */ }
      return proof(v,'spawn');
    }});
    const accepted = h.port.createRun({task_id:'T-FIXTURE-1'}); await flush();
    assert.equal(entered,1); assert.equal(h.spawns.length,0);
    assert.equal(h.port.getStatus(accepted.run_ref).status,'UNKNOWN');
  });

  await t.test('send gate receives only internal message types and bound run identity',async st => {
    const seen = [];
    const h = harness(st,{onBeforeSend:v => {
      assert.ok(Object.isFrozen(v)); v.assertActive();
      assert.deepEqual(Object.keys(v).sort(),['assertActive','message_type','run_ref','signal','task_id']);
      seen.push({type:v.message_type,run_ref:v.run_ref,task_id:v.task_id}); return proof(v,'send');
    }});
    const r = await completed(h);
    assert.deepEqual(seen,[{type:'start',run_ref:r.ref,task_id:'T-FIXTURE-1'},{type:'proposal_result',run_ref:r.ref,task_id:'T-FIXTURE-1'}]);
    assert.equal(r.status.status,'exited');
  });
  for (const [label,gate] of [
    ['throw',() => { throw new Error('PRIVATE_SEND_GATE'); }],
    ['thenable',() => ({then() { throw new Error('thenable must never run'); }})],
    ['boolean',() => true],
    ['bad receipt',v => ({...proof(v,'send'),run_ref:'run:wrong'})],
  ]) await t.test('send gate ' + label + ' rejects start before IPC and still permits stop',async st => {
    const h = harness(st,{onBeforeSend:gate}); const r = await running(h);
    assert.deepEqual(r.child.sent,[]); assert.equal(h.effects.length,0);
    const result = await h.port.wait(r.ref);
    assert.equal(result.status,'UNKNOWN'); assert.equal(result.process_exited,true);
    assert.ok(result.reason_codes.includes('send_admission_failed'));
    assert.ok(h.kills.some(k => k.signal === 'SIGTERM')); assert.equal(h.stops.length,1);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
  });
  await t.test('send gate exceeding the deadline cannot send start',async st => {
    let entered = 0;
    const h = harness(st,{maxTaskMs:1000,maxTotalMs:5000,onBeforeSend:v => {
      entered++;
      const until = require('node:perf_hooks').performance.now() + 1100;
      while (require('node:perf_hooks').performance.now() < until) { /* bounded synchronous mock */ }
      return proof(v,'send');
    }});
    const r = await running(h);
    assert.equal(entered,1); assert.deepEqual(r.child.sent,[]);
    assert.equal((await h.port.wait(r.ref)).status,'UNKNOWN'); assert.equal(h.effects.length,0);
  });
  await t.test('denied receipt acknowledgement keeps recorded mock effect evidence and UNKNOWN',async st => {
    const h = harness(st,{onBeforeSend:v => {
      if (v.message_type === 'proposal_result') throw new Error('fixture revoked before acknowledgement');
      return proof(v,'send');
    }});
    const r = await completed(h);
    assert.deepEqual(r.child.sent.map(v => v.type),['start']);
    assert.equal(h.effects.length,1); assert.ok(r.status.runtime_evidence);
    assert.equal(r.status.runtime_outcome,'UNKNOWN'); assert.equal(r.status.status,'UNKNOWN');
    assert.ok(r.status.reason_codes.includes('send_admission_failed'));
  });
  await t.test('synchronous cancel inside send gate yields zero IPC but can signal the worker',async st => {
    let h;
    h = harness(st,{onBeforeSend:v => { h.port.cancel(v.run_ref); return proof(v,'send'); }});
    const r = await running(h); assert.deepEqual(r.child.sent,[]);
    assert.ok(h.kills.some(k => k.signal === 'SIGTERM')); assert.equal(h.effects.length,0);
    assert.equal((await h.port.wait(r.ref)).status,'UNKNOWN'); assert.equal(h.stops.length,1);
  });
  await t.test('synchronous close inside send gate yields zero IPC and bounded stop',async st => {
    let h, closing;
    h = harness(st,{onBeforeSend:v => { closing = h.controller.close(); return proof(v,'send'); }});
    const r = await running(h); assert.deepEqual(r.child.sent,[]);
    assert.equal(closing,h.controller.close()); assert.equal((await closing).all_workers_exited,true);
    assert.ok(h.kills.some(k => k.signal === 'SIGTERM')); assert.equal(h.effects.length,0);
    assert.equal(h.port.getStatus(r.ref).status,'UNKNOWN'); assert.equal(h.stops.length,1);
  });

});
