"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const [dir, mode, release, version] = process.argv.slice(2);
function event(value) { fs.writeSync(1, JSON.stringify(value) + "\n"); }
let Store = require("../../../lib/coordination/protected-pin-store").ProtectedPinStore;
if (version) {
  const filename = path.resolve(__dirname, "../../../lib/coordination/protected-pin-store.js");
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(fs.readFileSync(path.join(__dirname, `protected-pin-store-v${version}-source.txt`), "utf8"), filename);
  Store = compiled.exports.ProtectedPinStore;
}
try {
  event({ event: "starting" });
  const store = Store.open(dir, { decisionId: "D-test-pin", anchorMode: "permissive" });
  if (mode === "read") {
    event({ event: "result", ok: true, sequence: store.revocationState().appliedRevocationSequence });
  } else {
    store.criticalSection(() => {
      if (mode === "hold") {
        event({ event: "paused" });
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(release)) {
          if (Date.now() > deadline) throw new Error("release deadline exceeded");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      store.commitRevocation({ sequence: 1, revokedFingerprints: ["revoked"], permitSequence: 1 });
    });
    event({ event: "result", ok: true });
  }
} catch (error) {
  event({ event: "result", ok: false, code: error.key || error.code || error.message });
}
