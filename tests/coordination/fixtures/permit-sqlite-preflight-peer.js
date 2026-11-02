"use strict";

// Exclusive fixture: real SQLite writers/observers, no production store code.
const [mode, file] = process.argv.slice(2);
if (mode === "observe") {
  const { preflightPermitSqlite } = require("../../../lib/coordination/permit-sqlite-preflight");
  process.stdout.write(JSON.stringify(preflightPermitSqlite(file)) + "\n");
} else {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  if (mode === "mutate") {
    db.exec("PRAGMA user_version=1"); db.close();
  } else if (mode === "wal-holder" || mode === "hot-journal") {
    if (mode === "wal-holder") {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=2");
    } else {
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA cache_size=5; BEGIN IMMEDIATE");
      db.prepare("UPDATE fixture_data SET secret=?").run("pending-fixture-only-".repeat(20000));
    }
    process.stdout.write("ready\n");
    process.stdin.resume();
    process.stdin.on("end", () => {
      if (mode === "hot-journal") db.exec("ROLLBACK");
      db.close();
    });
  } else {
    db.close(); throw Error("unsupported exclusive fixture mode");
  }
}
