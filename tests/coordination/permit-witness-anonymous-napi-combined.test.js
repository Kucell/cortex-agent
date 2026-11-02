"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {spawnSync,execFile}=require("node:child_process"),{promisify}=require("node:util"),exec=promisify(execFile);
const root=path.resolve(__dirname,"../.."),native=path.join(root,"packages/permit-witness-macos/native-anonymous"),fixtures=path.join(__dirname,"fixtures");
function compile(args){const r=spawnSync("/usr/bin/xcrun",args,{encoding:"utf8",timeout:20000});assert.ifError(r.error);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,"");}
const product=process.platform==="darwin"?spawnSync("/usr/bin/sw_vers",["-productVersion"],{encoding:"utf8"}).stdout?.trim():null;
const supported=process.platform==="darwin"&&process.arch==="arm64"&&os.release()==="27.0.0"&&product==="27.0.1"&&process.version==="v24.11.0";
const required=process.env.PERMIT_WITNESS_REQUIRE_ANONYMOUS_NATIVE==="1";
test("fixture-only combined N-API uses real owner, full v2 frames and charged delivery",{timeout:240000,skip:!supported&&!required},async t=>{
  assert.ok(supported,`unsupported native runtime: ${process.platform}/${process.arch}/${os.release()}/${product}/${process.version}`);
  const build=fs.mkdtempSync(testRuntime("permit-witness-napi-combined-"));t.diagnostic(build);
  const sanitize=["-fsanitize=address,undefined","-fno-sanitize-recover=undefined","-fno-omit-frame-pointer"];
  const flags=["-D_DARWIN_C_SOURCE","-Wall","-Wextra","-Werror","-Wno-unused-function","-Wno-unused-parameter","-Wframe-larger-than=16384","-O1","-g",...sanitize,"-I",native];
  const resource=spawnSync("/usr/bin/xcrun",["clang","--print-resource-dir"],{encoding:"utf8"});assert.equal(resource.status,0);
  const env={...process.env,DYLD_INSERT_LIBRARIES:path.join(resource.stdout.trim(),"lib/darwin/libclang_rt.asan_osx_dynamic.dylib"),ASAN_OPTIONS:"detect_leaks=0:abort_on_error=1"};
  const files=[...fs.readdirSync(native).filter(f=>/\.(?:c|cc|h)$/.test(f)).map(f=>path.join(native,f)),__filename,
    ...fs.readdirSync(fixtures).filter(f=>f.startsWith("permit-witness-anonymous-napi-combined-")).map(f=>path.join(fixtures,f)),
    path.join(fixtures,"permit-witness-anonymous-napi-thread-probe.c"),path.join(fixtures,"permit-witness-anonymous-combined-peer.c")];
  const sha=()=>Object.fromEntries(files.map(f=>[path.relative(root,f),crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")]));
  const initial=sha();t.diagnostic(JSON.stringify({dependencies:initial}));
  const modes=process.env.PERMIT_WITNESS_NAPI_HISTORICAL_ONCE==="1"?["historical-four"]:["normal","maximum","dual","close-hold","close-eof","idle","cancel","stall","bad-mac","copy-failure","quota","delivery-quota","worker-cleanup","default",
    "settlement-reentry","owner-before-done","owner-first","owner-published","destroy-failure","init-uv","init-tsfn","init-cleanup","init-thread"];
  for(const mode of modes)await t.test(mode,async st=>{
    const peer=path.join(build,`peer-${mode}`),defs=["-DPW_ANONYMOUS_FIXTURE","-DPW_ANONYMOUS_STATE_FIXTURE",`-DPW_FIXED_PEER_PATH=${JSON.stringify(peer)}`];
    const objects=[];for(const f of ["anonymous.c","session-wire.c","session-state.c","combined-session.c"]){const obj=path.join(build,`${mode}-${f}.o`);objects.push(obj);
      const probes=f==="anonymous.c"?["-Dread=pw_napi_test_read","-Dwrite=pw_cs_test_write","-Dwaitpid=pw_napi_test_waitpid","-Dposix_spawn=pw_napi_test_spawn"]:[];
      compile(["clang","-std=c11",...flags,...defs,...probes,"-c",path.join(native,f),"-o",obj]);}
    const thread=path.join(build,`${mode}-thread.o`);compile(["clang","-std=c11",...flags,"-c",path.join(fixtures,"permit-witness-anonymous-napi-thread-probe.c"),"-o",thread]);
    const child=path.join(build,`${mode}-child.o`);
    compile(["clang","-std=c11",...flags,...defs,"-Dwrite=pw_cs_test_write","-c",path.join(native,"anonymous.c"),"-o",child]);
    compile(["clang","-std=c11",...flags,...defs,`-DPW_CS_MODE=${JSON.stringify(["cancel","stall","worker-cleanup"].includes(mode)?"stall":mode==="historical-four"?"close-hold":mode)}`,
      child,...objects.slice(1),path.join(fixtures,"permit-witness-anonymous-napi-combined-peer.c"),"-o",peer]);
    const addon=path.join(build,`${mode}-addon.o`),probe=path.join(build,`${mode}-probe.o`),life=path.join(build,`${mode}-life.o`),binary=path.join(build,`${mode}.node`);
    const cxx=["clang++","-std=c++17",...flags,"-I",path.resolve(process.execPath,"../../include/node")];
    const fixture=mode==="default"?[]:[...defs,"-DPW_NAPI_FIXTURE","-DPW_NAPI_COMBINED_FIXTURE","-DPW_NAPI_CS_REGRESSION"];
    // The `default` mode deliberately builds the real, non-fixture addon: it
    // must refuse with UNSAFE_DEPLOYMENT instead of exposing a session. The
    // lifecycle probe only observes fixture-owned records, so the fixture
    // symbol redirects must not be applied to that build. Redirecting them
    // anyway makes the probe assert on an unregistered record and hides the
    // real refusal behind an unrelated assertion failure.
    const fixtureRedirects=mode==="default"?[]:[
      "-Dpw_cs_start_v1=pw_cs_test_start","-Dpw_cs_pump_v1=pw_cs_test_pump","-Dpw_cs_request_v1=pw_cs_test_request",
      "-Duv_close=pw_cs_test_uv_close","-Dnapi_create_threadsafe_function=pw_cs_test_create_tsfn",
      "-Dpw_cs_abort_v1=pw_cs_test_abort","-Dpw_cs_observe_v1=pw_cs_test_observe","-Dpw_cs_terminate_v1=pw_cs_test_terminate",
      "-Dpw_cs_root_destroy_v1=pw_cs_test_destroy","-Dnapi_create_buffer_copy=pw_cs_napi_buffer_copy"];
    compile([...cxx,...fixture,...(["idle","stall"].includes(mode)?["-DPW_NAPI_COMBINED_DEADLINE_MS=900"]:[]),
      ...(mode==="quota"?["-DPW_NAPI_COMBINED_COPY_LIMIT=1052695"]:mode==="delivery-quota"?["-DPW_NAPI_COMBINED_COPY_LIMIT=2105390"]:[]),
      ...fixtureRedirects,"-c",path.join(native,"addon.cc"),"-o",addon]);
    compile([...cxx,...(mode==="copy-failure"?["-DPW_NAPI_COPY_FAIL=1"]:[]),"-c",path.join(fixtures,"permit-witness-anonymous-napi-combined-probe.cc"),"-o",probe]);
    compile([...cxx,"-c",path.join(fixtures,"permit-witness-anonymous-napi-combined-lifecycle-probe.cc"),"-o",life]);
    compile(["clang++",...sanitize,"-bundle","-undefined","dynamic_lookup",...objects,thread,addon,probe,life,"-o",binary]);
    let result;
    try{result=await exec(process.execPath,["--unhandled-rejections=strict",path.join(fixtures,"permit-witness-anonymous-napi-combined-client.js"),binary,mode],{env,timeout:16000,maxBuffer:1024*1024});}
    catch(e){fs.writeFileSync(path.join(build,`${mode}-failure.json`),JSON.stringify({code:e.code,signal:e.signal,stdout:e.stdout,stderr:e.stderr},null,2));throw e;}
    assert.equal(result.stderr,"");assert.equal(JSON.parse(result.stdout.trim().split("\n").at(-1)).status,"OK");
    t.diagnostic(result.stdout.trim());
    if(mode==="owner-published")await st.test("missing completion mutex is rejected by the publication barrier",async()=>{
      // Runtime-only reproduction of the former unsynchronized publication:
      // remove close AND publication locks so the JS-controlled barrier never
      // waits with a Bridge lock held. Production source stays untouched.
      const source=fs.readFileSync(path.join(native,"addon.cc"),"utf8");
      const lock="// Publication and its final send are one critical section with JS close.\n    std::lock_guard<std::mutex> g(b->mutex);";
      assert.equal(source.split(lock).length,2);
      const publication="{std::lock_guard<std::mutex> g(b->mutex);b->owner_done.store(true);CS_TEST(b,\"owner-published\");";
      assert.equal(source.split(publication).length,2);
      const counter=path.join(build,"missing-completion-lock.cc"),object=path.join(build,"missing-completion-lock.o"),old=path.join(build,"missing-completion-lock.node");
      fs.writeFileSync(counter,source.replace(lock,"// Test-only missing completion synchronization.").replace(publication,"{b->owner_done.store(true);CS_TEST(b,\"owner-published\");"));
      compile([...cxx,...fixture,"-Duv_close=pw_cs_test_uv_close","-Dnapi_create_threadsafe_function=pw_cs_test_create_tsfn",
        "-Dpw_cs_abort_v1=pw_cs_test_abort","-Dpw_cs_observe_v1=pw_cs_test_observe","-Dpw_cs_terminate_v1=pw_cs_test_terminate",
        "-Dpw_cs_start_v1=pw_cs_test_start","-Dpw_cs_pump_v1=pw_cs_test_pump","-Dpw_cs_request_v1=pw_cs_test_request","-Dpw_cs_root_destroy_v1=pw_cs_test_destroy","-Dnapi_create_buffer_copy=pw_cs_napi_buffer_copy","-c",counter,"-o",object]);
      compile(["clang++",...sanitize,"-bundle","-undefined","dynamic_lookup",...objects,thread,object,probe,life,"-o",old]);
      let failure;try{await exec(process.execPath,["--unhandled-rejections=strict",path.join(fixtures,"permit-witness-anonymous-napi-combined-client.js"),old,"unsafe-owner-published"],{env,timeout:16000,maxBuffer:1024*1024});}catch(e){failure=e;}
      assert.ok(failure,"missing mutex must violate the barrier");
      fs.writeFileSync(path.join(build,"missing-completion-lock-failure.json"),JSON.stringify({code:failure.code,signal:failure.signal,stdout:failure.stdout,stderr:failure.stderr},null,2));
      assert.equal(failure.signal,"SIGABRT");
      assert.equal(failure.stderr,"PW_CS_PROBE_SEND_AFTER_UV_CLOSE_CALL\n");
      assert.doesNotMatch(failure.stderr,/ERROR: AddressSanitizer|runtime error:|UndefinedBehaviorSanitizer/);
    });
  });
  assert.deepEqual(sha(),initial,"native dependencies changed during build/test: revalidate a stable snapshot");
});
