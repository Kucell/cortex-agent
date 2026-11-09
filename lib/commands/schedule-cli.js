"use strict";

// ─── `cortex-agent schedule` (M-003 follow-up) ───────────────────────────────
//
// Scheduling for model runs that lives inside cortex instead of an external
// cron entry that shells out to the CLI.
//
//   cortex-agent schedule add --id <id> --agent <adapter:id>
//       (--task <text> | --tasks <file>)
//       (--every <30s|15m|2h|1d> | --cron "<m h dom mon dow>")
//       [--session-id <id>] [--concurrency <n>] [--timeout <s>]
//       [--project <path>] [--json]
//   cortex-agent schedule list [--project <path>] [--json]
//   cortex-agent schedule remove <id> [--project <path>] [--json]
//   cortex-agent schedule run [--id <id>] [--force] [--now <iso>] [--project <path>] [--json]
//   cortex-agent schedule daemon [--interval <sec>] [--once] [--project <path>] [--json]
//
// Exit codes: 0 success (including "nothing was due"), 2 usage, 3 runtime
// failure (a scheduled run failed / bad definition on disk).

const scheduler = require("../automation/scheduler");

const SUBCOMMANDS = ["add", "list", "remove", "run", "daemon", "help"];
const DEFAULT_DAEMON_INTERVAL = 60;

function usage() {
  return [
    "Usage:",
    "  cortex-agent schedule add --id <id> --agent <adapter:id> (--task <text> | --tasks <file>)",
    "                             (--every <30s|15m|2h|1d> | --cron \"<m h dom mon dow>\")",
    "                             [--session-id <id>] [--concurrency <n>] [--timeout <s>]",
    "                             [--project <path>] [--json]",
    "  cortex-agent schedule list [--project <path>] [--json]",
    "  cortex-agent schedule remove <id> [--project <path>] [--json]",
    "  cortex-agent schedule run [--id <id>] [--force] [--now <iso>] [--project <path>] [--json]",
    "  cortex-agent schedule daemon [--interval <sec>] [--once] [--project <path>] [--json]",
    "  cortex-agent schedule help",
    "",
    "Schedules live in .agent/schedules/<id>.json; runs are recorded under",
    ".agent/runtime/schedules/<id>/runs/. Execution goes through the normal",
    "dispatch path (same journals and statuses as `agent dispatch-batch`).",
    "`schedule daemon` is the built-in loop; `schedule run` is the same tick",
    "with an external clock (cron / launchd) if you prefer to own the timer.",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { positional: [], json: false, help: false, flags: {} };
  const valueFlags = new Set([
    "id", "agent", "task", "tasks", "every", "cron",
    "session-id", "concurrency", "timeout", "project", "now", "interval",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--force") out.flags.force = true;
    else if (arg === "--once") out.flags.once = true;
    else if (arg === "--disabled") out.flags.enabled = false;
    else if (arg.startsWith("--")) {
      const raw = arg.slice(2);
      const equals = raw.indexOf("=");
      const name = equals >= 0 ? raw.slice(0, equals) : raw;
      if (!valueFlags.has(name)) {
        const error = new scheduler.ScheduleError("ERR_SCHEDULE_USAGE", `unknown flag --${name}`);
        throw error;
      }
      const value = equals >= 0 ? raw.slice(equals + 1) : argv[i + 1];
      if (value === undefined) {
        throw new scheduler.ScheduleError("ERR_SCHEDULE_USAGE", `--${name} needs a value`);
      }
      if (equals < 0) i += 1;
      out.flags[name] = value;
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

function cadenceOf(definition) {
  return definition.cron ? `cron ${definition.cron}` : `every ${definition.every}`;
}

function printHuman(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.command === "add") {
    console.log(`created schedule ${result.schedule.id} (${cadenceOf(result.schedule)})`);
    console.log(`  agent:  ${result.schedule.agent_id}`);
    console.log(`  file:   ${result.file}`);
  } else if (result.command === "list") {
    if (!result.schedules.length) {
      console.log("no schedules defined (create one with `cortex-agent schedule add ...`)");
      return;
    }
    const rows = result.schedules.map((entry) => ({
      id: entry.id,
      cadence: cadenceOf(entry),
      agent: entry.agent_id,
      enabled: entry.enabled === false ? "no" : "yes",
      last_run: entry.last_run_at || "-",
      last_status: entry.last_status || "-",
    }));
    const widths = {
      id: Math.max(2, ...rows.map((row) => row.id.length)),
      cadence: Math.max(7, ...rows.map((row) => row.cadence.length)),
      agent: Math.max(5, ...rows.map((row) => row.agent.length)),
    };
    console.log(
      `${"ID".padEnd(widths.id)}  ${"CADENCE".padEnd(widths.cadence)}  ${"AGENT".padEnd(widths.agent)}  ENABLED  LAST RUN                      LAST STATUS`,
    );
    for (const row of rows) {
      console.log(
        `${row.id.padEnd(widths.id)}  ${row.cadence.padEnd(widths.cadence)}  ${row.agent.padEnd(widths.agent)}  ${row.enabled.padEnd(7)}  ${row.last_run.padEnd(29)}  ${row.last_status}`,
      );
    }
  } else if (result.command === "remove") {
    console.log(`removed schedule ${result.id} (${result.file})`);
  } else if (result.command === "run" || result.command === "daemon") {
    const tick = result.tick;
    console.log(`tick ${tick.ticked_at} — ran ${tick.counts.ran}, skipped ${tick.counts.skipped} (ok ${tick.counts.ok}, partial ${tick.counts.partial}, failed ${tick.counts.failed})`);
    for (const item of tick.results) {
      if (item.status === "skipped") continue;
      console.log(`  ${item.id}: ${item.status}${item.batch_id ? ` (batch ${item.batch_id})` : ""}${item.error ? ` — ${item.error.code}: ${item.error.message}` : ""}`);
    }
  }
}

async function runTick(options, json) {
  const result = await scheduler.tick(options);
  printHuman({ command: "run", tick: result }, json);
  const failed = result.counts.failed > 0;
  return failed ? 3 : 0;
}

async function daemon(parsed) {
  const intervalSeconds = Number(parsed.flags.interval || DEFAULT_DAEMON_INTERVAL);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) {
    throw new scheduler.ScheduleError("ERR_SCHEDULE_USAGE", "--interval must be a positive number of seconds");
  }
  const projectRoot = parsed.flags.project || process.cwd();
  const once = parsed.flags.once === true;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let worstExit = 0;
  do {
    const result = await scheduler.tick({ projectRoot });
    printHuman({ command: "daemon", tick: result }, parsed.json);
    if (result.counts.failed > 0) worstExit = 3;
    if (once || stopped) break;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, intervalSeconds * 1000);
      timer.unref?.();
      const onStop = () => { clearTimeout(timer); resolve(); };
      process.once("SIGINT", onStop);
      process.once("SIGTERM", onStop);
    });
  } while (!stopped);
  return worstExit;
}

