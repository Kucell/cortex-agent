"use strict";

// ─── secrets (L1 secrets-vcs — public CLI surface) ────────────────────────────
// Two responsibilities:
//   1. Provider-verify (npm). Hard-codes the registry + identity check so
//      operators get a single `secrets verify --ref … --provider npm` knob.
//   2. Secret-injection for arbitrary HTTP clients (Codex / Claude Code /
//      custom MCP servers).  Adds three new actions — `resolve`,
//      `render-bearer`, and `inject` — that turn `secret://<ref>` into
//      either a Codex `bearer_token_env_var` snippet or a child-process
//      env var.  None of these actions ever print the secret value to
//      stdout; the value lives only in the spawned child's environment.
//
// Why this lives here (not in `.agent/skills/secrets/scripts/index.js`):
//   - The skill owns storage (get/store/rotate/delete across 4 backends).
//     It is intentionally thin and does not know about Codex or HTTP.
//   - The public CLI owns the *wiring contract* between secrets and
//     consumers.  Adding a new consumer (e.g. an HTTP fetcher) only
//     touches this file; the storage skill stays untouched.

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { spawnSync, spawn } = childProcess;

const ACTIONS = new Set([
  "store",
  "verify",
  "list",
  "audit",
  "resolve",
  "render-bearer",
  "inject",
]);
const PROVIDERS = new Set(["npm"]);
// Bearer-style auth profiles we currently know how to render.  New entries
// must be added here *and* paired with a render branch in `renderBearer`.
// Anything else falls through to a hard fail-closed error so a typo or
// regression can't silently emit an unauthenticated MCP server block.
const BEARER_AUTH_PROFILES = new Set(["bearer_secret", "none"]);
// Strict env-var name pattern: POSIX-portable, prevents shell metachars.
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
// Same ref shape the skill already validates, kept here so public CLI
// rejects malformed refs at the boundary instead of round-tripping to
// the skill only to fail later.
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function option(args, name) {
  const exact = args.indexOf(name);
  if (exact >= 0) {
    const value = args[exact + 1];
    return value && !value.startsWith("--") ? value : null;
  }
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function result(ok, payload, exitCode = ok ? 0 : 2) {
  return { ok, exitCode, ...payload };
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout || "{}");
  } catch (_) {
    return null;
  }
}

function secretsScriptPath(ctx) {
  return path.join(ctx.cwd, ".agent", "skills", "secrets", "scripts", "index.js");
}

function readSecretsConfig(cwd) {
  // Mirror the skill's flat YAML-ish parser (it intentionally does not
  // ship a real YAML parser).  We only need the `default_backend` and the
  // list of declared `ref` entries for the `inject` gate.
  const configPath = path.join(cwd, ".agent", "config", "secrets.yml");
  if (!fs.existsSync(configPath)) return { exists: false, default_backend: null, refs: [] };
  const text = fs.readFileSync(configPath, "utf8");
  const out = { exists: true, default_backend: null, refs: [] };
  let inSecrets = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "");
    if (!line.trim()) continue;
    const top = line.match(/^(default_backend|backend):\s+(\S+)/);
    if (top) {
      out.default_backend = top[2];
      inSecrets = false;
      continue;
    }
    if (/^secrets:/.test(line.trim())) { inSecrets = true; continue; }
    if (inSecrets) {
      const m = line.match(/^\s*-\s+ref:\s+(\S+)/);
      if (m) out.refs.push(m[1]);
    }
  }
  return out;
}

