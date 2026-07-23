"use strict";

const command = (name, usage, description, extra = {}) => ({ name, usage, description, ...extra });

const commands = [
  command("init", "init [options]", "Initialize Cortex Agent."),
  command("add", "add <platform...>", "Add platform integrations."),
  command("remove", "remove <platform...>", "Remove platform integrations."),
  command("list", "list", "Show available and installed platforms."),
  command("upgrade", "upgrade [options]", "Add missing Agent files without overwriting local content."),
  command("update", "update [options]", "Add files and safely refresh unmodified managed scripts."),
  command("track", "track", "Enable Git tracking for .agent."),
  command("untrack", "untrack", "Disable Git tracking for .agent."),
  command("link-global", "link-global", "Link global ~/.agent configuration."),
  command("doctor", "doctor [options]", "Check setup health."),
  command("help", "help [command] [--json]", "Show human or machine-readable CLI usage."),
  command("query", "query <projection> [filters]", "Query a project Management API and output JSON.", { mode: "read_only" }),
  command("runs", "runs <list|show|upsert|event|checkpoint|tokens>", "Read or update Run state through explicit actions."),
  command("queues", "queues <list|upsert|item>", "Read or update Queue state through explicit actions."),
  command("sessions", "sessions <list|open|heartbeat|pause|close>", "Read or update Session state through explicit actions."),
  command("decisions", "decisions <request|resolve|supersede>", "Use gated Decision lifecycle actions."),
  command("inbox", "inbox <send|transition>", "Use gated Inbox lifecycle actions."),
  command("waitpoints", "waitpoints <create|release|cancel>", "Use gated Waitpoint lifecycle actions."),
  command("mcp", "mcp serve --project <path>", "Start the read-only Management API MCP stdio server.", { mode: "read_only" }),
  command("dev", "dev [options]", "Start the live project dashboard."),
];

const options = [
  { name: "--lang, -l <en|zh>", description: "Language, auto-detected by default." },
  { name: "--global, -g", description: "Use global ~/.agent configuration." },
  { name: "--project <path>", description: "Target an explicit project for management commands." },
  { name: "--since <date|time>", description: "Inclusive activity query start boundary." },
  { name: "--until <date|time>", description: "Inclusive activity query end boundary." },
  { name: "--track, -t", description: "Keep generated files in Git." },
  { name: "--platforms, -p <list>", description: "Select platforms non-interactively." },
  { name: "--update-scripts", description: "Apply safe managed-script updates during upgrade." },
  { name: "--force-scripts", description: "Overwrite locally modified managed scripts during update." },
  { name: "--dry-run", description: "Report upgrade/update changes without writing." },
  { name: "--report <text|json>", description: "Select update/upgrade report format." },
  { name: "--verify", description: "Run update verification without applying upgrade writes." },
  { name: "--verify-full", description: "Run heavier update verification checks." },
  { name: "--fix", description: "Apply doctor fixes, including forced script updates." },
  { name: "--json", description: "Emit machine-readable help when used with help." },
];

const management = {
  project_scope: "Use --project explicitly for cross-project or worktree automation.",
  query: {
    usage: "cortex-agent query <projection> --project <path> [projection filters]",
    read_only: true,
    discovery: "cortex-agent help query --json --project <path>",
  },
  mcp: {
    usage: "cortex-agent mcp serve --project <path>",
    transport: "stdio",
    project_scope: "single_explicit_local_project",
    resources: "cortex://management/<projection>",
    tools: ["cortex.query"],
    writer_tools: false,
  },
  writers: {
    runs: ["upsert", "event", "checkpoint", "tokens"],
    queues: ["upsert", "item"],
    sessions: ["open", "heartbeat", "pause", "close"],
    decisions: ["request", "resolve", "supersede"],
    inbox: ["send", "transition"],
    waitpoints: ["create", "release", "cancel"],
  },
  writer_usage: {
    "runs upsert": "cortex-agent runs upsert --project <path> --run-id <id> [run fields]",
    "runs event": "cortex-agent runs event --project <path> --run-id <id> --type <event> [event fields]",
    "runs checkpoint": "cortex-agent runs checkpoint --project <path> --run-id <id> --status <status> --phase <phase> [checkpoint fields]",
    "runs tokens": "cortex-agent runs tokens --project <path> --run-id <id> --source <host> --gate <workflow> [token fields]",
    "queues upsert": "cortex-agent queues upsert --project <path> --queue-id <id> --gate <workflow> [queue fields]",
    "queues item": "cortex-agent queues item --project <path> --queue-id <id> --task-id <id> --state <state> --gate <workflow> [item fields]",
    "sessions open": "cortex-agent sessions open --project <path> --session-id <id> --agent-id <id> --role <role> [session fields]",
    "sessions heartbeat": "cortex-agent sessions heartbeat --project <path> --session-id <id> --agent-id <owner> [session fields]",
    "sessions pause": "cortex-agent sessions pause --project <path> --session-id <id> --agent-id <owner> --gate <gate>",
    "sessions close": "cortex-agent sessions close --project <path> --session-id <id> --agent-id <owner> --gate <gate>",
    "decisions request": "cortex-agent decisions request --project <path> --decision-id <id> --gate <workflow> --type <type> --requested-by <id> --prompt <text> --action <action> --resource-ref <ref>",
    "decisions resolve": "cortex-agent decisions resolve --project <path> --decision-id <id> --gate user --status <status> --selected-option <option> --resolved-by <id> --rationale <text>",
    "decisions supersede": "cortex-agent decisions supersede --project <path> --decision-id <id> --gate requester --superseded-by-decision-id <id> --superseded-by <id> --rationale <text>",
    "inbox send": "cortex-agent inbox send --project <path> --message-id <id> --gate <workflow> --sender-id <id> --recipient-ids <ids> --subject <text>",
    "inbox transition": "cortex-agent inbox transition --project <path> --message-id <id> --gate <gate> --actor-id <id> --status <status>",
    "waitpoints create": "cortex-agent waitpoints create --project <path> --waitpoint-id <id> --gate <workflow> --owner-workflow <workflow> --reason <text> --action <action> --resource-ref <ref> --decision-id <id>",
    "waitpoints release": "cortex-agent waitpoints release --project <path> --waitpoint-id <id> --gate owner --owner-workflow <workflow> --decision-id <id> --released-by <id>",
    "waitpoints cancel": "cortex-agent waitpoints cancel --project <path> --waitpoint-id <id> --gate <gate> --owner-workflow <workflow> --reason <text>",
  },
  safety: [
    "No arbitrary write, state patch, shell execution, daemon, dispatch, or trigger command is exposed.",
    "Writer actions remain subject to Management API gate, owner, Decision, Waitpoint, and lifecycle validation.",
    "Internal .agent script paths are implementation/debug fallbacks, not the standard Agent interface.",
  ],
};

module.exports = {
  schema_version: 1,
  discovery_command: "cortex-agent help --json",
  commands,
  options,
  management,
};
