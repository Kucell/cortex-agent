// Fault injection only in this child test process. Production has no test hook.
const { DatabaseSync } = require("node:sqlite");
const { AuthorityStore, canonical, digest } = require("../../../lib/offline-migration/provider/authority-store");
const [root, phase] = process.argv.slice(2); let armed = false;
const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.prepare = function(sql) {
  const statement = prepare.call(this, sql);
  return { get: statement.get.bind(statement), all: statement.all.bind(statement), run(...args) {
    const result = statement.run(...args);
    if (armed && sql.startsWith("INSERT INTO " + phase + " ")) process.kill(process.pid, "SIGKILL");
    return result;
  } };
};
DatabaseSync.prototype.exec = function(sql) {
  const result = exec.call(this, sql);
  if (armed && phase === "committed" && sql === "COMMIT") process.kill(process.pid, "SIGKILL");
  return result;
};
const store = new AuthorityStore(root), old = store.read(); armed = true;
store.compareAndSwap(old, { ...old, revision: 2, previous_digest: digest(canonical(old)), state: "prepared", target: { generation: "target-1", db_identity: "db-2", anchor_identity: "anchor-2", digest: "c".repeat(64), schema: 3 } });
store.close(); process.exit(9); // Fault was not reached: test must fail.
