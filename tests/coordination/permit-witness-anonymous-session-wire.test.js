"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {spawnSync}=require("node:child_process");
const root=path.resolve(__dirname,"../.."),native=path.join(root,"packages/permit-witness-macos/native-anonymous"),fixtures=path.join(__dirname,"fixtures");
const wire=require("../../lib/coordination/permit-witness-bounded-session-wire");
const golden=require("./fixtures/permit-witness-anonymous-session-wire-vectors.json");
const key=Buffer.from(Array.from({length:32},(_,i)=>i)),session=Buffer.from(Array.from({length:16},(_,i)=>16+i)),binding=Buffer.from(Array.from({length:32},(_,i)=>128+i));
const MAX=1048697;
function fields(i) {return {direction:i%2+1,type:i+1,seq:i===5?0xffffffff:0x01020304+i,requestId:i===5?0xffffffff:0xa0b0c0d0+i,operation:i===5?65535:0x1234+i,binding};}
function run(file,args,encoding="utf8") {
 const r=spawnSync(file,args,{encoding,timeout:15000,maxBuffer:4*1024*1024,env:{...process.env,ASAN_OPTIONS:"detect_leaks=0:abort_on_error=1"}});
 assert.ifError(r.error);assert.equal(r.signal,null,String(r.stderr));assert.equal(r.status,0,String(r.stderr));return r.stdout;
}
const productVersion=process.platform==="darwin"?spawnSync("/usr/bin/sw_vers",["-productVersion"],{encoding:"utf8"}).stdout?.trim():null;
const locallyVerified=process.platform==="darwin"&&process.arch==="arm64"&&os.release()==="27.0.0"&&productVersion==="27.0.1";
const requireVerifiedPlatform=process.env.PERMIT_WITNESS_REQUIRE_ANONYMOUS_NATIVE==="1";
test("standalone session wire: JS/C exact bytes, authentication and bounded allocation",{
 timeout:90000,skip:!locallyVerified&&!requireVerifiedPlatform?"only verified macOS arm64 supports native session wire":false,
},async t=>{
 assert.equal(process.platform,"darwin");assert.equal(process.arch,"arm64");assert.equal(os.release(),"27.0.0");
 assert.equal(productVersion,"27.0.1");
 const build=fs.mkdtempSync(path.join(root,".agent/runtime/permit-witness-session-wire-"));t.diagnostic(build);
 const flags=["-std=c11","-D_DARWIN_C_SOURCE","-Wall","-Wextra","-Werror","-Wframe-larger-than=8192","-O2","-g","-fsanitize=address,undefined","-fno-sanitize-recover=undefined","-fno-omit-frame-pointer","-I",native];
 const object=path.join(build,"wire.o"),binary=path.join(build,"wire-test");
 run("/usr/bin/xcrun",["clang",...flags,"-Dmalloc=pw_sw_test_malloc","-c",path.join(native,"session-wire.c"),"-o",object]);
 run("/usr/bin/xcrun",["clang",...flags,object,path.join(fixtures,"permit-witness-anonymous-session-wire.c"),"-o",binary]);
 const input=path.join(build,"input.bin");
 function verify(bytes,i=0){fs.writeFileSync(input,bytes);return JSON.parse(run(binary,["verify",String(i),input]));}
 await t.test("C strict integer, truncation, tamper, output and allocation regressions",()=>{
  assert.equal(JSON.parse(run(binary,["selftest"])).status,"OK");
  assert.equal(JSON.parse(run(binary,["budget"])).status,"OK");
 });
 const records=[];
 for(let i=0;i<6;i++)await t.test(`fixed vector type ${i+1}: JS to C and C to JS`,()=>{
  const payload=i===0?Buffer.alloc(0):Buffer.from([0,255,0x7b,i,0,128]);
  const js=wire.encode(key,session,{...fields(i),payload});
  assert.equal(js.toString("hex"),golden[i].wireHex);
  const decoded=verify(js,i);assert.equal(decoded.result,"OK");assert.equal(decoded.valid,1);
  assert.equal(decoded.digest,wire.digest(js).toString("hex"));assert.equal(decoded.payloadBytes,payload.length);
  const payloadPath=path.join(build,`payload-${i}.bin`);fs.writeFileSync(payloadPath,payload);
  const c=run(binary,["encode",String(i),payloadPath],null);assert.deepEqual(c,js);
  const parsed=wire.decode(key,session,c,fields(i).direction,fields(i).seq);
  assert.equal(parsed.type,i+1);assert.equal(parsed.requestId,fields(i).requestId);assert.equal(parsed.operation,fields(i).operation);
  assert.deepEqual(parsed.binding,binding);assert.deepEqual(parsed.payload,payload);
  records.push({variant:i,keyHex:key.toString("hex"),sessionHex:session.toString("hex"),fields:{...fields(i),binding:binding.toString("hex")},wireHex:c.toString("hex")});
 });
 fs.writeFileSync(path.join(build,"fixed-vectors.json"),JSON.stringify(records,null,2)+"\n");
 assert.deepEqual(records,golden);
 await t.test("maximum v2 response fits exact 1048697-byte authenticated session frame",()=>{
  // Opaque v2 response bytes: 22-byte header + status + 1 MiB payload.
  const payload=Buffer.alloc(MAX-wire.OVERHEAD,0x5a);payload.writeUInt32BE(payload.length-4,0);payload[4]=2;payload[5]=2;payload[22]=0;
  const js=wire.encode(key,session,{...fields(3),payload});assert.equal(js.length,MAX);
  const decoded=verify(js,3);assert.equal(decoded.result,"OK");assert.equal(decoded.digest,wire.digest(js).toString("hex"));
  assert.equal(verify(js.subarray(0,-1),3).result,"SIZE");
  const payloadPath=path.join(build,"max-payload.bin");fs.writeFileSync(payloadPath,payload);
  const c=run(binary,["encode","3",payloadPath],null);assert.deepEqual(c,js);
  assert.deepEqual(wire.decode(key,session,c,2,fields(3).seq).payload,payload);
  t.diagnostic(JSON.stringify({maxFrameBytes:c.length,payloadBytes:payload.length,sha256:wire.digest(c).toString("hex")}));
  const over=wire.encode(key,session,{...fields(3),payload:Buffer.alloc(payload.length+1)});
  assert.equal(verify(over,3).result,"SIZE");
 });
 await t.test("strict length, every truncation and signed field mismatches fail without output",()=>{
  const good=wire.encode(key,session,{...fields(0),payload:Buffer.from([1,2,3])});
  for(let n=0;n<good.length;n++){const r=verify(good.subarray(0,n));assert.equal(r.result,"SIZE");assert.equal(r.valid,0);assert.equal(r.payloadBytes,0);assert.equal(r.digest,"");}
  assert.equal(verify(Buffer.concat([good,Buffer.from([0])])).result,"SIZE");
  function resign(b){crypto.createHmac("sha256",key).update(b.subarray(0,-32)).digest().copy(b,b.length-32);return b;}
  for(const [position,result] of [[4,"DOMAIN"],[5,"DOMAIN"],[6,"CORRELATION"],[7,"DOMAIN"],[8,"SEQUENCE"],[12,"CORRELATION"],[16,"CORRELATION"],[18,"DOMAIN"],[34,"CORRELATION"]]) {
   const changed=Buffer.from(good);changed[position]^=1;
   assert.equal(verify(changed).result,"MAC");const r=verify(resign(changed));assert.equal(r.result,result);assert.equal(r.valid,0);assert.equal(r.payloadBytes,0);
  }
  for(const pos of [66,good.length-32,good.length-1]){const changed=Buffer.from(good);changed[pos]^=1;assert.equal(verify(changed).result,"MAC");}
 });
 t.diagnostic(JSON.stringify({binarySha256:crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex"),platform:"macOS 27.0.1 arm64",sanitizers:"ASan/UBSan"}));
});
