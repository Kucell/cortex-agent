"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {spawnSync}=require("node:child_process");
const root=path.resolve(__dirname,"../.."),native=path.join(root,"packages/permit-witness-macos/native-anonymous"),fixtures=path.join(__dirname,"fixtures");
function run(file,args){const r=spawnSync(file,args,{encoding:"utf8",timeout:20000,maxBuffer:8*1024*1024,env:{...process.env,ASAN_OPTIONS:"detect_leaks=0:abort_on_error=1"}});assert.ifError(r.error);assert.equal(r.signal,null,r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;}
const locallyVerified=process.platform==="darwin" && process.arch==="arm64" && os.release()==="27.0.0";
const requireVerifiedPlatform=process.env.PERMIT_WITNESS_REQUIRE_ANONYMOUS_NATIVE==="1";
test("full v2 native profile capacity with precharged heap and quantum scheduling",{
  timeout:120000,
  skip:!locallyVerified && !requireVerifiedPlatform ? "only the verified Darwin arm64 runtime is supported" : false,
},async t=>{
  assert.equal(process.platform,"darwin");assert.equal(process.arch,"arm64");assert.equal(os.release(),"27.0.0");
  const build=fs.mkdtempSync(path.join(root,".agent/runtime/permit-witness-capacity-"));t.diagnostic(build);
  const flags=["-std=c11","-D_DARWIN_C_SOURCE","-Wall","-Wextra","-Werror","-Wframe-larger-than=16384","-Wno-unused-function","-Wno-unused-parameter","-O1","-g","-fsanitize=address,undefined","-fno-sanitize-recover=undefined","-fno-omit-frame-pointer","-I",native];
  const peer=path.join(build,"peer");
  run("/usr/bin/xcrun",["clang",...flags,"-DPW_CAPACITY_PEER",path.join(fixtures,"permit-witness-anonymous-peer.c"),path.join(fixtures,"permit-witness-anonymous-capacity-peer.c"),"-o",peer]);
  for(const mode of ["max-read","max-write","mixed","oversize-read","oversize-write","read-total","send-total","shared-read-total","shared-send-total","cumulative-read","cumulative-send","capacity","alloc-1","alloc-2","frames","send-frames","trace","default"])await t.test(mode,()=>{
    const extra=mode==="read-total"?["-DPW_FIXTURE_V2_READ_LIMIT=1048741"]:mode==="send-total"?["-DPW_FIXTURE_V2_SEND_LIMIT=1048752"]:
      mode==="shared-read-total"?["-DPW_FIXTURE_V2_READ_LIMIT=2097483"]:mode==="shared-send-total"?["-DPW_FIXTURE_V2_SEND_LIMIT=2097505"]:
      mode==="capacity"?["-DPW_FIXTURE_V2_CAPACITY_LIMIT=2097390"]:[];
    const object=path.join(build,`${mode}.o`),binary=path.join(build,mode);
    run("/usr/bin/xcrun",["clang",...flags,...extra,...(mode==="trace"?["-Dread=pw_readiness_read","-Dpoll=pw_readiness_poll"]:[]),...(mode==="default"?[]:["-DPW_ANONYMOUS_FIXTURE",`-DPW_FIXED_PEER_PATH=${JSON.stringify(peer)}`]),"-Dmalloc=pw_capacity_malloc","-c",path.join(native,"anonymous.c"),"-o",object]);
    run("/usr/bin/xcrun",["clang",...flags,...(mode==="trace"?["-DPW_READINESS_TEST",path.join(fixtures,"permit-witness-anonymous-readiness.c")]:[]),object,path.join(fixtures,"permit-witness-anonymous-capacity-harness.c"),"-o",binary]);
    const output=run(binary,[mode]);const report=JSON.parse(output);assert.equal(report.status,mode==="default"?"REFUSED":"OK");
    if(mode!=="default"){assert.equal(report.maxWireBytes,1048697);assert.ok(report.capacity<=4194780);}
    t.diagnostic(JSON.stringify({mode,...report}));
  });
});
