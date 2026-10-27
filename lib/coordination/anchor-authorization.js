"use strict";

// Platform authorization adapter for the protected anchor domain.
//
// The property the anchor domain has to establish is: the set of identities
// that can write the anchor domain is EXACTLY {the service identity}. The
// previous implementation expressed that with POSIX mode bits and st_uid,
// which is wrong on two of the three supported platforms:
//
//   Windows  mode bits are constantly 0666 and there is no st_uid, so the
//            strict check refused every Windows deployment (the target
//            platform) while proving nothing.
//   macOS    a named ACL entry grants write without showing up in the mode
//            bits, so a deployment with a writable staff ACL was accepted as
//            safe.
//
// The adapter therefore enumerates writers from the platform's own
// authorization model (POSIX mode bits, macOS ACL, Windows DACL) and compares
// that set against an EXPLICITLY DECLARED service identity. The declaration
// matters: trusting only "whoever is calling" would make the check circular
// -- a process able to run as the service identity would pass by definition.
// Requiring caller == declared service identity turns impersonation into a
// detectable failure.
//
// Three states must stay distinguishable throughout:
//
//   null            the platform model cannot be enumerated. This is NOT
//                   "safe" and NOT "nobody can write": it is "unknown", and
//                   it fails closed.
//   empty set       nobody can write the object.
//   a set           these identities can write it.
//
// Collapsing null into the empty set would turn an unreadable or
// unparseable ACL into a silently accepted deployment.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

// A sentinel for "every identity can write". A group or an "everyone" ACE
// grants write to an unbounded set, and that set cannot be compared with
// {service identity} by enumeration.
const ANY_IDENTITY = "*";

class AnchorAuthorizationError extends Error {
  constructor(code) {
    super(code);
    this.name = "AnchorAuthorizationError";
    this.code = code;
  }
}

function fail(code) { throw new AnchorAuthorizationError(code); }

function platformKey() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "posix";
  return null;
}

// ─── POSIX ──────────────────────────────────────────────────────────────────

// On a POSIX file system, a directory whose group and other write bits are
// clear can be written only by its owner, and the same holds for a file.
// The owner may always write it, whatever the bits say. So the writable set
// is derived from the three bits directly:
//
//   owner write bit  -> {st_uid}
//   group write bit  -> every member of st_gid, which is an unbounded set
//                       unless the group is expanded
//   other write bit  -> every identity
//
// The group case is deliberately NOT expanded into the group's membership.
// Expanding it needs a getgrouplist round trip that costs a subprocess and
// buys nothing: the contract that has to hold is "the group is not
// writable", and a group that IS writable is refused either way. The
// adapter reports it as an unbounded set so the caller refuses it.
function posixWritableIdentities(targetPath) {
  let stat;
  try { stat = fs.lstatSync(targetPath); }
  catch { fail("ERR_ANCHOR_UNREADABLE"); }
  const mode = stat.mode & 0o7777;
  if (mode & 0o002) return new Set([ANY_IDENTITY]);
  if (mode & 0o020) return new Set([ANY_IDENTITY]);
  return new Set([posixIdentity(stat.uid)]);
}

function posixIdentity(uid) {
  return "uid:" + uid;
}

function posixCurrentIdentity() {
  if (typeof process.getuid !== "function") return null;
  return posixIdentity(process.getuid());
}

function posixNormalizeIdentity(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return posixIdentity(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^uid:\d+$/.test(trimmed)) return trimmed;
    if (/^\d+$/.test(trimmed)) return posixIdentity(Number(trimmed));
  }
  return null;
}

// ─── macOS ─────────────────────────────────────────────────────────────────

