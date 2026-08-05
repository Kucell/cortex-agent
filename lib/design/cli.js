/**
 * lib/design/cli.js
 *
 * T-OD-001 MS-003: cortex-agent design <subcommand> CLI dispatcher.
 *
 * Subcommands:
 *   list [--available | --installed | --all] [--json] [--no-cache]
 *   install <id>... [--yes] [--force] [--no-cache] [--json]
 *   upgrade [<id>] [--yes] [--no-cache] [--json]
 *   remove <id>... [--json]
 *   show <id> [--json]
 *   resolved [--json]
 *   refresh-catalog
 *
 * Exit codes (frozen, per proposal):
 *   0  success
 *   1  generic error
 *   2  user error (invalid args, id not in catalog)
 *   3  network error
 *   4  license rejected by user
 *
 * Boundaries (per architecture-design.md):
 *   In scope: argv parsing, subcommand routing, license ack prompt,
 *             formatters, exit-code mapping.
 *   Out of scope: spawning subprocesses, writing outside <cwd>/.agent,
 *                 network sockets, credential access.
 *
 * Pure Node.js built-ins; zero npm deps. Mirrors dispatch-cli.js pattern.
 */

'use strict';

const path = require('node:path');
const readline = require('node:readline');

const registry = require('./registry');
const fetchLib = require('./fetch');
const lockfile = require('./lockfile');
const license = require('./license');
const resolve = require('./resolve');

// ─── argv parsing ────────────────────────────────────────────────────────────

function parseDesignArgs(args) {
  const out = {
    subcommand: null,
    ids: [],
    showHelp: false,
    showJson: false,
    yes: false,
    force: false,
    noCache: false,
    listMode: 'installed', // 'available' | 'installed' | 'all'
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      out.showHelp = true;
      continue;
    }
    if (arg === '--json') {
      out.showJson = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      out.yes = true;
      continue;
    }
    if (arg === '--force') {
      out.force = true;
      continue;
    }
    if (arg === '--no-cache') {
      out.noCache = true;
      continue;
    }
    if (arg === '--available') {
      out.listMode = 'available';
      continue;
    }
    if (arg === '--installed') {
      out.listMode = 'installed';
      continue;
    }
    if (arg === '--all') {
      out.listMode = 'all';
      continue;
    }
    if (arg && arg.startsWith('--')) {
      // Unknown flag: ignore (keep surface permissive)
      continue;
    }
    if (!out.subcommand) {
      out.subcommand = arg;
    } else {
      out.ids.push(arg);
    }
  }
  return out;
}

// ─── formatters ──────────────────────────────────────────────────────────────

