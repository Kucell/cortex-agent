"use strict";
// Real isolated Node process; control is fixture JSON over stdio, never secrets.
const readline = require("node:readline");
const { SqliteFixture } = require("./permit-phase-a-sqlite-driver");
const { DatabaseSync } = require("node:sqlite");
const db = SqliteFixture.open(process.argv[2]);
let lock;
const handles = new Map();
const signHandles = new Map();
process.stdout.write(JSON.stringify({ ready: true, snapshot: db.inspect() }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  let result;
  try {
    const c = JSON.parse(line);
    if (c.op === "hold-lock") {
      lock = new DatabaseSync(process.argv[2], { timeout: 1000 }); lock.exec("BEGIN IMMEDIATE"); result = { held: true };
    } else if (c.op === "release-lock") {
      lock.exec("ROLLBACK"); lock.close(); lock = null; result = { released: true };
    } else if (c.op === "probe-lock") {
      const probe = new DatabaseSync(process.argv[2], { timeout: c.timeout });
      const start = process.hrtime.bigint();
      process.stdout.write(JSON.stringify({ attemptingBegin: true }) + "\n");
      try { probe.exec("BEGIN IMMEDIATE"); probe.exec("ROLLBACK"); result = { acquired: true, elapsedMs: Number(process.hrtime.bigint() - start) / 1e6 }; }
      finally { probe.close(); }
    } else if (c.op === "inspect") result = db.inspect();
    else if (c.op === "recover") result = db.recover(c.options);
    else if (c.op === "consume") result = db.consumeOnce(c.request, c.observation, c.clocks, c.options);
    else if (c.op === "sign-prepare") result = db.prepareSigning(c.request, c.now, c.options);
    else if (c.op === "sign-inspect") result = db.inspectSigning(c.id);
    else if (c.op === "sign-arm") {
      const h = db.armSigning(c.id, c.now, c.options); signHandles.set(c.handle, h); result = { handle: c.handle };
    } else if (c.op === "sign-invoke") result = db.invokeSigning(signHandles.get(c.handle), c.now, c.options);
    else if (c.op === "sign-cancel") result = db.cancelSigning(c.id, c.now, c.options);
    else if (c.op === "business") result = db.commitBusiness(c.id, c.observation, c.clocks, c.options);
    else if (c.op === "barrier-inspect") result = db.inspectBarrier(c.id, c.scope || null);
    else if (c.op === "barrier-evidence") result = db.recordSyntheticEvidence(c.id, c.evidence, c.now, c.options);
    else if (c.op === "barrier-qualify") result = db.qualifySynthetic(c.id, c.now, c.options);
    else if (c.op === "barrier-claim-test") result = db.claimSyntheticRecord(c.id, c.now, c.options);
    else if (c.op === "real-publish") result = db.publish(c);
    else if (c.op === "real-claim") result = db.claim(c);
    else if (c.op === "real-dispatch") result = db.dispatch(c);
    else if (c.op === "command") {
      result = db.command(c.command, c.options);
      if (c.command.type === "enter" && Object.getPrototypeOf(result) === null) {
        handles.set(c.handle, result); result = { handle: c.handle };
      }
    } else if (c.op === "commit") result = db.commit(handles.get(c.handle), c.clocks, c.options);
    else throw Error("UNSUPPORTED_CHILD_COMMAND");
    if (c.op === "sign-invoke" && result.status === "hash-committed") {
      if (c.deliveryFailure === "exit-before-local-write") process.exit(85);
      process.stdout.write(JSON.stringify({ ok: true, result }) + "\n", error => {
        if (!error) {
          if (c.deliveryFailure === "exit-before-callback-record") process.exit(86);
          try {
            db.recordSigningLocalSend(result.attemptId, result.resultDigest, c.localSendOptions);
            if (c.deliveryFailure === "exit-after-callback-record") process.exit(87);
          }
          catch (e) { process.stderr.write("local-send-evidence: " + (e.code || e.message) + "\n"); }
        }
      });
    } else process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code || error.message, errcode: error.errcode, message: error.message, outcome: error.outcome,
      cleanupError: error.cleanupError && { code: error.cleanupError.code, errcode: error.cleanupError.errcode, message: error.cleanupError.message } }) + "\n");
  }
}).on("close", () => { if (lock) { lock.exec("ROLLBACK"); lock.close(); } db.close(); });