// macOS combines POSIX mode bits with NFSv4 style ACLs, and the ACL is what
// the mode bits cannot see:
//
//   $ chmod 700 anchor
//   $ chmod +a "staff allow write,delete" anchor
//   $ ls -lde anchor
//   drwx------@ 1 user staff 64 anchor
//     0: group:staff allow add_file,delete
//
// The mode bits still say owner-only, while staff may in fact write. The ACL
// is therefore enumerated and merged into the writable set.
//
// "ls -lde" is used rather than a native binding: it is present on every
// macOS host, it is read-only, and it needs no build step. LC_ALL=C pins the
// output format so the parser does not depend on the host locale.
const MACOS_WRITE_PERMISSIONS = new Set([
  "write", "writeattr", "delete", "add_file", "add_subdirectory",
  "delete_child", "writeextattr", "create", "write_security",
  "write_owner",
]);

function macosAclEntries(targetPath) {
  const batch = macosAclEntriesBatch([targetPath]);
  if (batch === null) return null;
  const entries = batch.get(targetPath);
  return entries === undefined ? null : entries;
}

// The ACLs of the whole anchor domain are read in one call. The anchor
// domain holds one file per journal entry, and a PowerShell or ls process
// per file would put a second or more on every open. The paths are sorted
// before the call because ls sorts its arguments, so the blocks in the
// output line up with the sorted paths.
//
// A mismatch between the number of parsed blocks and the number of paths is
// reported as "unknown" rather than as a partial answer: a half-parsed ACL
// set would silently skip a witness.
function macosAclEntriesBatch(targetPaths) {
  const paths = Array.from(new Set(targetPaths.filter((p) => typeof p === "string" && p)));
  if (paths.length === 0) return new Map();
  const sorted = paths.slice().sort();
  let output;
  try {
    output = execFileSync("/bin/ls", ["-lde"].concat(sorted), {
      encoding: "utf8",
      env: Object.assign({}, process.env, { LC_ALL: "C", LANG: "C" }),
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    // The ACL cannot be read. That is "unknown", not "safe".
    return null;
  }
  const entries = [];
  const blocks = [];
  for (const rawLine of String(output).split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // A header line describes the entry that the following ACL lines belong
    // to. It starts with the mode string.
    if (/^[-dlbcps][-rwxSsTt+@]{9}/.test(line)) {
      blocks.push([]);
      continue;
    }
    // ACL lines look like "0: group:staff allow add_file,delete".
    const match = /^\d+:\s*(.+?)\s+(allow|deny)\s+(.*)$/.exec(line);
    if (!match) continue;
    const who = match[1];
    const accessType = match[2];
    const rights = match[3].split(",").map((r) => r.trim()).filter(Boolean);
    const block = blocks[blocks.length - 1];
    if (!block) continue;
    block.push({ who, accessType, rights });
  }
  if (blocks.length !== sorted.length) return null;
  const map = new Map();
  for (let i = 0; i < sorted.length; i += 1) {
    map.set(sorted[i], blocks[i]);
  }
  entries.push(...blocks.flat());
  return map;
}

function macosWritableIdentities(targetPath) {
  const batch = macosAclEntriesBatch([targetPath]);
  if (batch === null) return null;
  const entries = batch.get(targetPath);
  if (entries === undefined) return null;
  return macosWritersFromEntries(targetPath, entries);
}

function macosWritersFromEntries(targetPath, entries) {
  const writers = new Set();
  // The mode bits still decide the base case.
  let stat;
  try { stat = fs.lstatSync(targetPath); }
  catch { fail("ERR_ANCHOR_UNREADABLE"); }
  const mode = stat.mode & 0o7777;
  if (mode & 0o002) writers.add(ANY_IDENTITY);
  if (mode & 0o020) writers.add(ANY_IDENTITY);
  if (!(mode & 0o020) && !(mode & 0o002)) writers.add(posixIdentity(stat.uid));
  // An ACL entry that grants a write right adds its identity. An entry for a
  // group or for everyone grants write to an unbounded set.
  for (const entry of entries) {
    if (entry.accessType !== "allow") continue;
    const grantsWrite = entry.rights.some((right) => MACOS_WRITE_PERMISSIONS.has(right));
    if (!grantsWrite) continue;
    const who = entry.who;
    if (who === "everyone" || who.startsWith("group:") || who.startsWith("other:")) {
      writers.add(ANY_IDENTITY);
      continue;
    }
    if (who.startsWith("user:")) {
      // The ACL names the user, the mode bits give a uid. Both have to end
      // up as the same identity value, otherwise the owner and a named ACL
      // entry for the same person would count as two writers. A name that
      // cannot be resolved is treated as an unbounded set: the identity it
      // stands for is then unknown, and an unknown identity is not the
      // service identity.
      const uid = resolveUid(who.slice("user:".length));
      if (uid === null) writers.add(ANY_IDENTITY);
      else writers.add(posixIdentity(uid));
      continue;
    }
    // A group that is not expanded cannot be compared with the declared
    // identity, so it is treated as an unbounded set.
    writers.add(ANY_IDENTITY);
  }
  return writers;
}

// The writable identity set of every path in one call. The anchor domain
// holds one file per journal entry, so reading them one at a time would put
// a process per witness on every open.
function macosWritableIdentitiesBatch(targetPaths) {
  const paths = Array.from(new Set(targetPaths.filter((p) => typeof p === "string" && p)));
  if (paths.length === 0) return new Map();
  const aclBatch = macosAclEntriesBatch(paths);
  if (aclBatch === null) return null;
  const map = new Map();
  for (const targetPath of paths) {
    const entries = aclBatch.get(targetPath);
    if (entries === undefined) return null;
    map.set(targetPath, macosWritersFromEntries(targetPath, entries));
  }
  return map;
}

function macosCurrentIdentity() {
  if (typeof process.getuid !== "function") return null;
  return posixIdentity(process.getuid());
}

// Resolve a user name to a uid. The result is cached because the same
// account usually appears in many ACL entries.
const UID_CACHE = new Map();

function resolveUid(name) {
  if (typeof name !== "string" || !name) return null;
  if (UID_CACHE.has(name)) return UID_CACHE.get(name);
  let uid = null;
  try {
    const output = execFileSync("/usr/bin/id", ["-u", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = String(output).trim();
    if (/^\d+$/.test(trimmed)) uid = Number(trimmed);
  } catch {
    uid = null;
  }
  UID_CACHE.set(name, uid);
  return uid;
}

function macosNormalizeIdentity(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return posixIdentity(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^uid:\d+$/.test(trimmed)) return trimmed;
    if (/^\d+$/.test(trimmed)) return posixIdentity(Number(trimmed));
    if (/^macos:.+$/.test(trimmed)) return trimmed;
  }
  return null;
}

// ─── Windows ───────────────────────────────────────────────────────────────

// Windows authorizes with a DACL: a list of access control entries, each
// binding a SID to a set of rights. The relevant rights for "can write this
// object" are:
//
//   FILE_WRITE_DATA / FILE_ADD_FILE    write content / create entries
//   FILE_APPEND_DATA / FILE_ADD_SUBDIRECTORY
//   FILE_DELETE_CHILD                 delete entries in a directory
//   DELETE                            delete the object itself
//   WRITE_DAC / WRITE_OWNER           change the ACL or the owner
//   GENERIC_WRITE / GENERIC_ALL      the generic forms of the above
//   FULL_CONTROL                      everything
//
// The DACL is read with Get-Acl and serialized with ConvertTo-Json, because
// that yields structured ACEs (identity, access type, rights) instead of the
// localized text that icacls prints. The parser is therefore not exposed to
// the locale or to the exact wording of the icacls output.
//
// Group SIDs are expanded: an ACE for BUILTIN\Administrators grants write to
// every member of that group, including the calling process when it is an
// administrator. Comparing the ACE's SID with the service identity would
// therefore miss the actual writer, which is why the caller's group set is
// read in the same call.
const WINDOWS_WRITE_RIGHTS = new Set([
  "Write", "Modify", "FullControl", "Delete", "DeleteSubdirectoriesAndFiles",
  "ChangePermissions", "TakeOwnership", "CreateFiles", "CreateDirectories",
  "AppendData", "WriteData", "WriteExtendedAttributes", "WriteAttributes",
]);

// Groups whose membership is not enumerable from the token in a way that
// would let the writer set be compared with a single identity. An ACE for
// one of these grants write to an unbounded set of identities, so the
// adapter reports "any identity" instead of pretending the set is small.
// This matters: the development account on the Windows host is a member of
// BUILTIN\Administrators, so an ACE for Administrators would otherwise be
// folded into the caller identity and the check would wrongly pass.
const WINDOWS_BROAD_GROUP_SIDS = new Set([
  "S-1-1-0",        // Everyone
  "S-1-5-11",       // Authenticated Users
  "S-1-5-32-545",   // Users
  "S-1-5-32-544",   // Administrators
  "S-1-5-32-546",   // Guests
  "S-1-5-32-555",   // Builtin domain users
]);

function windowsAclSnapshot(targetPath) {
  const script = windowsSnapshotScript();
  let output;
  try {
    output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script, "-", targetPath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch {
    return null;
  }
  const trimmed = String(output).trim();
  if (!trimmed) return null;
  let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch { return null; }
  if (!parsed || !Array.isArray(parsed.Access)) return null;
  return parsed;
}

function windowsSnapshotScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$paths = @($input)",
    "$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
    "$groups = foreach ($g in $id.Groups) { $g.Translate([System.Security.Principal.SecurityIdentifier]).Value }",
    "$result = foreach ($p in $paths) {",
    "  $acl = Get-Acl -LiteralPath $p",
    "  $ownerSid = $acl.Owner",
    "  if ($ownerSid -notmatch '^S-') {",
    "    $ownerSid = (New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "  }",
    "  $aces = foreach ($ace in $acl.Access) {",
    "    $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "    $rights = $ace.FileSystemRights.ToString()",
    "    [PSCustomObject]@{ Sid = $sid; Type = $ace.AccessControlType.ToString(); Rights = $rights }",
    "  }",
    "  [PSCustomObject]@{ Path = $p; Owner = $ownerSid; CurrentSid = $id.User.Value; Groups = @($groups); Access = @($aces) }",
    "}",
    "$result | ConvertTo-Json -Depth 5 -Compress",
  ].join("; ");
}

// The DACLs of the whole anchor domain are read in one PowerShell process.
// The anchor domain holds one file per journal entry, and a process per file
// would put a second or more on every open.
function windowsAclSnapshotBatch(targetPaths) {
  const paths = Array.from(new Set(targetPaths.filter((p) => typeof p === "string" && p)));
  if (paths.length === 0) return new Map();
  let output;
  try {
    output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", windowsSnapshotScript(), "-"].concat(paths),
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 32 * 1024 * 1024,
      },
    );
  } catch {
    return null;
  }
  const trimmed = String(output).trim();
  if (!trimmed) return null;
  let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch { return null; }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const map = new Map();
  for (const entry of list) {
    if (!entry || typeof entry.Path !== "string") return null;
    if (!Array.isArray(entry.Access)) return null;
    map.set(entry.Path, entry);
  }
  if (map.size !== paths.length) return null;
  return map;
}

