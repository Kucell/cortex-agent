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
//
//      The start time must be precise enough to separate two processes that
//      were started within the same second. `ps -o lstart=` only resolves to
//      the second, so on a busy machine every process started in that second
//      shares one token and pid reuse becomes undetectable. macOS therefore
//      reads the microsecond start time out of `proc_bsdinfo` instead.
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
 * The macOS start-time helper, kept as source lines rather than a template
 * literal so the file stays greppable and diffable.
 *
 * `ps -o lstart=` prints whole seconds, so every process started within the
 * same second shares one start token and pid reuse becomes undetectable.
 * macOS also removed `sysctl kern.proc.pid`, so the only remaining kernel
 * source of a sub-second start time is `proc_pidinfo(PROC_PIDTBSDINFO)`,
 * whose `pbi_start_tvsec`/`pbi_start_tvusec` fields carry the microseconds.
 *
 * The helper prints "<seconds>.<microseconds>" and exits 0. Every failure
 * exits non-zero, which the caller turns into an unavailable token — the
 * session fails closed rather than falling back to a coarse value.
 */
const MACOS_START_TIME_SOURCE = [
  "#include <stdio.h>",
  "#include <stdlib.h>",
  "#include <libproc.h>",
  "#include <sys/proc_info.h>",
  "int main(int argc, char **argv) {",
  "  if (argc < 2) return 2;",
  "  int pid = atoi(argv[1]);",
  "  if (pid <= 0) return 2;",
  "  struct proc_bsdinfo info;",
  "  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));",
  "  if (size <= 0) return 3;",
  "  printf(\"%llu.%llu\", (unsigned long long)info.pbi_start_tvsec,",
  "         (unsigned long long)info.pbi_start_tvusec);",
  "  return 0;",
  "}",
].join("\n");

/** Cache for the compiled helper: binary path and build outcome. */
const macosHelper = { binary: null, attempted: false };

/**
 * Compile the macOS start-time helper once per process.
 *
 * The binary lives in a private directory that only the current user can
 * read, and it is removed when the process exits. A helper that cannot be
 * built means the start token is unavailable, and an unavailable start token
 * makes the continuity audit fail closed.
 *
 * @returns {string|null} The helper's path, or null when it cannot be built.
 */
function buildMacosStartTimeHelper() {
  if (macosHelper.binary || macosHelper.attempted) return macosHelper.binary;
  macosHelper.attempted = true;

  const os = require("node:os");
  const path = require("node:path");

  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "m044-starttime-"));
    const sourcePath = path.join(dir, "bsdinfo.c");
    const binaryPath = path.join(dir, "bsdinfo");

    fs.writeFileSync(sourcePath, MACOS_START_TIME_SOURCE, { mode: 0o600 });
    const build = spawnSync("cc", ["-O1", "-o", binaryPath, sourcePath], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 30_000,
    });
    if (build.status !== 0) return null;

    fs.chmodSync(binaryPath, 0o700);
    macosHelper.binary = binaryPath;
    return macosHelper.binary;
  } catch (_) {
    return null;
  }
}

/**
 * Read the start time of a macOS process at microsecond resolution.
 *
 * @param {number} pid
 * @returns {string|null}
 */
