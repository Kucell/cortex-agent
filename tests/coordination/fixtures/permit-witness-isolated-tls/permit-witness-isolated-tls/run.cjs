"use strict";

// Standalone runner. All build/cache/log/keychain output stays in .agent.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { realUserHome, childEnvironment, directoryIdentity, cleanupAfterExit } = require("./runtime.cjs");
const root = path.resolve(__dirname, "../../../..");
const source = path.join(__dirname, "IsolatedTLS.swift");
const base = path.join(root, ".agent/runtime/permit-witness-isolated-tls");
fs.mkdirSync(base, {recursive:true});
const run = fs.mkdtempSync(path.join(base, "run-"));
const identity = directoryIdentity(run, base);
for (const dir of ["tmp", "cache", "logs"]) fs.mkdirSync(path.join(run, dir), {mode:0o700});
const env = childEnvironment(run);
const report = {scope:"single-machine-loopback-test-only", runtime:run, platform:process.platform,
  independent_witness_verified:false, windows_schannel_verified:false, production_policy_verified:false,
  actual_tls_verified:false, source_sha256:crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex")};
const writeReport = () => fs.writeFileSync(path.join(run,"summary.json"),JSON.stringify(report,null,2)+"\n");
let active = null, terminated = null;
function stop(signal) {
  terminated ||= signal;
  active?.stop();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
async function child(command,args,label,timeout=45000) {
  assert.equal(terminated, null, "runner terminated");
  return await new Promise(resolve => {
    const processChild = spawn(command,args,{cwd:root,env,detached:true,stdio:["ignore","pipe","pipe"]});
    let stdout = "", stderr = "", error, forced = false, escalation;
    const killGroup = signal => {
      try { process.kill(-processChild.pid, signal); } catch (e) { if (e.code !== "ESRCH") error = e; }
    };
    const terminate = () => {
      if (escalation) return;
      killGroup("SIGTERM");
      escalation = setTimeout(() => { forced = true; killGroup("SIGKILL"); }, 10000);
    };
    active = {stop:terminate};
    const timer = setTimeout(() => { error = Error("child deadline"); terminate(); }, timeout);
    processChild.stdout.on("data", data => { stdout += data; if (stdout.length > 4*1024*1024) terminate(); });
    processChild.stderr.on("data", data => { stderr += data; if (stderr.length > 4*1024*1024) terminate(); });
    processChild.on("error", e => { error = e; });
    processChild.on("close", (status, signal) => {
      clearTimeout(timer); clearTimeout(escalation); active = null;
      fs.writeFileSync(path.join(run,`logs/${label}.stdout`),stdout);
      fs.writeFileSync(path.join(run,`logs/${label}.stderr`),`${stderr}${error||""}`);
      report.children ||= []; report.children.push({label,status,signal,forced});
      resolve({status:error?null:status,signal,stdout,stderr,error});
    });
  });
}
async function main() {
try {
  assert.equal(process.platform,"darwin","BLOCKED: fixture requires macOS Security/Network.framework");
  assert.ok(fs.existsSync("/usr/bin/sandbox-exec"),"BLOCKED: loopback filesystem sandbox unavailable");
  const home = realUserHome(); // Resolve/validate before any compiler or TLS child starts.
  const profile=path.join(run,"loopback.sb"), quote=JSON.stringify;
  fs.writeFileSync(profile,["(version 1)","(allow default)","(deny network*)",
    '(allow network-outbound (remote ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-bind (local ip "localhost:*"))',
    "(deny file-write*)",`(allow file-write* (subpath ${quote(run)}))`,
    '(allow file-write-data (literal "/dev/null"))',
    `(deny file-read* file-write* (subpath ${quote(path.join(home,"Library/Keychains"))}) `+
      '(subpath "/Library/Keychains") (subpath "/System/Library/Keychains"))',""].join("\n"));
  console.log(JSON.stringify({event:"runtime-created",runtime:run}));
  const version=await child("/usr/bin/xcrun",["swiftc","--version"],"toolchain");
  assert.equal(version.status,0,"BLOCKED: Swift compiler unavailable");report.swift=version.stdout.trim();
  const executable=path.join(run,"isolated-tls");
  const build=await child("/usr/bin/xcrun",["swiftc","-parse-as-library","-swift-version","6","-module-cache-path",
    path.join(run,"cache"),source,"-o",executable],"build",120000);
  assert.equal(build.status,0,`fixture build failed: ${build.stderr}`);
  const extra = process.argv.includes("--test-hold-after-create") ? ["--test-hold-after-create"] : [];
  const result=await child("/usr/bin/sandbox-exec",["-f",profile,executable,run,...extra],"tls");
  assert.equal(terminated,null,"runner terminated");
  const rows=(result.stdout||"").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));
  report.events=rows;
  const stopped=rows.find(row=>["blocked","failed"].includes(row.event));
  assert.equal(result.status,0,`${stopped?.event||"failed"}: ${stopped?.reason||result.stderr||result.error}`);
  const keys=rows.filter(row=>row.event==="key-attribute-check");
  assert.equal(keys.length,3);assert.ok(keys.every(row=>row.extractable===false&&row.permanent===true));
  assert.equal(rows.filter(row=>row.event==="key-container-check"&&row.matches_new_container===true).length,3);
  const cases=rows.filter(row=>row.case);
  assert.deepEqual(cases.map(row=>row.case),["valid-mutual","wrong-server-pin","wrong-client-pin","missing-client"]);
  assert.ok(cases.every(row=>row.status==="pass"));
  const positive=cases[0];assert.equal(positive.request_bytes,24);assert.equal(positive.response_bytes,25);
  const ready=positive.events.filter(row=>row.event==="tls-ready");
  assert.deepEqual(new Set(ready.map(row=>row.detail.side)),new Set(["client","server"]));
  assert.ok(ready.every(row=>row.detail.tls==="1.3"));
  for(const event of ["request-sent-without-half-close","request-received-without-eof","response-received-without-eof"])
    assert.ok(positive.events.some(row=>row.event===event),event);
  for(const negative of cases.slice(1)){
    assert.equal(negative.request_bytes,0);assert.equal(negative.response_bytes,0);
    assert.ok(negative.events.some(row=>row.event==="expected-authentication-rejection"));
  }
  assert.ok(rows.some(row=>row.event==="test-keychain-cleanup"&&row.status===0),"test keychain cleanup failed");
  assert.ok(!fs.readdirSync(run).some(file=>file.includes("keychain")),"temporary keychain file remains");
  report.status="pass";report.actual_tls_verified=true;report.cases_passed=cases.length;
  report.private_key_storage="new-explicit-nonextractable-keychain-deleted";
  report.certificate_storage="process-memory-only";
} catch(error) {
  report.status="blocked-or-failed";report.reason=String(error.message||error);
  process.exitCode=1;
} finally {
  report.termination_signal=terminated;
  try { report.residual_cleanup=await cleanupAfterExit(run,base,identity); }
  catch(error) { report.status="cleanup-failed";report.cleanup_error=error.message;process.exitCode=1; }
  if (terminated) {
    if (!report.cleanup_error) report.status="terminated";
    process.exitCode=terminated==="SIGTERM"?143:130;
  }
  writeReport();console.log(JSON.stringify({status:report.status,cases_passed:report.cases_passed,runtime:run}));
  process.removeAllListeners("SIGTERM");process.removeAllListeners("SIGINT");
}
}
main().catch(error => { console.error(error);process.exitCode=1; });
