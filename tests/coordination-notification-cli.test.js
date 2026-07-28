"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const contract = require("../lib/cli-contract");
const notificationCli = require("../lib/coordination/notification-cli");
const cliContract = require("../lib/cli-contract");

const { EXIT, ERR, ADAPTER_WHITELIST, ACTOR_KINDS } = notificationCli;

const BASE_PROJECT = "/tmp/cortex-notification-cli";
const BASE_FLAGS = [
  "--project", BASE_PROJECT,
  "--consumer", "consumer:a",
  "--target", "agent:owner-1",
  "--adapter", "noop",
];

function withArgs(...extra) {
  return ["notification", "pump", ...BASE_FLAGS, ...extra];
}

function pumpHarness(overrides = {}) {
  const calls = { runOnce: 0, stop: 0, status: 0 };
  const pump = {
    async runOnce() {
      calls.runOnce += 1;
      return { scanned: 0, delivered: 0, acknowledged: 0, deferred: 0, failed: 0 };
    },
  };
  const harness = {
    async resolvePump() {
      return {
        pump,
        stop: async () => { calls.stop += 1; },
        getStatus: async () => ({ cursor: { keys: 0 }, pending: {} }),
        ...overrides,
      };
    },
    notify: () => { /* silent */ },
  };
  return { harness, calls };
}

// ─── Contract plumbing ──────────────────────────────────────────────────────

test("cli-contract registers notification command and whitelist", () => {
  const entry = contract.commands.find((cmd) => cmd.name === "notification");
  assert.ok(entry, "notification command missing");
  assert.equal(entry.thin, true);
  assert.match(entry.usage, /^notification <pump>/);

  const optionNames = contract.options.map((opt) => opt.name.split(" ")[0]);
  for (const required of ["--consumer", "--target", "--adapter", "--once", "--watch", "--status", "--stop"]) {
    assert.ok(optionNames.includes(required), `missing option ${required}`);
  }

  assert.ok(contract.notification);
  assert.deepEqual(contract.notification.pump.adapter_whitelist, ADAPTER_WHITELIST);
  assert.equal(contract.notification.contract_version, 1);
  assert.equal(contract.notification.pump.required_flags.length, 4);
  for (const required of ["--project", "--consumer", "--target", "--adapter"]) {
    assert.ok(contract.notification.pump.required_flags.includes(required), `required flags missing ${required}`);
  }
});

test("cli-contract exit codes are stable and documented", () => {
  const codes = contract.notification.pump.exit_codes;
  assert.equal(codes[0], "success");
  assert.equal(codes[1], "invalid usage");
  assert.equal(codes[2], "unsupported");
  assert.equal(codes[3], "runtime failure");
  assert.equal(codes[4], "capability unavailable");
});

test("cli-contract surface explicitly forbids event.command / event.executable", () => {
  const limits = contract.notification.cli_surface_limits;
  assert.ok(limits.some((line) => line.includes("event.command")));
  assert.ok(limits.some((line) => line.includes("event.executable")));
});

// ─── Pure parser ────────────────────────────────────────────────────────────

test("parseNotificationArgs succeeds for --once with all required flags", () => {
  const result = notificationCli.parseNotificationArgs(withArgs("--once"));
  assert.equal(result.ok, true);
  assert.equal(result.action, "once");
  assert.equal(result.exitCode, EXIT.SUCCESS);
  assert.equal(result.options.project, BASE_PROJECT);
  assert.equal(result.options.consumer, "consumer:a");
  assert.deepEqual(result.options.target, { kind: "agent", actorId: "owner-1", raw: "agent:owner-1" });
  assert.equal(result.options.adapter, "noop");
  assert.equal(result.options.intervalMs, undefined);
  assert.equal(result.options.maxAttempts, undefined);
});

