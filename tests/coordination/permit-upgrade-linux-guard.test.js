"use strict";

const { testRuntime, relocatedTestRuntime } = require("../helpers/runtime-sandbox");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { createHash } = require("node:crypto");

const root = path.resolve(__dirname, "../..");
const source = path.join(root, "packages/permit-upgrade-linux-guard");
const runtime = testRuntime();
const phases = ["configuration", "final-verification", "stamp-marker", "report-marker"];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, message) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const result = action();
    if (result) return result;
    await sleep(15);
  }
  assert.fail(message);
}
function insideRuntime(name) {
  const resolved = path.resolve(name);
  assert.ok(resolved.startsWith(`${runtime}${path.sep}`), `outside runtime: ${name}`);
  fs.mkdirSync(resolved, { recursive: true });
  const real = fs.realpathSync(resolved);
  assert.ok(real.startsWith(`${fs.realpathSync(runtime)}${path.sep}`), `runtime symlink escape: ${name}`);
  return resolved;
}
function identity(name) {
  const st = fs.statSync(name, { bigint: true });
  return { dev: String(st.dev), ino: String(st.ino), owner: String(st.uid) };
}
function waiting(pid) {
  return fs.readFileSync("/proc/locks", "utf8").split("\n")
    .find(line => line.includes("->") && line.includes("FLOCK") && new RegExp(`\\b${pid}\\b`).test(line));
}

class Peer {
  constructor(binary, args, t) {
    this.child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.pid = this.child.pid;
    this.events = [];
    this.stderr = "";
    this.done = once(this.child, "exit");
    let buffer = "";
    this.child.stdout.on("data", data => {
      buffer += data;
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        this.events.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
      }
    });
    this.child.stderr.on("data", data => { this.stderr += data; });
    this.child.stdin.on("error", () => {});
    t.after(async () => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
      await this.done;
      assert.doesNotMatch(this.stderr, /runtime error:|AddressSanitizer/);
    });
  }
  async event(name) {
    return until(() => {
      const index = this.events.findIndex(item => item.event === name);
      if (index < 0) return null;
      return this.events.splice(index, 1)[0];
    }, `${this.pid} missing ${name}; ${JSON.stringify(this.events)}; ${this.stderr}`);
  }
  async held() {
    this.observation = await this.event("held");
    this.sequence = 1;
    assert.equal(this.observation.executionAuthorized, false);
    assert.equal(this.observation.discovery, "discovery-unknown");
    assert.equal(this.observation.fdReused, true);
    return this.observation;
  }
  sendRaw(line) { this.child.stdin.write(`${line}\n`); }
  command(name) { this.sendRaw(`${name} ${this.observation.incarnation} ${this.sequence++}`); }
  async finish() {
    for (const phase of phases) {
      this.command("STEP");
      assert.equal((await this.event("phase")).phase, phase);
    }
    this.command("FINISH");
    const published = await this.event("diagnostic-work-published");
    assert.equal(published.executionAuthorized, false);
    assert.equal(published.release, "pending");
    assert.deepEqual(await this.done, [0, null]);
  }
}

