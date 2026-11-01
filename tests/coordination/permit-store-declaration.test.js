"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { parsePermitStoreDeclaration: parse, LIMITS, PermitStoreDeclarationError } = require("../../lib/coordination/permit-store-declaration");

// Entirely synthetic identities/URIs. No real project path or SQLite fixture.
function store(suffix = "a") {
  return { binding_id: "store-" + suffix, backend: "protected-permit-store", mode: "ordinary",
    database_ref: { kind: "machine-binding", binding_id: "db-" + suffix }, anchor_binding_id: "anchor-" + suffix,
    deployment_binding_id: "service-" + suffix, expected_decision_id: "D-existing", expected_store_id: "persisted-" + suffix,
    migration_policy: "automatic-when-proven" };
}
function declaration() { return { format_version: 1, project_id: "project-a", revision: 7, stores: [store()] }; }
const encode = value => JSON.stringify(value);
function accepted(value = declaration()) { return parse(encode(value), "project-a"); }
function rejected(input, code) {
  assert.throws(() => parse(input, "project-a"), error => {
    assert.ok(error instanceof PermitStoreDeclarationError);
    assert.match(error.code, /^ERR_PERMIT_DECLARATION_/);
    if (code) assert.equal(error.code, code);
    // Do not echo declarations or possibly secret-bearing invalid fields.
    assert.equal(error.message, error.code);
    return true;
  });
}

test("independent canonical JSON and domain-separated SHA256 fixed vector", () => {
  const expected = '{"format_version":1,"project_id":"project-a","revision":7,"stores":[{"anchor_binding_id":"anchor-a","backend":"protected-permit-store","binding_id":"store-a","database_ref":{"binding_id":"db-a","kind":"machine-binding"},"deployment_binding_id":"service-a","expected_decision_id":"D-existing","expected_store_id":"persisted-a","migration_policy":"automatic-when-proven","mode":"ordinary"}]}';
  const result = accepted();
  assert.equal(result.canonicalJson, expected);
  // Independently calculated with Python hashlib, not the implementation.
  assert.equal(result.digest, "77ee4e443c7aae7a3ee9dc08a4b628dea8a4f80cd9793e501d69afce72ee6b44");
  assert.equal(parse(Buffer.from(encode(declaration())), "project-a").digest, result.digest);
  const reordered = Object.fromEntries(Object.entries(declaration()).reverse());
  reordered.stores = [Object.fromEntries(Object.entries(store()).reverse())];
  assert.equal(parse(" \r\n" + JSON.stringify(reordered, null, 2) + "\t", "project-a").canonicalJson, expected);
  assert.equal(Object.getPrototypeOf(result.snapshot), null);
  assert.equal(Object.getPrototypeOf(result.snapshot.stores[0].database_ref), null);
});

test("all returned data deeply freezes and is independent of input bytes", () => {
  const input = Buffer.from(encode(declaration())), result = parse(input, "project-a");
  input.fill(32);
  function frozen(value) {
    if (value && typeof value === "object") { assert.equal(Object.isFrozen(value), true); Object.values(value).forEach(frozen); }
  }
  frozen(result);
  assert.throws(() => { result.snapshot.stores[0].database_ref.binding_id = "replacement"; }, TypeError);
  assert.throws(() => result.snapshot.stores.push(store("b")), TypeError);
  assert.equal(result.snapshot.stores[0].database_ref.binding_id, "db-a");
  assert.deepEqual(Object.keys(result).sort(), ["canonicalJson", "digest", "snapshot"]);
});

test("store ordering canonicalizes; revision/identity/reference changes remain distinct", () => {
  const a = declaration(); a.stores.push(store("b"));
  const b = declaration(); b.stores.unshift(store("b"));
  assert.equal(accepted(a).digest, accepted(b).digest);
  assert.deepEqual(accepted(b).snapshot.stores.map(item => item.binding_id), ["store-a", "store-b"]);
  const original = accepted().digest;
  for (const change of [value => value.revision++, value => { value.stores[0].expected_decision_id = "D-other"; },
    value => { value.stores[0].expected_store_id = "persisted-other"; },
    value => { value.stores[0].database_ref = { kind: "project-logical", uri: "runtime://coordination/permit/primary/state.sqlite" }; }]) {
    const value = declaration(); change(value); assert.notEqual(accepted(value).digest, original);
  }
});

