"use strict";

const { testRuntime, relocatedTestRuntime } = require("../helpers/runtime-sandbox");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { createHash, generateKeyPairSync } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const source = path.join(root, "packages/permit-upgrade-linux-guard");
const fixture = path.join(__dirname, "fixtures/permit-upgrade-linux-journal-peer.c");
const zero = { sequence: 0, generation: 0, digest: "00".repeat(32) };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { const result = fn(); if (result) return result; await sleep(10); }
  assert.fail(message());
}
function withinRuntime(input) {
  const name = fs.realpathSync(input), runtime = fs.realpathSync(testRuntime());
  assert.ok(name.startsWith(`${runtime}/`), "evidence and fixtures must be under runtime");
  return name;
}
class Peer {
  constructor(binary, args, t) {
    this.child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.events = []; this.stderr = ""; this.output = "";
    this.done = once(this.child, "exit");
    let pending = "";
    this.child.stdout.on("data", chunk => {
      this.output += chunk; pending += chunk;
      for (;;) {
        const at = pending.indexOf("\n"); if (at < 0) break;
        this.events.push(JSON.parse(pending.slice(0, at))); pending = pending.slice(at + 1);
      }
    });
    this.child.stderr.on("data", chunk => { this.stderr += chunk; });
    this.child.stdin.on("error", () => {});
    t.after(async () => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
      await this.done;
      assert.doesNotMatch(this.stderr, /runtime error:|AddressSanitizer/);
    });
  }
  event(name) {
    return until(() => {
      const at = this.events.findIndex(e => e.event === name);
      return at < 0 ? null : this.events.splice(at, 1)[0];
    }, () => `missing ${name}: ${this.output} ${this.stderr}`);
  }
  send(line) { this.child.stdin.write(`${line}\n`); }
  async record(event, generation = 1, success = true) {
    this.send(`${event} ${generation}`);
    const result = await this.event("record");
    assert.equal(result.rc, success ? 0 : -1);
    if (success) { assert.equal(result.outcome, 2); this.head = await this.event("state"); }
    else if (result.outcome === 0) await this.event("state");
    return result;
  }
  async exit() { this.send("EXIT"); await this.event("closed"); assert.deepEqual(await this.done, [0, null]); }
  async kill() { this.child.kill("SIGKILL"); assert.deepEqual(await this.done, [null, "SIGKILL"]); }
}

