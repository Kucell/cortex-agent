"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const MANAGEMENT_API_MAX_BUFFER = 16 * 1024 * 1024;

function projectError(code, message, details = {}, exitCode = 3) {
  return { ok: false, error: { code, message, details }, exitCode };
}

function canonicalDirectory(candidate) {
  try {
    const resolved = fs.realpathSync(candidate);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch (_) {
    return null;
  }
}

function gitRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  return canonicalDirectory(String(result.stdout || "").trim());
}

function resolveManagementProject(ctx) {
  const hasProjectFlag = ctx.args.some((arg) => arg === "--project" || (typeof arg === "string" && arg.startsWith("--project=")));
  if (hasProjectFlag && !(ctx.options && ctx.options.project)) {
    return projectError("INVALID_PROJECT_OPTION", "--project requires a non-empty path.", {}, 2);
  }
  const explicit = ctx.options && ctx.options.project
    ? path.resolve(ctx.cwd, ctx.options.project)
    : null;
  const root = explicit ? canonicalDirectory(explicit) : gitRoot(ctx.cwd) || canonicalDirectory(ctx.cwd);
  if (!root) {
    return projectError("PROJECT_NOT_FOUND", "Unable to resolve the target project directory.", {
      requested_path: explicit,
    });
  }

  const agentPath = path.join(root, ".agent");
  const agentRoot = canonicalDirectory(agentPath);
  if (!agentRoot) {
    return projectError("PROJECT_AGENT_NOT_FOUND", "Target project does not contain a readable .agent directory.", {
      project_root: root,
      agent_path: agentPath,
      explicit: Boolean(explicit),
    });
  }

  return {
    ok: true,
    project: {
      root,
      agent_root: agentRoot,
    },
  };
}

function managementScript(project) {
  return path.join(project.agent_root, "skills", "management-api", "scripts", "index.js");
}

function classifyManagementFailure(code, status) {
  const normalized = String(code || "management_api_command_failed").toLowerCase();
  if (/gate|owner|recipient|permission|decision_(?:not_approved|gate_mismatch)|requested_by/.test(normalized)) return 4;
  if (/terminal|closed|conflict|atomic|write_failed|lifecycle|expired/.test(normalized)) return 5;
  if (status === 2 || /invalid|required|unsupported|not_found/.test(normalized)) return 2;
  return 3;
}

function invokeManagementProject(ctx, commandArgs) {
  const resolved = resolveManagementProject(ctx);
  if (!resolved.ok) return resolved;
  const script = managementScript(resolved.project);
  if (!fs.existsSync(script)) {
    return projectError("MANAGEMENT_API_UNAVAILABLE", "Target project is missing the Management API script.", {
      script,
    });
  }

  const result = spawnSync(process.execPath, [script, ...commandArgs], {
    cwd: resolved.project.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MANAGEMENT_API_MAX_BUFFER,
  });
  if (result.error) {
    return projectError("MANAGEMENT_API_UNAVAILABLE", result.error.message, { script });
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch (_) {
    const stderr = String(result.stderr || "").trim();
    if (result.status !== 0 && /EACCES|EPERM|ENOTDIR|EROFS|rename|write/i.test(stderr)) {
      return projectError("ATOMIC_WRITE_FAILED", "Management API could not persist the requested state change.", {
        stderr,
        status: result.status,
      }, 5);
    }
    return projectError("MANAGEMENT_API_INVALID_OUTPUT", "Management API returned invalid JSON.", {
      stderr,
      status: result.status,
    });
  }

  if (result.status !== 0 || !payload || payload.ok !== true) {
    const rawCode = payload && payload.error ? payload.error : "MANAGEMENT_API_COMMAND_FAILED";
    const code = String(rawCode).replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
    return projectError(code, payload && payload.message ? payload.message : `Management API command failed: ${rawCode}`, {
      command: commandArgs.slice(0, 2),
      status: result.status,
    }, classifyManagementFailure(rawCode, result.status));
  }

  return { ok: true, payload, project: resolved.project };
}

function queryManagementProject(ctx, projection, extraArgs = []) {
  const result = invokeManagementProject(ctx, ["query", projection, ...extraArgs]);
  if (!result.ok && result.error && result.error.details) result.error.details.projection = projection;
  return result;
}

function attachProject(payload, project) {
  return {
    ...payload,
    project: {
      ...(payload.project && typeof payload.project === "object" ? payload.project : {}),
      root: project.root,
      agent_root: project.agent_root,
    },
  };
}

function formatQueryPayload(payload, projection, capability, project) {
  const excluded = new Set(["ok", "query", "generated_at", "project", "summary", "warnings"]);
  const data = capability.data_field
    ? payload[capability.data_field]
    : Object.fromEntries(Object.entries(payload).filter(([key]) => !excluded.has(key)));
  return {
    ok: true,
    command: "query",
    projection,
    project: {
      root: project.root,
      agent_root: project.agent_root,
    },
    filters: payload.filters && typeof payload.filters === "object" ? payload.filters : {},
    data,
    summary: payload.summary || {},
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    generated_at: payload.generated_at || null,
  };
}

module.exports = {
  attachProject,
  formatQueryPayload,
  invokeManagementProject,
  queryManagementProject,
  resolveManagementProject,
};
