"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const native = process.platform === "darwin" ? test : (name, fn) => test(name, { skip: "Darwin Security.framework negative controls" }, fn);
function setup(t, configured) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "migration-launcher-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const definitions = configured ? ['-DINVENTORY_WORKER_TEAM="NOT_A_RELEASE_TEAM"', '-DINVENTORY_WORKER_CDHASH="0000000000000000000000000000000000000000"', '-DINVENTORY_WORKER_REQUIREMENT="anchor apple generic"', '-DINVENTORY_WORKER_SIZE=1', '-DINVENTORY_WORKER_SHA256="unconfigured"'] : [];
  const source = path.resolve(__dirname, "../../scripts/native/inventory-launcher.m"), exe = path.join(dir, "inventory");
  const r = spawnSync("/usr/bin/clang", ["-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-mmacosx-version-min=13.0", "-framework", "Foundation", "-framework", "Security", ...definitions, source, "-o", exe], { encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 0, r.stderr); return { dir, exe };
}
function worker(dir, body) {
  const source = path.join(dir, "worker.c"); fs.writeFileSync(source, '#include <unistd.h>\nint main(void){' + body + '}\n');
  const r = spawnSync("/usr/bin/clang", [source, "-o", path.join(dir, "inventory-worker")], { encoding: "utf8", timeout: 30000 }); assert.equal(r.status, 0, r.stderr);
}
function bindHash(dir, exe) {
  const bytes = fs.readFileSync(path.join(dir, "inventory-worker"));
  const definitions = ['-DINVENTORY_WORKER_TEAM="NOT_A_RELEASE_TEAM"', '-DINVENTORY_WORKER_CDHASH="0000000000000000000000000000000000000000"', '-DINVENTORY_WORKER_REQUIREMENT="anchor apple generic"', '-DINVENTORY_WORKER_SIZE=' + bytes.length, '-DINVENTORY_WORKER_SHA256="' + crypto.createHash("sha256").update(bytes).digest("hex") + '"'];
  const r = spawnSync("/usr/bin/clang", ["-fobjc-arc", "-fblocks", "-Wno-deprecated-declarations", "-framework", "Foundation", "-framework", "Security", ...definitions, path.resolve(__dirname, "../../scripts/native/inventory-launcher.m"), "-o", exe], { encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
}
native("unconfigured native release refuses before worker launch", t => {
  const { exe } = setup(t, false), r = spawnSync(exe, [], { input: "PRIVATE_REQUEST", encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 2); assert.match(r.stderr, /MIGRATION_NATIVE_RELEASE_UNAVAILABLE/); assert.equal(r.stdout, "");
});
native("untrusted direct worker never receives project request", t => {
  const { dir, exe } = setup(t, true);
  worker(dir, 'char r=1,b[100];write(3,&r,1);close(3);int n=read(0,b,100);if(n>0)write(1,b,n);return 0;'); bindHash(dir, exe);
  const r = spawnSync(exe, [], { input: "PRIVATE_REQUEST", encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 2); assert.match(r.stderr, /MIGRATION_NATIVE_SIGNATURE_INVALID/); assert.equal(r.stdout, "");
});
native("unsigned early-exit worker is rejected before execution", t => {
  const { dir, exe } = setup(t, true); worker(dir, "return 0;"); bindHash(dir, exe);
  const r = spawnSync(exe, [], { input: "PRIVATE_REQUEST", encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 2); assert.match(r.stderr, /MIGRATION_NATIVE_SIGNATURE_INVALID/); assert.equal(r.stdout, "");
});
native("worker symlink rejected before spawn", t => {
  const { dir, exe } = setup(t, true); fs.symlinkSync("/bin/cat", path.join(dir, "inventory-worker"));
  const r = spawnSync(exe, [], { input: "PRIVATE_REQUEST", encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 2); assert.match(r.stderr, /MIGRATION_NATIVE_PATH_INVALID/);
});

native("native production write loop bounds real pipe backpressure", t => {
  const { dir } = setup(t, false), source = path.join(dir, "backpressure.m"), exe = path.join(dir, "backpressure");
  const production = path.resolve(__dirname, "../../scripts/native/inventory-launcher.m");
  fs.writeFileSync(source, '#define main inventoryLauncherMain\n#include ' + JSON.stringify(production) + '\n#undef main\nint main(void){started=nowMs();int p[2];if(pipe(p))return 3;char b[1048576]={0};writeAll(p[1],b,sizeof(b));return 4;}\n');
  const build = spawnSync("/usr/bin/clang", ["-fobjc-arc", "-fblocks", "-Wno-deprecated-declarations", "-framework", "Foundation", "-framework", "Security", source, "-o", exe], { encoding: "utf8", timeout: 30000 }); assert.equal(build.status, 0, build.stderr);
  const start = Date.now(), r = spawnSync(exe, [], { encoding: "utf8", timeout: 8000 });
  assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /MIGRATION_NATIVE_TIMEOUT/); assert.ok(Date.now() - start < 7500);
});
native("controlled SIGTERM reaps the production loop's own worker", async t => {
  const { dir } = setup(t, false), source = path.join(dir, "cancel.m"), exe = path.join(dir, "cancel");
  const production = path.resolve(__dirname, "../../scripts/native/inventory-launcher.m");
  fs.writeFileSync(source, '#define main inventoryLauncherMain\n#include ' + JSON.stringify(production) + '\n#undef main\nint main(void){started=nowMs();signal(SIGTERM,cancelHandler);child=fork();if(child==0){sleep(30);_exit(0);}printf("%d\\n",child);fflush(stdout);int p[2];if(pipe(p))return 3;char b[1048576]={0};writeAll(p[1],b,sizeof(b));return 4;}\n');
  const build = spawnSync("/usr/bin/clang", ["-fobjc-arc", "-fblocks", "-Wno-deprecated-declarations", "-framework", "Foundation", "-framework", "Security", source, "-o", exe], { encoding: "utf8", timeout: 30000 }); assert.equal(build.status, 0, build.stderr);
  const { spawn } = require("node:child_process"), { once } = require("node:events"), proc = spawn(exe, [], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(proc, "close"); let stderr = ""; proc.stderr.on("data", b => stderr += b);
  const timer = setTimeout(() => proc.kill("SIGTERM"), 7000); t.after(() => clearTimeout(timer));
  const [line] = await once(proc.stdout, "data"), pid = Number(String(line).trim()); assert.ok(Number.isSafeInteger(pid) && pid > 0);
  proc.kill("SIGTERM"); const [code] = await closed; clearTimeout(timer);
  assert.equal(code, 2, stderr); assert.match(stderr, /MIGRATION_NATIVE_CANCELLED/);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
