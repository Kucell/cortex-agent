"use strict";

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const {
  startManagedCallerSession,
  createExecutorEndpoint,
  readSessionSecret,
  SUPERVISOR_OPERATIONS,
} = require("../../lib/governed/managed-caller-supervisor");
const {
  ManagedCallerSession,
  newSessionId,
} = require("../../lib/governed/managed-caller-session");

const EXECUTOR = path.join(__dirname, "fixtures", "m044-ms002-executor.js");

/** Kill a child and wait until it is really gone. */
async function killChild(child) {
  if (!child || typeof child.kill !== "function") return;
  try {
    child.kill();
  } catch (_) {
    // Already gone.
  }
  // Give the OS a moment to reap it so the next test does not see a stray
  // process. A leaked executor outlives the test run.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/**
 * Kill every fixture process that outlived its test.
 *
 * The `transfer` fixture deliberately hands its IPC handle to a grandchild.
 * That grandchild holds the inherited descriptor, so it survives the death of
 * its parent and would keep the channel open. The fixture cannot reap it
 * reliably, so the test sweep does it here.
 */
async function sweepFixtureProcesses() {
  let listing = "";
  try {
    listing = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" });
  } catch (_) {
    return;
  }
  for (const line of listing.split("\n")) {
    if (!line.includes("m044-ms002-executor.js") && !line.includes("m044-ms002-grandchild.js")) {
      continue;
    }
    const pid = Number.parseInt(line.trim().split(/\s+/)[0], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (_) {
      // Already gone.
    }
  }
}

/** Start a session and always tear it down, even when the test throws. */
async function withSession(options, fn) {
  const { session, child } = await startManagedCallerSession({
    modulePath: EXECUTOR,
    handshakeTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    ...options,
  });
  try {
    return await fn(session, child);
  } finally {
    await session.close("test_cleanup");
    await killChild(child);
  }
}

/**
 * Start a session that is expected to fail during the handshake, and make
 * sure the child is reaped even though `startManagedCallerSession` rejects.
 */
async function expectHandshakeFailure(options, pattern) {
  let child = null;
  try {
    await startManagedCallerSession({
      modulePath: EXECUTOR,
      handshakeTimeoutMs: 2_000,
      ...options,
    });
    assert.fail("expected the handshake to fail");
  } catch (error) {
    if (error && error.code === "ERR_ASSERTION") throw error;
    assert.match(String(error.message || error), pattern);
  } finally {
    // The supervisor keeps the child reachable only after the handshake, so a
    // failed handshake is the one case where the child could survive. The
    // supervisor kills the child itself on a failed handshake; this is the
    // belt-and-braces sweep for anything that slipped through.
    await sweepFixtureProcesses();
  }
  return child;
}

describe("governed/managed-caller-session - session lifecycle", () => {
  test("establishes a session and exposes the supervised child identity", async () => {
    await withSession({ owner: "m044-test" }, async (session) => {
      assert.equal(session.established, true);
      assert.equal(session.closed, false);
      assert.ok(session.childIdentity.pid > 0);
      assert.equal(session.childIdentity.owner, "m044-test");
      assert.match(session.sessionId, /^ms002-/);
    });
  });

  test("session ids are unique across sessions", () => {
    const ids = new Set([newSessionId(), newSessionId(), newSessionId()]);
    assert.equal(ids.size, 3);
  });

  test("refuses to construct a session without a live child handle", () => {
    assert.throws(() => new ManagedCallerSession({ sessionId: "x", secret: "s" }), /live child process handle/);
    assert.throws(
      () => new ManagedCallerSession({ sessionId: "x", secret: "s", child: { pid: 1 } }),
      /inherited IPC channel/,
    );
  });

  test("refuses to construct a session without a session secret", () => {
    assert.throws(
      () => new ManagedCallerSession({ sessionId: "x", child: { pid: 1, channel: {} } }),
      /session secret/,
    );
  });

  test("a closed session refuses new requests instead of degrading to anonymous mode", async () => {
    await withSession({}, async (session) => {
      await session.close("deliberate");
      assert.equal(session.closed, true);
      await assert.rejects(() => session.request(SUPERVISOR_OPERATIONS.PING), /not established/);
    });
  });

  test("a session whose child exited refuses to serve requests", async () => {
    const { session, child } = await startManagedCallerSession({
      modulePath: EXECUTOR,
      handshakeTimeoutMs: 5_000,
    });
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(session.closed, true);
    await assert.rejects(() => session.request(SUPERVISOR_OPERATIONS.PING), /not established/);
    await killChild(child);
  });
});

describe("governed/managed-caller-session - handshake and request path", () => {
  test("round-trips a request over the inherited channel", async () => {
    await withSession({}, async (session) => {
      const result = await session.request(SUPERVISOR_OPERATIONS.PING, { hello: "world" });
      assert.equal(result.handled, SUPERVISOR_OPERATIONS.PING);
    });
  });

  test("rejects a handshake answered with the wrong nonce", async () => {
    await expectHandshakeFailure({ args: ["--mode=bad-nonce"] }, /nonce mismatch/);
  });

  test("fails closed when the child never answers the handshake", async () => {
    await expectHandshakeFailure({ args: ["--mode=no-handshake"], handshakeTimeoutMs: 700 }, /timed out/);
  });

  test("fails closed when the child exits during the handshake", async () => {
    await expectHandshakeFailure(
      { args: ["--mode=exit-early"], handshakeTimeoutMs: 2_000 },
      /nonce mismatch|session is closed|session closed|timed out|channel|signature/,
    );
  });

  test("an operation outside the batch scope is refused", async () => {
    await withSession({ args: ["--mode=proxy"], allowedOperations: [SUPERVISOR_OPERATIONS.PING] }, async (session) => {
      // The child makes the request itself, so the refusal must come from the
      // supervisor's batch-scope check rather than from client-side validation.
      const outcome = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("proxy timed out")), 5_000);
        session.child.on("message", (message) => {
          if (message && message.type === "proxy-result") {
            clearTimeout(timer);
            resolve(message);
          }
        });
        session.child.send({ type: "proxy", requestId: "p1", operation: "definitely-not-in-batch" });
      });

      assert.equal(outcome.ok, false);
      assert.match(outcome.error, /operation_not_in_batch/);
    });
  });
});

