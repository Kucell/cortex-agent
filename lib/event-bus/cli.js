"use strict";

/**
 * lib/event-bus/cli.js
 *
 * M-004 MS-002 / F-005 — bin/cli.js event-bus 子命令 dispatcher.
 *
 * 4 个子命令:
 *   event-bus publish   --event <name> --payload <json> [--parent-id <id>]
 *                                   [--mission-id <id>] [--session-id <id>]
 *                                   [--bus-id <id>] [--data-dir <path>]
 *                                   [--no-fsync] [--output json|human]
 *   event-bus subscribe --event <name> (可多, 留空 = all)
 *                                   [--bus-id <id>] [--data-dir <path>]
 *                                   [--timeout <seconds>]
 *   event-bus list-events [--event <name>] [--limit N] [--offset N]
 *                                   [--bus-id <id>] [--data-dir <path>]
 *                                   [--output json|human]
 *   event-bus history   [--event <name>] [--since <ts>]
 *                                   [--bus-id <id>] [--data-dir <path>]
 *                                   [--output json|human]
 *
 * 集成方式 (跟 M-003 MS-001 dispatch-execute 一致, 严格 additive):
 *   - bin/cli.js 加 1 case "event-bus", 1 forward (peek args[1], 转发到
 *     lib/event-bus/cli.js 的 eventBusCommand)
 *   - lib/commands.js 零修改
 *   - lib/event-bus/{event-bus,event-types,persistence,fs-watcher}.js 零修改
 *   - 0 npm install maintained
 *
 * 退出码:
 *   - 0: success
 *   - 2: usage error (missing required arg, bad flag)
 *   - 3: runtime error (publish failed, list failed, etc.)
 *
 * Reference:
 *   - .agent/missions/M-004/handoffs/20260805-215200-ms-002-spec-done.md
 *   - docs/architecture/framework-event-bus-design.md §4
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { createEventBus } = require("./event-bus");
const bridge = require("./subagent-trace-bridge");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_SUBCOMMANDS = ["publish", "subscribe", "list-events", "history"];

const DEFAULT_BUS_ID = `${os.hostname().toLowerCase().slice(0, 12) || "unknown-host"}:global`;

const KNOWN_EVENT_NAMES = new Set([
  "subagent_spawned",
  "subagent_progress",
  "subagent_completed",
  "subagent_failed",
  "subagent_cancelled",
  "handoff_ready",
  "decision_resolved",
  "waitpoint_released",
]);

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

/**
 * Parse argv into a structured options object. `args` starts AFTER the
 * "event-bus" prefix — i.e. args[0] is the subcommand (publish / subscribe / ...).
 */
