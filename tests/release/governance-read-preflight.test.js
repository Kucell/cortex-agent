"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {probe}=require("../../scripts/release/governance-read-preflight.cjs");
const docs=[
  {decision_id:"D-release-1.15.0-eca99a7c"},
  {waitpoint_id:"WP-release-1.15.0-eca99a7c"}
];
const response=(record)=>({ok:true,async json(){return {type:"file",encoding:"base64",content:Buffer.from(JSON.stringify(record)).toString("base64")}}});
test("reads expected immutable historical records without leaking content",async()=>{
  let index=0;
  const result=await probe("FAKE_TOKEN",async(url,opts)=>{
    assert.match(url,/https:\/\/api\.github\.com\/repos\/Kucell\/cortex-agent-agent\/contents\//);
    assert.equal(opts.redirect,"error");
    assert.equal(opts.headers.Authorization,"Bearer FAKE_TOKEN");
    return response(docs[index++]);
  });
  assert.equal(index,2);
  assert.deepEqual(result,{read_only_access_verified:true,record_count:2});
  assert.doesNotMatch(JSON.stringify(result),/FAKE_TOKEN|D-release-/);
});
test("missing secret fails closed",async()=>{
  await assert.rejects(()=>probe(""),/SECRET_MISSING/);
});
test("missing authorization fails closed",async()=>{
  for(const status of [401,403,404]){
    await assert.rejects(()=>probe("FAKE",async()=>({ok:false,status})),/PRIVATE_CONTENT_READ_DENIED/);
  }
});
test("invalid or mismatched record fails closed",async()=>{
  await assert.rejects(()=>probe("FAKE",async()=>response({decision_id:"WRONG"})),/RECORD_ID_MISMATCH/);
  await assert.rejects(()=>probe("FAKE",async()=>({ok:true,async json(){return {type:"dir"}}})),/PRIVATE_CONTENT_UNREADABLE/);
});
test("network error cannot reveal token",async()=>{
  let error;
  try{await probe("SECRET_HIDDEN",async()=>{throw Error("SECRET_HIDDEN");});}catch(e){error=e;}
  assert.equal(error.code,"PRIVATE_API_UNAVAILABLE");
  assert.doesNotMatch(error.message,/SECRET_HIDDEN/);
});
