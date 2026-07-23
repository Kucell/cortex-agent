"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

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

function queryManagementProject(ctx, projection, extraArgs = []) {
  const resolved = resolveManagementProject(ctx);
  if (!resolved.ok) return resolved;
  const script = managementScript(resolved.project);
  if (!fs.existsSync(script)) {
    return projectError("MANAGEMENT_API_UNAVAILABLE", "Target project is missing the Management API script.", {
      script,
    });
  }

  const result = spawnSync(process.execPath, [script, "query", projection, ...extraArgs], {
    cwd: resolved.project.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return projectError("MANAGEMENT_API_UNAVAILABLE", result.error.message, { script });
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch (_) {
    return projectError("MANAGEMENT_API_INVALID_OUTPUT", "Management API returned invalid JSON.", {
      stderr: String(result.stderr || "").trim(),
      status: result.status,
    });
  }

  if (result.status !== 0 || !payload || payload.ok !== true) {
    const rawCode = payload && payload.error ? payload.error : "MANAGEMENT_API_QUERY_FAILED";
    const code = String(rawCode).replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
    return projectError(code, payload && payload.message ? payload.message : `Management API query failed: ${rawCode}`, {
      projection,
      status: result.status,
    }, result.status === 2 ? 2 : 3);
  }

  return { ok: true, payload, project: resolved.project };
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
    filters: {},
    data,
    summary: payload.summary || {},
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    generated_at: payload.generated_at || null,
  };
}

module.exports = {
  attachProject,
  formatQueryPayload,
  queryManagementProject,
  resolveManagementProject,
};
