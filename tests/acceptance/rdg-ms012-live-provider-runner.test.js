"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const runner = path.resolve(__dirname, "../../scripts/validation/rdg-ms012-live-provider.js");

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(result.stderr || result.stdout || "git failed");
  }
  return result;
}

test("live provider runner proves lease-CAS semantics and cleans temporary branch", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ms012-live-runner-"));
  const bare = path.join(root, "governance.git");
  const seed = path.join(root, "seed");
  const evidence = path.join(root, "evidence.json");
  fs.mkdirSync(bare);
  git(bare, ["init", "-q", "--bare"]);

  fs.mkdirSync(seed);
  git(seed, ["init", "-q"]);
  git(seed, ["config", "user.name", "Seed"]);
  git(seed, ["config", "user.email", "seed@example.invalid"]);
  fs.writeFileSync(path.join(seed, "README.md"), "# governance\n");
  git(seed, ["add", "README.md"]);
  git(seed, ["commit", "-m", "seed"]);
  git(seed, ["branch", "-M", "main"]);
  git(seed, ["remote", "add", "origin", bare]);
  git(seed, ["push", "-u", "origin", "main"]);

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const run = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      RDG_PROVIDER: "generic-git",
      RDG_GOVERNANCE_REPOSITORY: bare,
      RDG_GOVERNANCE_BRANCH: "main",
      RDG_PRODUCT_REPOSITORY: "Kucell/cortex-agent",
      RDG_ACCEPTANCE_RUN_ID: "local-fixture",
      RDG_EVIDENCE_OUT: evidence,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  const payload = JSON.parse(fs.readFileSync(evidence, "utf8"));
  assert.equal(payload.evidence_class, "LIVE");
  assert.equal(payload.provider, "generic-git");
  assert.equal(payload.status, "passed");
  assert.equal(payload.stale_writer_rejected, true);
  assert.equal(payload.fresh_clone_verified, true);
  assert.equal(payload.cleanup_succeeded, true);

  const refs = String(git(bare, ["show-ref"], { allowFailure: true }).stdout || "");
  assert.equal(refs.includes("cortex-rdg-ms012-generic-git-local-fixture"), false);
});
