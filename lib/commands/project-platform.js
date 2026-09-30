"use strict";

const {
  createLocalProjectPlatformReadModel,
} = require("../platform/project-read-model-local.js");

function parse(args) {
  const values = Array.isArray(args) ? args.slice(1) : [];
  const out = { subcommand: null, project: null, json: false, help: false };
  for (const value of values) {
    if (value === "--json") out.json = true;
    else if (value === "--help" || value === "-h") out.help = true;
    else if (!value.startsWith("-") && !out.subcommand) out.subcommand = value;
    else if (!value.startsWith("-") && !out.project) out.project = value;
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  cortex-agent project list [--json]",
    "  cortex-agent project inspect <project-id|project-ref> [--json]",
    "  cortex-agent project health [--json]",
    "",
    "Read-only connected-project platform surface.",
    "Registration and mutation remain owner/API concerns and are not exposed here in MS-004.",
  ].join("\n");
}

function print(value, json, io = process) {
  if (json) {
    io.stdout.write(JSON.stringify(value, null, 2) + "\n");
    return;
  }

  if (value && Array.isArray(value.projects)) {
    if (value.projects.length === 0) {
      io.stdout.write("Connected projects: none\n");
      return;
    }
    io.stdout.write(`Connected projects (${value.projects.length}):\n`);
    for (const project of value.projects) {
      io.stdout.write(`  ${project.project_id}  ${project.repository_slug}  ${project.integration_mode}\n`);
    }
    return;
  }

  if (value && value.project) {
    const project = value.project;
    io.stdout.write(`${project.project_id} (${project.repository_slug})\n`);
    io.stdout.write(`  integration: ${project.integration_mode}\n`);
    io.stdout.write(`  drift: ${project.drift && project.drift.detected ? "detected" : "clean"}\n`);
    if (project.authority) {
      io.stdout.write(`  cortex_role: ${project.authority.cortex_role}\n`);
      io.stdout.write(`  authoritative_domain: ${project.authority.authoritative_domain}\n`);
      io.stdout.write(`  authoritative_runtime: ${project.authority.authoritative_runtime}\n`);
    }
    return;
  }

  if (value && value.overall) {
    io.stdout.write(`Platform Health: ${value.overall}\n`);
    for (const component of value.components || []) {
      io.stdout.write(`  ${component.id}: ${component.status}\n`);
    }
    return;
  }

  io.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

async function projectPlatformCommand(ctx, dependencies = {}) {
  const parsed = parse(ctx.args);
  const io = dependencies.io || process;
  const createReadModel = dependencies.createReadModel || createLocalProjectPlatformReadModel;

  if (parsed.help || !parsed.subcommand) {
    io.stdout.write(usage() + "\n");
    return;
  }

  let model;
  try {
    model = createReadModel(ctx);
  } catch (error) {
    io.stderr.write(JSON.stringify({
      ok: false,
      error: {
        code: error.code || "ERR_PROJECT_PLATFORM",
        message: error.message,
      },
    }) + "\n");
    process.exitCode = 3;
    return;
  }

  try {
    switch (parsed.subcommand) {
      case "list":
        print(await model.list(), parsed.json, io);
        break;
      case "inspect": {
        if (!parsed.project) {
          io.stderr.write("project inspect: project id/ref required\n");
          process.exitCode = 2;
          return;
        }
        const result = await model.inspect(parsed.project);
        if (!result) {
          io.stderr.write(`project inspect: not found: ${parsed.project}\n`);
          process.exitCode = 2;
          return;
        }
        print(result, parsed.json, io);
        break;
      }
      case "health":
        print(await model.health(), parsed.json, io);
        break;
      default:
        io.stderr.write(`project: unknown subcommand: ${parsed.subcommand}\n`);
        io.stderr.write(usage() + "\n");
        process.exitCode = 2;
    }
  } catch (error) {
    io.stderr.write(JSON.stringify({
      ok: false,
      error: {
        code: error.code || "ERR_PROJECT_PLATFORM",
        message: error.message,
      },
    }) + "\n");
    process.exitCode = 3;
  }
}

module.exports = {
  projectPlatformCommand,
  parse,
  usage,
  print,
};