function printJson(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function humanList(entries, label) {
  if (entries.length === 0) {
    process.stdout.write(`(${label}: none)\n`);
    return;
  }
  process.stdout.write(`${label} (${entries.length}):\n`);
  for (const e of entries) {
    const id = e.id || '-';
    const cat = e.category || '-';
    const lic = e.license || '-';
    process.stdout.write(`  ${id}\t${cat}\t${lic}\n`);
  }
}

function humanCascade(layers) {
  if (layers.length === 0) {
    process.stdout.write('(no DESIGN.md in cascade — write <project>/.agent/DESIGN.md or install a system)\n');
    return;
  }
  for (const layer of layers) {
    const tag = layer.id ? `[${layer.kind}:${layer.id}]` : `[${layer.kind}]`;
    process.stdout.write(`  ${layer.layer}. ${layer.source}  ${tag}\n`);
  }
}

function humanShow(sys) {
  const lines = [];
  lines.push(`id:       ${sys.id}`);
  if (sys.license) lines.push(`license:  ${sys.license}`);
  if (sys.category) lines.push(`category: ${sys.category}`);
  if (sys.sha256_design) lines.push(`sha256:   ${sys.sha256_design}`);
  lines.push(`path:     ${path.join('.agent', 'design-systems', sys.id)}`);
  process.stdout.write(lines.join('\n') + '\n');
}

function printHelp() {
  const lines = [
    'Usage: cortex-agent design <subcommand> [options]',
    '',
    'Subcommands:',
    '  list [--available | --installed | --all] [--json] [--no-cache]',
    '    Show available catalog and/or installed design systems.',
    '  install <id>... [--yes] [--force] [--no-cache] [--json]',
    '    Install one or more design systems. Prompts for license ack unless --yes.',
    '  upgrade [<id>] [--yes] [--no-cache] [--json]',
    '    Upgrade installed systems. If <id> omitted, upgrades all.',
    '  remove <id>... [--json]',
    '    Remove installed design systems.',
    '  show <id> [--json]',
    '    Show details of an installed design system.',
    '  resolved [--json]',
    '    Print the 4-level cascade of active DESIGN.md files.',
    '  refresh-catalog',
    '    Force refresh the upstream catalog cache (24h TTL default).',
    '',
    'Options:',
    '  --json         Emit machine-readable JSON output',
    '  --yes, -y      Skip license ack prompt (script-friendly)',
    '  --force        Override license fail-closed (use with care)',
    '  --no-cache     Bypass the 24h upstream catalog cache',
    '  --available    list: show upstream catalog',
    '  --installed    list: show installed (default)',
    '  --all          list: show both',
    '  --help, -h     Show this help',
    '',
    'Exit codes: 0 success / 1 generic / 2 user error / 3 network / 4 license rejected',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

// ─── prompt (injectable for tests) ──────────────────────────────────────────

function defaultPrompt(question) {
  return new Promise((resolvePrompt) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolvePrompt(answer);
    });
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────

function getCwd(ctx) {
  return (ctx && ctx.cwd) || process.cwd();
}

async function loadCatalogSafe(parsed) {
  try {
    return await registry.loadCatalog({ forceRefresh: parsed.noCache });
  } catch (e) {
    const err = new Error('Failed to load upstream catalog: ' + e.message);
    err.code = 'ERR_CATALOG';
    err.cause = e;
    throw err;
  }
}

async function fetchManifestSafe(id, entry, ctx) {
  try {
    return await fetchLib.fetchManifest({
      id,
      entry,
      upstream: registry.getUpstream(ctx && ctx.env),
    });
  } catch (e) {
    const err = new Error('Failed to fetch manifest for ' + id + ': ' + e.message);
    err.code = 'ERR_NETWORK';
    err.cause = e;
    throw err;
  }
}

async function fetchSystemSafe(id, entry, destDir, ctx) {
  try {
    return await fetchLib.fetchSystem({
      id,
      entry,
      upstream: registry.getUpstream(ctx && ctx.env),
      destDir,
    });
  } catch (e) {
    const err = new Error('Failed to fetch system ' + id + ': ' + e.message);
    err.code = e && e.code === 'ERR_NETWORK' ? 'ERR_NETWORK' : 'ERR_FETCH';
    err.cause = e;
    throw err;
  }
}

// ─── subcommand: list ───────────────────────────────────────────────────────

async function designList(parsed, ctx) {
  const cwd = getCwd(ctx);
  const installed = lockfile.listSystems(cwd);
  let available = null;
  if (parsed.listMode === 'available' || parsed.listMode === 'all') {
    available = await loadCatalogSafe(parsed);
  }

  if (parsed.showJson) {
    if (parsed.listMode === 'installed') {
      printJson({ ok: true, installed });
    } else if (parsed.listMode === 'available') {
      printJson({ ok: true, entries: available });
    } else {
      printJson({ ok: true, installed, available });
    }
    return;
  }
  if (parsed.listMode === 'all' || parsed.listMode === 'installed') {
    humanList(installed, 'Installed');
  }
  if (parsed.listMode === 'all') process.stdout.write('\n');
  if (parsed.listMode === 'available' || parsed.listMode === 'all') {
    humanList(available, 'Available');
  }
}

// ─── subcommand: install ────────────────────────────────────────────────────

async function designInstall(parsed, ctx) {
  if (parsed.ids.length === 0) {
    process.stderr.write('design install: <id> required\n');
    process.stderr.write('Usage: cortex-agent design install <id>... [--yes] [--force] [--no-cache]\n');
    process.exitCode = 2;
    return;
  }
  const cwd = getCwd(ctx);
  const prompt = (ctx && ctx.prompt) || defaultPrompt;
  const catalog = await loadCatalogSafe(parsed);
  const byId = new Map(catalog.map((e) => [e.id, e]));

  for (const id of parsed.ids) {
    const entry = byId.get(id);
    if (!entry) {
      process.stderr.write('design install: id not found in catalog: ' + id + '\n');
      process.exitCode = 2;
      return;
    }

    // 1. Fetch manifest only (read-only) to check license.
    const manifestResult = await fetchManifestSafe(id, entry, ctx);

    // 2. License gate.
    const acceptable = license.isLicenseAcceptable(
      manifestResult.manifest,
      { force: parsed.force, allowedCategories: ctx && ctx.allowedCategories, allowedLicenses: ctx && ctx.allowedLicenses }
    );
    if (!acceptable.ok && !parsed.yes) {
      const warning = license.formatLicenseWarning(Object.assign({ id }, manifestResult.manifest, { source: manifestResult.manifest.source || (entry.upstream_url ? { type: 'upstream', origin: new URL(entry.upstream_url).pathname.split('/').slice(1, 3).join('/') } : null) }));
      process.stdout.write(warning);
      const answer = await prompt('Proceed? [y/N] ');
      if (!license.isYesAnswer(answer)) {
        process.stderr.write('Aborted: ' + id + '\n');
        process.exitCode = 4;
        return;
      }
    } else if (!acceptable.ok && parsed.yes) {
      // --yes does NOT override license fail-closed; only --force does.
      process.stderr.write('design install: license unacceptable (use --force): ' + acceptable.reason + '\n');
      process.exitCode = 4;
      return;
    }

    // 3. Fetch and write all files.
    const destDir = path.join(cwd, '.agent', 'design-systems', id);
    const result = await fetchSystemSafe(id, entry, destDir, ctx);

    // 4. Add to lockfile.
    const lockEntry = {
      id,
      sha256_manifest: result.sha256.manifest,
      sha256_design: result.sha256.design,
      sha256_tokens: result.sha256.tokens,
      license: manifestResult.manifest.license || null,
      category: manifestResult.manifest.category || null,
      source: manifestResult.manifest.source || null,
    };
    lockfile.addSystem(cwd, lockEntry);

    if (parsed.showJson) {
      printJson({ ok: true, id, sha256: result.sha256, license: lockEntry.license, category: lockEntry.category });
    } else {
      process.stdout.write('Installed ' + id + ' (' + (lockEntry.license || 'unknown license') + ')\n');
    }
  }
}

// ─── subcommand: upgrade ────────────────────────────────────────────────────

async function designUpgrade(parsed, ctx) {
  const cwd = getCwd(ctx);
  const installed = lockfile.listSystems(cwd);
  if (installed.length === 0) {
    process.stderr.write('design upgrade: no installed systems. Use `design install` first.\n');
    process.exitCode = 2;
    return;
  }
  const targetIds = parsed.ids.length > 0
    ? parsed.ids
    : installed.map((s) => s.id);
  // Verify all target ids are installed.
  for (const id of targetIds) {
    if (!installed.find((s) => s.id === id)) {
      process.stderr.write('design upgrade: not installed: ' + id + '\n');
      process.exitCode = 2;
      return;
    }
  }

  const catalog = await loadCatalogSafe(parsed);
  const byId = new Map(catalog.map((e) => [e.id, e]));
  const deltas = {};

  for (const id of targetIds) {
    const entry = byId.get(id);
    if (!entry) {
      process.stderr.write('design upgrade: id not in catalog: ' + id + ' (skipping)\n');
      continue;
    }
    const manifestResult = await fetchManifestSafe(id, entry, ctx);
    const current = installed.find((s) => s.id === id);
    if (current.sha256_manifest === manifestResult.sha256) {
      // no change
      if (parsed.showJson) {
        // collect later
      } else {
        process.stdout.write(id + ': no change (sha256 match)\n');
      }
      continue;
    }
    // Hash differs — re-fetch.
    const destDir = path.join(cwd, '.agent', 'design-systems', id);
    const result = await fetchSystemSafe(id, entry, destDir, ctx);
    deltas[id] = {
      old_sha256: current.sha256_manifest,
      new_sha256: result.sha256.manifest,
    };
    if (!parsed.showJson) {
      process.stdout.write(id + ': upgraded (' + (current.sha256_manifest || '-').slice(0, 12) + '... -> ' + result.sha256.manifest.slice(0, 12) + '...)\n');
    }
  }

  if (Object.keys(deltas).length > 0) {
    lockfile.upgradeSystems(cwd, Object.fromEntries(Object.entries(deltas).map(([id, d]) => [id, { sha256_manifest: d.new_sha256 }])));
  }
  if (parsed.showJson) {
    printJson({ ok: true, deltas });
  }
}

// ─── subcommand: remove ─────────────────────────────────────────────────────

async function designRemove(parsed, ctx) {
  if (parsed.ids.length === 0) {
    process.stderr.write('design remove: <id> required\n');
    process.exitCode = 2;
    return;
  }
  const cwd = getCwd(ctx);
  for (const id of parsed.ids) {
    const { changed } = lockfile.removeSystem(cwd, id);
    if (parsed.showJson) {
      printJson({ ok: true, id, removed: changed });
    } else {
      process.stdout.write(changed ? ('Removed ' + id + '\n') : (id + ': not installed\n'));
    }
  }
}

// ─── subcommand: show ───────────────────────────────────────────────────────

async function designShow(parsed, ctx) {
  if (parsed.ids.length !== 1) {
    process.stderr.write('design show: <id> required\n');
    process.exitCode = 2;
    return;
  }
  const cwd = getCwd(ctx);
  const sys = lockfile.getSystem(cwd, parsed.ids[0]);
  if (!sys) {
    process.stderr.write('design show: not installed: ' + parsed.ids[0] + '\n');
    process.exitCode = 2;
    return;
  }
  if (parsed.showJson) {
    printJson({ ok: true, system: sys });
  } else {
    humanShow(sys);
  }
}

// ─── subcommand: resolved ───────────────────────────────────────────────────

async function designResolved(parsed, ctx) {
  const cwd = getCwd(ctx);
  const templateDir = path.resolve(__dirname, '..', '..', 'templates');
  const layers = resolve.resolveCascade({ cwd, templateDir });
  if (parsed.showJson) {
    printJson({ ok: true, layers });
  } else {
    humanCascade(layers);
  }
}

// ─── subcommand: refresh-catalog ────────────────────────────────────────────

async function designRefreshCatalog(parsed, ctx) {
  const entries = await loadCatalogSafe({ noCache: true });
  if (parsed.showJson) {
    printJson({ ok: true, count: entries.length });
  } else {
    process.stdout.write('Catalog refreshed: ' + entries.length + ' systems\n');
  }
}

// ─── dispatcher entry point ────────────────────────────────────────────────

async function designCommand(ctx) {
  ctx = ctx || {};
  const rawArgs = Array.isArray(ctx.args) ? ctx.args : [];
  // Strip leading "design" so parseDesignArgs sees subcommand + flags.
  const args = rawArgs[0] === 'design' ? rawArgs.slice(1) : rawArgs;
  const parsed = parseDesignArgs(args);

  if (parsed.showHelp || !parsed.subcommand) {
    printHelp();
    return;
  }

  try {
    switch (parsed.subcommand) {
      case 'list':
        await designList(parsed, ctx);
        break;
      case 'install':
        await designInstall(parsed, ctx);
        break;
      case 'upgrade':
        await designUpgrade(parsed, ctx);
        break;
      case 'remove':
        await designRemove(parsed, ctx);
        break;
      case 'show':
        await designShow(parsed, ctx);
        break;
      case 'resolved':
        await designResolved(parsed, ctx);
        break;
      case 'refresh-catalog':
        await designRefreshCatalog(parsed, ctx);
        break;
      case 'help':
        printHelp();
        break;
      default:
        process.stderr.write('design: unknown subcommand: ' + parsed.subcommand + '\n');
        printHelp();
        process.exitCode = 2;
        break;
    }
  } catch (e) {
    const code = e && e.code;
    if (code === 'ERR_NETWORK') {
      process.stderr.write('design: network error: ' + e.message + '\n');
      process.exitCode = 3;
    } else if (code === 'ERR_CATALOG') {
      process.stderr.write('design: catalog error: ' + e.message + '\n');
      process.exitCode = 3;
    } else {
      process.stderr.write('design: ' + e.message + '\n');
      process.exitCode = 1;
    }
  }
}

module.exports = {
  designCommand,
  parseDesignArgs,
  printHelp,
  // Subcommands (exported for direct testing)
  designList,
  designInstall,
  designUpgrade,
  designRemove,
  designShow,
  designResolved,
  designRefreshCatalog,
  // Helpers
  defaultPrompt,
  loadCatalogSafe,
  fetchManifestSafe,
  fetchSystemSafe,
};
