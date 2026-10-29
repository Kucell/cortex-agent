"use strict";

// Bounded Linux REAL-FILE fixture, using SYNTHETIC authority only. This is not a
// RuntimeWriter appointment, production authenticator, Host, or callback sink.
// Import is inert. Only the separately attested supervisor/driver can construct
// this fixture; client identity comes from inherited pipe objects, never JSON.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SOURCE_PATHS = Object.freeze([
  "lib/runtime-state/serialized-artifact-gateway.js",
  "tests/runtime-state/serialized-artifact-gateway.test.js",
  "scripts/l3/linux-sink-canary.py",
  "tests/fixtures/l3/linux-sink-client.cjs",
]);
const CORPUS = Object.freeze({ "a.txt": "alpha\n", "b.txt": "beta\n", "c.txt": "gamma\n" });
const LIMITS = Object.freeze({ publications: 3, requests: 48, queued: 48, journalBytes: 65536, sourceBytes: 262144 });
const permits = new WeakMap();
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function check(value, code) { if (!value) fail(code); }
function exact(value, names, code = "FIELDS") {
  check(value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.getOwnPropertySymbols(value).length === 0, code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Object.values(descriptors).every((d) => Object.hasOwn(d, "value") && d.enumerable)
    && Object.keys(value).sort().join("|") === [...names].sort().join("|"), code);
}
function integer(value, min, max, code) { check(Number.isSafeInteger(value) && value >= min && value <= max, code); }
function hex(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function decimal(value) { return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value); }
function channelName(index) { return "synthetic:pipe-" + (index + 1); }

