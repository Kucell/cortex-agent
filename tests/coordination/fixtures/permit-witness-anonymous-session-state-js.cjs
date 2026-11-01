"use strict";
// Test-only view of the EXACT existing endpoint, with its real rawIO/admit.
// No repository JS is modified. Native launcher supplies fixed fd 3/4;
// bootstrap is synthetic fixture constants, never credentials/env/argv.
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),{createRequire}=require("node:module");
const filename=path.resolve(__dirname,"../../../lib/coordination/permit-witness-bounded-session.js");
const localRequire=createRequire(filename),moduleView={exports:{}};
const context={require:localRequire,module:moduleView,exports:moduleView.exports,process,Buffer,console,setTimeout,clearTimeout};
vm.runInNewContext(fs.readFileSync(filename,"utf8")+"\nmodule.exports.fixtureEndpoint=endpoint;",context,{filename});
const {SessionBudget,admit}=localRequire("./permit-witness-bounded-session-io");
const role=process.argv[2],key=Buffer.from(Array.from({length:32},(_,i)=>i)),id=Buffer.from(Array.from({length:16},(_,i)=>16+i));
const account=admit(new SessionBudget(),65536,64);
const session=moduleView.exports.fixtureEndpoint({role,readFd:3,writeFd:4,key,session:id,
 deadlineNs:process.hrtime.bigint()+10000000000n,account,maxPayloadBytes:65536,maxFrames:64,operations:new Set([1,2,3]),
 handler:async(op,payload)=>{if(op===3)await new Promise(resolve=>setTimeout(resolve,5));return Buffer.from(payload);}});
(async()=>{await session.ready;if(role==="parent"){
 for(let i=0;i<12;i++){const payload=Buffer.from([0,255,i]);const reply=await session.request(i%3+1,payload);if(!reply.equals(payload))throw Error("reply mismatch");}
 await session.close();
}await session.closed;
if(!key.every(x=>x===0)||!id.every(x=>x===0))throw Error("synthetic key not wiped");
})().catch(e=>{console.error(e);process.exitCode=1;session.abort();});
