"use strict";

const path = require("node:path");
const {
  atomicWrite,
  readJson,
  runtimeRoot,
} = require("./daemon-state.js");

const LEDGER_SCHEMA_VERSION = 1;

function ledgerPath(projectRoot) {
  return path.join(runtimeRoot(projectRoot), "idempotency.json");
}

function createFileIdempotencyStore(projectRoot, options = {}) {
  const limit = Number.isInteger(options.limit) ? Math.max(1, options.limit) : 1000;

  function read() {
    const value = readJson(ledgerPath(projectRoot), null);
    if (!value || value.schema_version !== LEDGER_SCHEMA_VERSION || !Array.isArray(value.entries)) {
      return { schema_version: LEDGER_SCHEMA_VERSION, entries: [] };
    }
    return value;
  }

  function write(value) {
    atomicWrite(ledgerPath(projectRoot), value);
  }

  return Object.freeze({
    has(key) {
      return read().entries.some((entry) => entry.key === key);
    },
    mark(key, value = true) {
      const current = read();
      const entries = current.entries.filter((entry) => entry.key !== key);
      entries.push({
        key,
        value,
        recorded_at: new Date().toISOString(),
      });
      while (entries.length > limit) entries.shift();
      write({ schema_version: LEDGER_SCHEMA_VERSION, entries });
    },
    size() {
      return read().entries.length;
    },
  });
}

module.exports = {
  LEDGER_SCHEMA_VERSION,
  ledgerPath,
  createFileIdempotencyStore,
};
