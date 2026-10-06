"use strict";

const path = require("node:path");
const {
  status,
  attach,
  detach,
  rebind,
} = require("../governance/lifecycle");

function value(args, name) {
  const direct = args.find((arg) => typeof arg === "string" && arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index >= 0) return args[index + 1] || null;
  return null;
}

function bindingFromArgs(args, prefix = "") {
  const key = (name) => prefix ? `${prefix}-${name}` : name;
  const kind = value(args, key("kind"));
  const locator = value(args, key("locator"));
  const ref = value(args, key("ref"));
  if (!kind && !locator && !ref) return null;
  if (!kind || !locator) {
    const error = new Error(`--${key("kind")} and --${key("locator")} are required together`);
    error.code = "ERR_GOVERNANCE_BINDING_ARGS";
    throw error;
  }
  return { kind, locator, ref: ref || null };
}

function print(payload) {
  process.stdout.write(JSON.stringify({ ok: true, ...payload }, null, 2) + "\n");
}

function fail(error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: {
      code: error.code || "ERR_GOVERNANCE_COMMAND_FAILED",
      message: error.message,
      details: error.details || {},
    },
  }, null, 2) + "\n");
  process.exitCode = 2;
}

function governanceCommand(ctx) {
  const action = ctx.args[1] || "status";
  const projectRoot = ctx.options && ctx.options.project
    ? path.resolve(ctx.cwd, ctx.options.project)
    : ctx.cwd;

  try {
    if (action === "status") {
      print({ command: "governance status", project: status(projectRoot) });
      return;
    }
    if (action === "attach") {
      const binding = bindingFromArgs(ctx.args);
      print({ command: "governance attach", descriptor: attach(projectRoot, binding) });
      return;
    }
    if (action === "detach") {
      const expected = bindingFromArgs(ctx.args, "expected");
      print({ command: "governance detach", descriptor: detach(projectRoot, { expected_current: expected }) });
      return;
    }
    if (action === "rebind") {
      const next = bindingFromArgs(ctx.args);
      const expected = bindingFromArgs(ctx.args, "expected");
      print({ command: "governance rebind", descriptor: rebind(projectRoot, next, { expected_current: expected }) });
      return;
    }
    const error = new Error("Usage: cortex-agent governance <status|attach|detach|rebind> [options]");
    error.code = "ERR_GOVERNANCE_USAGE";
    throw error;
  } catch (error) {
    fail(error);
  }
}

module.exports = { governanceCommand, bindingFromArgs };
