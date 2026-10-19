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
  const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"cortex-admission-")),repo=path.join(base,"repo.git"),template=path.join(base,"empty-template");
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

test("reservation is one real multi-record CAS, freezes input and supports current idempotent revalidation",async t=>{
  const f=fixture(t),writer={...f.writer},a=createInertAdmissionPrototype({store:f.store,writerFixture:writer}),input=req();
  const pending=a.reserve(input);input.operation_id="OP-mutated";writer.workflow_sha="d".repeat(40);
  const r=await pending;assert.equal(r.status,"PUBLISHED");assert.equal(r.effect_authority,false);
  const before=f.snapshot();
  assert.equal(f.get("reservation").request.operation_id,"OP-fixture");assert.equal(f.get("lease").fence,1);
  assert.equal(f.get("budget").held,3);assert.equal(f.get("journal").events.length,1);
  assert.equal(before.records[K.ack],null);assert.equal(before.records[K.outcome],null);
  assert.equal((await a.reserve(req())).status,"REVALIDATED");assert.equal((await a.revalidate(r.handle)).status,"REVALIDATED");
  assert.deepEqual(f.snapshot().revision,before.revision);
  await assert.rejects(a.revalidate({}),{code:"INERT_HANDLE"});await assert.rejects(f.broker().revalidate(r.handle),{code:"INERT_HANDLE"});
});

test("two actual Git leaders race at update-ref; precisely one complete reservation wins",async t=>{
  const f=fixture(t),stores=[f.open(),f.open()],pending=[];let winner;
  const original=cp.spawnSync;
  // Both candidates are prepared and revalidated against the same H. B's actual
  // CAS is interleaved after A's final precheck and before A's actual update-ref.
  const wrapped=stores.map((io,i)=>({...io,publishPrepared:handle=>new Promise(resolve=>{
    pending[i]={handle,resolve};
    if(pending[0]&&pending[1]){
      const loser=stores[0].publishPrepared(pending[0].handle);
      pending[0].resolve(loser);pending[1].resolve(winner);
    }
  })}));
  // Stop recursive interception while B enters its own update-ref.
  let entering=false;
  const intercept=(...args)=>{
    if(args[1].includes("update-ref")&&!entering&&pending[0]&&pending[1]){entering=true;winner=stores[1].publishPrepared(pending[1].handle);}
    return original(...args);
  };cp.spawnSync=intercept;
  try {
    const a=f.broker(wrapped[0]),b=f.broker(wrapped[1]);
    const results=await Promise.all([a.reserve(req()),b.reserve({...req(),attempt_nonce:"b".repeat(32)})]);
    assert.deepEqual(results.map(r=>r.status),["CONFLICT","PUBLISHED"]);
    assert.equal(f.get("reservation").request.attempt_nonce,"b".repeat(32));assert.equal(f.get("lease").attempt_nonce,"b".repeat(32));
    assert.equal(f.get("replay").request_digest,digest(json({...req(),attempt_nonce:"b".repeat(32)})));
    assert.equal(f.get("budget").held,3);assert.equal(f.get("journal").events.length,1);
  }finally{cp.spawnSync=original;}
});

test("replay rereads Owner generation, Writer generation, independent gates, dependency and fence",async t=>{
  const f=fixture(t),a=f.broker(),r=await a.reserve(req());
  for(const [name,patch,code] of [
    ["owner",{generation:2},"INERT_OWNER_CHANGED"],["writer",{generation:2},"INERT_WRITER_CHANGED"],
    ["decision",{status:"rejected"},"INERT_DECISION"],["waitpoint",{status:"blocked"},"INERT_WAITPOINT"],
    ["dependency",{status:"pending"},"INERT_DEPENDENCY"],["lease",{fence:2},"INERT_OLD_FENCE"]]){
    const prior=f.get(name);f.edit(name,{...prior,...patch});
    await assert.rejects(a.reserve(req()),{code});await assert.rejects(a.claimDispatch(r.handle),{code});f.edit(name,prior);
  }
  assert.equal(f.get("reservation").state,"RESERVED");assert.equal(f.get("budget").held,3);
});

