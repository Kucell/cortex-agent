"use strict";
const assert=require("node:assert/strict"),{Worker}=require("node:worker_threads"),{createHook}=require("node:async_hooks");
const binary=process.argv[2],mode=process.argv[3],addon=require(binary);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<1500;i++){if(fn())return;await sleep(5);}throw Error("completion timeout");}
async function run(){
  assert.ok(Object.getOwnPropertyNames(addon).includes("start"));
  if(mode==="default"){assert.throws(()=>addon.start(),{code:"UNSAFE_DEPLOYMENT"});return;}
  if(["owner-before-done","owner-published","unsafe-owner-published","destroy-failure"].includes(mode)||mode.startsWith("init-")){
    addon.testArm(mode);const token=addon.testStatus().token+1;
    const worker=new Worker(`const {parentPort}=require('node:worker_threads');setInterval(()=>{},1000);
      (async()=>{try{const a=require(${JSON.stringify(binary)}),c=a.start();await c.ready;await c.request(1,Buffer.from('retained'));
        parentPort.postMessage({ready:true,snapshot:c.snapshot()});}catch(e){parentPort.postMessage({failure:e.code});}})();`,{eval:true});
    let ending,message;
    try{
      message=await new Promise((resolve,reject)=>{worker.once("message",resolve);worker.once("error",reject);});
      if(mode.startsWith("init-")){
        assert.equal(message.failure,mode==="init-thread"?"THREAD":"MEMORY");
        await until(()=>addon.testStatus(token).deleted);
        const state=addon.testStatus(token);assert.equal(state.before,0);assert.equal(state.published,0);
        if(mode==="init-uv"){assert.equal(state.closed,0);assert.equal(state.finalized,0);}
        else {assert.ok(state.closed&&state.deleted>state.closed);if(mode!=="init-tsfn")assert.ok(state.finalized);}
      }else{
        assert.equal(message.ready,true);ending=worker.terminate();
        await until(()=>addon.testStatus(token).finalized);
        if(mode==="destroy-failure"){
          await until(()=>addon.testStatus(token).destroyFailed);
          const state=addon.testStatus(token);assert.equal(state.published,0);assert.equal(state.closed,0);assert.equal(state.deleted,0);
          assert.equal(state.waitProven,true);assert.ok(state.capacityRetained>0&&state.stateCapacityRetained>0);
          let done=false;ending.then(()=>done=true);await sleep(40);assert.equal(done,false);
        }else{
          await until(()=>addon.testStatus(token).reached);
          const entered=addon.testStatus(token).entered;addon.testPulse(token);
          await until(()=>addon.testStatus(token).entered>entered);
          assert.equal(addon.testStatus(token).closed,0);
          assert.equal(addon.testStatus(token).sent,0);
        }
      }
    }finally{addon.testRelease(token);if(!ending)ending=worker.terminate();await ending;}
    const state=addon.testStatus(token);
    assert.ok(state.deleted>state.closed||mode==="init-uv");
    if(!mode.startsWith("init-")){
      assert.ok(state.published>state.before&&state.sent>state.published);
      assert.ok(state.closed>state.sent&&state.closed>state.finalized&&state.deleted>state.ownerRelease);
      assert.ok(state.destroyed&&state.cleanup);
      assert.equal(state.waitProven,true);
    }
    console.log(JSON.stringify({mode,lifetime:state}));return;
  }
  if(mode==="settlement-reentry"){
    const ids=new WeakMap();let cap,readyId,resultId,closeId,closedId,first,second,closing,readyCalls=0,results=0,closes=0,closedCalls=0;
    const hook=createHook({init(id,type,trigger,resource){if(type==="PROMISE")ids.set(resource,id);},promiseResolve(id){
      if(id===readyId){readyCalls++;cap.snapshot();first=cap.request(1,Buffer.from('first'));resultId=ids.get(first);}
      else if(id===resultId){results++;cap.snapshot();
        if(results===1){second=cap.request(2,Buffer.from('second'));resultId=ids.get(second);}
        else {closing=cap.close();closeId=ids.get(closing);}}
      else if(id===closeId){closes++;cap.snapshot();assert.throws(()=>cap.request(1,Buffer.alloc(0)),{code:'CLOSED'});assert.throws(()=>cap.close(),{code:'CLOSED'});cap.cancel(false);}
      else if(id===closedId){closedCalls++;cap.snapshot();assert.throws(()=>cap.request(1,Buffer.alloc(0)),{code:'CLOSED'});}
    }});hook.enable();cap=addon.start();readyId=ids.get(cap.ready);closedId=ids.get(cap.closed);
    await cap.ready;assert.equal((await first).toString(),'first');assert.equal((await second).toString(),'second');await closing;await cap.closed;await cap.directExit;hook.disable();
    assert.equal(readyCalls,1);assert.equal(results,2);assert.equal(closes,1);assert.equal(closedCalls,1);return;
  }
  if(mode==="worker-cleanup"){
    const worker=new Worker(`const {parentPort}=require('node:worker_threads'),cap=require(${JSON.stringify(binary)}).start();
      cap.ready.then(()=>{cap.request(1,Buffer.alloc(1048599)).catch(()=>{});parentPort.postMessage('ready');});`,{eval:true});
    await new Promise((resolve,reject)=>{worker.once("message",resolve);worker.once("error",reject);});
    await worker.terminate();return;
  }
  const cap=addon.start();
  assert.deepEqual(Object.getOwnPropertyNames(cap).filter(k=>k!=="testReleasePeer").sort(),["cancel","close","closed","directExit","ready","request","snapshot"]);
  const exit=cap.directExit,closed=cap.closed;
  if(mode==="bad-mac"){
    await assert.rejects(cap.ready,{code:"MAC"});await closed;assert.equal((await exit).directExitObserved,true);return;
  }
  await cap.ready;
  if(mode==="historical-four"){
    const started=process.hrtime.bigint();
    const log=stage=>console.log(JSON.stringify({stage,monotonicNs:process.hrtime.bigint().toString(),elapsedNs:(process.hrtime.bigint()-started).toString(),snapshot:cap.snapshot(),native:addon.testStatus()}));
    try{
      log('ready');
      for(let round=1;round<=4;round++){
        log(`before-request-${round}`);const reply=await cap.request(round%3+1,Buffer.alloc(1048599,round));
        assert.equal(reply.length,1048599);assert.ok(reply.every(v=>v===round));log(`after-request-${round}`);
      }
      log('before-close');await cap.close();log('after-close');await cap.closed;
      assert.equal(cap.snapshot().protocolClosed,true);assert.equal(cap.snapshot().directExitObserved,false);
      cap.testReleasePeer();const direct=await cap.directExit;log('after-real-exit');assert.equal(direct.status,0);
    }catch(e){
      log('first-js-error');cap.testReleasePeer();cap.cancel(true);
      let timer;try{const direct=await Promise.race([cap.directExit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('wait incomplete')),2000);})]);
        console.log(JSON.stringify({stage:'failure-real-exit',direct}));}finally{clearTimeout(timer);}
      log('after-failure-cleanup');throw e;
    }
    return;
  }
  assert.equal(cap.snapshot().stateKeyWiped,false);assert.equal(cap.snapshot().transportKeyWiped,true);
  assert.throws(()=>cap.request(),{code:"ARGUMENTS"});assert.throws(()=>cap.close(1,Buffer.from("x")),{code:"ARGUMENTS"});
  assert.throws(()=>cap.request(1,Buffer.alloc(1048600)),{code:"LENGTH"});
  if(mode==="idle"){
    const before=cap.snapshot();await sleep(80);const after=cap.snapshot();
    assert.ok(after.ownerPumps>before.ownerPumps);assert.equal(after.bridgeCopyReservedBytes,0);assert.equal(after.copyAllocationAttempts,0);
    await closed;assert.equal(cap.snapshot().failure,"DEADLINE");await exit;return;
  }
  if(mode==="quota"||mode==="delivery-quota"){
    // Input admission succeeds, native receives the complete authenticated
    // response, but the bridge result-copy reservation cannot fit.
    await assert.rejects(cap.request(1,Buffer.alloc(1048599,7)),{code:"QUOTA"});await closed;await exit;
    assert.equal(cap.snapshot().inputCopyReservedPayloadBytes,1048599);
    assert.equal(cap.snapshot().resultCopyReservedPayloadBytes,mode==="quota"?0:1048599);
    assert.equal(cap.snapshot().deliveryCopyReservedPayloadBytes,0);
    assert.throws(()=>cap.request(1,Buffer.alloc(0)),{code:"CLOSED"});return;
  }
  if(mode==="cancel"||mode==="stall"){
    const p=cap.request(1,Buffer.alloc(1048599,7));
    if(mode==="cancel"){await sleep(30);cap.cancel(false);await assert.rejects(p,{code:"CANCELLED"});
      let done=false;exit.then(()=>done=true);await sleep(50);assert.equal(done,false);cap.cancel(true);
    }else await assert.rejects(p,{code:"DEADLINE"});
    await closed;await exit;assert.equal(cap.snapshot().protocolClosed,false);return;
  }
  if(mode==="copy-failure"){
    const ids=new WeakMap();let target,reentered=0;
    const hook=createHook({init(id,type,trigger,resource){if(type==="PROMISE")ids.set(resource,id);},promiseResolve(id){
      if(id!==target)return;reentered++;assert.throws(()=>cap.request(1,Buffer.from("blocked")),{code:"CLOSED"});cap.cancel(false);cap.cancel(true);
    }});hook.enable();const p=cap.request(1,Buffer.alloc(1048599,7));target=ids.get(p);
    await assert.rejects(p,{code:"SYSTEM"});hook.disable();assert.equal(reentered,1);
    await closed;assert.equal((await exit).directExitObserved,true);assert.equal(cap.snapshot().deliveryCopyReservedPayloadBytes,1048599);return;
  }
  if(mode==="close-eof"){
    await assert.rejects(cap.close());await closed;await exit;assert.equal(cap.snapshot().protocolClosed,false);return;
  }
  const dual=mode==="dual",caps=[cap];if(dual){caps.push(addon.start());await caps[1].ready;assert.throws(()=>addon.start(),{code:"ADMISSION"});}
  if(mode==="normal"){const empty=await cap.request(1,Buffer.alloc(0));assert.ok(Buffer.isBuffer(empty));assert.equal(empty.length,0);}
  const initialTurns=caps.map(c=>c.snapshot().ownerPumps);
  let expected=0,ticks=0;const timer=setInterval(()=>ticks++,5);
  try{
    for(let round=0;round<(dual?3:mode==="normal"?4:1);round++){
      const n=["normal","close-hold"].includes(mode)?127:1048599;
      const tasks=caps.map((c,i)=>{const bytes=Buffer.alloc(n,round+i+7);const p=c.request(round%3+1,bytes);bytes.fill(99);
        assert.throws(()=>c.request(1,Buffer.alloc(0)),{code:"BUSY"});expected+=n;
        return p.then(reply=>{assert.equal(reply.length,n);assert.ok(reply.every(v=>v===round+i+7));});});
      await Promise.all(tasks);
    }
  }finally{clearInterval(timer);}
  if(!["normal","close-hold"].includes(mode))assert.ok(ticks>5,"owner must leave the JS event loop runnable");
  const beforeClose=cap.snapshot();assert.equal(beforeClose.inputCopyReservedPayloadBytes,expected);assert.equal(beforeClose.resultCopyReservedPayloadBytes,expected);
  assert.equal(beforeClose.deliveryCopyReservedPayloadBytes,expected);assert.equal(beforeClose.bridgeCopyReservedBytes,3*expected+beforeClose.copyAllocationAttempts*4096);
  assert.equal(beforeClose.maxWireBytes,1048697);assert.equal(beforeClose.readCreditsValid,true);assert.ok(beforeClose.traceEntriesChecked>0);
  assert.equal(beforeClose.bridgeCopyReservedBytes<=beforeClose.bridgeCopyLimit,true);
  if(dual){const turns=caps.map((c,i)=>c.snapshot().ownerPumps-initialTurns[i]);
    assert.ok(Math.abs(turns[0]-turns[1])<=2,JSON.stringify({turns}));}
  await Promise.all(caps.map(c=>c.close()));
  if(mode==="close-hold"){
    let done=false;exit.then(()=>done=true);await sleep(60);assert.equal(done,false);
    assert.equal(cap.snapshot().protocolClosed,true);assert.equal(cap.snapshot().directExitObserved,false);
    cap.testReleasePeer();
  }
  for(const c of caps){await c.closed;const direct=await c.directExit;assert.equal(direct.directExitObserved,true);assert.equal(direct.status,0);
    const v=c.snapshot();assert.equal(v.protocolClosed,true);assert.equal(v.stateKeyWiped,true);assert.equal(v.transportKeyWiped,true);
    assert.equal(v.chargesRetained,true);assert.equal(v.treeExitProven,false);assert.equal(v.executionAuthorized,false);
    assert.equal(v.sentBytes,v.stateSentReservedBytes+56*caps.length);assert.equal(v.receivedBytes,v.stateReceivedBytes);
    assert.throws(()=>c.request(1,Buffer.alloc(0)),{code:"CLOSED"});}
  console.log(JSON.stringify({mode,expectedPayloadCopies:expected,...cap.snapshot()}));
}
run().then(()=>console.log(JSON.stringify({mode,status:"OK"})),e=>{console.error(e);process.exitCode=1;});
