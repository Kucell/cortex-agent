"use strict";

// ─── MiniMax CLI Portable Skill Discovery (M-011 / P-008) ──────────────────
// Zero external dependencies — Node.js built-ins only.
// Node compatibility: >=14.
//
// Public API:
//   - discoverSkills(options) -> MiniMaxCliSkillDescriptor[]
//   - enumerateDiscoveryPaths(options) -> string[]
//
// Skill descriptors are purely informational (path + present + size +
// declared name + description). The module NEVER writes, installs, or
// mutates any host skill directory. If a path is missing the descriptor
// reports `present: false` and no other side-effect occurs.

const fs = require("node:fs");
const path = require("node:path");

const SKILL_NAME = "minimax-cli";
const MAX_DECLARED_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 256;
const MAX_PATH_LENGTH = 1024;

const HOSTS = Object.freeze([
  "claude-code",
  "cursor",
  "pi",
  "codex",
  "common",
]);

const SCOPES = Object.freeze(["user", "project", "template"]);

const HOST_PATH_BUILDER = Object.freeze({
  "claude-code": {
    user: () => path.join(osHomedir(), ".claude", "skills", SKILL_NAME),
    project: (projectRoot) => path.join(projectRoot, ".claude", "skills", SKILL_NAME),
    template: (templatesRoot, locale) => path.join(templatesRoot, locale, ".claude", "skills", SKILL_NAME),
  },
  cursor: {
    user: () => path.join(osHomedir(), ".cursor", "skills", SKILL_NAME),
    project: (projectRoot) => path.join(projectRoot, ".cursor", "skills", SKILL_NAME),
    template: (templatesRoot, locale) => path.join(templatesRoot, locale, ".cursor", "skills", SKILL_NAME),
  },
  pi: {
    // Per ARI P-005 §5.2: enumerate BOTH `~/.pi/skills/minimax-cli` and
    // `~/.agents/skills/minimax-cli` as independent user-level entries.
    user_pi: () => path.join(osHomedir(), ".pi", "skills", SKILL_NAME),
    user_agents: () => path.join(osHomedir(), ".agents", "skills", SKILL_NAME),
    project: (projectRoot) => path.join(projectRoot, ".pi", "skills", SKILL_NAME),
    template: (templatesRoot, locale) => path.join(templatesRoot, locale, ".pi", "skills", SKILL_NAME),
  },
  codex: {
    user: () => path.join(osHomedir(), ".codex", "skills", SKILL_NAME),
    project: (projectRoot) => path.join(projectRoot, ".codex", "skills", SKILL_NAME),
    template: (templatesRoot, locale) => path.join(templatesRoot, locale, ".codex", "skills", SKILL_NAME),
  },
  common: {
    user: () => null, // no common user scope
    project: (projectRoot) => path.join(projectRoot, ".agent", "skills", SKILL_NAME),
    template: (templatesRoot, locale) => path.join(templatesRoot, locale, ".agent", "skills", SKILL_NAME),
  },
});

const TEMPLATE_LOCALES = Object.freeze(["zh", "en"]);

const SHARED_TEMPLATE_REL = path.join("_shared", ".agent", "skills", SKILL_NAME);

class SkillDiscoveryError extends Error {
  constructor(code, details) {
    super(`[minimax-cli-skill-discovery:${code}] ${JSON.stringify(details || {})}`);
    this.name = "SkillDiscoveryError";
    this.code = code;
    this.details = details || {};
  }
}

function osHomedir() {
  return require("node:os").homedir();
}

function piSkillsHome() {
  // Pi discovery supports both ~/.pi/skills and ~/.agents/skills. We return
  // the parent directory (`<homedir>/.pi/skills` or `<homedir>/.agents/skills`)
  // and let the caller append SKILL_NAME so the path stays well-formed.
  // The Pi builder explicitly enumerates BOTH roots to honour ARI P-005 §5.2
  // ("Pi 用户的 ~/.pi/skills/ ~/.agents/skills/").
  const os = require("node:os");
  const primaryParent = path.join(os.homedir(), ".pi", "skills");
  const fallbackParent = path.join(os.homedir(), ".agents", "skills");
  try {
    if (fs.existsSync(primaryParent)) return primaryParent;
    if (fs.existsSync(fallbackParent)) return fallbackParent;
  } catch (_) {
    // ignore
  }
  return primaryParent;
}

