"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PROVIDER_KINDS,
  PROVIDER_CAPABILITIES,
  PROVIDER_NATIVE_TERMS,
  providerCapabilities,
  hasProviderCapability,
  requireProviderCapability,
  normalizeProviderLocator,
  normalizeChangeRequest,
  normalizeCheckSummary,
  normalizeProviderIdentity,
  createGenericGitAdapter,
  createGitHubAdapter,
  createGitLabAdapter,
  createGiteeAdapter,
} = require("../../lib/governance/providers");

test("provider kinds are frozen and provider-neutral", () => {
  assert.deepEqual(PROVIDER_KINDS, ["generic-git", "github", "gitlab", "gitee"]);
  assert.ok(PROVIDER_CAPABILITIES.includes("conditional-write"));
  assert.ok(PROVIDER_CAPABILITIES.includes("change-request.read"));
});

test("generic git exposes only portable repository primitives", () => {
  const caps = providerCapabilities("generic-git");
  assert.deepEqual(caps, [
    "repository.resolve",
    "branch.resolve",
    "revision.read",
    "branch.create",
    "object.read",
    "conditional-write",
  ]);
  assert.equal(hasProviderCapability("generic-git", "change-request.read"), false);
  assert.equal(hasProviderCapability("generic-git", "checks.read"), false);
  assert.throws(
    () => requireProviderCapability("generic-git", "change-request.read"),
    (error) => error.code === "ERR_PROVIDER_CAPABILITY_UNSUPPORTED",
  );
});

test("hosted provider adapters expose normalized change-request/check capabilities", () => {
  for (const kind of ["github", "gitlab", "gitee"]) {
    assert.equal(hasProviderCapability(kind, "change-request.read"), true);
    assert.equal(hasProviderCapability(kind, "checks.read"), true);
    assert.equal(hasProviderCapability(kind, "identity.read"), true);
  }
});

test("provider-native naming remains metadata and does not leak into core vocabulary", () => {
  assert.equal(PROVIDER_NATIVE_TERMS.github.change_request, "pull-request");
  assert.equal(PROVIDER_NATIVE_TERMS.gitlab.change_request, "merge-request");
  assert.equal(PROVIDER_NATIVE_TERMS.gitee.checks, "gitee-or-third-party-ci");
  assert.equal(PROVIDER_NATIVE_TERMS["generic-git"].change_request, null);
});

test("provider locator is normalized without provider-specific fields", () => {
  assert.deepEqual(
    normalizeProviderLocator({
      kind: "gitlab",
      repository: "group/project-agent",
      ref: "main",
    }),
    {
      kind: "gitlab",
      repository: "group/project-agent",
      ref: "main",
    },
  );
});

test("ChangeRequest normalizes GitHub/GitLab/Gitee into one portable shape", () => {
  const values = [
    normalizeChangeRequest({
      id: "42",
      provider: "github",
      repository: "org/repo",
      source_branch: "feat/a",
      target_branch: "main",
      state: "open",
      revision: "abc",
      url: "https://example.invalid/pr/42",
    }),
    normalizeChangeRequest({
      id: "17",
      provider: "gitlab",
      repository: "group/repo",
      source_branch: "feat/b",
      target_branch: "main",
      state: "opened",
      revision: "def",
      url: "https://example.invalid/mr/17",
    }),
    normalizeChangeRequest({
      id: "9",
      provider: "gitee",
      repository: "org/repo",
      source_branch: "feat/c",
      target_branch: "main",
      state: "open",
      revision: "ghi",
      url: "https://example.invalid/pr/9",
    }),
  ];
  for (const value of values) {
    assert.ok(value.id);
    assert.ok(value.provider);
    assert.ok(value.repository);
    assert.ok(value.source_branch);
    assert.ok(value.target_branch);
    assert.ok(value.state);
    assert.ok(Object.prototype.hasOwnProperty.call(value, "revision"));
  }
});

test("CheckSummary and ProviderIdentity stay provider-neutral", () => {
  const check = normalizeCheckSummary({
    id: "check-1",
    provider: "github",
    name: "ci",
    status: "completed",
    conclusion: "success",
    revision: "abc",
    url: "https://example.invalid/check/1",
  });
  assert.equal(check.provider, "github");
  assert.equal(check.conclusion, "success");

  const identity = normalizeProviderIdentity({
    provider: "gitee",
    id: "u-1",
    login: "alice",
    display_name: "Alice",
  });
  assert.deepEqual(identity, {
    provider: "gitee",
    id: "u-1",
    login: "alice",
    display_name: "Alice",
  });
});

test("adapter invocation fails closed when a declared capability has no operation owner", () => {
  const adapter = createGitHubAdapter();
  assert.equal(adapter.supports("change-request.read"), true);
  assert.throws(
    () => adapter.invoke("change-request.read", "42"),
    (error) => error.code === "ERR_PROVIDER_OPERATION_UNAVAILABLE",
  );
});

test("adapter invokes only declared operations", () => {
  const calls = [];
  const adapter = createGitLabAdapter({
    "repository.resolve": (repo) => {
      calls.push(repo);
      return { repository: repo };
    },
  });
  assert.deepEqual(adapter.invoke("repository.resolve", "group/repo"), {
    repository: "group/repo",
  });
  assert.deepEqual(calls, ["group/repo"]);
});

test("generic adapter cannot silently gain hosted-provider capabilities from operations", () => {
  const adapter = createGenericGitAdapter({
    "change-request.read": () => ({ id: "1" }),
  });
  assert.equal(adapter.supports("change-request.read"), false);
  assert.throws(
    () => adapter.invoke("change-request.read", "1"),
    (error) => error.code === "ERR_PROVIDER_CAPABILITY_UNSUPPORTED",
  );
});

test("all named adapter factories preserve their provider identity", () => {
  assert.equal(createGenericGitAdapter().kind, "generic-git");
  assert.equal(createGitHubAdapter().kind, "github");
  assert.equal(createGitLabAdapter().kind, "gitlab");
  assert.equal(createGiteeAdapter().kind, "gitee");
});
