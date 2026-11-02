"use strict";
const assert = require("node:assert/strict");
const {Worker} = require("node:worker_threads");
const {createHook} = require("node:async_hooks");
const path = process.argv[2], mode = process.argv[3], addon = require(path);
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn) { for(let i=0;i<300;i++) { if(fn()) return; await sleep(5); } throw Error("barrier timeout"); }
async function pending(p) { let done=false; p.then(()=>{done=true;},()=>{done=true;}); await sleep(80); assert.equal(done,false); }
async function run() {
  if(mode.startsWith("buffer-copy-live") || mode.startsWith("buffer-copy-two-slot")) {
    const worker = new Worker(`const assert=require('node:assert/strict'),{parentPort}=require('node:worker_threads');
      const {createHook}=require('node:async_hooks'),addon=require(${JSON.stringify(path)}),mode=${JSON.stringify(mode)};
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      async function until(fn){for(let i=0;i<300;i++){if(fn())return;await sleep(5);}throw Error('barrier timeout');}
      (async()=>{
        const dual=mode.includes('two-slot'), cancelNeighbor=mode.endsWith('cancel-neighbor');
        const caps=[addon.start()]; if(dual)caps.push(addon.start());
        await Promise.all(caps.map(c=>c.ready));
        for(const c of caps)assert.equal((await c.io()).toString(),'FD_OK');
        const target=mode.endsWith('second')?1:0,failed=caps[target];
        for(let i=0;i<caps.length;i++)await caps[i].io(Buffer.from(i===target?'FAIL':'SAFE'));
        const baseline=addon.testStatus(),token=addon.testArm(mode);
        parentPort.postMessage({token});
        const ids=new WeakMap(); let targetId, reentries=0;
        const reentrant=mode.endsWith('reentry')||cancelNeighbor;
        const hook=createHook({init(id,type,trigger,resource){if(type==='PROMISE')ids.set(resource,id);},
          promiseResolve(id){if(id!==targetId||!reentrant)return;
            reentries++;
            assert.throws(()=>failed.io(),{code:'CLOSED'});
            assert.throws(()=>failed.io(Buffer.from('blocked')),{code:'CLOSED'});
            failed.cancel(false); failed.cancel(true);
            if(cancelNeighbor){
              assert.throws(()=>caps[1].io(),{code:'BUSY'});
              caps[1].cancel(false);
            }
          }});
        hook.enable();
        const reads=caps.map(c=>c.io()); targetId=ids.get(reads[target]);
        assert.ok(targetId);
        let operations=0,exits=0;
        for(const p of reads)p.then(()=>operations++,()=>operations++);
        for(const c of caps)c.directExit.then(()=>exits++);
        const outcomes=await Promise.allSettled(reads); hook.disable();
        assert.equal(outcomes[target].status,'rejected');assert.equal(outcomes[target].reason.code,'SYSTEM');
        assert.equal(reentries,reentrant?1:0);
        if(dual){const other=outcomes[1-target];
          if(cancelNeighbor){assert.equal(other.status,'rejected');assert.equal(other.reason.code,'CANCELLED');}
          else {assert.equal(other.status,'fulfilled');assert.equal(other.value.toString(),'SAFE');}
        }
        assert.throws(()=>failed.io(),{code:'CLOSED'});
        assert.throws(()=>failed.io(Buffer.from('blocked')),{code:'CLOSED'});
        const injected=addon.testStatus();
        assert.equal(injected.injectedAlive,true);assert.equal(injected.bufferFailures,1);
        assert.equal(injected.cancelCalls,0);assert.equal(injected.terminateCalls,0);
        assert.equal(failed.snapshot().directExitObserved,false);assert.equal(exits,0);
        // Only now allow the owner to consume the cancellation request.
        addon.testRelease();
        await until(()=>addon.testStatus().cancelCalls>0&&addon.testStatus().terminateCalls>0&&addon.testStatus().withheldWaits>0);
        let done=false;failed.directExit.then(()=>done=true);await sleep(60);assert.equal(done,false);
        // Remove the wait-error injection; only the actual native wait may settle exit.
        addon.testRelease();
        await until(()=>failed.snapshot().directExitObserved);
        const direct=await failed.directExit;
        assert.equal(direct.directExitObserved,true);assert.equal(direct.notStarted,false);
        assert.equal(direct.treeExitProven,false);assert.equal(failed.snapshot().chargesRetained,true);
        if(dual){const other=caps[1-target];
          if(!cancelNeighbor){
            await other.io(Buffer.from('STILL_SAFE'));assert.equal((await other.io()).toString(),'STILL_SAFE');
          }
          other.cancel(true);await other.directExit;
        }
        await sleep(60);assert.equal(operations,caps.length);assert.equal(exits,caps.length);
        const state=addon.testStatus();assert.equal(state.bufferFailures,1);
        const extra=dual&&!cancelNeighbor?2:0;
        assert.equal(state.resolved-baseline.resolved,caps.length+(dual&&!cancelNeighbor?1:0)+extra);
        assert.equal(state.rejected-baseline.rejected,cancelNeighbor?2:1);
        parentPort.postMessage({done:true,state});
      })().catch(e=>parentPort.postMessage({error:e.stack}));`,{eval:true});
    let token,result;
    try {
      result=await new Promise((resolve,reject)=>{
        worker.on("message",m=>{if(m.token)token=m.token;if(m.done)resolve(m.state);if(m.error)reject(Error(m.error));});
        worker.once("error",reject);worker.once("exit",code=>reject(Error(`worker exited before completion: ${code}`)));
      });
    } finally {
      if(token){addon.testRelease(token);addon.testRelease(token);}
      await worker.terminate();
    }
    const state=addon.testStatus(token);
    assert.ok(state.ownerDone&&state.finalized&&state.completionClosed);
    assert.ok(state.deleted>state.ownerDone&&state.deleted>state.finalized&&state.deleted>state.completionClosed);
    assert.equal(state.resolved,result.resolved);assert.equal(state.rejected,result.rejected);
    console.log(JSON.stringify({mode,instance:state}));return;
  }
  if(["buffer-copy-failure","buffer-copy-pending-exception"].includes(mode)) {
    const worker = new Worker(`const assert=require('node:assert/strict'),{parentPort}=require('node:worker_threads');
      const addon=require(${JSON.stringify(path)}), cap=addon.start();
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      (async()=>{
        await cap.ready; const token=addon.testArm(${JSON.stringify(mode)});
        parentPort.postMessage({token});
        const read=cap.io(); let operations=0,exits=0;
        read.then(()=>{operations++;},()=>{operations++;});
        cap.directExit.then(()=>{exits++;});
        await assert.rejects(read,{code:'SYSTEM'});
        let timer;
        const exit=await Promise.race([cap.directExit,new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(Error('directExit lost after buffer copy failure')),500);
        })]).finally(()=>clearTimeout(timer));
        assert.equal(exit.directExitObserved,true); assert.equal(exit.notStarted,false);
        assert.equal(exit.treeExitProven,false);
        assert.equal(cap.snapshot().chargesRetained,true);
        assert.throws(()=>cap.io(),{code:'CLOSED'});
        await sleep(80);
        assert.equal(operations,1); assert.equal(exits,1);
        const state=addon.testStatus();
        assert.equal(state.bufferFailures,1); assert.equal(state.exitPublished,true);
        assert.equal(state.resolved,2); assert.equal(state.rejected,1);
        parentPort.postMessage({done:true,state});
      })().catch(e=>{throw e;});`,{eval:true});
    let token, result;
    try {
      result=await new Promise((resolve,reject)=>{
        worker.on("message",message=>{ if(message.token) token=message.token; if(message.done) resolve(message.state); });
        worker.once("error",reject);
        worker.once("exit",code=>reject(Error(`worker exited before completion: ${code}`)));
      });
    } finally { await worker.terminate(); }
    const state=addon.testStatus(token);
    assert.ok(state.ownerDone && state.finalized && state.completionClosed);
    assert.ok(state.deleted>state.ownerDone && state.deleted>state.finalized && state.deleted>state.completionClosed);
    assert.equal(state.resolved,result.resolved); assert.equal(state.rejected,result.rejected);
    console.log(JSON.stringify({mode,instance:state})); return;
  }
  if(["teardown","destroy-failure","closing"].includes(mode)) {
    const worker = new Worker(`const {parentPort}=require('node:worker_threads');
      const addon=require(${JSON.stringify(path)}), cap=addon.start();
      cap.ready.then(async()=>{await cap.io(); const token=addon.testArm(${JSON.stringify(mode === "teardown" ? "owner-tick" : mode)});
        parentPort.postMessage(token);});`,{eval:true});
    let token, ending;
    try {
      token = await new Promise((resolve,reject)=>{worker.once("message",resolve);worker.once("error",reject);});
      const state=()=>addon.testStatus(token);
      assert.notEqual(token,addon.testStatus().token);
      if(mode === "teardown") await until(()=>state().reached);
      if(mode === "closing") await until(()=>state().closing);
      ending=worker.terminate(); await until(()=>state().cleanup);
      if(mode === "destroy-failure") await until(()=>state().destroyFailed);
      if(mode !== "closing") {
        await until(()=>state().finalized);
        assert.equal(state().ownerDone,0); assert.equal(state().deleted,0);
        await pending(ending);
      }
      if(mode === "destroy-failure") {
        assert.equal(state().sessionsRetained,1); assert.ok(state().capacityRetained>0);
        assert.equal(state().sendReserved,56);
      }
    } finally {
      if(token) addon.testRelease(token);
      if(!ending) ending=worker.terminate();
      await ending;
    }
    const state=addon.testStatus(token);
    assert.ok(state.ownerDone > state.cleanup);
    assert.ok(state.completionClosed > state.ownerDone && state.completionClosed > state.finalized);
    assert.ok(state.deleted > state.completionClosed);
    assert.equal(addon.testStatus().ownerDone,0);
    assert.equal(addon.testStatus().cleanup,0);
    assert.equal(addon.testStatus().deleted,0);
    if(mode === "destroy-failure") assert.equal(state.destroyRecovered,true);
    if(mode === "closing") { assert.ok(state.closing); assert.equal(state.callsAfterClosing,0); }
    console.log(JSON.stringify({mode,instance:state}));
    return;
  }
  if(["post-start","pre-start","unknown-start"].includes(mode)) addon.testArm(mode);
  if(mode === "cancel-ready") addon.testArm("ready-publication");
  const cap=addon.start();
  if(["post-start","pre-start","unknown-start"].includes(mode)) {
    await assert.rejects(cap.ready,{code:"SYSTEM"});
    if(mode === "pre-start") { const result=await cap.directExit; assert.equal(result.directExitObserved,false); assert.equal(result.notStarted,true); }
    else {
      await pending(cap.directExit);
      if(mode === "post-start") { cap.cancel(true); addon.testRelease(); const result=await cap.directExit; assert.equal(result.directExitObserved,true); }
      else { cap.cancel(true); await pending(cap.directExit); process.exit(0); }
    }
    return;
  }
  if(mode === "cancel-ready") {
    const outcome=assert.rejects(cap.ready,{code:"CANCELLED"});
    try { await until(()=>addon.testStatus().reached); cap.cancel(false); }
    finally { addon.testRelease(); }
    await outcome;
    cap.cancel(true); await cap.directExit; return;
  }
  await cap.ready; assert.equal((await cap.io()).toString(),"FD_OK");
  if(mode === "reentrant-promise") {
    let reentered=0;
    const hook=createHook({init(id,type){ if(type === "PROMISE" && !reentered) { reentered++; cap.snapshot(); cap.cancel(false); } }});
    hook.enable(); const p=cap.io(); hook.disable(); await assert.rejects(p,{code:"CANCELLED"});
    assert.equal(reentered,1); cap.cancel(true); await cap.directExit; return;
  }
  if(mode === "unknown-wait") {
    addon.testArm("unknown-wait"); cap.cancel(true); await pending(cap.directExit);
    addon.testRelease(); assert.equal((await cap.directExit).directExitObserved,true); return;
  }
  await cap.io(Buffer.from("late")); addon.testArm("op-publication");
  const read=cap.io(), rejected=assert.rejects(read,{code:"CANCELLED"});
  try { await until(()=>addon.testStatus().reached); cap.cancel(false); }
  finally { addon.testRelease(); }
  await rejected;
  cap.cancel(true); await cap.directExit;
}
run().then(()=>console.log(JSON.stringify({mode,status:"OK"})),e=>{console.error(e);process.exitCode=1;});
