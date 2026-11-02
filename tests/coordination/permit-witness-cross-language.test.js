"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

// Offline framing interoperability only: no certificates, native TLS, sockets,
// witness authorization, or production startup. All generated files are under
// .agent/runtime. On macOS this can run all six directions; Windows can run
// JS/C# without Swift. Set PERMIT_WITNESS_REQUIRE_TOOLCHAINS=dotnet on Windows
// or =swift,dotnet on macOS to make missing toolchains fail a dedicated CI job.
// A missing optional toolchain is always an explicit node:test skip.
// Temporary files are removed after the test to support strict hermetic runs;
// set PERMIT_WITNESS_KEEP_ARTIFACTS=1 to retain the isolated logs and binaries.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const frames = require("../../lib/coordination/permit-witness-frame");
const vectors = require("./fixtures/permit-witness-frames.json");

const root = path.resolve(__dirname, "../..");
const fixture = path.join(__dirname, "fixtures/permit-witness-cross-language");
const runtimeBase = testRuntime("permit-witness-cross-language");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const chunks = [1, 3, 16384];
const required = (process.env.PERMIT_WITNESS_REQUIRE_TOOLCHAINS || "").split(",").map(x => x.trim()).filter(Boolean);

function payload(vector) {
  if (vector.payload_hex !== undefined) return Buffer.from(vector.payload_hex, "hex");
  const result = Buffer.alloc(vector.payload_bytes, Buffer.from(vector.payload_repeat_hex, "hex"));
  Buffer.from(vector.payload_prefix_hex || "", "hex").copy(result);
  return result;
}

function input(vector, data) {
  return { direction: vector.direction, operation: vector.operation, requestId: vector.request_id, payload: data,
    ...(vector.direction === "response" ? { status: vector.status } : {}) };
}

function options(direction, operation = vectors.response_correlation.expected_operation,
  id = vectors.response_correlation.expected_request_id) {
  return direction === "request" ? { direction } : { direction, expectedOperation: operation, expectedRequestId: id };
}

function decodeJs(wire, row) {
  const decoder = new frames.FrameDecoder(options(row.direction, row.expected_operation, row.expected_id));
  for (let offset = 0; offset < wire.length; offset += row.chunk) decoder.append(wire.subarray(offset, offset + row.chunk));
  const frame = decoder.finish();
  return { name: row.name, ok: true, operation: frame.operation, id: frame.requestId,
    payload_bytes: frame.payload.length, payload_sha256: hash(frame.payload),
    ...(frame.direction === "response" ? { status: frame.status } : {}) };
}

function child(command, args, env, log, timeout = 120000) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 });
  fs.writeFileSync(log, `${result.stdout || ""}${result.stderr || ""}${result.error ? `\n${result.error}\n` : ""}`);
  const detail = `${result.stdout || ""}${result.stderr || ""}`.slice(-4000);
  assert.equal(result.error, undefined, `${command} could not run: ${result.error}; ${detail}`);
  assert.equal(result.status, 0, `${command} exited ${result.status}: ${detail}`);
  return result.stdout;
}

function commandExists(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout: 15000 });
  return result.error || result.status !== 0 ? null : result.stdout.trim();
}

