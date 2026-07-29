"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ACTIONS = new Set(["store", "verify", "list", "audit"]);
const PROVIDERS = new Set(["npm"]);

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

function runSecrets(ctx, dependencies = {}) {
  const spawn = dependencies.spawnSync || spawnSync;
  const args = ctx.args.slice(1);
  const action = args[0];
  if (!ACTIONS.has(action)) {
    return result(false, {
      error: "invalid_usage",
      usage: "cortex-agent secrets <store|verify|list|audit> [options]",
    });
  }

  const script = path.join(ctx.cwd, ".agent", "skills", "secrets", "scripts", "index.js");
  if (!fs.existsSync(script)) {
    return result(false, {
      error: "secrets_skill_unavailable",
      message: `Secrets skill is unavailable for project: ${ctx.cwd}`,
    }, 3);
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

function secretsCommand(ctx, dependencies) {
  const response = runSecrets(ctx, dependencies);
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  if (!response.ok) process.exitCode = response.exitCode;
  return response;
}

module.exports = { ACTIONS, PROVIDERS, option, runSecrets, secretsCommand };
