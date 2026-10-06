"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  RevisionConflict,
  createRevisionToken,
  normalizeGovernanceStoreCapabilities,
} = require("../../packages/project-sdk/src/governance.js");

const FILESYSTEM_STORE_KIND = "filesystem";

function normalizeRelativeKey(key) {
  if (typeof key !== "string" || !key.trim() || /[\r\n]/.test(key)) {
    const error = new Error("GovernanceStore key must be a non-empty relative path.");
    error.code = "ERR_GOVERNANCE_STORE_KEY_INVALID";
    throw error;
  }
  const normalized = key.trim().replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    const error = new Error(`GovernanceStore key must stay inside the store root: ${key}`);
    error.code = "ERR_GOVERNANCE_STORE_KEY_ESCAPE";
    throw error;
  }
  return normalized;
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function createFilesystemRevision(content) {
  return createRevisionToken({
    store_kind: FILESYSTEM_STORE_KIND,
    value: `sha256:${sha256(content)}`,
  });
}

class FilesystemGovernanceStore {
  constructor(root) {
    if (typeof root !== "string" || !root.trim()) {
      const error = new Error("FilesystemGovernanceStore root is required.");
      error.code = "ERR_GOVERNANCE_STORE_ROOT_REQUIRED";
      throw error;
    }
    this.kind = FILESYSTEM_STORE_KIND;
    this.root = path.resolve(root);
    this._capabilities = normalizeGovernanceStoreCapabilities({
      read: true,
      write: true,
      compare_and_write: true,
      append: false,
      history: false,
      watch: false,
    });
  }

  capabilities() {
    return this._capabilities;
  }

  resolve(key) {
    const normalized = normalizeRelativeKey(key);
    const target = path.resolve(this.root, ...normalized.split("/"));
    const relative = path.relative(this.root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      const error = new Error(`GovernanceStore key escaped root: ${key}`);
      error.code = "ERR_GOVERNANCE_STORE_KEY_ESCAPE";
      throw error;
    }
    return target;
  }

  exists(key) {
    return fs.existsSync(this.resolve(key));
  }

  readText(key, options = {}) {
    const target = this.resolve(key);
    if (!fs.existsSync(target)) {
      if (options.required === false) {
        return { ok: true, exists: false, content: null, revision: null, path: target };
      }
      const error = new Error(`GovernanceStore object not found: ${key}`);
      error.code = "ERR_GOVERNANCE_STORE_NOT_FOUND";
      error.key = key;
      throw error;
    }
    const content = fs.readFileSync(target, "utf8");
    return {
      ok: true,
      exists: true,
      content,
      revision: createFilesystemRevision(content),
      path: target,
    };
  }

  readJson(key, options = {}) {
    const result = this.readText(key, options);
    if (!result.exists) return { ...result, value: null };
    try {
      return { ...result, value: JSON.parse(result.content) };
    } catch (error) {
      error.code = "ERR_GOVERNANCE_STORE_JSON_INVALID";
      error.key = key;
      throw error;
    }
  }

  getRevision(key) {
    const result = this.readText(key, { required: false });
    return result.revision;
  }

  writeText(key, content, options = {}) {
    if (typeof content !== "string") {
      const error = new Error("GovernanceStore text content must be a string.");
      error.code = "ERR_GOVERNANCE_STORE_CONTENT_INVALID";
      throw error;
    }
    const target = this.resolve(key);
    const current = this.readText(key, { required: false });
    if (Object.prototype.hasOwnProperty.call(options, "expected_revision")) {
      const expected = options.expected_revision;
      const expectedValue = expected && typeof expected === "object" ? expected.value : expected;
      const actualValue = current.revision ? current.revision.value : null;
      if (expectedValue !== actualValue) {
        throw new RevisionConflict({
          expected: expectedValue,
          actual: actualValue,
          resource: key,
        });
      }
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmp, content, {
        encoding: "utf8",
        mode: options.mode == null ? 0o600 : options.mode,
      });
      fs.renameSync(tmp, target);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      error.code = error.code || "ERR_GOVERNANCE_STORE_WRITE_FAILED";
      throw error;
    }
    return {
      ok: true,
      path: target,
      revision: createFilesystemRevision(content),
    };
  }

  writeJson(key, value, options = {}) {
    const content = JSON.stringify(value, null, 2) + "\n";
    return this.writeText(key, content, options);
  }
}

function createFilesystemGovernanceStore(root) {
  return new FilesystemGovernanceStore(root);
}

module.exports = {
  FILESYSTEM_STORE_KIND,
  FilesystemGovernanceStore,
  createFilesystemGovernanceStore,
  normalizeRelativeKey,
  createFilesystemRevision,
};
