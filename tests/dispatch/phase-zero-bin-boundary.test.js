"use strict";

// Public package-bin regression, not live L3/Host acceptance.
// The checked-out product files are unmodified; every invocation gets a fresh
// regular-file source snapshot, synthetic project and HOME.
// Run through .github/workflows/phase-zero-bin-boundary.yml. Its exact-head
// materializer creates phase-zero-source-proof.json; this test intentionally
// does not run standalone from an ordinary checkout without that proof.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "../..");
const manifest = require("./phase-zero-source-manifest.json");
const proofPath = path.join(ROOT, "phase-zero-source-proof.json");
assert.ok(fs.existsSync(proofPath), "Run the phase-zero-bin-boundary.yml exact-head materializer first; source proof is required");
const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
assert.match(proof.source_head, /^[0-9a-f]{40}$/);
assert.deepEqual(Object.keys(proof.blobs).sort(), manifest.sources.slice().sort());
const hash = (bytes, algorithm = "sha256") => crypto.createHash(algorithm).update(bytes).digest("hex");
const blobHash = (bytes) => crypto.createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
function snapshot(root) {
  const result = {};
  function visit(file) {
    const st = fs.lstatSync(file, { bigint: true }), key = path.relative(root, file) || ".";
    result[key] = { mode: String(st.mode), size: String(st.size), mtime_ns: String(st.mtimeNs),
      type: st.isFile() ? "file" : st.isDirectory() ? "directory" : st.isSymbolicLink() ? "symlink" : "other" };
    if (st.isFile()) result[key].sha256 = hash(fs.readFileSync(file));
    if (st.isSymbolicLink()) result[key].target = fs.readlinkSync(file);
    if (st.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
  }
  visit(root);
  return result;
}

// Serialized into a standalone --require preload. Nothing from the package
// has been imported when the sink guards, loader guard and audit hook install.
function boundary(config) {
  const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
  const cp = require("node:child_process"), net = require("node:net");
  const worker = require("node:worker_threads");
  const Socket = net.Socket, ChildProcess = cp.ChildProcess;
  const fileURLToPath = require("node:url").fileURLToPath;
  // Initialize the diagnostic streams before guarding network constructors.
  void process.stdout; void process.stderr;
  const rawWrite = fs.writeSync, originalLoad = Module._load, originalResolve = Module._resolveFilename;
  const metrics = { schema_version: 1, node: process.version, source_head: config.head,
    guards_ready: false, modules: [], optional_absent: [], installed_export_guards: [],
    counts: { fs_write: 0, network: 0, child: 0, worker: 0, dispatch: 0, host: 0, effect: 0,
      unexpected_module: 0, outside_read: 0, native_escape: 0 }, denied: [] };
  process.once("exit", (exitCode) => {
    metrics.exit_code = exitCode;
    metrics.modules.sort();
    rawWrite(3, JSON.stringify(metrics) + "\n");
  });
  function deny(counter, label) {
    metrics.counts[counter]++;
    metrics.denied.push(label);
    const error = new Error("PHASE0_BOUNDARY_DENIED:" + label);
    error.code = "PHASE0_BOUNDARY_DENIED";
    throw error;
  }
  const replace = (object, key, counter, label) => {
    if (typeof object[key] === "function") object[key] = function() { return deny(counter, label); };
  };
  for (const name of ["node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dgram", "node:dns"]) {
    const api = require(name);
    for (const key of Object.keys(api)) replace(api, key, "network", name + "." + key);
    if (api.promises) for (const key of Object.keys(api.promises)) replace(api.promises, key, "network", name + ".promises." + key);
  }
  // Saved built-in prototype references prevent a constructor/import bypass.
  // The actual production sources use only the APIs covered above.
  replace(Socket.prototype, "connect", "network", "net.Socket.connect");
  replace(ChildProcess.prototype, "spawn", "child", "ChildProcess.spawn");
  replace(ChildProcess.prototype, "send", "child", "ChildProcess.send");
  for (const key of Object.keys(cp)) replace(cp, key, "child", "child_process." + key);
  replace(worker, "Worker", "worker", "worker_threads.Worker");
  globalThis.fetch = function() { return deny("network", "fetch"); };
  globalThis.WebSocket = function() { return deny("network", "WebSocket"); };
  for (const key of ["kill", "dlopen", "binding", "_linkedBinding"]) {
    replace(process, key, key === "kill" ? "child" : "native_escape", "process." + key);
  }
  const mutations = ["appendFile", "chmod", "chown", "copyFile", "cp", "fchmod", "fchown",
    "fdatasync", "fsync", "ftruncate", "futimes", "lchmod", "lchown", "lutimes", "link",
    "mkdir", "mkdtemp", "rename", "rm", "rmdir", "symlink", "truncate", "unlink",
    "utimes", "write", "writeFile", "writev", "createWriteStream", "WriteStream", "FileWriteStream"];
  for (const name of mutations) {
    for (const suffix of ["", "Sync"]) replace(fs, name + suffix, "fs_write", "fs." + name + suffix);
    replace(fs.promises, name, "fs_write", "fs.promises." + name);
  }
  function checkedRead(file) {
    if (typeof file === "number") return;
    const value = file instanceof URL ? fileURLToPath(file) : Buffer.isBuffer(file) ? file.toString() : file;
    if (typeof value !== "string") return deny("outside_read", "non-path-read");
    const absolute = path.resolve(value);
    if (absolute !== config.root && !absolute.startsWith(config.root + path.sep)) {
      return deny("outside_read", "outside-fixture-read");
    }
  }
  for (const name of ["readFile", "readdir", "readlink", "realpath", "stat", "lstat", "access", "exists"]) {
    for (const suffix of ["", "Sync"]) {
      const key = name + suffix, original = fs[key];
      if (typeof original === "function") {
        const wrapped = function(file, ...args) { checkedRead(file); return original.call(this, file, ...args); };
        if (typeof original.native === "function") {
          wrapped.native = function(file, ...args) { checkedRead(file); return original.native.call(this, file, ...args); };
        }
        fs[key] = wrapped;
      }
    }
    const original = fs.promises[name];
    if (typeof original === "function") fs.promises[name] = function(file, ...args) {
      checkedRead(file); return original.call(this, file, ...args);
    };
  }
  for (const key of ["open", "openSync"]) {
    const original = fs[key];
    fs[key] = function(file, flags, ...args) {
      const writing = typeof flags === "number"
        ? !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
        : !/^r[s]?$/.test(flags);
      if (writing) return deny("fs_write", "fs." + key + ":write");
      checkedRead(file);
      return original.call(this, file, flags, ...args);
    };
  }
  // Current reviewed closure has no async open; no FileHandle write escape.
  fs.promises.open = function() { return deny("fs_write", "fs.promises.open:unapproved"); };
  const allowed = new Set(config.manifest.sources.map((name) => path.join(config.source, name)));
  const builtins = new Set(config.manifest.builtins);
  const wrappedModules = new Map();
  function guardedExports(file, value) {
    const relative = path.relative(config.source, file).split(path.sep).join("/");
    const rule = config.manifest.deny_exports[relative];
    if (!rule) return value;
    if (wrappedModules.has(file)) return wrappedModules.get(file);
    const result = Object.create(Object.getPrototypeOf(value));
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (typeof descriptor.value === "function" && (rule.names.includes("*") || rule.names.includes(key))) {
        const target = descriptor.value;
        descriptor.value = new Proxy(target, {
          apply() { return deny(rule.counter, relative + "#" + key); },
          construct() { return deny(rule.counter, relative + "#new " + key); },
        });
        metrics.installed_export_guards.push(relative + "#" + key);
      }
      Object.defineProperty(result, key, descriptor);
    }
    wrappedModules.set(file, result);
    if (require.cache[file]) require.cache[file].exports = result;
    return result;
  }
  Module._load = function(request, parent, isMain) {
    if (Module.isBuiltin(request)) {
      if (!builtins.has(request.replace(/^node:/, ""))) return deny("unexpected_module", "builtin:" + request);
      return originalLoad.call(this, request, parent, isMain);
    }
    const parentRelative = parent && path.relative(config.source, parent.filename).split(path.sep).join("/");
    const optional = config.manifest.optional_absent.find((item) => item.request === request && item.parents.includes(parentRelative));
    if (optional) {
      try { originalResolve.call(this, request, parent, isMain); }
      catch (error) {
        if (error.code !== "MODULE_NOT_FOUND") throw error;
        metrics.optional_absent.push({ request, parent: parentRelative });
        throw error;
      }
      return deny("unexpected_module", "unexpected-installed-workspace-alias");
    }
    const base = path.isAbsolute(request) ? request
      : request.startsWith(".") && parent ? path.resolve(path.dirname(parent.filename), request) : null;
    if (!base || ![base, base + ".js", base + ".json", base + ".cjs", path.join(base, "index.js")].some((file) => allowed.has(file))) {
      // The legacy internal manual execution module is intentionally not called.
      if (base === path.join(config.source, "lib/dispatch/execute.js")) return deny("dispatch", "manual-execute-module-entry");
      return deny("unexpected_module", "outside-reviewed-closure:" + request);
    }
    const file = originalResolve.call(this, request, parent, isMain);
    if (!allowed.has(file)) return deny("unexpected_module", "resolved-outside-closure");
    if (!metrics.modules.includes(path.relative(config.source, file))) metrics.modules.push(path.relative(config.source, file));
    const value = originalLoad.call(this, request, parent, isMain);
    return guardedExports(file, value);
  };
  metrics.guards_ready = true;
  if (config.control) {
    try {
      if (config.control === "fs_write") fs.writeFileSync(path.join(config.project, "forbidden"), "must not exist");
      else if (config.control === "network") net.createConnection({ host: "127.0.0.1", port: 1 });
      else if (config.control === "child") cp.spawnSync(process.execPath, ["--version"]);
      else if (config.control === "dispatch") require(path.join(config.source, "lib/agents/dispatch-execute.js")).dispatchExecute({});
      else if (config.control === "host") require(path.join(config.source, "lib/coordination/notification-host.js")).createNotificationHarness(config.project);
      else throw new Error("Unknown control");
    } catch (error) {
      if (error.code === "PHASE0_BOUNDARY_DENIED") process.exit(87);
      throw error;
    }
    throw new Error("Instrumentation control failed open");
  }
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-phase0-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = { root, source: path.join(root, "source"), project: path.join(root, "project"),
    home: path.join(root, "home"), tmp: path.join(root, "tmp"), control: path.join(root, "control") };
  for (const dir of [f.source, f.project, f.home, f.tmp, f.control]) fs.mkdirSync(dir);
  for (const relative of manifest.sources) {
    const original = path.join(ROOT, relative), destination = path.join(f.source, relative);
    const st = fs.lstatSync(original);
    assert.ok(st.isFile() && !st.isSymbolicLink(), relative);
    const bytes = fs.readFileSync(original);
    assert.equal(blobHash(bytes), proof.blobs[relative].blob, relative);
    write(destination, bytes);
    fs.chmodSync(destination, proof.blobs[relative].mode === "100755" ? 0o755 : 0o644);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.source, "package.json"))).bin["cortex-agent"], "bin/cli.js");
  assert.equal(fs.existsSync(path.join(f.source, ".agent")), false);
  assert.equal(fs.existsSync(path.join(f.source, "node_modules")), false);
  for (const relative of [".agent/runs", ".agent/queues", ".agent/sessions", ".agent/decisions",
    ".agent/waitpoints", ".agent/locks", ".agent/operations", ".agent/authorizations", ".agent/readiness",
    ".agent/memory", ".agent/indexes", ".agent/dispatch-cache", ".agent/runtime/coordination/leases",
    ".agent/runtime/dispatch", ".agent-runtime/coordination/leases", ".agent-runtime/dispatch",
    ".agent-runtime/cross-project/outbox", ".agent/runtime/cross-project/outbox"]) {
    write(path.join(f.project, relative, ".keep"), "synthetic fixture canary\n");
  }
  write(path.join(f.project, ".agent/memory/index.json"), '{"fixture":"unchanged"}\n');
  write(path.join(f.home, ".agent/fixture-canary"), "synthetic home canary\n");
  if (options.conflict) write(path.join(f.project, ".agent/runs/R-EXIST.json"),
    JSON.stringify({ run_id: "R-EXIST", task_id: "T-FIXTURE", phase: "EXECUTE_FEATURE" }));
  if (options.language) write(path.join(f.project, ".agent/rules/language.md"), options.language);
  if (options.fakeAuthority) {
    write(path.join(f.project, ".agent/decisions/D-FAKE.json"),
      JSON.stringify({ decision_id: "D-FAKE", status: "approved", relations: { task_ids: ["T-FIXTURE"] } }));
    write(path.join(f.project, ".agent/waitpoints/W-FAKE.json"),
      JSON.stringify({ waitpoint_id: "W-FAKE", status: "released", relations: { task_ids: ["T-FIXTURE"] } }));
  }
  f.guard = path.join(f.control, "boundary.cjs");
  write(f.guard, "(" + boundary.toString() + ")(" + JSON.stringify({
    root, source: f.source, project: f.project, head: proof.source_head, manifest, control: options.control || null,
  }) + ");\n");
  return f;
}
function invoke(t, f, args, expectedExit, expectedControl = null) {
  const before = snapshot(f.root);
  const result = spawnSync(process.execPath, ["--require", f.guard, path.join(f.source, "bin/cli.js"), ...args], {
    cwd: f.project, env: {
      PATH: "", HOME: f.home, USERPROFILE: f.home, XDG_CONFIG_HOME: f.home,
      TMPDIR: f.tmp, TMP: f.tmp, TEMP: f.tmp, LANG: "C", LC_ALL: "C", TZ: "UTC", CI: "true",
    }, stdio: ["ignore", "pipe", "pipe", "pipe"], encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const auditLines = result.output[3].trim().split("\n");
  assert.equal(auditLines.length, 1, "exactly one out-of-band exit audit");
  const audit = JSON.parse(auditLines[0]);
  assert.equal(audit.guards_ready, true);
  assert.equal(audit.exit_code, result.status);
  for (const [counter, count] of Object.entries(audit.counts)) {
    assert.equal(count, counter === expectedControl ? 1 : 0, counter + ": " + JSON.stringify(audit.denied));
  }
  assert.equal(audit.denied.length, expectedControl ? 1 : 0);
  assert.equal(result.status, expectedExit, result.stderr);
  assert.deepEqual(snapshot(f.root), before, "source/project/HOME/tmp entries, bytes, modes and mtimes");
  t.diagnostic(JSON.stringify({ tier: "U", source_head: proof.source_head, argv: args, audit,
    live_governance_effect_count: null, live_host_call_count: null, future_authority_consumers: null }));
  return { ...result, audit };
}
function stub(result) {
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.implemented, false);
  assert.equal(output.phase, 0);
  assert.equal(output.side_effects, false);
  assert.equal(output.error.code, "PHASE_ZERO_STUB");
}
for (const [name, args] of [
  ["execute", ["dispatch", "execute", "T-FIXTURE", "--json"]],
  ["bare", ["dispatch", "--json"]],
  ["unknown subcommand", ["dispatch", "dry-runx", "T-FIXTURE", "--json"]],
]) test("Phase-0 bin: " + name + " stays stub", (t) => {
  const f = fixture(t); stub(invoke(t, f, args, 2));
});
test("Phase-0 bin: fake approval and full execution flags cannot activate execute", (t) => {
  const f = fixture(t, { fakeAuthority: true });
  stub(invoke(t, f, ["dispatch", "execute", "T-FIXTURE", "--project", f.project, "--host", "H-A",
    "--gate", "owner", "--idempotency-key", "fixture", "--execution-authorized=true", "--json"], 2));
});
test("Phase-0 bin: help is discoverable and non-executing", (t) => {
  const f = fixture(t), output = JSON.parse(invoke(t, f, ["dispatch", "execute", "--help", "--json"], 0).stdout);
  assert.equal(output.status, "stub"); assert.equal(output.phase, 0);
  assert.equal(output.implemented, false); assert.equal(output.side_effects, false);
});
test("Phase-0 bin: execute --output json alone retains legacy human stderr", (t) => {
  const f = fixture(t), result = invoke(t, f, ["dispatch", "execute", "T-FIXTURE", "--output", "json"], 2);
  assert.equal(result.stdout, ""); assert.match(result.stderr, /Phase 0 contract stub/);
});
for (const flags of [["--json"], ["--output", "json"], ["--output=json"]]) {
  test("Phase-0 bin: synthetic dry-run " + flags.join(" "), (t) => {
    const f = fixture(t), output = JSON.parse(invoke(t, f, ["dispatch", "dry-run", "T-FIXTURE", ...flags], 0).stdout);
    assert.equal(output.task_id, "T-FIXTURE"); assert.equal(output.would_proceed, true);
    assert.equal(output.snapshot.selection, "H-A");
    assert.equal(output.next_run_event.activity, "dispatch_dry_run");
    assert.equal(output.idempotency.existing_run_id, null);
    assert.equal(output.idempotency.would_duplicate, false);
    // would_* and synthetic matcher selection are preview data, not authority.
    assert.notEqual(output.execution_authorized, true);
    assert.notEqual(output.effect_permitted, true);
    assert.equal(fs.readdirSync(path.join(f.project, ".agent/decisions")).filter((x) => x.endsWith(".json")).length, 0);
  });
}
test("Phase-0 bin: preview values fed to execute still cannot dispatch", (t) => {
  const f = fixture(t), plan = JSON.parse(invoke(t, f, ["dispatch", "dry-run", "T-FIXTURE", "--json"], 0).stdout);
  stub(invoke(t, f, ["dispatch", "execute", plan.task_id, "--host", plan.snapshot.selection,
    "--idempotency-key", plan.idempotency.key, "--gate", "owner", "--plan-json", JSON.stringify(plan), "--json"], 2));
});
test("Phase-0 bin: human preview keeps would_* vocabulary", (t) => {
  const f = fixture(t), result = invoke(t, f, ["dispatch", "dry-run", "T-FIXTURE"], 0);
  assert.match(result.stdout, /dispatch dry-run task_id=T-FIXTURE/);
  assert.match(result.stdout, /would_proceed=true/);
});
for (const fail of [false, true]) test("Phase-0 bin: conflict exit policy fail=" + fail, (t) => {
  const f = fixture(t, { conflict: true });
  const output = JSON.parse(invoke(t, f, ["dispatch", "dry-run", "T-FIXTURE", "--json", ...(fail ? ["--fail-on-conflict"] : [])], fail ? 3 : 0).stdout);
  assert.equal(output.would_proceed, false); assert.equal(output.idempotency.existing_run_id, "R-EXIST");
});
test("Phase-0 bin: missing task retains usage exit 2", (t) => {
  const f = fixture(t), result = invoke(t, f, ["dispatch", "dry-run", "--project", f.project], 2);
  assert.match(result.stderr, /<task-id> required/);
});
test("Phase-0 bin: project language is preserved", (t) => {
  const f = fixture(t, { language: "首选语言：中文" });
  const result = invoke(t, f, ["dispatch", "dry-run", "--project=" + f.project], 2);
  assert.match(result.stderr, /用法:/);
});
test("Phase-0 bin: explicit language overrides project language", (t) => {
  const f = fixture(t, { language: "首选语言：中文" });
  const result = invoke(t, f, ["dispatch", "dry-run", "--project", f.project, "--lang=en"], 2);
  assert.match(result.stderr, /Usage:/);
});
test("Phase-0 bin: unsupported flags stay permissive", (t) => {
  const f = fixture(t);
  const output = JSON.parse(invoke(t, f, ["dispatch", "dry-run", "T-FIXTURE", "--future-flag", "--json"], 0).stdout);
  assert.equal(output.task_id, "T-FIXTURE"); assert.equal(output.would_proceed, true);
});
for (const control of ["fs_write", "network", "child", "dispatch", "host"]) {
  test("Phase-0 instrumentation catches attempted " + control + " before effect", (t) => {
    const f = fixture(t, { control });
    invoke(t, f, ["dispatch", "execute", "T-FIXTURE", "--json"], 87, control);
  });
}
