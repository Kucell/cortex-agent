"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");
const test=require("node:test"), assert=require("node:assert/strict"), fs=require("node:fs"), path=require("node:path");
const os=require("node:os");
const {spawnSync,execFile}=require("node:child_process"), {promisify}=require("node:util");
const exec=promisify(execFile), root=path.resolve(__dirname,"../.."), native=path.join(root,"packages/permit-witness-macos/native-anonymous"), fixtures=path.join(__dirname,"fixtures");
function compile(args){const r=spawnSync("/usr/bin/xcrun",args,{encoding:"utf8",timeout:20000});assert.ifError(r.error);assert.equal(r.status,0,r.stderr);}
const locallyVerified=process.platform==="darwin" && process.arch==="arm64" && os.release()==="27.0.0" && process.version==="v24.11.0";
const requireVerifiedPlatform=process.env.PERMIT_WITNESS_REQUIRE_ANONYMOUS_NATIVE==="1";
test("N-API controlled lifetime, arbitration, wait and reentry regressions",{
  timeout:90000,
  skip:!locallyVerified && !requireVerifiedPlatform ? "only the verified Darwin arm64 and Node runtime is supported" : false,
},async t=>{
  assert.equal(process.platform,"darwin"); assert.equal(process.arch,"arm64"); assert.equal(process.version,"v24.11.0");
  const build=fs.mkdtempSync(testRuntime("permit-witness-napi-regression-"));t.diagnostic(build);
  const base=["-D_DARWIN_C_SOURCE","-Wall","-Wextra","-Werror","-Wno-unused-function","-g","-O1","-I",native];
  const sanitized=process.env.PERMIT_WITNESS_NAPI_SANITIZERS==="1";
  const instrumentation=sanitized ? ["-fsanitize=address,undefined","-fno-sanitize-recover=undefined","-fno-omit-frame-pointer"] : [];
  base.push(...instrumentation);
  let clientEnv=process.env;
  if(sanitized) {
    const result=spawnSync("/usr/bin/xcrun",["clang","--print-resource-dir"],{encoding:"utf8"});
    assert.equal(result.status,0,result.stderr);
    const asan=path.join(result.stdout.trim(),"lib/darwin/libclang_rt.asan_osx_dynamic.dylib");
    assert.ok(fs.existsSync(asan));
    clientEnv={...process.env,DYLD_INSERT_LIBRARIES:asan,ASAN_OPTIONS:"detect_leaks=0:abort_on_error=1"};
  }
  const peer=path.join(build,"peer");
  compile(["clang","-std=c11",...base,path.join(fixtures,"permit-witness-anonymous-peer.c"),"-o",peer]);
  const core=path.join(build,"core.o"),addon=path.join(build,"addon.o"),probe=path.join(build,"probe.o"),binary=path.join(build,"regression.node");
  const fixtureFlags=["-DPW_ANONYMOUS_FIXTURE",`-DPW_FIXED_PEER_PATH=${JSON.stringify(peer)}`];
  compile(["clang","-std=c11",...base,...fixtureFlags,"-c",path.join(native,"anonymous.c"),"-o",core]);
  const cxx=["clang++","-std=c++17",...base,"-I",path.resolve(process.execPath,"../../include/node"),...fixtureFlags];
  compile([...cxx,"-DPW_NAPI_FIXTURE","-DPW_NAPI_REGRESSION","-Dpw_start=pw_napi_regression_start","-Dpw_observe_direct_exit=pw_napi_regression_wait",
    "-Dpw_root_destroy=pw_napi_regression_destroy","-Dnapi_call_threadsafe_function=pw_napi_regression_call",
    "-Dpw_read_frame_step=pw_napi_regression_read","-Dnapi_create_buffer_copy=pw_napi_regression_buffer_copy",
    "-Dpw_cancel=pw_napi_regression_cancel","-Dpw_terminate_direct_child=pw_napi_regression_terminate",
    "-Dnapi_resolve_deferred=pw_napi_regression_resolve","-Dnapi_reject_deferred=pw_napi_regression_reject",
    "-c",path.join(native,"addon.cc"),"-o",addon]);
  compile([...cxx,"-c",path.join(fixtures,"permit-witness-anonymous-napi-regression-probe.cc"),"-o",probe]);
  compile(["clang++",...instrumentation,"-bundle","-undefined","dynamic_lookup",core,addon,probe,"-o",binary]);
  for(const mode of ["buffer-copy-live","buffer-copy-live-pending-exception","buffer-copy-live-reentry",
    "buffer-copy-two-slot-first","buffer-copy-two-slot-second","buffer-copy-two-slot-cancel-neighbor",
    "buffer-copy-failure","buffer-copy-pending-exception","cancel-ready","cancel-result","post-start","pre-start","unknown-start","unknown-wait","reentrant-promise","teardown","destroy-failure","closing"]) await t.test(mode,async()=>{
    const result=await exec(process.execPath,["--unhandled-rejections=strict",path.join(fixtures,"permit-witness-anonymous-napi-regression-client.js"),binary,mode],{env:clientEnv,timeout:8000,maxBuffer:1024*1024});
    assert.equal(result.stderr,""); if(mode!=="unknown-start") {
      const lines=result.stdout.trim().split("\n"); assert.equal(JSON.parse(lines.at(-1)).status,"OK");
      if(lines.length>1) t.diagnostic(lines[0]);
    }
  });
});