test("parseNotificationArgs returns INVALID_USAGE when --project is missing", () => {
  const args = ["notification", "pump", "--consumer", "c", "--target", "agent:a", "--adapter", "noop", "--once"];
  const result = notificationCli.parseNotificationArgs(args);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.INVALID_USAGE);
  assert.equal(result.error.code, ERR.INVALID_USAGE);
  assert.match(result.error.message, /--project/);
});

test("parseNotificationArgs returns INVALID_USAGE when --consumer is missing", () => {
  const args = ["notification", "pump", "--project", "/tmp/p", "--target", "agent:a", "--adapter", "noop", "--once"];
  const result = notificationCli.parseNotificationArgs(args);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.INVALID_USAGE);
  assert.match(result.error.message, /--consumer/);
});

test("parseNotificationArgs rejects malformed --target", () => {
  const args = withArgs("--once");
  args[args.indexOf("--target") + 1] = "agent"; // missing actorId
  const result = notificationCli.parseNotificationArgs(args);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.INVALID_USAGE);
  assert.match(result.error.message, /<kind>:<actorId>/);
});

test("parseNotificationArgs rejects target kind outside the actor vocabulary", () => {
  const args = withArgs("--once");
  args[args.indexOf("--target") + 1] = "ghost:actor-1";
  const result = notificationCli.parseNotificationArgs(args);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.INVALID_USAGE);
  assert.match(result.error.message, /coordinator/);
});

test("parseNotificationArgs rejects adapter not in whitelist", () => {
  const args = withArgs("--once");
  args[args.indexOf("--adapter") + 1] = "curl";
  const result = notificationCli.parseNotificationArgs(args);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.INVALID_USAGE);
  assert.match(result.error.message, /whitelist/);
  assert.deepEqual(result.error.details.whitelist, ADAPTER_WHITELIST);
});

test("parseNotificationArgs rejects consumer id with unsafe characters", () => {
  const args = withArgs("--once");
  args[args.indexOf("--consumer") + 1] = "consumer;rm -rf";
  const result = notificationCli.parseNotificationArgs(args);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.INVALID_USAGE);
});

test("parseNotificationArgs rejects when zero action flags are set", () => {
  const result = notificationCli.parseNotificationArgs(["notification", "pump", ...BASE_FLAGS]);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.INVALID_USAGE);
  assert.match(result.error.message, /Exactly one of/);
});

test("parseNotificationArgs rejects when multiple action flags are set", () => {
  const result = notificationCli.parseNotificationArgs(withArgs("--once", "--status"));
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.INVALID_USAGE);
  assert.deepEqual(result.error.details.conflicting.sort(), ["once", "status"]);
});

test("parseNotificationArgs rejects bad --interval-ms", () => {
  const result = notificationCli.parseNotificationArgs(withArgs("--once", "--interval-ms", "100"));
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.INVALID_USAGE);
  assert.match(result.error.message, /interval-ms/);
});

test("parseNotificationArgs rejects bad --max-attempts", () => {
  const result = notificationCli.parseNotificationArgs(withArgs("--once", "--max-attempts", "0"));
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.INVALID_USAGE);
  assert.match(result.error.message, /max-attempts/);
});

test("parseNotificationArgs accepts --interval-ms within range and captures eventId", () => {
  const result = notificationCli.parseNotificationArgs(withArgs("--once", "--interval-ms", "5000", "--max-attempts", "7", "--event", "CE-abc"));
  assert.equal(result.ok, true);
  assert.equal(result.options.intervalMs, 5000);
  assert.equal(result.options.maxAttempts, 7);
  assert.equal(result.options.eventId, "CE-abc");
});

test("parseNotificationArgs returns UNSUPPORTED on unknown second verb", () => {
  const result = notificationCli.parseNotificationArgs(["notification", "explode"]);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.UNSUPPORTED);
  assert.match(result.error.message, /explode/);
});

test("parseNotificationArgs returns UNSUPPORTED on missing subcommand", () => {
  const result = notificationCli.parseNotificationArgs(["notification"]);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.UNSUPPORTED);
  assert.equal(result.error.code, ERR.UNSUPPORTED);
});

