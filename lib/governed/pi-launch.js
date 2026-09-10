"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { executeGovernedLaunch } = require("./launch-cli");

const FORBIDDEN_FLAGS = new Set(["--command", "--allow-command", "--agent-arg", "--pi-command"]);

function option(args, name) {
  const marker = `--${name}`;
  const inline = args.find((value) => value.startsWith(`${marker}=`));
  if (inline) return inline.slice(marker.length + 1);
  const index = args.indexOf(marker);
  return index < 0 ? undefined : args[index + 1];
}

function fail(code, message, exitCode = 2) {
  return { ok: false, code, message, exitCode };
}

function findOnPath(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) { /* continue */ }
  }
  return null;
}

function resolvePiCommand() {
  const candidate = findOnPath("pi");
  if (!candidate) return null;
  if (path.basename(candidate) !== "pi") return null;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return path.resolve(candidate);
  } catch (_) {
    return null;
  }
}

function resolveTaskFile(worktree, value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const file = path.resolve(worktree, value);
  const relative = path.relative(worktree, file);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch (_) {
    return null;
  }
}

function piArguments(sessionId, taskFile, model, thinking) {
  const args = ["--mode", "json", "--print", "--session-id", sessionId];
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  args.push(`@${taskFile}`, "Execute the assigned Cortex task. Report blockers honestly and do not claim completion without evidence. End only after the Pi host emits its agent_settled event.");
  return args;
}

async function executeGovernedPiLaunch(args, dependencies = {}) {
  const input = Array.isArray(args) ? args : [];
  if (input.some((value) => FORBIDDEN_FLAGS.has(value) || [...FORBIDDEN_FLAGS].some((flag) => value.startsWith(`${flag}=`)))) {
    return fail("ERR_PI_ARGUMENT_FORBIDDEN", "Pi governed launch does not accept generic command or agent-arg overrides.");
  }
  const projectRoot = path.resolve(dependencies.projectRoot || process.cwd());
  const worktree = option(input, "worktree") || projectRoot;
  if (!path.isAbsolute(worktree) || path.resolve(worktree) !== projectRoot) {
    return fail("ERR_WORKTREE_REQUIRED", "Pi governed launch requires the explicit current project worktree.");
  }
  const piCommand = resolvePiCommand();
  if (!piCommand) return fail("ERR_PI_UNAVAILABLE", "Pi executable is unavailable or not an approved pi command.", 4);
  const taskFile = resolveTaskFile(projectRoot, option(input, "task-file"));
  if (!taskFile) return fail("ERR_PI_TASK_FILE", "--task-file must name an existing regular file under the project worktree.");
  const sessionId = option(input, "session-id");
  if (!sessionId) return fail("INVALID_USAGE", "Pi governed launch requires --session-id.");

  const launchArgs = [...input,
    "--command", piCommand,
    "--allow-command", piCommand,
  ];
  for (const arg of piArguments(sessionId, taskFile, option(input, "model"), option(input, "thinking"))) {
    launchArgs.push("--agent-arg", arg);
  }
  const launch = dependencies.executeLaunch || executeGovernedLaunch;
  return launch(launchArgs, { ...dependencies, projectRoot });
}

module.exports = { executeGovernedPiLaunch, piArguments, resolvePiCommand, resolveTaskFile };
