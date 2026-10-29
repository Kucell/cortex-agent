"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { AuthorityStore, canonical, digest } = require("../../lib/offline-migration/provider/authority-store");
const record = () => ({ protocol: 1, domain_id: "fixture-domain", control_epoch: "control-1", revision: 1, previous_digest: null, state: "source_disabled", active_generation: "source-1", attempt_id: "attempt-1", plan_digest: "a".repeat(64), freeze_generation: "freeze-1", source: { generation: "source-1", db_identity: "db-1", anchor_identity: "anchor-1", digest: "b".repeat(64) }, target: null });
function setup(t) { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "migration-authority-"))); fs.chmodSync(root, 0o700); const store = new AuthorityStore(root, { create: true }); t.after(() => { try { store.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } }); return { root, store }; }
function prepared(old) { return { ...old, revision: old.revision + 1, previous_digest: digest(canonical(old)), state: "prepared", target: { generation: "target-1", db_identity: "db-2", anchor_identity: "anchor-2", digest: "c".repeat(64), schema: 3 } }; }
test("authority persists binding, audit and highwater together", t => {
  const { root, store } = setup(t), source = store.initialize(record()), target = store.compareAndSwap(source, prepared(source));
  assert.deepEqual(store.read(), target); const other = new AuthorityStore(root); assert.deepEqual(other.read(), target); other.close();
});
test("stale expected binding cannot overwrite winner", t => { const { store } = setup(t), old = store.initialize(record()); store.compareAndSwap(old, prepared(old)); assert.throws(() => store.compareAndSwap(old, prepared(old)), { code: "MIGRATION_AUTHORITY_CAS_CONFLICT" }); });
test("initialization never overwrites existing authority", t => { const { store } = setup(t); store.initialize(record()); assert.throws(() => store.initialize(record()), { code: "MIGRATION_AUTHORITY_EXISTS" }); assert.equal(store.read().revision, 1); });
test("activation and source snapshot rollback forbidden in persistence API", t => { const { store } = setup(t), old = store.initialize(record()); assert.throws(() => store.compareAndSwap(old, { ...prepared(old), state: "active" })); assert.throws(() => store.compareAndSwap(old, { ...prepared(old), revision: 1 })); assert.equal(store.read().revision, 1); });
test("partial metadata tampering is rejected rather than reconstructed", t => {
  const { root, store } = setup(t); store.initialize(record()); const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(path.join(root, "authority.sqlite")); db.exec("DELETE FROM highwater"); db.close(); assert.throws(() => store.read(), { code: "MIGRATION_AUTHORITY_CORRUPT" });
});
test("CAS cannot change source, freeze or control identity", t => { const { store } = setup(t), old = store.initialize(record()); for (const key of ["control_epoch", "freeze_generation", "attempt_id"]) assert.throws(() => store.compareAndSwap(old, { ...prepared(old), [key]: "other" })); assert.equal(store.read().revision, 1); });
test("replaced authority inode is rejected by existing handle", t => { const { root, store } = setup(t); store.initialize(record()); const file = path.join(root, "authority.sqlite"); fs.renameSync(file, file + ".retained"); fs.copyFileSync(file + ".retained", file); fs.chmodSync(file, 0o600); assert.throws(() => store.read(), { code: "MIGRATION_AUTHORITY_REPLACED" }); });
for (const phase of ["records", "audit", "binding", "highwater", "committed"]) test(`real SIGKILL after ${phase} leaves whole old or new transaction`, t => {
  const { root, store } = setup(t); store.initialize(record());
  const { spawnSync } = require("node:child_process");
  const child = spawnSync(process.execPath, [path.join(__dirname, "helpers/authority-crash.cjs"), root, phase], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.signal, "SIGKILL", child.stderr); assert.equal(store.read().revision, phase === "committed" ? 2 : 1);
});
function bytes(root) { return Object.fromEntries(fs.readdirSync(root).sort().map(n => { const file = path.join(root, n), st = fs.statSync(file); return [n, [digest(fs.readFileSync(file)), st.size, st.mtimeMs]]; })); }
test("unknown WAL authority is refused without checkpoint or sidecar changes", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "migration-unknown-"))); fs.chmodSync(root, 0o700);
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(path.join(root, "authority.sqlite"));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=99; CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('preserve');"); fs.chmodSync(path.join(root, "authority.sqlite"), 0o600);
  const before = bytes(root); assert.throws(() => new AuthorityStore(root), { code: "MIGRATION_AUTHORITY_UNSUPPORTED_FORMAT" }); assert.deepEqual(bytes(root), before);
});
test("wrong structure at known header version is refused without writes", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "migration-unknown-"))); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(path.join(root, "authority.sqlite")); db.exec("PRAGMA user_version=1; CREATE TABLE unrelated(value TEXT)"); db.close(); fs.chmodSync(path.join(root, "authority.sqlite"), 0o600);
  const before = bytes(root); assert.throws(() => new AuthorityStore(root)); assert.deepEqual(bytes(root), before);
});
for (const field of ["control_epoch", "source", "state"]) test(`consistent but illegal history ${field} is rejected on reopen`, t => {
  const { root, store } = setup(t), old = store.initialize(record()), next = store.compareAndSwap(old, prepared(old));
  if (field === "source") next.source = { ...next.source, digest: "d".repeat(64) };
  else if (field === "state") { next.state = "target_disabled"; next.active_generation = next.target.generation; }
  else next[field] = "changed";
  const payload = canonical(next), hash = digest(payload), { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(path.join(root, "authority.sqlite"));
  db.exec("BEGIN"); db.prepare("UPDATE records SET payload=?,digest=? WHERE revision=2").run(payload, hash);
  for (const table of ["binding", "highwater"]) db.prepare(`UPDATE ${table} SET digest=? WHERE id=1`).run(hash);
  db.prepare("UPDATE audit SET payload_digest=? WHERE revision=2").run(hash); db.exec("COMMIT"); db.close();
  const before = bytes(root); assert.throws(() => new AuthorityStore(root)); assert.deepEqual(bytes(root), before);
});
for (const mutation of ["wrong-columns", "missing-check", "trigger", "view"]) test(`full table-name set with ${mutation} is refused unchanged`, t => {
  const { root, store } = setup(t), { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(path.join(root, "authority.sqlite"));
  if (mutation === "wrong-columns") db.exec("DROP TABLE records; CREATE TABLE records(revision TEXT,payload TEXT,digest TEXT)");
  else if (mutation === "missing-check") db.exec("DROP TABLE binding; CREATE TABLE binding(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,digest TEXT NOT NULL)");
  else if (mutation === "trigger") db.exec("CREATE TRIGGER extra AFTER INSERT ON records BEGIN DELETE FROM audit; END");
  else db.exec("CREATE VIEW extra AS SELECT * FROM audit");
  db.close(); const before = bytes(root); assert.throws(() => new AuthorityStore(root), { code: "MIGRATION_AUTHORITY_UNSUPPORTED_SCHEMA" }); assert.deepEqual(bytes(root), before);
});
