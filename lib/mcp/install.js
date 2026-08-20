"use strict";

/**
 * lib/mcp/install.js — per-agent MCP config writer (P-002 MS-003).
 *
 * Writes the cortex-agent MCP server entry into a target coding agent's
 * config file, mirroring open-design's `od mcp install <agent>` protocol:
 *
 *   {
 *     "command": "cortex-agent",
 *     "args": ["mcp", "serve"],
 *     "env": { "CORTEX_AGENT_PROJECT_ROOT": "<cwd>", "CORTEX_AGENT_MCP_TOKEN": "<hex32>" }
 *   }
 *
 * Supported config formats:
 *   json  — merge under a `mcpServers` (or kind-specific) object key
 *   toml  — append/replace a `[mcp_servers.<name>]` section (Codex CLI)
 *   unknown — agent has no known public config path: warn and refuse
 *
 * Safety (P-002 §4.4 / R7):
 *   - `--token` must be exactly 32 hex bytes (64 chars) when supplied
 *   - tokens are auto-generated with crypto.randomBytes(32) otherwise
 *   - config files are written atomically (tmp + rename) with 0600 perms
 *   - `dryRun` performs zero writes and returns the would-be snippet
 *
 * Zero npm deps — node:fs / node:path / node:crypto / node:os only.
 * `io` is injectable for tests (defaults to node:fs).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const TOKEN_RE = /^[0-9a-f]{64}$/; // hex32 (32 bytes → 64 hex chars)
const SERVER_NAME = "cortex-agent";

/**
 * Per-agent config metadata. `format` is one of "json" | "toml" | "unknown".
 * `key` is the JSON object key that holds the server map (mcpServers for most
 * agents; opencode uses `mcp`). `bestEffort` marks paths that follow the
 * upstream convention but are not officially documented — they still get a
 * warning on install.
 */
const AGENTS = {
  claude: { format: "json", key: "mcpServers", configPath: (home) => path.join(home, ".claude", "mcp_servers.json") },
  "claude-desktop": { format: "json", key: "mcpServers", configPath: (home) => path.join(home, ".config", "Claude", "claude_desktop_config.json") },
  codex: { format: "toml", configPath: (home) => path.join(home, ".codex", "config.toml") },
  cursor: { format: "json", key: "mcpServers", configPath: (home) => path.join(home, ".cursor", "mcp.json") },
  copilot: { format: "json", key: "mcpServers", configPath: (home) => path.join(home, ".config", "github-copilot", "mcp.json") },
  dsh: { format: "json", key: "mcpServers", configPath: (home) => path.join(home, ".config", "dsh", "mcp.json") },
  // best-effort: follow the upstream convention; warn on install.
  opencode: { format: "json", key: "mcp", configPath: (home) => path.join(home, ".config", "opencode", "opencode.json"), bestEffort: true },
  cline: { format: "json", key: "mcpServers", configPath: (home) => path.join(home, ".cline", "mcp_settings.json"), bestEffort: true },
  openclaw: { format: "json", key: "mcpServers", configPath: (home) => path.join(home, ".openclaw", "openclaw.json"), bestEffort: true },
  // unknown: no reliable public config path — warn and refuse to write.
  antigravity: { format: "unknown" },
  trae: { format: "unknown" },
  kimi: { format: "unknown" },
  kiro: { format: "unknown" },
  pi: { format: "unknown" },
  vibe: { format: "unknown" },
  hermes: { format: "unknown" },
  reasonix: { format: "unknown" },
  raven: { format: "unknown" },
};

function isKnownAgent(agentId) {
  return Object.prototype.hasOwnProperty.call(AGENTS, agentId);
}

function listAgents() {
  return Object.keys(AGENTS).sort();
}

function validateToken(token) {
  if (token === undefined || token === null || token === "") return null;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    const err = new Error("invalid --token: must be exactly 32 hex bytes (64 lowercase hex chars)");
    err.code = "INVALID_TOKEN";
    return err;
  }
  return null;
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

/** Build the MCP server entry written into agent configs. */
function serverEntry(opts) {
  opts = opts || {};
  const env = { CORTEX_AGENT_PROJECT_ROOT: opts.cwd || process.cwd() };
  if (opts.token) env.CORTEX_AGENT_MCP_TOKEN = opts.token;
  return { command: "cortex-agent", args: ["mcp", "serve"], env };
}

