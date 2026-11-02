"use strict";

// Test deployment policy, not a change to supervisor defaults or an OS sandbox.
const KEYS = ["PATH", "TMPDIR", "TMP", "TEMP", ...(process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [])];
const SENTINELS = ["ISOLATION_FAKE_API_KEY", "ISOLATION_PRELOAD_DIR"];
function environment(temp) {
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: temp, TMP: temp, TEMP: temp,
    // CoreFoundation may inject this key on macOS. Supply a deterministic value
    // rather than copying the coordinator's ambient setting.
    ...(process.platform === "darwin" ? { __CF_USER_TEXT_ENCODING: "0x0:0:0" } : {}) };
}
function evidence() {
  return { onlyAllowedEnvironment: Object.keys(process.env).every(key => KEYS.includes(key)),
    unexpectedEnvironmentKeys: Object.keys(process.env).filter(key => !KEYS.includes(key)),
    nodeOptionsAbsent: !Object.hasOwn(process.env, "NODE_OPTIONS"),
    syntheticKeyAbsent: !Object.hasOwn(process.env, SENTINELS[0]),
    preloadDirectoryAbsent: !Object.hasOwn(process.env, SENTINELS[1]) };
}
module.exports = { environment, evidence, SENTINELS };
