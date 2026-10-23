"use strict";

// ─── Managed Caller Identity Facts (M-044 / MS-002) ─────────────────────────
//
// The OS-level facts the coordinator needs in order to tell "the process I
// am supervising" apart from "something that merely holds the same channel".
//
// Everything in this module is a *cross-check*, never an identity input on its
// own. The identity decision is made in `managed-caller-session.js` and it
// requires the caller to hold the session secret, which never travels over
// the transferable channel.
//
// Three facts are collected:
//
//   1. `processStartToken` — pid + process start time. A bare pid is
//      reusable: the OS may hand the same number to a different process
//      after the original exits. Pairing the pid with the start time makes
//      that reuse detectable, which is what VC-044-005 asks for.
//   2. `channelHolders` — the set of processes holding the IPC socket.
//      When the handle is transferred to a descendant, a second holder shows
//      up. This is how "explicit handle transfer" is detected rather than
//      merely assumed impossible.
//   3. `commandDigest` — a digest of the child's own command line. Used only
//      to confirm the supervised process is still the one that was started.

const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

/**
 * Match a unix socket address in an `lsof -U` line.
 *
 * The column layout of `lsof` differs between platforms: macOS prints an
 * 8-digit address (`0x9d4588dd`) in a fixed column, Linux prints a 16-digit
 * address (`0x000000009d4588dd`) and appends `type=STREAM (CONNECTED)`.
 * Indexing columns would therefore be platform-specific and brittle, so the
 * address is matched by shape instead.
 */
const SOCKET_ADDRESS_PATTERN = /0x[0-9a-fA-F]+/g;

/**
 * Extract every socket address from an `lsof -U` line.
 *
 * The first address is the socket's own (local) address; a `->0x...` peer
 * address, when present, names the other end of the connection.
 *
 * @param {string} line
 * @returns {string[]}
 */
function extractSocketAddresses(line) {
  const matches = String(line).match(SOCKET_ADDRESS_PATTERN) || [];
  return matches.map((value) => value.toLowerCase());
}

/**
 * Read the process start time for a pid.
 *
 * Linux exposes the kernel's start tick in `/proc/<pid>/stat`. macOS has no
 * `/proc`, so `ps -o lstart=` is used instead. Both are normalised to an
 * opaque string; the value only has to be *stable* for the lifetime of one
 * process and *different* for a different process that reuses the pid.
 *
 * @param {number} pid
 * @returns {string|null}
 */
function readProcessStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // The executable name may contain spaces and parentheses, so the fields
      // after the closing paren are the only safe source.
      const tail = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      // tail[0] is `state`; field 22 (1-based) is `starttime`.
      const starttime = tail[19];
      return starttime ? `linux:${starttime}` : null;
    } catch (_) {
      // Fall through to the portable path below.
    }
  }

  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const value = String(result.stdout || "").trim();
  return value ? `ps:${value}` : null;
}

/**
 * List the processes that hold a given unix socket address.
 *
 * `lsof -U` prints every unix socket on the machine. The lines mentioning
 * the address are the holders. A transferred handle shows up here as an
 * extra pid — that is the signal that the channel left the supervised
 * process.
 *
 * @param {string} address The socket's local address, e.g. `0x53753ea926dd8940`.
 * @returns {number[]} Holder pids, sorted ascending.
 */
function readSocketHolders(address) {
  if (!address || typeof address !== "string") return [];

  const wanted = address.toLowerCase();

  // Scan every unix socket on the machine: a descendant that inherited the
  // handle is not a process we know the pid of, so it must be discovered by
  // the socket address rather than looked up directly.
  const result = spawnSync("lsof", ["-U"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return [];

  const pids = new Set();
  for (const line of String(result.stdout || "").split("\n")) {
    if (!/unix/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    // Match on the local address only. The peer address belongs to the other
    // end of the socket and would match unrelated processes.
    const addresses = extractSocketAddresses(line);
    if (!addresses.length || addresses[0] !== wanted) continue;
    const pid = Number.parseInt(line.trim().split(/\s+/)[1], 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids].sort((a, b) => a - b);
}

/**
 * Find the unix socket address of a process's IPC channel.
 *
 * The IPC channel is the child's fd 3 in a `fork`ed Node child. Its *local*
 * address is the stable identifier: the peer column names the other end,
 * which is the coordinator, and would match the wrong process.
 *
 * @param {number} pid
 * @returns {string|null} The socket's local address.
 */
function readIpcSocketAddress(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const result = spawnSync("lsof", ["-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return null;

  for (const line of String(result.stdout || "").split("\n")) {
    if (!/unix/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts[3] !== "3u") continue;
    // The IPC channel is the child's fd 3. Its local address is the stable
    // identifier; the peer address names the coordinator's end.
    const addresses = extractSocketAddresses(line);
    if (addresses.length) return addresses[0];
  }
  return null;
}

/**
 * Digest the command line of a process, for a continuity cross-check.
 *
 * @param {number} pid
 * @returns {string|null}
 */
function readCommandDigest(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const command = String(result.stdout || "").trim();
  if (!command) return null;
  return `sha256:${crypto.createHash("sha256").update(command).digest("hex")}`;
}

/**
 * Collect the OS-level identity facts for a supervised child.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @returns {{pid: number, startToken: string|null, commandDigest: string|null, socketAddress: string|null, holders: number[]}}
 */
function collectProcessFacts(child) {
  const pid = child && typeof child.pid === "number" ? child.pid : 0;
  const socketAddress = pid ? readIpcSocketAddress(pid) : null;
  return {
    pid,
    startToken: pid ? readProcessStartToken(pid) : null,
    commandDigest: pid ? readCommandDigest(pid) : null,
    socketAddress,
    holders: socketAddress ? readSocketHolders(socketAddress) : [],
  };
}

module.exports = {
  collectProcessFacts,
  readProcessStartToken,
  readSocketHolders,
  readIpcSocketAddress,
  readCommandDigest,
};
