"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const root = path.resolve(__dirname,"../..");
const native = path.join(root,"packages/permit-witness-macos/native-anonymous");
const fixtures = path.join(__dirname,"fixtures");
function compile(args) {
  const r = spawnSync("/usr/bin/xcrun",args,{encoding:"utf8",timeout:20000});
  assert.ifError(r.error); assert.equal(r.status,0,r.stdout+r.stderr);
}
const locallyVerified = process.platform === "darwin" && process.arch === "arm64" && os.release() === "27.0.0" && process.version === "v24.11.0";
const requireVerifiedPlatform = process.env.PERMIT_WITNESS_REQUIRE_ANONYMOUS_NATIVE === "1";
test("independent N-API candidate uses opaque capabilities and a native owner", {
  timeout: 120000,
  skip: !locallyVerified && !requireVerifiedPlatform ? "only the verified Darwin arm64 and Node runtime is supported" : false,
}, async t=> {
  assert.equal(process.platform,"darwin"); assert.equal(process.arch,"arm64"); assert.equal(os.release(),"27.0.0");
  assert.equal(process.version,"v24.11.0","only this Node patch is validated by this test");
  const runtime = testRuntime(); fs.mkdirSync(runtime,{recursive:true});
  const build = fs.mkdtempSync(path.join(runtime,"permit-witness-anonymous-napi-"));
  const includes = path.resolve(process.execPath,"../../include/node");
  assert.ok(fs.existsSync(path.join(includes,"node_api.h")));
  const base = ["-D_DARWIN_C_SOURCE","-Wall","-Wextra","-Werror","-Wno-unused-function","-O1","-g","-I",native];
  const sha = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  t.diagnostic(`build artifacts: ${path.relative(root,build)}`);
  for (const mode of ["default","core-fixture-only","echo","stall","deadline","bad-ack","quota","worker-cleanup"]) {
    await t.test(mode,async()=> {
      const peer = path.join(build,`peer-${mode}`);
      const peerMode = ["stall","deadline","worker-cleanup"].includes(mode) ? "stall" : mode === "quota" ? "expect-zero" : mode === "bad-ack" ? "bad-ack" : "echo";
      compile(["clang","-std=c11",...base,`-DPW_PEER_MODE=${JSON.stringify(peerMode)}`,
        path.join(fixtures,"permit-witness-anonymous-peer.c"),"-o",peer]);
      const core = path.join(build,`core-${mode}.o`), addon = path.join(build,`addon-${mode}.o`);
      const fixtureFlags = mode === "default" ? [] : ["-DPW_ANONYMOUS_FIXTURE",`-DPW_FIXED_PEER_PATH=${JSON.stringify(peer)}`];
      compile(["clang","-std=c11",...base,...fixtureFlags,...(mode === "quota" ? ["-DPW_FIXTURE_SEND_LIMIT=64"] : []),
        "-Dread=pw_napi_test_read","-Dwrite=pw_napi_test_write","-Dwaitpid=pw_napi_test_waitpid","-Dposix_spawn=pw_napi_test_spawn",
        "-c",path.join(native,"anonymous.c"),"-o",core]);
      compile(["clang++","-std=c++17",...base,"-I",includes,
        ...(["default","core-fixture-only"].includes(mode) ? [] : ["-DPW_ANONYMOUS_FIXTURE","-DPW_NAPI_FIXTURE"]),
        "-c",path.join(native,"addon.cc"),"-o",addon]);
      const probe = path.join(build,`probe-${mode}.o`);
      compile(["clang","-std=c11",...base,"-c",path.join(fixtures,"permit-witness-anonymous-napi-thread-probe.c"),"-o",probe]);
      const binary = path.join(build,`${mode}.node`);
      compile(["clang++","-bundle","-undefined","dynamic_lookup",core,addon,probe,"-o",binary]);
      const run = await exec(process.execPath,["--unhandled-rejections=strict",path.join(fixtures,"permit-witness-anonymous-napi-client.js"),binary,
        mode === "core-fixture-only" ? "default" : mode],{timeout:12000,maxBuffer:1024*1024});
      assert.equal(run.stderr,""); const result = JSON.parse(run.stdout.trim());
      t.diagnostic(JSON.stringify({mode,sha256:sha(binary),peerSha256:sha(peer),...result}));
    });
  }
});