async function scheduleCommand(ctx) {
  // `ctx.args` is `process.argv.slice(2)`, so args[0] is the command name
  // itself ("schedule"). Strip it before parsing so the same function also
  // works for programmatic callers (tests, future embedding).
  const rawArgs = Array.isArray(ctx && ctx.args) ? ctx.args : [];
  const argv = rawArgs[0] === "schedule" ? rawArgs.slice(1) : rawArgs;
  const sub = argv[0];
  // `schedule`, `schedule help`, `schedule --help` and `schedule -h` all print
  // the usage block; only then do we require a real subcommand.
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(usage());
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgs(argv.slice(1));
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
  if (parsed.help) {
    console.log(usage());
    return 0;
  }
  if (!SUBCOMMANDS.includes(sub)) {
    console.error(`error: unknown schedule subcommand "${sub}"`);
    console.error(usage());
    return 2;
  }
  const projectRoot = parsed.flags.project || process.cwd();

  try {
    if (sub === "add") {
      const definition = scheduler.validateSchedule({
        id: parsed.flags.id,
        agent_id: parsed.flags.agent,
        task: parsed.flags.task,
        tasks_file: parsed.flags.tasks,
        every: parsed.flags.every,
        cron: parsed.flags.cron,
        session_id: parsed.flags["session-id"],
        concurrency: parsed.flags.concurrency,
        timeout: parsed.flags.timeout,
        enabled: parsed.flags.enabled,
      });
      if (scheduler.readSchedule(projectRoot, definition.id)) {
        throw new scheduler.ScheduleError("ERR_SCHEDULE_EXISTS", `a schedule named "${definition.id}" already exists (remove it first)`);
      }
      const file = scheduler.writeSchedule(projectRoot, definition);
      printHuman({ command: "add", schedule: definition, file }, parsed.json);
      return 0;
    }
    if (sub === "list") {
      const schedules = scheduler.loadSchedules(projectRoot);
      printHuman({ command: "list", project_root: projectRoot, schedules }, parsed.json);
      return 0;
    }
    if (sub === "remove") {
      const id = parsed.positional[0] || parsed.flags.id;
      if (!id) {
        console.error("error: schedule remove needs an <id>");
        return 2;
      }
      const file = scheduler.removeSchedule(projectRoot, id);
      printHuman({ command: "remove", id, file }, parsed.json);
      return 0;
    }
    if (sub === "run") {
      return await runTick({
        projectRoot,
        now: parsed.flags.now,
        force: parsed.flags.force === true,
        only: parsed.flags.id || null,
      }, parsed.json);
    }
    if (sub === "daemon") {
      return await daemon(parsed);
    }
    return 2;
  } catch (error) {
    if (error instanceof scheduler.ScheduleError) {
      console.error(`error: ${error.code}: ${error.message}`);
      return 2;
    }
    console.error(`error: ${error && error.message ? error.message : error}`);
    return 3;
  }
}

module.exports = { scheduleCommand, usage, parseArgs };
