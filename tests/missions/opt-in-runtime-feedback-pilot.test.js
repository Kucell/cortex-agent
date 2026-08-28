"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {spawnSync}=require("node:child_process");
const test=require("node:test");

const ROOT=path.resolve(__dirname,"..","..");
const SCRIPT=path.join(ROOT,".agent/skills/opt-in-runtime-feedback-pilot/scripts/index.js");
const CI_FIXTURE={
  agent_identity:"pilot-agent@ms003",
  generated_at:"2026-08-27T10:10:00.000Z",
  evidence_refs:["ci-runs:fixture-A"],
  runs:[
    {test_id:"t-a",outcome:"pass"},{test_id:"t-a",outcome:"fail"},
    {test_id:"t-b",outcome:"pass"},{test_id:"t-b",outcome:"pass"},
    {test_id:"t-c",outcome:"fail"},{test_id:"t-c",outcome:"pass"},
    {test_id:"t-d",outcome:"fail"},{test_id:"t-d",outcome:"fail"}
  ]
};

function tempDir(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"m032-ms003-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

function run(cmd,args){const out=spawnSync(process.execPath,[SCRIPT,cmd,...args],{encoding:"utf8"});return out;}

test("detect -> diagnose -> proposal chain binds to MS-003 resource and stays read-only",(t)=>{
  const dir=tempDir(t);
  const detect=run("detect",["--input",path.join(dir,"runs.json"),"--output",path.join(dir,"trigger.json")]);
  fs.writeFileSync(path.join(dir,"runs.json"),JSON.stringify(CI_FIXTURE));
  const detect2=run("detect",["--input",path.join(dir,"runs.json"),"--output",path.join(dir,"trigger.json")]);
  assert.equal(detect2.status,0,detect2.stderr);
  const trigger=JSON.parse(fs.readFileSync(path.join(dir,"trigger.json"),"utf8"));
  assert.equal(trigger.type,"runtime_feedback_trigger");
  assert.equal(trigger.decision_id,"D-M032-MS003-runtime-pilot-5f9b7e2a");
  assert.equal(trigger.waitpoint_id,"WP-M032-MS003-runtime-pilot-5f9b7e2a");
  assert.equal(trigger.capability,"diagnosis-or-proposal-only");
  assert.deepEqual(trigger.allowed_tools,[]);
  assert.equal(trigger.message_route,"none");
  assert.ok(/does not authorize/i.test(trigger.authority_boundary));
  assert.deepEqual(trigger.affected_tests.sort(),["t-a","t-c"]);
  const diagnose=run("diagnose",["--trigger",path.join(dir,"trigger.json"),"--output",path.join(dir,"diagnosis.json")]);
  assert.equal(diagnose.status,0,diagnose.stderr);
  const diagnosis=JSON.parse(fs.readFileSync(path.join(dir,"diagnosis.json"),"utf8"));
  assert.equal(diagnosis.type,"runtime_diagnosis");
  assert.equal(diagnosis.severity,"high");
  const proposal=run("proposal",["--diagnosis",path.join(dir,"diagnosis.json"),"--output",path.join(dir,"proposal.json")]);
  assert.equal(proposal.status,0,proposal.stderr);
  const proposalDoc=JSON.parse(fs.readFileSync(path.join(dir,"proposal.json"),"utf8"));
  assert.equal(proposalDoc.type,"runtime_proposal");
  for(const doc of [trigger,diagnosis,proposalDoc]){
    for(const forbidden of ["merge","release","publish","deploy","credential","push","pushing"]){
      assert.ok(!JSON.stringify(doc).toLowerCase().includes(forbidden),
        forbidden+" leaked into "+doc.type);
    }
  }
});

test("pilot is fail-closed against wrong decision_id or unsupported signals",(t)=>{
  const dir=tempDir(t);
  fs.writeFileSync(path.join(dir,"runs.json"),JSON.stringify(CI_FIXTURE));
  const detect=run("detect",["--input",path.join(dir,"runs.json"),"--output",path.join(dir,"trigger.json")]);
  assert.equal(detect.status,0);
  const trigger=JSON.parse(fs.readFileSync(path.join(dir,"trigger.json"),"utf8"));
  trigger.decision_id="D-evil-decision";
  fs.writeFileSync(path.join(dir,"trigger-bad.json"),JSON.stringify(trigger));
  const diagnose=run("diagnose",["--trigger",path.join(dir,"trigger-bad.json"),"--output",path.join(dir,"diagnosis.json")]);
  assert.equal(diagnose.status,2,didame_err(diagnose));
  assert.match(diagnose.stdout,/decision_mismatch/);
  const diagnoseMissing=run("diagnose",["--trigger",path.join(dir,"trigger.json"),"--output",path.join(dir,"diagnosis.json")]);
  assert.equal(diagnoseMissing.status,0,JSON.stringify(diagnoseMissing));
  fs.writeFileSync(path.join(dir,"bad-proposal.json"),JSON.stringify({type:"runtime_diagnosis",decision_id:"D-M032-MS003-runtime-pilot-5f9b7e2a",waitpoint_id:"WP-M032-MS003-runtime-pilot-5f9b7e2a",agent_identity:"pilot",allowed_tools:["write"],message_route:"none",evidence_refs:["x"],authority_boundary:"a",affected_tests:["t-z"],generated_at:"2026-08-27T10:10:00.000Z",severity:"low",remediation_options:["r"]}));
  const proposal=run("proposal",["--diagnosis",path.join(dir,"bad-proposal.json"),"--output",path.join(dir,"out.json")]);
  assert.equal(proposal.status,2,JSON.stringify(proposal));
});

function didame_err(r){return r.stdout+r.stderr;}
