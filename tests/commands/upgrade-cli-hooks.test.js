"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repo = path.resolve(__dirname, "../..");
const runtime = testRuntime();
const cli = path.join(repo, "bin", "cli.js");

test("CLI installs upgrade hooks only after success, never on partial, failure or dry-run", t => {
  fs.mkdirSync(runtime, { recursive: true });
  const root = fs.mkdtempSync(path.join(runtime, "upgrade-cli-hooks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preload = path.join(root, "preload.cjs");
  fs.writeFileSync(preload, `
    const Module = require("node:module");
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      const actual = load.call(this, request, parent, isMain);
      if (parent && parent.filename === ${JSON.stringify(cli)} && request === "../lib/commands") {
        return { ...actual, upgrade: async () => { process.exitCode = Number(process.env.CORTEX_TEST_EXIT); } };
      }
      if (parent && parent.filename === ${JSON.stringify(cli)} && request === "../lib/state-sync/index.js") {
        return { ...actual, installStateGithooks: () => { process.stdout.write("HOOK_CALLED\\n"); } };
      }
      return actual;
    };
  `);
  for (const command of ["upgrade", "update"]) {
    for (const status of [0, 1, 2, 3]) {
      for (const dryRun of [false, true]) {
        const args = ["--require", preload, cli, command, ...(dryRun ? ["--dry-run"] : [])];
        const result = spawnSync(process.execPath, args, {
          cwd: root, encoding: "utf8", timeout: 15000,
          env: { ...process.env, CORTEX_TEST_EXIT: String(status), NODE_OPTIONS: "" },
        });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, status, result.stderr);
        assert.equal(result.stdout.includes("HOOK_CALLED"), status === 0 && !dryRun,
          `${command} exit=${status} dryRun=${dryRun}`);
      }
    }
  }
});
