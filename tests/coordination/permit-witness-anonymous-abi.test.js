"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {spawnSync}=require("node:child_process");
const root=path.resolve(__dirname,"../.."),native=path.join(root,"packages/permit-witness-macos/native-anonymous"),fixtures=path.join(__dirname,"fixtures");
function run(file,args) {
  const result=spawnSync(file,args,{encoding:"utf8",timeout:20000,env:{...process.env,ASAN_OPTIONS:"detect_leaks=0:abort_on_error=1"}});
  assert.ifError(result.error);assert.equal(result.signal,null,result.stderr);assert.equal(result.status,0,result.stderr);return result.stdout;
}
const locallyVerified=process.platform==="darwin"&&process.arch==="arm64"&&os.release()==="27.0.0";
const requireVerifiedPlatform=process.env.PERMIT_WITNESS_REQUIRE_ANONYMOUS_NATIVE==="1";
test("versioned snapshot ABI rejects mismatched caller size without writes",{
  timeout:30000,skip:!locallyVerified&&!requireVerifiedPlatform?"only the verified Darwin arm64 runtime is supported":false,
},t=>{
  assert.equal(process.platform,"darwin");assert.equal(process.arch,"arm64");
  const build=fs.mkdtempSync(testRuntime("permit-witness-abi-"));t.diagnostic(build);
  const flags=["-std=c11","-D_DARWIN_C_SOURCE","-Wall","-Wextra","-Werror","-Wno-unused-function","-O1","-g",
    "-fsanitize=address,undefined","-fno-sanitize-recover=undefined","-fno-omit-frame-pointer","-I",native];
  const object=path.join(build,"core.o"),library=path.join(build,"core.dylib"),binary=path.join(build,"abi");
  run("/usr/bin/xcrun",["clang",...flags,"-c",path.join(native,"anonymous.c"),"-o",object]);
  run("/usr/bin/xcrun",["clang",...flags,"-dynamiclib",object,"-o",library]);
  run("/usr/bin/xcrun",["clang",...flags,object,path.join(fixtures,"permit-witness-anonymous-abi.c"),"-o",binary]);
  const legacy=spawnSync("/usr/bin/xcrun",["clang",...flags,object,path.join(fixtures,"permit-witness-anonymous-abi-legacy.c"),"-o",path.join(build,"old")],{encoding:"utf8",timeout:20000});
  assert.ifError(legacy.error);assert.notEqual(legacy.status,0);assert.match(legacy.stderr,/_pw_inspect/);
  fs.writeFileSync(path.join(build,"legacy-link-refusal.txt"),legacy.stderr);
  const report=JSON.parse(run(binary,[library]));assert.equal(report.status,"OK");assert.equal(report.mismatchesWithoutWrites,11);
  t.diagnostic(JSON.stringify(report));
});
