"use strict";

// ─── lease — Public Ownership Lease CLI (FAE-007 / M-013 MS-002) ──────────────
//
// Originally lived in lib/commands.js (line 1620–1808 AND line 2101–2170). Note:
// lib/commands.js has a historical bug — `lease` is declared TWICE in the same
// file (once at line 1791 and again at line 2106), and the module.exports uses
// the second declaration. Both definitions are kept here verbatim to preserve
// the existing dispatch table (the second one wins inside this module too,
// matching the public surface behavior).
//
// Extracted so callers can require this surface in isolation.

const path = require("node:path");
const { printManagementPayload } = require("../management/api-helpers");

// ─── First lease surface (line 1620–1808 in the original) ────────────────────

function leaseUsage(ctx) {
  const lines = [
    "Usage:",
    "  cortex-agent lease acquire --scope <scope> --owner <owner> [--actor <actor>] [--ttl <seconds>] [--idempotency-key <key>] [--evidence <ref>...] [--project <path>] [--json]",
    "  cortex-agent lease renew --lease-id <id> | --scope <scope> [--owner <owner>] [--ttl <seconds>] [--evidence <ref>...] [--project <path>] [--json]",
    "  cortex-agent lease release --lease-id <id> [--actor <actor>] [--evidence <ref>...] [--project <path>] [--json]",
    "  cortex-agent lease status [--lease-id <id> | --scope <scope>] [--project <path>] [--json]",
    "  cortex-agent lease recover --scope <scope> --new-owner <owner> [--actor-session-id <id>] [--recovery-evidence <ref>...] [--ttl <seconds>] [--takeover-timeout-ms <ms>] [--project <path>] [--json]",
    "",
    "Reuses M-008 / T-ACN-005 LeaseManager (no algorithm duplication); persists to .agent-runtime/coordination/leases/{state.json,idempotency.json}.",
  ];
  return lines.join("\n");
}

function leaseFlag(ctx, name, fallback = null) {
  const idx = ctx.args.indexOf(name);
  if (idx === -1 || !ctx.args[idx + 1]) return fallback;
  return ctx.args[idx + 1];
}

function leaseFlagList(ctx, name) {
  const out = [];
  for (let i = 0; i < ctx.args.length; i += 1) {
    if (ctx.args[i] === name && ctx.args[i + 1]) {
      out.push(ctx.args[i + 1]);
      i += 1;
    }
  }
  return out;
}

function leaseCliSubcommand(ctx) {
  return ctx.args[1] || "status";
}

function leaseResolveProjectRoot(ctx) {
  const explicit = ctx.options && ctx.options.project;
  if (explicit) return path.resolve(ctx.cwd, explicit);
  return path.resolve(ctx.cwd, ".");
}

function leaseAcquireHandler(ctx) {
  const leaseCli = require("../../coordination/lease-cli");
  const args = {
    scope: leaseFlag(ctx, "--scope"),
    owner: leaseFlag(ctx, "--owner"),
    actor: leaseFlag(ctx, "--actor"),
    ttl: leaseFlag(ctx, "--ttl"),
    idempotencyKey: leaseFlag(ctx, "--idempotency-key"),
    evidence: leaseFlagList(ctx, "--evidence"),
  };
  if (!args.scope || !args.owner) {
    console.error("lease acquire: --scope and --owner are required");
    console.log(leaseUsage(ctx));
    process.exitCode = 2;
    return;
  }
  const result = leaseCli.leaseAcquire(args, { projectRoot: leaseResolveProjectRoot(ctx) });
  if (ctx.args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(`lease acquire failed: ${result.code} ${JSON.stringify(result.error)}`);
    process.exitCode = 3;
  } else {
    console.log(`lease acquire ok: lease_id=${result.lease.leaseId} scope=${result.lease.scope} owner=${result.lease.owner} fencing_token=${result.lease.fencingToken} expires_at=${result.lease.expiresAt} idempotent=${result.idempotent}`);
  }
}