function defaultEnvVar(ref, server) {
  // Stable, grep-friendly env var name.  SamHMI's MCP synchronizer and
  // any future consumer read this back via `secrets resolve` so the
  // contract stays one-way: cortex-agent owns the naming convention.
  if (server && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(server)) {
    return `CORTEX_MCP_${server.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
  }
  return `CORTEX_SECRET_${ref.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function renderBearer({ server, url, ref, envVar, auth }) {
  // Emit a Codex `[mcp_servers.<name>]` TOML block.  The output is meant
  // to be appended to `.codex/config.toml` by the consumer (e.g. the
  // SamHMI synchronizer).  Crucially, the secret value is NEVER embedded
  // here — only the env-var name, which Codex will resolve at launch
  // time via `bearer_token_env_var`.
  const lines = [];
  lines.push(`[mcp_servers.${server}]`);
  lines.push(`url = ${JSON.stringify(url)}`);
  if (auth === "bearer_secret") {
    lines.push(`bearer_token_env_var = ${JSON.stringify(envVar)}`);
    lines.push(`# source: secret://${ref}  (resolved at launch by Cortex Host)`);
  } else if (auth === "none") {
    lines.push(`# auth: none — bearer_token_env_var intentionally omitted`);
  } else {
    return null; // fail-closed: unknown auth profile
  }
  return `${lines.join("\n")}\n`;
}

function runSecrets(ctx, dependencies = {}) {
  // Two injection points so tests can stub each independently:
  //   - `spawnSync` is used for the *storage skill* round-trip
  //     (secrets list / get / store).  Existing tests already use it.
  //   - `spawn` is used for the *child command* in `inject`.  It defaults
  //     to node's async `child_process.spawn` so the child's stdio
  //     inherits our tty — `codex` (and any other interactive host) must
  //     not be run via `spawnSync` (that would block and lose the prompt).
  const spawnSyncDep = dependencies.spawnSync || spawnSync;
  const spawnDep = dependencies.spawn || spawn;
  return runSecretsAsync(ctx, { ...dependencies, spawnSync: spawnSyncDep, spawn: spawnDep });
}

async function runSecretsAsync(ctx, dependencies) {
  const spawnSyncDep = dependencies.spawnSync;
  const spawnDep = dependencies.spawn;
  // Legacy alias so the pre-existing store/list/audit/verify paths keep
  // their `spawn(...)` call sites.  The new actions are explicit about
  // whether they want the *storage* spawn (sync) or the *child* spawn
  // (async) by destructuring the right one.
  const spawn = spawnSyncDep;
  const args = ctx.args.slice(1);
  const action = args[0];
  if (!ACTIONS.has(action)) {
    return result(false, {
      error: "invalid_usage",
      usage: "cortex-agent secrets <store|verify|list|audit|resolve|render-bearer|inject> [options]",
    });
  }

  const script = secretsScriptPath(ctx);
  if (!fs.existsSync(script)) {
    return result(false, {
      error: "secrets_skill_unavailable",
      message: `Secrets skill is unavailable for project: ${ctx.cwd}`,
    }, 3);
  }

  // ── New: secret-injection actions (resolve / render-bearer / inject) ──
  // These are independent of the storage skill's providers: a `secret://<ref>`
  // resolves through whichever backend is configured (keychain/secret-service/
  // file-gpg/env), and the consumer (Codex, custom MCP server, …) only ever
  // sees the env-var name and the launched process.  No plaintext ever
  // crosses this CLI's stdout.
  if (action === "resolve") {
    return resolveAction({ ctx, script, spawn: spawnSyncDep });
  }
  if (action === "render-bearer") {
    return renderBearerAction({ ctx, script, spawn: spawnSyncDep });
  }
  if (action === "inject") {
    return injectAction({ ctx, script, spawn: spawnSyncDep, spawnChild: spawnDep });
  }

  if (action === "list" || action === "audit") {
    const child = spawn(process.execPath, [script, action, "--gate", "agent"], {
      cwd: ctx.cwd,
      encoding: "utf8",
    });
    const body = parseJson(child.stdout);
    return child.status === 0 && body
      ? result(true, { action, data: body })
      : result(false, { error: "secrets_backend_failed", action }, child.status || 1);
  }

  const ref = option(args, "--ref");
  if (!ref || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref)) {
    return result(false, { error: "invalid_ref", message: "--ref is required and must be a stable identifier." });
  }

  if (action === "store") {
    const envName = option(args, "--from-env");
    if (!envName || !/^[A-Z_][A-Z0-9_]*$/.test(envName)) {
      return result(false, {
        error: "secure_input_required",
        message: "Use --from-env <ENV_NAME>; --value is intentionally unsupported by the public CLI.",
      });
    }
    const secret = process.env[envName];
    if (!secret) return result(false, { error: "secret_env_missing", env: envName });
    const child = spawn(process.execPath, [
      script, "store", "--ref", ref, "--value", secret, "--gate", "user",
    ], { cwd: ctx.cwd, encoding: "utf8" });
    const body = parseJson(child.stdout);
    return child.status === 0 && body && body.ok
      ? result(true, { action, ref, secret_uri: `secret://${ref}`, backend: "configured" })
      : result(false, { error: "secrets_backend_failed", action, ref }, child.status || 1);
  }

  const provider = option(args, "--provider") || "npm";
  if (!PROVIDERS.has(provider)) {
    return result(false, { error: "unsupported_provider", supported: [...PROVIDERS] });
  }
  const get = spawn(process.execPath, [
    script, "get", "--ref", ref, "--no-mask", "--gate", "user",
  ], { cwd: ctx.cwd, encoding: "utf8" });
  const secretBody = parseJson(get.stdout);
  if (get.status !== 0 || !secretBody || !secretBody.ok || typeof secretBody.value !== "string") {
    return result(false, { error: "secret_unavailable", ref }, get.status || 1);
  }

  const registry = option(args, "--registry") || "https://registry.npmjs.org/";
  const verified = spawn("npm", ["whoami", "--registry", registry], {
    cwd: ctx.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      "npm_config_//registry.npmjs.org/:_authToken": secretBody.value,
    },
  });
  if (verified.status !== 0) {
    return result(false, {
      error: "provider_verification_failed",
      provider,
      ref,
      registry,
    }, verified.status || 1);
  }
  return result(true, {
    action,
    provider,
    ref,
    secret_uri: `secret://${ref}`,
    registry,
    identity: String(verified.stdout || "").trim(),
  });
}

async function secretsCommand(ctx, dependencies) {
  const response = await runSecrets(ctx, dependencies);
  // The response envelope never carries the secret value.  `inject`
  // returns child metadata only; the value lives in the spawned
  // process's env and is gone when the child exits.  We still pass the
  // envelope through JSON.stringify so accidental `console.log(response)`
  // later in the calling shell script never gets a chance to leak the
  // value via debugger-style printing.
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  // For `inject` we forward the child's exit code on success too.  For
  // every other action success is exit 0 and failures use the response's
  // own exitCode.
  process.exitCode = response.exitCode;
  return response;
}

// ─── resolve ──────────────────────────────────────────────────────────────────
// Look up the secrets config for a ref and emit the *binding* the rest of
// the system uses — env-var name, declared backend, declared service
// account — without ever touching the secret value.  Consumers call this
// at planning time to wire up Codex config / a launch wrapper.
function resolveAction({ ctx, script, spawn }) {
  const ref = option(ctx.args, "--ref");
  if (!ref || !REF_NAME.test(ref)) {
    return result(false, { error: "invalid_ref", message: "--ref is required and must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/." });
  }
  const server = option(ctx.args, "--server");
  const envVar = option(ctx.args, "--env") || defaultEnvVar(ref, server);
  if (!ENV_NAME.test(envVar)) {
    return result(false, { error: "invalid_env_var", message: `--env ${JSON.stringify(envVar)} does not match ${ENV_NAME}` });
  }
  const cfg = readSecretsConfig(ctx.cwd);
  const declared = cfg.refs.includes(ref);
  const backend = option(ctx.args, "--backend") || cfg.default_backend || "keychain";
  // We *list* (read-only) to confirm the ref is reachable.  The skill's
  // `list` action returns no values, only declared refs + backend metadata.
  const listChild = spawn(process.execPath, [script, "list", "--gate", "agent"], {
    cwd: ctx.cwd,
    encoding: "utf8",
  });
  const listBody = parseJson(listChild.stdout);
  if (listChild.status !== 0 || !listBody || !listBody.ok) {
    return result(false, {
      error: "secrets_backend_failed",
      action: "resolve",
      ref,
    }, listChild.status || 1);
  }
  if (!declared && cfg.exists) {
    return result(false, {
      error: "ref_undeclared",
      message: `ref ${ref} is not declared in .agent/config/secrets.yml. Add it before resolve/inject will succeed.`,
      ref,
      env_var: envVar,
    });
  }
  return result(true, {
    action: "resolve",
    ref,
    secret_uri: `secret://${ref}`,
    env_var: envVar,
    backend,
    declared,
    note: "Value not returned by design. Use `secrets inject` to land it in a child process env.",
  });
}

// ─── render-bearer ────────────────────────────────────────────────────────────
// Produce a Codex-compatible `[mcp_servers.<name>]` TOML block.  The block
// references the env-var name only; the value is fetched at launch time by
// `secrets inject` (or any other Cortex Host that knows the contract).
// SamHMI's MCP synchronizer calls this and merges the result into the
// project's `.codex/config.toml`.
function renderBearerAction({ ctx, script, spawn }) {
  const server = option(ctx.args, "--server");
  const url = option(ctx.args, "--url");
  const ref = option(ctx.args, "--ref");
  const auth = option(ctx.args, "--auth") || "bearer_secret";
  if (!server || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(server)) {
    return result(false, { error: "invalid_server", message: "--server <name> is required (1-64 chars, [A-Za-z][A-Za-z0-9_-])." });
  }
  if (!url || !/^https?:\/\//.test(url)) {
    return result(false, { error: "invalid_url", message: "--url must be an http(s) URL." });
  }
  if (!BEARER_AUTH_PROFILES.has(auth)) {
    return result(false, {
      error: "unsupported_auth",
      message: `--auth ${auth} is not supported by render-bearer. Supported: ${[...BEARER_AUTH_PROFILES].join(", ")}.`,
    });
  }
  if (auth === "bearer_secret" && (!ref || !REF_NAME.test(ref))) {
    return result(false, { error: "invalid_ref", message: "auth=bearer_secret requires --ref <name>." });
  }
  const envVar = option(ctx.args, "--env") || defaultEnvVar(ref, server);
  if (!ENV_NAME.test(envVar)) {
    return result(false, { error: "invalid_env_var", message: `--env ${JSON.stringify(envVar)} does not match ${ENV_NAME}` });
  }
  const toml = renderBearer({ server, url, ref, envVar, auth });
  if (toml === null) {
    return result(false, { error: "render_failed", message: `No render branch for auth=${auth}.` });
  }
  return result(true, {
    action: "render-bearer",
    server,
    url,
    auth,
    ref: ref || null,
    secret_uri: ref ? `secret://${ref}` : null,
    env_var: envVar,
    toml,
  });
}

// ─── inject ───────────────────────────────────────────────────────────────────
// The Cortex Host entry point.  Resolves the ref, sets the named env var
// in the child process, and execs the command.  Three things this function
// MUST guarantee:
//
//   1. The ref is declared in `.agent/config/secrets.yml` (fail-closed:
//      a typo in `--ref` must not let the keychain leak through).
//   2. The env-var name is POSIX-portable (no shell metachars).
//   3. The child is spawned with `shell: false` and explicit args (no
//      shell-string interpolation, no implicit defaults).
//
// On success the child inherits stdout/stderr so `codex …` behaves
// normally.  We capture the child's exit code and return it as our own.
//
// Async on purpose: the child must be spawned via `child_process.spawn`
// (NOT `spawnSync`) so its stdio stays attached to our tty.  An
// interactive host like Codex is unusable when run synchronously.
function injectAction({ ctx, script, spawn, spawnChild }) {
  const ref = option(ctx.args, "--ref");
  if (!ref || !REF_NAME.test(ref)) {
    return Promise.resolve(result(false, { error: "invalid_ref", message: "--ref is required and must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/." }));
  }
  const envName = option(ctx.args, "--env");
  if (!envName || !ENV_NAME.test(envName)) {
    return Promise.resolve(result(false, { error: "invalid_env_var", message: `--env <NAME> is required and must match ${ENV_NAME}` }));
  }
  // The args to the child command follow `--` (POSIX convention).  This
  // keeps the parser simple and shell-safe: everything after `--` is the
  // literal argv to the child, no globbing, no metachars.
  const sepIdx = ctx.args.indexOf("--");
  const childArgs = sepIdx >= 0 ? ctx.args.slice(sepIdx + 1) : [];
  if (childArgs.length === 0) {
    return Promise.resolve(result(false, { error: "missing_command", message: "inject requires a command after `--`, e.g. `-- codex`." }));
  }
  const cfg = readSecretsConfig(ctx.cwd);
  if (cfg.exists && !cfg.refs.includes(ref)) {
    return Promise.resolve(result(false, {
      error: "ref_undeclared",
      message: `ref ${ref} is not declared in .agent/config/secrets.yml. Add it before injecting.`,
      ref,
    }));
  }
  // Resolve the ref through the skill with --no-mask so the value lands
  // in our process.  We never echo it; it is bound directly to the
  // child env below.
  const getChild = spawn(process.execPath, [
    script, "get", "--ref", ref, "--no-mask", "--gate", "user",
  ], { cwd: ctx.cwd, encoding: "utf8" });
  const getBody = parseJson(getChild.stdout);
  if (getChild.status !== 0 || !getBody || !getBody.ok || typeof getBody.value !== "string") {
    return Promise.resolve(result(false, {
      error: "secret_unavailable",
      ref,
      note: "inject could not resolve the ref via the secrets skill.",
    }, getChild.status || 1));
  }
  const value = getBody.value;
  // The value never appears in any of our own logs.  Note that the JSON
  // envelope we return *must not* contain the value either — only the
  // fact that injection succeeded and which env var was set.
  const childEnv = { ...process.env, [envName]: value };
  return new Promise((resolve) => {
    const child = spawnChild(childArgs[0], childArgs.slice(1), {
      cwd: ctx.cwd,
      env: childEnv,
      stdio: "inherit",
      shell: false,
    });
    if (child.error) {
      resolve(result(false, {
        error: "child_spawn_failed",
        ref,
        env_var: envName,
        child_error: String(child.error.code || child.error.message || "spawn_error"),
      }, 1));
      return;
    }
    // Forward the child's exit code.  Signal exits get 128+signum per
    // POSIX convention so callers can still distinguish them.
    child.on("exit", (code, signal) => {
      let exitCode = 0;
      if (typeof code === "number") exitCode = code;
      else if (signal) exitCode = 128 + (typeof childProcess.constants?.signals?.[signal] === "number" ? childProcess.constants.signals[signal] : 1);
      resolve(result(true, {
        action: "inject",
        ref,
        secret_uri: `secret://${ref}`,
        env_var: envName,
        backend: getBody.backend || (cfg.default_backend || "keychain"),
        child_argv: childArgs,
        child_exit_code: exitCode,
        note: "Secret value never returned. The child process received it only via env.",
      }, exitCode));
    });
  });
}

module.exports = {
  ACTIONS,
  PROVIDERS,
  BEARER_AUTH_PROFILES,
  option,
  runSecrets,
  secretsCommand,
  defaultEnvVar,
  renderBearer,
};