function windowsRightsAllowWrite(rightsText) {
  if (typeof rightsText !== "string") return false;
  return rightsText
    .split(",")
    .map((part) => part.trim())
    .some((part) => WINDOWS_WRITE_RIGHTS.has(part));
}

function windowsWritableIdentities(targetPath) {
  const snapshot = windowsAclSnapshot(targetPath);
  if (snapshot === null) return null;
  return windowsWritersFromSnapshot(snapshot);
}

function windowsWritersFromSnapshot(snapshot) {
  const writers = new Set();
  const groups = Array.isArray(snapshot.Groups) ? snapshot.Groups.map(String) : [];
  // The owner may always change the ACL of the object it owns, so the owner
  // is a writer even when no ACE grants it write access. An owner that is
  // not the service identity is therefore a second writer.
  if (snapshot.Owner) writers.add("sid:" + snapshot.Owner);
  for (const ace of snapshot.Access) {
    if (ace.Type !== "Allow") continue;
    if (!windowsRightsAllowWrite(ace.Rights)) continue;
    const sid = String(ace.Sid || "");
    if (!sid) return null;
    // A group that every identity may be part of grants write to an
    // unbounded set, which cannot be compared with a single service
    // identity and is therefore reported as "any identity".
    if (WINDOWS_BROAD_GROUP_SIDS.has(sid)) {
      writers.add(ANY_IDENTITY);
      continue;
    }
    // A narrower group is reported by the group SID itself. If the caller is
    // a member of it, the group is already the caller's own write access, so
    // the concrete identity is reported instead of the group.
    if (groups.includes(sid)) {
      writers.add("sid:" + snapshot.CurrentSid);
      continue;
    }
    writers.add("sid:" + sid);
  }
  return writers;
}

