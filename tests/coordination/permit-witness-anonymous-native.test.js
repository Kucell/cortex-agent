"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const native = path.join(root, "packages/permit-witness-macos/native-anonymous");
const fixture = path.join(__dirname, "fixtures");
let executionLog;
function command(file, args, options = {}) {
  const run = spawnSync(file, args, { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024, ...options });
  if(executionLog)fs.appendFileSync(executionLog,JSON.stringify({file,args,status:run.status,signal:run.signal,stderr:run.stderr,error:run.error?.message})+"\n");
  assert.ifError(run.error);
  assert.equal(run.signal, null, run.stderr);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return run.stdout;
}
const locallyVerified = process.platform === "darwin" && process.arch === "arm64" && os.release() === "27.0.0";
const requireVerifiedPlatform = process.env.PERMIT_WITNESS_REQUIRE_ANONYMOUS_NATIVE === "1";
test("native anonymous candidate: compile and exercise real macOS children", {
  timeout: 120000,
  skip: !locallyVerified && !requireVerifiedPlatform ? "only the verified Darwin arm64 runtime is supported" : false,
}, async t => {
  // Dedicated platform gates must set PERMIT_WITNESS_REQUIRE_ANONYMOUS_NATIVE=1
  // so an unsupported runner fails rather than reporting a successful skip.
  assert.equal(process.platform, "darwin", "UNSUPPORTED: only locally verified macOS is enabled");
  assert.equal(process.arch, "arm64", "UNSUPPORTED: arm64 only");
  assert.equal(os.release(), "27.0.0", "UNSUPPORTED: Darwin patch not verified");
  assert.equal(command("/usr/bin/sw_vers", ["-productVersion"]).trim(), "27.0.1");
  const build = fs.mkdtempSync(path.join(root,".agent/runtime/pw-anonymous-build-"));
  executionLog=path.join(build,"commands.jsonl");t.diagnostic(executionLog);
  const base = ["clang", "-std=c11", "-D_DARWIN_C_SOURCE", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function",
    "-Wno-unused-parameter", "-O1", "-g", "-fsanitize=address,undefined", "-fno-sanitize-recover=undefined", "-fno-omit-frame-pointer", "-I", native];
  const source = path.join(native, "anonymous.c");
  const harness = path.join(fixture, "permit-witness-anonymous-harness.c");
  const peerSource = path.join(fixture, "permit-witness-anonymous-peer.c");
  const modes = ["echo", "quota", "faults", "bad-ack", "oversize", "truncated", "eof", "deadline", "cancel",
    "paused", "backpressure-deadline", "close-read", "trace-limit", "write-reject", "write-exact",
    "write-cancel", "write-shared", "write-bootstrap", "inheritance", "pipe2-failure"];
  for (const mode of modes) await t.test(mode, () => {
    const peerMode = ["quota", "faults", "inheritance", "pipe2-failure", "write-bootstrap"].includes(mode) ? "echo" :
      mode === "write-exact" ? "expect-nine" : mode.startsWith("write-") ? "expect-zero" :
      ["deadline", "cancel", "trace-limit"].includes(mode) ? "stall" : mode === "backpressure-deadline" ? "paused" : mode;
    const peer = path.join(build, `peer-${mode}`);
    command("/usr/bin/xcrun", [...base, `-DPW_PEER_MODE=${JSON.stringify(peerMode)}`, peerSource, "-o", peer]);
    const binary = path.join(build, `harness-${mode}`);
    const sendLimits = { "write-reject": 64, "write-exact": 65, "write-cancel": 65, "write-shared": 129,
      "write-bootstrap": 55 };
    const nativeFlags = ["-DPW_ANONYMOUS_FIXTURE", `-DPW_FIXED_PEER_PATH=${JSON.stringify(peer)}`];
    if (sendLimits[mode]) nativeFlags.push(`-DPW_FIXTURE_SEND_LIMIT=${sendLimits[mode]}`);
    if(mode==="trace-limit"){
      const object=path.join(build,"native-trace.o");
      command("/usr/bin/xcrun",[...base,...nativeFlags,"-Dread=pw_readiness_read","-Dpoll=pw_readiness_poll","-c",source,"-o",object]);
      command("/usr/bin/xcrun",[...base,...nativeFlags,"-DPW_READINESS_TEST",object,harness,path.join(fixture,"permit-witness-anonymous-readiness.c"),"-o",binary]);
    } else if (mode === "inheritance" || mode === "pipe2-failure") {
      const probe = path.join(build, `inventory-${mode}`);
      command("/usr/bin/xcrun", [...base, '-DPW_PEER_MODE="inheritance-probe"', peerSource, "-o", probe]);
      const object = path.join(build, `native-${mode}.o`);
      command("/usr/bin/xcrun", [...base, ...nativeFlags, "-Dpipe2=pw_test_pipe2", "-Dpipe=pw_test_forbidden_pipe",
        "-c", source, "-o", object]);
      command("/usr/bin/xcrun", [...base, ...nativeFlags, "-DPW_PIPE2_TEST",
        ...(mode === "pipe2-failure" ? ["-DPW_PIPE2_ENOSYS"] : []),
        `-DPW_FIXED_INHERITANCE_PROBE=${JSON.stringify(probe)}`, object, harness,
        path.join(fixture, "permit-witness-anonymous-pipe2-probe.c"), "-o", binary]);
    } else command("/usr/bin/xcrun", [...base, ...nativeFlags, source, harness, "-o", binary]);
    // Apple ASan has no LeakSanitizer. FD leak accounting lives in the native
    // harness; do not claim heap-leak coverage from unsupported detect_leaks.
    const output = command(binary, [mode], { cwd: "/", env: { ASAN_OPTIONS: "detect_leaks=0:abort_on_error=1" } });
    const report = JSON.parse(output.trim()); assert.equal(report.status, "OK");
    assert.equal(report.fdLeaks, 0);
    if (!["faults", "pipe2-failure", "write-bootstrap"].includes(mode)) {
      assert.equal(report.executionAuthorized, false); assert.equal(report.treeExitProven, false);
      assert.ok(report.readCalls > 0); assert.ok(report.sessionsRetained >= 1);
      if (mode.startsWith("backpressure") || mode === "paused") assert.ok(report.writeWaits > 0);
      if (mode === "quota") assert.equal(report.received, 1024);
      if (mode === "write-reject") {
        assert.equal(report.reservedSend, 56); assert.equal(report.sent, 56); assert.equal(report.writeCalls, 1);
      }
      if (mode === "write-exact") { assert.equal(report.reservedSend, 65); assert.equal(report.sent, 65); }
      if (mode === "write-cancel") { assert.equal(report.reservedSend, 65); assert.equal(report.sent, 56); }
      if (mode === "write-shared") { assert.equal(report.reservedSend, 121); assert.equal(report.sent, 112); }
      if (mode === "inheritance") {
        assert.equal(report.atomicPairsChecked, 3); assert.equal(report.concurrentSpawnsChecked, 3);
        assert.equal(report.positiveInheritanceControls, 3);
      }
    }
    const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    t.diagnostic(JSON.stringify({ mode, nativeSha256: sha256(binary), peerSha256: sha256(peer), ...report }));
  });
  await t.test("non-fixture build refuses all launches before allocating descriptors", () => {
    const binary = path.join(build, "refuse");
    command("/usr/bin/xcrun", [...base, source, harness, "-o", binary]);
    const report = JSON.parse(command(binary, ["refuse"]).trim());
    assert.deepEqual(report, { status: "UNSAFE_DEPLOYMENT", sessions: 0 });
  });
});
