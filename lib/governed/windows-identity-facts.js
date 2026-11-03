"use strict";

// ─── Windows Identity Facts (M-053 / MS-008 第 9 环) ──────────────────────
//
// The Windows-native fact sources for `governed/managed-caller-identity.js`.
//
// WHY THIS EXISTS
//   `managed-caller-identity.js` has a Linux branch and a macOS branch. Its
//   portable fallback shells out to `ps`, which **does not exist on
//   Windows** (measured: `ps.exe` is absent, `PS_LSTART_ERROR=ENOENT`). A
//   missing fact is not a coarse fact — the continuity audit refuses a
//   coarse token rather than accepting a comparison it cannot make — so the
//   fallback yields `null` and every fact is unavailable.
//
//   This module supplies the three facts on Windows, from Windows-native
//   mechanisms:
//
//     1. `startToken`      — CIM `Win32_Process.CreationDate`. Measured on
//        the real machine at 100ns resolution, which separates two
//        processes started within the same second — finer than the
//        whole-second `ps -o lstart=` the portable path would give, and
//        finer than macOS's microsecond `proc_bsdinfo`.
//     2. `commandDigest`   — CIM `Win32_Process.CommandLine`, digested the
//        same way the POSIX path digests `ps -o command=`.
//     3. `channelHolders`  — `NtQuerySystemInformation` +
//        `NtQueryObject`, resolved through an **inlined** PowerShell
//        `Add-Type` helper whose source arrives on STDIN.
//
// WHY THE HELPER SOURCE ARRIVES ON STDIN
//   Writing the source to a file first would put it on disk in a directory
//   that a same-account process can read — and the helper reads process
//   handle tables, which is exactly the kind of fact an attacker wants to
//   learn the shape of. `Add-Type -TypeDefinition` with the source piped on
//   STDIN compiles it in memory: **zero bytes on disk**.
//
//   This is the form the Owner ruling fixed: "PowerShell 内联 Add-Type +
//   源码走 STDIN，不改包形态".
//
// WHAT THIS MODULE DOES NOT DO
//   It does not decide identity. Every value here is a *cross-check*; the
//   identity decision lives in `managed-caller-session.js` and requires the
//   caller to hold the session secret. A fact source that could be talked
//   into returning a chosen value would be worse than no fact source at all.

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

// The PowerShell helper that reads CIM facts. It is a plain script with no
// state and no writes: it reads two properties of one process.
const CIM_FACTS_SOURCE = [
  "$ErrorActionPreference = 'Stop'",
  "$pid0 = [int]$args[0]",
  "$p = Get-CimInstance -ClassName Win32_Process -Filter \"ProcessId=$pid0\" -ErrorAction Stop",
  "if ($null -eq $p) { Write-Output 'CIM_FACTS=ABSENT'; exit 0 }",
  "$created = $p.CreationDate",
  "if ($null -eq $created) { Write-Output 'CIM_FACTS=NOCREATIONDATE'; exit 0 }",
  // The ticks are the precise part. The DateTime's own ToString() keeps only
  // milliseconds on some paths, and the whole point of the token is to
  // separate two processes started within the same second.
  "$ticks = $created.ToUniversalTime().Ticks",
  "$cmd = $p.CommandLine",
  "Write-Output 'CIM_FACTS=OK'",
  "Write-Output ('CIM_TICKS=' + $ticks)",
  "Write-Output ('CIM_CMDLINE_B64=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$cmd)))",
].join("; ");

/**
 * Run a PowerShell script with a given argument list.
 *
 * @param {string} script
 * @param {string[]} [args]
 * @returns {{status: number|null, stdout: string, stderr: string, error: string|null}}
 */
function powerShellCommand(script, args) {
  const encodedArgs = args.map((arg) => {
    const encoded = Buffer.from(String(arg), "utf8").toString("base64");
    return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`;
  });
  return `& { ${script} } ${encodedArgs.join(" ")}`;
}

function runPowerShell(script, args = []) {
  const argv = ["-NoProfile", "-NonInteractive", "-Command", powerShellCommand(script, args)];
  const result = spawnSync("powershell.exe", argv, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error ? (result.error.code || String(result.error)) : null,
  };
}

/**
 * Run a PowerShell script whose STDIN carries a payload.
 *
 * The payload is the C# helper source. It arrives on STDIN and is compiled
 * by `Add-Type` **in memory** — zero bytes of source reach the disk. The
 * alternative (writing the source to a file, then compiling it) would put a
 * readable description of the handle-table reader in a directory a
 * same-account process can read.
 *
 * @param {string} script
 * @param {string} payload
 * @param {string[]} [args]
 * @returns {{status: number|null, stdout: string, stderr: string, error: string|null}}
 */
function runPowerShellWithStdin(script, payload, args = []) {
  const argv = ["-NoProfile", "-NonInteractive", "-Command", powerShellCommand(script, args)];
  const result = spawnSync("powershell.exe", argv, {
    encoding: "utf8",
    input: payload,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error ? (result.error.code || String(result.error)) : null,
  };
}

/**
 * Read the CIM facts of one process.
 *
 * @param {number} pid
 * @returns {{creationTicks: string|null, commandLine: string|null}|null}
 */
function readCimFacts(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const result = runPowerShell(CIM_FACTS_SOURCE, [String(pid)]);
  if (result.status !== 0) return null;

  const output = result.stdout;
  if (!/CIM_FACTS=OK/.test(output)) return null;

  const ticks = (output.match(/CIM_TICKS=(\d+)/) || [])[1] || null;
  const encoded = (output.match(/CIM_CMDLINE_B64=([A-Za-z0-9+/=]*)/) || [])[1] || null;
  if (!ticks) return null;

  let commandLine = null;
  if (encoded) {
    try {
      commandLine = Buffer.from(encoded, "base64").toString("utf8");
    } catch (_) {
      commandLine = null;
    }
  }

  return { creationTicks: ticks, commandLine };
}

/**
 * The Windows start token of a process.
 *
 * @param {number} pid
 * @returns {string|null}
 */
function readWindowsStartToken(pid) {
  const facts = readCimFacts(pid);
  if (!facts) return null;
  return `win32:${facts.creationTicks}`;
}

/**
 * The digest of a process's own command line.
 *
 * The digest is computed over the **command line text**, exactly like the
 * POSIX path digests `ps -o command=`. Both sides must agree on what is
 * hashed, or a continuity check would compare two different things.
 *
 * @param {number} pid
 * @returns {string|null}
 */
function readWindowsCommandDigest(pid) {
  const facts = readCimFacts(pid);
  if (!facts || typeof facts.commandLine !== "string") return null;
  const command = facts.commandLine.trim();
  if (!command) return null;
  return `sha256:${crypto.createHash("sha256").update(command).digest("hex")}`;
}

module.exports = Object.freeze({
  readCimFacts,
  readWindowsStartToken,
  readWindowsCommandDigest,
  runPowerShell,
  runPowerShellWithStdin,
});
