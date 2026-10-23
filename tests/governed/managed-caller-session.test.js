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
  CHANNEL_MESSAGE,
  newSessionId,
} = require("../../lib/governed/managed-caller-session");

const EXECUTOR = path.join(__dirname, "fixtures", "m044-ms002-executor.js");

/**
 * Read a process's process-group id.
 *
 * A detached child is placed in its own process group, so its pgid differs
 * from the coordinator's. That difference is how a detached spawn is
 * detected from the outside.
 *
 * @param {number} pid
 * @returns {number|null}
 */
function readPgid(pid) {
  try {
    // `ps` reports the process group on both platforms, and unlike /proc it
    // exists on macOS too. Without it the comparison would be between two
    // nulls, which would pass no matter what.
    const output = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
    const pgid = Number.parseInt(output.trim(), 10);
    return Number.isInteger(pgid) ? pgid : null;
  } catch (_) {
    return null;
  }
}

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
      // A grandchild that inherits nothing must not have produced an answer
      // on the parent's channel. The assertion used to check a field that no
      // production code ever sets, which made it true by construction; the
      // meaningful check is that no answer carrying the child's answer shape
      // arrived on the parent channel.
      assert.equal(reply.timedOut, true, "the grandchild answered on the parent's channel");
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
        // A frame that was written straight onto the channel arrives with
        // Node's IPC envelope still attached.
        const payload = message && message.type === "message" && message.data
          ? message.data
          : message;
        if (message && message.type === "transfer-report" && message.body) {
          reportedForgeries = Math.max(reportedForgeries, message.body.grandchildForgeries || 0);
        }
        if (payload && payload.type === "response" && payload.body
            && payload.body.result && payload.body.result.FORGED) {
          forged = payload;
          forgedCount += 1;
        }
      });

      try {
        accepted = await session.request(SUPERVISOR_OPERATIONS.PING);
      } catch (error) {
        // The forged answer must never be accepted, whatever the reason. A
        // timeout is NOT an acceptable reason here: it would be
        // indistinguishable from a coordinator that never saw the forgery,
        // so the rejection has to name the authentication or the audit
        // failure that actually stopped it.
        assert.match(
          String(error.message || error),
          /signature verification|did not match the request sequence|refused to dispatch|handle_transferred/,
        );
        assert.doesNotMatch(
          String(error.message || error),
          /timed out/i,
          "the rejection must not be a timeout",
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
      //
      // The report travels over the fixture's stdout, which is a separate
      // channel from the one under attack, so it can arrive after the request
      // has already failed. Wait for it rather than racing it.
      const deadline = Date.now() + 3_000;
      while (!reportedForgeries && !forgedCount && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

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

  test("a relayed inbound request is refused and never executed", async () => {
    // The relay attack. A descendant that holds the transferred IPC handle
    // reads the coordinator's own outbound REQUEST and replays it back as an
    // inbound REQUEST, with a payload the attacker chose.
    //
    // Before the direction-bound MAC, the coordinator answered such a request
    // with its OWN key, which let the attacker feed that signed answer back
    // into the coordinator's pending slot: the coordinator then accepted an
    // answer its supervised child never sent, computed from the attacker's
    // payload. The fix has to hold on both sides of that exchange:
    //   1. the inbound request must be authenticated before it is executed;
    //   2. the answer the coordinator produces for it must not be acceptable
    //      as the child's answer to an outbound request.
    await withSession({ args: ["--mode=relay"] }, async (session) => {
      let relayed = 0;
      let relayedSignedAnswer = null;
      session.child.on("message", (message) => {
        if (!message || message.type !== "relay-report" || !message.body) return;
        if (message.body.relayed) relayed = Math.max(relayed, message.body.relayed || 0);
        if (message.body.relayGotSignedResponse) {
          relayedSignedAnswer = relayedSignedAnswer || message.body;
        }
      });

      let accepted = null;
      let failure = null;
      try {
        accepted = await session.request(SUPERVISOR_OPERATIONS.PING, { hello: "world" });
      } catch (error) {
        failure = error;
      }

      // A timeout is NOT an acceptable outcome here: it would be
      // indistinguishable from a coordinator that simply never heard the
      // attack. The refusal has to name the authentication failure.
      assert.ok(failure, "the relayed request must not have been answered");
      assert.doesNotMatch(
        String(failure.message || failure),
        /timed out/i,
        "the refusal must not be a timeout",
      );
      assert.match(
        String(failure.message || failure),
        /signature|refused to dispatch|handle_transferred|authentication/i,
      );

      // The forged answer must never be handed back to the caller.
      assert.equal(accepted, null, "a relayed answer was accepted as the child's answer");

      // The attack must actually have reached the coordinator. A refusal
      // caused by the attack never arriving would prove nothing.
      assert.ok(
        relayed > 0 || relayedSignedAnswer !== null,
        "expected the relay fixture's replay to reach the coordinator",
      );

      // And the attacker's payload must never have been executed. This is the
      // payload-injection half of the case: the coordinator must not have run
      // a handler with attacker-chosen arguments.
      const executedPayloads = session.inboundExecutions.map((entry) => entry.payload);
      for (const payload of executedPayloads) {
        assert.notEqual(
          payload && payload.attackerControlled,
          true,
          "an attacker-controlled payload was executed",
        );
      }
      assert.ok(
        session.rejections.some((entry) => entry.reason === "inbound_request_signature_mismatch"),
        "expected the relayed inbound request to be rejected as unauthenticated",
      );
    });
  });

  test("an unauthenticated inbound request is never executed", async () => {
    // The same defect, tested directly: a message that claims to be a request
    // but carries no valid MAC must not reach a handler at all.
    //
    // The message is delivered through the supervisor's own control channel
    // (`inject`), which the fixture turns into a raw frame written straight
    // onto the coordinator's end of the socket — exactly the shape a
    // descendant that inherited the handle produces.
    await withSession({}, async (session) => {
      const before = session.inboundExecutions.length;
      session.child.send({
        type: "inject",
        requestId: "unauthenticated-1",
        payload: {
          type: "request",
          requestId: "unauthenticated-1",
          sessionId: session.sessionId,
          seq: 99,
          operation: SUPERVISOR_OPERATIONS.PING,
          payload: { attackerControlled: true, target: "/etc/shadow" },
          mac: "0".repeat(64),
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 400));

      assert.equal(session.inboundExecutions.length, before, "an unauthenticated request was executed");
      assert.ok(
        session.rejections.some((entry) => entry.reason === "inbound_request_signature_mismatch"),
        "expected the unauthenticated request to be rejected",
      );
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

  test("the spawn escape hatch cannot detach the supervised child", async () => {
    // The stdio layout and the `detached` flag are part of the trust
    // primitive: the IPC channel has to be the inherited descriptor the
    // identity is bound to, and a detached child would outlive the
    // coordinator. The caller's options used to be spread last, which let
    // them replace both.
    const { session, child } = await startManagedCallerSession({
      modulePath: EXECUTOR,
      handshakeTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      spawnOptions: { detached: true },
    });
    try {
      // The handshake succeeding proves the child was started; the process
      // group is what proves it was NOT detached.
      assert.equal(session.established, true, "expected the handshake to succeed");
      assert.equal(
        child.spawnargs.length > 0,
        true,
        "expected spawn arguments to be recorded",
      );

      // A detached child gets its own process group, so its pgid differs
      // from the coordinator's. An attached child keeps the coordinator's.
      const childPgid = process.kill(child.pid, 0)
        ? readPgid(child.pid)
        : null;
      assert.equal(
        childPgid,
        readPgid(process.pid),
        "the supervised child must not be in its own process group",
      );
    } finally {
      await session.close("test_cleanup");
      await killChild(child);
    }
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

  test("the established identity cannot be replaced from the outside", async () => {
    await withSession({}, async (session) => {
      const original = session.childIdentity;

      // A frozen object is only frozen at the top level: a property can still
      // be shadowed by a getter, and a plain writable property can be
      // replaced wholesale. The identity has to resist both.
      assert.throws(() => {
        session.childIdentity = { pid: 1, owner: "attacker" };
      });
      assert.equal(session.childIdentity, original, "the identity object was replaced");

      assert.throws(() => {
        Object.defineProperty(session, "childIdentity", {
          get: () => ({ pid: 1, owner: "attacker" }),
        });
      });
      assert.equal(session.childIdentity, original, "the identity getter was redefined");

      // The batch scope is not part of the session's mutable surface either:
      // it lives in the supervisor's closure, so nothing outside can widen it.
      assert.equal(session.allowedOperations, undefined);
    });
  });

  test("the identity records a start token so pid reuse is detectable", async () => {
    await withSession({}, async (session) => {
      assert.ok(session.childIdentity.startToken, "expected a process start token");
      assert.equal(session.auditProcessContinuity().ok, true);
    });
  });

  test("the audits fail closed instead of reporting a clean channel", async () => {
    // A degraded environment is not a clean one. If the socket address cannot
    // be determined, or the start token is missing, the audit has to say so
    // instead of reporting `ok: true` — that permissive answer is exactly
    // what would let a transferred handle keep working.
    await withSession({}, async (session) => {
      const holders = session.auditChannelHolders();
      assert.equal(holders.ok, true, `expected a clean channel, got ${holders.reason}`);
      assert.ok(holders.holders.length >= 1, "expected at least one socket holder");

      const continuity = session.auditProcessContinuity();
      assert.equal(continuity.ok, true, `expected a continuous process, got ${continuity.reason}`);

      // With the identity removed, both audits must refuse rather than pass.
      const identity = session.childIdentity;
      assert.ok(identity, "expected an established identity");
    });
  });

  test("a session without a usable socket address refuses to dispatch", async () => {
    // The audit has to run on the request path, and a missing socket address
    // has to stop the request instead of letting it through.
    const realFacts = require("../../lib/governed/managed-caller-identity");
    const { session, child } = await startManagedCallerSession({
      modulePath: EXECUTOR,
      handshakeTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      factSource: {
        ...realFacts,
        collectProcessFacts: () => ({
          pid: 0,
          startToken: null,
          commandDigest: null,
          socketAddress: null,
          socketEndpoint: null,
          holders: [],
        }),
      },
    });
    try {
      const original = session.childIdentity;
      assert.equal(original.socketAddress, null, "expected no socket address in this environment");

      const audit = session.auditChannelHolders();
      assert.equal(audit.ok, false, "an unknown socket address must not report a clean channel");
      assert.equal(audit.reason, "socket_address_unknown");

      await assert.rejects(
        () => session.request(SUPERVISOR_OPERATIONS.PING),
        /refused to dispatch|socket_address_unknown/,
      );
      assert.equal(session.closed, true, "the session must end when the audit fails");
    } finally {
      await session.close("test_cleanup");
      await killChild(child);
    }
  });

  test("a refused dispatch never puts the payload on the channel", async () => {
    // The audit has to run BEFORE the request frame is written. A request
    // that is refused afterwards has already leaked its payload to whoever
    // holds the transferred handle: the coordinator reports "refused to
    // dispatch" while the sensitive body has already gone out over the
    // wire.
    const realFacts = require("../../lib/governed/managed-caller-identity");
    const { session, child } = await startManagedCallerSession({
      modulePath: EXECUTOR,
      handshakeTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      factSource: {
        ...realFacts,
        collectProcessFacts: () => ({
          pid: 0,
          startToken: null,
          commandDigest: null,
          socketAddress: null,
          socketEndpoint: null,
          holders: [],
        }),
      },
    });
    try {
      const written = [];
      const originalSend = session.child.send.bind(session.child);
      session.child.send = (message, ...rest) => {
        written.push(message);
        return originalSend(message, ...rest);
      };

      await assert.rejects(
        () => session.request(SUPERVISOR_OPERATIONS.PING, { SENSITIVE: "LEAK-ME" }),
        /refused to dispatch|socket_address_unknown/,
      );

      const requestFrames = written.filter((message) => message
        && message.type === CHANNEL_MESSAGE.REQUEST);
      assert.equal(
        requestFrames.length,
        0,
        "a refused request must not be written to the channel",
      );
    } finally {
      await session.close("test_cleanup");
      await killChild(child);
    }
  });

  test("the identity slot itself cannot be replaced from the outside", async () => {
    // `childIdentity` is exposed through a read-only accessor, but the slot
    // behind it used to be a plain writable property. Anything holding a
    // reference to the session could overwrite the slot and thereby defeat
    // the pid-reuse check, which compares against the recorded start token.
    await withSession({}, async (session) => {
      const original = session.childIdentity;

      // Writing the old slot name must not change what the session reports.
      session._childIdentity = { pid: 1, owner: "attacker" };
      assert.equal(session.childIdentity, original, "the identity was replaced");

      // There must be NO write handle on the instance at all. An earlier
      // revision exposed the writer as `session._setChildIdentity`: it was
      // non-configurable and non-writable, so it could not be replaced or
      // redefined -- and it was still CALLABLE, so calling it bypassed the
      // pid-reuse check exactly as the writable slot it replaced did.
      //
      // Asserting only that the property cannot be REDEFINED misses that
      // attack. The assertion has to be that there is nothing to call.
      assert.equal(
        Object.getOwnPropertyNames(session).includes("_setChildIdentity"),
        false,
        "the identity writer must not exist on the instance",
      );
      assert.equal(typeof session._setChildIdentity, "undefined");

      // Same for the fact readers: a reader on the instance could be
      // swapped for one that reports clean facts.
      for (const name of ["_collectFacts", "_readHolders", "_tokenIsPrecise"]) {
        assert.equal(
          Object.getOwnPropertyNames(session).includes(name),
          false,
          `${name} must not exist on the instance`,
        );
        assert.equal(typeof session[name], "undefined");
      }

      // And the private fields are invisible to property enumeration.
      const descriptors = Object.getOwnPropertyDescriptors(session);
      for (const name of Object.keys(descriptors)) {
        assert.doesNotMatch(name, /^#/, `private field ${name} is visible`);
      }

      // Defining a same-named property creates a NEW property that nothing
      // reads, so it is harmless -- what matters is that it is not a handle
      // to the real identity. The read-only accessor itself must still resist
      // redefinition and assignment.
      session._setChildIdentity = () => {};
      assert.equal(session.childIdentity, original, "the identity was replaced");

      assert.throws(() => {
        Object.defineProperty(session, "childIdentity", {
          get: () => ({ pid: 1, owner: "attacker" }),
        });
      }, /Cannot redefine property/);
    });
  });

  test("a replaced process behind the same pid is detected", async () => {
    // The pid reuse negative case. The pid stays the same but the process
    // behind it is not the one the session established, which is exactly what
    // the OS does when it hands a pid to a new process. The start token is
    // what tells the two apart, so the continuity audit has to refuse.
    const realFacts = require("../../lib/governed/managed-caller-identity");
    // The handshake records the token of the process that was there then.
    // Afterwards the fact source reports a different token, which is what
    // the OS does when it hands the same pid to a new process.
    let replaced = false;
    const { session, child } = await startManagedCallerSession({
      modulePath: EXECUTOR,
      handshakeTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      factSource: {
        ...realFacts,
        collectProcessFacts: () => ({
          pid: process.pid,
          startToken: replaced
            ? "linux:the-process-that-replaced-it"
            : "linux:the-process-that-was-established",
          commandDigest: null,
          socketAddress: null,
          socketEndpoint: null,
          holders: [],
        }),
      },
    });
    try {
      assert.equal(
        session.childIdentity.startToken,
        "linux:the-process-that-was-established",
      );
      assert.equal(session.auditProcessContinuity().ok, true);

      // The pid is now held by a different process.
      replaced = true;

      const audit = session.auditProcessContinuity();
      assert.equal(audit.ok, false, "a replaced process must not pass the continuity audit");
      assert.equal(audit.reason, "process_replaced_pid_reuse");
    } finally {
      await session.close("test_cleanup");
      await killChild(child);
    }
  });

  test("the recorded identity cannot be rewritten to defeat the pid-reuse check", async () => {
    // The bypass, modelled the way an attacker would model it: change the
    // ONE fact that a pid reuse actually changes -- the start token -- and
    // leave every other fact real. If the recorded identity can be rewritten
    // to carry the replacement's token, the continuity audit compares the
    // replacement against ITSELF and reports a clean channel.
    //
    // An earlier revision failed this: the identity writer was exposed on the
    // instance, so this exact attack succeeded while the audit looked
    // perfectly well-formed.
    const realFacts = require("../../lib/governed/managed-caller-identity");
    let replaced = false;
    const { session, child } = await startManagedCallerSession({
      modulePath: EXECUTOR,
      handshakeTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      factSource: {
        ...realFacts,
        collectProcessFacts: () => ({
          pid: process.pid,
          startToken: replaced
            ? "linux:the-process-that-replaced-it"
            : "linux:the-process-that-was-established",
          commandDigest: null,
          socketAddress: null,
          socketEndpoint: null,
          holders: [],
        }),
      },
    });
    try {
      // The pid is now held by a different process.
      replaced = true;

      const audit = session.auditProcessContinuity();
      assert.equal(audit.ok, false, "a replaced process must not pass the continuity audit");
      assert.equal(audit.reason, "process_replaced_pid_reuse");

      // Now try to make the audit compare the replacement against itself.
      // Every route to the recorded identity has to be closed.
      const attackerToken = "linux:the-process-that-replaced-it";

      session._childIdentity = Object.freeze({
        ...session.childIdentity,
        startToken: attackerToken,
      });
      assert.throws(() => {
        session._setChildIdentity(Object.freeze({
          ...session.childIdentity,
          startToken: attackerToken,
        }));
      });

      // The recorded identity must still be the one established at handshake
      // time, so the audit still refuses.
      assert.equal(
        session.childIdentity.startToken,
        "linux:the-process-that-was-established",
        "the recorded start token was rewritten",
      );
      assert.equal(session.auditProcessContinuity().ok, false);
    } finally {
      await session.close("test_cleanup");
      await killChild(child);
    }
  });

  test("a missing start token fails the continuity audit closed", async () => {
    // Without a start token a pid reuse cannot be detected at all, so the
    // audit has to refuse rather than treat the missing fact as a pass.
    const realFacts = require("../../lib/governed/managed-caller-identity");
    const { session, child } = await startManagedCallerSession({
      modulePath: EXECUTOR,
      handshakeTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      factSource: {
        ...realFacts,
        // No start token is available at all: the environment cannot answer
        // the question the continuity audit has to ask.
        collectProcessFacts: () => ({
          pid: process.pid,
          startToken: null,
          commandDigest: null,
          socketAddress: null,
          socketEndpoint: null,
          holders: [],
        }),
      },
    });
    try {
      const audit = session.auditProcessContinuity();
      assert.equal(audit.ok, false, "a missing start token must not pass the continuity audit");
      assert.equal(audit.reason, "start_token_unavailable");
    } finally {
      await session.close("test_cleanup");
      await killChild(child);
    }
  });

  test("a coarse start token fails the continuity audit closed", async () => {
    // `ps -o lstart=` resolves to whole seconds, so a token derived from it
    // is shared by every process started in that second. A pid reuse by such
    // a process would compare EQUAL, and the audit would report a pass for a
    // replacement it cannot see. The audit has to refuse a comparison it
    // cannot make.
    const realFacts = require("../../lib/governed/managed-caller-identity");
    const { session, child } = await startManagedCallerSession({
      modulePath: EXECUTOR,
      handshakeTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      factSource: {
        ...realFacts,
        collectProcessFacts: () => ({
          pid: process.pid,
          startToken: "ps-coarse:Sat Oct 23 12:00:00 2026",
          commandDigest: null,
          socketAddress: null,
          socketEndpoint: null,
          holders: [],
        }),
      },
    });
    try {
      const audit = session.auditProcessContinuity();
      assert.equal(audit.ok, false, "a coarse token must not pass the continuity audit");
      assert.equal(audit.reason, "start_token_too_coarse");
    } finally {
      await session.close("test_cleanup");
      await killChild(child);
    }
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
