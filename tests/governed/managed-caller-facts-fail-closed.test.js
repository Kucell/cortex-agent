"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { startManagedCallerSession } = require("../../lib/governed/managed-caller-supervisor");

test("unverifiable caller facts refuse dispatch before writing a request", async () => {
  for (const scenario of ["missing-endpoint", "changed-inode", "changed-address", "changed-peer",
    "parent-only", "missing-initial-digest", "missing-current-digest"]) {
    let established = false;
    let pid;
    const mac = scenario === "changed-address" || scenario === "changed-peer";
    const endpoint = mac ? { inode: null, address: "local", peerAddress: "peer" } : { inode: 123, address: null };
    const facts = {
      collectProcessFacts(child) {
        pid = child.pid;
        let currentEndpoint = endpoint;
        if (established && scenario === "missing-endpoint") currentEndpoint = null;
        if (established && scenario === "changed-inode") currentEndpoint = { inode: 124, address: null };
        if (established && scenario === "changed-address") currentEndpoint = { ...endpoint, address: "other" };
        if (established && scenario === "changed-peer") currentEndpoint = { ...endpoint, peerAddress: "other" };
        const noDigest = (!established && scenario === "missing-initial-digest") ||
          (established && scenario === "missing-current-digest");
        return { pid: child.pid, startToken: "precise", commandDigest: noDigest ? null : "digest",
          socketAddress: endpoint.address, socketEndpoint: currentEndpoint };
      },
      readSocketHolders: () => scenario === "parent-only" ? [process.pid] : [pid],
      isPreciseStartToken: () => true,
    };
    const { session, child } = await startManagedCallerSession({
      modulePath: path.join(__dirname, "fixtures", "m044-ms002-executor.js"), factSource: facts,
    });
    try {
      established = true;
      let requests = 0;
      const send = child.send.bind(child);
      child.send = (message, ...args) => { if (message.type === "request") requests += 1; return send(message, ...args); };
      const reason = scenario === "missing-endpoint" ? "socket_address_unknown"
        : scenario.startsWith("changed-") ? "channel_endpoint_changed"
          : scenario === "parent-only" ? "socket_holders_unknown" : "command_digest_unavailable";
      await assert.rejects(session.request("ping", { value: "must-not-send" }), new RegExp(reason), scenario);
      assert.equal(requests, 0, scenario);
      assert.equal(session.closed, true, scenario);
    } finally {
      await session.close("test_cleanup");
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
});
