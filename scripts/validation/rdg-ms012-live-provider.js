#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function run(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.allowFailure !== true) {
    fail("ERR_LIVE_ACCEPTANCE_GIT", "git command failed", {
      args,
      status: result.status,
      stderr: String(result.stderr || "").trim(),
    });
  }
  return result;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    fail("ERR_LIVE_ACCEPTANCE_ENV", "Missing required environment variable", { name });
  }
  return String(value).trim();
}

function safeProvider(value) {
  const provider = String(value || "").toLowerCase();
  if (!["gitlab", "gitee", "generic-git"].includes(provider)) {
    fail("ERR_LIVE_ACCEPTANCE_PROVIDER", "Unsupported live acceptance provider", { provider });
  }
  return provider;
}

function sanitize(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function configureIdentity(repo) {
  run(repo, ["config", "user.name", "Cortex RDG Acceptance"]);
  run(repo, ["config", "user.email", "rdg-acceptance@cortex.local"]);
}

function main() {
  const provider = safeProvider(requiredEnv("RDG_PROVIDER"));
  const repository = requiredEnv("RDG_GOVERNANCE_REPOSITORY");
  const sourceBranch = process.env.RDG_GOVERNANCE_BRANCH || "main";
  const productRepository = process.env.RDG_PRODUCT_REPOSITORY || "Kucell/cortex-agent";
  const runId = sanitize(process.env.RDG_ACCEPTANCE_RUN_ID || (Date.now() + "-" + crypto.randomBytes(4).toString("hex")));
  const branch = "cortex-rdg-ms012-" + provider + "-" + runId;
  const out = path.resolve(process.env.RDG_EVIDENCE_OUT || "rdg-ms012-live-provider-evidence.json");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-rdg-ms012-live-"));
  const a = path.join(tempRoot, "session-a");
  const b = path.join(tempRoot, "session-b");
  const verify = path.join(tempRoot, "verify");

  const evidence = {
    schema_version: 1,
    evidence_class: "LIVE",
    provider,
    product_repository: productRepository,
    governance_repository: repository.replace(/https:\/\/[^@]+@/, "https://***@"),
    source_branch: sourceBranch,
    acceptance_branch: branch,
    started_at: new Date().toISOString(),
    base_revision: null,
    session_a_revision: null,
    session_b_revision: null,
    stale_writer_rejected: false,
    fresh_clone_verified: false,
    cleanup_succeeded: false,
    status: "running",
    error: null,
  };

  let branchCreated = false;
  let aCommit = null;

  try {
    run(tempRoot, ["clone", "--single-branch", "--branch", sourceBranch, repository, a]);
    run(tempRoot, ["clone", "--single-branch", "--branch", sourceBranch, repository, b]);
    configureIdentity(a);
    configureIdentity(b);

    const base = String(run(a, ["rev-parse", "HEAD"]).stdout).trim();
    evidence.base_revision = base;

    run(a, ["push", "origin", base + ":refs/heads/" + branch]);
    branchCreated = true;

    run(a, ["checkout", "-b", branch, base]);
    run(b, ["checkout", "-b", branch, base]);

    const aFile = path.join(a, ".cortex-acceptance", "session-a.json");
    writeJson(aFile, {
      provider,
      acceptance: "rdg-ms012",
      session: "A",
      expected_revision: base,
      run_id: runId,
    });
    run(a, ["add", ".cortex-acceptance/session-a.json"]);
    run(a, ["commit", "-m", "test(rdg): live acceptance session A"]);
    aCommit = String(run(a, ["rev-parse", "HEAD"]).stdout).trim();
    evidence.session_a_revision = aCommit;

    run(a, [
      "push",
      "--force-with-lease=refs/heads/" + branch + ":" + base,
      "origin",
      "HEAD:refs/heads/" + branch,
    ]);

    const bFile = path.join(b, ".cortex-acceptance", "session-b.json");
    writeJson(bFile, {
      provider,
      acceptance: "rdg-ms012",
      session: "B",
      expected_revision: base,
      run_id: runId,
    });
    run(b, ["add", ".cortex-acceptance/session-b.json"]);
    run(b, ["commit", "-m", "test(rdg): live acceptance session B"]);
    const bCommit = String(run(b, ["rev-parse", "HEAD"]).stdout).trim();
    evidence.session_b_revision = bCommit;

    const stale = run(b, [
      "push",
      "--force-with-lease=refs/heads/" + branch + ":" + base,
      "origin",
      "HEAD:refs/heads/" + branch,
    ], { allowFailure: true });
    if (stale.status === 0) {
      fail("ERR_LIVE_ACCEPTANCE_STALE_WRITE_ACCEPTED", "Stale session push unexpectedly succeeded");
    }
    evidence.stale_writer_rejected = true;

    run(tempRoot, ["clone", "--single-branch", "--branch", branch, repository, verify]);
    const verifiedHead = String(run(verify, ["rev-parse", "HEAD"]).stdout).trim();
    if (verifiedHead !== aCommit) {
      fail("ERR_LIVE_ACCEPTANCE_VERIFY_HEAD", "Fresh clone did not observe session A revision", {
        expected: aCommit,
        actual: verifiedHead,
      });
    }
    if (!fs.existsSync(path.join(verify, ".cortex-acceptance", "session-a.json"))) {
      fail("ERR_LIVE_ACCEPTANCE_VERIFY_EVIDENCE", "Session A evidence missing from fresh clone");
    }
    if (fs.existsSync(path.join(verify, ".cortex-acceptance", "session-b.json"))) {
      fail("ERR_LIVE_ACCEPTANCE_VERIFY_STALE", "Stale session B evidence appeared remotely");
    }
    evidence.fresh_clone_verified = true;

    evidence.status = "passed";
    return evidence;
  } catch (error) {
    evidence.status = "failed";
    evidence.error = {
      code: error.code || "ERR_LIVE_ACCEPTANCE",
      message: error.message,
      details: error.details || {},
    };
    process.exitCode = 1;
    return evidence;
  } finally {
    if (branchCreated && aCommit) {
      try {
        const cleanup = run(a, [
          "push",
          "--force-with-lease=refs/heads/" + branch + ":" + aCommit,
          "origin",
          ":refs/heads/" + branch,
        ], { allowFailure: true });
        evidence.cleanup_succeeded = cleanup.status === 0;
      } catch (_) {
        evidence.cleanup_succeeded = false;
      }
    }
    evidence.completed_at = new Date().toISOString();
    writeJson(out, evidence);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
  }
}

main();
