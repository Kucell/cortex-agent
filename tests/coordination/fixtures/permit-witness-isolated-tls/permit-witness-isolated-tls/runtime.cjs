"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function realUserHome() {
  // userInfo uses the OS effective-user record, unlike homedir's HOME override.
  // Never fall back to HOME, USERPROFILE, cwd or an unverified directory.
  const user = os.userInfo(), uid = process.getuid(), euid = process.geteuid();
  const home = user.homedir;
  if (uid !== euid || user.uid !== euid || typeof home !== "string" || home.includes("\0") ||
      !path.isAbsolute(home) || path.normalize(home) !== home || home === path.parse(home).root) {
    throw Error("unverified OS user home");
  }
  const stat = fs.lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== euid || fs.realpathSync(home) !== home) {
    throw Error("unsafe OS user home");
  }
  return home;
}

function childEnvironment(run) {
  // Values are constructed, never copied from process.env. In particular no
  // loader, proxy, credential, developer-directory or user configuration leaks.
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C",
    TMPDIR: path.join(run, "tmp"), TMP: path.join(run, "tmp"), TEMP: path.join(run, "tmp"),
    CLANG_MODULE_CACHE_PATH: path.join(run, "cache"), XDG_CACHE_HOME: path.join(run, "cache") };
}
function directoryIdentity(run, base) {
  const stat = fs.lstatSync(run);
  if (path.dirname(run) !== base || fs.realpathSync(run) !== run || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw Error("unsafe runtime directory");
  }
  return `${stat.dev}:${stat.ino}`;
}
function cleanupResiduals(run, base, identity) {
  // Only after child 'close': never race a live create/write. No recursive
  // removal, following links, Keychain search, or cleanup of another run.
  if (directoryIdentity(run, base) !== identity) throw Error("runtime directory replaced");
  const names = fs.readdirSync(run).filter(name =>
    name === "test-only.keychain-db" || /^test-only\.keychain-db\.sb-[A-Za-z0-9-]+$/.test(name));
  // Validate the entire set before deleting any part of it.
  for (const name of names) {
    const stat = fs.lstatSync(path.join(run, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()) {
      throw Error("unsafe keychain residue");
    }
  }
  for (const name of names) fs.unlinkSync(path.join(run, name));
  const remaining = fs.readdirSync(run).filter(name => name.startsWith("test-only.keychain"));
  if (remaining.length) throw Error("unrecognized keychain residue; refused automatic deletion");
  return { removed: names, remaining };
}
async function cleanupAfterExit(run, base, identity) {
  const removed = [], deadline = Date.now() + 2000;
  let quietSince = Date.now();
  do {
    const row = cleanupResiduals(run, base, identity);
    removed.push(...row.removed);
    if (row.removed.length) quietSince = Date.now();
    if (Date.now() - quietSince >= 500) return {removed,remaining:[],quiet_ms:500};
    await new Promise(resolve => setTimeout(resolve,50));
  } while (Date.now() < deadline);
  throw Error("keychain residue did not settle; cleanup not confirmed");
}
module.exports = { realUserHome, childEnvironment, directoryIdentity, cleanupResiduals, cleanupAfterExit };
