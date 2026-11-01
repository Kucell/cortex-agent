"use strict";
const assert = require("node:assert/strict");
const { Worker } = require("node:worker_threads");
const fs = require("node:fs");
const addonPath = process.argv[2], mode = process.argv[3];
const addon = require(addonPath);
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function run() {
  assert.deepEqual(Object.getOwnPropertyNames(addon), ["start"]);
  assert.equal(Object.isFrozen(addon),true);
  assert.throws(() => addon.start({ path: "/bin/sh", fd: 3, fixture: true }), { code: "ARGUMENTS" });
  if (mode === "default") {
    process.env.PW_NAPI_FIXTURE = "1"; process.env.PW_ANONYMOUS_FIXTURE = "1";
    assert.throws(() => addon.start(), { code: "UNSAFE_DEPLOYMENT" });
    return { defaultRefused: true };
  }
  if (mode === "worker-cleanup") {
    const worker = new Worker(`const {parentPort}=require('node:worker_threads');
      const cap=require(${JSON.stringify(addonPath)}).start();
      cap.ready.then(()=>parentPort.postMessage('ready'));`, { eval: true });
    await new Promise((resolve,reject) => { worker.once("message",resolve); worker.once("error",reject); });
    await worker.terminate();
    return { workerCleanupCompleted: true };
  }
  const baseline = fs.readdirSync("/dev/fd").length;
  const cap = addon.start();
  assert.deepEqual(Object.getOwnPropertyNames(cap).sort(), ["cancel","directExit","io","ready","snapshot"]);
  assert.equal(Object.isFrozen(cap),true);
  const detached = cap.io;
  assert.throws(() => detached.call({},Buffer.from("x")), { code: "CAPABILITY" });
  assert.throws(() => cap.io.call(Object.create(cap)), { code: "CAPABILITY" });
  assert.throws(() => cap.io(Buffer.from("early")), { code: "BUSY" });
  if (mode === "bad-ack") {
    await assert.rejects(cap.ready, { code: "AUTH" });
    await cap.directExit;
    cap.cancel(true);
    return { badAckRefused: true };
  }
  await cap.ready;
  assert.equal((await cap.io()).toString(),"FD_OK");
  assert.throws(() => cap.io(3), { code: "LENGTH" });
  assert.throws(() => cap.io(Buffer.alloc(513)), { code: "LENGTH" });
  assert.throws(() => cap.io(Buffer.from("x"),{}), { code: "ARGUMENTS" });
  assert.throws(() => cap.cancel(), { code: "ARGUMENTS" });
  if (mode === "stall" || mode === "deadline") {
    let ticks = 0; const timer = setInterval(() => ticks++,5);
    const pending = cap.io();
    assert.throws(() => cap.io(), { code: "BUSY" });
    if (mode === "deadline") await assert.rejects(pending,{code:"DEADLINE"});
    else {
      await sleep(80); cap.cancel(false);
      await assert.rejects(pending,{code:"CANCELLED"});
      let exited = false; cap.directExit.then(()=> { exited = true; });
      await sleep(50); assert.equal(exited,false);
      assert.equal(cap.snapshot().directExitObserved,false);
      cap.cancel(true);
    }
    await cap.directExit; clearInterval(timer); assert.ok(ticks > 5);
    return { eventLoopTicks: ticks, actualWaitObserved: true, ...cap.snapshot() };
  }
  if (mode === "quota") {
    await assert.rejects(cap.io(Buffer.from("HELLO")),{code:"QUOTA"});
    cap.cancel(false); const exited = await cap.directExit;
    assert.equal(exited.status,0); // child independently counted zero request bytes
    assert.equal(cap.snapshot().reservedSendBytes,56);
    return { zeroRequestBytes: true, ...cap.snapshot() };
  }
  for (const bytes of [Buffer.from([0,255,5]), Buffer.alloc(127,7), Buffer.from("third")]) {
    const pending = cap.io(bytes); bytes.fill(7); // copy must already be native-owned
    assert.throws(() => cap.io(), {code:"BUSY"}); await pending;
    const reply = await cap.io();
    if (reply.length === 3 && reply[0] === 0) assert.deepEqual(reply,Buffer.from([0,255,5]));
    else assert.ok(reply.length === 127 || reply.toString() === "third");
  }
  cap.cancel(false); const direct = await cap.directExit;
  assert.equal(direct.directExitObserved,true); assert.equal(direct.status,0);
  const closed = cap.snapshot();
  assert.equal(closed.sessionsRetained,1);
  assert.equal(closed.snapshotAbiVersion,2);
  assert.equal(closed.capacityBytes,closed.sessionCapacityReservedBytes);
  assert.equal(closed.sessionCapacityReservedBytes,2*512+4);
  assert.equal(closed.rootCapacityReservedBytes,closed.rootMetadataReservedBytes+closed.traceCapacityReservedBytes);
  assert.ok(closed.traceCapacityReservedBytes>0);
  assert.ok(closed.rootMetadataReservedBytes>0);
  assert.equal(closed.totalNativeReservedBytes,closed.rootCapacityReservedBytes+closed.sessionCapacityReservedBytes);
  assert.equal(closed.processRssMeasured,false);
  const second = addon.start(); await second.ready; assert.equal((await second.io()).toString(),"FD_OK");
  second.cancel(false); await second.directExit;
  assert.equal(second.snapshot().sessionsRetained,2);
  assert.equal(second.snapshot().rootCapacityReservedBytes,closed.rootCapacityReservedBytes);
  assert.equal(second.snapshot().sessionCapacityReservedBytes,2*closed.sessionCapacityReservedBytes);
  assert.throws(() => addon.start(),{code:"ADMISSION"});
  assert.equal(second.snapshot().chargesRetained,true);
  assert.equal(second.snapshot().treeExitProven,false);
  assert.equal(second.snapshot().executionAuthorized,false);
  assert.equal(second.snapshot().watchdog,false); assert.equal(second.snapshot().osIdentity,false);
  await sleep(30);
  assert.ok(fs.readdirSync("/dev/fd").length <= baseline);
  return { fdLeaks: 0, ...second.snapshot() };
}
run().then(result => console.log(JSON.stringify(result)),error => { console.error(error); process.exitCode=1; });