test("project identity and caller lower revision bound are mandatory and exact", () => {
  const input = encode(declaration());
  for (const project of [undefined, null, {}, "", "project-b", "project-a "]) assert.throws(() => parse(input, project), PermitStoreDeclarationError);
  assert.equal(parse(input, "project-a", 7).snapshot.revision, 7);
  assert.throws(() => parse(input, "project-a", 8), { code: "ERR_PERMIT_DECLARATION_REVISION" });
  for (const minimum of [0, -1, -0, 1.5, NaN, Infinity, "1", {}, 9007199254740992]) assert.throws(() => parse(input, "project-a", minimum), PermitStoreDeclarationError);
  const value = declaration(); value.revision = Number.MAX_SAFE_INTEGER;
  assert.equal(accepted(value).snapshot.revision, Number.MAX_SAFE_INTEGER);
});

test("missing is always an error, and an empty parsed list makes no discovery decision", () => {
  for (const input of [undefined, null, "", Buffer.alloc(0)]) rejected(input);
  const value = declaration(); value.stores = [];
  const result = accepted(value); assert.deepEqual(result.snapshot.stores, []);
  assert.equal(Object.hasOwn(result, "status"), false);
  assert.equal(result.canonicalJson.includes("not-configured"), false);
});

for (const location of ["root", "store", "ref"]) {
  test(`duplicate raw and escaped keys rejected at ${location}`, () => {
    const text = encode(declaration());
    const key = location === "root" ? "revision" : location === "store" ? "binding_id" : "kind";
    const original = location === "root" ? '"revision":7' : location === "store" ? '"binding_id":"store-a"' : '"kind":"machine-binding"';
    const value = location === "root" ? "7" : location === "store" ? '"store-a"' : '"machine-binding"';
    for (const alias of [JSON.stringify(key), '"\\u' + key.charCodeAt(0).toString(16).padStart(4, "0") + key.slice(1) + '"']) {
      rejected(text.replace(original, original + "," + alias + ":" + value), "ERR_PERMIT_DECLARATION_DUPLICATE_KEY");
    }
  });
}

for (const input of ["{", "[]", "null", "true", "false", "1", '"text"', "{} {}", "/* comment */{}", "{\"a\":1,}",
  "[1,]", "{a:1}", '{"a":undefined}', '{"a":NaN}', '{"a":Infinity}', '{"a":"\u0000"}', '{"a":"\\x41"}', '{"a":01}',
  '\ufeff{"format_version":1}', '{}\v', '{"a":"unterminated}', '{"a":}', '{"a":trueX}']) {
  test(`reject invalid/schema JSON input ${JSON.stringify(input).slice(0, 55)}`, () => rejected(input));
}

for (const token of ["-0", "0", "-1", "1.5", "7.0000000000000001", "7e0", "1e309", "9007199254740992", "9007199254740993"]) {
  test(`revision rejects ambiguous/invalid integer token ${token}`, () => rejected(encode(declaration()).replace('"revision":7', '"revision":' + token)));
}

test("non-UTF8, BOM and lone surrogates reject without replacement decoding", () => {
  for (const bytes of [[0xff], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) rejected(Buffer.from(bytes), "ERR_PERMIT_DECLARATION_UTF8");
  rejected(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(encode(declaration()))]), "ERR_PERMIT_DECLARATION_JSON");
  for (const input of ['"\ud800"', '{"\\ud800":0}', '{"x":"\\udc00"}', '{"x":"\\ud800x"}']) rejected(input, "ERR_PERMIT_DECLARATION_UTF8");
});

test("byte limit exact boundary and rejection before unbounded decode", () => {
  const text = encode(declaration()), padded = text + " ".repeat(LIMITS.bytes - Buffer.byteLength(text));
  assert.equal(parse(padded, "project-a").digest, accepted().digest);
  assert.equal(parse(Buffer.from(padded), "project-a").digest, accepted().digest);
  rejected(padded + " ", "ERR_PERMIT_DECLARATION_LIMIT");
  rejected(Buffer.alloc(LIMITS.bytes + 1, 32), "ERR_PERMIT_DECLARATION_LIMIT");
  rejected("é".repeat(LIMITS.bytes / 2 + 1), "ERR_PERMIT_DECLARATION_LIMIT");
});

