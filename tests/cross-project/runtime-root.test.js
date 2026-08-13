"use strict";

// Regression for T-RUNTIME-IGNORE-001:
//
// Every Cross-Project Bridge write path (subscriptions / inbox / outbox /
// cursors) must, on its first write into `.agent-runtime/cross-project/…`,
// also seed the runtime root with a `.gitignore` whose payload is exactly
//
//     *
//     !.gitignore
//
// and whose mode is 0o600. Previously each writer only `mkdirSync`-ed the
// cross-project subdir and left `.agent-runtime/.gitignore` uncreated, so
// bridge data could end up in version control via `git add .`.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const subscriptions = require("../../lib/cross-project/subscriptions");
const inboxStore = require("../../lib/cross-project/inbox-store");
const outbox = require("../../lib/cross-project/outbox");
const bridgeSync = require("../../lib/cross-project/bridge-sync");

const RUNTIME_GITIGNORE_BODY = "*\n!.gitignore\n";
const RUNTIME_GITIGNORE_MODE = 0o600;

function mkRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withRoot(prefix, fn) {
  return (t) => {
    const root = mkRoot(prefix);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return fn(t, root);
  };
}

function assertRuntimeGitignore(root) {
  const target = path.join(root, ".agent-runtime", ".gitignore");
  assert.equal(fs.existsSync(target), true,
    `.agent-runtime/.gitignore must exist after first Bridge write into ${root}`);
  const stat = fs.statSync(target);
  // mask off type bits so we only compare permission bits.
  assert.equal(stat.mode & 0o777, RUNTIME_GITIGNORE_MODE,
    `.agent-runtime/.gitignore must be mode 0o600, got 0o${(stat.mode & 0o777).toString(8)}`);
  assert.equal(fs.readFileSync(target, "utf8"), RUNTIME_GITIGNORE_BODY,
    `.agent-runtime/.gitignore must contain exactly "*\\n!.gitignore\\n"`);
}

function mkEvent(overrides = {}) {
  return {
    bridge_event_id: "BR-EVT-runtime-001",
    source_project_id: "cortex-agent",
    event_type: "task.state_changed",
    summary: { to_state: "READY_FOR_REVIEW" },
    propagated_at: "2026-08-12T00:00:00.000Z",
    correlation_group: "agentic-ui-delivery",
    ...overrides,
  };
}

// ─── subscriptions writer ──────────────────────────────────────────────────

test("addSubscription seeds .agent-runtime/.gitignore on cold start",
  withRoot("cortex-runtime-sub-", (t, root) => {
    subscriptions.addSubscription(root, {
      source_project_id: "cortex-agent",
      event_types: ["task.state_changed"],
    });
    assertRuntimeGitignore(root);
  }),
);

// ─── inbox writer ──────────────────────────────────────────────────────────

test("writeInboxEntry seeds .agent-runtime/.gitignore on cold start",
  withRoot("cortex-runtime-inbox-", (t, root) => {
    inboxStore.writeInboxEntry(root, "cortex-agent", mkEvent());
    assertRuntimeGitignore(root);
  }),
);

// ─── outbox writer ─────────────────────────────────────────────────────────

test("writeEvent seeds .agent-runtime/.gitignore on cold start",
  withRoot("cortex-runtime-outbox-", (t, root) => {
    outbox.writeEvent(root, {
      source_project_id: "cortex-agent",
      event_type: "task.state_changed",
      summary: { to_state: "READY_FOR_REVIEW" },
      correlation_group: "agentic-ui-delivery",
      bridge_event_id: "BR-EVT-runtime-002",
      propagated_at: "2026-08-12T00:00:00.000Z",
    });
    assertRuntimeGitignore(root);
  }),
);

// ─── cursors writer (via bridge-sync) ──────────────────────────────────────

test("syncForProject seeds .agent-runtime/.gitignore on cold start",
  withRoot("cortex-runtime-cursor-", (t, root) => {
    // Seed a source outbox directory under a second mkdtemp so the sync has
    // something to read from.
    const sourceRoot = mkRoot("cortex-runtime-src-");
    t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
    const writeRes = outbox.writeEvent(sourceRoot, {
      source_project_id: "cortex-agent",
      event_type: "task.state_changed",
      summary: { to_state: "READY_FOR_REVIEW" },
      correlation_group: "agentic-ui-delivery",
      bridge_event_id: "BR-EVT-runtime-003",
      propagated_at: "2026-08-12T00:00:00.000Z",
    });
    assert.equal(writeRes.ok, true);

    subscriptions.addSubscription(root, {
      source_project_id: "cortex-agent",
      event_types: ["task.state_changed"],
    });
    // Bridge-sync writes cursors on its first successful write; calling it
    // before the inbox/cursors writer runs triggers the cold-start codepath.
    const result = bridgeSync.syncForProject(root, {
      sourceProjectId: "cortex-agent",
      sourceRoot,
    });
    assert.equal(result.ok, true);
    assert.equal(result.written >= 1, true,
      "expected syncForProject to write at least one inbox entry");
    assertRuntimeGitignore(root);
  }),
);

// ─── idempotency: pre-existing .gitignore is preserved ─────────────────────

test("existing .agent-runtime/.gitignore is not overwritten",
  withRoot("cortex-runtime-keep-", (t, root) => {
    const runtimeDir = path.join(root, ".agent-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const ignorePath = path.join(runtimeDir, ".gitignore");
    const customBody = "# managed by hand\n";
    fs.writeFileSync(ignorePath, customBody, { encoding: "utf8", mode: 0o644 });

    subscriptions.addSubscription(root, {
      source_project_id: "cortex-agent",
      event_types: ["task.state_changed"],
    });
    assert.equal(fs.readFileSync(ignorePath, "utf8"), customBody,
      "pre-existing .gitignore must not be overwritten");
  }),
);