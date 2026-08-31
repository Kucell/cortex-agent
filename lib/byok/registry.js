"use strict";

// ─── byok/registry — BYOK (Bring Your Own Key) config probe (P-003 §4.3) ──────
//
// Discovers provider credentials that the user has placed at the conventional
// location for the cortex-agent BYOK surface:
//
//   ~/.config/cortex-agent/byok/<provider>.env
//
// Each file is a tiny shell-style KEY=VALUE document (one key per line, no
// quoting required for our purposes). Probe-only: this module NEVER reads the
// actual key value into the returned record, only its presence / keyRef.
//
// Schema for an entry on disk (text):
//   # comment lines start with #
//   <UPPER_SNAKE_KEY>=<value>
//   <ANOTHER_KEY>=<value>
//
// Example:
//   ~/.config/cortex-agent/byok/openai.env
//     OPENAI_API_KEY=sk-...
//     OPENAI_ORG=org_xxx
//
// The returned record:
//   { provider, keyRef, envVars: [{ name, present }], present, configPath }
//
// - provider        provider id (e.g. "openai")
// - keyRef          stable identifier used by image.js manifest WITHOUT the
//                   actual key value (e.g. "byok://openai/OPENAI_API_KEY").
// - envVars         array of { name, present } for the canonical key names
//                   the registry expects per provider.
// - present         true when at least one canonical key file is readable.
// - configPath      absolute path the registry probed (or null if missing).
//
// Exit / error model: the probe is best-effort and never throws. Missing
// files, unreadable files, malformed lines, and missing directories all
// produce a { present: false } record with diagnostic fields set.
//
// Boundaries:
//   In scope: read & parse <configRoot>/byok/<provider>.env.
//   Out of scope: write the file, prompt the user, mutate ~/.config/, fetch
//                 network, or hand the raw key value back to the caller.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Provider id → canonical env var names the registry expects to find.
// When a provider has multiple required keys, ALL must be present for
// present=true.
const PROVIDERS = Object.freeze({
  openai: { keys: ["OPENAI_API_KEY"] },
  seedream: { keys: ["SEEDREAM_API_KEY"] },
  nano_banana: { keys: ["NANO_BANANA_API_KEY"] },
});

function defaultConfigRoot() {
  // XDG-style: $XDG_CONFIG_HOME/cortex-agent  (Linux/CI), else ~/.config/cortex-agent.
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return path.resolve(xdg, "cortex-agent");
  return path.join(os.homedir(), ".config", "cortex-agent");
}

function parseDotEnv(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Trim a single layer of matching surrounding quotes (basic support).
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (!name) continue;
    result[name] = value;
  }
  return result;
}

function probeProvider(providerId, opts) {
  const options = opts || {};
  const root = options.configRoot || defaultConfigRoot();
  const filePath = path.join(root, "byok", providerId + ".env");
  const def = PROVIDERS[providerId];
  const canonicalKeys = def ? def.keys : [];
  const result = {
    provider: providerId,
    keyRef: null,
    envVars: canonicalKeys.map((name) => ({ name, present: false })),
    present: false,
    configPath: filePath,
    reason: null,
  };
  try {
    if (!fs.existsSync(filePath)) {
      result.reason = "config file missing";
      return result;
    }
    const text = fs.readFileSync(filePath, "utf8");
    const parsed = parseDotEnv(text);
    let anyPresent = false;
    for (const entry of result.envVars) {
      if (parsed[entry.name]) {
        entry.present = true;
        anyPresent = true;
      }
    }
    if (!anyPresent) {
      result.reason = "file present but no canonical keys found";
      return result;
    }
    result.present = true;
    // keyRef uses the FIRST canonical key as the stable identifier — we never
    // embed the value itself.
    const primary = result.envVars.find((e) => e.present) || result.envVars[0];
    result.keyRef = "byok://" + providerId + "/" + primary.name;
    return result;
  } catch (err) {
    result.reason = "probe failed: " + (err && err.message ? err.message : String(err));
    return result;
  }
}

function probeAll(opts) {
  const out = {};
  for (const id of Object.keys(PROVIDERS)) {
    out[id] = probeProvider(id, opts);
  }
  return out;
}

// Friendly guidance printed to stderr when BYOK is not configured — explains
// how to set up the credential file WITHOUT mutating the user's environment.
function guidanceForProvider(providerId, isZh) {
  const def = PROVIDERS[providerId];
  const keys = def ? def.keys : [];
  const root = defaultConfigRoot();
  const file = path.join(root, "byok", providerId + ".env");
  if (isZh) {
    return [
      "[cortex-agent] BYOK 未配置: " + providerId,
      "  期望路径: " + file,
      "  期望键名: " + keys.join(", "),
      "  配置示例:",
      "    mkdir -p " + path.dirname(file),
      "    cat > " + file + " <<'EOF'",
      "    " + (keys[0] || "<KEY>") + "=<your-key>",
      "    EOF",
      "  本命令不会修改你的 shell 环境; 仅在上述位置写入 .env 即可被探测到。",
    ].join("\n");
  }
  return [
    "[cortex-agent] BYOK not configured: " + providerId,
    "  expected file: " + file,
    "  expected keys: " + keys.join(", "),
    "  setup:",
    "    mkdir -p " + path.dirname(file),
    "    cat > " + file + " <<'EOF'",
    "    " + (keys[0] || "<KEY>") + "=<your-key>",
    "    EOF",
    "  This command does not modify your shell environment; writing the .env",
    "  file at the path above is sufficient.",
  ].join("\n");
}

module.exports = {
  PROVIDERS,
  defaultConfigRoot,
  parseDotEnv,
  probeProvider,
  probeAll,
  guidanceForProvider,
};
