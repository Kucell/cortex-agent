"use strict";
const fs=require("node:fs");
const path=require("node:path");

const BOUND_RESOURCE = "D-M032-MS003-runtime-pilot-5f9b7e2a";
const BOUND_WAITPOINT = "WP-M032-MS003-runtime-pilot-5f9b7e2a";
const BOUND_SIGNAL = "ci-flaky-test-rate";
const BOUND_SCOPE = "non-production";
const BOUND_CAPABILITY = "diagnosis-or-proposal-only";
const BOUND_ENVIRONMENTS = ["ci-non-prod"];
const AUTHORITY_BOUNDARY = "This artifact is evidence-only. It does not authorize combining changes, releasing a version, writing to a remote, distributing artifacts, reading secrets, rolling out to environments, destructive actions, or any external side effect. Any such action requires a separate resource-bound Decision/Waitpoint.";

function fail(code, message, details, exit=2){process.stdout.write(JSON.stringify({ok:false,error:code,message,details})+String.fromCharCode(10));process.exit(exit);}

function readJson(file){try{return JSON.parse(fs.readFileSync(path.resolve(file),"utf8"));}catch(err){fail("invalid_input",err.message,{file},2);}}

function writeJson(file,value){if(!file)fail("output_required","Pass --output",undefined,2);const target=path.resolve(file);fs.mkdirSync(path.dirname(target),{recursive:true});const tmp=target+"."+process.pid+".tmp";fs.writeFileSync(tmp,JSON.stringify(value,null,2)+String.fromCharCode(10));fs.renameSync(tmp,target);}

function parseArgs(argv){const out={command:argv[0]};for(let i=1;i<argv.length;i++){if(!argv[i].startsWith("--"))continue;out[argv[i].slice(2)]=argv[i+1];i+=1;}return out;}

function boundHeader(agentIdentity, generatedAt, evidenceRefs, extra){return {decision_id:BOUND_RESOURCE,waitpoint_id:BOUND_WAITPOINT,signal:BOUND_SIGNAL,scope:BOUND_SCOPE,capability:BOUND_CAPABILITY,environments:[...BOUND_ENVIRONMENTS],agent_identity:agentIdentity,allowed_tools:[],message_route:"none",evidence_refs:[...new Set(evidenceRefs||[])],authority_boundary:AUTHORITY_BOUNDARY,generated_at:generatedAt,...(extra||{})};}
function logAndExit(code,details){process.stdout.write(JSON.stringify({ok:false,error:code,details})+String.fromCharCode(10));process.exit(2);}

function detect(input){if(!input||typeof input!=="object")fail("input_required","Pass --input <ci-runs.json>",undefined,2);if(!Array.isArray(input.runs))fail("runs_required","input.runs must be an array",undefined,2);if(!input.generated_at)fail("generated_at_required","input.generated_at must be set",undefined,2);if(!input.agent_identity)fail("agent_identity_required","input.agent_identity must be set",undefined,2);
  const totals={runs:0,tests:0,flaky:0};const tests=new Map();
  for(const run of input.runs){if(!run.test_id)fail("test_id_required","each run must declare test_id",undefined,2);const key=run.test_id;const bucket=tests.get(key)||{test_id:key,attempts:0,failures:0};bucket.attempts+=1;if(run.outcome==="fail")bucket.failures+=1;tests.set(key,bucket);totals.runs+=1;}
  const flakyTests=[];for(const t of tests.values()){if(t.attempts>=2&&t.failures>0&&t.failures<t.attempts){flakyTests.push(t.test_id);totals.flaky+=1;}}
  totals.tests=tests.size;
  const rate=totals.tests?(totals.flaky*10000)/totals.tests:0;
  const trigger={type:"runtime_feedback_trigger",metrics:{flaky_test_count:totals.flaky,total_test_count:totals.tests,flaky_rate_basis_points:Math.round(rate),runs_analyzed:totals.runs,threshold_basis_points:200},affected_tests:flakyTests,remediation_options:[],...boundHeader(input.agent_identity,input.generated_at,input.evidence_refs||[])};
  return trigger;
}

function diagnose(input){if(!input||input.type!=="runtime_feedback_trigger")fail("trigger_required","--trigger must reference a runtime_feedback_trigger artifact",undefined,2);if(input.decision_id!==BOUND_RESOURCE)fail("decision_mismatch",input.decision_id,undefined,2);if(input.waitpoint_id!==BOUND_WAITPOINT)fail("waitpoint_mismatch",input.waitpoint_id,undefined,2);
  const sev=input.metrics.flaky_rate_basis_points>=4000?"high":input.metrics.flaky_rate_basis_points>=200?"medium":"low";
  return {type:"runtime_diagnosis",severity:sev,affected_tests:input.affected_tests,remediation_options:["Inspect last failing jobs for shared infrastructure flake.","Add explicit retry/timeout/quarantine annotation to the affected tests.","File a follow-up Task for stabilization once approved by a human decision."],...boundHeader(input.agent_identity,input.generated_at,[input.evidence_refs[0]||"trigger:ci-flaky-test-rate","diagnosis:"+String(input.generated_at||Date.now())])};
}

function proposal(input){if(!input||input.type!=="runtime_diagnosis")fail("diagnosis_required","--diagnosis must reference a runtime_diagnosis artifact",undefined,2);if(input.decision_id!==BOUND_RESOURCE)fail("decision_mismatch",input.decision_id,undefined,2);if(input.waitpoint_id!==BOUND_WAITPOINT)fail("waitpoint_mismatch",input.waitpoint_id,undefined,2);if(Array.isArray(input.allowed_tools)&&input.allowed_tools.length>0)fail("allowed_tools_forbidden","diagnostic identity cannot carry any allowed_tools",undefined,2);if(input.message_route!=="none")fail("message_route_forbidden","message_route must remain none",undefined,2);
  return {type:"runtime_proposal",spec_draft:{title:"Stabilize flaky CI tests for "+input.affected_tests.join(", "),summary:"Create a follow-up task that quarantines or fixes the reported tests without changing any authority bound to MS-003.",risk_tier:"medium"},follow_up_task_draft:{suggested_id:"T-CI-FLAKY-"+Date.now().toString(36),rationale:"Triggered by MS-003 pilot; remains a draft until human review."},...boundHeader(input.agent_identity,input.generated_at,[input.evidence_refs[0]||"diagnosis:"+String(input.generated_at||Date.now()),"proposal:"+String(input.generated_at||Date.now())])};
}

const args=parseArgs(process.argv.slice(2));
let value;
if(args.command==="detect")value=detect(readJson(args.input));
else if(args.command==="diagnose")value=diagnose(readJson(args.trigger));
else if(args.command==="proposal")value=proposal(readJson(args.diagnosis));
else fail("unknown_command",args.command,undefined,2);
writeJson(args.output,value);
process.stdout.write(JSON.stringify({ok:true,output:path.resolve(args.output),type:value.type})+String.fromCharCode(10));
