"use strict";

// All writers, gates, port IDs and reviewers are SYNTHETIC. Only the local Git
// batch/CAS is actual. No network, Host, remote ref, auth file or real repository.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), cp = require("node:child_process");
const { createGitTransactionStore, GIT_TRANSACTION_REF } = require("../../lib/governance/git-transaction-store");
const { createInertAdmissionPrototype, INERT_KEYS:K } = require("../../lib/runtime-state/runtime-admission");
const { json,digest,parse } = require("../../lib/governance/canonical-records");
const envRecord = (kind,fields) => ({schema_version:1,kind:"inert-"+kind+"-v1",effect_authority:false,...fields});
const req = () => ({operation_id:"OP-fixture",attempt_nonce:"a".repeat(32),task_id:"T-fixture"});
function fixture(t) {
  const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"cortex-strict-entry-")),repo=path.join(base,"repo.git"),template=path.join(base,"empty-template");
  fs.mkdirSync(template); const git=fs.realpathSync("/usr/bin/git"),original=cp.spawnSync;
  const allowed=new Set(["init","cat-file","ls-tree","hash-object","mktree","commit-tree","update-ref","merge-base"]);
  const wrapped=(file,args,options)=>{
    assert.equal(file,git);assert.equal(options.shell,false);assert.ok(options.cwd===base||options.cwd===repo);
    assert.equal(args.filter(x=>allowed.has(x)).length,1);assert.ok(args.includes("core.hooksPath=/dev/null"));
    return original(file,args,{...options,env:{...options.env,GIT_ALLOW_PROTOCOL:"file",GIT_PROTOCOL_FROM_USER:"0"}});
  };cp.spawnSync=wrapped;
  let closed=false;const close=()=>{if(closed)return;closed=true;cp.spawnSync=original;fs.rmSync(base,{recursive:true,force:true});assert.equal(fs.existsSync(base),false);};t.after(close);
  const env={PATH:"/usr/bin:/bin",HOME:base,XDG_CONFIG_HOME:base,LANG:"C",LC_ALL:"C",TZ:"UTC",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_SYSTEM:"/dev/null",GIT_CONFIG_GLOBAL:"/dev/null"};
  const init=cp.spawnSync(git,["-c","core.hooksPath=/dev/null","init","--bare","--object-format=sha1","--initial-branch=unused","--template="+template,repo],{cwd:base,env,shell:false,encoding:"utf8",timeout:2000,maxBuffer:1048576});
  assert.equal(init.status,0,init.stderr);
  const open=()=>createGitTransactionStore({repo,ref:GIT_TRANSACTION_REF,gitExecutable:git}),store=open();
  const writer=envRecord("writer-fixture",{project_id:"project-fixture",writer_id:"synthetic:writer",instance_id:"synthetic:instance",repository_id:"fixture-repo",workflow_path:"fixture/control.yml",workflow_sha:"c".repeat(40),run_id:"synthetic:control-run",run_attempt:1,owner_generation:1,writer_generation:1});
  const dependency=envRecord("dependency",{task_id:"T-prerequisite",status:"completed",test_ref:"synthetic:test-proof",review_ref:"synthetic:review-proof"});
  const task=envRecord("task",{task_id:"T-fixture",status:"ready",input:{fixture_value:"fixture"},dependency_id:dependency.task_id,dependency_digest:digest(json(dependency))});
  const scope=envRecord("scope",{project_id:writer.project_id,task_id:task.task_id,task_digest:digest(json(task)),owner_generation:1,writer_generation:1,units:3,valid_from:"2020-01-01T00:00:00.000Z",expires_at:"2099-01-01T00:00:00.000Z",action:"synthetic"});
  const records={project:envRecord("project",{project_id:writer.project_id,repository_id:writer.repository_id,status:"active"}),owner:envRecord("owner",{subject_id:"synthetic:human",generation:1,status:"active"}),
    writer:envRecord("writer",{writer_id:writer.writer_id,instance_id:writer.instance_id,run_id:writer.run_id,run_attempt:writer.run_attempt,generation:1,owner_generation:1,repository_id:writer.repository_id,workflow_path:writer.workflow_path,workflow_sha:writer.workflow_sha,status:"active"}),
    decision:envRecord("decision",{decision_id:"D-runtime",scope_digest:digest(json(scope)),approver_id:"synthetic:human",owner_generation:1,status:"approved"}),
    waitpoint:envRecord("waitpoint",{waitpoint_id:"WP-runtime",decision_id:"D-runtime",scope_digest:digest(json(scope)),released_by:"synthetic:owning-workflow",status:"released"}),scope,task,dependency,
    budget:envRecord("budget",{limit:3,held:0,spent:0}),lease:envRecord("lease",{fence:0,operation_id:null,attempt_nonce:null,instance_id:null,status:"idle"}),journal:envRecord("journal",{events:[]})};
  const seeded=store.prepareBatch({expected_revision:null,transaction_id:"fixture-seed",writes:Object.entries(records).map(([name,v])=>({key:K[name],content:json(v)}))});
  assert.equal(store.publishPrepared(seeded.handle).status,"PUBLISHED");
  // Cache assertion reads only while the actual fixture ref OID is unchanged.
  // Changed state always goes through the real store's full validated snapshot.
  const revision=()=>({store_kind:"git",value:fs.readFileSync(path.join(repo,GIT_TRANSACTION_REF),"utf8").trim()});
  let cached=null;
  const snapshot=()=>{const current=revision();if(!cached||cached.revision.value!==current.value)cached=open().readSnapshot(Object.values(K));return cached;};
  const get=name=>parse(snapshot().records[K[name]].content);
  const edit=(name,value)=>{const io=open(),p=io.prepareBatch({expected_revision:revision(),transaction_id:"fixture-edit",writes:[{key:K[name],content:json(value)}]});assert.equal(io.publishPrepared(p.handle).status,"PUBLISHED");};
  const broker=io=>createInertAdmissionPrototype({store:io||open(),writerFixture:writer});
  return {base,repo,open,store,writer,records,get,edit,broker,close,snapshot};
}

