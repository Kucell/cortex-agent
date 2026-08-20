"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  readLockfile,
  writeLockfile,
  migrateV1ToV2,
  upsertEntry,
  removeEntry,
  findEntry,
  listByKind,
  emptyV2Lockfile,
  getLockfilePath,
  getLegacyLockfilePath,
  _internal,
} = require("../../lib/catalog/lockfile");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-catalog-lockfile-"));
}

// ─── Path resolution ─────────────────────────────────────────────────────────

test("getLockfilePath: returns <cwd>/.agent/catalog.lock", () => {
  assert.equal(getLockfilePath("/tmp/foo"), path.join("/tmp/foo", ".agent", "catalog.lock"));
});

test("getLegacyLockfilePath: returns <cwd>/.agent/design-systems.lock", () => {
  assert.equal(getLegacyLockfilePath("/tmp/foo"), path.join("/tmp/foo", ".agent", "design-systems.lock"));
});

// ─── emptyV2Lockfile ─────────────────────────────────────────────────────────

test("emptyV2Lockfile: returns a valid empty v2 lock", () => {
  const lock = emptyV2Lockfile("2026-08-20T00:00:00Z");
  assert.equal(lock.lockfileVersion, 2);
  assert.equal(lock.schemaVersion, "od-catalog-project/v1");
  assert.equal(lock.fetched_at, "2026-08-20T00:00:00Z");
  assert.deepEqual(lock.catalogs, []);
});

// ─── readLockfile: nonexistent file ──────────────────────────────────────────

