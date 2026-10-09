"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCommand, hasIndependentApproval, validateGovernance, verifyApproval } = require("../../scripts/release/verify-approved-release.cjs");
const sha = "a".repeat(40);
const decision = {decision_id:"D-release-1",type:"approval",status:"approved",selected_option:"approve",resolved_by:"interactive-user",workflow_gate:"user",resolved_at:"2026-10-09T06:00:00Z",gate:{action:"release",resource_ref:"release:cortex-agent@"+sha}};
const waitpoint = {waitpoint_id:"WP-release-1",status:"released",decision_id:"D-release-1",released_by:"/release",workflow_gate:"owner",released_at:"2026-10-09T06:05:00Z",gate:{action:"release",resource_ref:"release:cortex-agent@"+sha}};
const pr = {number:51,merged:true,base:{ref:"main"},merge_commit_sha:sha,user:{login:"Kucell"},head:{sha:"b".repeat(40)}};
const reviews = [{state:"APPROVED",user:{login:"separate-reviewer"},commit_id:pr.head.sha}];
const event = {action:"created",issue:{number:51,pull_request:{}},sender:{login:"Kucell"},comment:{user:{login:"Kucell"},author_association:"OWNER",body:"/cortex-release publish v1.15.4 decision=D-release-1 waitpoint=WP-release-1"}};
const ok = data => ({ok:true,status:200,async json(){return data;}});
const b64 = data => ({encoding:"base64",content:Buffer.from(JSON.stringify(data)).toString("base64")});
function http(uri) {
  if (uri.includes("/pulls/51/files")) return Promise.resolve(ok([{filename:"package.json",status:"modified"},{filename:"CHANGELOG.md",status:"modified"}]));
  if (uri.includes("/pulls/51/reviews")) return Promise.resolve(ok(reviews));
  if (uri.endsWith("/pulls/51")) return Promise.resolve(ok(pr));
  if (uri.endsWith("/git/ref/heads/main")) return Promise.resolve(ok({object:{sha}}));
  if (uri.includes("/decisions/")) return Promise.resolve(ok(b64(decision)));
  if (uri.includes("/waitpoints/")) return Promise.resolve(ok(b64(waitpoint)));
  throw new Error("unexpected request");
}
const opts=()=>({event,repo:"Kucell/cortex-agent",mainSha:sha,packageVersion:"1.15.4",repoToken:"test",governanceToken:"test",http});
test("strict command parser disallows missing/ambiguous request",()=>{
 assert.equal(parseCommand(event.comment.body).version,"1.15.4");
 assert.throws(()=>parseCommand("/cortex-release publish v1.15.4"));
 assert.throws(()=>parseCommand(event.comment.body+"; rm -rf ."));
});
test("governance Decision and Waitpoint are exact HEAD bound",()=>{
 assert.equal(validateGovernance(decision,waitpoint,sha),"release:cortex-agent@"+sha);
 assert.throws(()=>validateGovernance({...decision,status:"open"},waitpoint,sha));
 assert.throws(()=>validateGovernance(decision,{...waitpoint,status:"pending"},sha));
 assert.throws(()=>validateGovernance(decision,waitpoint,"c".repeat(40)));
 assert.throws(()=>validateGovernance(decision,{...waitpoint,expires_at:"2026-01-01T00:00:00Z"},sha));
});
test("self-review, stale review and final changes-requested review fail",()=>{
 assert.equal(hasIndependentApproval(pr,reviews),true);
 assert.equal(hasIndependentApproval(pr,[{...reviews[0],user:{login:"Kucell"}}]),false);
 assert.equal(hasIndependentApproval(pr,[{...reviews[0],commit_id:sha}]),false);
 assert.equal(hasIndependentApproval(pr,[...reviews,{...reviews[0],state:"CHANGES_REQUESTED"}]),false);
});
test("unresolved changes request from different reviewer blocks even if one approval exists",()=>{
 assert.equal(hasIndependentApproval(pr,[...reviews,{state:"CHANGES_REQUESTED",user:{login:"security-reviewer"},commit_id:pr.head.sha}]),false);
 assert.equal(hasIndependentApproval(pr,[...reviews,{state:"CHANGES_REQUESTED",user:{login:"separate-reviewer"},commit_id:pr.head.sha}]),false);
});
test("governance actor, workflow and expiry proofs fail closed",()=>{
 assert.throws(()=>validateGovernance({...decision,resolved_by:"model"},waitpoint,sha));
 assert.throws(()=>validateGovernance({...decision,workflow_gate:"mission"},waitpoint,sha));
 assert.throws(()=>validateGovernance({...decision,resolved_at:"not-a-time"},waitpoint,sha));
 assert.throws(()=>validateGovernance(decision,{...waitpoint,released_by:"github-comment"},sha));
 assert.throws(()=>validateGovernance(decision,{...waitpoint,workflow_gate:"user"},sha));
 assert.throws(()=>validateGovernance(decision,{...waitpoint,expires_at:"not-a-time"},sha));
});
test("exact version, SHA, independent reviewer and governance gate pass",async()=>{
 assert.deepEqual(await verifyApproval(opts()),{version:"1.15.4",sha,pr:51});
});
test("nonowner, missing governance token, drift and unmerged PR fail closed",async()=>{
 await assert.rejects(()=>verifyApproval({...opts(),event:{...event,sender:{login:"attacker"}}}));
 await assert.rejects(()=>verifyApproval({...opts(),governanceToken:null}));
 await assert.rejects(()=>verifyApproval({...opts(),packageVersion:"1.15.5"}));
 await assert.rejects(()=>verifyApproval({...opts(),mainSha:"c".repeat(40)}));
 await assert.rejects(()=>verifyApproval({...opts(),http:uri=>uri.endsWith("/pulls/51")?Promise.resolve(ok({...pr,merged:false})):http(uri)}));
});

test("missing release files or active review objection block release",async()=>{
 await assert.rejects(()=>verifyApproval({...opts(),http:uri=>{
   if(uri.includes("/pulls/51/files"))return Promise.resolve(ok([{filename:"package.json"}]));
   return http(uri);
 }}));
 await assert.rejects(()=>verifyApproval({...opts(),http:uri=>{
   if(uri.includes("/pulls/51/reviews"))return Promise.resolve(ok([...reviews,{state:"CHANGES_REQUESTED",user:{login:"security-reviewer"},commit_id:pr.head.sha}]));
   return http(uri);
 }}));
});