const { createInertStrictEntry } = require("../../lib/runtime-port/strict-entry");
const entry = (a,scenario="complete") => createInertStrictEntry({admission:a,scenario});

test("fixed inert port maps only supplied fixture relations; outcome does not finish canonical Task",async t=>{
  const f=fixture(t),a=f.broker(),e=entry(a),r=await a.reserve(req()),task=f.get("task");
  assert.equal((await e.dispatch(r.handle)).status,"PUBLISHED");
  const ack=f.get("ack");assert.equal(ack.effect_authority,false);assert.equal(ack.operation.status,"executing");
  assert.equal(ack.operation.relations.run_id,"synthetic:run:"+req().attempt_nonce);
  assert.equal(ack.operation.relations.session_id,"synthetic:session:"+req().attempt_nonce);
  assert.equal(ack.operation.relations.workspace_id,"synthetic:workspace:"+req().attempt_nonce);
  const observed=e.inspect();assert.equal(observed.starts,1);assert.equal(observed.effect_authority,false);
  assert.deepEqual(Object.keys(observed.payload).sort(),["attempt_nonce","effect_authority","input","kind","operation_id","project_id","runtime_ref","schema_version"]);
  assert.ok(Object.isFrozen(observed.payload.input));
  assert.equal((await e.complete(r.handle)).status,"PUBLISHED");
  assert.equal(f.get("ack").operation.status,"succeeded");assert.equal(f.get("reservation").state,"COMPLETED");
  assert.equal(f.get("budget").spent,1);assert.equal(f.get("budget").held,3);assert.deepEqual(f.get("task"),task);
  await assert.rejects(e.dispatch(r.handle));await assert.rejects(e.complete(r.handle));assert.equal(e.inspect().starts,1);
  f.close();
  const rejected=fixture(t),broker=rejected.broker(),port=entry(broker,"review-rejected"),reservation=await broker.reserve(req()),prior=rejected.get("task");
  await port.dispatch(reservation.handle);await assert.rejects(port.complete(reservation.handle),{code:"INERT_REVIEW_REJECTED"});
  assert.equal(rejected.snapshot().records[K.outcome],null);assert.equal(rejected.get("budget").held,3);assert.deepEqual(rejected.get("task"),prior);
});

test("entry cannot accept caller port, identity, callback, forged broker or mutated options",async t=>{
  const f=fixture(t),a=f.broker();let called=0;
  assert.throws(()=>createInertStrictEntry({admission:a,scenario:"complete",port:{createRun(){called++;}}}));
  assert.throws(()=>createInertStrictEntry({admission:{...a},scenario:"complete"}));
  const accessor={scenario:"complete"};Object.defineProperty(accessor,"admission",{enumerable:true,get(){called++;return a;}});
  assert.throws(()=>createInertStrictEntry(accessor));assert.equal(called,0);
  const options={admission:a,scenario:"complete"},e=createInertStrictEntry(options);options.scenario="start-throws";
  const r=await a.reserve(req());assert.equal((await e.dispatch(r.handle)).status,"PUBLISHED");
  const second=await a.revalidate(r.handle);assert.equal(second.status,"REVALIDATED");
  await assert.rejects(e.dispatch(r.handle));assert.equal(e.inspect().starts,1);
});

