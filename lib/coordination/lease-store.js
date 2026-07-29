"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { CoordinationError } = require("./errors");
const { LeaseManager } = require("./lease");

function statePath(leasesDir) {
  return path.join(leasesDir, "state.json");
}

function writeLeaseState(leasesDir, manager) {
  fs.mkdirSync(leasesDir, { recursive: true });
  const target = statePath(leasesDir);
  const suffix = crypto.randomBytes(8).toString("hex");
  const temp = `${target}.tmp.${process.pid}.${suffix}`;
  const data = `${JSON.stringify(manager.exportState(), null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    const dirFd = fs.openSync(leasesDir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* renamed or best-effort cleanup */ }
  }
  return target;
}

function readLeaseState(leasesDir, options = {}) {
  const target = statePath(leasesDir);
  let raw;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return new LeaseManager({ clock: options.clock });
    }
    throw error;
  }
  try {
    return LeaseManager.fromState(JSON.parse(raw), { clock: options.clock });
  } catch (error) {
    if (error instanceof CoordinationError) throw error;
    throw new CoordinationError("ERR_INVALID_STATE", {
      cause: error,
      details: { reason: "durable lease state is corrupted" },
    });
  }
}

// ─── FAE-007 idempotency persistence ───────────────────────────────────────
// Lightweight, fsynced durable index mapping idempotency_key →
// { scope, lease_id, owner, created_at, expires_at }. Used by the public
// lease CLI to short-circuit duplicate acquires without scanning the full
// state.json on every call. The state.json remains the authoritative lease
// source; idempotency.json is a derived index only.

function idempotencyPath(leasesDir) {
  return path.join(leasesDir, "idempotency.json");
}

function readIdempotency(leasesDir, options = {}) {
  const target = idempotencyPath(leasesDir);
  let raw;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { schema_version: 1, keys: {} };
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schema_version !== 1 || typeof parsed.keys !== "object" || parsed.keys === null) {
      throw new CoordinationError("ERR_INVALID_STATE", {
        details: { reason: "idempotency.json is corrupted" },
      });
    }
    return parsed;
  } catch (error) {
    if (error instanceof CoordinationError) throw error;
    throw new CoordinationError("ERR_INVALID_STATE", {
      cause: error,
      details: { reason: "idempotency.json is corrupted" },
    });
  }
}

function writeIdempotency(leasesDir, index) {
  if (!index || index.schema_version !== 1 || typeof index.keys !== "object" || index.keys === null) {
    throw new CoordinationError("ERR_INVALID_STATE", {
      details: { reason: "idempotency index shape invalid" },
    });
  }
  fs.mkdirSync(leasesDir, { recursive: true });
  const target = idempotencyPath(leasesDir);
  const suffix = crypto.randomBytes(8).toString("hex");
  const temp = `${target}.tmp.${process.pid}.${suffix}`;
  const data = `${JSON.stringify(index, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    const dirFd = fs.openSync(leasesDir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* renamed or best-effort cleanup */ }
  }
  return target;
}

module.exports = {
  statePath,
  idempotencyPath,
  writeLeaseState,
  readLeaseState,
  readIdempotency,
  writeIdempotency,
};
