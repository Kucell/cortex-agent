"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const PACKAGE = path.resolve(__dirname, "../..");
const BIN = path.join(PACKAGE, "bin/cli.js");
const SOURCE_CLOSURE = [
  "bin/cli.js",
  "lib/next-action/cli.js",
  "lib/next-action/bound-query.js",
  "lib/next-action/canonical-task-source.js",
  "lib/next-action/advisory-plan.js",
  "lib/next-action/advisory-plan.schema.json",
  "lib/next-action/canonical-plan-source.js",
  "lib/next-action/canonical-pair.js",
  "templates/_shared/.agent/decisions/decision.schema.json",
  "templates/_shared/.agent/waitpoints/waitpoint.schema.json",
  "lib/next-action/index.js",
  "lib/commands/management/query.js",
  "lib/commands/management/api-helpers.js",
  "lib/management/client.js",
  "lib/sdk/local-client.js",
  "lib/sdk/local-transport.js",
  "lib/governance/root.js",
  "packages/sdk/src/index.js",
  "packages/project-sdk/src/descriptor.js",
  "packages/project-sdk/src/governance.js",
  "packages/protocol/src/index.js",
  "packages/protocol/src/refs.js",
  "packages/protocol/src/version.js",
  "packages/protocol/src/result.js",
  "packages/protocol/src/capabilities.js",
  "packages/protocol/src/events.js",
  "packages/protocol/src/timeline.js",
  "packages/protocol/src/negotiation.js",
  "packages/protocol/src/evolution.js"
];
const GIT_PREFIX = ["--no-lazy-fetch", "--no-replace-objects", "-c", "protocol.allow=never", "-c", "core.fsmonitor=false", "-C"];
function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function snapshot(root) {
  const rows = {};
  function visit(file) {
    const st = fs.lstatSync(file, { bigint: true });
    const key = path.relative(root, file) || ".";
    rows[key] = { mode: String(st.mode), size: String(st.size), mtime: String(st.mtimeNs),
      type: st.isDirectory() ? "directory" : st.isFile() ? "file" : st.isSymbolicLink() ? "link" : "other" };
    if (st.isFile()) rows[key].digest = sha(fs.readFileSync(file));
    if (st.isSymbolicLink()) rows[key].target = fs.readlinkSync(file);
    if (st.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
  }
  visit(root);
  return rows;
}
function cleanEnv(home) {
  // Explicit whitelist: no inherited NODE_OPTIONS, NODE_PATH, Host CLI, GIT_*,
  // credentials or agent configuration enters the real bin/SDK subprocess.
  return { PATH: "/usr/bin:/bin", HOME: home, LANG: "C", LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}
function git(f, repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], { env: f.env, encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function descriptor(id, locator) {
  return { schema_version: "1", project_id: id, repository: { slug: "fixture/" + id, default_branch: "main" },
    integration_mode: "embedded", boundaries: { authoritative_domain: "fixture", authoritative_runtime: "fixture",
      cortex_role: "governance-observer", protected_components: [] },
    governance: { kind: "git", locator, ref: "refs/heads/main" } };
}
function makeProject(f, name, task = "T-A") {
  const project = path.join(f.root, name), repo = path.join(f.root, name + "-governance");
  fs.mkdirSync(path.join(project, ".agent"), { recursive: true });
  fs.mkdirSync(repo);
  git(f, repo, "init", "-b", "main");
  git(f, repo, "config", "user.name", "Fixture");
  git(f, repo, "config", "user.email", "fixture@example.test");
  write(path.join(repo, "tasks/index.json"), JSON.stringify({ tasks: [{ task_id: task, path: ".agent/tasks/" + task + ".json" }] }));
  write(path.join(repo, "tasks/" + task + ".json"), JSON.stringify({ task_id: task, status: "active", priority: "P1",
    owner: "fixture-owner", dependencies: [], validation_commands: ["node --test fixture-only.test.js"],
    // Similar names are deliberately not canonical scope or authority.
    mission_ref: "M-FAKE", scope: { branch: "main", repository: "fixture/" + name, allowed_paths: ["**"], allowed_operations: ["execute"] },
    plan_digest: "fake", execution_authorized: true }));
  git(f, repo, "add", "tasks"); git(f, repo, "commit", "-m", "fixture");
  const head = git(f, repo, "rev-parse", "HEAD");
  write(path.join(project, "cortex.project.json"), JSON.stringify(descriptor(name, repo)));
  f.projects.push(project); f.repos.push(repo);
  return { project, repo, task, head };
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cortex-advisor-query-")));
  const f = { root, home: path.join(root, "home"), projects: [], repos: [] };
  fs.mkdirSync(f.home); f.env = cleanEnv(f.home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  f.a = makeProject(f, "alpha");
  f.runner = path.join(root, "sdk-runner.cjs");
  write(f.runner, [
    '"use strict";',
    'const { createLocalCortexClient } = require(' + JSON.stringify(path.join(PACKAGE, "lib/sdk/local-client.js")) + ');',
    'const project = process.argv[2];',
    'const filters = JSON.parse(process.argv[3]);',
    'const client = createLocalCortexClient({ cwd: project, args: ["sdk"], options: { project }, lang: "en" });',
    'try { const report = client.management.query("next-action", filters); process.stdout.write(JSON.stringify({ report, project: client.project.resolve() }) + "\\n"); }',
    'catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: { code: error.code } }) + "\\n"); process.exitCode = error.exitCode || 3; }',
  ].join("\n"));
  return f;
}
function preload(config) {
  const fs = require("node:fs"), cp = require("node:child_process"), Module = require("node:module");
  const path = require("node:path");
  const originalSpawn = cp.spawnSync;
  const originalOpen = fs.openSync, originalWriteSync = fs.writeSync, originalClose = fs.closeSync;
  // This closure is the fixed fixture actor; product calls keep the write guard.
  const bindingFault = config.fault && config.fault.kind === "binding" ? {
    file: config.fault.file, bytes: Buffer.from(config.fault.content, "utf8"),
  } : null;
  if (bindingFault && bindingFault.file !== path.join(config.projects[0], "cortex.project.json")) {
    throw new Error("Unexpected fixture binding target");
  }
  const originalLoad = Module._load, originalResolve = Module._resolveFilename;
  const metrics = { modules: [], git_calls: [], writes: 0, networks: 0, denied: [], fixture_faults: 0 };
  const fail = (kind) => { metrics.denied.push(kind); process.stderr.write("BOUND_DENIED:" + kind + "\n"); process.exit(87); };
  const builtins = new Set(Module.builtinModules.map((name) => name.replace(/^node:/, "")));
  for (const name of ["node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dns", "node:dgram"]) {
    const mod = require(name);
    for (const key of Object.keys(mod)) {
      if (/^(?:request|get|connect|createConnection|createServer|createSocket|lookup|resolve|reverse)/.test(key) && typeof mod[key] === "function") {
        mod[key] = () => { metrics.networks++; fail("network:" + name + ":" + key); };
      }
    }
    if (mod.promises) for (const key of Object.keys(mod.promises)) if (typeof mod.promises[key] === "function") {
      mod.promises[key] = () => { metrics.networks++; fail("network-promise"); };
    }
  }
  require("node:net").Socket.prototype.connect = () => { metrics.networks++; fail("socket-connect"); };
  globalThis.fetch = () => { metrics.networks++; fail("fetch"); };
  globalThis.WebSocket = class { constructor() { metrics.networks++; fail("websocket"); } };
  for (const key of ["writeFile", "appendFile", "unlink", "rm", "rmdir", "mkdir", "rename", "copyFile", "cp", "link", "symlink",
    "truncate", "chmod", "chown", "utimes", "write", "writev", "ftruncate", "fchmod", "fchown", "futimes", "mkdtemp"]) {
    for (const suffix of ["", "Sync"]) if (typeof fs[key + suffix] === "function") {
      fs[key + suffix] = () => { metrics.writes++; fail("fs-write:" + key + suffix); };
    }
    if (typeof fs.promises[key] === "function") fs.promises[key] = () => { metrics.writes++; fail("fs-promise-write:" + key); };
  }
  fs.openSync = function(file, flags, ...rest) {
    if (file === config.forbiddenRead) fail("private-canary-read");
    const numeric = typeof flags === "number";
    if (numeric ? !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : !/^r[s]?$/.test(flags)) {
      metrics.writes++; fail("fs-open-write");
    }
    return originalOpen.call(this, file, flags, ...rest);
  };
  for (const name of ["exec", "execSync", "execFile", "execFileSync", "spawn", "fork"]) cp[name] = () => fail("child:" + name);
  cp.spawnSync = function(command, args, options) {
    const prefix = config.gitPrefix;
    if (command !== "git" || !Array.isArray(args) || !options || options.shell
        || prefix.some((value, index) => args[index] !== value)) fail("child-argv");
    const repo = args[prefix.length], tail = args.slice(prefix.length + 1);
    if (![...config.projects, ...config.repos].includes(repo)) fail("child-repository");
    const allowed = JSON.stringify(tail) === JSON.stringify(["rev-parse", "--is-bare-repository"])
      || JSON.stringify(tail) === JSON.stringify(["rev-parse", "--absolute-git-dir"])
      || JSON.stringify(tail) === JSON.stringify(["rev-parse", "--show-toplevel"])
      || tail.length === 4 && tail[0] === "rev-parse" && tail[1] === "--verify" && tail[2] === "--quiet" && /^refs\/[A-Za-z0-9._/-]+\^\{commit\}$/.test(tail[3])
      || tail.length === 5 && tail[0] === "ls-tree" && tail[1] === "-z" && /^[0-9a-f]{40}$/.test(tail[2]) && tail[3] === "--"
        && (/^tasks\/(?:index|T-[A-Za-z0-9][A-Za-z0-9._-]*)\.json$/.test(tail[4])
          || /^missions\/M-[A-Za-z0-9][A-Za-z0-9._-]*\/(?:validation-contract\.json|advisory-plans\/AP-[A-Za-z0-9][A-Za-z0-9._-]*\.json)$/.test(tail[4])
          || /^decisions\/D-[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(tail[4]) || /^waitpoints\/WP-[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(tail[4]))
      || tail.length === 6 && tail[0] === "ls-tree" && tail[1] === "-r" && tail[2] === "-z"
        && /^[0-9a-f]{40}$/.test(tail[3]) && tail[4] === "--" && ["missions", "decisions", "waitpoints"].includes(tail[5])
      || tail.length === 3 && tail[0] === "cat-file" && ["-s", "-p"].includes(tail[1]) && /^[0-9a-f]{40}$/.test(tail[2]);
    if (!allowed) fail("child-operation");
    const expectedEnv = {
      PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1",
      GIT_ALLOW_PROTOCOL: "", GIT_PROTOCOL_FROM_USER: "0",
    };
    if (process.platform === "darwin") expectedEnv.TMPDIR = "/tmp";
    if (JSON.stringify(Object.keys(options.env).sort()) !== JSON.stringify(Object.keys(expectedEnv).sort())
        || Object.keys(expectedEnv).some((key) => options.env[key] !== expectedEnv[key])
        || options.timeout !== 5000 || options.maxBuffer !== 1024 * 1024 + 1 || options.encoding !== null) fail("child-environment");
    metrics.git_calls.push({ repo, argv: tail });
    if (config.unsupportedGit) return { status: 129, stdout: Buffer.alloc(0), stderr: Buffer.from("unknown option: --no-lazy-fetch\n") };
    const result = originalSpawn.call(this, command, args, options);
    if (config.fault && metrics.fixture_faults === 0 && tail[0] === "cat-file" && tail[1] === "-p"
        && (!config.fault.planOnly || String(result.stdout).includes('"plan_id"'))) {
      metrics.fixture_faults++;
      if (config.fault.kind === "ref") {
        const changed = originalSpawn("git", ["-C", config.fault.repo, "update-ref", "refs/heads/main", config.fault.next], {
          env: config.fixtureEnv, encoding: "utf8", timeout: 5000 });
        if (changed.error || changed.status !== 0) fail("fixture-ref-change");
      } else if (config.fault.kind === "binding") {
        const fd = originalOpen(bindingFault.file, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
        try {
          let offset = 0;
          while (offset < bindingFault.bytes.length) {
            const written = originalWriteSync(fd, bindingFault.bytes, offset, bindingFault.bytes.length - offset, null);
            if (!Number.isInteger(written) || written <= 0) throw new Error("Incomplete fixture binding write");
            offset += written;
          }
        } finally { originalClose(fd); }
      }
    }
    return result;
  };
  Module._load = function(request, parent, isMain) {
    if (builtins.has(request.replace(/^node:/, ""))) return originalLoad.call(this, request, parent, isMain);
    if (request === "../lib/commands" && parent && parent.filename === path.join(config.packageRoot, "bin/cli.js")) fail("module:legacy-dispatch-boundary");
    let resolved;
    try { resolved = originalResolve.call(this, request, parent, isMain); } catch (error) { throw error; }
    metrics.modules.push(path.resolve(resolved));
    if (!config.allowedModules.includes(path.resolve(resolved))) fail("module:" + path.relative(config.packageRoot, resolved));
    return originalLoad.call(this, request, parent, isMain);
  };
  process.on("exit", () => process.stderr.write("BOUND_AUDIT:" + JSON.stringify(metrics) + "\n"));
}
function run(f, args, options = {}) {
  const guard = path.join(f.root, "guard.cjs");
  const config = { packageRoot: PACKAGE, allowedModules: SOURCE_CLOSURE.map((file) => path.join(PACKAGE, file)).concat(f.runner),
    projects: f.projects, repos: f.repos, gitPrefix: GIT_PREFIX, fixtureEnv: f.env,
    forbiddenRead: options.forbiddenRead, fault: options.fault, unsupportedGit: options.unsupportedGit };
  write(guard, "(" + preload.toString() + ")(" + JSON.stringify(config) + ");\n");
  const before = snapshot(f.root);
  const target = options.sdk ? f.runner : BIN;
  const child = spawnSync(process.execPath, ["--require", guard, target, ...args], {
    cwd: options.cwd || f.a.project, env: { ...f.env, ...(options.env || {}) },
    encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(child.error);
  const auditLine = String(child.stderr).split("\n").find((line) => line.startsWith("BOUND_AUDIT:"));
  assert.ok(auditLine, child.stderr);
  const audit = JSON.parse(auditLine.slice("BOUND_AUDIT:".length));
  assert.equal(audit.writes, 0, child.stderr); assert.equal(audit.networks, 0, child.stderr);
  if (!options.expectModuleDenial) assert.deepEqual(audit.denied, [], child.stderr);
  const after = snapshot(f.root);
  if (options.fault) {
    assert.equal(audit.fixture_faults, 1);
    const allowed = options.fault.kind === "binding"
      ? [path.relative(f.root, options.fault.file)]
      : ["alpha-governance/.git", "alpha-governance/.git/refs/heads", "alpha-governance/.git/refs/heads/main",
        "alpha-governance/.git/logs/refs/heads/main", "alpha-governance/.git/logs/HEAD"];
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "fault must preserve the full entry set");
    for (const key of allowed) {
      assert.equal(after[key].type, before[key].type, key + " type");
      assert.equal(after[key].mode, before[key].mode, key + " mode");
      if (before[key].type === "directory") {
        const { mtime: beforeMtime, ...beforeRest } = before[key];
        const { mtime: afterMtime, ...afterRest } = after[key];
        assert.deepEqual(afterRest, beforeRest, key + " permits only directory mtime change");
      }
    }
    if (options.fault.kind === "binding") {
      assert.deepEqual(fs.readFileSync(options.fault.file), Buffer.from(options.fault.content, "utf8"), "exact fixture fault bytes");
    }
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    assert.ok(changed.length > 0);
    assert.ok(changed.every((key) => allowed.includes(key)), JSON.stringify(changed));
  } else assert.deepEqual(after, before, "query must preserve every fixture file and directory, including mtime");
  let output = null;
  if (child.stdout.trim()) output = JSON.parse(child.stdout);
  return { ...child, output, audit };
}
function cli(f, extra = [], options = {}) { return run(f, ["query", "next-action", "--project", f.a.project, ...extra], options); }
function assertGap(result, task = "T-A") {
  assert.equal(result.status, 0, result.stderr);
  const data = result.output.data;
  assert.equal(result.output.command, "query"); assert.equal(result.output.projection, "next-action");
  assert.equal(data.diagnostic_kind, "bound-task-gap-report"); assert.equal(data.execution_authorized, false);
  assert.equal(data.source_status.tasks, "observed");
  assert.equal(data.source_status.project, "not_observed");
  assert.equal(data.recommendations[0].task_ref, task);
  assert.equal(data.recommendations[0].advice_status, "INSUFFICIENT_EVIDENCE");
  assert.equal(data.recommendations[0].mission_ref, null);
  assert.equal(data.recommendations[0].execution_authorized, false);
  assert.ok(data.recommendations[0].blocking_reasons.includes("scope_unknown"));
  assert.equal(data.recommendations[0].approval_request_draft.plan_digest, null);
  return data;
}

test("actual bin query traverses SDK/transport/reader/advisor without eager Host imports or writes", (t) => {
  const f = fixture(t), result = cli(f), data = assertGap(result);
  assert.equal(data.governance_revision.value, f.a.head);
  assert.equal(data.binding_observation.authority_attested, false);
  assert.equal(data.task_source.read_receipts.length, 2);
  for (const file of ["bin/cli.js", "lib/commands/management/query.js", "lib/sdk/local-client.js", "lib/sdk/local-transport.js",
    "lib/next-action/bound-query.js", "lib/next-action/canonical-task-source.js", "lib/next-action/index.js"]) {
    assert.ok(result.audit.modules.includes(path.join(PACKAGE, file)), file);
  }
});
test("actual SDK query uses the same bound source without a management script", (t) => {
  const f = fixture(t), result = run(f, [f.a.project, JSON.stringify({ task: "T-A" })], { sdk: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.report.source_status.tasks, "observed");
  assert.equal(result.output.report.execution_authorized, false);
  assert.equal(result.output.project.project_ref, "project:alpha");
  assert.equal(result.output.report.governance_revision.value, f.a.head);
});
test("CLI explicit project overrides another project cwd without cross-project evidence", (t) => {
  const f = fixture(t), b = makeProject(f, "beta", "T-B");
  const result = run(f, ["query", "next-action", "--project=" + b.project], { cwd: f.a.project });
  const data = assertGap(result, "T-B");
  assert.equal(data.project_ref, "project:beta");
  assert.equal(data.governance_revision.value, b.head);
  assert.ok(!JSON.stringify(result.output).includes('"T-A"'));
});
test("CLI relative project path resolves canonically", (t) => {
  const f = fixture(t);
  const result = run(f, ["query", "next-action", "--project", "../alpha", "--task=T-A"]);
  assertGap(result); assert.equal(result.output.project.root, fs.realpathSync(f.a.project));
});
test("CLI no explicit project uses bounded local discovery and non-Git cwd", (t) => {
  const f = fixture(t);
  assertGap(run(f, ["query", "next-action"]));
});
test("Git discovery never inherits caller TMPDIR", (t) => {
  const f = fixture(t);
  // The exact child-environment guard requires /tmp on Darwin and absence
  // elsewhere; the nonexistent caller path must never reach a Git child.
  assertGap(run(f, ["query", "next-action"], {
    env: { TMPDIR: path.join(f.root, "untrusted-nonexistent-temp") },
  }));
});
test("SDK caller cannot inject proof, sources, Host, scope or project identity", (t) => {
  const f = fixture(t);
  for (const key of ["proof", "sources", "host", "scope", "project_ref", "governance_revision"]) {
    const result = run(f, [f.a.project, JSON.stringify({ [key]: { execution_authorized: true } })], { sdk: true });
    assert.equal(result.status, 2); assert.equal(result.output.error.code, "INVALID_QUERY_OPTION");
    assert.equal(result.audit.git_calls.length, 0);
  }
});
test("CLI rejects unsupported authority flags before project I/O", (t) => {
  const f = fixture(t);
  for (const flag of ["--proof", "--scope", "--host", "--decision", "--json", "--lang", "--help"]) {
    const result = cli(f, [flag, "claimed"]);
    assert.equal(result.status, 2); assert.equal(result.output.error.code, "INVALID_QUERY_OPTION");
    assert.equal(result.audit.git_calls.length, 0);
    assert.ok(!result.audit.modules.includes(path.join(PACKAGE, "lib/next-action/bound-query.js")));
  }
});
test("CLI rejects short help, extra words and extra actions without fallback", (t) => {
  const f = fixture(t);
  for (const extra of [["-h"], ["-?"], ["extra"], ["execute"], ["T-A"]]) {
    const result = cli(f, extra);
    assert.equal(result.status, 2); assert.equal(result.output, null);
    assert.equal(result.audit.git_calls.length, 0);
  }
});
test("CLI missing/empty/duplicate project options retain failure status 2", (t) => {
  const f = fixture(t);
  for (const args of [
    ["query", "next-action", "--project"], ["query", "next-action", "--project="],
    ["query", "next-action", "--project", "--task", "T-A"],
    ["query", "next-action", "--project", f.a.project, "--project", f.a.project],
  ]) {
    const result = run(f, args);
    assert.equal(result.status, 2); assert.equal(result.output.error.code, "INVALID_PROJECT_OPTION");
    assert.equal(result.audit.git_calls.length, 0);
  }
});
test("CLI invalid/missing/duplicate task IDs fail before project reads", (t) => {
  const f = fixture(t);
  for (const args of [["--task"], ["--task="], ["--task", "../T-A"], ["--task", "T-.."],
    ["--task", "T-A", "--task", "T-A"]]) {
    const result = cli(f, args);
    assert.equal(result.status, 2); assert.equal(result.output.error.code, "INVALID_QUERY_OPTION");
    assert.equal(result.audit.git_calls.length, 0);
  }
});
test("exact route leaves near-miss command spellings to the unchanged legacy dispatcher boundary", (t) => {
  const f = fixture(t);
  for (const args of [["query", "next-actions"], ["query-next-action"], ["query", "NEXT-ACTION"], ["query", "next-action-extra"]]) {
    const result = run(f, args, { expectModuleDenial: true });
    assert.equal(result.status, 87);
    assert.ok(result.audit.denied.some((reason) => reason.startsWith("module:")));
    assert.ok(!result.audit.modules.includes(path.join(PACKAGE, "lib/next-action/cli.js")));
    assert.equal(result.audit.git_calls.length, 0);
  }
});
test("missing project descriptor is explicit failure and never guessed from basename", (t) => {
  const f = fixture(t); fs.unlinkSync(path.join(f.a.project, "cortex.project.json"));
  const result = cli(f); assert.equal(result.status, 3);
  assert.equal(result.output.error.code, "ADVISOR_DESCRIPTOR_UNAVAILABLE");
});
test("missing governance binding is an explicit unavailable gap", (t) => {
  const f = fixture(t), value = descriptor("alpha", f.a.repo); delete value.governance;
  write(path.join(f.a.project, "cortex.project.json"), JSON.stringify(value));
  const result = cli(f); assert.equal(result.status, 0);
  assert.equal(result.output.data.source_status.tasks, "unavailable");
  assert.deepEqual(result.output.data.task_source.reason_codes, ["governance_binding_not_observed"]);
  assert.equal(result.output.data.execution_authorized, false);
});
test("filesystem binding cannot become a repository-wide revision", (t) => {
  const f = fixture(t), value = descriptor("alpha", f.a.repo);
  value.governance = { kind: "filesystem", locator: ".agent" };
  write(path.join(f.a.project, "cortex.project.json"), JSON.stringify(value));
  const result = cli(f); assert.equal(result.status, 0);
  assert.equal(result.output.data.governance_revision, null);
  assert.deepEqual(result.output.data.task_source.reason_codes, ["filesystem_repository_snapshot_unsupported"]);
  assert.equal(result.audit.git_calls.length, 0);
});
test("unsupported protocol locator is not contacted", (t) => {
  const f = fixture(t), value = descriptor("alpha", "blocked-fixture:local-only");
  write(path.join(f.a.project, "cortex.project.json"), JSON.stringify(value));
  const result = cli(f); assert.equal(result.status, 0);
  assert.deepEqual(result.output.data.task_source.reason_codes, ["local_git_repository_unavailable"]);
  assert.equal(result.audit.git_calls.length, 0);
});
test("unsafe ref expression is rejected without Git invocation", (t) => {
  const f = fixture(t), value = descriptor("alpha", f.a.repo); value.governance.ref = "main^{tree}";
  write(path.join(f.a.project, "cortex.project.json"), JSON.stringify(value));
  const result = cli(f); assert.equal(result.status, 0);
  assert.deepEqual(result.output.data.task_source.reason_codes, ["git_ref_unsupported"]);
  assert.equal(result.audit.git_calls.length, 0);
});
test("descriptor symlink and hardlink are rejected before reading canary bytes", (t) => {
  const f = fixture(t), file = path.join(f.a.project, "cortex.project.json"), secret = path.join(f.root, "private-canary");
  fs.renameSync(file, secret); fs.symlinkSync(secret, file);
  let result = cli(f, [], { forbiddenRead: secret });
  assert.equal(result.status, 3); assert.equal(result.output.error.code, "ADVISOR_DESCRIPTOR_UNAVAILABLE");
  fs.unlinkSync(file); fs.linkSync(secret, file);
  result = cli(f, [], { forbiddenRead: secret });
  assert.equal(result.status, 3); assert.equal(result.output.error.code, "ADVISOR_DESCRIPTOR_UNAVAILABLE");
});
test("descriptor FIFO is rejected without blocking", (t) => {
  const f = fixture(t), file = path.join(f.a.project, "cortex.project.json"); fs.unlinkSync(file);
  const made = spawnSync("/usr/bin/mkfifo", [file], { env: f.env, timeout: 5000 });
  assert.ifError(made.error); assert.equal(made.status, 0);
  const result = cli(f); assert.equal(result.status, 3);
  assert.equal(result.output.error.code, "ADVISOR_DESCRIPTOR_UNAVAILABLE");
});
test("descriptor invalid UTF-8 and oversize bytes are rejected", (t) => {
  const f = fixture(t), file = path.join(f.a.project, "cortex.project.json");
  write(file, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d]));
  let result = cli(f); assert.equal(result.status, 3); assert.equal(result.output.error.code, "ADVISOR_DESCRIPTOR_INVALID");
  write(file, Buffer.alloc(1024 * 1024 + 1, 0x20));
  result = cli(f); assert.equal(result.status, 3); assert.equal(result.output.error.code, "ADVISOR_DESCRIPTOR_UNAVAILABLE");
});
test("Task Git symlink mode cannot be parsed as a regular canonical Task blob", (t) => {
  const f = fixture(t), file = path.join(f.a.repo, "tasks/T-A.json");
  fs.unlinkSync(file); fs.symlinkSync("private-canary", file);
  git(f, f.a.repo, "add", "tasks/T-A.json"); git(f, f.a.repo, "commit", "-m", "fixture symlink");
  const result = cli(f); assert.equal(result.status, 0);
  assert.equal(result.output.data.source_status.tasks, "unavailable");
  assert.deepEqual(result.output.data.recommendations, []);
});
test("Task raw oversize/invalid UTF-8 blobs fail closed", (t) => {
  const f = fixture(t), file = path.join(f.a.repo, "tasks/T-A.json");
  for (const bytes of [Buffer.alloc(1024 * 1024 + 1, 0x20), Buffer.from([0xff, 0xff, 0xff])]) {
    write(file, bytes); git(f, f.a.repo, "add", "tasks/T-A.json"); git(f, f.a.repo, "commit", "-m", "fixture malformed");
    const result = cli(f); assert.equal(result.status, 0);
    assert.equal(result.output.data.source_status.tasks, "unavailable");
    assert.deepEqual(result.output.data.recommendations, []);
  }
});
test("replace refs cannot substitute another Task tree for the observed commit", (t) => {
  const f = fixture(t);
  write(path.join(f.a.repo, "tasks/index.json"), JSON.stringify({ tasks: [{ task_id: "T-REPLACED", path: ".agent/tasks/T-REPLACED.json" }] }));
  write(path.join(f.a.repo, "tasks/T-REPLACED.json"), JSON.stringify({ task_id: "T-REPLACED", status: "active", dependencies: [] }));
  git(f, f.a.repo, "add", "tasks"); git(f, f.a.repo, "commit", "-m", "fixture alternate tree");
  const next = git(f, f.a.repo, "rev-parse", "HEAD");
  git(f, f.a.repo, "update-ref", "refs/heads/main", f.a.head);
  git(f, f.a.repo, "replace", f.a.head, next);
  assertGap(cli(f));
});
test("missing promisor object cannot lazy-fetch even from a local fixture remote", (t) => {
  const f = fixture(t), peer = path.join(f.root, "promisor-peer");
  git(f, f.root, "-c", "protocol.file.allow=always", "clone", "--no-hardlinks", f.a.repo, peer);
  const blob = git(f, f.a.repo, "rev-parse", "HEAD:tasks/T-A.json");
  git(f, f.a.repo, "config", "core.repositoryformatversion", "1");
  git(f, f.a.repo, "config", "extensions.partialClone", "fixture");
  git(f, f.a.repo, "config", "remote.fixture.url", peer);
  git(f, f.a.repo, "config", "remote.fixture.promisor", "true");
  fs.unlinkSync(path.join(f.a.repo, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  const result = cli(f); assert.equal(result.status, 0);
  assert.equal(result.output.data.source_status.tasks, "unavailable");
  assert.deepEqual(result.output.data.recommendations, []);
  assert.ok(!fs.existsSync(path.join(f.a.repo, ".git/objects", blob.slice(0, 2), blob.slice(2))));
});
test("inherited Git redirection/config/askpass are excluded from each product Git child", (t) => {
  const f = fixture(t), b = makeProject(f, "beta", "T-B");
  const result = cli(f, [], { env: {
    GIT_DIR: path.join(b.repo, ".git"), GIT_WORK_TREE: b.repo, GIT_OBJECT_DIRECTORY: path.join(b.repo, ".git/objects"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true",
    GIT_CONFIG_GLOBAL: path.join(f.root, "unused-config"), GIT_SSH_COMMAND: "forbidden-fixture-command",
    GIT_ASKPASS: "forbidden-fixture-command", HOST_CLI: "forbidden-fixture-command",
  } });
  assertGap(result);
});
test("unsupported Git safety flags produce unavailable, never ordinary-read fallback", (t) => {
  const f = fixture(t), result = cli(f, [], { unsupportedGit: true });
  assert.equal(result.status, 0);
  assert.equal(result.output.data.source_status.tasks, "unavailable");
  assert.deepEqual(result.output.data.recommendations, []);
  assert.ok(result.audit.git_calls.length > 0);
});
test("failed project discovery cannot silently select another cwd project", (t) => {
  const f = fixture(t), result = run(f, ["query", "next-action"], { unsupportedGit: true });
  assert.equal(result.status, 3);
  assert.equal(result.output.error.code, "ADVISOR_PROJECT_DISCOVERY_FAILED");
});
test("actual fixture ref mutation during a read discards the entire Task set", (t) => {
  const f = fixture(t);
  write(path.join(f.a.repo, "tasks/T-A.json"), JSON.stringify({ task_id: "T-A", status: "blocked", dependencies: [] }));
  git(f, f.a.repo, "add", "tasks/T-A.json"); git(f, f.a.repo, "commit", "-m", "fixture later revision");
  const next = git(f, f.a.repo, "rev-parse", "HEAD");
  git(f, f.a.repo, "update-ref", "refs/heads/main", f.a.head);
  const result = cli(f, [], { fault: { kind: "ref", repo: f.a.repo, next } });
  assert.equal(result.status, 0);
  assert.equal(result.output.data.source_status.tasks, "conflict");
  assert.deepEqual(result.output.data.recommendations, []);
});
test("actual fixture descriptor rebinding during a read discards the entire Task set", (t) => {
  const f = fixture(t), b = makeProject(f, "beta", "T-B");
  const result = cli(f, [], { fault: { kind: "binding", file: path.join(f.a.project, "cortex.project.json"),
    content: JSON.stringify(descriptor("beta", b.repo)) } });
  assert.equal(result.status, 0);
  assert.equal(result.output.data.source_status.tasks, "conflict");
  assert.deepEqual(result.output.data.recommendations, []);
  assert.ok(!JSON.stringify(result.output).includes('"T-B"'));
});

test("locator ordinary child directory cannot inherit its ancestor Git repository", (t) => {
  const f = fixture(t), child = path.join(f.a.repo, "ordinary-child");
  fs.mkdirSync(child); f.repos.push(child);
  write(path.join(f.a.project, "cortex.project.json"), JSON.stringify(descriptor("alpha", child)));
  const result = cli(f); assert.equal(result.status, 0);
  assert.equal(result.output.data.source_status.tasks, "unavailable");
  assert.deepEqual(result.output.data.task_source.reason_codes, ["governance_locator_not_repository_root"]);
  assert.deepEqual(result.output.data.recommendations, []);
  assert.ok(!result.audit.git_calls.some((call) => call.argv[0] === "cat-file"));
});
test("explicit bare governance repository is bound by its actual git-dir identity", (t) => {
  const f = fixture(t), bare = path.join(f.root, "alpha-bare");
  git(f, f.root, "-c", "protocol.file.allow=always", "clone", "--bare", "--no-hardlinks", f.a.repo, bare);
  f.repos.push(bare);
  write(path.join(f.a.project, "cortex.project.json"), JSON.stringify(descriptor("alpha", bare)));
  const data = assertGap(cli(f));
  assert.equal(data.governance_revision.value, f.a.head);
});

function committedPlan(f) {
  const { prepareAdvisoryPlan, sha256 } = require("../../lib/next-action/advisory-plan.js");
  const now = Date.now(), at = (offset) => new Date(now + offset).toISOString();
  const created = at(-3600000), expires = at(3600000);
  const contract = { schema_version: 2, mission_id: "M-A", proposal_hash: "0123456789abcdef",
    generated_at: created, states: { current: "done", transitions: [] }, milestones: [], gates: [] };
  const contractText = JSON.stringify(contract, null, 2) + "\n";
  const plan = { schema_version: 1, plan_id: "AP-A", project_id: "alpha", task_id: "T-A", mission_id: "M-A",
    task_source: { path: "tasks/T-A.json", git_blob: git(f, f.a.repo, "rev-parse", "HEAD:tasks/T-A.json") },
    mission_contract: { path: "missions/M-A/validation-contract.json", sha256: sha256(contractText) },
    scope: { repository: "fixture/alpha", branch: "main", product_commit: "b".repeat(40),
      allowed_paths: ["lib/**"], allowed_operations: ["prepare_patch"] },
    risk_tier: "medium", validation_commands: ["node --test fixture-only.test.js"],
    estimated_budget: { tokens: 1000, cost_amount: 0.25, currency: "USD" },
    required_host_capabilities: ["runtime.reason"], stop_conditions: ["Stop on scope drift"],
    created_at: created, expires_at: expires,
    approval: { action: "external_side_effect", owner_workflow: "/mission", decision_id: "D-A", waitpoint_id: "WP-A" } };
  const draft = prepareAdvisoryPlan(JSON.stringify(plan));
  const relations = { task_ids: ["T-A"], mission_ids: ["M-A"], run_ids: [], queue_ids: [], session_ids: [],
    artifact_refs: [draft.resource_ref], worktree_paths: [] };
  const d = { schema_version: 1, decision_id: "D-A", type: "approval", status: "approved",
    requested_by: "fixture-requester", prompt: "Review fixture plan", options: ["approve", "reject"], selected_option: "approve",
    resolved_by: "fixture-reviewer", resolved_at: at(-3000000), rationale: "Fixture only",
    gate: { action: "external_side_effect", resource_ref: draft.resource_ref }, relations,
    created_at: created, updated_at: at(-3000000) };
  const w = { schema_version: 1, waitpoint_id: "WP-A", status: "released", owner_workflow: "/mission",
    reason: "Fixture pair", gate: { ...d.gate }, decision_id: "D-A", evidence_refs: [draft.resource_ref],
    relations: JSON.parse(JSON.stringify(relations)), created_at: created, updated_at: at(-2400000),
    released_at: at(-2400000), released_by: "fixture-owner", expires_at: expires };
  write(path.join(f.a.repo, plan.mission_contract.path), contractText);
  write(path.join(f.a.repo, draft.path), draft.content);
  write(path.join(f.a.repo, "decisions/D-A.json"), JSON.stringify(d));
  write(path.join(f.a.repo, "waitpoints/WP-A.json"), JSON.stringify(w));
  commitPlanFixture(f);
  return { plan, draft, contract, d, w, now, at };
}
function commitPlanFixture(f) {
  git(f, f.a.repo, "add", "missions", "decisions", "waitpoints");
  git(f, f.a.repo, "commit", "-m", "fixture canonical plan and pair");
  f.a.head = git(f, f.a.repo, "rev-parse", "HEAD");
}
function planData(result) {
  assert.equal(result.status, 0, result.stderr);
  const data = result.output.data, row = data.recommendations[0];
  assert.equal(data.execution_authorized, false); assert.equal(row.execution_authorized, false);
  assert.equal(data.source_status.project, "not_observed");
  assert.equal(data.source_status.host, "not_observed"); assert.equal(data.source_status.ownership, "not_observed");
  return { data, row };
}
test("actual CLI maps committed Mission identity/scope and real pair through the same read-only path", (t) => {
  const f = fixture(t), p = committedPlan(f), result = cli(f), { data, row } = planData(result);
  assert.equal(data.plan_source.status, "observed"); assert.equal(data.plan_source.read_receipts.length, 4);
  for (const name of ["tasks", "missions", "decisions", "waitpoints"]) assert.equal(data.source_status[name], "observed");
  assert.equal(row.mission_ref, "M-A"); assert.equal(row.approval_request_draft.plan_digest, p.draft.sha256);
  assert.equal(row.approval_request_draft.resource_ref, p.draft.resource_ref);
  assert.ok(row.source_refs.some((ref) => ref.endsWith("#git-blob:" + p.plan.task_source.git_blob)));
  assert.equal(row.advice_status, "INSUFFICIENT_EVIDENCE");
  for (const code of ["scope_unknown", "mission_not_observed", "canonical_pair_missing", "matching_approved_decision_not_observed"]) {
    assert.ok(!row.blocking_reasons.includes(code), code);
  }
  for (const code of ["ci_not_observed", "live_owner_lease_fence_not_verified", "host_not_proven"]) assert.ok(row.blocking_reasons.includes(code), code);
  assert.ok(result.audit.git_calls.some((call) => JSON.stringify(call.argv.slice(0, 3)) === JSON.stringify(["ls-tree", "-r", "-z"])));
  assert.equal(Object.prototype.hasOwnProperty.call(p.d, "expires_at"), false);
});
test("actual SDK consumes canonical plan and pair without caller proof injection", (t) => {
  const f = fixture(t), p = committedPlan(f), result = run(f, [f.a.project, JSON.stringify({ task: "T-A" })], { sdk: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.report.plan_source.status, "observed");
  assert.equal(result.output.report.recommendations[0].approval_request_draft.plan_digest, p.draft.sha256);
  assert.equal(result.output.report.execution_authorized, false);
});
test("actual CLI rejects a plan explicitly bound to another project", (t) => {
  const f = fixture(t), p = committedPlan(f);
  p.plan.project_id = "beta"; write(path.join(f.a.repo, p.draft.path), JSON.stringify(p.plan)); commitPlanFixture(f);
  const { data, row } = planData(cli(f));
  assert.equal(data.plan_source.status, "unavailable"); assert.equal(row.mission_ref, null);
  assert.ok(row.blocking_reasons.includes("scope_unknown"));
  assert.ok(data.plan_source.reason_codes.includes("ERR_ADVISOR_PLAN_BINDING"));
});
test("actual CLI does not infer Mission identity from folder names when contract is missing", (t) => {
  const f = fixture(t), p = committedPlan(f);
  fs.unlinkSync(path.join(f.a.repo, p.plan.mission_contract.path)); commitPlanFixture(f);
  const { data, row } = planData(cli(f));
  assert.equal(data.plan_source.status, "unavailable"); assert.equal(row.mission_ref, null);
  assert.ok(data.plan_source.reason_codes.includes("ERR_ADVISOR_MISSION_CONTRACT_MISSING"));
});
test("actual CLI rejects a changed Mission contract even when its mission_id still matches", (t) => {
  const f = fixture(t), p = committedPlan(f);
  write(path.join(f.a.repo, p.plan.mission_contract.path), JSON.stringify(p.contract) + "\n"); commitPlanFixture(f);
  const { data, row } = planData(cli(f));
  assert.equal(data.plan_source.status, "unavailable"); assert.equal(row.mission_ref, null);
  assert.ok(data.plan_source.reason_codes.includes("ERR_ADVISOR_MISSION_IDENTITY"));
});
test("actual CLI reports two active plans for one Task as conflict", (t) => {
  const f = fixture(t), p = committedPlan(f); p.plan.plan_id = "AP-B";
  const { prepareAdvisoryPlan } = require("../../lib/next-action/advisory-plan.js");
  const second = prepareAdvisoryPlan(JSON.stringify(p.plan)); write(path.join(f.a.repo, second.path), second.content); commitPlanFixture(f);
  const { data, row } = planData(cli(f));
  assert.equal(data.plan_source.status, "conflict"); assert.equal(row.mission_ref, null);
  assert.equal(row.advice_status, "RECONCILIATION_REQUIRED");
});
test("actual CLI never reuses old approval after raw plan byte change", (t) => {
  const f = fixture(t), p = committedPlan(f); write(path.join(f.a.repo, p.draft.path), p.draft.content + " "); commitPlanFixture(f);
  const { data, row } = planData(cli(f));
  assert.equal(data.plan_source.status, "observed");
  assert.notEqual(row.approval_request_draft.plan_digest, p.draft.sha256);
  assert.ok(row.blocking_reasons.includes("canonical_pair_missing"));
});
test("actual CLI uses unique-pair semantics instead of first approved Decision", (t) => {
  const f = fixture(t), p = committedPlan(f); p.d.decision_id = "D-B";
  write(path.join(f.a.repo, "decisions/D-B.json"), JSON.stringify(p.d)); commitPlanFixture(f);
  const { row } = planData(cli(f)); assert.equal(row.advice_status, "BLOCKED");
  assert.ok(row.blocking_reasons.includes("canonical_pair_ambiguous"));
});
test("actual CLI treats rejected selection as blocked while retaining zero-write report", (t) => {
  const f = fixture(t), p = committedPlan(f); p.d.selected_option = "reject";
  write(path.join(f.a.repo, "decisions/D-A.json"), JSON.stringify(p.d)); commitPlanFixture(f);
  const { row } = planData(cli(f)); assert.equal(row.advice_status, "BLOCKED");
  assert.ok(row.blocking_reasons.includes("canonical_decision_selection_invalid"));
});
test("actual CLI enforces Waitpoint owner and deadline without fabricating Decision fields", (t) => {
  const f = fixture(t), p = committedPlan(f); p.w.owner_workflow = "/user";
  write(path.join(f.a.repo, "waitpoints/WP-A.json"), JSON.stringify(p.w)); commitPlanFixture(f);
  assert.ok(planData(cli(f)).row.blocking_reasons.includes("canonical_pair_scope_mismatch"));
  p.w.owner_workflow = "/mission"; p.w.expires_at = p.at(-600000);
  write(path.join(f.a.repo, "waitpoints/WP-A.json"), JSON.stringify(p.w)); commitPlanFixture(f);
  const { row } = planData(cli(f)); assert.equal(row.advice_status, "BLOCKED");
  assert.ok(row.blocking_reasons.includes("canonical_waitpoint_expired"));
});
test("actual CLI rejects unknown authority fields in committed Decision schema", (t) => {
  const f = fixture(t), p = committedPlan(f); p.d.execution_authorized = true;
  write(path.join(f.a.repo, "decisions/D-A.json"), JSON.stringify(p.d)); commitPlanFixture(f);
  const { data, row } = planData(cli(f)); assert.equal(data.plan_source.status, "unavailable");
  assert.equal(row.mission_ref, null); assert.ok(data.plan_source.reason_codes.includes("ERR_ADVISOR_PAIR_SCHEMA"));
});
test("actual CLI refuses Git symlink blobs anywhere in canonical plan namespace", (t) => {
  const f = fixture(t), p = committedPlan(f);
  fs.unlinkSync(path.join(f.a.repo, p.draft.path));
  fs.symlinkSync("../validation-contract.json", path.join(f.a.repo, p.draft.path)); commitPlanFixture(f);
  const { data, row } = planData(cli(f)); assert.equal(data.plan_source.status, "unavailable");
  assert.equal(row.mission_ref, null);
});
test("actual CLI enforces bounded namespace count without reading plan bytes", (t) => {
  const f = fixture(t); committedPlan(f);
  for (let i = 0; i < 513; i++) write(path.join(f.a.repo, "missions/fixture-notes/" + i + ".md"), "");
  commitPlanFixture(f); const { data, row } = planData(cli(f));
  assert.equal(data.plan_source.status, "unavailable"); assert.equal(row.mission_ref, null);
  assert.equal(data.plan_source.read_receipts.length, 0);
});
test("actual ref change during plan blob read discards every Task and plan mapping", (t) => {
  const f = fixture(t), p = committedPlan(f), initial = f.a.head;
  p.w.reason = "Later fixture revision"; write(path.join(f.a.repo, "waitpoints/WP-A.json"), JSON.stringify(p.w)); commitPlanFixture(f);
  const next = f.a.head; git(f, f.a.repo, "update-ref", "refs/heads/main", initial);
  const result = cli(f, [], { fault: { kind: "ref", repo: f.a.repo, next, planOnly: true } });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.output.data.source_status.tasks, "conflict");
  assert.deepEqual(result.output.data.recommendations, []); assert.equal(result.output.data.execution_authorized, false);
  assert.equal(result.output.data.plan_source.status, "not_observed");
});

test("actual CLI invalidates old plan on Task byte change and forbids weaker validation after rebinding", (t) => {
  const f = fixture(t), p = committedPlan(f), file = path.join(f.a.repo, "tasks/T-A.json");
  const task = JSON.parse(fs.readFileSync(file, "utf8")); task.owner = "changed-fixture-owner";
  write(file, JSON.stringify(task)); git(f, f.a.repo, "add", "tasks"); git(f, f.a.repo, "commit", "-m", "fixture Task changed");
  let report = planData(cli(f));
  assert.equal(report.data.plan_source.status, "conflict"); assert.equal(report.row.mission_ref, null);
  assert.ok(report.data.plan_source.reason_codes.includes("ERR_ADVISOR_TASK_VERSION_CONFLICT"));
  task.validation_commands.push("node --test new-required.test.js");
  write(file, JSON.stringify(task)); git(f, f.a.repo, "add", "tasks"); git(f, f.a.repo, "commit", "-m", "fixture Task validation changed");
  p.plan.task_source.git_blob = git(f, f.a.repo, "rev-parse", "HEAD:tasks/T-A.json");
  write(path.join(f.a.repo, p.draft.path), JSON.stringify(p.plan)); commitPlanFixture(f);
  report = planData(cli(f)); assert.equal(report.data.plan_source.status, "conflict");
  assert.ok(report.data.plan_source.reason_codes.includes("ERR_ADVISOR_TASK_VALIDATION_CONFLICT"));
  assert.equal(report.row.mission_ref, null);
  assert.deepEqual(report.row.validation_plan.tests, ["node --test fixture-only.test.js", "node --test new-required.test.js"]);
});