test("bounded depth and node count fail deterministically, not RangeError", () => {
  for (const input of ["[".repeat(10000) + "0" + "]".repeat(10000), "[" + "0,".repeat(LIMITS.nodes) + "0]"]) rejected(input, "ERR_PERMIT_DECLARATION_LIMIT");
  const nested = declaration(); nested.stores[0].database_ref = { kind: "machine-binding", binding_id: { a: { b: { c: { d: { e: {} } } } } } };
  rejected(encode(nested), "ERR_PERMIT_DECLARATION_LIMIT");
});

test("object/prototype/accessor/cycle/Proxy inputs never execute caller code", () => {
  let calls = 0;
  const trap = () => { calls++; throw Error("input executed"); };
  const accessor = Object.defineProperty({}, "format_version", { get: trap });
  const toJSON = { toJSON: trap }, cycle = {}; cycle.self = cycle;
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  const bufferProxy = new Proxy(Buffer.from(encode(declaration())), { get: trap, ownKeys: trap, getPrototypeOf: trap });
  for (const input of [declaration(), Object.create(null), Object.create({ inherited: true }), accessor, toJSON, cycle,
    proxy, revoked.proxy, bufferProxy, Object(encode(declaration())), new Uint8Array([123, 125]), Object.create(Buffer.prototype), () => trap()]) rejected(input, "ERR_PERMIT_DECLARATION_INPUT");
  for (const key of ["toJSON", "length", "constructor", "buffer"]) {
    const buffer = Buffer.from(encode(declaration())); Object.defineProperty(buffer, key, { get: trap });
    assert.equal(parse(buffer, "project-a").digest, accepted().digest);
  }
  const symbol = Buffer.from(encode(declaration())); symbol[Symbol("hidden")] = 1;
  assert.equal(parse(symbol, "project-a").digest, accepted().digest);
  const shared = Buffer.from(new SharedArrayBuffer(8)); rejected(shared, "ERR_PERMIT_DECLARATION_INPUT");
  assert.equal(calls, 0);
});

for (const location of ["root", "store", "ref"]) {
  test(`closed schema rejects credentials, overrides and prototype fields at ${location}`, () => {
    for (const key of ["path", "file", "anchorDir", "password", "privateKey", "provider", "signer", "code", "authority", "__proto__", "constructor", "prototype"]) {
      const value = declaration(), target = location === "root" ? value : location === "store" ? value.stores[0] : value.stores[0].database_ref;
      Object.defineProperty(target, key, { value: "synthetic forbidden input", enumerable: true }); rejected(encode(value));
    }
  });
}

test("required fields cannot be missing or substituted with wrong JSON types", () => {
  for (const location of ["root", "store", "ref"]) {
    const base = declaration(), target = location === "root" ? base : location === "store" ? base.stores[0] : base.stores[0].database_ref;
    for (const key of Object.keys(target)) {
      const value = declaration(), copy = location === "root" ? value : location === "store" ? value.stores[0] : value.stores[0].database_ref;
      delete copy[key]; rejected(encode(value));
      // All scalar fields reject non-scalar data; object/array fields reject
      // primitives. Keep the valid stores:[] case separately explicit.
      const invalid = key === "stores" || key === "database_ref" ? [null, false, 1, "value"] : [null, [], {}, false];
      for (const replacement of invalid) {
        const changed = declaration(), subject = location === "root" ? changed : location === "store" ? changed.stores[0] : changed.stores[0].database_ref;
        subject[key] = replacement; rejected(encode(changed));
      }
    }
  }
  for (const value of [null, "stores", {}, true, 1]) { const declarationValue = declaration(); declarationValue.stores = value; rejected(encode(declarationValue)); }
});

test("backend/mode/policy/version enums are closed, no production or schema3 enablement", () => {
  for (const [field, values] of [["backend", ["sqlite", "development-witness", "protected-pin-store"]],
    ["mode", ["development-only", "authority", "production", "ordinary "]], ["migration_policy", ["force", "manual", "skip", "automatic"]]]) {
    for (const item of values) { const value = declaration(); value.stores[0][field] = item; rejected(encode(value)); }
  }
  for (const version of [0, 2, "1", null]) { const value = declaration(); value.format_version = version; rejected(encode(value), "ERR_PERMIT_DECLARATION_VERSION"); }
});