test("Linux native scoped controller: real locks, FD lifetimes and fail-closed sessions", {
  timeout: 90000,
  skip: process.platform !== "linux" && process.env.PERMIT_LINUX_GUARD_REQUIRE !== "1" ? "requires actual Linux" : false,
}, async t => {
  assert.equal(process.platform, "linux", "required native evidence cannot be skipped");
  fs.mkdirSync(runtime, { recursive: true });
  const buildBase = insideRuntime(relocatedTestRuntime(process.env.PERMIT_LINUX_GUARD_BUILD_ROOT, "linux-guard-build"));
  const fixtureBase = insideRuntime(relocatedTestRuntime(process.env.PERMIT_LINUX_GUARD_TEST_ROOT, "linux-guard-fixtures"));
  const build = fs.mkdtempSync(path.join(buildBase, "build-"));
  const binary = path.join(build, "lifecycle-peer");
  const flags = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-Wpedantic", "-O2", "-g",
    "-fstack-protector-strong", "-D_FORTIFY_SOURCE=3",
    ...(process.env.PERMIT_LINUX_GUARD_SANITIZE === "1" ? ["-fsanitize=undefined", "-fno-sanitize-recover=all"] : [])];
  function compile(args) {
    const cc = spawnSync("cc", [...flags, ...args],
      { encoding: "utf8", timeout: 20000, env: { ...process.env, TMPDIR: build } });
    assert.ifError(cc.error);
    assert.equal(cc.status, 0, cc.stdout + cc.stderr);
  }
  compile([path.join(source, "guard.c"), path.join(source, "lifecycle-peer.c"), "-o", binary]);
  const faultObject = path.join(build, "guard-close-fault.o"), faultBinary = path.join(build, "close-fault-peer");
  compile(["-Dclose=pg_test_close", "-Dfstat=pg_test_fstat", "-c", path.join(source, "guard.c"), "-o", faultObject]);
  compile([faultObject, path.join(source, "close-fault-peer.c"), "-o", faultBinary]);
  const evidence = {
    platform: process.platform, arch: process.arch, node: process.version,
    kernel: fs.readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(),
    fsType: fs.statfsSync(fixtureBase).type.toString(16), build,
    sources: Object.fromEntries(["guard.h", "guard.c", "lifecycle-peer.c", "close-fault-peer.c"].map(name =>
      [name, createHash("sha256").update(fs.readFileSync(path.join(source, name))).digest("hex")])),
    observations: [], executionAuthorized: false,
  };
  t.after(() => fs.writeFileSync(path.join(build, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n"));
  t.diagnostic(JSON.stringify({ build, fsType: evidence.fsType, arch: evidence.arch }));
  function fixture(t) {
    const directory = fs.mkdtempSync(path.join(fixtureBase, "case-"));
    fs.chmodSync(directory, 0o700);
    const index = path.join(directory, "index");
    fs.mkdirSync(index, { mode: 0o700 });
    // Keep only metadata evidence, not stale ephemeral tmpfs fixture paths.
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    return { directory, index };
  }
  function argumentsFor(f, mode, overrides = {}) {
    const p = identity(f.directory), d = identity(f.index);
    const output = fs.mkdtempSync(path.join(f.directory, "output-"));
    const args = [f.directory, "index", p.dev, p.ino, d.dev, d.ino, d.owner, mode, output, "upgrade-test", "20000"];
    for (const [index, value] of Object.entries(overrides)) args[Number(index)] = String(value);
    return { args, output };
  }
  function start(t, f, mode = "shared", overrides) {
    const { args, output } = argumentsFor(f, mode, overrides);
    const peer = new Peer(binary, args, t);
    peer.output = output;
    return peer;
  }
  async function blocked(peer) {
    const line = await until(() => waiting(peer.pid), `no real kernel FLOCK waiter for ${peer.pid}`);
    evidence.observations.push({ event: "kernel-waiter", line });
    assert.equal(peer.events.some(x => x.event === "held"), false);
  }

  await t.test("shared guards retain one inode lock through real controller writes; exclusive really waits", async t => {
    const f = fixture(t), first = start(t, f), second = start(t, f);
    await first.held(); await second.held();
    // Both caller root descriptors have already been closed and reused.
    const lockInfos = fs.readdirSync(`/proc/${first.pid}/fdinfo`).map(fd =>
      fs.readFileSync(`/proc/${first.pid}/fdinfo/${fd}`, "utf8"));
    const locked = lockInfos.filter(info => /lock:\s+\d+: FLOCK/.test(info));
    assert.equal(locked.length, 1);
    assert.ok(Number.parseInt(locked[0].match(/flags:\s+(\d+)/)[1], 8) & 0o2000000, "CLOEXEC on private lock FD");
    first.command("CHECK"); await first.event("checked");
    const writer = start(t, f, "exclusive");
    await writer.event("waiting"); await blocked(writer);
    const independentContender = () => spawnSync("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "42", f.index, "/bin/true"]);
    for (const phase of phases) {
      first.command("STEP");
      assert.equal((await first.event("phase")).phase, phase);
      assert.equal(fs.readFileSync(path.join(first.output, phase), "utf8"), "diagnostic marker only\n");
      await blocked(writer);
      assert.equal(independentContender().status, 42, "util-linux independently observes the held lock");
    }
    first.command("FINISH"); await first.event("diagnostic-work-published");
    assert.deepEqual(await first.done, [0, null]);
    await blocked(writer); // second SH guard, not a local Promise, is the barrier.
    await second.finish(); await writer.held(); await writer.finish();
    assert.equal(independentContender().status, 0);
    assert.deepEqual(fs.readdirSync(f.index), [], "no lock file/journal/DB created");
  });

  await t.test("exclusive-first ordering blocks discovery primitive until installer scope finishes", async t => {
    const f = fixture(t), exclusive = start(t, f, "exclusive"); await exclusive.held();
    const shared = start(t, f); await blocked(shared);
    await exclusive.finish(); await shared.held(); await shared.finish();
  });

  await t.test("SIGKILL releases kernel lock; stale observation cannot resume a new incarnation", async t => {
    const f = fixture(t), old = start(t, f); const observation = await old.held();
    const exclusive = start(t, f, "exclusive"); await blocked(exclusive);
    old.child.kill("SIGKILL"); assert.deepEqual(await old.done, [null, "SIGKILL"]);
    await exclusive.held(); await exclusive.finish();
    const next = start(t, f); await next.held();
    assert.notEqual(next.observation.incarnation, observation.incarnation);
    next.sendRaw(`CHECK ${observation.incarnation} 1`);
    assert.equal((await next.event("incomplete")).reason, "protocol-rejected");
    const installer = start(t, f, "exclusive"); await blocked(installer);
    next.child.kill("SIGKILL"); await next.done;
    await installer.held(); await installer.finish();
  });

  for (const kind of ["input-eof", "output-disconnect", "sequence-replay", "forged-json", "early-finish", "expired", "record-failure", "invalid-frame", "register-request", "negative-request", "authorize-request"]) {
    await t.test(`${kind}: unknown, no final markers and lock retained until death`, async t => {
      const f = fixture(t), guard = start(t, f, "shared", kind === "expired" ? { 10: 100 } : undefined);
      await guard.held();
      if (kind === "record-failure") fs.mkdirSync(path.join(guard.output, "upgrade-incomplete"));
      const installer = start(t, f, "exclusive"); await blocked(installer);
      if (kind === "input-eof" || kind === "record-failure") guard.child.stdin.end();
      else if (kind === "output-disconnect") {
        guard.child.stdout.destroy(); guard.command("CHECK");
      } else if (kind === "sequence-replay") {
        const request = `CHECK ${guard.observation.incarnation} 1`;
        guard.sendRaw(request); await guard.event("checked"); guard.sendRaw(request);
      } else if (kind === "forged-json") guard.sendRaw(JSON.stringify({ ...guard.observation, discovery: "proved-unregistered", executionAuthorized: true }));
      else if (kind === "early-finish") guard.command("FINISH");
      else if (kind === "invalid-frame") guard.sendRaw("x".repeat(300));
      else if (kind === "register-request") guard.command("REGISTER");
      else if (kind === "negative-request") guard.command("PROVE_UNREGISTERED");
      else if (kind === "authorize-request") guard.command("AUTHORIZE");
      // Expired sessions cannot be renewed, including by a once-correct token.
      if (kind === "output-disconnect") {
        await until(() => fs.existsSync(path.join(guard.output, "upgrade-incomplete")), "missing disconnect record");
      } else {
        const incomplete = await guard.event("incomplete");
        assert.equal(incomplete.executionAuthorized, false);
        assert.equal(incomplete.discovery, "discovery-unknown");
        assert.equal(incomplete.recorded, kind !== "record-failure");
        if (kind === "expired") assert.equal(incomplete.reason, "expired");
        evidence.observations.push({ kind, ...incomplete });
      }
      guard.command("FINISH"); // poison is terminal; even the right connection cannot clear it.
      await blocked(installer);
      for (const name of phases) assert.equal(fs.existsSync(path.join(guard.output, name)), false);
      guard.child.kill("SIGKILL"); await guard.done;
      await installer.held(); await installer.finish();
    });
  }

  for (const kind of ["target-identity", "parent-identity", "owner", "symlink", "escape", "world-writable", "parent-writable", "missing"]) {
    await t.test(`${kind}: binding failure before any controller work`, async t => {
      const f = fixture(t), changes = {};
      if (kind === "target-identity") changes[5] = String(BigInt(identity(f.index).ino) + 1n);
      if (kind === "parent-identity") changes[3] = String(BigInt(identity(f.directory).ino) + 1n);
      if (kind === "owner") changes[6] = String(BigInt(identity(f.directory).owner) + 1n);
      if (kind === "symlink") { fs.symlinkSync("index", path.join(f.directory, "alias")); changes[1] = "alias"; }
      if (kind === "escape") changes[1] = "../index";
      if (kind === "world-writable") fs.chmodSync(f.index, 0o777);
      if (kind === "parent-writable") fs.chmodSync(f.directory, 0o777);
      if (kind === "missing") changes[1] = "missing";
      const peer = start(t, f, "shared", changes);
      assert.equal((await peer.event("refused")).executionAuthorized, false);
      assert.deepEqual(await peer.done, [70, null]);
      assert.deepEqual(fs.readdirSync(peer.output), []);
    });
  }

  await t.test("renamed/replaced pathname poisons original bound inode; cannot retarget flock", async t => {
    const f = fixture(t), guard = start(t, f); await guard.held();
    fs.renameSync(f.index, path.join(f.directory, "original")); fs.mkdirSync(f.index, { mode: 0o700 });
    guard.command("CHECK"); assert.equal((await guard.event("incomplete")).reason, "binding-lost");
    // Same OFD continues to lock the ORIGINAL inode. A replacement inode can be
    // locked independently: this is why a mutable project path is not a registry.
    const oldIndex = { ...f, index: path.join(f.directory, "original") };
    const writer = start(t, oldIndex, "exclusive", { 1: "original" }); await blocked(writer);
    const replacement = start(t, f, "exclusive"); await replacement.held(); await replacement.finish();
    guard.child.kill("SIGKILL"); await guard.done;
    await writer.held(); await writer.finish();
  });

  await t.test("unsupported filesystem is refused rather than silently claiming local semantics", async t => {
    const f = fixture(t);
    const proc = identity("/proc");
    const peer = start(t, f, "shared", { 0: "/proc", 1: ".", 2: proc.dev, 3: proc.ino, 4: proc.dev, 5: proc.ino, 6: proc.owner });
    assert.equal((await peer.event("refused")).errno, 95); // Linux EOPNOTSUPP
    assert.deepEqual(await peer.done, [70, null]);
  });

  await t.test("disconnect while acquiring cannot become a usable session when the lock arrives", async t => {
    const f = fixture(t), exclusive = start(t, f, "exclusive"); await exclusive.held();
    const disconnected = start(t, f); await blocked(disconnected);
    disconnected.child.stdin.end();
    await exclusive.finish(); await disconnected.held();
    assert.equal((await disconnected.event("incomplete")).reason, "connection-lost");
    assert.deepEqual(fs.readdirSync(disconnected.output), ["upgrade-incomplete"]);
    const installer = start(t, f, "exclusive"); await blocked(installer);
    disconnected.child.kill("SIGKILL"); await disconnected.done;
    await installer.held(); await installer.finish();
  });

  await t.test("counterexample: controller death does not drain an external writer; registration remains unsupported", async t => {
    const f = fixture(t), guard = start(t, f); await guard.held();
    const file = path.join(f.directory, "residual-writer");
    const writer = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      const fd = fs.openSync(process.argv[1], "wx", 0o600);
      process.stdout.write("ready\\n");
      process.stdin.once("data", () => { fs.writeSync(fd, "late write"); fs.closeSync(fd); process.stdout.write("written\\n"); });
    `, file], { stdio: ["pipe", "pipe", "pipe"] });
    const done = once(writer, "exit");
    let output = "";
    writer.stdout.on("data", data => { output += data; });
    t.after(async () => { if (writer.exitCode === null) writer.kill("SIGKILL"); await done; });
    await until(() => output.includes("ready"), "residual writer did not start");
    const contender = start(t, f, "exclusive"); await blocked(contender);
    guard.child.kill("SIGKILL"); await guard.done; await contender.held();
    // A genuine live process still writes after EX lock acquisition. Therefore
    // we categorically do NOT publish registration or claim a startup fence.
    writer.stdin.end("write\n");
    await until(() => output.includes("written"), "residual writer did not demonstrate late write");
    assert.deepEqual(await done, [0, null]);
    assert.equal(fs.readFileSync(file, "utf8"), "late write");
    assert.equal(contender.observation.executionAuthorized, false);
    contender.command("REGISTER");
    assert.equal((await contender.event("incomplete")).reason, "protocol-rejected");
    evidence.observations.push({ event: "external-writer-counterexample", lateWriteAfterExclusive: true, registrationSupported: false });
  });

  for (const point of ["initial-check", "work-check", "final-check", "lock", "parent", "primary-and-cleanup"]) {
    for (const timing of ["before", "after"]) {
      await t.test(`close ${point} ${timing}: single attempt, no false success or reused-FD close`, async t => {
        const f = fixture(t), output = path.join(f.directory, "published-marker");
        const call = { "initial-check": 1, "work-check": 2, "final-check": 3, lock: 4, parent: 5, "primary-and-cleanup": 1 }[point];
        const primary = point === "primary-and-cleanup";
        const peer = new Peer(faultBinary, [f.directory, f.index, output, String(call), timing, primary ? "1" : "0", primary && timing === "before" ? "1" : "0"], t);
        const contender = () => spawnSync("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "42", f.index, "/bin/true"]).status;
        const injection = await peer.event("close-injected");
        assert.equal(injection.call, call);
        if (point === "work-check" || point === "final-check") {
          await peer.event("published");
          if (point === "work-check") {
            const check = await peer.event("check-failed");
            assert.equal(check.error, 4); assert.equal(check.checkCloseError, 4);
            assert.equal(check.workCompleted, 0); assert.equal(check.lockState, 1);
          }
          // Final-check failure cannot return or issue a successful result.
          const installer = start(t, f, "exclusive"); await blocked(installer);
          assert.equal(contender(), 42);
          assert.equal(fs.readFileSync(output, "utf8"), "published\n");
          assert.equal(peer.events.some(x => x.event === "result"), false);
          if (timing === "after") assert.equal(fs.readlinkSync(`/proc/${peer.pid}/fd/${injection.reused}`), "/dev/null");
          peer.child.kill("SIGKILL"); await peer.done;
          await installer.held(); await installer.finish();
          evidence.observations.push({ point, timing, published: true, failedClosed: true });
          return;
        }
        const result = await peer.event("result");
        evidence.observations.push({ point, timing, ...result });
        assert.equal(result.rc, -1); assert.equal(result.errno, primary ? 116 : 4);
        assert.equal(result.error, primary ? 116 : 4);
        assert.equal(result.retried, 0); assert.equal(result.reuseAlive, timing === "after" ? 1 : 0);
        const completed = point === "lock" || point === "parent";
        assert.equal(result.workStarted, completed ? 1 : 0); assert.equal(result.workCompleted, completed ? 1 : 0);
        assert.equal(fs.readFileSync(output, "utf8"), completed ? "published\n" : "");
        assert.equal(result.checkCloseError, completed ? 0 : 4);
        assert.equal(result.lockCloseError, point === "lock" || (primary && timing === "before") ? 4 : 0);
        assert.equal(result.parentCloseError, point === "parent" ? 4 : 0);
        assert.equal(result.closeCalls, completed ? 5 : 3);
        const unknown = point === "lock" || (primary && timing === "before");
        assert.equal(result.lockState, unknown ? 3 : 2);
        assert.equal(contender(), unknown && timing === "before" ? 42 : 0);
        peer.child.stdin.end("exit\n"); assert.deepEqual(await peer.done, [70, null]);
        assert.equal(contender(), 0, "process death reaps an actually retained FD");
      });
    }
  }
});
