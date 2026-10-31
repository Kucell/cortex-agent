"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { startPermitManagedSession } = require("../../lib/coordination/permit-managed-session");

const cli = path.join(__dirname, "../../bin/cli.js");

test("permit commands refuse direct invocation without a managed session", () => {
  const result = spawnSync(process.execPath, [cli, "permit", "key", "--input", "missing.json"], { encoding: "utf8" });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /managed session required/);
});

test("managed CLI sends an authenticated request and returns the public result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permit-cli-test-"));
  const input = path.join(root, "input.json");
  fs.writeFileSync(input, JSON.stringify({ fingerprint: "test" }), { mode: 0o600 });
  let session;
  let child;
  try {
    ({ session, child } = await startPermitManagedSession({ modulePath: cli,
      args: ["permit", "key", "--input", input],
      authority: { dispatch: (identity, action, payload) => {
        assert.ok(identity.pid > 0);
        assert.equal(action, "key");
        return { fingerprint: payload.fingerprint };
      } },
    }));
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part) => { output += part; });
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    const ready = new Promise((resolve) => child.on("message", (message) => {
      if (message && message.type === "permit.result-ready") resolve();
    }));
    await session.request("permit.start", {});
    await ready;
    await session.close("test_complete");
    assert.equal(await exited, 0);
    assert.deepEqual(JSON.parse(output), { ok: true, action: "key", result: { fingerprint: "test" } });
  } finally {
    if (session) await session.close("test_cleanup");
    if (child && child.exitCode === null) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed issuance creates an exclusive private output before issuing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permit-cli-test-"));
  const input = path.join(root, "input.json");
  const output = path.join(root, "permit.json");
  fs.writeFileSync(input, JSON.stringify({ lease: {}, permit: {} }), { mode: 0o600 });
  let calls = 0;
  const authority = { dispatch: (_identity, action) => {
    assert.equal(action, "issue");
    calls += 1;
    return { fingerprint: "f", publicKeyPem: "public", signedPermit: { signature: "signed" } };
  } };
  async function run() {
    const { session, child } = await startPermitManagedSession({ modulePath: cli,
      args: ["permit", "issue", "--input", input, "--output", output], authority });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part) => { stdout += part; });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const ready = new Promise((resolve) => child.on("message", (message) => {
      if (message && message.type === "permit.result-ready") resolve();
    }));
    try {
      await session.request("permit.start", {});
      await ready;
      await session.close("test_complete");
      return { code: await exited, stdout };
    } finally {
      await session.close("test_cleanup");
      if (child.exitCode === null) child.kill();
    }
  }
  try {
    const first = await run();
    assert.equal(first.code, 0);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const original = fs.readFileSync(output, "utf8");
    assert.match(original, /signed/);
    assert.doesNotMatch(first.stdout, /signed|PRIVATE KEY/);
    const second = await run();
    assert.equal(second.code, 3);
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(output, "utf8"), original);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("private PEM input is refused before any managed operation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permit-cli-test-"));
  const input = path.join(root, "input.json");
  fs.writeFileSync(input, JSON.stringify({ value: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----" }));
  let calls = 0;
  let session;
  let child;
  try {
    ({ session, child } = await startPermitManagedSession({ modulePath: cli,
      args: ["permit", "key", "--input", input], authority: { dispatch: () => { calls += 1; } } }));
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (part) => { stderr += part; });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const ready = new Promise((resolve) => child.on("message", (message) => {
      if (message && message.type === "permit.result-ready") resolve();
    }));
    await session.request("permit.start", {});
    await ready;
    await session.close("test_complete");
    assert.equal(await exited, 3);
    assert.equal(calls, 0);
    assert.doesNotMatch(stderr, /secret|PRIVATE KEY/);
  } finally {
    if (session) await session.close("test_cleanup");
    if (child && child.exitCode === null) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