test("Linux control journal: real IO, processes, recovery boundaries (not qualification)", {
  timeout: 60000,
  skip: process.platform !== "linux" && process.env.PERMIT_LINUX_JOURNAL_REQUIRE !== "1" ? "requires Linux" : false,
}, async t => {
  assert.equal(process.platform, "linux");
  const output = withinRuntime(relocatedTestRuntime(process.env.PERMIT_LINUX_JOURNAL_BUILD_ROOT, "journal-build"));
  const storage = withinRuntime(relocatedTestRuntime(process.env.PERMIT_LINUX_JOURNAL_TEST_ROOT, "journal-data"));
  const build = fs.mkdtempSync(path.join(output, "journal-build-"));
  const binary = path.join(build, "peer"), object = path.join(build, "journal-fault.o");
  const compile = args => {
    fs.appendFileSync(path.join(build, "compile-commands.jsonl"), JSON.stringify(args) + "\n");
    const r = spawnSync("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-Wpedantic",
      "-fsanitize=undefined", "-fno-sanitize-recover=all", `-I${source}`, ...args], { encoding: "utf8" });
    fs.appendFileSync(path.join(build, "compile.log"), r.stdout + r.stderr);
    assert.equal(r.status, 0, r.stderr);
  };
  compile(["-Dpwrite=pcj_test_pwrite", "-Dpread=pcj_test_pread", "-Dfsync=pcj_test_fsync",
    "-Dclose=pcj_test_close", "-c", path.join(source, "control-journal.c"), "-o", object]);
  compile([object, path.join(source, "guard.c"), fixture, "-lcrypto", "-o", binary]);
  // Also compile the unmodified production source: fault hooks never ship in it.
  compile(["-c", path.join(source, "control-journal.c"), "-o", path.join(build, "journal.o")]);
  // Dedicated native recovery driver is a runtime artifact, not a product entry.
  const recoverySource = path.join(build, "recovery-driver.c");
  fs.writeFileSync(recoverySource, String.raw`
#define _GNU_SOURCE
#include "control-journal.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
static const char *fault;
static int calls;
int recovery_fsync(int fd) {
    calls++;
    if (fault && !strcmp(fault,"sync-before")) { errno=EIO; return -1; }
    int rc=fsync(fd);
    if (fault && !strcmp(fault,"sync-after")) { errno=EIO; return -1; }
    if (fault && !strcmp(fault,"sync-kill")) {
        puts("{\"event\":\"sync-boundary\"}"); for (;;) pause();
    }
    return rc;
}
static void hex(const unsigned char *p, size_t n) { for(size_t i=0;i<n;i++) printf("%02x",p[i]); }
static int unhex(const char *p, unsigned char *out, size_t n) {
    if(strlen(p)!=2*n) return -1;
    for(size_t i=0;i<n;i++) { unsigned int x; if(sscanf(p+2*i,"%2x",&x)!=1)return -1; out[i]=(unsigned char)x; }
    return 0;
}
static void state(struct pcj *j) {
    struct pcj_state s;
    if(pcj_snapshot(j,&s)) { puts("{\"event\":\"poisoned\"}"); return; }
    printf("{\"event\":\"state\",\"sequence\":%llu,\"generation\":%llu,\"stamp\":%d,\"attempt\":%llu,\"eligible\":%d,\"complete\":%d,\"digest\":\"",
      (unsigned long long)s.head.sequence,(unsigned long long)s.head.owner_generation,s.stamp,
      (unsigned long long)s.attempt,s.eligible,s.complete);hex(s.head.digest,32);puts("\"}");
}
int main(int argc,char **argv) {
    if(argc!=10)return 64;
    setvbuf(stdout,NULL,_IONBF,0);
    int fd=open(argv[1],O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);struct stat st;
    if(fd<0||fstat(fd,&st))return 65;
    struct pcj_binding b={0};strcpy(b.upgrade_id,"upgrade-test");memset(b.context_digest,0x23,32);
    b.old_present=1;b.old_size=b.target_size=3;memcpy(b.old_bytes,"old",3);memcpy(b.target_bytes,"new",3);
    if(!strcmp(argv[9],"other-id"))strcpy(b.upgrade_id,"other-id");
    struct pcj_anchor a={0};a.head.sequence=strtoull(argv[2],NULL,10);a.head.owner_generation=strtoull(argv[3],NULL,10);
    if(unhex(argv[4],a.head.digest,32))return 66;
    a.revision=strtoull(argv[5],NULL,10);a.fence_generation=strtoull(argv[6],NULL,10);
    struct pcj_recovery *c=NULL;struct pcj *j=NULL;struct pcj_result r;struct pcj_recovery_view v;
    int rc=pcj_recovery_open(fd,(struct pg_identity){st.st_dev,st.st_ino,st.st_uid},1,&b,&a,
        strtoull(argv[7],NULL,10),strtoull(argv[8],NULL,10),&c,&v,&r);
    if(close(fd))return 67;
    printf("{\"event\":\"view\",\"rc\":%d,\"error\":%d,\"kind\":%d,\"prefix\":%d,\"bad\":%llu,\"records\":%llu}\n",
      rc,r.error,v.kind,v.prefix_verified,(unsigned long long)v.bad_sequence,(unsigned long long)v.records);
    if(rc)return 0;
    char line[4096];
    while(fgets(line,sizeof(line),stdin)) {
      line[strcspn(line,"\n")]=0;
      if(!strncmp(line,"FAULT ",6)){fault=strdup(line+6);continue;}
      if(!strcmp(line,"PREPARE")){
        unsigned char q[PCJ_RECOVERY_REQUEST_BYTES];rc=pcj_recovery_prepare(c,q,&r);
        printf("{\"event\":\"prepared\",\"rc\":%d,\"error\":%d,\"request\":\"",rc,r.error);hex(q,sizeof(q));puts("\"}");
      }else if(!strncmp(line,"TAIL ",5)){
        unsigned char w[PCJ_WIRE_BYTES];rc=pcj_recovery_copy_tail(c,strtoull(line+5,NULL,10),w,&r);
        printf("{\"event\":\"tail\",\"rc\":%d,\"error\":%d,\"wire\":\"",rc,r.error);hex(w,sizeof(w));puts("\"}");
      }else if(!strncmp(line,"ACCEPT ",7)){
        unsigned char receipt[PCJ_RECOVERY_RECEIPT_BYTES];enum pcj_cas_state cas;
        int missing=!strcmp(line+7,"missing");if(!missing&&unhex(line+7,receipt,sizeof(receipt)))return 68;
        rc=pcj_recovery_accept(&c,missing?NULL:receipt,&j,&cas,&r);
        printf("{\"event\":\"accepted\",\"rc\":%d,\"error\":%d,\"cas\":%d,\"handle\":%d}\n",rc,r.error,cas,j!=NULL);
        if(j)state(j);
      }else if(!strcmp(line,"EXIT")){
        if(c)rc=pcj_recovery_close(&c,&r);else if(j)rc=pcj_close(&j,&r);else rc=0;
        printf("{\"event\":\"closed\",\"rc\":%d}\n",rc);return rc?70:0;
      }else {
        unsigned int event;unsigned long long gen;unsigned char proof[32];memset(proof,0x42,32);
        if(sscanf(line,"%u %llu",&event,&gen)!=2)return 69;
        rc=pcj_record(j,(uint64_t)gen,(enum pcj_event)event,proof,&r);
        printf("{\"event\":\"record\",\"rc\":%d,\"outcome\":%d,\"error\":%d}\n",rc,r.outcome,r.error);if(j)state(j);
      }
    }
    return 0;
}
`);
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const recoveryObject = path.join(build, "recovery-model.o");
  compile([`-DPCJ_TEST_WITNESS_KEY_HEX="${publicKey}"`, "-Dfsync=recovery_fsync", "-c",
    path.join(source, "control-journal.c"), "-o", recoveryObject]);
  const recoveryBinary = path.join(build, "recovery-model");
  compile([recoveryObject, recoverySource, "-lcrypto", "-o", recoveryBinary]);
  const deniedBinary = path.join(build, "recovery-default");
  compile([path.join(build, "journal.o"), recoverySource, "-lcrypto", "-o", deniedBinary]);
  const witnessSource = path.join(build, "independent-test-witness.cjs");
  fs.writeFileSync(witnessSource, String.raw`
"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),readline=require("node:readline");
// Loaded once from the independent registrar BEFORE reading any protocol input.
// Request/init fields can never replace this identity. Compare full uint64 values.
const registeredDirectory=Object.freeze(JSON.parse(fs.readFileSync(process.argv[2],"utf8")));
let config,committed;
const sha=b=>crypto.createHash("sha256").update(b).digest();
readline.createInterface({input:process.stdin}).on("line",line=>{
  const m=JSON.parse(line);
  if(m.init){config=m;console.log(JSON.stringify({event:"witness-ready"}));return;}
  const q=Buffer.from(m.request,"hex"),hash=sha(q),id=hash.toString("hex");
  const u=at=>Number(q.readBigUInt64LE(at));
  let valid=q.length===1152&&q.subarray(0,8).toString()==="PCJQ0001"&&
    u(8)===config.anchor.sequence&&u(16)===config.anchor.generation&&
    q.subarray(672,704).toString("hex")===config.anchor.digest&&
    u(736)===config.revision&&u(744)===config.fence&&u(752)===config.next&&
    q.subarray(40,672).equals(Buffer.from(config.binding,"hex"))&&
    q.readBigUInt64LE(768).toString()===registeredDirectory.dev&&
    q.readBigUInt64LE(776).toString()===registeredDirectory.ino&&
    q.readBigUInt64LE(784).toString()===registeredDirectory.owner;
  // The expected intent is provisioned BEFORE the old writer executes the tail.
  // Merely recomputing a hash from bytes supplied by the recovery client is insufficient.
  let previous=Buffer.from(config.anchor.digest,"hex"),seq=config.anchor.sequence;
  const tails=(m.tails||[]).map(x=>Buffer.from(x,"hex"));
  if(tails.length!==config.intents.length)valid=false;
  for(let i=0;i<tails.length;i++){
    const w=tails[i];seq++;
    if(w.length!==1024||!w.equals(Buffer.from(config.intents[i]||"","hex"))||
      !w.subarray(672,704).equals(previous)||!sha(w.subarray(0,992)).equals(w.subarray(992)))valid=false;
    previous=w.subarray(992);
  }
  if(u(24)!==seq||!q.subarray(704,736).equals(previous))valid=false;
  let status=valid?1:2,revision=config.revision;
  if(valid&&m.mode==="unknown-before")status=3;
  else if(m.mode==="reject")status=2;
  else if(valid&&committed&&committed.id!==id)status=2; // stale external CAS, even with a fresh signature.
  else if(valid&&status===1){
    if(!committed){
      committed={id,revision:config.revision+1,owner:config.next,head:previous.toString("hex")};
      const file=path.join(config.store,"cas-"+committed.revision);
      const fd=fs.openSync(file,"wx",0o600);fs.writeFileSync(fd,JSON.stringify(committed));fs.fsyncSync(fd);fs.closeSync(fd);
      const dir=fs.openSync(config.store,"r");fs.fsyncSync(dir);fs.closeSync(dir);
    }
    revision=committed.revision;
    if(m.mode==="unknown-after")status=3;
  }
  const body=Buffer.alloc(64);body.write("PCJRA001");hash.copy(body,8);
  body.writeBigUInt64LE(BigInt(status),40);body.writeBigUInt64LE(BigInt(revision),48);
  body.writeBigUInt64LE(BigInt(config.next),56);
  if(m.mode==="wrong-plan")body[8]^=1;
  const key=m.mode==="wrong-key"?crypto.generateKeyPairSync("ed25519").privateKey:crypto.createPrivateKey(config.privateKey);
  console.log(JSON.stringify({event:"receipt",status,committed:!!committed,
    receipt:Buffer.concat([body,crypto.sign(null,body,key)]).toString("hex")}));
});
`);
  const evidence = { platform: process.platform, arch: process.arch, node: process.version,
    kernel: fs.readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(),
    fsType: fs.statfsSync(storage).type.toString(16), model: true, executionAuthorized: false,
    externalCheckpoint: "test supervisor memory/file only; NOT authenticated",
    productionRecoveryVerifierInstalled: false, testWitnessPublicKey: publicKey,
    generatedTestArtifacts: Object.fromEntries([recoverySource, witnessSource].map(file =>
      [path.basename(file), createHash("sha256").update(fs.readFileSync(file)).digest("hex")])),
    sources: Object.fromEntries([path.join(source, "control-journal.c"), path.join(source, "control-journal.h"),
      path.join(source, "guard.c"), path.join(source, "guard.h"), fixture, __filename].map(file =>
      [path.relative(root, file), createHash("sha256").update(fs.readFileSync(file)).digest("hex")])), observations: [] };
  t.diagnostic(JSON.stringify({ build, fsType: evidence.fsType }));
  const peers = [];
  t.after(() => {
    evidence.processes = peers.map(p => ({ pid: p.child.pid, output: p.output, stderr: p.stderr }));
    fs.writeFileSync(path.join(build, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  });
  function setup(t) {
    const base = fs.mkdtempSync(path.join(storage, "case-")); fs.chmodSync(base, 0o700);
    for (const name of ["index", "journal"]) fs.mkdirSync(path.join(base, name), { mode: 0o700 });
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    return base;
  }
  function start(t, base, checkpoint = zero, fault = "none", binding = "same", model = 1) {
    const p = new Peer(binary, [base, String(checkpoint.sequence), String(checkpoint.generation),
      checkpoint.digest, String(model), fault, binding], t); peers.push(p); return p;
  }
  async function ready(t, base, head = zero, fault = "none") {
    const p = start(t, base, head, fault); p.head = await p.event("ready"); return p;
  }
  const contender = base => spawnSync("flock", ["-n", "-E", "42", "-x", path.join(base, "index"), "/bin/true"]).status;
  function recovery(t, base, anchor, options = {}) {
    const p = new Peer(options.defaults ? deniedBinary : recoveryBinary, [path.join(base, "journal"),
      String(anchor.sequence), String(anchor.generation), anchor.digest, "7", "1", String(options.next ?? 2),
      String(options.bound ?? 4), options.binding ?? "same"], t); peers.push(p); return p;
  }
  function expectedCall(anchor) {
    const w = Buffer.alloc(1024); w.write("PCJR0001");
    for (const [at, n] of [[8, anchor.sequence + 1], [16, 1], [24, 1], [32, 4], [136, 1], [144, 3], [152, 3]])
      w.writeBigUInt64LE(BigInt(n), at);
    w.write("upgrade-test", 40); w.fill(0x23, 104, 136); w.write("old", 160); w.write("new", 416);
    Buffer.from(anchor.digest, "hex").copy(w, 672); w.fill(0x42, 704, 736);
    createHash("sha256").update(w.subarray(0, 992)).digest().copy(w, 992); return w;
  }
  async function unconfirmed(t) {
    const base = setup(t);
    // Independent registrar observation, fixed BEFORE writer execution or any recovery request.
    const registered = fs.statSync(path.join(base, "journal"), { bigint: true });
    const directoryIdentity = { dev: String(registered.dev), ino: String(registered.ino), owner: String(registered.uid) };
    const old = await ready(t, base);
    await old.record(1); const ownerAnchor = old.head;
    await old.record(3); const anchor = old.head;
    const intent = expectedCall(anchor); // external model intent fixed before tail write.
    await old.record(4); assert.equal(old.head.digest, intent.subarray(992).toString("hex"));
    await old.kill();
    return { base, anchor, ownerAnchor, intent, observed: old.head, directoryIdentity };
  }
  async function witness(t, f) {
    const store = fs.mkdtempSync(path.join(build, "witness-domain-"));
    const registry = path.join(store, "registered-identity.json");
    // Never construct this registration from q[768..791] or a request's identity fields.
    for (const [file, data] of [[registry, f.directoryIdentity],
      [path.join(store, "anchor.json"), { head: f.anchor, revision: 7, fence: 1 }]]) {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); fs.closeSync(fd);
    }
    const dir = fs.openSync(store, "r"); fs.fsyncSync(dir); fs.closeSync(dir);
    const p = new Peer(process.execPath, [witnessSource, registry], t); peers.push(p); p.store = store;
    p.send(JSON.stringify({ init: true, anchor: f.anchor, revision: 7, fence: 1, next: 2,
      binding: f.intent.subarray(40, 672).toString("hex"), intents: [f.intent.toString("hex")], store,
      privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }) }));
    await p.event("witness-ready"); return p;
  }
  async function prepare(p) {
    p.send("PREPARE"); const q = await p.event("prepared"); assert.equal(q.rc, 0); return q.request;
  }
  async function receipt(p, request, intent, mode = "commit") {
    p.send(JSON.stringify({ request, tails: [intent.toString("hex")], mode })); return p.event("receipt");
  }
  async function accept(p, signed, success) {
    p.send(`ACCEPT ${signed}`); const answer = await p.event("accepted");
    assert.equal(answer.rc, success ? 0 : -1); assert.equal(answer.handle, success ? 1 : 0); return answer;
  }

  await t.test("exclusive journal owner, independent directory FD and live discovery guard", async t => {
    const base = setup(t), first = await ready(t, base);
    await first.record(1); const head = first.head;
    const second = start(t, base, head);
    assert.equal((await second.event("open-error")).error, 11); await second.done;
    assert.equal(contender(base), 42);
    first.send("CHECK"); assert.equal((await first.event("checked")).rc, 0);
    await first.exit(); assert.equal(contender(base), 0);
    const reopened = await ready(t, base, head); await reopened.exit();
    evidence.observations.push({ case: "real-process-exclusion", journalContenderError: 11, guardContenderStatus: 42 });
  });

  await t.test("acknowledged call-possible survives SIGKILL; same ID takeover, revalidate and confirm", async t => {
    const base = setup(t), old = await ready(t, base);
    await old.record(1); await old.record(3); await old.record(4);
    const head = old.head; assert.equal(head.stamp, 1); await old.kill();
    const next = await ready(t, base, head);
    assert.equal(next.head.stamp, 1); assert.equal(next.head.attempt, 1);
    await next.record(5, 1, false); // reopening must not revive old ownership.
    await next.record(1, 1, false);
    await next.record(1, 2);
    await next.record(5, 1, false); // stale owner cannot confirm.
    await next.record(4, 2, false); // takeover alone grants no eligibility.
    await next.record(5, 2, false); // evidence must be revalidated first.
    await next.record(8, 2); assert.equal(next.head.stamp, 1);
    await next.record(4, 2); assert.equal(next.head.attempt, 2); assert.equal(next.head.stamp, 1);
    await next.record(5, 2); await next.record(6, 2); await next.record(7, 2);
    await next.record(9, 2); assert.equal(next.head.complete, 1); assert.equal(next.head.deliveryUnknown, 1);
    const complete = next.head; await next.exit();
    const again = await ready(t, base, complete); assert.equal(again.head.complete, 1); await again.exit();
    evidence.observations.push({ case: "same-upgrade-recovery", attempt: 2, stampUnknownUntilConfirmation: true });
  });

  await t.test("disconnect persists incomplete and keeps guard; higher owner required for revalidation", async t => {
    const base = setup(t), p = await ready(t, base); await p.record(1);
    p.child.stdin.end(); const interrupted = await p.event("disconnected");
    assert.equal(interrupted.incomplete, 1); assert.equal(contender(base), 42);
    await p.kill(); const next = await ready(t, base, interrupted);
    await next.record(8, 1, false); await next.record(1, 2); await next.record(8, 2);
    assert.equal(next.head.incomplete, 1); await next.exit();
  });

  await t.test("unacknowledged tail, stale head, changed binding and rollback are blocked", async t => {
    const base = setup(t), p = await ready(t, base); await p.record(1); const first = p.head;
    await p.record(3); const latest = p.head; await p.kill();
    for (const [head, binding] of [[first, "same"], [latest, "changed-binding"]]) {
      const q = start(t, base, head, "none", binding); await q.event("open-error"); await q.done;
    }
    fs.unlinkSync(path.join(base, "journal/r-00000000000000000002")); // adversarial test rollback only.
    const q = start(t, base, latest); assert.equal((await q.event("open-error")).error, 116); await q.done;
    evidence.observations.push({ case: "unknown-tail", automaticReconciliationImplemented: false });
  });

  for (const fault of ["write-short", "write-eintr", "partial-eio", "write-zero", "read-corrupt",
    "file-before", "file-after", "dir-before", "dir-after", "close-before", "close-after"]) {
    await t.test(`real IO with ${fault}`, async t => {
      const base = setup(t), p = await ready(t, base, zero, fault);
      const success = ["write-short", "write-eintr"].includes(fault);
      const result = await p.record(1, 1, success);
      if (success) {
        const head = p.head; assert.equal(result.syncCalls, 2); await p.exit();
        const q = await ready(t, base, head); await q.exit();
      } else {
        assert.equal(result.outcome, 1); await p.event("poisoned");
        if (fault.startsWith("close-")) {
          assert.equal(result.closeCalls, 1); assert.equal(result.closeError, 4);
          assert.equal(result.reuseAlive, fault === "close-after" ? 1 : 0);
        }
        assert.equal(contender(base), 42);
        await p.kill();
        const q = start(t, base); await q.event("open-error"); await q.done;
      }
      evidence.observations.push({ fault, ...result });
    });
  }

  for (const point of ["create-kill", "write-kill", "file-kill", "dir-kill"]) {
    await t.test(`SIGKILL after ${point} retains tail and refuses empty checkpoint`, async t => {
      const base = setup(t), p = await ready(t, base, zero, point);
      p.send("1 1"); await p.event("boundary"); assert.equal(contender(base), 42);
      await p.kill(); assert.equal(contender(base), 0);
      assert.equal(fs.readdirSync(path.join(base, "journal")).length, 1);
      const q = start(t, base); await q.event("open-error"); await q.done;
    });
  }

  await t.test("corrupt bytes and symlink record refuse replay", async t => {
    const base = setup(t), p = await ready(t, base); await p.record(1); const head = p.head; await p.exit();
    const file = path.join(base, "journal/r-00000000000000000001"), bytes = fs.readFileSync(file);
    bytes[160] ^= 1; fs.writeFileSync(file, bytes);
    const q = start(t, base, head); await q.event("open-error"); await q.done;
    fs.unlinkSync(file); fs.symlinkSync("/dev/null", file);
    const r = start(t, base, head); await r.event("open-error"); await r.done;
  });

  const diskBytes = base => Object.fromEntries(fs.readdirSync(path.join(base, "journal")).sort()
    .map(name => [name, fs.readFileSync(path.join(base, "journal", name)).toString("hex")]));
  const diskIdentity = base => Object.fromEntries(fs.readdirSync(path.join(base, "journal")).sort().map(name => {
    const s = fs.statSync(path.join(base, "journal", name), { bigint: true });
    return [name, [s.dev, s.ino, s.mode, s.size, s.nlink].map(String)];
  }));
  const witnessFiles = w => Object.fromEntries(fs.readdirSync(w.store).sort().map(name => {
    const file = path.join(w.store, name), s = fs.statSync(file, { bigint: true });
    return [name, { bytes: fs.readFileSync(file).toString("hex"),
      identity: [s.dev, s.ino, s.mode, s.size, s.nlink].map(String) }];
  }));
  await t.test("independently registered directory rejects byte-identical journal at another inode", async t => {
    const f = await unconfirmed(t), w = await witness(t, f), clone = setup(t);
    for (const name of fs.readdirSync(path.join(f.base, "journal")))
      fs.copyFileSync(path.join(f.base, "journal", name), path.join(clone, "journal", name));
    assert.notEqual(String(fs.statSync(path.join(clone, "journal"), { bigint: true }).ino), f.directoryIdentity.ino);
    const before = diskBytes(f.base), originalIdentity = diskIdentity(f.base), copied = diskBytes(clone),
      copiedIdentity = diskIdentity(clone), external = witnessFiles(w);
    assert.deepEqual(copied, before);
    const p = recovery(t, clone, f.anchor); assert.equal((await p.event("view")).kind, 1);
    const q = await prepare(p), signed = await receipt(w, q, f.intent);
    // Record the vulnerable grant/handle as evidence before asserting rejection.
    p.send(`ACCEPT ${signed.receipt}`); const result = await p.event("accepted");
    evidence.observations.push({ identityCase: "copied-inode", registered: f.directoryIdentity,
      requested: { dev: Buffer.from(q, "hex").readBigUInt64LE(768).toString(),
        ino: Buffer.from(q, "hex").readBigUInt64LE(776).toString(),
        owner: Buffer.from(q, "hex").readBigUInt64LE(784).toString() },
      witnessStatus: signed.status, committed: signed.committed, handle: result.handle });
    assert.equal(signed.status, 2); assert.equal(signed.committed, false); assert.equal(result.handle, 0);
    assert.deepEqual(diskBytes(f.base), before); assert.deepEqual(diskIdentity(f.base), originalIdentity);
    assert.deepEqual(diskBytes(clone), copied); assert.deepEqual(diskIdentity(clone), copiedIdentity);
    assert.deepEqual(witnessFiles(w), external); await p.exit();
  });

  for (const [field, offset] of [["dev", 768], ["ino", 776], ["owner", 784]]) {
    await t.test(`registered directory ${field} conflict rejects request identity self-report`, async t => {
      const f = await unconfirmed(t), w = await witness(t, f), before = diskBytes(f.base),
        identities = diskIdentity(f.base), external = witnessFiles(w);
      const p = recovery(t, f.base, f.anchor); await p.event("view");
      const actual = await prepare(p), forged = Buffer.from(actual, "hex");
      forged.writeBigUInt64LE(forged.readBigUInt64LE(offset) + 1n, offset);
      const denied = await receipt(w, forged.toString("hex"), f.intent);
      evidence.observations.push({ identityCase: field, status: denied.status, committed: denied.committed });
      assert.equal(denied.status, 2); assert.equal(denied.committed, false);
      assert.equal((await accept(p, denied.receipt, false)).handle, 0);
      assert.deepEqual(diskBytes(f.base), before); assert.deepEqual(diskIdentity(f.base), identities);
      assert.deepEqual(witnessFiles(w), external); await p.exit();
    });
  }

  await t.test("independent owner registration conflict cannot be replaced by an honest request", async t => {
    const f = await unconfirmed(t);
    const registered = { ...f, directoryIdentity: { ...f.directoryIdentity,
      owner: (BigInt(f.directoryIdentity.owner) + 1n).toString() } };
    const w = await witness(t, registered), before = diskBytes(f.base), identities = diskIdentity(f.base), external = witnessFiles(w);
    const p = recovery(t, f.base, f.anchor); await p.event("view");
    const q = await prepare(p), denied = await receipt(w, q, f.intent);
    evidence.observations.push({ identityCase: "pre-registered-owner-conflict", status: denied.status, committed: denied.committed });
    assert.equal(denied.status, 2); assert.equal(denied.committed, false);
    assert.equal((await accept(p, denied.receipt, false)).handle, 0);
    assert.deepEqual(diskBytes(f.base), before); assert.deepEqual(diskIdentity(f.base), identities);
    assert.deepEqual(witnessFiles(w), external); await p.exit();
  });
  await t.test("bounded complete tail: default denial, independent signed CAS, same ID and exact reserved owner", async t => {
    const f = await unconfirmed(t), before = diskBytes(f.base), identities = diskIdentity(f.base), w = await witness(t, f);
    const denied = recovery(t, f.base, f.anchor, { defaults: true });
    assert.equal((await denied.event("view")).kind, 1);
    const deniedQ = await prepare(denied);
    const signed = await receipt(w, deniedQ, f.intent, "unknown-before");
    assert.equal((await accept(denied, signed.receipt, false)).error, 95);
    await denied.exit();
    const p = recovery(t, f.base, f.anchor); const view = await p.event("view");
    assert.equal(view.kind, 1); assert.equal(view.prefix, 1);
    const waiting = start(t, f.base, f.observed);
    assert.equal((await waiting.event("open-error")).error, 11); await waiting.done;
    const q = await prepare(p); assert.equal(await prepare(p), q, "same session, same request nonce");
    p.send("TAIL 3"); assert.equal((await p.event("tail")).wire, f.intent.toString("hex"));
    p.send("TAIL 2"); assert.equal((await p.event("tail")).rc, -1);
    assert.equal((await accept(p, signed.receipt, false)).error, 116, "receipt from another nonce cannot replay");
    for (const mode of ["wrong-key", "wrong-plan", "unknown-after"]) {
      const r = await receipt(w, q, f.intent, mode);
      const result = await accept(p, r.receipt, false);
      assert.equal(result.cas, mode === "unknown-after" ? 3 : 0);
      assert.deepEqual(diskBytes(f.base), before);
      assert.deepEqual(diskIdentity(f.base), identities);
    }
    assert.equal((await accept(p, "missing", false)).cas, 3);
    const confirmed = await receipt(w, q, f.intent);
    const answer = await accept(p, confirmed.receipt, true); assert.equal(answer.cas, 1);
    p.head = await p.event("state"); assert.equal(p.head.stamp, 1); assert.equal(p.head.sequence, 3);
    assert.deepEqual(diskBytes(f.base), before, "head adoption itself must not overwrite/append bytes");
    assert.deepEqual(diskIdentity(f.base), identities);
    await p.record(1, 1, false); await p.record(1, 3, false);
    await p.record(1, 2); await p.record(8, 2); assert.equal(p.head.stamp, 1);
    await p.record(4, 2); assert.equal(p.head.attempt, 2);
    for (const [name, hex] of Object.entries(before)) assert.equal(diskBytes(f.base)[name], hex);
    await p.exit();
    evidence.observations.push({ recovery: "complete-tail", defaultDenied: true, independentWitnessPid: w.child.pid,
      testKeyOnly: true, externalCasUnknownPreserved: true, executionAuthorized: false });
  });

  await t.test("external CAS unknown across process death: stale anchor and old receipt never resume", async t => {
    const f = await unconfirmed(t), before = diskBytes(f.base), w = await witness(t, f);
    const old = recovery(t, f.base, f.anchor); await old.event("view");
    const q = await prepare(old), lost = await receipt(w, q, f.intent, "unknown-after");
    assert.equal(lost.committed, true); assert.equal((await accept(old, lost.receipt, false)).cas, 3);
    await old.kill();
    const next = recovery(t, f.base, f.anchor); await next.event("view");
    const newQ = await prepare(next); assert.notEqual(newQ, q);
    const oldConfirm = await receipt(w, q, f.intent);
    assert.equal((await accept(next, oldConfirm.receipt, false)).error, 116);
    const conflict = await receipt(w, newQ, f.intent); assert.equal(conflict.status, 2);
    assert.equal((await accept(next, conflict.receipt, false)).cas, 2);
    assert.deepEqual(diskBytes(f.base), before); await next.exit();
    evidence.observations.push({ recovery: "cas-unknown-death", needsAuthoritativeAnchorAndFenceRefresh: true });
  });

  await t.test("torn tail, corrupt tail, changed ID and bound excess remain immutable and ungrantable", async t => {
    const base = setup(t), old = await ready(t, base, zero, "partial-eio");
    await old.record(1, 1, false); await old.kill();
    const before = diskBytes(base); assert.equal(Buffer.from(Object.values(before)[0], "hex").length, 17);
    const torn = recovery(t, base, zero); assert.equal((await torn.event("view")).kind, 2);
    torn.send("PREPARE"); assert.equal((await torn.event("prepared")).rc, -1);
    assert.equal((await accept(torn, "missing", false)).handle, 0); await torn.exit();
    assert.deepEqual(diskBytes(base), before);
    const f = await unconfirmed(t);
    const bound = recovery(t, f.base, f.ownerAnchor, { bound: 1 });
    assert.equal((await bound.event("view")).kind, 5); bound.send("PREPARE");
    assert.equal((await bound.event("prepared")).rc, -1); await bound.exit();
    const other = recovery(t, f.base, f.anchor, { binding: "other-id" });
    assert.equal((await other.event("view")).kind, 4); await other.exit();
    const file = path.join(f.base, "journal/r-00000000000000000003"), bytes = fs.readFileSync(file);
    bytes[160] ^= 1; fs.writeFileSync(file, bytes);
    const corrupt = recovery(t, f.base, f.anchor); assert.equal((await corrupt.event("view")).kind, 3);
    corrupt.send("PREPARE"); assert.equal((await corrupt.event("prepared")).rc, -1); await corrupt.exit();
    assert.deepEqual(fs.readFileSync(file), bytes);
  });

  for (const point of ["sync-before", "sync-after", "sync-kill"]) {
    await t.test(`recovery stabilization ${point}: no head adoption or record mutation`, async t => {
      const f = await unconfirmed(t), before = diskBytes(f.base);
      const p = recovery(t, f.base, f.anchor); await p.event("view");
      p.send(`FAULT ${point}`); p.send("PREPARE");
      if (point === "sync-kill") { await p.event("sync-boundary"); await p.kill(); }
      else {
        const result = await p.event("prepared"); assert.equal(result.rc, -1); assert.equal(result.error, 5);
        await p.exit();
      }
      assert.deepEqual(diskBytes(f.base), before);
    });
  }

  await t.test("external CAS committed but local recheck fails: retain commit fact and all unknown bytes", async t => {
    const f = await unconfirmed(t), w = await witness(t, f), p = recovery(t, f.base, f.anchor);
    await p.event("view"); const q = await prepare(p), signed = await receipt(w, q, f.intent);
    const file = path.join(f.base, "journal/r-00000000000000000003"), bytes = fs.readFileSync(file);
    bytes[160] ^= 1; fs.writeFileSync(file, bytes); // injected protected-domain violation, must detect.
    const result = await accept(p, signed.receipt, false); assert.equal(result.cas, 1);
    assert.deepEqual(fs.readFileSync(file), bytes); await p.exit();
  });

  await t.test("cross-container persistent volume fixture (storage model only)", async t => {
    const base = fs.mkdtempSync(path.join(storage, "persist-")); fs.chmodSync(base, 0o700);
    for (const name of ["index", "journal"]) fs.mkdirSync(path.join(base, name), { mode: 0o700 });
    const p = await ready(t, base); await p.record(1); await p.record(2);
    const head = p.head; await p.exit();
    fs.writeFileSync(path.join(build, "persistent-model.json"), JSON.stringify({ binary, base, head }));
  });
});