function setup() {
  fs.mkdirSync(runtimeBase, { recursive: true });
  const run = fs.mkdtempSync(path.join(runtimeBase, "run-"));
  for (const dir of ["tmp", "logs", "dotnet-home", "nuget", "nuget-http", "nuget-plugins", "xdg-cache", "xdg-config", "swift-cache"]) {
    fs.mkdirSync(path.join(run, dir));
  }
  const env = { ...process.env, TMPDIR: path.join(run, "tmp"), TMP: path.join(run, "tmp"), TEMP: path.join(run, "tmp"),
    DOTNET_CLI_HOME: path.join(run, "dotnet-home"), NUGET_PACKAGES: path.join(run, "nuget"),
    NUGET_HTTP_CACHE_PATH: path.join(run, "nuget-http"), NUGET_PLUGINS_CACHE_PATH: path.join(run, "nuget-plugins"),
    XDG_CACHE_HOME: path.join(run, "xdg-cache"), XDG_CONFIG_HOME: path.join(run, "xdg-config"),
    CLANG_MODULE_CACHE_PATH: path.join(run, "swift-cache"), DOTNET_GENERATE_ASPNET_CERTIFICATE: "false",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: "true", DOTNET_NOLOGO: "1" };
  const swift = process.platform === "darwin" && commandExists("xcrun", ["--find", "swiftc"], env);
  const dotnetVersion = commandExists("dotnet", ["--version"], env);
  const dotnet = dotnetVersion && Number(dotnetVersion.split(".")[0]) >= 10 ? dotnetVersion : null;
  return { run, env, available: { swift: swift || null, dotnet } };
}

function buildNative(name, context) {
  const { run, env } = context;
  if (name === "swift") {
    const source = path.join(root, "packages/permit-witness-macos/Sources/WitnessTransport");
    const executable = path.join(run, "swift-interop");
    child("xcrun", ["swiftc", "-swift-version", "6", "-module-cache-path", path.join(run, "swift-cache"),
      ...["BoundedIPC.swift", "Exchange.swift", "NativeTLS.swift", "TrustBoundary.swift"].map(file => path.join(source, file)),
      path.join(fixture, "Interop.swift"), "-o", executable], env, path.join(run, "logs/swift-build.log"));
    return { command: executable, args: [] };
  }
  const artifacts = path.join(run, "dotnet-artifacts");
  child("dotnet", ["build", path.join(fixture, "Interop.csproj"), "--artifacts-path", artifacts,
    "--configfile", path.join(root, "packages/permit-witness-windows/NuGet.Config"), "--disable-build-servers",
    "-p:NuGetAudit=false", "-p:UseSharedCompilation=false"], env, path.join(run, "logs/dotnet-build.log"));
  return { command: "dotnet", args: [path.join(artifacts, "bin/Interop/debug/Interop.dll")] };
}

function nativeCall(name, native, context, mode, rows) {
  const prefix = path.join(context.run, `${name}-${mode}`);
  fs.writeFileSync(`${prefix}-input.json`, JSON.stringify(rows));
  child(native.command, [...native.args, mode, `${prefix}-input.json`, `${prefix}-output.json`], context.env,
    path.join(context.run, `logs/${name}-${mode}.log`));
  return JSON.parse(fs.readFileSync(`${prefix}-output.json`, "utf8"));
}