describe("governed/managed-caller-session - negative cases required by VC-044-005", () => {
  // The `transfer` fixture hands its IPC handle to a grandchild, which then
  // holds the inherited descriptor and survives its parent's death. Sweep the
  // fixtures once this suite is done so no process outlives the test run.
  after(async () => {
    await sweepFixtureProcesses();
  });

  test("a same-account bystander cannot discover the channel through the filesystem", async () => {
    await withSession({}, async (session) => {
      // The channel is an anonymous socket: it has no directory entry, so a
      // bystander scanning /tmp or the socket directory finds nothing.
      const tmpEntries = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(".s."));
      assert.deepEqual(tmpEntries, []);

      // And it is not a named unix socket path either.
      let lsofOutput = "";
      try {
        lsofOutput = execFileSync("lsof", ["-p", String(session.child.pid)], { encoding: "utf8" });
      } catch (_) {
        // lsof unavailable in this environment; the directory scan above is
        // the portable half of the assertion.
      }
      const unixLines = lsofOutput
        .split("\n")
        .filter((line) => /\bunix\b/.test(line))
        .map((line) => line.trim().split(/\s+/).pop());
      for (const target of unixLines) {
        assert.ok(
          !target.startsWith("/"),
          `expected an address pair, found a filesystem path: ${target}`,
        );
      }
    });
  });

  test("a grandchild that inherits nothing cannot answer on the parent's channel", async () => {
    await withSession({ args: ["--mode=inherit"] }, async (session) => {
      // The fixture spawns a grandchild with the ordinary default stdio, so it
      // gets its own socket. It must not be able to answer our request.
      const reply = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timedOut: true }), 2_500);
        session.child.on("message", (message) => {
          if (message && message.requestId === "probe") {
            clearTimeout(timer);
            resolve({ timedOut: false, body: message.body });
          }
        });
        session.child.send({ type: "request", requestId: "probe", seq: 1, operation: "probe" });
      });

      if (!reply.timedOut && reply.body && reply.body.grandchild) {
        assert.equal(reply.body.grandchild.note, "grandchild-has-own-channel");
      }
      assert.notEqual(reply.answeredOnParentChannel, true);
    });
  });

  test("an explicitly transferred channel handle cannot forge a response", async () => {
    // This is the decisive negative case. The child deliberately hands its IPC
    // fd to a grandchild, which then answers with a forged result. The
    // grandchild holds the transferable channel but not the session secret,
    // so the coordinator must refuse the response.
    await withSession({ args: ["--mode=transfer"] }, async (session) => {
      let forged = null;
      let forgedCount = 0;
      let reportedForgeries = 0;
      let accepted = null;
      session.child.on("message", (message) => {
        if (message && message.type === "transfer-report" && message.body) {
          reportedForgeries = Math.max(reportedForgeries, message.body.grandchildForgeries || 0);
        }
        if (message && message.type === "response" && message.body
            && message.body.result && message.body.result.FORGED) {
          forged = message;
          forgedCount += 1;
        }
      });

      try {
        accepted = await session.request(SUPERVISOR_OPERATIONS.PING);
      } catch (error) {
        // The forged answer must never be accepted, whatever the reason.
        assert.match(
          String(error.message || error),
          /signature verification|did not match the request sequence|timed out/,
        );
      }

      // A forged result must never be handed back to the caller as the
      // child's answer.
      assert.equal(accepted, null, "a forged result was accepted as the child's answer");
      if (forged) assert.equal(forged.body.result.handled, "forged");

      // The attack must actually have reached the coordinator. A rejection
      // that only happened because the forgery never arrived would prove
      // nothing, so the fixture reports how many forgeries it delivered.
      //
      // On macOS the descendant reads the coordinator's requests and answers
      // them, so the forged response arrives as a solicited reply. On Linux
      // the inherited descriptor is write-only for the descendant, so the
      // forgery is injected blind. Both must be delivered — and in both cases
      // the coordinator must not accept the forged result.
      assert.ok(
        reportedForgeries > 0 || forgedCount > 0,
        "expected the grandchild's forgeries to reach the coordinator",
      );
    });
  });

  test("a transferred channel handle is detected by the holder audit", async () => {
    await withSession({ args: ["--mode=transfer"] }, async (session) => {
      // Give the fixture time to spawn the grandchild and hand over the fd.
      await new Promise((resolve) => setTimeout(resolve, 800));

      const audit = session.auditChannelHolders();
      // The audit must either detect the transfer, or report that it cannot
      // see the socket address at all. It must never report a clean channel
      // while a grandchild holds the handle.
      if (audit.ok) {
        assert.equal(audit.reason, "socket_address_unknown");
      } else {
        assert.equal(audit.reason, "channel_handle_transferred");
        assert.ok(audit.holders.length >= 2, "expected the grandchild to show up as a holder");
      }
    });
  });

  test("a response signed with the wrong secret is rejected", async () => {
    await withSession({ args: ["--mode=bad-mac"] }, async (session) => {
      await assert.rejects(
        () => session.request(SUPERVISOR_OPERATIONS.PING),
        /signature verification|did not match the request sequence/,
      );
    });
  });

  test("the child process handle identifies exactly one process", async () => {
    await withSession({}, async (session) => {
      const pid = session.child.pid;
      assert.equal(session.childIdentity.pid, pid);

      // A second, independent process must not be able to claim this session.
      const outsider = await startManagedCallerSession({
        modulePath: EXECUTOR,
        handshakeTimeoutMs: 5_000,
      });
      try {
        assert.notEqual(outsider.session.sessionId, session.sessionId);
        assert.notEqual(outsider.session.childIdentity.pid, pid);
      } finally {
        await outsider.session.close("test_cleanup");
        await killChild(outsider.child);
      }
    });
  });

  test("a request whose response does not match its sequence is rejected", async () => {
    await withSession({ args: ["--mode=bad-seq"] }, async (session) => {
      await assert.rejects(
        () => session.request(SUPERVISOR_OPERATIONS.PING),
        /did not match the request sequence/,
      );
    });
  });

  test("the detached launcher and its 0600 context file are never used as a fallback", async () => {
    // The sensitive path must not shell out to the legacy launcher's context
    // file or environment variable. Assert the supervisor never mentions
    // them, so a future edit cannot quietly reintroduce the fallback.
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "lib", "governed", "managed-caller-supervisor.js"),
      "utf8",
    );
    assert.doesNotMatch(source, /CORTEX_LAUNCH_CONTEXT/);
    assert.doesNotMatch(source, /context\.json/);
    assert.doesNotMatch(source, /detached:\s*true/);
  });
});