test("missing runtime relation is UNKNOWN, no Operation is fabricated and no retry is possible",async t=>{
  for(const scenario of ["missing-session","wrong-attempt"]){
    const f=fixture(t),a=f.broker(),e=entry(a,scenario),r=await a.reserve(req());
    const out=await e.dispatch(r.handle);assert.equal(out.status,"UNKNOWN");assert.equal(out.budget_held,true);
    assert.equal(f.get("reservation").state,"UNKNOWN");assert.equal(f.snapshot().records[K.ack],null);
    assert.equal(f.get("budget").held,3);await assert.rejects(e.dispatch(r.handle));await assert.rejects(f.broker().reserve(req()));assert.equal(e.inspect().starts,1);
    f.close();
  }
});

test("uncertain start holds budget and never automatically calls the fixed port again",async t=>{
  const f=fixture(t),a=f.broker(),e=entry(a,"start-throws"),r=await a.reserve(req());
  assert.equal((await e.dispatch(r.handle)).status,"UNKNOWN");assert.equal(f.get("budget").held,3);
  await assert.rejects(e.dispatch(r.handle));assert.equal(e.inspect().starts,1);assert.equal(f.get("reservation").state,"UNKNOWN");
});

test("revocation before dispatch makes zero port calls; replacement ownership cannot be revoked by old handle",async t=>{
  const f=fixture(t),a=f.broker(),e=entry(a),r=await a.reserve(req());
  const time=t.mock.method(Date,"now",()=>Date.parse("2099-01-01T00:00:00.000Z"));
  try{await assert.rejects(e.dispatch(r.handle),{code:"INERT_EXPIRED"});assert.equal(e.inspect().starts,0);}finally{time.mock.restore();}
  const original=f.get("writer");f.edit("writer",{...original,generation:2});
  await assert.rejects(a.revoke(r.handle),{code:"INERT_REVOKE_OWNERSHIP_CHANGED"});assert.equal(f.get("writer").generation,2);
  await assert.rejects(e.dispatch(r.handle));assert.equal(e.inspect().starts,0);
  f.edit("writer",original);assert.equal((await e.revoke(r.handle)).status,"PUBLISHED");
  await assert.rejects(e.dispatch(r.handle));assert.equal(e.inspect().starts,0);
});

test("unconfirmed cancellation quarantines, preserves budget and rejects late completed output",async t=>{
  const f=fixture(t),a=f.broker(),e=entry(a,"cancel-unknown"),r=await a.reserve(req());
  assert.equal((await e.dispatch(r.handle)).status,"PUBLISHED");assert.equal((await e.revoke(r.handle)).status,"UNKNOWN");
  assert.equal(e.inspect().cancels,1);assert.equal(f.get("reservation").state,"UNKNOWN");assert.equal(f.get("budget").held,3);
  await assert.rejects(e.complete(r.handle));assert.equal(f.snapshot().records[K.outcome],null);
});

test("lost acknowledgement publication after an actual port call returns UNKNOWN and holds budget",async t=>{
  const f=fixture(t),a=f.broker(),e=entry(a),r=await a.reserve(req()),original=cp.spawnSync;let updates=0;
  const fault=(...args)=>{
    const result=original(...args);if(args[1].includes("update-ref")&&++updates===2)return {...result,error:Object.assign(new Error("synthetic lost ack exit"),{code:"ETIMEDOUT"})};return result;
  };cp.spawnSync=fault;
  let out;try{out=await e.dispatch(r.handle);}finally{cp.spawnSync=original;}
  assert.equal(out.status,"UNKNOWN");assert.equal(out.recovery_required,true);assert.equal(out.budget_held,true);assert.equal(out.recorded,false);
  assert.equal(e.inspect().starts,1);assert.equal(f.get("budget").held,3);await assert.rejects(e.dispatch(r.handle));
  await assert.rejects(f.broker().reserve(req()));assert.equal(e.inspect().starts,1);
});

test("persisted ack and outcome cross-record substitutions are rejected before new port calls",async t=>{
  const f=fixture(t),a=f.broker(),e=entry(a),r=await a.reserve(req());await e.dispatch(r.handle);
  const ack=f.get("ack"),bad=JSON.parse(JSON.stringify(ack));bad.runtime_ack.attempt_nonce="b".repeat(32);
  f.edit("ack",bad);await assert.rejects(a.revalidate(r.handle),{code:"INERT_ACK_BINDING"});f.edit("ack",ack);
  const reservation=f.get("reservation");f.edit("reservation",{...reservation,state:"DISPATCHING"});
  await assert.rejects(a.revalidate(r.handle),{code:"INERT_ACK_STATE"});f.edit("reservation",reservation);
  await e.complete(r.handle);
  const outcome=f.get("outcome"),changed=JSON.parse(JSON.stringify(outcome));changed.candidate.attempt_nonce="b".repeat(32);changed.review.candidate_digest=digest(json(changed.candidate));
  // Keep model unchanged: cross-record inconsistency must fail on read, not be
  // accepted because candidate and its synthetic review agree with each other.
  f.edit("outcome",changed);await assert.rejects(a.revalidate(r.handle));assert.equal(e.inspect().starts,1);
});
