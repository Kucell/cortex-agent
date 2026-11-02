"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),{spawnSync}=require("node:child_process");
const root=path.resolve(__dirname,"../.."),native=path.join(root,"packages/permit-witness-macos/native-anonymous"),fixture=path.join(__dirname,"fixtures");
const supported=process.platform==="darwin"&&process.arch==="arm64"&&os.release()==="27.0.0"&&spawnSync("/usr/bin/sw_vers",["-productVersion"],{encoding:"utf8"}).stdout?.trim()==="27.0.1";
function run(args){const r=spawnSync(args[0],args.slice(1),{encoding:"utf8",timeout:15000,env:{...process.env,ASAN_OPTIONS:"detect_leaks=0:abort_on_error=1"}});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;}
test("zero-timeout readiness avoids idle trace consumption and retains real syscall evidence",{timeout:90000,skip:!supported&&process.env.PERMIT_WITNESS_REQUIRE_ANONYMOUS_NATIVE!=="1"?"only verified macOS arm64":false},async t=>{
 assert.ok(supported);const build=fs.mkdtempSync(testRuntime("permit-witness-readiness-"));t.diagnostic(build);
 const flags=["-std=c11","-D_DARWIN_C_SOURCE","-Wall","-Wextra","-Werror","-Wno-unused-function","-Wno-unused-parameter","-Wframe-larger-than=16384","-O1","-g","-fsanitize=address,undefined","-fno-sanitize-recover=undefined","-fno-omit-frame-pointer","-I",native];
 const peer=path.join(build,"peer"),object=path.join(build,"native.o"),binary=path.join(build,"probe");
 run(["/usr/bin/xcrun","clang",...flags,path.join(fixture,"permit-witness-anonymous-peer.c"),"-o",peer]);
 run(["/usr/bin/xcrun","clang",...flags,"-DPW_ANONYMOUS_FIXTURE",`-DPW_FIXED_PEER_PATH=${JSON.stringify(peer)}`,"-Dread=pw_readiness_read","-Dpoll=pw_readiness_poll","-Dclock_gettime=pw_readiness_clock_gettime","-c",path.join(native,"anonymous.c"),"-o",object]);
 run(["/usr/bin/xcrun","clang",...flags,"-DPW_READINESS_HARNESS",object,path.join(fixture,"permit-witness-anonymous-readiness.c"),"-o",binary]);
 for(const mode of ["idle-two","race","read-eintr","poll-eintr","poll-system","nval","late","poll-error-event","unknown","mixed-unknown","trace-races"])await t.test(mode,()=>{const report=JSON.parse(run([binary,mode]));assert.equal(report.status,"OK");assert.equal(report.checkedBeforeRead,report.reads);t.diagnostic(JSON.stringify(report));});
 await t.test("real POLLIN|POLLHUP drains buffered frame before EOF",()=>{
  const peerHup=path.join(build,"peer-hup"),obj=path.join(build,"native-hup.o"),exe=path.join(build,"hup");
  run(["/usr/bin/xcrun","clang",...flags,'-DPW_PEER_MODE="hup-drain"',path.join(fixture,"permit-witness-anonymous-peer.c"),"-o",peerHup]);
  run(["/usr/bin/xcrun","clang",...flags,"-DPW_ANONYMOUS_FIXTURE",`-DPW_FIXED_PEER_PATH=${JSON.stringify(peerHup)}`,"-Dread=pw_readiness_read","-Dpoll=pw_readiness_poll","-Dclock_gettime=pw_readiness_clock_gettime","-c",path.join(native,"anonymous.c"),"-o",obj]);
  run(["/usr/bin/xcrun","clang",...flags,"-DPW_READINESS_HARNESS",obj,path.join(fixture,"permit-witness-anonymous-readiness.c"),"-o",exe]);
  const report=JSON.parse(run([exe,"hup-drain"]));assert.equal(report.bufferedHupReads,2);assert.equal(report.hupEofReads,1);assert.equal(report.terminal,"EOF");t.diagnostic(JSON.stringify(report));
 });
 await t.test("legacy ready failure records actual rc and second-session context",()=>{
  const obj=path.join(build,"diagnostic.o"),exe=path.join(build,"diagnostic");
  run(["/usr/bin/xcrun","clang",...flags,"-DPW_ANONYMOUS_FIXTURE",`-DPW_FIXED_PEER_PATH=${JSON.stringify(peer)}`,"-Dread=pw_ready_fault_read","-Dpoll=pw_ready_fault_poll","-c",path.join(native,"anonymous.c"),"-o",obj]);
  run(["/usr/bin/xcrun","clang",...flags,"-DPW_ANONYMOUS_FIXTURE",obj,path.join(fixture,"permit-witness-anonymous-harness.c"),path.join(fixture,"permit-witness-anonymous-ready-fault.c"),"-o",exe]);
  const r=spawnSync(exe,["quota"],{encoding:"utf8",timeout:10000,env:{ASAN_OPTIONS:"detect_leaks=0:abort_on_error=1"}});
  fs.writeFileSync(path.join(build,"expected-ready-failure.stderr"),r.stderr);assert.ifError(r.error);assert.equal(r.signal,"SIGABRT",r.stderr);
  const reports=r.stderr.split("\n").filter(s=>s.startsWith("{")).map(s=>JSON.parse(s));
  const failure=reports.find(x=>x.context==="ready-FD_OK"&&x.rc==="TRACE_LIMIT");assert.ok(failure,r.stderr);
  assert.equal(failure.session,2);assert.equal(failure.traceCount,256);assert.equal(failure.traceLimit,256);assert.ok(failure.remainingNs>0);assert.equal(failure.received,85);
  assert.ok(failure.lastReads.every(x=>x[4]===-35));assert.doesNotMatch(r.stderr,/ERROR: AddressSanitizer|runtime error:/);t.diagnostic(JSON.stringify({expectedAbort:true,...failure}));
 });
});
