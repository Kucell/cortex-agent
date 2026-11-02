"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {spawnSync}=require("node:child_process");
const root=path.resolve(__dirname,"../.."),native=path.join(root,"packages/permit-witness-macos/native-anonymous"),fixtures=path.join(__dirname,"fixtures");
const version=process.platform==="darwin"?spawnSync("/usr/bin/sw_vers",["-productVersion"],{encoding:"utf8"}).stdout?.trim():null;
const supported=process.platform==="darwin"&&process.arch==="arm64"&&os.release()==="27.0.0"&&version==="27.0.1";
const gate=process.env.PERMIT_WITNESS_REQUIRE_ANONYMOUS_NATIVE==="1";
function run(file,args){const r=spawnSync(file,args,{encoding:"utf8",timeout:15000,maxBuffer:4*1024*1024,env:{...process.env,ASAN_OPTIONS:"detect_leaks=0:abort_on_error=1"}});assert.ifError(r.error);assert.equal(r.signal,null,r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);assert.doesNotMatch(r.stderr,/AddressSanitizer|UndefinedBehaviorSanitizer|runtime error:|Assertion failed/,"child sanitizer/assertion failure must not be hidden by parent exit 0");return r.stdout;}
test("native fixture composition uses real state HELLO and exactly one length frame",{timeout:120000,skip:!supported&&!gate?"only verified macOS arm64 is supported":false},async t=>{
 assert.ok(supported);const build=fs.mkdtempSync(testRuntime("permit-witness-combined-"));t.diagnostic(build);
 const flags=["-std=c11","-D_DARWIN_C_SOURCE","-Wall","-Wextra","-Werror","-Wno-unused-function","-Wno-unused-parameter","-Wframe-larger-than=16384","-O1","-g","-fsanitize=address,undefined","-fno-sanitize-recover=undefined","-fno-omit-frame-pointer","-I",native];
 const shared=[path.join(native,"session-wire.c"),path.join(native,"session-state.c"),path.join(native,"combined-session.c")];
 for(const mode of ["normal","maximum","concurrent","paused","stall","eof","exit","close-eof","oversize","bad-mac","default"])await t.test(mode,()=>{
  const peer=path.join(build,`peer-${mode}`),childObject=path.join(build,`transport-child-${mode}.o`);
  const fixture=["-DPW_ANONYMOUS_FIXTURE","-DPW_ANONYMOUS_STATE_FIXTURE",`-DPW_FIXED_PEER_PATH=${JSON.stringify(peer)}`];
  run("/usr/bin/xcrun",["clang",...flags,...fixture,"-Dwrite=pw_cs_test_write","-c",path.join(native,"anonymous.c"),"-o",childObject]);
  run("/usr/bin/xcrun",["clang",...flags,...fixture,`-DPW_CS_MODE=${JSON.stringify(mode)}`,childObject,...shared,path.join(fixtures,"permit-witness-anonymous-combined-peer.c"),"-o",peer]);
  const binary=path.join(build,`parent-${mode}`);
  run("/usr/bin/xcrun",["clang",...flags,...(mode==="default"?[]:fixture),path.join(native,"anonymous.c"),...shared,path.join(fixtures,"permit-witness-anonymous-combined-harness.c"),"-o",binary]);
  const report=JSON.parse(run(binary,[mode]));assert.equal(report.status,mode==="default"?"REFUSED":"OK");t.diagnostic(JSON.stringify({mode,...report}));
 });
});