function defaultIo() {
  return {
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    chmodSync: fs.chmodSync,
    renameSync: fs.renameSync,
  };
}

// ─── json writer ─────────────────────────────────────────────────────────────

function writeJsonConfig(agent, configPath, entry, io) {
  let parsed = {};
  if (io.existsSync(configPath)) {
    try {
      parsed = JSON.parse(io.readFileSync(configPath, "utf8"));
    } catch (err) {
      const error = new Error(`existing config is not valid JSON: ${configPath} (${err.message})`);
      error.code = "CONFIG_PARSE_ERROR";
      throw error;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) parsed = {};
  }
  const key = agent.key || "mcpServers";
  const servers = parsed[key] && typeof parsed[key] === "object" && !Array.isArray(parsed[key])
    ? parsed[key]
    : {};
  servers[SERVER_NAME] = entry;
  parsed[key] = servers;
  atomicWriteJson(configPath, parsed, io);
}

function atomicWriteJson(configPath, payload, io) {
  io.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp-${process.pid}`;
  io.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  io.chmodSync(tmpPath, 0o600);
  io.renameSync(tmpPath, configPath);
}

// ─── toml writer (codex) ─────────────────────────────────────────────────────

function tomlEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function writeTomlConfig(configPath, entry, io) {
  let body = "";
  if (io.existsSync(configPath)) {
    try {
      body = io.readFileSync(configPath, "utf8");
    } catch (_) {
      body = "";
    }
  }
  const envLines = Object.keys(entry.env)
    .map((k) => `  ${k} = "${tomlEscape(entry.env[k])}"`)
    .join("\n");
  const section =
    `[mcp_servers.${SERVER_NAME}]\n` +
    `command = "${tomlEscape(entry.command)}"\n` +
    `args = [${entry.args.map((a) => `"${tomlEscape(a)}"`).join(", ")}]\n` +
    (envLines ? `env = {\n${envLines}\n}\n` : "");

  // Replace an existing cortex-agent section, else append.
  const sectionRe = /^\[mcp_servers\.cortex-agent\]\r?\n(?:.*\r?\n)*?(?=^\[|\r?\n*\s*$)/m;
  if (sectionRe.test(body)) {
    body = body.replace(sectionRe, section.endsWith("\n") ? section : section + "\n");
  } else {
    body = body.replace(/\r?\n*$/, "\n") + (body ? "\n" : "") + section;
  }
  io.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp-${process.pid}`;
  io.writeFileSync(tmpPath, body, { encoding: "utf8", mode: 0o600 });
  io.chmodSync(tmpPath, 0o600);
  io.renameSync(tmpPath, configPath);
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Install the cortex-agent MCP server into an agent's config file.
 *
 * @param {string} agentId  one of listAgents()
 * @param {object} [opts]
 * @param {string} [opts.token]     hex32 token (validated; auto-generated if absent)
 * @param {boolean} [opts.dryRun]   zero writes; returns the would-be snippet
 * @param {boolean} [opts.print]    include the JSON snippet in the result
 * @param {string} [opts.cwd]       project root written into env (default process.cwd())
 * @param {string} [opts.home]      home dir for config paths (default os.homedir())
 * @param {object} [opts.io]        fs-like injectable for tests
 * @returns {{ok: boolean, agent: string, format: string, path: string|null,
 *            snippet: object, wrote: boolean, warning?: string}}
 */
function install(agentId, opts) {
  opts = opts || {};
  const io = opts.io || defaultIo();
  const tokenError = validateToken(opts.token);
  if (tokenError) throw tokenError;

  if (!isKnownAgent(agentId)) {
    return {
      ok: false,
      code: "UNKNOWN_AGENT",
      agent: agentId,
      message: `unknown agent "${agentId}". Known agents: ${listAgents().join(", ")}. See .agent/references/runtime-adapters/ for the full 26-agent matrix.`,
    };
  }
  const agent = AGENTS[agentId];
  const token = opts.token || generateToken();
  const cwd = opts.cwd || process.cwd();
  const home = opts.home || os.homedir();
  const entry = serverEntry({ cwd, token });
  const snippet = {
    command: entry.command,
    args: entry.args,
    env: entry.env,
  };

  if (agent.format === "unknown") {
    return {
      ok: false,
      code: "UNKNOWN_CONFIG_PATH",
      agent: agentId,
      format: "unknown",
      path: null,
      snippet,
      warning: `cortex-agent mcp install ${agentId}: no known config path for ${agentId} — install the cortex-agent MCP server manually per .agent/references/runtime-adapters/${agentId}.md`,
    };
  }

  const configPath = agent.configPath(home);
  if (!opts.dryRun) {
    if (agent.format === "json") {
      writeJsonConfig(agent, configPath, entry, io);
    } else if (agent.format === "toml") {
      writeTomlConfig(configPath, entry, io);
    }
  }

  return {
    ok: true,
    agent: agentId,
    format: agent.format,
    path: configPath,
    snippet,
    wrote: !opts.dryRun,
    token,
    ...(agent.bestEffort ? { warning: `best-effort config path for ${agentId}: ${configPath} (verify against ${agentId} docs)` } : {}),
  };
}

/**
 * Uninstall the cortex-agent MCP server entry from an agent config file.
 * JSON formats remove the "cortex-agent" key; TOML removes the section.
 *
 * @returns {{ok: boolean, agent: string, removed: boolean, path: string|null}}
 */
function uninstall(agentId, opts) {
  opts = opts || {};
  const io = opts.io || defaultIo();
  if (!isKnownAgent(agentId)) {
    return { ok: false, code: "UNKNOWN_AGENT", agent: agentId, message: `unknown agent "${agentId}"` };
  }
  const agent = AGENTS[agentId];
  if (agent.format === "unknown") {
    return { ok: false, code: "UNKNOWN_CONFIG_PATH", agent: agentId, path: null, message: `no known config path for ${agentId}` };
  }
  const home = opts.home || os.homedir();
  const configPath = agent.configPath(home);
  if (!io.existsSync(configPath)) return { ok: true, agent: agentId, removed: false, path: configPath };

  if (agent.format === "json") {
    const parsed = JSON.parse(io.readFileSync(configPath, "utf8"));
    const key = agent.key || "mcpServers";
    const servers = parsed[key];
    if (servers && typeof servers === "object" && servers[SERVER_NAME]) {
      delete servers[SERVER_NAME];
      atomicWriteJson(configPath, parsed, io);
      return { ok: true, agent: agentId, removed: true, path: configPath };
    }
    return { ok: true, agent: agentId, removed: false, path: configPath };
  }
  if (agent.format === "toml") {
    let body = io.readFileSync(configPath, "utf8");
    const sectionRe = /^\[mcp_servers\.cortex-agent\]\r?\n(?:.*\r?\n)*?(?=^\[|\r?\n*\s*$)/m;
    if (sectionRe.test(body)) {
      body = body.replace(sectionRe, "");
      io.mkdirSync(path.dirname(configPath), { recursive: true });
      io.writeFileSync(configPath, body, "utf8");
      return { ok: true, agent: agentId, removed: true, path: configPath };
    }
    return { ok: true, agent: agentId, removed: false, path: configPath };
  }
  return { ok: true, agent: agentId, removed: false, path: configPath };
}

/**
 * Report which known agents already have a cortex-agent entry configured.
 *
 * @returns {{ok: boolean, installed: Array<{agent, path, configured: boolean}>}}
 */
function listInstalled(opts) {
  opts = opts || {};
  const io = opts.io || defaultIo();
  const home = opts.home || os.homedir();
  const installed = [];
  for (const agentId of listAgents()) {
    const agent = AGENTS[agentId];
    if (agent.format === "unknown") continue;
    const configPath = agent.configPath(home);
    let configured = false;
    if (io.existsSync(configPath)) {
      try {
        if (agent.format === "json") {
          const parsed = JSON.parse(io.readFileSync(configPath, "utf8"));
          const key = agent.key || "mcpServers";
          configured = Boolean(parsed && parsed[key] && parsed[key][SERVER_NAME]);
        } else if (agent.format === "toml") {
          const body = io.readFileSync(configPath, "utf8");
          configured = /^\[mcp_servers\.cortex-agent\]/m.test(body);
        }
      } catch (_) {
        configured = false;
      }
    }
    installed.push({ agent: agentId, path: configPath, configured });
  }
  return { ok: true, installed };
}

module.exports = {
  AGENTS,
  SERVER_NAME,
  TOKEN_RE,
  isKnownAgent,
  listAgents,
  validateToken,
  generateToken,
  serverEntry,
  install,
  uninstall,
  listInstalled,
  // exposed for tests
  _internal: { writeJsonConfig, writeTomlConfig, atomicWriteJson, tomlEscape, defaultIo },
};
