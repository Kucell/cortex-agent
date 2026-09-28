"use strict";

const EFFECT_SCHEMA_VERSION = "1.0";
const EFFECT_KINDS = Object.freeze(["none", "read", "mutation"]);
const EFFECT_DOMAINS = Object.freeze([
  "filesystem",
  "git-local",
  "git-remote",
  "process",
  "network",
  "credential",
  "host-config",
]);

const EFFECT_KIND_SET = new Set(EFFECT_KINDS);
const EFFECT_DOMAIN_SET = new Set(EFFECT_DOMAINS);

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.length > 0))];
}

function buildEffect(kind, options = {}) {
  if (!EFFECT_KIND_SET.has(kind)) {
    throw new TypeError(`Unknown command effect kind: ${kind}`);
  }
  const domains = uniqueStrings(options.domains);
  for (const domain of domains) {
    if (!EFFECT_DOMAIN_SET.has(domain)) {
      throw new TypeError(`Unknown command effect domain: ${domain}`);
    }
  }
  const committed = kind === "mutation" ? options.committed === true : false;
  return Object.freeze({
    schema_version: EFFECT_SCHEMA_VERSION,
    kind,
    committed,
    exact_paths: options.exact_paths !== false,
    resources: Object.freeze(uniqueStrings(options.resources)),
    paths: Object.freeze(uniqueStrings(options.paths)),
    domains: Object.freeze(domains),
    external: options.external === true,
  });
}

function commandNone(options = {}) {
  return {
    ok: options.ok !== false,
    mutated: false,
    ...(options.help ? { help: true } : {}),
    ...(options.code ? { code: options.code } : {}),
    effect: buildEffect("none"),
  };
}

function commandRead(options = {}) {
  return {
    ok: options.ok !== false,
    mutated: false,
    read: true,
    ...(options.code ? { code: options.code } : {}),
    effect: buildEffect("read", {
      resources: options.resources,
      domains: options.domains,
    }),
  };
}

function commandMutation(options = {}) {
  return {
    ok: options.ok !== false,
    mutated: true,
    effect: buildEffect("mutation", {
      committed: options.committed !== false,
      exact_paths: options.exact_paths,
      resources: options.resources,
      paths: options.paths,
      domains: options.domains || ["filesystem"],
      external: options.external,
    }),
  };
}

function commandFailure(code, options = {}) {
  return commandNone({ ok: false, code, ...options });
}

function isCommittedMutation(result) {
  return Boolean(
    result
    && result.ok
    && result.mutated
    && result.effect
    && result.effect.kind === "mutation"
    && result.effect.committed === true,
  );
}

module.exports = {
  EFFECT_SCHEMA_VERSION,
  EFFECT_KINDS,
  EFFECT_DOMAINS,
  buildEffect,
  commandNone,
  commandRead,
  commandMutation,
  commandFailure,
  isCommittedMutation,
};