function parseArgs(args) {
  const out = {
    subcommand: null,
    showHelp: false,
    outputFormat: "human",
    outputJson: false,

    // publish
    event: null,
    payload: null,
    payloadRaw: null,
    parentId: null,
    missionId: null,
    sessionId: null,
    busId: DEFAULT_BUS_ID,
    dataDir: null,
    fsync: true,

    // subscribe (multi-event)
    events: [],

    // list-events
    limit: 0,
    offset: 0,

    // history
    since: null,

    // subscribe
    timeoutSec: 0,
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      out.showHelp = true;
      continue;
    }
    if (arg === "--json") {
      out.outputJson = true;
      out.outputFormat = "json";
      continue;
    }
    if (arg === "--output") {
      const v = args[i + 1];
      if (v === "json" || v === "human") {
        out.outputFormat = v;
        out.outputJson = v === "json";
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--output=")) {
      const v = arg.slice("--output=".length);
      if (v === "json" || v === "human") {
        out.outputFormat = v;
        out.outputJson = v === "json";
      }
      continue;
    }
    if (arg === "--event") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out.event = v;
        if (!out.events.includes(v)) out.events.push(v);
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--event=")) {
      const v = arg.slice("--event=".length);
      out.event = v;
      if (!out.events.includes(v)) out.events.push(v);
      continue;
    }
    if (arg === "--payload") {
      const v = args[i + 1];
      if (v != null) {
        out.payloadRaw = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--payload=")) {
      out.payloadRaw = arg.slice("--payload=".length);
      continue;
    }
    if (arg === "--parent-id") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out.parentId = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--parent-id=")) {
      out.parentId = arg.slice("--parent-id=".length);
      continue;
    }
    if (arg === "--mission-id") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out.missionId = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--mission-id=")) {
      out.missionId = arg.slice("--mission-id=".length);
      continue;
    }
    if (arg === "--session-id") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out.sessionId = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--session-id=")) {
      out.sessionId = arg.slice("--session-id=".length);
      continue;
    }
    if (arg === "--bus-id") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out.busId = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--bus-id=")) {
      out.busId = arg.slice("--bus-id=".length);
      continue;
    }
    if (arg === "--data-dir") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out.dataDir = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--data-dir=")) {
      out.dataDir = arg.slice("--data-dir=".length);
      continue;
    }
    if (arg === "--limit") {
      const v = args[i + 1];
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) {
        out.limit = n;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isFinite(n) && n >= 0) out.limit = n;
      continue;
    }
    if (arg === "--offset") {
      const v = args[i + 1];
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) {
        out.offset = n;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--offset=")) {
      const n = Number(arg.slice("--offset=".length));
      if (Number.isFinite(n) && n >= 0) out.offset = n;
      continue;
    }
    if (arg === "--since") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out.since = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--since=")) {
      out.since = arg.slice("--since=".length);
      continue;
    }
    if (arg === "--timeout") {
      const v = args[i + 1];
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) {
        out.timeoutSec = n;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--timeout=")) {
      const n = Number(arg.slice("--timeout=".length));
      if (Number.isFinite(n) && n > 0) out.timeoutSec = n;
      continue;
    }
    if (arg === "--no-fsync") {
      out.fsync = false;
      continue;
    }
    if (arg && !arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  out.subcommand = positional[0] || null;
  return out;
}

// ---------------------------------------------------------------------------
// Subcommand: publish
// ---------------------------------------------------------------------------