test("shared witness framing across available languages (offline; not mTLS)", { timeout: 360000 }, async t => {
  const context = setup();
  const { run, available } = context;
  const keep = process.env.PERMIT_WITNESS_KEEP_ARTIFACTS === "1";
  t.after(() => { if (!keep) fs.rmSync(run, { recursive: true, force: true }); });
  t.diagnostic(`framing fixtures and logs: ${run} (${keep ? "retained" : "removed after test"})`);
  t.diagnostic(`toolchains: swift=${available.swift || "unavailable"}; dotnet=${available.dotnet || "unavailable"}`);

  await t.test("required toolchains are present", () => {
    for (const name of required) {
      assert.ok(["swift", "dotnet"].includes(name), `unknown required toolchain: ${name}`);
      assert.ok(available[name], `required ${name} toolchain is unavailable on ${process.platform}`);
    }
  });

  const positive = [...vectors.positive, ...vectors.boundary];
  await t.test("shared fixture contains both directions, limits, and EOF regressions", () => {
    assert.deepEqual(new Set(vectors.boundary.map(row => row.direction)), new Set(["request", "response"]));
    assert.ok(vectors.boundary.every(row => row.payload_bytes === frames.LIMITS.payloadBytes));
    assert.deepEqual(new Set(vectors.positive.map(row => row.operation)), new Set([1, 2]));
    assert.deepEqual(new Set(vectors.positive.filter(row => row.direction === "response").map(row => row.status)), new Set([0, 1, 2, 3]));
    const names = new Set(vectors.negative.map(row => row.name));
    for (const name of ["eof-at-0", "eof-at-23", "request-trailing-byte", "request-two-frames",
      "response-trailing-byte", "response-two-frames", "request-response-only-capacity", "response-over-capacity"]) {
      assert.ok(names.has(name), `missing shared negative vector: ${name}`);
    }
  });
  const rows = positive.map((vector, index) => {
    const bytes = payload(vector);
    const payloadPath = path.join(run, `payload-${index}.bin`);
    fs.writeFileSync(payloadPath, bytes);
    return { ...vector, payload_path: payloadPath, expected: { operation: vector.operation, id: vector.request_id,
      payload_bytes: bytes.length, payload_sha256: hash(bytes), ...(vector.direction === "response" ? { status: vector.status } : {}) } };
  });
  const wires = { js: [] };
  await t.test("JS encodes shared fixed bytes and directional maxima", () => {
    for (const [index, row] of rows.entries()) {
      const bytes = fs.readFileSync(row.payload_path);
      const wire = frames.encodeFrame(input(row, bytes));
      assert.equal(hash(wire), row.wire_sha256, row.name);
      if (row.wire_hex) assert.equal(wire.toString("hex"), row.wire_hex, row.name);
      if (row.wire_bytes) assert.equal(wire.length, row.wire_bytes, row.name);
      const wirePath = path.join(run, `js-${index}.bin`);
      fs.writeFileSync(wirePath, wire);
      wires.js.push(wirePath);
    }
    for (const row of rows.filter(row => row.payload_bytes === frames.LIMITS.payloadBytes)) {
      assert.throws(() => frames.encodeFrame(input(row, Buffer.concat([fs.readFileSync(row.payload_path), Buffer.from([0])]))));
    }
  });

  const natives = {};
  for (const name of ["swift", "dotnet"]) {
    await t.test(`${name} build and encode shared vectors`, { skip: !available[name] && `${name} toolchain unavailable` }, () => {
      const native = buildNative(name, context);
      const encoding = rows.map((row, index) => ({ ...row, output_path: path.join(run, `${name}-${index}.bin`) }));
      const tooLarge = rows.filter(row => row.payload_bytes === frames.LIMITS.payloadBytes).map((row, index) => {
        const tooLargePath = path.join(run, `${name}-oversize-${index}.bin`);
        fs.writeFileSync(tooLargePath, Buffer.concat([fs.readFileSync(row.payload_path), Buffer.from([0])]));
        return { ...row, name: `${row.name}-plus-one`, payload_path: tooLargePath, output_path: path.join(run, `${name}-unexpected-${index}.bin`) };
      });
      const results = nativeCall(name, native, context, "encode", [...encoding, ...tooLarge]);
      assert.equal(results.length, encoding.length + tooLarge.length);
      for (const [index, row] of encoding.entries()) {
        assert.equal(results[index].name, row.name);
        assert.equal(results[index].ok, true, row.name);
        assert.equal(hash(fs.readFileSync(row.output_path)), row.wire_sha256, row.name);
        assert.deepEqual(fs.readFileSync(row.output_path), fs.readFileSync(wires.js[index]), row.name);
      }
      for (const result of results.slice(encoding.length)) assert.equal(result.ok, false, result.name);
      natives[name] = native;
      wires[name] = encoding.map(row => row.output_path);
    });
  }

  const decodeRows = [];
  for (const [source, paths] of Object.entries(wires)) {
    for (const [index, wirePath] of paths.entries()) {
      const row = rows[index];
      for (const chunk of (row.payload_bytes === frames.LIMITS.payloadBytes ? [16384] : chunks)) {
        decodeRows.push({ name: `${source}/${row.name}/${chunk}`, source, direction: row.direction, wire_path: wirePath, chunk,
          expected_operation: row.operation, expected_id: row.request_id, expected: row.expected });
      }
    }
  }
  const negativeRows = [];
  for (const [index, vector] of vectors.negative.entries()) {
    const wirePath = path.join(run, `negative-${index}.bin`);
    fs.writeFileSync(wirePath, Buffer.from(vector.wire_hex, "hex"));
    for (const chunk of chunks) negativeRows.push({ name: `${vector.name}/${chunk}`, direction: vector.direction,
      wire_path: wirePath, chunk, expected_operation: vectors.response_correlation.expected_operation,
      expected_id: vectors.response_correlation.expected_request_id });
  }

  await t.test("JS decodes each available encoder and rejects shared negatives", () => {
    for (const row of decodeRows) {
      const actual = decodeJs(fs.readFileSync(row.wire_path), row);
      const { name, ok, ...value } = actual;
      assert.equal(ok, true, name);
      assert.deepEqual(value, row.expected, name);
    }
    for (const row of negativeRows) assert.throws(() => decodeJs(fs.readFileSync(row.wire_path), row), undefined, row.name);
    const decoder = new frames.FrameDecoder(options("response"));
    assert.equal(decoder.append(fs.readFileSync(wires.js[2])), undefined, "no result before EOF");
  });

  for (const name of ["swift", "dotnet"]) {
    await t.test(`${name} decodes each encoder and rejects shared EOF, trailing and chunked negatives`,
      { skip: !available[name] && `${name} toolchain unavailable` }, () => {
        assert.ok(natives[name], `${name} build did not succeed`);
        const results = nativeCall(name, natives[name], context, "decode", [...decodeRows, ...negativeRows]);
        assert.equal(results.length, decodeRows.length + negativeRows.length);
        const failures = [];
        for (const [index, row] of decodeRows.entries()) {
          const { name: resultName, ok, remaining, ...value } = results[index];
          try { assert.equal(resultName, row.name); assert.equal(ok, true); assert.deepEqual(value, row.expected); assert.equal(remaining ?? 0, 0); }
          catch { failures.push(`${row.name}: ${JSON.stringify(results[index])}`); }
        }
        for (const [index, row] of negativeRows.entries()) {
          const actual = results[decodeRows.length + index];
          if (actual.name !== row.name || actual.ok || actual.error !== "protocol") failures.push(`${row.name}: ${JSON.stringify(actual)}`);
        }
        assert.deepEqual(failures, [], `${name} violated shared vector expectations`);
      });
  }

  for (const name of ["swift", "dotnet"]) {
    await t.test(`${name} response waits for EOF under a deadline`, { skip: !available[name] && `${name} toolchain unavailable` }, () => {
      assert.ok(natives[name], `${name} build did not succeed`);
      const row = decodeRows.find(row => row.source === "js" && row.direction === "response" && row.chunk === 3);
      const [actual] = nativeCall(name, natives[name], context, "stall-response", [{ ...row, name: "response-without-eof", stall: true }]);
      assert.equal(actual.ok, false);
      assert.equal(actual.error, "timeout");
    });
  }
  await t.test("dotnet request waits for EOF under a deadline", { skip: !available.dotnet && "dotnet toolchain unavailable" }, () => {
    assert.ok(natives.dotnet, "dotnet build did not succeed");
    const row = decodeRows.find(row => row.source === "js" && row.direction === "request" && row.chunk === 3);
    const [actual] = nativeCall("dotnet", natives.dotnet, context, "stall-request", [{ ...row, name: "request-without-eof", stall: true }]);
    assert.equal(actual.ok, false, `request returned before EOF: ${JSON.stringify(actual)}`);
    assert.equal(actual.error, "timeout");
  });
  t.diagnostic("Swift request FrameDecoder has no EOF/finish API; its fixture supplies EOF and checks incomplete data. No request-side host is proven.");
});