test("project-logical and machine-binding are exclusive alternatives", () => {
  const good = declaration(); good.stores[0].database_ref = { kind: "project-logical", uri: "runtime://coordination/permit/primary/state.sqlite" };
  assert.equal(accepted(good).snapshot.stores[0].database_ref.uri, good.stores[0].database_ref.uri);
  for (const ref of [{ kind: "project-logical", uri: good.stores[0].database_ref.uri, binding_id: "db-a" },
    { kind: "machine-binding", binding_id: "db-a", uri: good.stores[0].database_ref.uri }, { kind: "project-logical", binding_id: "db-a" },
    { kind: "machine-binding", uri: good.stores[0].database_ref.uri }, { kind: "file", binding_id: "db-a" }]) {
    const value = declaration(); value.stores[0].database_ref = ref; rejected(encode(value));
  }
});

for (const invalid of ["/absolute/state.sqlite", "../escape", "file:///root/db", "https://example.invalid/db", "\\\\server\\share", "C:\\db",
  "runtime:///absolute/db", "runtime://a/../db", "runtime://a/./db", "runtime://a//db", "runtime://a/%2e%2e/db", "runtime://a/%252e/db",
  "runtime://a\\b/db", "runtime://a/db?x", "runtime://a/db#x", "runtime://user@a/db", "runtime://a/db:stream", "runtime://a/db.",
  "runtime://a/db ", "runtime://A/db", "runtime://a/é", "runtime://a/CON", "runtime://a/con.sqlite", "runtime://a/lpt1", "runtime://a/..hidden",
  "runtime://a/db\u0000", "runtime://a/b/c/d/e/f/g/h/i", "runtime://a/db/"]) {
  test(`URI rejects escaping/ambiguous spelling ${JSON.stringify(invalid)}`, () => {
    const value = declaration(); value.stores[0].database_ref = { kind: "project-logical", uri: invalid }; rejected(encode(value));
  });
}

test("ID bounds and canonical binding spelling are explicit without coercion", () => {
  for (const invalid of ["", ".", "..", "with/slash", "with\\slash", " space", "trailing ", "é", "e\u0301", "__proto__", "x".repeat(LIMITS.id + 1)]) {
    const value = declaration(); value.project_id = invalid; rejected(encode(value));
  }
  for (const invalid of ["Upper", "has.dot", "with:colon", "two--dashes", "-lead", "trail-", "x".repeat(LIMITS.id + 1), 1, true, null, {}]) {
    const value = declaration(); value.stores[0].binding_id = invalid; rejected(encode(value));
  }
  const boundary = declaration(); boundary.project_id = "p".repeat(LIMITS.id);
  assert.equal(parse(encode(boundary), boundary.project_id).snapshot.project_id, boundary.project_id);
});

test("same binding/resource aliases and semantic duplicate stores are never silently deduplicated", () => {
  for (const field of ["binding_id", "anchor_binding_id", "expected_store_id"]) {
    const value = declaration(), other = store("b"); other[field] = value.stores[0][field]; value.stores.push(other);
    rejected(encode(value), "ERR_PERMIT_DECLARATION_DUPLICATE_BINDING");
  }
  const ref = declaration(); const other = store("b"); other.database_ref.binding_id = "db-a"; ref.stores.push(other);
  rejected(encode(ref), "ERR_PERMIT_DECLARATION_DUPLICATE_BINDING");
  const repeated = declaration(); repeated.stores.push(store()); rejected(encode(repeated), "ERR_PERMIT_DECLARATION_DUPLICATE_BINDING");
  const typed = declaration(); typed.stores[0].anchor_binding_id = "db-a";
  assert.equal(accepted(typed).snapshot.stores[0].anchor_binding_id, "db-a");
  const uri = declaration(); uri.stores.push(store("b"));
  for (const item of uri.stores) item.database_ref = { kind: "project-logical", uri: "runtime://coordination/permit/db.sqlite" };
  rejected(encode(uri), "ERR_PERMIT_DECLARATION_DUPLICATE_BINDING");
  const escaped = declaration(); escaped.stores.push(store("b"));
  rejected(encode(escaped).replace('"db-b"', '"\\u0064b-a"'), "ERR_PERMIT_DECLARATION_DUPLICATE_BINDING");
});

