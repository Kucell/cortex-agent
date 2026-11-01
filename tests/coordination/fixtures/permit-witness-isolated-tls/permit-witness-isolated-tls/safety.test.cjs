"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const {spawn} = require("node:child_process");
const {realUserHome,childEnvironment,directoryIdentity,cleanupResiduals,cleanupAfterExit} = require("./runtime.cjs");
const root=path.resolve(__dirname,"../../../.."),base=path.join(root,".agent/runtime/permit-witness-isolated-tls");
fs.mkdirSync(base,{recursive:true});
const evidence=fs.mkdtempSync(path.join(base,"run-safety-"));
function directory() {
  const run=fs.mkdtempSync(path.join(base,"run-safety-case-"));
  for(const dir of ["tmp","cache","logs"])fs.mkdirSync(path.join(run,dir));
  return run;
}
function launch(command,args,env,onLine) {
  const child=spawn(command,args,{cwd:root,env,stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="",pending="";
  child.stdout.on("data",data=>{
    stdout+=data;pending+=data;let index;
    while((index=pending.indexOf("\n"))>=0){
      const line=pending.slice(0,index);pending=pending.slice(index+1);
      if(onLine)onLine(line,child);
    }
  });
  child.stderr.on("data",data=>{stderr+=data;});
  const completion=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>child.kill("SIGKILL"),60000);
    child.on("error",reject);
    child.on("close",(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
  });
  return {child,completion};
}
const parse=text=>text.trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));
test("isolated TLS environment and termination safety",{skip:process.platform!=="darwin",timeout:180000},async t=>{
  let successfulRun;
  await t.test("OS home lookup fails closed without an environment fallback",()=>{
    const lookup=os.userInfo, original=lookup(), home=process.env.HOME;
    process.env.HOME=evidence;
    try {
      assert.equal(realUserHome(),original.homedir);
      for(const replacement of [()=>{throw Error("lookup unavailable");},
        ()=>({...original,uid:original.uid+1}),()=>({...original,homedir:""}),
        ()=>({...original,homedir:"/"}),()=>({...original,homedir:"relative"}),
        ()=>({...original,homedir:path.join(evidence,"nonexistent")})]){
        os.userInfo=replacement;assert.throws(()=>realUserHome());
      }
    } finally {os.userInfo=lookup;if(home===undefined)delete process.env.HOME;else process.env.HOME=home;}
  });
  await t.test("forged HOME and parent credential/loader/proxy/developer sentinels cannot weaken isolation",async()=>{
    const sentinel=crypto.randomBytes(20).toString("hex"),keylog=path.join(evidence,"sentinel-keylog");
    const actualHome=realUserHome(),fakeHome=path.join(evidence,"forged-home");fs.mkdirSync(fakeHome);
    const env={...childEnvironment(evidence),PERMIT_TLS_SECRET_SENTINEL:sentinel,AWS_SECRET_ACCESS_KEY:sentinel,
      HOME:fakeHome,USERPROFILE:fakeHome,
      SSLKEYLOGFILE:keylog,HTTPS_PROXY:"http://127.0.0.1:9",DEVELOPER_DIR:path.join(evidence,"invalid-developer"),
      DYLD_LIBRARY_PATH:path.join(evidence,"invalid-libraries"),NODE_OPTIONS:"--no-warnings"};
    const result=await launch(process.execPath,[path.join(__dirname,"run.cjs")],env).completion;
    fs.writeFileSync(path.join(evidence,"sentinel-run.json"),JSON.stringify(result,null,2));
    assert.equal(result.code,0,result.stderr+result.stdout);
    const end=parse(result.stdout).at(-1);successfulRun=end.runtime;
    const summary=JSON.parse(fs.readFileSync(path.join(successfulRun,"summary.json")));
    const profile=fs.readFileSync(path.join(successfulRun,"loopback.sb"),"utf8");
    const actualRule=`(subpath ${JSON.stringify(path.join(actualHome,"Library/Keychains"))})`;
    assert.ok(profile.includes(`(deny file-read* file-write* ${actualRule}`));
    assert.equal(profile.includes(path.join(fakeHome,"Library/Keychains")),false);
    fs.writeFileSync(path.join(evidence,"forged-home.json"),JSON.stringify({fakeHome,actualHome,
      actual_keychain_deny_present:true,checks_only_profile_no_keychain_access:true},null,2));
    assert.equal(summary.actual_tls_verified,true);assert.equal(summary.cases_passed,4);
    const check=summary.events.find(row=>row.event==="environment-check");assert.equal(check.status,"pass");
    assert.deepEqual(check.keys.filter(key=>key!=="__CF_USER_TEXT_ENCODING").sort(),Object.keys(childEnvironment(successfulRun)).sort());
    for(const file of fs.readdirSync(path.join(successfulRun,"logs"))){
      assert.equal(fs.readFileSync(path.join(successfulRun,"logs",file),"utf8").includes(sentinel),false);
    }
    assert.equal(fs.existsSync(keylog),false);
  });
  await t.test("SIGTERM at create-start waits for create to return then deletes only the new container",async()=>{
    assert.ok(successfulRun);
    const run=directory(),identity=directoryIdentity(run,base),profile=path.join(run,"loopback.sb");
    fs.writeFileSync(profile,fs.readFileSync(path.join(successfulRun,"loopback.sb"),"utf8").replaceAll(successfulRun,run));
    let sent=false;
    const result=await launch("/usr/bin/sandbox-exec",["-f",profile,path.join(successfulRun,"isolated-tls"),run,"--test-hold-after-create"],
      childEnvironment(run),(line,child)=>{
        const row=JSON.parse(line);if(row.event==="keychain-create-start"&&!sent){sent=true;child.kill("SIGTERM");}
      }).completion;
    const leftovers=fs.readdirSync(run).filter(name=>name.startsWith("test-only.keychain"));
    const fallback=await cleanupAfterExit(run,base,identity);
    fs.writeFileSync(path.join(evidence,"direct-create-sigterm.json"),JSON.stringify({sent,run,leftovers,fallback,...result},null,2));
    assert.equal(sent,true);assert.equal(result.code,143);assert.equal(result.signal,null);
    assert.deepEqual(leftovers,[],"cooperative SIGTERM must not need file fallback");
    const rows=parse(result.stdout);
    assert.ok(rows.some(row=>row.event==="keychain-create-return"&&row.status===0));
    assert.ok(rows.some(row=>row.event==="test-keychain-cleanup"&&row.status===0));
    assert.ok(rows.some(row=>row.event==="terminated"&&row.signal===15));
    assert.equal(rows.some(row=>row.event==="managed-key-preflight"),false);
    assert.deepEqual(fs.readdirSync(run).filter(name=>name.includes("keychain")),[]);
  });
  await t.test("runner SIGTERM when first creation file appears forwards, waits and verifies residue",async()=>{
    let run,sent=false,poll;
    const launched=launch(process.execPath,[path.join(__dirname,"run.cjs"),"--test-hold-after-create"],childEnvironment(evidence),line=>{
      const row=JSON.parse(line);
      if(row.event==="runtime-created"){
        run=row.runtime;
        poll=setInterval(()=>{
          if(!sent&&fs.readdirSync(run).some(name=>name.startsWith("test-only.keychain"))){sent=true;launched.child.kill("SIGTERM");}
        },2);
      }
    });
    const result=await launched.completion;clearInterval(poll);
    fs.writeFileSync(path.join(evidence,"runner-create-sigterm.json"),JSON.stringify({sent,run,...result},null,2));
    assert.equal(sent,true);assert.equal(result.code,143);
    const summary=JSON.parse(fs.readFileSync(path.join(run,"summary.json")));
    assert.equal(summary.status,"terminated");assert.equal(summary.actual_tls_verified,false);
    assert.deepEqual(summary.residual_cleanup.remaining,[]);
    const child=summary.children.find(row=>row.label==="tls");
    assert.equal(child.forced,false);assert.equal(child.status,143);
    assert.deepEqual(fs.readdirSync(run).filter(name=>name.includes("keychain")),[]);
  });
  await t.test("abrupt child kill leaves only this run's container for bounded post-exit file cleanup",async()=>{
    const run=directory(),identity=directoryIdentity(run,base),profile=path.join(run,"loopback.sb");
    fs.writeFileSync(profile,fs.readFileSync(path.join(successfulRun,"loopback.sb"),"utf8").replaceAll(successfulRun,run));
    const result=await launch("/usr/bin/sandbox-exec",["-f",profile,path.join(successfulRun,"isolated-tls"),run,"--test-hold-after-create"],
      childEnvironment(run),(line,child)=>{if(JSON.parse(line).event==="keychain-create-return")child.kill("SIGKILL");}).completion;
    assert.equal(result.signal,"SIGKILL");
    const before=fs.readdirSync(run).filter(name=>name.startsWith("test-only.keychain"));assert.ok(before.length);
    const cleaned=await cleanupAfterExit(run,base,identity);
    fs.writeFileSync(path.join(evidence,"post-kill-cleanup.json"),JSON.stringify({run,before,cleaned,...result},null,2));
    assert.ok(cleaned.removed.length);assert.deepEqual(cleaned.remaining,[]);
  });
  await t.test("cleanup rejects links, unknown suffixes and another run; preserves unrelated sentinels",()=>{
    const run=directory(),sibling=directory(),identity=directoryIdentity(run,base);
    const canary=path.join(sibling,"test-only.keychain-db"),file=path.join(run,"test-only.keychain-db");
    fs.writeFileSync(canary,"unrelated sentinel");
    fs.symlinkSync(canary,file);assert.throws(()=>cleanupResiduals(run,base,identity));fs.unlinkSync(file);
    fs.linkSync(canary,file);assert.throws(()=>cleanupResiduals(run,base,identity));fs.unlinkSync(file);
    const unknown=path.join(run,"test-only.keychain-db.unrecognized");fs.writeFileSync(unknown,"sentinel");
    assert.throws(()=>cleanupResiduals(run,base,identity));assert.ok(fs.existsSync(unknown));fs.unlinkSync(unknown);
    fs.writeFileSync(file,"test residue");fs.writeFileSync(file+".sb-abc-123","test sidecar");
    assert.throws(()=>cleanupResiduals(sibling,base,identity));
    const result=cleanupResiduals(run,base,identity);assert.equal(result.removed.length,2);
    assert.equal(fs.readFileSync(canary,"utf8"),"unrelated sentinel");fs.unlinkSync(canary);
    fs.writeFileSync(path.join(evidence,"scope-check.json"),JSON.stringify({status:"pass",result},null,2));
  });
  t.diagnostic(`retained safety evidence: ${evidence}`);
});
