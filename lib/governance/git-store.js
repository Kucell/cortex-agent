"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  RevisionConflict,
  createRevisionToken,
  normalizeGovernanceStoreCapabilities,
} = require("../../packages/project-sdk/src/governance.js");
const { normalizeRelativeKey } = require("./store");

const GIT_STORE_KIND = "git";
const ZERO_OID = "0000000000000000000000000000000000000000";

function gitError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function runGit(repo, args, options = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, ...(options.env || {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    throw gitError("ERR_GIT_GOVERNANCE_UNAVAILABLE", result.error.message, { args });
  }
  if (result.status !== 0 && options.allowFailure !== true) {
    throw gitError(
      "ERR_GIT_GOVERNANCE_COMMAND_FAILED",
      String(result.stderr || result.stdout || "git command failed").trim(),
      { args, status: result.status },
    );
  }
  return result;
}

function normalizeRevisionValue(value) {
  if (value == null) return null;
  if (typeof value === "object") return value.value || null;
  return String(value);
}

class GitGovernanceStore {
  constructor(repo, options = {}) {
    if (typeof repo !== "string" || !repo.trim()) {
      throw gitError("ERR_GIT_GOVERNANCE_REPO_REQUIRED", "GitGovernanceStore repository is required.");
    }
    this.repo = path.resolve(repo);
    this.ref = options.ref || "refs/heads/main";
    this.authorName = options.author_name || "Cortex Governance";
    this.authorEmail = options.author_email || "governance@cortex.local";

    const probe = runGit(this.repo, ["rev-parse", "--git-dir"], { allowFailure: true });
    if (probe.status !== 0) {
      throw gitError("ERR_GIT_GOVERNANCE_REPO_INVALID", "Governance store is not a Git repository.", {
        repo: this.repo,
      });
    }

    this._capabilities = normalizeGovernanceStoreCapabilities({
      read: true,
      write: true,
      compare_and_write: true,
      append: true,
      history: true,
      watch: false,
    });
  }

  capabilities() {
    return this._capabilities;
  }

  getHead() {
    const result = runGit(this.repo, ["rev-parse", "--verify", "--quiet", this.ref], {
      allowFailure: true,
    });
    if (result.status !== 0) return null;
    const value = String(result.stdout || "").trim();
    return value || null;
  }

  getRevision() {
    const head = this.getHead();
    return head ? createRevisionToken({ store_kind: GIT_STORE_KIND, value: head }) : null;
  }

  _findBlob(commit, key) {
    if (!commit) return null;
    const normalized = normalizeRelativeKey(key);
    const result = runGit(this.repo, ["ls-tree", "-z", commit, "--", normalized], {
      allowFailure: true,
    });
    if (result.status !== 0 || !result.stdout) return null;
    const entry = String(result.stdout).split("\0")[0];
    const match = /^[0-9]+\s+blob\s+([0-9a-f]{40,64})\t/.exec(entry);
    return match ? match[1] : null;
  }

  exists(key) {
    const head = this.getHead();
    return Boolean(this._findBlob(head, key));
  }

  readText(key, options = {}) {
    const normalized = normalizeRelativeKey(key);
    const head = this.getHead();
    const blob = this._findBlob(head, normalized);
    if (!blob) {
      if (options.required === false) {
        return {
          ok: true,
          exists: false,
          content: null,
          revision: head ? createRevisionToken({ store_kind: GIT_STORE_KIND, value: head }) : null,
          key: normalized,
        };
      }
      throw gitError("ERR_GOVERNANCE_STORE_NOT_FOUND", `GovernanceStore object not found: ${normalized}`, {
        key: normalized,
      });
    }
    const content = runGit(this.repo, ["cat-file", "-p", blob]).stdout;
    return {
      ok: true,
      exists: true,
      content,
      revision: createRevisionToken({ store_kind: GIT_STORE_KIND, value: head }),
      key: normalized,
      blob,
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

  _commitText(key, content, baseCommit, message) {
    const normalized = normalizeRelativeKey(key);
    const indexPath = path.join(
      os.tmpdir(),
      `cortex-governance-index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const env = { GIT_INDEX_FILE: indexPath };
    try {
      if (baseCommit) {
        runGit(this.repo, ["read-tree", baseCommit], { env });
      } else {
        runGit(this.repo, ["read-tree", "--empty"], { env });
      }

      const blob = String(
        runGit(this.repo, ["hash-object", "-w", "--stdin"], { input: content }).stdout || "",
      ).trim();
      runGit(this.repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${normalized}`], { env });
      const tree = String(runGit(this.repo, ["write-tree"], { env }).stdout || "").trim();

      const commitArgs = ["commit-tree", tree];
      if (baseCommit) commitArgs.push("-p", baseCommit);
      commitArgs.push("-m", message || `cortex governance: update ${normalized}`);

      const identityEnv = {
        GIT_AUTHOR_NAME: this.authorName,
        GIT_AUTHOR_EMAIL: this.authorEmail,
        GIT_COMMITTER_NAME: this.authorName,
        GIT_COMMITTER_EMAIL: this.authorEmail,
      };
      const commit = String(runGit(this.repo, commitArgs, { env: identityEnv }).stdout || "").trim();
      return { commit, blob, tree };
    } finally {
      try { fs.unlinkSync(indexPath); } catch (_) {}
    }
  }

  writeText(key, content, options = {}) {
    if (typeof content !== "string") {
      throw gitError("ERR_GOVERNANCE_STORE_CONTENT_INVALID", "GovernanceStore text content must be a string.");
    }
    const normalized = normalizeRelativeKey(key);
    const observedHead = this.getHead();
    const hasExpected = Object.prototype.hasOwnProperty.call(options, "expected_revision");
    const expectedValue = hasExpected ? normalizeRevisionValue(options.expected_revision) : observedHead;

    if (hasExpected && expectedValue !== observedHead) {
      throw new RevisionConflict({
        expected: expectedValue,
        actual: observedHead,
        resource: normalized,
      });
    }

    const prepared = this._commitText(
      normalized,
      content,
      observedHead,
      options.message,
    );

    const oldForCas = observedHead || ZERO_OID;
    const update = runGit(
      this.repo,
      ["update-ref", this.ref, prepared.commit, oldForCas],
      { allowFailure: true },
    );
    if (update.status !== 0) {
      const actual = this.getHead();
      throw new RevisionConflict({
        expected: expectedValue,
        actual,
        resource: normalized,
      });
    }

    return {
      ok: true,
      key: normalized,
      revision: createRevisionToken({ store_kind: GIT_STORE_KIND, value: prepared.commit }),
      commit: prepared.commit,
      blob: prepared.blob,
    };
  }

  writeJson(key, value, options = {}) {
    return this.writeText(key, JSON.stringify(value, null, 2) + "\n", options);
  }

  appendText(key, suffix, options = {}) {
    if (typeof suffix !== "string") {
      throw gitError("ERR_GOVERNANCE_STORE_CONTENT_INVALID", "Append content must be a string.");
    }
    const current = this.readText(key, { required: false });
    const expected = Object.prototype.hasOwnProperty.call(options, "expected_revision")
      ? options.expected_revision
      : current.revision;
    return this.writeText(key, (current.content || "") + suffix, {
      ...options,
      expected_revision: expected,
      message: options.message || `cortex governance: append ${normalizeRelativeKey(key)}`,
    });
  }

  history(options = {}) {
    const head = this.getHead();
    if (!head) return [];
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20;
    const format = "%H%x1f%P%x1f%an%x1f%ae%x1f%s";
    const result = runGit(this.repo, ["log", `-${limit}`, `--format=${format}`, this.ref]);
    return String(result.stdout || "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [commit, parents, author_name, author_email, subject] = line.split("\x1f");
        return {
          commit,
          parents: parents ? parents.split(" ").filter(Boolean) : [],
          author_name,
          author_email,
          subject,
        };
      });
  }
}

function createGitGovernanceStore(repo, options = {}) {
  return new GitGovernanceStore(repo, options);
}

module.exports = {
  GIT_STORE_KIND,
  ZERO_OID,
  GitGovernanceStore,
  createGitGovernanceStore,
};