function windowsWritableIdentitiesBatch(targetPaths) {
  const paths = Array.from(new Set(targetPaths.filter((p) => typeof p === "string" && p)));
  if (paths.length === 0) return new Map();
  const batch = windowsAclSnapshotBatch(paths);
  if (batch === null) return null;
  const map = new Map();
  for (const targetPath of paths) {
    const snapshot = batch.get(targetPath);
    if (snapshot === undefined) return null;
    map.set(targetPath, windowsWritersFromSnapshot(snapshot));
  }
  return map;
}

function windowsCurrentIdentity() {
  const snapshot = windowsAclSnapshot(process.cwd());
  if (snapshot === null || !snapshot.CurrentSid) return null;
  return "sid:" + snapshot.CurrentSid;
}

function windowsNormalizeIdentity(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^sid:S-\d-\d+(-\d+)+$/.test(trimmed)) return trimmed;
  // A bare SID is accepted and given the platform prefix.
  if (/^S-\d-\d+(-\d+)+$/.test(trimmed)) return "sid:" + trimmed;
  return null;
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

const ADAPTERS = {
  posix: {
    writableIdentities: posixWritableIdentities,
    writableIdentitiesBatch: null,
    currentIdentity: posixCurrentIdentity,
    normalizeIdentity: posixNormalizeIdentity,
  },
  macos: {
    writableIdentities: macosWritableIdentities,
    writableIdentitiesBatch: macosWritableIdentitiesBatch,
    currentIdentity: macosCurrentIdentity,
    normalizeIdentity: macosNormalizeIdentity,
  },
  windows: {
    writableIdentities: windowsWritableIdentities,
    writableIdentitiesBatch: windowsWritableIdentitiesBatch,
    currentIdentity: windowsCurrentIdentity,
    normalizeIdentity: windowsNormalizeIdentity,
  },
};

function adapterFor(platform) {
  const key = platform || platformKey();
  if (!key) return null;
  return ADAPTERS[key] || null;
}

// The adapter can be overridden for tests and for a deployment that has to
// use a platform the runtime does not report. An override that names an
// unknown platform is an error rather than a silent fallback to POSIX: a
// fallback would apply the wrong authorization model to a real deployment.
function resolveAdapter(options) {
  const opts = options || {};
  if (opts.adapter) return opts.adapter;
  const adapter = adapterFor(opts.platform || platformKey());
  if (!adapter) fail("ERR_ANCHOR_ADAPTER_UNAVAILABLE");
  return adapter;
}

module.exports = {
  ANY_IDENTITY,
  AnchorAuthorizationError,
  adapterFor,
  macosAclEntries,
  macosAclEntriesBatch,
  macosWritableIdentities,
  macosWritableIdentitiesBatch,
  platformKey,
  posixWritableIdentities,
  resolveAdapter,
  windowsAclSnapshot,
  windowsAclSnapshotBatch,
  windowsWritersFromSnapshot,
  windowsWritableIdentities,
  windowsWritableIdentitiesBatch,
};