test("readLockfile: nonexistent file returns empty v2 lock", () => {
  const dir = makeTmpDir();
  const lock = readLockfile(dir);
  assert.equal(lock.lockfileVersion, 2);
  assert.deepEqual(lock.catalogs, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── v1 → v2 migration (the critical backward-compat path) ──────────────────

test("migrateV1ToV2: v1 systems[] becomes v2 catalogs[]", () => {
  const v1 = {
    lockfileVersion: 1,
    schemaVersion: "od-design-system-project/v1",
    fetched_at: "2026-08-15T12:00:00Z",
    upstream: "https://raw.githubusercontent.com/nexu-io/open-design/main",
    systems: [
      {
        id: "linear-app",
        sha256_manifest: "ab12",
        sha256_design: "cd34",
        sha256_tokens: "ef56",
        license: "Apache-2.0",
        category: "Developer Tools",
        source: { type: "upstream", origin: "nexu-io/open-design" },
        fetched_at: "2026-08-15T12:01:00Z",
      },
      {
        id: "default",
        sha256_manifest: "1111",
        license: "MIT",
        source: { type: "upstream", origin: "nexu-io/open-design" },
      },
    ],
  };
  const v2 = migrateV1ToV2(v1, "2026-08-20T00:00:00Z");
  assert.equal(v2.lockfileVersion, 2);
  assert.equal(v2.schemaVersion, "od-catalog-project/v1");
  assert.equal(v2.upstream, "https://raw.githubusercontent.com/nexu-io/open-design/main");
  assert.equal(v2._migrated_from_v1, true);
  assert.match(v2._v1_migration_note, /migrated from v1/);
  assert.equal(v2.catalogs.length, 2);
  // Each entry has kind="design-system" injected
  assert.equal(v2.catalogs[0].kind, "design-system");
  assert.equal(v2.catalogs[0].id, "linear-app");
  assert.equal(v2.catalogs[0].license, "Apache-2.0");
  assert.equal(v2.catalogs[1].id, "default");
  assert.equal(v2.catalogs[1].kind, "design-system");
});

test("migrateV1ToV2: missing systems[] throws", () => {
  assert.throws(() => migrateV1ToV2({ lockfileVersion: 1 }, "now"), /missing 'systems\[\]'/);
});

test("migrateV1ToV2: filters out malformed entries", () => {
  const v2 = migrateV1ToV2(
    {
      lockfileVersion: 1,
      schemaVersion: "od-design-system-project/v1",
      fetched_at: "x",
      systems: [null, { id: "ok", license: "MIT" }, undefined, "string"],
    },
    "now",
  );
  assert.equal(v2.catalogs.length, 1);
  assert.equal(v2.catalogs[0].id, "ok");
});

// ─── readLockfile: v1 legacy file ────────────────────────────────────────────

test("readLockfile: legacy v1 design-systems.lock auto-migrates to v2", () => {
  const dir = makeTmpDir();
  const legacyPath = getLegacyLockfilePath(dir);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(
    legacyPath,
    JSON.stringify({
      lockfileVersion: 1,
      schemaVersion: "od-design-system-project/v1",
      fetched_at: "2026-08-15T12:00:00Z",
      upstream: "https://example.com",
      systems: [{ id: "default", license: "MIT" }],
    }),
    "utf8",
  );
  const lock = readLockfile(dir);
  assert.equal(lock.lockfileVersion, 2);
  assert.equal(lock.schemaVersion, "od-catalog-project/v1");
  assert.equal(lock._migrated_from_v1, true);
  assert.equal(lock.catalogs.length, 1);
  assert.equal(lock.catalogs[0].kind, "design-system");
  assert.equal(lock.catalogs[0].id, "default");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readLockfile: v2 catalog.lock roundtrips", () => {
  const dir = makeTmpDir();
  const lockPath = getLockfilePath(dir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      lockfileVersion: 2,
      schemaVersion: "od-catalog-project/v1",
      fetched_at: "2026-08-20T00:00:00Z",
      catalogs: [
        { kind: "design-system", id: "linear-app", license: "Apache-2.0" },
        { kind: "plugin", id: "od-figma-migration", license: "Apache-2.0" },
      ],
    }),
    "utf8",
  );
  const lock = readLockfile(dir);
  assert.equal(lock.lockfileVersion, 2);
  assert.equal(lock.catalogs.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readLockfile: v2 lock wins over legacy v1 when both exist", () => {
  const dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, ".agent"), { recursive: true });
  fs.writeFileSync(
    getLegacyLockfilePath(dir),
    JSON.stringify({ lockfileVersion: 1, schemaVersion: "od-design-system-project/v1", systems: [{ id: "from-v1", license: "MIT" }] }),
    "utf8",
  );
  fs.writeFileSync(
    getLockfilePath(dir),
    JSON.stringify({ lockfileVersion: 2, schemaVersion: "od-catalog-project/v1", catalogs: [{ kind: "design-system", id: "from-v2", license: "Apache-2.0" }] }),
    "utf8",
  );
  const lock = readLockfile(dir);
  assert.equal(lock.catalogs.length, 1);
  assert.equal(lock.catalogs[0].id, "from-v2");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readLockfile: malformed JSON throws", () => {
  const dir = makeTmpDir();
  const lockPath = getLockfilePath(dir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "{ not json", "utf8");
  assert.throws(() => readLockfile(dir), /failed to parse/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readLockfile: unsupported lockfileVersion throws", () => {
  const dir = makeTmpDir();
  const lockPath = getLockfilePath(dir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 99, catalogs: [] }), "utf8");
  assert.throws(() => readLockfile(dir), /unsupported lockfileVersion 99/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── writeLockfile ───────────────────────────────────────────────────────────

test("writeLockfile: writes v2 schema and strips migration metadata", () => {
  const dir = makeTmpDir();
  const result = writeLockfile(dir, {
    fetched_at: "2026-08-20T00:00:00Z",
    upstream: "https://example.com",
    catalogs: [
      { kind: "design-system", id: "default", license: "MIT" },
      { kind: "plugin", id: "od-figma-migration", license: "Apache-2.0" },
    ],
    _migrated_from_v1: true,
    _v1_migration_note: "should be stripped",
  });
  assert.ok(result.path.endsWith("catalog.lock"));
  const written = JSON.parse(fs.readFileSync(result.path, "utf8"));
  assert.equal(written.lockfileVersion, 2);
  assert.equal(written.schemaVersion, "od-catalog-project/v1");
  assert.equal(written._migrated_from_v1, undefined);
  assert.equal(written._v1_migration_note, undefined);
  assert.equal(written.catalogs.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeLockfile: atomic write (tmp + rename)", () => {
  const dir = makeTmpDir();
  writeLockfile(dir, { catalogs: [] });
  // tmp file should not remain
  const tmpPath = getLockfilePath(dir) + ".tmp";
  assert.equal(fs.existsSync(tmpPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeLockfile: defaults fetched_at when missing", () => {
  const dir = makeTmpDir();
  writeLockfile(dir, { catalogs: [{ kind: "skill", id: "x", license: "MIT" }] });
  const lock = readLockfile(dir);
  assert.match(lock.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeLockfile: defaults catalogs to [] when missing", () => {
  const dir = makeTmpDir();
  writeLockfile(dir, { });
  const lock = readLockfile(dir);
  assert.deepEqual(lock.catalogs, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── upsertEntry / removeEntry / findEntry / listByKind ──────────────────────

test("upsertEntry: adds new entry", () => {
  const lock = emptyV2Lockfile("now");
  const next = upsertEntry(lock, { kind: "design-system", id: "default", license: "MIT" });
  assert.equal(next.catalogs.length, 1);
  assert.match(next.catalogs[0].fetched_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("upsertEntry: replaces existing (kind, id)", () => {
  let lock = emptyV2Lockfile("now");
  lock = upsertEntry(lock, { kind: "plugin", id: "od-x", license: "MIT" });
  lock = upsertEntry(lock, { kind: "plugin", id: "od-x", license: "Apache-2.0" });
  assert.equal(lock.catalogs.length, 1);
  assert.equal(lock.catalogs[0].license, "Apache-2.0");
});

test("upsertEntry: requires kind + id", () => {
  const lock = emptyV2Lockfile("now");
  assert.throws(() => upsertEntry(lock, { id: "x" }), /kind and id are required/);
  assert.throws(() => upsertEntry(lock, { kind: "plugin" }), /kind and id are required/);
});

test("upsertEntry: 4-kind isolation (same id across kinds)", () => {
  let lock = emptyV2Lockfile("now");
  lock = upsertEntry(lock, { kind: "design-system", id: "default", license: "MIT" });
  lock = upsertEntry(lock, { kind: "plugin", id: "default", license: "Apache-2.0" });
  assert.equal(lock.catalogs.length, 2);
  const ds = lock.catalogs.find((e) => e.kind === "design-system");
  const pl = lock.catalogs.find((e) => e.kind === "plugin");
  assert.equal(ds.license, "MIT");
  assert.equal(pl.license, "Apache-2.0");
});

test("removeEntry: removes by (kind, id)", () => {
  let lock = emptyV2Lockfile("now");
  lock = upsertEntry(lock, { kind: "plugin", id: "a", license: "MIT" });
  lock = upsertEntry(lock, { kind: "plugin", id: "b", license: "MIT" });
  lock = upsertEntry(lock, { kind: "skill", id: "a", license: "MIT" });
  const next = removeEntry(lock, "plugin", "a");
  assert.equal(next.catalogs.length, 2);
  assert.equal(next.catalogs.find((e) => e.kind === "skill" && e.id === "a").license, "MIT");
  assert.equal(next.catalogs.find((e) => e.kind === "plugin" && e.id === "a"), undefined);
});

test("findEntry: returns entry or null", () => {
  let lock = emptyV2Lockfile("now");
  lock = upsertEntry(lock, { kind: "template", id: "saas-landing", license: "Apache-2.0" });
  assert.equal(findEntry(lock, "template", "saas-landing").license, "Apache-2.0");
  assert.equal(findEntry(lock, "template", "missing"), null);
});

test("listByKind: filters by kind", () => {
  let lock = emptyV2Lockfile("now");
  lock = upsertEntry(lock, { kind: "skill", id: "s1", license: "MIT" });
  lock = upsertEntry(lock, { kind: "skill", id: "s2", license: "MIT" });
  lock = upsertEntry(lock, { kind: "plugin", id: "p1", license: "MIT" });
  const skills = listByKind(lock, "skill");
  assert.equal(skills.length, 2);
  assert.equal(skills[0].kind, "skill");
});

// ─── End-to-end: write v2 → read → migrate roundtrip ────────────────────────

test("E2E: write v2 → read returns same catalogs", () => {
  const dir = makeTmpDir();
  let lock = emptyV2Lockfile("2026-08-20T00:00:00Z");
  lock = upsertEntry(lock, { kind: "design-system", id: "default", license: "MIT" });
  lock = upsertEntry(lock, { kind: "plugin", id: "od-figma-migration", license: "Apache-2.0" });
  lock = upsertEntry(lock, { kind: "skill", id: "open-design-launch-checklist", license: "Apache-2.0" });
  lock = upsertEntry(lock, { kind: "template", id: "saas-landing", license: "Apache-2.0" });
  writeLockfile(dir, lock);
  const read = readLockfile(dir);
  assert.equal(read.catalogs.length, 4);
  assert.equal(listByKind(read, "design-system").length, 1);
  assert.equal(listByKind(read, "plugin").length, 1);
  assert.equal(listByKind(read, "skill").length, 1);
  assert.equal(listByKind(read, "template").length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("E2E: write v1 → read auto-migrates → re-write emits clean v2", () => {
  const dir = makeTmpDir();
  const legacyPath = getLegacyLockfilePath(dir);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(
    legacyPath,
    JSON.stringify({
      lockfileVersion: 1,
      schemaVersion: "od-design-system-project/v1",
      fetched_at: "2026-08-15T00:00:00Z",
      upstream: "https://example.com",
      systems: [{ id: "default", license: "MIT" }, { id: "linear-app", license: "Apache-2.0" }],
    }),
    "utf8",
  );
  // First read: auto-migrates in memory
  const lock = readLockfile(dir);
  assert.equal(lock.lockfileVersion, 2);
  assert.equal(lock._migrated_from_v1, true);
  // Re-write: emits clean v2 (no migration metadata)
  writeLockfile(dir, lock);
  const reread = readLockfile(dir);
  assert.equal(reread._migrated_from_v1, undefined);
  assert.equal(reread.catalogs.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── Schema constants ────────────────────────────────────────────────────────

test("_internal: schema constants are frozen", () => {
  assert.equal(_internal.SCHEMA_VERSION_V1, "od-design-system-project/v1");
  assert.equal(_internal.SCHEMA_VERSION_V2, "od-catalog-project/v1");
  assert.equal(_internal.LOCKFILE_VERSION_V2, 2);
});