test("URI limits accept the exact lexical boundary without resolving a path", () => {
  const value = declaration(), parts = ["coordination", "permit", "a".repeat(128), "b".repeat(128), "c".repeat(128), "d".repeat(95)];
  const uri = "runtime://" + parts.join("/"); assert.equal(uri.length, LIMITS.uri);
  value.stores[0].database_ref = { kind: "project-logical", uri };
  assert.equal(accepted(value).snapshot.stores[0].database_ref.uri.length, LIMITS.uri);
  value.stores[0].database_ref.uri += "d"; rejected(encode(value));
});

test("maximum store count accepted; next store refused", () => {
  const value = declaration(); value.stores = Array.from({ length: LIMITS.stores }, (_, i) => store("s" + i));
  assert.equal(accepted(value).snapshot.stores.length, LIMITS.stores);
  value.stores.push(store("overflow")); rejected(encode(value), "ERR_PERMIT_DECLARATION_LIMIT");
});

test("runtime database URI has an exact known namespace and permit subtree", () => {
  for (const input of ["runtime://unknown/permit/db.sqlite", "runtime://hosts/permit/db.sqlite", "runtime://worktrees/permit/db.sqlite",
    "runtime://dispatch/permit/db.sqlite", "runtime://coordination/permits/db.sqlite", "runtime://coordination/permit",
    "runtime://coordination/permit-other/db.sqlite", "runtime://coordination/permit/", "runtime://coordination/permit/../db.sqlite",
    "runtime://coordination/permit/%2edb", "runtime://coordination/permit/db%2esqlite", "runtime://coordination/permit/nul.txt",
    "runtime://coordination/permit/db:stream", "runtime://coordination/permit/a\\b", "runtime://coordination/permit/a.",
    "runtime://coordination/permit/con/db.sqlite", "runtime://coordination/permit/lpt9.sqlite", "runtime://coordination/permit/db?x"]) {
    const value = declaration(); value.stores[0].database_ref = { kind: "project-logical", uri: input }; rejected(encode(value));
  }
});

test("accepted URI is a strict subset of the actual logical URI/resolver contract across path flavors", () => {
  const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
  const { createRequire } = require("node:module");
  const logical = require("../../lib/runtime-layout/logical-uri"), resolver = require("../../lib/runtime-layout/resolver");
  const resolverFile = require.resolve("../../lib/runtime-layout/resolver"), resolverSource = fs.readFileSync(resolverFile, "utf8");
  const localRequire = createRequire(resolverFile), variants = [];
  for (const flavor of ["posix", "win32"]) {
    const module = { exports: {} };
    const root = flavor === "posix" ? "/synthetic-project" : "Q:\\synthetic-project";
    vm.runInNewContext(resolverSource, { module, exports: module.exports, require: name => {
      if (name === "node:path") return path[flavor];
      if (name === "node:fs") return new Proxy({}, { get: () => { throw Error("resolver must not access filesystem in this test"); } });
      return localRequire(name);
    }, process, Buffer }, { filename: resolverFile });
    const api = module.exports;
    const layout = api.resolveLayout({ projectRoot: root, projectId: "project-a" });
    const value = declaration(); value.stores[0].database_ref = { kind: "project-logical", uri: "runtime://coordination/permit/primary/state.sqlite" };
    const parsed = logical.parse(accepted(value).snapshot.stores[0].database_ref.uri);
    assert.ok(resolver.PORTABLE_NAMESPACES.includes(parsed.segments[0]));
    assert.equal(parsed.scheme, "runtime");
    const target = api.portablePath(layout, parsed);
    assert.equal(target, path[flavor].join(root, ".agent", "runtime", "coordination", "permit", "primary", "state.sqlite"));
    variants.push(parsed.segments);
  }
  assert.deepEqual(variants[0], variants[1]);
});

