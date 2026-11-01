"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {spawnSync}=require("node:child_process");
const root=path.resolve(__dirname,"../.."),native=path.join(root,"packages/permit-witness-macos/native-anonymous"),fixtures=path.join(__dirname,"fixtures");
function run(file,args) {
 const result=spawnSync(file,args,{encoding:"utf8",timeout:20000,maxBuffer:4*1024*1024,env:{...process.env,ASAN_OPTIONS:"detect_leaks=0:abort_on_error=1"}});
 assert.ifError(result.error);assert.equal(result.signal,null,result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;
}
const productVersion=process.platform==="darwin"?spawnSync("/usr/bin/sw_vers",["-productVersion"],{encoding:"utf8"}).stdout?.trim():null;
const locallyVerified=process.platform==="darwin"&&process.arch==="arm64"&&os.release()==="27.0.0"&&productVersion==="27.0.1"&&process.version==="v24.11.0";
const requireVerifiedPlatform=process.env.PERMIT_WITNESS_REQUIRE_ANONYMOUS_NATIVE==="1";
test("native session-state standalone: exact JS semantics and terminal boundaries",{
 timeout:120000,skip:!locallyVerified&&!requireVerifiedPlatform?"only verified macOS arm64 supports native session-state":false,
},async t=>{
 assert.equal(process.platform,"darwin");assert.equal(process.arch,"arm64");assert.equal(productVersion,"27.0.1");
 assert.equal(process.version,"v24.11.0","real JS endpoint validation uses this verified Node patch");
 fs.mkdirSync(path.join(root,".agent/runtime"),{recursive:true});
 const build=fs.mkdtempSync(path.join(root,".agent/runtime/permit-witness-session-state-"));t.diagnostic(build);
 const flags=["-std=c11","-D_DARWIN_C_SOURCE","-Wall","-Wextra","-Werror","-Wframe-larger-than=16384","-O1","-g","-fsanitize=address,undefined","-fno-sanitize-recover=undefined","-fno-omit-frame-pointer","-I",native];
 const object=path.join(build,"state.o"),binary=path.join(build,"state-test");
 run("/usr/bin/xcrun",["clang",...flags,"-Dmalloc=pw_ss_test_malloc","-Dcalloc=pw_ss_test_calloc","-Darc4random_buf=pw_ss_fixed_random","-Dclock_gettime=pw_ss_test_clock","-c",path.join(native,"session-state.c"),"-o",object]);
 const wireObject=path.join(build,"wire.o");
 run("/usr/bin/xcrun",["clang",...flags,"-Dmalloc=pw_ss_test_wire_malloc","-Dcalloc=pw_ss_test_wire_calloc","-c",path.join(native,"session-wire.c"),"-o",wireObject]);
 run("/usr/bin/xcrun",["clang",...flags,object,wireObject,path.join(fixtures,"permit-witness-anonymous-session-state.c"),
  `-DPW_SS_NODE=${JSON.stringify(process.execPath)}`,`-DPW_SS_JS_PEER=${JSON.stringify(path.join(fixtures,"permit-witness-anonymous-session-state-js.cjs"))}`,"-o",binary]);
 for(const mode of ["selftest","allocations","handshake-negative","replay-close","boundaries","ownership","live-parent","live-child"])await t.test(mode,()=>{
  const result=JSON.parse(run(binary,[mode]));assert.equal(result.status,"OK");t.diagnostic(JSON.stringify(result));
 });
 await t.test("fixed handshake/request/response/CLOSE transcript bytes match JS wire",()=>{
  const file=path.join(build,"transcript.bin");assert.equal(JSON.parse(run(binary,["transcript",file])).status,"OK");
  const bytes=fs.readFileSync(file),frames=[];let offset=0;
  while(offset<bytes.length){const n=bytes.readUInt32BE(offset);offset+=4;frames.push(bytes.subarray(offset,offset+n));offset+=n;}assert.equal(offset,bytes.length);
  const wire=require("../../lib/coordination/permit-witness-bounded-session-wire"),key=Buffer.from(Array.from({length:32},(_,i)=>i)),session=Buffer.from(Array.from({length:16},(_,i)=>i+16));
  const challenge=Buffer.from(Array.from({length:32},(_,i)=>i+32)),expected=[];
  function encode(direction,type,seq,requestId,operation,binding,payload){const b=wire.encode(key,session,{direction,type,seq,requestId,operation,binding,payload});expected.push(b);return b;}
  const hello=encode(1,1,1,0,0,wire.zero,challenge);encode(2,2,1,0,0,wire.digest(hello),challenge);
  for(let i=0;i<3;i++){const payload=Buffer.from([0,255,i]);const request=encode(1,3,i+2,i+1,i+1,wire.zero,payload);encode(2,4,i+2,i+1,i+1,wire.digest(request),payload);}
  const close=encode(1,5,5,4,0,wire.zero,Buffer.alloc(0));encode(2,6,5,4,0,wire.digest(close),Buffer.alloc(0));
  assert.deepEqual(frames,expected);fs.writeFileSync(path.join(build,"transcript-vectors.json"),JSON.stringify(frames.map(b=>b.toString("hex")),null,2)+"\n");
  t.diagnostic(`transcript sha256: ${crypto.createHash("sha256").update(bytes).digest("hex")}`);
 });
});