function leaseRenewHandler(ctx) {
  const leaseCli = require("../../coordination/lease-cli");
  const args = {
    leaseId: leaseFlag(ctx, "--lease-id"),
    scope: leaseFlag(ctx, "--scope"),
    owner: leaseFlag(ctx, "--owner"),
    actor: leaseFlag(ctx, "--actor"),
    ttl: leaseFlag(ctx, "--ttl"),
    evidence: leaseFlagList(ctx, "--evidence"),
  };
  if (!args.leaseId && !args.scope) {
    console.error("lease renew: --lease-id or --scope required");
    console.log(leaseUsage(ctx));
    process.exitCode = 2;
    return;
  }
  const result = leaseCli.leaseRenew(args, { projectRoot: leaseResolveProjectRoot(ctx) });
  if (ctx.args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(`lease renew failed: ${result.code} ${JSON.stringify(result.error)}`);
    process.exitCode = 3;
  } else {
    console.log(`lease renew ok: lease_id=${result.lease.leaseId} expires_at=${result.lease.expiresAt}`);
  }
}

function leaseReleaseHandler(ctx) {
  const leaseCli = require("../../coordination/lease-cli");
  const args = {
    leaseId: leaseFlag(ctx, "--lease-id"),
    actor: leaseFlag(ctx, "--actor"),
    evidence: leaseFlagList(ctx, "--evidence"),
  };
  if (!args.leaseId) {
    console.error("lease release: --lease-id required");
    console.log(leaseUsage(ctx));
    process.exitCode = 2;
    return;
  }
  const result = leaseCli.leaseRelease(args, { projectRoot: leaseResolveProjectRoot(ctx) });
  if (ctx.args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(`lease release failed: ${result.code} ${JSON.stringify(result.error)}`);
    process.exitCode = 3;
  } else {
    console.log(`lease release ok: lease_id=${result.lease.leaseId} released_at=${result.lease.releasedAt}`);
  }
}

function leaseStatusHandler(ctx) {
  const leaseCli = require("../../coordination/lease-cli");
  const args = {
    leaseId: leaseFlag(ctx, "--lease-id"),
    scope: leaseFlag(ctx, "--scope"),
  };
  const result = leaseCli.leaseStatus(args, { projectRoot: leaseResolveProjectRoot(ctx) });
  if (ctx.args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.found && args.leaseId) {
    console.error(`lease status: lease_id=${args.leaseId} not found`);
    process.exitCode = 3;
  } else if (args.scope) {
    console.log(`lease status scope=${args.scope} count=${result.leases.length}`);
    for (const lease of result.leases) {
      console.log(`  ${lease.leaseId} owner=${lease.owner} status=${lease.status} remaining_ms=${lease.remaining_ms} fencing=${lease.fencingToken}`);
    }
  } else {
    console.log(`lease status active count=${result.leases.length}`);
    for (const lease of result.leases) {
      console.log(`  ${lease.leaseId} scope=${lease.scope} owner=${lease.owner} remaining_ms=${lease.remaining_ms}`);
    }
  }
}

function leaseRecoverHandler(ctx) {
  const leaseCli = require("../../coordination/lease-cli");
  const args = {
    scope: leaseFlag(ctx, "--scope"),
    newOwner: leaseFlag(ctx, "--new-owner"),
    actorSessionId: leaseFlag(ctx, "--actor-session-id"),
    recoveryEvidence: leaseFlagList(ctx, "--recovery-evidence"),
    ttl: leaseFlag(ctx, "--ttl"),
    takeoverTimeoutMs: leaseFlag(ctx, "--takeover-timeout-ms"),
  };
  if (!args.scope || !args.newOwner) {
    console.error("lease recover: --scope and --new-owner are required");
    console.log(leaseUsage(ctx));
    process.exitCode = 2;
    return;
  }
  const result = leaseCli.leaseRecover(args, { projectRoot: leaseResolveProjectRoot(ctx) });
  if (ctx.args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(`lease recover failed: ${result.code} ${JSON.stringify(result.error)}`);
    process.exitCode = 3;
  } else {
    console.log(`lease recover ok: request_id=${result.request.requestId} new_lease_id=${result.takeover.lease.leaseId} fencing_token=${result.takeover.lease.fencingToken}`);
  }
}