// PURE: no clock, filesystem, subprocess, network, or identity appointment.
function validateRequest(raw) {
  check(typeof raw === "string" && Buffer.byteLength(raw) <= 2048, "REQUEST_SIZE");
  let request;
  try { request = JSON.parse(raw); } catch (_) { fail("MALFORMED_JSON"); }
  exact(request, ["protocol", "project", "run", "attempt", "channel", "sequence", "operation", "fence", "name", "text"]);
  check(request.protocol === 1 && request.project === "synthetic:linux-sink", "PROJECT");
  check(typeof request.run === "string" && /^synthetic:[a-f0-9]{64}$/.test(request.run), "RUN");
  integer(request.attempt, 1, 8, "ATTEMPT");
  check([channelName(0), channelName(1)].includes(request.channel), "CHANNEL");
  integer(request.sequence, 1, 48, "SEQUENCE");
  integer(request.fence, 1, 8, "FENCE");
  check(typeof request.operation === "string" && /^synthetic:[a-z][a-z-]{0,31}$/.test(request.operation), "OPERATION");
  check(typeof request.name === "string" && Object.hasOwn(CORPUS, request.name), "PATH");
  check(Object.values(CORPUS).includes(request.text), "CONTENT");
  return Object.freeze(request);
}
function evaluateGate(authority, request, identity, at, spent) {
  // PURE. A supplied identity here is data for unit validation, NOT authority.
  if (authority.closed) return "CLOSED";
  if (authority.quarantined) return "QUARANTINED";
  if (request.run !== identity.run || request.attempt !== identity.attempt) return "BINDING";
  if (request.channel !== identity.channel) return "CHANNEL_BINDING";
  if (authority.revoked) return "REVOKED";
  if (request.fence !== authority.fence) return "STALE_FENCE";
  if (!Number.isSafeInteger(at) || at >= authority.expiresAt) return "EXPIRED";
  if (spent >= LIMITS.publications) return "BUDGET";
  return null;
}
function validateHello(hello, mode) {
  exact(hello, ["type", "protocol", "synthetic", "nonce", "root", "parent_pid", "source_manifest", "pipes",
    ...(mode === "reconcile" ? ["recovery"] : [])]);
  check(hello.type === "hello" && hello.protocol === 1 && hello.synthetic === true && hex(hello.nonce), "SUPERVISOR_HELLO");
  check(typeof hello.root === "string" && path.isAbsolute(hello.root) && path.resolve(hello.root) === hello.root, "ROOT");
  integer(hello.parent_pid, 2, 4194304, "SUPERVISOR_PID");
  exact(hello.source_manifest, SOURCE_PATHS, "SOURCE_MANIFEST");
  check(Object.values(hello.source_manifest).every(hex), "SOURCE_HASH");
  check(Array.isArray(hello.pipes) && hello.pipes.length === (mode === "reconcile" ? 0 : 2), "PIPES");
  const descriptors = new Set();
  for (const pipe of hello.pipes) {
    exact(pipe, ["readFd", "writeFd", "readStat", "writeStat"]);
    for (const name of ["readFd", "writeFd"]) {
      integer(pipe[name], 3, 255, "PIPE_FD");
      check(!descriptors.has(pipe[name]), "PIPE_ALIAS"); descriptors.add(pipe[name]);
    }
    for (const stat of [pipe.readStat, pipe.writeStat]) {
      exact(stat, ["dev", "ino"]); check(decimal(stat.dev) && decimal(stat.ino), "PIPE_STAT");
    }
  }
  if (mode === "reconcile") {
    exact(hello.recovery, ["name", "size", "sha256", "operation", "journal_events"]);
    check(hello.recovery.name === "c.txt" && hello.recovery.size === 6
      && hello.recovery.sha256 === digest(CORPUS["c.txt"]) && hello.recovery.operation === "synthetic:crash", "RECOVERY_SCOPE");
    integer(hello.recovery.journal_events, 1, 128, "RECOVERY_EVENTS");
  }
  return hello;
}
function stableStat(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid
    && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function readRegular(file, limit, expectedLinks = 1) {
  const before = fs.lstatSync(file);
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === expectedLinks && before.size <= limit, "UNSAFE_FILE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    check(stableStat(before, fs.fstatSync(fd)), "CHANGED_FILE");
    const bytes = Buffer.alloc(limit + 1); let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    check(length === before.size && length <= limit && stableStat(before, fs.fstatSync(fd))
      && stableStat(before, fs.lstatSync(file)), "CHANGED_FILE");
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function privateDirectory(root) {
  check(fs.realpathSync(root) === root, "ROOT_SYMLINK");
  const info = fs.lstatSync(root);
  check(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0
    && info.uid === process.getuid(), "ROOT_PRIVATE");
  return info;
}
function rootIdentity(root, pinned) {
  const now = privateDirectory(root);
  check(now.dev === pinned.dev && now.ino === pinned.ino, "ROOT_CHANGED");
}
function syncDirectory(root) {
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// This brand only binds a synthetic test assembly. The protected socket/pipe
// inheritance and the supervisor's source/runtime/isolation checks are required
// trust assumptions. It is expressly NOT a caller-JSON production authenticator.
function verifySupervisorBinding(hello, controlFd, mode = "sink") {
  check(mode === "sink" || mode === "reconcile", "MODE");
  validateHello(hello, mode);
  integer(controlFd, 3, 255, "CONTROL_FD");
  check(process.platform === "linux" && typeof process.getuid === "function"
    && Number.isInteger(fs.constants.O_NOFOLLOW) && Number.isInteger(fs.constants.O_DIRECTORY), "LINUX_REQUIRED");
  check(!process.env.NODE_TEST_CONTEXT && require.main
    && fs.realpathSync(require.main.filename) === fs.realpathSync(path.resolve(__dirname, "../../tests/runtime-state/serialized-artifact-gateway.test.js"))
    && process.argv.length === 4 && process.argv[2] === (mode === "sink" ? "--physical-supervised" : "--physical-reconcile")
    && process.argv[3] === String(controlFd), "FIXED_DRIVER_REQUIRED");
  check(process.ppid === hello.parent_pid && fs.fstatSync(controlFd).isSocket(), "CONTROL_BINDING");
  const sourceRoot = path.resolve(__dirname, "../..");
  for (const relative of SOURCE_PATHS) {
    const file = path.join(sourceRoot, relative);
    check(fs.realpathSync(file) === file && digest(readRegular(file, LIMITS.sourceBytes)) === hello.source_manifest[relative], "SOURCE_CHANGED");
  }
  const rootStat = privateDirectory(hello.root);
  privateDirectory(path.dirname(hello.root));
  check(path.basename(hello.root) === "sink" && /^cortex-linux-sink-[A-Za-z0-9_-]+$/.test(path.basename(path.dirname(hello.root))), "ROOT_SCOPE");
  check(mode !== "sink" || fs.readdirSync(hello.root).length === 0, "ROOT_NOT_FRESH");
  const endpoints = hello.pipes.map((pipe, index) => {
    for (const [name, expected] of [["readFd", pipe.readStat], ["writeFd", pipe.writeStat]]) {
      check(pipe[name] !== controlFd, "CONTROL_ALIAS");
      const stat = fs.fstatSync(pipe[name], { bigint: true });
      check(stat.isFIFO() && String(stat.dev) === expected.dev && String(stat.ino) === expected.ino, "PIPE_CHANGED");
    }
    return Object.freeze({ endpoint: Object.freeze(Object.create(null)), index,
      readFd: pipe.readFd, writeFd: pipe.writeFd, identity: Object.freeze({
        run: "synthetic:" + hello.nonce, attempt: 1, channel: channelName(index),
      }) });
  });
  check(new Set(hello.pipes.flatMap((p) => [p.readStat.dev + ":" + p.readStat.ino, p.writeStat.dev + ":" + p.writeStat.ino])).size
    === endpoints.length * 2, "PIPE_IDENTITY_ALIAS");
  const permit = Object.freeze(Object.create(null));
  permits.set(permit, { hello: JSON.parse(JSON.stringify(hello)), rootStat, endpoints, mode });
  return Object.freeze({ permit, endpoints: Object.freeze(endpoints) });
}

function openSupervisedGateway(permit) {
  const binding = permits.get(permit);
  check(binding && binding.mode === "sink", "SUPERVISOR_PERMIT_REQUIRED");
  permits.delete(permit);
  const { hello, rootStat, endpoints } = binding, root = hello.root;
  rootIdentity(root, rootStat);
  check(fs.readdirSync(root).length === 0, "ROOT_NOT_FRESH");
  const identities = new WeakMap(endpoints.map((e) => [e.endpoint, e.identity]));
  const sequences = new WeakMap(endpoints.map((e) => [e.endpoint, 0]));
  const queue = [], claims = new Map(), tickets = new WeakMap();
  const authority = { fence: 1, expiresAt: Date.now() + 60000, revoked: false, closed: false, quarantined: false };
  let busy = false, requests = 0, spent = 0, eventCount = 0, previous = null, journalBytes = 0, preparations = 0;
  const journal = path.join(root, ".journal");
  const journalFd = fs.openSync(journal, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let journalClosed = false;
  function record(state, fields = {}) {
    const event = { sequence: ++eventCount, state, at: Date.now(), previous, ...fields };
    const line = JSON.stringify(event) + "\n";
    check(eventCount <= 128 && journalBytes + Buffer.byteLength(line) <= LIMITS.journalBytes, "JOURNAL_BOUND");
    fs.writeFileSync(journalFd, line); fs.fsyncSync(journalFd);
    previous = digest(line); journalBytes += Buffer.byteLength(line);
  }
  record("BOUND", { synthetic: true, production_authority: false, nonce: hello.nonce, budget: LIMITS.publications });
  syncDirectory(root);
  function serial(fn) {
    check(!busy && !journalClosed, "SERIAL_GATE_CLOSED"); busy = true;
    try { rootIdentity(root, rootStat); return fn(); }
    catch (error) { authority.quarantined = true; throw error; }
    finally { busy = false; }
  }
  function denial(code) { return Object.freeze({ status: "DENIED", code, executable_success: false, production_authority: false }); }
  function currentGate(request, identity, budget = true) {
    return evaluateGate(authority, request, identity, Date.now(), budget ? spent : 0);
  }
  function enqueue(endpoint, raw) {
    check(!busy, "REENTRANT");
    if (++requests > LIMITS.requests) return denial("REQUEST_BOUND");
    const identity = identities.get(endpoint);
    if (!identity) return denial("ENDPOINT");
    let request;
    try { request = validateRequest(raw); } catch (error) { return denial(error.code); }
    if (request.run !== identity.run || request.attempt !== identity.attempt) return denial("BINDING");
    if (request.channel !== identity.channel) return denial("CHANNEL_BINDING");
    if (request.sequence <= sequences.get(endpoint)) return denial("SEQUENCE_REPLAY");
    sequences.set(endpoint, request.sequence);
    if (authority.closed) return denial("CLOSED");
    if (queue.length >= LIMITS.queued) return denial("QUEUE_BOUND");
    // Enqueue never reserves authority, a fence, a budget unit or future effect.
    queue.push({ identity, request });
    return Object.freeze({ status: "QUEUED", executable_success: false });
  }
  function publish(job) {
    const { request, identity } = job;
    const blocked = currentGate(request, identity);
    if (blocked) return denial(blocked);
    const prior = claims.get(request.operation);
    if (prior && (prior.channel !== identity.channel || prior.fence !== request.fence
      || prior.name !== request.name || prior.sha256 !== digest(request.text))) return denial("CLAIM_CONFLICT");
    const final = path.join(root, request.name), sha256 = digest(request.text);
    let existing;
    try { existing = readRegular(final, 6); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing) {
      if (digest(existing) !== sha256) return denial("CONTENT_CONFLICT");
      return Object.freeze({ status: "DEDUPE_OBSERVATION", sha256, executable_success: false, production_authority: false });
    }
    const metadata = { operation: request.operation, name: request.name, size: Buffer.byteLength(request.text), sha256,
      channel: identity.channel, fence: request.fence };
    record("INTENDED", metadata);
    // INTENDED fsync may cross expiry. Recheck after it and linearize admission
    // at this clock sample, before recording ADMITTED or creating preparation.
    // The serial executor also owns revocation and fence changes. Completion
    // may be later: admitted_at is never claimed as a physical completion time.
    const admittedAt = Date.now();
    const admissionBlocked = evaluateGate(authority, request, identity, admittedAt, spent);
    if (admissionBlocked) return denial(admissionBlocked);
    metadata.admitted_at = admittedAt;
    metadata.expires_at = authority.expiresAt;
    record("ADMITTED", metadata);
    claims.set(request.operation, metadata);
    const prep = path.join(root, ".prep-" + (spent + 1));
    const fd = fs.openSync(prep, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    preparations++;
    try { fs.writeFileSync(fd, request.text, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // link() atomically creates one final name or fails EEXIST. No rename,
    // replacement, multi-record atomicity claim, or caller-selected effect.
    fs.linkSync(prep, final);
    spent++; // Never release a consumed unit after an uncertain result.
    fs.unlinkSync(prep);
    syncDirectory(root);
    check(digest(readRegular(final, 6)) === sha256, "READBACK_DIGEST");
    record("PUBLISHED", metadata);
    const ticket = Object.freeze(Object.create(null));
    tickets.set(ticket, { ...metadata, request, identity, observed: false });
    return Object.freeze({ status: "PUBLISHED_PENDING_OBSERVATION", ticket, name: request.name,
      size: metadata.size, sha256, admitted_at: admittedAt, expires_at: metadata.expires_at,
      executable_success: false, production_authority: false });
  }
  function drain() {
    return serial(() => {
      const results = [];
      while (queue.length) {
        const job = queue.shift();
        try { results.push(publish(job)); }
        catch (error) {
          authority.quarantined = true;
          results.push(Object.freeze({ status: "UNKNOWN", code: error.code || "IO_FAILURE", executable_success: false }));
        }
      }
      return results;
    });
  }
  function observe(ticket) {
    return serial(() => {
      const value = tickets.get(ticket); check(value && !value.observed, "TICKET");
      const blocked = currentGate(value.request, value.identity, false);
      check(digest(readRegular(path.join(root, value.name), 6)) === value.sha256, "READBACK_DIGEST");
      value.observed = true;
      record(blocked ? "QUARANTINED_COMPLETION" : "OBSERVED", { operation: value.operation, name: value.name,
        sha256: value.sha256, reason: blocked });
      return Object.freeze({ status: blocked ? "QUARANTINED_COMPLETION" : "OBSERVED", reason: blocked,
        admitted_before_boundary: true, physical_publication: true, executable_success: !blocked,
        production_authority: false, next_effect_authorized: false });
    });
  }
  function revoke() {
    return serial(() => {
      authority.revoked = true; authority.fence++;
      record("REVOKED", { fence: authority.fence });
      return Object.freeze({ status: "DENY_BARRIER", fence: authority.fence });
    });
  }
  function rotate() {
    return serial(() => {
      check(!authority.closed && !authority.quarantined && authority.fence < 8, "ROTATE_DENIED");
      authority.fence++; authority.revoked = false; authority.expiresAt = Date.now() + 60000;
      record("SYNTHETIC_ROTATION", { fence: authority.fence, expires_at: authority.expiresAt });
      return authority.fence;
    });
  }
  function expireSoon() {
    return serial(() => {
      check(!authority.closed && !authority.revoked, "EXPIRY_DENIED");
      authority.expiresAt = Math.min(authority.expiresAt, Date.now() + 30);
      record("SYNTHETIC_EXPIRY_SHORTENED", { expires_at: authority.expiresAt });
      return authority.expiresAt;
    });
  }
  function closeAdmission() {
    return serial(() => { authority.closed = true; queue.length = 0; record("ADMISSION_CLOSED"); });
  }
  function snapshot() {
    rootIdentity(root, rootStat);
    return Object.freeze({ files: fs.readdirSync(root).sort().map((name) => {
      check(name === ".journal" || /^\.prep-[123]$/.test(name) || Object.hasOwn(CORPUS, name), "UNEXPECTED_ENTRY");
      const bytes = readRegular(path.join(root, name), name === ".journal" ? LIMITS.journalBytes : 6);
      return { name, size: bytes.length, sha256: digest(bytes) };
    }), requests, publications: spent, preparations, journal_events: eventCount,
    authority: { ...authority }, production_authority: false });
  }
  function closeJournal() { if (!journalClosed) { fs.closeSync(journalFd); journalClosed = true; } }
  return Object.freeze({ enqueue, drain, observe, revoke, rotate, expireSoon, closeAdmission, snapshot, closeJournal });
}

function reconcileSupervisedGateway(permit) {
  const binding = permits.get(permit);
  check(binding && binding.mode === "reconcile", "SUPERVISOR_PERMIT_REQUIRED"); permits.delete(permit);
  const { hello, rootStat } = binding, root = hello.root;
  rootIdentity(root, rootStat);
  const journal = readRegular(path.join(root, ".journal"), LIMITS.journalBytes);
  const lines = journal.toString("utf8").split("\n"); check(lines.pop() === "", "PARTIAL_JOURNAL");
  check(lines.length === hello.recovery.journal_events, "JOURNAL_EVENT_COUNT");
  let previous = null, admitted = null, published = null, observed = false;
  const publications = new Set();
  for (let index = 0; index < lines.length; index++) {
    const event = JSON.parse(lines[index]);
    check(event.sequence === index + 1 && event.previous === previous, "JOURNAL_CHAIN");
    previous = digest(lines[index] + "\n");
    if (index === 0) check(event.state === "BOUND" && event.nonce === hello.nonce && event.synthetic === true
      && event.production_authority === false && event.budget === 3, "RECOVERY_BINDING");
    if (event.state === "PUBLISHED") publications.add(event.name);
    if (event.operation === hello.recovery.operation) {
      if (event.state === "ADMITTED") admitted = event;
      if (event.state === "PUBLISHED") published = event;
      if (["OBSERVED", "QUARANTINED_COMPLETION"].includes(event.state)) observed = true;
    }
  }
  check(admitted && published && !observed && publications.size === 3, "RECOVERY_HISTORY");
  for (const event of [admitted, published]) check(event.name === hello.recovery.name && event.size === hello.recovery.size
    && event.sha256 === hello.recovery.sha256, "RECOVERY_EXPECTATION");
  const files = fs.readdirSync(root).sort();
  check(files.every((name) => name === ".journal" || /^\.prep-[123]$/.test(name) || Object.hasOwn(CORPUS, name)), "UNEXPECTED_ENTRY");
  const partialPreparations = files.filter((name) => name.startsWith(".prep-"));
  const bytes = readRegular(path.join(root, hello.recovery.name), 6);
  check(bytes.length === hello.recovery.size && digest(bytes) === hello.recovery.sha256, "RECOVERY_DIGEST");
  // Read-only evidence does not rewrite history, issue a receipt, replay a write,
  // release budget, renew authority, steal a lock, or remove preparation files.
  return Object.freeze({ status: "UNKNOWN", observed_match: true, receipt_missing: true,
    physical_publications: publications.size, budget_released: 0, replayed: false,
    partial_preparations: partialPreparations, executable_success: false, production_authority: false,
    journal_sha256: digest(journal), name: hello.recovery.name, sha256: digest(bytes) });
}

module.exports = Object.freeze({ CORPUS, LIMITS, SOURCE_PATHS, digest, validateRequest, evaluateGate,
  validateHello, verifySupervisorBinding, openSupervisedGateway, reconcileSupervisedGateway });