test("Buffer byte copy never enumerates own metadata, invokes getters, or uses caller iterator/species", () => {
  const bytes = Buffer.from(encode(declaration())), expected = accepted().digest;
  let calls = 0;
  const trap = () => { calls++; throw Error("Buffer metadata executed"); };
  // Many arbitrary metadata keys previously made Reflect.ownKeys unbounded.
  for (let i = 0; i < 20000; i++) Object.defineProperty(bytes, "metadata-" + i, { get: trap });
  for (const key of ["byteLength", "byteOffset", "buffer", "length", "constructor", "toJSON", "valueOf"])
    Object.defineProperty(bytes, key, { get: trap });
  Object.defineProperty(bytes, Symbol.iterator, { get: trap });
  const ownKeys = Reflect.ownKeys, names = Object.getOwnPropertyNames, symbols = Object.getOwnPropertySymbols;
  Reflect.ownKeys = value => { if (value === bytes) throw Error("enumerated buffer"); return ownKeys(value); };
  Object.getOwnPropertyNames = value => { if (value === bytes) throw Error("enumerated buffer"); return names(value); };
  Object.getOwnPropertySymbols = value => { if (value === bytes) throw Error("enumerated buffer"); return symbols(value); };
  try { assert.equal(parse(bytes, "project-a").digest, expected); }
  finally { Reflect.ownKeys = ownKeys; Object.getOwnPropertyNames = names; Object.getOwnPropertySymbols = symbols; }
  assert.equal(calls, 0);
  const wrapped = new Proxy(bytes, { get: trap, getPrototypeOf: trap, ownKeys: trap });
  rejected(wrapped, "ERR_PERMIT_DECLARATION_INPUT"); assert.equal(calls, 0);
});

test("Buffer intrinsic view validates offset, shared and detached storage with captured builtins", () => {
  const text = encode(declaration()), bytes = Buffer.alloc(Buffer.byteLength(text) + 16, 0x20);
  bytes.write(text, 8); const slice = bytes.subarray(8, bytes.length - 8);
  const oldSet = Uint8Array.prototype.set;
  Uint8Array.prototype.set = () => { throw Error("uncaptured set"); };
  try { assert.equal(parse(slice, "project-a").digest, accepted().digest); }
  finally { Uint8Array.prototype.set = oldSet; }
  for (const length of [0, 8]) {
    const backing = new ArrayBuffer(length), buffer = Buffer.from(backing);
    structuredClone(backing, { transfer: [backing] });
    rejected(buffer, "ERR_PERMIT_DECLARATION_INPUT");
  }
  const shared = Buffer.from(new SharedArrayBuffer(Buffer.byteLength(text))); shared.write(text);
  rejected(shared, "ERR_PERMIT_DECLARATION_INPUT");
  const tooLarge = Buffer.alloc(LIMITS.bytes + 1); Object.defineProperty(tooLarge, "length", { get: () => { throw Error("length getter"); } });
  rejected(tooLarge, "ERR_PERMIT_DECLARATION_LIMIT");
});

test("deployment sharing and cross-role equal spelling preserve unambiguous typed references", () => {
  const value = declaration(); value.stores.push(store("b"));
  value.stores[1].deployment_binding_id = "service-a";
  // Same string means different typed roles; does not collapse DB and anchor.
  value.stores[0].binding_id = value.stores[0].anchor_binding_id = value.stores[0].deployment_binding_id = value.stores[0].database_ref.binding_id = "primary";
  value.stores[1].deployment_binding_id = "primary";
  const result = accepted(value);
  assert.equal(result.snapshot.stores.length, 2);
  assert.deepEqual(result.snapshot.stores.map(item => item.deployment_binding_id), ["primary", "primary"]);
  const reordered = { ...value, stores: [...value.stores].reverse() };
  assert.equal(accepted(reordered).digest, result.digest);
  // A single real anchor journal cannot contain these two store identities.
  value.stores[1].anchor_binding_id = "primary";
  rejected(encode(value), "ERR_PERMIT_DECLARATION_DUPLICATE_BINDING");
});

test("module load and parsing require no filesystem, path resolver, DB, network or process execution", () => {
  const child = spawnSync(process.execPath, ["-e", `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(name, ...args) {
      if (/^(?:node:)?(?:fs|path|sqlite|net|tls|http|https|child_process)(?:\\/|$)/.test(name)) throw Error('forbidden dependency ' + name);
      return load.call(this, name, ...args);
    };
    const codec = require(process.argv[1]);
    const result = codec.parsePermitStoreDeclaration(process.argv[2], 'project-a');
    process.stdout.write(result.digest);
  `, require.resolve("../../lib/coordination/permit-store-declaration"), encode(declaration())], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "77ee4e443c7aae7a3ee9dc08a4b628dea8a4f80cd9793e501d69afce72ee6b44");
});