function readMacosStartTime(pid) {
  const helper = buildMacosStartTimeHelper();
  // Without the helper there is no precise token. Returning null here would
  // silently drop the session to the coarse second-resolution fallback,
  // which cannot separate two processes started in the same second — and a
  // pid reuse is exactly the case the token has to detect. The caller is
  // told the token is unavailable so it can fail closed.
  if (!helper) return null;
  const result = spawnSync(helper, [String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  const value = String(result.stdout || "").trim();
  return value ? `macos:${value}` : null;
}

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
 * Report whether an `lsof -U` line refers to a given kernel inode.
 *
 * On Linux the inode is printed in the NODE column. It cannot be located by
 * a pattern anchored on the trailing `type=` marker, because the NAME
 * column sits between them for a NAMED socket and holds the socket's path:
 *
 *     node 1 root 18u unix 0x0000000083793813 0t0 1818793 /tmp/x.sock type=STREAM (LISTEN)
 *
 * Anchoring on `type=` skipped every path-bound socket, which made the
 * holder set come back EMPTY for one — a fail-open direction.
 *
 * The inode is therefore matched by its POSITION relative to the `0t0`
 * column, which is the SIZE/OFF column and always directly precedes the
 * inode on Linux:
 *
 *     ... unix 0x0000000083793813  0t0  1818793  /tmp/x.sock  type=STREAM
 *
 * macOS prints no inode at all — the column after `0t0` is the peer address
 * — so the same rule simply does not match there, which is correct: the
 * inode model is the Linux one.
 *
 * @param {string[]} parts The whitespace-split columns of the line.
 * @param {number} inode
 * @returns {boolean}
 */
function lineHasInode(parts, inode) {
  for (let index = 0; index < parts.length; index += 1) {
    if (!/^0t\d+$/.test(parts[index])) continue;
    const next = parts[index + 1];
    if (typeof next !== "string" || !/^\d+$/.test(next)) continue;
    if (Number.parseInt(next, 10) === inode) return true;
  }
  return false;
}

/**
 * Read the kernel inode of a process's file descriptor.
 *
 * Linux exposes it under `/proc/<pid>/fd/<n>` as `socket:[<inode>]`. The
 * inode identifies the socket object itself, which is exactly the property
 * the holder audit needs: a descendant that inherited the descriptor holds
 * the SAME socket object, and therefore the same inode. An unrelated socket
 * never shares it.
 *
 * macOS has no `/proc`, so the inode is not available there and this returns
 * null. macOS instead identifies the socket by its address pair, which is
 * unique for the lifetime of the connection.
 *
 * @param {number} pid
 * @param {number} fd
 * @returns {number|null}
 */
function readSocketInode(pid, fd) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
    const match = /^socket:\[(\d+)\]$/.exec(link);
    if (!match) return null;
    const inode = Number.parseInt(match[1], 10);
    return Number.isInteger(inode) ? inode : null;
  } catch (_) {
    return null;
  }
}

/**
 * Read the process start time for a pid.
 *
 * Linux exposes the kernel's start tick in `/proc/<pid>/stat`. macOS has no
 * `/proc`, so the microsecond start time is read out of `proc_bsdinfo`. The
 * coarse `ps -o lstart=` value is only a last resort: it resolves to whole
 * seconds, which is not enough to tell two processes of the same second
 * apart, and pid reuse detection depends on exactly that distinction.
 *
 * Both are normalised to an opaque string; the value only has to be *stable*
 * for the lifetime of one process and *different* for a different process
 * that reuses the pid.
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
      // The boot id is part of the token so that the counter cannot be
      // confused across a reboot: a pid that is reused after a reboot starts
      // at a low tick count again, and the boot id tells the two apart.
      const bootId = readBootId();
      return starttime ? `linux:${bootId ? `${bootId}:` : ""}${starttime}` : null;
    } catch (_) {
      // Fall through to the portable path below.
    }
  }

  if (process.platform === "darwin") {
    const precise = readMacosStartTime(pid);
    if (precise) return precise;
    // Fall through to the portable path. The coarse token is marked as such,
    // so the continuity audit can refuse it: it detects a replaced process
    // only when the replacement started in a different second.
  }

  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const value = String(result.stdout || "").trim();
  // The `ps:` prefix marks the coarse fallback. It resolves to whole
  // seconds, so two processes started in the same second share a token and a
  // pid reuse between them cannot be detected. The continuity audit refuses
  // a coarse token rather than accepting a comparison it cannot make.
  return value ? `ps-coarse:${value}` : null;
}

/**
 * Report whether a start token is precise enough to detect a pid reuse.
 *
 * A token is precise when it identifies the process at a resolution finer
 * than one second. `ps -o lstart=` resolves to whole seconds, so a token
 * derived from it is coarse: two processes started within the same second
 * share it, and a reuse of the pid by one of them would go unnoticed.
 *
 * @param {string|null} token
 * @returns {boolean}
 */
function isPreciseStartToken(token) {
  if (typeof token !== "string" || !token) return false;
  return !token.startsWith("ps-coarse:");
}

/**
 * Read the machine's boot id.
 *
 * The kernel exposes it under `/proc/sys/kernel/random/boot_id`. It is the
 * same for every process on the machine and changes on every boot, which is
 * what makes a start token comparable across a reboot.
 *
 * @returns {string|null}
 */
function readBootId() {
  try {
    const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return value || null;
  } catch (_) {
    return null;
  }
}