// Historical bug: this `lease` declaration is shadowed by the second one below
// in module.exports; the second declaration wins. Kept verbatim for parity.
function lease(ctx) {
  const sub = leaseCliSubcommand(ctx);
  if (ctx.args.includes("--help") || ctx.args.includes("-h")) {
    console.log(leaseUsage(ctx));
    return;
  }
  switch (sub) {
    case "acquire": return leaseAcquireHandler(ctx);
    case "renew": return leaseRenewHandler(ctx);
    case "release": return leaseReleaseHandler(ctx);
    case "status": return leaseStatusHandler(ctx);
    case "recover": return leaseRecoverHandler(ctx);
    default:
      console.error(`Unknown lease subcommand: ${sub}`);
      console.log(leaseUsage(ctx));
      process.exitCode = 2;
  }
}

// ─── Second lease surface (line 2101–2170 in the original) ───────────────────
//
// This is intentionally a thin argument adapter over coordination/lease-cli.
// LeaseManager remains the only owner of fencing, TTL, idempotency and durable
// state.  In particular, this command never creates a task or starts a host.

function lease(ctx) {
  const action = ctx.args[1];
  const args = ctx.args.slice(2);
  const projectRoot = path.resolve(ctx.cwd, (ctx.options && ctx.options.project) || ".");
  const option = (name) => {
    const marker = `--${name}`;
    const inline = args.find((value) => typeof value === "string" && value.startsWith(`${marker}=`));
    if (inline) return inline.slice(marker.length + 1);
    const index = args.indexOf(marker);
    return index < 0 ? undefined : args[index + 1];
  };
  const repeated = (name) => {
    const marker = `--${name}`;
    const values = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === marker) {
        if (typeof args[index + 1] !== "string") return null;
        values.push(args[index + 1]);
        index += 1;
      } else if (typeof args[index] === "string" && args[index].startsWith(`${marker}=`)) {
        values.push(args[index].slice(marker.length + 1));
      }
    }
    return values;
  };
  const evidence = repeated("evidence");
  const recoveryEvidence = repeated("recovery-evidence");
  if (evidence === null || recoveryEvidence === null) {
    printManagementPayload({ ok: false, code: "INVALID_USAGE", message: "Each repeated evidence option requires an explicit value.", exitCode: 2 });
    process.exitCode = 2;
    return;
  }
  const { leaseAcquire, leaseRenew, leaseRelease, leaseStatus, leaseRecover, LeaseCliError } = require("../../coordination/lease-cli");
  const options = { projectRoot };
  try {
    let result;
    switch (action) {
      case "acquire":
        result = leaseAcquire({ scope: option("scope"), owner: option("owner"), actor: option("actor"), ttl: option("ttl"), idempotencyKey: option("idempotency-key"), evidence }, options);
        break;
      case "renew":
        result = leaseRenew({ leaseId: option("lease-id"), scope: option("scope"), owner: option("owner"), actor: option("actor"), ttl: option("ttl"), evidence }, options);
        break;
      case "release":
        result = leaseRelease({ leaseId: option("lease-id"), actor: option("actor"), evidence }, options);
        break;
      case "status":
        result = leaseStatus({ leaseId: option("lease-id"), scope: option("scope") }, options);
        break;
      case "recover":
        result = leaseRecover({ scope: option("scope"), newOwner: option("new-owner"), actorSessionId: option("actor-session-id"), ttl: option("ttl"), takeoverTimeoutMs: option("takeover-timeout-ms"), recoveryEvidence }, options);
        break;
      default:
        result = { ok: false, code: "INVALID_USAGE", message: "lease requires acquire, renew, release, status, or recover.", exitCode: 2 };
    }
    printManagementPayload(result);
    if (!result.ok) process.exitCode = result.exitCode || 3;
  } catch (error) {
    const code = error instanceof LeaseCliError ? error.code : "LEASE_COMMAND_FAILED";
    // Do not return raw argument values: evidence may be sensitive and the
    // lease boundary is deliberately non-disclosing.
    printManagementPayload({ ok: false, code, message: "Ownership lease command was rejected.", exitCode: 3 });
    process.exitCode = 3;
  }
}

module.exports = {
  leaseUsage,
  leaseFlag,
  leaseFlagList,
  leaseCliSubcommand,
  leaseResolveProjectRoot,
  leaseAcquireHandler,
  leaseRenewHandler,
  leaseReleaseHandler,
  leaseStatusHandler,
  leaseRecoverHandler,
  lease,
};