function runPublish(parsed) {
  if (!parsed.event) {
    process.stderr.write("event-bus publish: --event is required\n");
    process.exitCode = 2;
    return;
  }
  if (!parsed.payloadRaw) {
    process.stderr.write("event-bus publish: --payload is required (JSON string)\n");
    process.exitCode = 2;
    return;
  }
  if (!KNOWN_EVENT_NAMES.has(parsed.event) && !parsed.event.startsWith("custom:")) {
    process.stderr.write(
      `event-bus publish: --event must be one of the 8 core events or 'custom:<name>', got "${parsed.event}"\n`,
    );
    process.exitCode = 2;
    return;
  }

  let payloadObj;
  try {
    payloadObj = JSON.parse(parsed.payloadRaw);
  } catch (e) {
    process.stderr.write(`event-bus publish: --payload is not valid JSON: ${e.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (typeof payloadObj !== "object" || payloadObj === null || Array.isArray(payloadObj)) {
    process.stderr.write("event-bus publish: --payload must be a JSON object\n");
    process.exitCode = 2;
    return;
  }

  let bus;
  try {
    bus = createEventBus({
      busId: parsed.busId,
      dataDir: parsed.dataDir || undefined,
      fsync: parsed.fsync,
    });
  } catch (e) {
    process.stderr.write(`event-bus publish: bus init failed: ${e.message}\n`);
    process.exitCode = 3;
    return;
  }

  let result;
  try {
    result = bus.publish(
      { event_name: parsed.event, payload: payloadObj },
      {
        producer: {
          producer_id: parsed.parentId || "cli-user",
          producer_kind: "cli",
          session_id: parsed.sessionId || null,
        },
        missionId: parsed.missionId || "global",
        subagentId: parsed.parentId || "host",
        parentRunId: parsed.parentId || "global",
      },
    );
  } catch (e) {
    process.stderr.write(`event-bus publish failed: ${e.message}\n`);
    bus.close();
    process.exitCode = 3;
    return;
  }

  bus.close();

  const out = {
    ok: true,
    action: "publish",
    event_id: result.event_id,
    event_name: parsed.event,
    persisted_at: result.persisted_at,
    bus_id: parsed.busId,
    deduped: !!result.deduped,
  };
  printResult(out, parsed);
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Subcommand: list-events
// ---------------------------------------------------------------------------

function runListEvents(parsed) {
  let bus;
  try {
    bus = createEventBus({
      busId: parsed.busId,
      dataDir: parsed.dataDir || undefined,
      fsync: false,
    });
  } catch (e) {
    process.stderr.write(`event-bus list-events: bus init failed: ${e.message}\n`);
    process.exitCode = 3;
    return;
  }

  const filter = {};
  if (parsed.event) filter.event_name = parsed.event;
  if (parsed.limit > 0) filter.limit = parsed.limit;
  if (parsed.offset > 0) filter.offset = parsed.offset;

  let result;
  try {
    result = bus.list(filter);
  } catch (e) {
    process.stderr.write(`event-bus list-events failed: ${e.message}\n`);
    bus.close();
    process.exitCode = 3;
    return;
  }
  bus.close();

  const out = {
    ok: true,
    action: "list-events",
    bus_id: parsed.busId,
    count: result.events.length,
    total: result.total,
    next_offset: result.next_offset,
    events: result.events,
  };
  printResult(out, parsed);
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Subcommand: history
// ---------------------------------------------------------------------------

function runHistory(parsed) {
  let bus;
  try {
    bus = createEventBus({
      busId: parsed.busId,
      dataDir: parsed.dataDir || undefined,
      fsync: false,
    });
  } catch (e) {
    process.stderr.write(`event-bus history: bus init failed: ${e.message}\n`);
    process.exitCode = 3;
    return;
  }

  // history is per-subscription. For CLI we synthesize a one-shot subscription
  // matching the filter, then read acks + events for that subscription.
  // If no --event is given we synthesize an "all" subscription.
  const eventsFilter = parsed.events.length > 0 ? parsed.events : null;
  let subId;
  try {
    subId = bus.subscribe(
      eventsFilter ? { event_names: eventsFilter } : {},
      function noop() { return { ack: true }; },
      { ackTimeoutMs: 100, retryCount: 0 },
    );
  } catch (e) {
    process.stderr.write(`event-bus history: subscribe failed: ${e.message}\n`);
    bus.close();
    process.exitCode = 3;
    return;
  }

  const opts = {};
  if (parsed.since) opts.since = parsed.since;

  let hist;
  try {
    hist = bus.history(subId, opts);
  } catch (e) {
    process.stderr.write(`event-bus history failed: ${e.message}\n`);
    bus.close();
    process.exitCode = 3;
    return;
  }
  bus.close();

  const out = {
    ok: true,
    action: "history",
    bus_id: parsed.busId,
    subscription_id: subId,
    filter: eventsFilter || "all",
    since: parsed.since || null,
    stats: hist.stats,
    ack_count: hist.acks.length,
    event_count: hist.events.length,
    acks: hist.acks,
    events: hist.events,
  };
  printResult(out, parsed);
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Subcommand: subscribe
// ---------------------------------------------------------------------------

function runSubscribe(parsed) {
  // Long-running: stream matching events to stdout. Each event is one JSON line.
  // We use bus.subscribe with a noop handler so the bus maintains the
  // subscription, then poll for new events on the persistence layer.
  // (We don't use bus.subscribe's handler delivery because we want raw stdout
  // streaming, not the ack-required contract.)
  //
  // Implementation strategy: synthesize a noop subscription, then read events
  // from the bus's last_read_offset forward in a tight loop with a small sleep.
  // This is the simplest path that doesn't need to change event-bus.js.
  let bus;
  try {
    bus = createEventBus({
      busId: parsed.busId,
      dataDir: parsed.dataDir || undefined,
      fsync: false,
    });
  } catch (e) {
    process.stderr.write(`event-bus subscribe: bus init failed: ${e.message}\n`);
    process.exitCode = 3;
    return;
  }

  const eventsFilter = parsed.events.length > 0 ? parsed.events : null;

  // Print subscription banner
  process.stdout.write(JSON.stringify({
    ok: true,
    action: "subscribe",
    bus_id: parsed.busId,
    filter: eventsFilter || "all",
    note: "streaming events to stdout; Ctrl-C to exit",
  }) + "\n");

  let lastOffset = 0;
  try {
    // Initialize offset to current end so we only emit new events
    const initial = bus.list({ limit: 0 });
    lastOffset = initial.total; // count of events already on disk
  } catch (_) {
    lastOffset = 0;
  }

  let running = true;
  const stop = () => {
    running = false;
    try { bus.close(); } catch (_) {}
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const startMs = Date.now();
  const deadlineMs = parsed.timeoutSec > 0 ? startMs + parsed.timeoutSec * 1000 : null;

  while (running) {
    if (deadlineMs != null && Date.now() >= deadlineMs) {
      process.stdout.write(JSON.stringify({ ok: true, action: "subscribe", note: "timeout reached, exiting" }) + "\n");
      break;
    }
    try {
      const filter = {};
      if (eventsFilter && eventsFilter.length > 0) filter.event_name = eventsFilter[0];
      // Pull all current events then advance offset manually to get the new ones
      const all = bus.list({ limit: 0, ...filter });
      const newEvents = all.events.slice(lastOffset);
      for (const ev of newEvents) {
        if (eventsFilter && eventsFilter.length > 0 && !eventsFilter.includes(ev.event_name)) continue;
        process.stdout.write(JSON.stringify({ ok: true, action: "subscribe", event: ev }) + "\n");
      }
      lastOffset = all.events.length;
    } catch (e) {
      // Suppress transient errors during long-running subscribe
    }
    // small sleep to avoid hot loop
    const until = Date.now() + 200;
    while (running && Date.now() < until) {
      // busy-wait with a tiny slice
      const end = Date.now() + 50;
      while (Date.now() < end) { /* sleep */ }
    }
  }
  try { bus.close(); } catch (_) {}
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printResult(obj, parsed) {
  if (parsed.outputJson) {
    process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
    return;
  }
  printHuman(obj, parsed);
}

function printHuman(obj, parsed) {
  switch (obj.action) {
    case "publish":
      console.log(`✓ published ${obj.event_name} → event_id=${obj.event_id}`);
      if (obj.deduped) console.log(`  (deduped — event already seen)`);
      break;
    case "list-events":
      console.log(`bus_id:    ${obj.bus_id}`);
      console.log(`count:     ${obj.count} (total: ${obj.total})`);
      if (obj.next_offset) console.log(`next_offset: ${obj.next_offset}`);
      if (obj.events.length === 0) {
        console.log(`(no events match the filter)`);
        return;
      }
      for (const ev of obj.events) {
        console.log(`- ${ev.occurred_at}  ${ev.event_name}  [${ev.event_id}]`);
      }
      break;
    case "history":
      console.log(`bus_id:    ${obj.bus_id}`);
      console.log(`filter:    ${obj.filter}`);
      if (obj.since) console.log(`since:     ${obj.since}`);
      console.log(`stats:     ${JSON.stringify(obj.stats)}`);
      console.log(`ack_count:  ${obj.ack_count}`);
      console.log(`event_count: ${obj.event_count}`);
      break;
    default:
      // Fallback: pretty print
      console.log(JSON.stringify(obj, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp(lang) {
  const zh = lang === "zh";
  if (zh) {
    console.log("用法: cortex-agent event-bus <子命令> [选项]");
    console.log("");
    console.log("子命令 (4):");
    console.log("  publish       发布一个 event 到 event-bus");
    console.log("  subscribe     订阅 + 持续打印 event 到 stdout (Ctrl-C 退出)");
    console.log("  list-events   列出历史 events");
    console.log("  history       列出 events + acks + stats");
    console.log("");
    console.log("publish 必选 flag:");
    console.log("  --event <name>        8 类 core event 或 custom:<name>");
    console.log("  --payload <json>      JSON 字符串, payload 内容");
    console.log("");
    console.log("subscribe 必选 flag:");
    console.log("  --event <name>        可多, 留空 = 全部");
    console.log("");
    console.log("list-events 可选 flag:");
    console.log("  --event <name>        过滤 event_name");
    console.log("  --limit N             限制条数");
    console.log("  --offset N            起始偏移");
    console.log("");
    console.log("history 可选 flag:");
    console.log("  --event <name>        过滤 event_name");
    console.log("  --since <ts>          ISO 时间戳下限");
    console.log("");
    console.log("通用 flag:");
    console.log("  --bus-id <id>         bus 标识 (默认 <host>:global)");
    console.log("  --data-dir <path>     bus 数据目录 (默认 .agent/event-bus/<bus-id>)");
    console.log("  --output json|human   输出格式 (默认 human)");
    console.log("  --help / -h           显示本帮助");
    console.log("");
    console.log("示例:");
    console.log('  cortex-agent event-bus publish --event subagent_completed --payload \'{"status":"success","output_summary":"done"}\'');
    console.log("  cortex-agent event-bus list-events --event subagent_completed --limit 5");
    console.log("  cortex-agent event-bus subscribe --event subagent_spawned");
  } else {
    console.log("Usage: cortex-agent event-bus <subcommand> [options]");
    console.log("");
    console.log("Subcommands (4):");
    console.log("  publish       Publish an event to the event-bus");
    console.log("  subscribe     Subscribe + stream events to stdout (Ctrl-C to exit)");
    console.log("  list-events   List historical events");
    console.log("  history       List events + acks + stats");
    console.log("");
    console.log("publish required flags:");
    console.log("  --event <name>        8 core events or custom:<name>");
    console.log("  --payload <json>      JSON string, payload contents");
    console.log("");
    console.log("subscribe flags:");
    console.log("  --event <name>        repeat to filter, empty = all");
    console.log("  --timeout <seconds>   auto-exit after N seconds (0 = forever)");
    console.log("");
    console.log("list-events optional flags:");
    console.log("  --event <name>        filter by event_name");
    console.log("  --limit N             max number of events");
    console.log("  --offset N            starting offset");
    console.log("");
    console.log("history optional flags:");
    console.log("  --event <name>        filter by event_name");
    console.log("  --since <ts>          ISO timestamp lower bound");
    console.log("");
    console.log("Common flags:");
    console.log("  --bus-id <id>         bus identifier (default <host>:global)");
    console.log("  --data-dir <path>     bus data directory (default .agent/event-bus/<bus-id>)");
    console.log("  --mission-id <id>     set mission_id correlation");
    console.log("  --session-id <id>     set session_id in producer");
    console.log("  --parent-id <id>      set parent_run_id correlation");
    console.log("  --no-fsync            disable fsync for performance (publish only)");
    console.log("  --output json|human   output format (default human)");
    console.log("  --help / -h           show this help");
    console.log("");
    console.log("Examples:");
    console.log('  cortex-agent event-bus publish --event subagent_completed --payload \'{"status":"success","output_summary":"done"}\'');
    console.log("  cortex-agent event-bus list-events --event subagent_completed --limit 5");
    console.log("  cortex-agent event-bus subscribe --event subagent_spawned --timeout 30");
  }
}

// ---------------------------------------------------------------------------
// dispatcher entry point (wired from bin/cli.js)
// ---------------------------------------------------------------------------

function eventBusCommand(ctx) {
  // ctx.args is process.argv.slice(2) — args[0] is "event-bus". Strip it.
  const rawArgs = Array.isArray(ctx.args) ? ctx.args : [];
  const args = rawArgs[0] === "event-bus" ? rawArgs.slice(1) : rawArgs;
  const parsed = parseArgs(args);

  if (parsed.showHelp || !parsed.subcommand) {
    printHelp(ctx.lang);
    process.exitCode = parsed.showHelp ? 0 : 2;
    if (!parsed.subcommand && !parsed.showHelp) {
      process.stderr.write("Error: subcommand required (publish|subscribe|list-events|history)\n");
    }
    return;
  }

  if (!VALID_SUBCOMMANDS.includes(parsed.subcommand)) {
    process.stderr.write(
      `Error: unknown event-bus subcommand "${parsed.subcommand}". Valid: ${VALID_SUBCOMMANDS.join(", ")}.\n`,
    );
    printHelp(ctx.lang);
    process.exitCode = 2;
    return;
  }

  switch (parsed.subcommand) {
    case "publish":     return runPublish(parsed);
    case "subscribe":   return runSubscribe(parsed);
    case "list-events": return runListEvents(parsed);
    case "history":     return runHistory(parsed);
  }
}

module.exports = {
  eventBusCommand,
  parseArgs,
  printHelp,
  VALID_SUBCOMMANDS,
  // exposed for tests
  _runPublish: runPublish,
  _runListEvents: runListEvents,
  _runHistory: runHistory,
  // re-export bridge for convenience (caller can also require it directly)
  bridge,
};