test("parseNotificationArgs rejects when first arg is not 'notification'", () => {
  const result = notificationCli.parseNotificationArgs(["task", "list"]);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.INVALID_USAGE);
});

test("CLI surface strips event.command / event.executable — parser never accepts them", () => {
  // The CLI does not even define those flags. This guards against a future
  // regression where someone re-adds them as input.
  const noise = withArgs("--once", "--event-command", "rm -rf /", "--event-executable", "/bin/sh");
  const result = notificationCli.parseNotificationArgs(noise);
  assert.equal(result.ok, true);
  assert.equal(result.options.eventId, undefined);
  assert.equal("command" in result.options, false);
  assert.equal("executable" in result.options, false);
});

// ─── Dependency-injection harness ───────────────────────────────────────────

test("executeNotificationCommand --once delegates to the injected pump", async () => {
  const { harness, calls } = pumpHarness();
  const result = await notificationCli.executeNotificationCommand(withArgs("--once"), harness);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, EXIT.SUCCESS);
  assert.equal(result.action, "once");
  assert.equal(calls.runOnce, 1);
  assert.equal(calls.stop, 0);
});

test("executeNotificationCommand --status returns payload from the harness", async () => {
  const { harness } = pumpHarness();
  const result = await notificationCli.executeNotificationCommand(withArgs("--status"), harness);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, EXIT.SUCCESS);
  assert.equal(result.action, "status");
  assert.ok(result.report);
  assert.equal(result.report.cursor.keys, 0);
});

test("executeNotificationCommand --stop calls harness.stop", async () => {
  const { harness, calls } = pumpHarness();
  const result = await notificationCli.executeNotificationCommand(withArgs("--stop"), harness);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, EXIT.SUCCESS);
  assert.equal(calls.stop, 1);
});

test("executeNotificationCommand fails CAPABILITY when no harness is provided", async () => {
  const result = await notificationCli.executeNotificationCommand(withArgs("--once"));
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.CAPABILITY);
  assert.equal(result.error.code, ERR.CAPABILITY);
});

test("executeNotificationCommand fails CAPABILITY when harness lacks runOnce", async () => {
  const harness = { async resolvePump() { return { pump: {}, stop: async () => {}, getStatus: async () => ({}) }; } };
  const result = await notificationCli.executeNotificationCommand(withArgs("--once"), harness);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.CAPABILITY);
});

test("executeNotificationCommand maps pump errors to runtime exit code", async () => {
  const harness = {
    async resolvePump() {
      return {
        pump: {
          async runOnce() {
            const error = new Error("journal unreadable");
            error.code = "ERR_JOURNAL_READ";
            throw error;
          },
        },
        stop: async () => {},
        getStatus: async () => ({}),
      };
    },
  };
  const result = await notificationCli.executeNotificationCommand(withArgs("--once"), harness);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT.RUNTIME);
  assert.equal(result.error.code, ERR.RUNTIME);
  assert.match(result.error.message, /journal unreadable/);
  assert.equal(result.error.details.originalCode, "ERR_JOURNAL_READ");
});

test("executeNotificationCommand --watch exits via stop flag without sleeping full interval", async () => {
  const harness = {
    async resolvePump() {
      return {
        pump: { async runOnce() { return { scanned: 0, delivered: 1 }; } },
        stop: async () => {},
        getStatus: async () => ({}),
      };
    },
    notify: () => {},
  };
  const start = Date.now();
  const runPromise = notificationCli.executeNotificationCommand(
    withArgs("--watch", "--interval-ms", "10000"),
    harness,
  );
  // Trigger stop after a short delay (well under the 10s interval).
  setTimeout(() => {
    if (typeof global.__cortexNotificationStopFlag === "function") {
      global.__cortexNotificationStopFlag();
    }
  }, 100);
  const result = await runPromise;
  const elapsed = Date.now() - start;
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, EXIT.SUCCESS);
  assert.equal(result.action, "watch");
  assert.ok(elapsed < 5000, `watch loop did not respect stop flag (elapsed=${elapsed}ms)`);
  assert.equal(global.__cortexNotificationStopFlag, undefined, "stop flag must be cleared after watch ends");
});

