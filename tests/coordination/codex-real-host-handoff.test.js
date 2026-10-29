"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const {
  deliverCodexWakeup,
  validateThreadId,
} = require("../../lib/coordination/codex-app-server-client");
const { buildRequest, parseOptions } = require("../../scripts/validation/codex-notification-live-smoke");

function fakeAppServer(options = {}) {
  const requests = [];
  let child;
  const spawn = () => {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
      return true;
    };
    child.stdin = new Writable({
      write(chunk, encoding, done) {
        for (const line of chunk.toString("utf8").trim().split("\n")) {
          if (!line) continue;
          const msg = JSON.parse(line);
          requests.push(msg);
          if (typeof msg.id !== "number") continue;
          setImmediate(() => {
            if (msg.method === "initialize") respond(msg.id, {});
            else if (msg.method === "thread/resume") {
              respond(msg.id, { thread: { id: options.mismatch ? "other-thread" : msg.params.threadId } });
            } else if (msg.method === "turn/start") {
              if (options.busy) {
                child.stdout.write(JSON.stringify({
                  id: msg.id, error: { code: -32000, message: "thread busy" },
                }) + "\n");
              } else {
                respond(msg.id, { turn: { id: "turn-smoke" } });
                notify("turn/completed", {
                  threadId: msg.params.threadId,
                  turn: { id: "turn-smoke", status: options.status || "completed" },
                });
              }
            }
          });
        }
        done();
      },
    });
    return child;
  };
  function respond(id, result) {
    child.stdout.write(JSON.stringify({ id, result }) + "\n");
  }
  function notify(method, params) {
    child.stdout.write(JSON.stringify({ method, params }) + "\n");
  }
  return { requests, spawn };
}

test("smoke CLI defaults to no side effects and does not need a real host", () => {
  const options = parseOptions(["--thread-id", "thread-safe"], {});
  assert.equal(options.execute, false);
  assert.equal(options.threadId, "thread-safe");
  assert.equal(options.timeoutMs, 120000);
  assert.equal(buildRequest().requestedAction, null);
});

test("unsafe or missing thread identifiers are rejected before a wakeup", () => {
  assert.throws(() => parseOptions(["--thread-id", "../thread", "--execute"], {}));
  assert.throws(() => parseOptions(["--execute"], {}));
  assert.throws(() => validateThreadId("thread id with spaces"));
  assert.throws(() => parseOptions(["--timeout-ms", "0", "--thread-id", "ok"], {}));
});

test("real-host adapter protocol completes initialize, resume, start, completed", async () => {
  const host = fakeAppServer();
  const result = await deliverCodexWakeup(buildRequest(), {
    threadId: "thread-safe", spawn: host.spawn, timeoutMs: 2000,
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(host.requests.map((req) => req.method), [
    "initialize", "initialized", "thread/resume", "turn/start",
  ]);
  const wake = host.requests.find((req) => req.method === "turn/start");
  assert.equal(wake.params.threadId, "thread-safe");
  assert.match(wake.params.input[0].text, /This is a notification, not authorization/);
});

test("non-completed turns do not count as delivered", async () => {
  const host = fakeAppServer({ status: "failed" });
  await assert.rejects(
    deliverCodexWakeup(buildRequest(), {
      threadId: "thread-safe", spawn: host.spawn, timeoutMs: 2000,
    }),
    (error) => error.code === "ERR_CODEX_TURN_NOT_COMPLETED",
  );
});

test("busy threads fail closed without redirecting or approving permissions", async () => {
  const host = fakeAppServer({ busy: true });
  await assert.rejects(
    deliverCodexWakeup(buildRequest(), {
      threadId: "thread-safe", spawn: host.spawn, timeoutMs: 2000,
    }),
    (error) => error.code === "ERR_CODEX_APP_SERVER_RPC",
  );
  assert.equal(host.requests.filter((req) => req.method === "turn/start").length, 1);
  assert.equal(host.requests.some((req) => req.method === "turn/steer"), false);
  assert.equal(host.requests.some((req) => req.method === "approval/approve"), false);
});

test("thread mismatch blocks cross-session delivery", async () => {
  const host = fakeAppServer({ mismatch: true });
  await assert.rejects(
    deliverCodexWakeup(buildRequest(), {
      threadId: "thread-safe", spawn: host.spawn, timeoutMs: 2000,
    }),
    (error) => error.code === "ERR_CODEX_THREAD_MISMATCH",
  );
  assert.equal(host.requests.some((req) => req.method === "turn/start"), false);
});