test("expiry, malformed identity, accessor and numeric coercions fail closed before reservation",async t=>{
  const f=fixture(t);
  for(const value of ["1",1.5,null,{},Infinity])assert.throws(()=>createInertAdmissionPrototype({store:f.store,writerFixture:{...f.writer,run_attempt:value}}));
  assert.throws(()=>createInertAdmissionPrototype({store:f.store,writerFixture:{...f.writer,effect_authority:true}}));
  let calls=0;const bad={...f.writer};Object.defineProperty(bad,"run_id",{enumerable:true,get(){calls++;return "synthetic:bad";}});
  assert.throws(()=>createInertAdmissionPrototype({store:f.store,writerFixture:bad}));assert.equal(calls,0);
  const badOptions={store:f.store};Object.defineProperty(badOptions,"writerFixture",{enumerable:true,get(){calls++;return f.writer;}});
  assert.throws(()=>createInertAdmissionPrototype(badOptions));assert.equal(calls,0);
  const a=f.broker();await assert.rejects(a.reserve({...req(),operation_id:{toString(){calls++;return "OP-x";}}}));assert.equal(calls,0);
  const time=t.mock.method(Date,"now",()=>Date.parse("2099-01-01T00:00:00.000Z"));
  try{await assert.rejects(a.reserve(req()),{code:"INERT_EXPIRED"});}finally{time.mock.restore();}
  assert.equal(f.snapshot().records[K.reservation],null);
});

test("budget exhaustion and owner/writer role conflation never reserve",async t=>{
  const f=fixture(t);f.edit("budget",{...f.get("budget"),limit:2});
  await assert.rejects(f.broker().reserve(req()),{code:"INERT_BUDGET_OR_LEASE"});
  f.edit("budget",f.records.budget);f.edit("owner",{...f.get("owner"),subject_id:f.writer.writer_id});
  await assert.rejects(f.broker().reserve(req()),{code:"INERT_OWNER_CHANGED"});
  assert.equal(f.snapshot().records[K.reservation],null);
});

test("revoke advances fence and generation atomically, retains budget, rejects all old receipts",async t=>{
  const f=fixture(t),a=f.broker(),r=await a.reserve(req());assert.equal((await a.revoke(r.handle)).status,"PUBLISHED");
  assert.equal(f.get("lease").fence,2);assert.equal(f.get("writer").generation,2);assert.equal(f.get("reservation").state,"REVOKED");
  assert.equal(f.get("budget").held,3);assert.equal(f.get("journal").events.length,2);
  await assert.rejects(a.claimDispatch(r.handle),{code:"INERT_WRITER_CHANGED"});await assert.rejects(a.reserve(req()),{code:"INERT_WRITER_CHANGED"});
});

test("lost actual reserve publication is UNKNOWN, quarantined and never republishes",async t=>{
  const f=fixture(t),a=f.broker(),original=cp.spawnSync;let updates=0;
  const fault=(...args)=>{
    const r=original(...args);if(args[1].includes("update-ref")){updates++;return {...r,error:Object.assign(new Error("synthetic lost exit"),{code:"ETIMEDOUT"})};}return r;
  };cp.spawnSync=fault;
  let out;try{out=await a.reserve(req());}finally{cp.spawnSync=original;}
  assert.equal(out.status,"UNKNOWN");assert.equal(out.budget_held,true);assert.equal(updates,1);
  await assert.rejects(a.reserve(req()),{code:"INERT_QUARANTINED"});assert.equal(f.get("budget").held,3);
  assert.equal(f.get("reservation").state,"RESERVED");
  // A new process can inspect evidence but must not interpret this as a live permit.
  assert.equal(out.effect_authority,false);await assert.rejects(f.broker().reserve(req()),{code:"INERT_RECOVERY_REQUIRED"});
});
