"use strict";

// Dedicated Stage A offline test. Source implementations are imported/compiled
// directly, never copied or rewritten. All outputs/caches stay under .agent/runtime.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const frame = require(path.join(root, "lib/coordination/permit-witness-v2-frame"));
const v1 = require(path.join(root, "lib/coordination/permit-witness-frame"));
const vectors = require("./fixtures/permit-witness-v2-cross-language/vectors.json");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const required = (process.env.PERMIT_WITNESS_REQUIRE_TOOLCHAINS || "").split(",").map(x => x.trim()).filter(Boolean);
const fixture = path.join(__dirname, "fixtures/permit-witness-v2-cross-language");
const sources = ["lib/coordination/permit-witness-frame.js", "lib/coordination/permit-witness-v2-frame.js",
  "packages/permit-witness-macos/Sources/WitnessTransport/TrustBoundary.swift",
  "packages/permit-witness-macos/Sources/WitnessTransport/V2Frame.swift",
  "packages/permit-witness-windows/src/Frames.cs", "packages/permit-witness-windows/src/V2Frames.cs"];
const sourceHashes = () => Object.fromEntries(sources.map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
function payload(row) {
  if (row.payload_hex !== undefined) return Buffer.from(row.payload_hex, "hex");
  const bytes = Buffer.alloc(row.payload_bytes, Buffer.from(row.payload_repeat_hex, "hex"));
  Buffer.from(row.payload_prefix_hex, "hex").copy(bytes); return bytes;
}
function options(row) {
  return { direction: row.direction, ...(row.direction === "response" ? {
    expectedOperation: row.operation ?? vectors.response_correlation.expected_operation,
    expectedRequestId: row.request_id ?? vectors.response_correlation.expected_request_id } : {}) };
}
function input(row, bytes) {
  return { direction: row.direction, operation: row.operation, requestId: row.request_id,
    payload: bytes, ...(row.direction === "response" ? { status: row.status } : {}) };
}
function batches(length, chunk) {
  return Array.from({ length: Math.ceil(length / chunk) }, (_, i) => Math.min(chunk, length - i * chunk));
}
function decodeJs(row) {
  const wire = fs.readFileSync(row.wire_path), decoder = new frame.FrameDecoder(options(row));
  let offset = 0;
  for (const size of row.batches) {
    const end = Math.min(offset + size, wire.length), result = decoder.append(wire.subarray(offset, end));
    if (result) {
      const f = result.frame;
      return { name: row.name, ok: true, operation: f.operation, id: f.requestId,
        payload_bytes: f.payload.length, payload_sha256: sha(f.payload),
        ...(f.direction === "response" ? { status: f.status } : {}),
        completion_offset: end, trailing_bytes: result.trailingBytes, unfed_bytes: wire.length - end };
    }
    offset = end;
  }
  return decoder.finish(); // JS provides a terminal truncation error; native fixtures do not.
}
function probe(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout: 15000 });
  return !result.error && result.status === 0 ? result.stdout.trim() : null;
}
function child(command, args, context, label) {
  const result = spawnSync(command, args, { cwd: root, env: context.env,
    encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const output = `${result.stdout || ""}${result.stderr || ""}${result.error || ""}`;
  fs.writeFileSync(path.join(context.run, `logs/${label}.log`), output);
  assert.equal(result.error, undefined, `${label}: ${output.slice(-3000)}`);
  assert.equal(result.status, 0, `${label}: ${output.slice(-3000)}`);
}
function setup() {
  const base = path.join(root, ".agent/runtime/permit-witness-v2-interop");
  fs.mkdirSync(base, { recursive: true });
  const run = fs.mkdtempSync(path.join(base, "run-"));
  const dirs = ["logs", "tmp", "dotnet-home", "nuget", "nuget-http", "nuget-plugins", "xdg-cache", "xdg-config", "swift-cache"];
  for (const dir of dirs) fs.mkdirSync(path.join(run, dir));
  const env = { ...process.env, TMPDIR: path.join(run, "tmp"), TMP: path.join(run, "tmp"), TEMP: path.join(run, "tmp"),
    DOTNET_CLI_HOME: path.join(run, "dotnet-home"), NUGET_PACKAGES: path.join(run, "nuget"),
    NUGET_HTTP_CACHE_PATH: path.join(run, "nuget-http"), NUGET_PLUGINS_CACHE_PATH: path.join(run, "nuget-plugins"),
    XDG_CACHE_HOME: path.join(run, "xdg-cache"), XDG_CONFIG_HOME: path.join(run, "xdg-config"),
    CLANG_MODULE_CACHE_PATH: path.join(run, "swift-cache"), DOTNET_GENERATE_ASPNET_CERTIFICATE: "false",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: "true", DOTNET_NOLOGO: "1" };
  const swift = process.platform === "darwin" && probe("xcrun", ["--find", "swiftc"], env);
  const dotnetVersion = probe("dotnet", ["--version"], env);
  const dotnet = dotnetVersion && Number(dotnetVersion.split(".")[0]) >= 10 ? dotnetVersion : null;
  return { run, env, available: { swift: swift || null, dotnet } };
}
function build(name, context) {
  if (name === "swift") {
    const executable = path.join(context.run, "swift-interop");
    child("xcrun", ["swiftc", "-swift-version", "6", "-warnings-as-errors", "-module-cache-path",
      path.join(context.run, "swift-cache"), ...sources.filter(file => file.endsWith(".swift")).map(file => path.join(root, file)),
      path.join(fixture, "Interop.swift"), "-o", executable], context, "swift-build");
    return { command: executable, args: [] };
  }
  const artifacts = path.join(context.run, "dotnet-artifacts");
  child("dotnet", ["build", path.join(fixture, "Interop.csproj"), "--artifacts-path", artifacts,
    "--configfile", path.join(root, "packages/permit-witness-windows/NuGet.Config"), "--disable-build-servers",
    "-p:NuGetAudit=false", "-p:UseSharedCompilation=false"], context, "dotnet-build");
  return { command: "dotnet", args: [path.join(artifacts, "bin/Interop/debug/Interop.dll")] };
}
function nativeCall(name, native, context, mode, rows) {
  const prefix = path.join(context.run, `${name}-${mode}`);
  fs.writeFileSync(`${prefix}-input.json`, JSON.stringify(rows));
  child(native.command, [...native.args, mode, `${prefix}-input.json`, `${prefix}-output.json`], context, `${name}-${mode}`);
  return JSON.parse(fs.readFileSync(`${prefix}-output.json`, "utf8"));
}

test("Stage A v2 fixed-vector interoperability (offline, no TLS acceptance)", { timeout: 360000 }, async t => {
  const context = setup(), { run, available } = context, before = sourceHashes();
  const report = { scope: "offline-framing-only", tls_verified: false, node: process.version,
    platform: process.platform, toolchains: available, fixture_sha256: sha(fs.readFileSync(path.join(fixture, "vectors.json"))),
    source_hashes_before: before, matrix: {}, positive_vectors: vectors.positive.length + vectors.boundary.length,
    negative_vectors: vectors.negative.length, trailing_vectors: vectors.trailing.length };
  t.after(() => {
    report.source_hashes_after = sourceHashes();
    fs.writeFileSync(path.join(run, "summary.json"), JSON.stringify(report, null, 2) + "\n");
  });
  t.diagnostic(`retained offline fixtures, logs, binaries and summary: ${run}`);
  t.diagnostic(`toolchains: ${JSON.stringify(available)}`);
  await t.test("required toolchains and vector coverage", () => {
    for (const name of required) {
      assert.ok(["swift", "dotnet"].includes(name), `unknown toolchain ${name}`);
      assert.ok(available[name], `required ${name} toolchain unavailable`);
    }
    assert.deepEqual(new Set(vectors.positive.map(row => row.operation)), new Set([1, 2]));
    assert.deepEqual(new Set(vectors.positive.filter(row => row.direction === "response").map(row => row.status)), new Set([0, 1, 2, 3]));
    assert.deepEqual(new Set(vectors.boundary.map(row => row.direction)), new Set(["request", "response"]));
    assert.ok(vectors.boundary.every(row => row.payload_bytes === frame.LIMITS.payloadBytes));
    for (const direction of ["request", "response"]) {
      assert.ok(vectors.negative.some(row => row.name === `${direction}-version-1`));
      assert.ok(vectors.negative.some(row => row.name === `${direction}-length-4294967295`));
    }
  });
  const rows = [...vectors.positive, ...vectors.boundary].map((row, i) => {
    const bytes = payload(row), payloadPath = path.join(run, `payload-${i}.bin`);
    assert.equal(bytes.length, row.payload_bytes); assert.equal(sha(bytes), row.payload_sha256);
    fs.writeFileSync(payloadPath, bytes);
    return { ...row, payload_path: payloadPath };
  });
  const rejectedEncode = [];
  for (const row of rows.filter(row => row.payload_bytes === frame.LIMITS.payloadBytes)) {
    for (const size of [0, frame.LIMITS.payloadBytes + 1]) {
      const name = `${row.direction}-encode-size-${size}`, payloadPath = path.join(run, `${name}.bin`);
      fs.writeFileSync(payloadPath, Buffer.alloc(size, 0x7b));
      rejectedEncode.push({ ...row, name, payload_path: payloadPath, output_path: path.join(run, `${name}-unexpected.bin`) });
    }
  }
  const wires = { js: [] }, natives = {};
  function verifyEncoded(bytes, row) {
    assert.equal(bytes[4], 2, row.name); assert.equal(bytes.length, row.wire_bytes, row.name);
    assert.equal(bytes.readUInt32BE(), row.length, row.name);
    assert.equal(bytes.subarray(0, 22).toString("hex"), row.header_hex, row.name);
    assert.equal(sha(bytes), row.wire_sha256, row.name);
    if (row.wire_hex !== undefined) assert.equal(bytes.toString("hex"), row.wire_hex, row.name);
  }
  await t.test("JS matches independent fixed bytes; empty and maximum+1 encodes fail", () => {
    for (const [i, row] of rows.entries()) {
      const bytes = frame.encodeFrame(input(row, payload(row))); verifyEncoded(bytes, row);
      const file = path.join(run, `js-${i}.bin`); fs.writeFileSync(file, bytes); wires.js.push(file);
    }
    for (const row of rejectedEncode) assert.throws(() => frame.encodeFrame(input(row, fs.readFileSync(row.payload_path))));
  });
  for (const name of ["swift", "dotnet"]) {
    await t.test(`${name} builds actual v2 codec and matches fixed encodings`,
      { skip: !available[name] && `${name} toolchain unavailable` }, () => {
        const native = build(name, context);
        const encoding = rows.map((row, i) => ({ ...row, output_path: path.join(run, `${name}-${i}.bin`) }));
        const results = nativeCall(name, native, context, "encode", [...encoding, ...rejectedEncode]);
        assert.equal(results.length, encoding.length + rejectedEncode.length);
        for (const [i, row] of encoding.entries()) {
          assert.deepEqual(results[i], { name: row.name, ok: true });
          verifyEncoded(fs.readFileSync(row.output_path), row);
          assert.deepEqual(fs.readFileSync(row.output_path), fs.readFileSync(wires.js[i]));
        }
        for (const [i, row] of rejectedEncode.entries()) {
          assert.equal(results[encoding.length + i].name, row.name);
          assert.equal(results[encoding.length + i].ok, false, row.name);
          assert.equal(fs.existsSync(row.output_path), false, "invalid encode must not write bytes");
        }
        natives[name] = native; wires[name] = encoding.map(row => row.output_path);
      });
  }
  const decodeRows = [];
  for (const [source, files] of Object.entries(wires)) for (const [i, wirePath] of files.entries()) {
    const row = rows[i], length = row.wire_bytes;
    const schedules = row.payload_bytes === frame.LIMITS.payloadBytes
      ? [[length], batches(length, 8192), batches(length, 65536)]
      : [[length], batches(length, 1), batches(length, 3),
        ...Array.from({ length }, (_, split) => [split, length - split])];
    for (const [schedule, parts] of schedules.entries()) decodeRows.push({ ...row,
      name: `${source}/${row.name}/schedule-${schedule}`, source, wire_path: wirePath, batches: parts,
      expected: { operation: row.operation, id: row.request_id, payload_bytes: row.payload_bytes,
        payload_sha256: row.payload_sha256, ...(row.direction === "response" ? { status: row.status } : {}),
        completion_offset: length, trailing_bytes: 0, unfed_bytes: 0 } });
  }
  const negativeRows = vectors.negative.flatMap((row, i) => {
    const bytes = Buffer.from(row.wire_hex, "hex"), file = path.join(run, `negative-${i}.bin`);
    fs.writeFileSync(file, bytes);
    return [1, 3, 65536].map(chunk => ({ ...row, name: `${row.name}/chunk-${chunk}`,
      wire_path: file, batches: batches(bytes.length, chunk) }));
  });
  const trailingRows = vectors.trailing.flatMap((row, i) => {
    const file = path.join(run, `trailing-${i}.bin`), bytes = Buffer.from(row.wire_hex, "hex");
    fs.writeFileSync(file, bytes);
    const first = frame.decodeFrame(Buffer.from(row.first_wire_hex, "hex"), options(row));
    return [[bytes.length], [row.first_wire_bytes - 1, row.trailing_bytes + 1],
      [row.first_wire_bytes, row.trailing_bytes]].map((parts, mode) => ({ ...row,
      name: `${row.name}/mode-${mode}`, wire_path: file, batches: parts,
      expected: { operation: first.operation, id: first.requestId, payload_bytes: first.payload.length,
        payload_sha256: sha(first.payload), ...(row.direction === "response" ? { status: first.status } : {}),
        completion_offset: mode === 2 ? row.first_wire_bytes : bytes.length,
        trailing_bytes: mode === 2 ? 0 : row.trailing_bytes, unfed_bytes: mode === 2 ? row.trailing_bytes : 0 } }));
  });
  function checkPositive(actual, row) {
    const { name, ok, ...summary } = actual;
    assert.equal(name, row.name); assert.equal(ok, true, `${row.name}: ${JSON.stringify(actual)}`);
    assert.deepEqual(summary, row.expected, row.name);
  }
  await t.test("JS decodes every encoder before EOF, all splits and tails; rejects shared negatives", () => {
    for (const row of [...decodeRows, ...trailingRows]) checkPositive(decodeJs(row), row);
    for (const row of negativeRows) assert.throws(() => decodeJs(row), {
      code: `ERR_WITNESS_FRAME_${row.expected.toUpperCase()}` }, row.name);
    for (const row of vectors.trailing) assert.throws(() => frame.decodeFrame(Buffer.from(row.wire_hex, "hex"), options(row)));
    for (const row of rows) assert.throws(() => v1.decodeFrame(fs.readFileSync(wires.js[rows.indexOf(row)]), options(row)),
      undefined, "v1 must not accept v2");
    for (const source of Object.keys(wires)) report.matrix[`${source}->js`] = decodeRows.filter(row => row.source === source).length;
  });
  for (const name of ["swift", "dotnet"]) {
    await t.test(`${name} decodes every encoder before EOF, all splits and tails; rejects shared negatives`,
      { skip: !available[name] && `${name} toolchain unavailable` }, () => {
        assert.ok(natives[name], `${name} build failed`);
        const all = [...decodeRows, ...trailingRows, ...negativeRows];
        const results = nativeCall(name, natives[name], context, "decode", all);
        assert.equal(results.length, all.length);
        for (let i = 0; i < decodeRows.length + trailingRows.length; i++) checkPositive(results[i], all[i]);
        for (let i = decodeRows.length + trailingRows.length; i < all.length; i++) {
          const row = all[i], actual = results[i], truncated = row.expected === "truncated";
          assert.deepEqual(actual, { name: row.name, ok: false,
            error: truncated ? "truncated" : name === "dotnet" ? "protocol" : row.expected,
            origin: truncated ? "fixture" : "codec" }, row.name);
        }
        for (const source of Object.keys(wires)) report.matrix[`${source}->${name}`] = decodeRows.filter(row => row.source === source).length;
      });
  }
  await t.test("implementation sources stayed unchanged during this run", () => assert.deepEqual(sourceHashes(), before));
  report.positive_decode_cases_per_language = decodeRows.length;
  report.negative_cases_per_language = negativeRows.length;
  report.trailing_cases_per_language = trailingRows.length;
  report.scope_notes = ["Native truncated=fixture observation, not decoder-thrown rejection.",
    ".NET exact tail length is fixture accounting; codec supplies a checked Trailing boolean.",
    "No native response correlation/payload policy or exchange/commit/TLS acceptance is inferred.",
    "unfed_bytes are future deliveries: the owner, not this codec harness, handles late input."];
});