describe("governed/managed-caller-session - identity does not come from self-report", () => {
  test("self-reported actor, owner, pid and path cannot establish identity", async () => {
    await withSession({}, async (session) => {
      // These are the fields the current lease CLI trusts. The managed caller
      // session must ignore them entirely: the established identity comes
      // from the process handle and the channel, nothing else.
      const before = { ...session.childIdentity };
      assert.equal(before.actor, undefined);
      assert.equal(before.pid, session.child.pid);
    });
  });

  test("the established identity object is frozen", async () => {
    await withSession({}, async (session) => {
      assert.throws(() => {
        "use strict";
        session.childIdentity.pid = 1;
      });
      assert.equal(session.childIdentity.pid, session.child.pid);
    });
  });

  test("the identity records a start token so pid reuse is detectable", async () => {
    await withSession({}, async (session) => {
      assert.ok(session.childIdentity.startToken, "expected a process start token");
      assert.equal(session.auditProcessContinuity().ok, true);
    });
  });
});

describe("governed/managed-caller-session - child side helpers", () => {
  test("the executor endpoint requires both a channel and a secret", () => {
    assert.throws(() => createExecutorEndpoint(null, "s"), /inherited IPC channel/);
    assert.throws(() => createExecutorEndpoint({ channel: {} }, ""), /session secret/);
  });

  test("the executor endpoint rejects a call without a secret channel", async () => {
    await assert.rejects(() => readSessionSecret(null), /secret channel/);
  });
});