// ─── help notification --json / contract discovery ──────────────────────────

test("describeNotificationContract exposes the public surface for help --json", () => {
  const desc = notificationCli.describeNotificationContract();
  assert.deepEqual(desc.adapter_whitelist, ADAPTER_WHITELIST);
  assert.deepEqual(desc.action_flags, ["once", "watch", "status", "stop"]);
  assert.equal(desc.action_exclusivity, "exactly_one");
  assert.ok(desc.event_surface_limits.some((line) => line.includes("event.command")));
  assert.ok(desc.event_surface_limits.some((line) => line.includes("event.executable")));
  assert.deepEqual(desc.target_kind_vocabulary, ACTOR_KINDS);
  assert.equal(desc.exit_codes[0], "success");
  assert.equal(desc.exit_codes[4], "capability unavailable");
});

test("cli-contract --json surfaces the notification segment under the contract root", () => {
  const payload = contract;
  assert.ok(payload.notification);
  assert.equal(payload.notification.pump.action_flags.once.flag, "--once");
  assert.equal(payload.notification.pump.action_flags.watch.flag, "--watch");
  assert.equal(payload.notification.pump.action_flags.status.flag, "--status");
  assert.equal(payload.notification.pump.action_flags.stop.flag, "--stop");
  assert.equal(payload.notification.pump.action_exclusivity.includes("Exactly one"), true);
});

// ─── Adapter whitelist & integration notes ──────────────────────────────────

test("adapter whitelist contains only the public set", () => {
  assert.deepEqual(ADAPTER_WHITELIST.slice().sort(), ["claude-code", "codex", "noop", "webhook"]);
});

test("contract advertises an integration_notes section", () => {
  const notes = contract.notification.integration_notes;
  assert.ok(Array.isArray(notes) && notes.length > 0);
  assert.ok(notes.some((line) => line.includes("lib/coordination/notification-cli.js")));
  assert.ok(notes.some((line) => line.includes("do NOT directly require")));
});

// ─── Thin adapter boundary ──────────────────────────────────────────────────

test("notification-cli.js does not require runtime journal or pump modules", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "lib", "coordination", "notification-cli.js"),
    "utf8",
  );
  // Strip the doc-comment header so the policy text doesn't trip the grep —
  // the doc-comment explicitly names the forbidden modules to declare the
  // boundary, but the actual require() / import statements must be absent.
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const forbidden = [
    "notification-pump",
    "./journal",
    "consumer-cursor",
    "application-service",
    "claude-adapter",
    "codex-adapter",
  ];
  for (const token of forbidden) {
    assert.ok(
      !codeOnly.includes(token),
      `notification-cli.js must not depend on runtime module ${token}`,
    );
  }
  // Sanity-check the file declares the public parser entry we rely on.
  assert.ok(source.includes("parseNotificationArgs"));
  assert.match(source, /module\.exports\s*=\s*\{[\s\S]*parseNotificationArgs/);
});

test("cli-contract matches the thin adapter's whitelist and exit codes", () => {
  assert.deepEqual(
    contract.notification.pump.adapter_whitelist,
    notificationCli.ADAPTER_WHITELIST,
  );
  for (const key of Object.keys(notificationCli.EXIT)) {
    const numeric = notificationCli.EXIT[key];
    assert.ok(contract.notification.pump.exit_codes[numeric] !== undefined);
  }
});

// Reference cliContract to silence unused-import lint when only used above.
test("cliContract reference is non-empty", () => {
  assert.ok(cliContract.commands.length > 0);
});