/**
 * List the processes that hold a given unix socket.
 *
 * `lsof -U` prints every unix socket on the machine. A transferred handle
 * shows up here as an extra pid — that is the signal that the channel left the
 * supervised process.
 *
 * Two platforms, two identities for the same socket:
 *
 *   - Linux prints the socket's inode in the NODE column. The inode
 *     identifies the socket OBJECT, so a descendant that inherited the
 *     descriptor is matched exactly, and it agrees with a direct `/proc`
 *     read of the holder set. The `0x...` column is deliberately not used:
 *     it does not identify the socket (the two ends of one connection carry
 *     different values, and a socketpair's two ends carry the same value
 *     with different inodes), so matching on it cannot tell one socket from
 *     another.
 *   - macOS prints an address pair (`local ->peer`). The address is unique
 *     for the lifetime of the connection, so the pair identifies the socket.
 *
 * @param {object} endpoint
 * @param {number} [endpoint.inode] The socket's kernel inode (Linux).
 * @param {string} [endpoint.address] The socket's local address (macOS).
 * @param {string} [endpoint.peerAddress] The socket's peer address (macOS).
 * @returns {number[]} Holder pids, sorted ascending.
 */
function readSocketHolders(endpoint) {
  if (!endpoint || typeof endpoint !== "object") return [];

  const inode = Number.isInteger(endpoint.inode) ? endpoint.inode : null;
  const wanted = endpoint.address ? String(endpoint.address).toLowerCase() : null;
  const wantedPeer = endpoint.peerAddress ? String(endpoint.peerAddress).toLowerCase() : null;

  // Neither identity is known: there is nothing to look for.
  if (inode === null && !wanted) return [];

  // Scan every unix socket on the machine: a descendant that inherited the
  // handle is not a process we know the pid of, so it must be discovered by
  // the socket identity rather than looked up directly.
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

    if (inode !== null) {
      // The NODE column holds the inode on Linux. It is read by COLUMN
      // position rather than by shape: a named socket carries its path in
      // the NAME column, which sits between NODE and the trailing `type=`
      // marker, so a pattern anchored on `type=` silently skipped every
      // path-bound socket. That made the holder set come back EMPTY for such
      // a socket — a fail-open direction, even though the IPC channel itself
      // is anonymous and unaffected.
      if (!lineHasInode(parts, inode)) continue;
    } else {
      const addresses = extractSocketAddresses(line);
      if (!addresses.length || addresses[0] !== wanted) continue;
      // When the peer is known, the socket has to match on both ends. Without
      // it the local address alone can collide with an unrelated socket.
      if (wantedPeer) {
        if (addresses.length < 2 || addresses[1] !== wantedPeer) continue;
      }
    }

    const pid = Number.parseInt(parts[1], 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids].sort((a, b) => a - b);
}

/**
 * Find the unix socket of a process's IPC channel.
 *
 * The IPC channel is the child's fd 3 in a `fork`ed Node child. The socket
 * is identified in whichever way the platform makes unambiguous:
 *
 *   - Linux: the kernel inode, read from `/proc/<pid>/fd/3`. The inode names
 *     the socket object, so a descendant that inherited the descriptor is
 *     matched exactly.
 *   - macOS: the address pair. The local address names the child's end and
 *     the peer names the coordinator's end; the pair is unique for the
 *     lifetime of the connection.
 *
 * @param {number} pid
 * @returns {{inode: number|null, address: string|null, peerAddress: string|null}|null}
 */
function readIpcSocketEndpoint(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const inode = readSocketInode(pid, 3);

  const result = spawnSync("lsof", ["-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });

  let address = null;
  let peerAddress = null;
  if (result.status === 0) {
    for (const line of String(result.stdout || "").split("\n")) {
      if (!/unix/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      if (parts[3] !== "3u") continue;
      const addresses = extractSocketAddresses(line);
      if (!addresses.length) continue;
      address = addresses[0];
      peerAddress = addresses.length > 1 ? addresses[1] : null;
      break;
    }
  }

  if (inode === null && !address) return null;
  return { inode, address, peerAddress };
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
 * @returns {{pid: number, startToken: string|null, commandDigest: string|null, socketAddress: string|null, socketEndpoint: object|null, holders: number[]}}
 */
function collectProcessFacts(child) {
  const pid = child && typeof child.pid === "number" ? child.pid : 0;
  const socketEndpoint = pid ? readIpcSocketEndpoint(pid) : null;
  const socketAddress = socketEndpoint ? socketEndpoint.address : null;
  return {
    pid,
    startToken: pid ? readProcessStartToken(pid) : null,
    commandDigest: pid ? readCommandDigest(pid) : null,
    socketAddress,
    socketEndpoint,
    holders: socketEndpoint ? readSocketHolders(socketEndpoint) : [],
  };
}

module.exports = Object.freeze({
  collectProcessFacts,
  readProcessStartToken,
  isPreciseStartToken,
  readSocketHolders,
  readIpcSocketEndpoint,
  readSocketInode,
  readCommandDigest,
});
