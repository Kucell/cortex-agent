"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),{spawnSync}=require("node:child_process");
const root=path.resolve(__dirname,"../.."),native=path.join(root,"packages/permit-witness-macos/native-anonymous"),fixture=path.join(__dirname,"fixtures/permit-witness-anonymous-combined-adopt.c");
const supported=process.platform==="darwin"&&process.arch==="arm64"&&os.release()==="27.0.0"&&spawnSync("/usr/bin/sw_vers",["-productVersion"],{encoding:"utf8"}).stdout?.trim()==="27.0.1";
function run(args){const r=spawnSync(args[0],args.slice(1),{encoding:"utf8",timeout:15000,env:{...process.env,ASAN_OPTIONS:"detect_leaks=0:abort_on_error=1"}});assert.ifError(r.error);assert.equal(r.signal,null,r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);assert.doesNotMatch(r.stderr,/AddressSanitizer|runtime error:|Assertion failed/);return r.stdout;}
test("fixed child adoption and bootstrap EOF preserve ownership and first errors",{timeout:90000,skip:!supported&&process.env.PERMIT_WITNESS_REQUIRE_ANONYMOUS_NATIVE!=="1"?"only verified macOS arm64":false},async t=>{
 assert.ok(supported);const build=fs.mkdtempSync(testRuntime("permit-witness-combined-adopt-"));t.diagnostic(build);
 const flags=["-std=c11","-D_DARWIN_C_SOURCE","-Wall","-Wextra","-Werror","-Wno-unused-function","-Wno-unused-parameter","-Wframe-larger-than=16384","-O1","-g","-fsanitize=address,undefined","-fno-sanitize-recover=undefined","-fno-omit-frame-pointer","-I",native,"-DPW_ANONYMOUS_FIXTURE","-DPW_ANONYMOUS_STATE_FIXTURE",'-DPW_FIXED_PEER_PATH="/nonexistent-fixture-not-used"'];
 for(const mode of ["set-3","set-4","set-5","flag-3","flag-4","flag-5","foreign-3","foreign-4","foreign-5","system","quota","trace","deadline","extra"])await t.test(mode,()=>{
  const obj=path.join(build,`${mode}.o`),binary=path.join(build,mode),extra=mode==="quota"?["-DPW_FIXTURE_V2_READ_LIMIT=56"]:[];
  run(["/usr/bin/xcrun","clang",...flags,...extra,"-Dfcntl=pw_adopt_fcntl","-Dread=pw_adopt_read","-Dpoll=pw_adopt_poll","-Dclock_gettime=pw_adopt_clock_gettime","-c",path.join(native,"anonymous.c"),"-o",obj]);
  run(["/usr/bin/xcrun","clang",...flags,`-DPW_ADOPT_BINARY=${JSON.stringify(binary)}`,obj,path.join(native,"session-state.c"),path.join(native,"session-wire.c"),fixture,"-o",binary]);
  t.diagnostic(run([binary,mode]).trim());
 });
});