function enumerateDiscoveryPaths(options) {
  const opts = options || {};
  const projectRoot = opts.projectRoot || process.cwd();
  const templatesRoot = opts.templatesRoot || path.join(projectRoot, "templates");
  const locales = Array.isArray(opts.locales) && opts.locales.length > 0 ? opts.locales : TEMPLATE_LOCALES;
  const out = [];
  for (const host of HOSTS) {
    for (const scope of SCOPES) {
      // Common/user is intentionally absent.
      if (host === "common" && scope === "user") continue;
      // Pi host has TWO user-level entries (pi + agents); expand both.
      if (host === "pi" && scope === "user") {
        const piBuilders = HOST_PATH_BUILDER[host];
        out.push({ host, scope, path: piBuilders.user_pi(), variant: "user_pi" });
        out.push({ host, scope, path: piBuilders.user_agents(), variant: "user_agents" });
        continue;
      }
      const builder = HOST_PATH_BUILDER[host][scope];
      if (!builder) continue;
      if (scope === "user") {
        out.push({ host, scope, path: builder() });
      } else if (scope === "project") {
        out.push({ host, scope, path: builder(projectRoot) });
      } else {
        for (const locale of locales) {
          out.push({ host, scope, path: builder(templatesRoot, locale), locale });
        }
      }
    }
  }
  // Plus the shared template root (always points at templates/_shared).
  out.push({
    host: "common",
    scope: "template",
    path: path.join(templatesRoot, SHARED_TEMPLATE_REL),
    locale: "shared",
  });
  return out;
}

function readFrontMatter(skillFilePath) {
  try {
    const content = fs.readFileSync(skillFilePath, "utf8");
    if (content.length > 16 * 1024) return { name: null, description: null };
    if (!content.startsWith("---")) return { name: null, description: null };
    const closing = content.indexOf("\n---", 3);
    if (closing < 0) return { name: null, description: null };
    const front = content.slice(3, closing).trim();
    const out = { name: null, description: null };
    for (const line of front.split(/\r?\n/)) {
      const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1].toLowerCase();
      const value = match[2].replace(/^['"]|['"]$/g, "").trim();
      if (key === "name") out.name = value.slice(0, MAX_DECLARED_NAME_LENGTH);
      if (key === "description") out.description = value.slice(0, MAX_DESCRIPTION_LENGTH);
    }
    return out;
  } catch (_) {
    return { name: null, description: null };
  }
}

function inspectPath(candidate) {
  const { host, scope, path: candidatePath } = candidate;
  if (!candidatePath || candidatePath.length > MAX_PATH_LENGTH) {
    throw new SkillDiscoveryError("ERR_PATH_INVALID", {
      host,
      scope,
      path: candidatePath,
    });
  }
  let present = false;
  let sizeBytes = null;
  let declaredName = null;
  let description = null;
  try {
    const stat = fs.statSync(candidatePath);
    if (stat.isDirectory()) {
      present = true;
      sizeBytes = stat.size;
      const skillMd = path.join(candidatePath, "SKILL.md");
      if (fs.existsSync(skillMd)) {
        const fm = readFrontMatter(skillMd);
        declaredName = fm.name;
        description = fm.description;
      }
    }
  } catch (_) {
    present = false;
  }
  return {
    schema_version: "1.0",
    host,
    scope,
    path: candidatePath,
    present,
    size_bytes: sizeBytes,
    declared_name: declaredName,
    description,
  };
}

function discoverSkills(options) {
  const candidates = enumerateDiscoveryPaths(options);
  return candidates.map(inspectPath);
}

function summarizeSkills(descriptors) {
  const total = descriptors.length;
  const present = descriptors.filter((d) => d.present).length;
  const byHost = {};
  for (const d of descriptors) {
    if (!byHost[d.host]) byHost[d.host] = { total: 0, present: 0 };
    byHost[d.host].total += 1;
    if (d.present) byHost[d.host].present += 1;
  }
  return { total, present, by_host: byHost };
}

module.exports = {
  SKILL_NAME,
  HOSTS: HOSTS.slice(),
  SCOPES: SCOPES.slice(),
  TEMPLATE_LOCALES: TEMPLATE_LOCALES.slice(),
  SkillDiscoveryError,
  enumerateDiscoveryPaths,
  discoverSkills,
  summarizeSkills,
  inspectPath,
};