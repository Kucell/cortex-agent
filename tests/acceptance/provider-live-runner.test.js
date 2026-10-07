"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createGenericGitAdapter,
  createGitLabAdapter,
} = require("../../lib/governance/providers");
const { runProviderLiveAcceptance } = require("../../lib/acceptance/provider-live");

function fakeStatefulProvider(factory, options = {}) {
  let revision = "R1";
  let content = null;

  return factory({
    "repository.resolve": (repo) => ({ repository: repo, default_branch: "main" }),
    "branch.resolve": (repo, branch) => ({ repository: repo, branch }),
    "revision.read": () => revision,
    "object.read": () => content,
    "conditional-write": ({ expected_revision, content: next }) => {
      if (expected_revision !== revision) {
        const error = new Error("stale");
        error.code = "ERR_PROVIDER_CONDITIONAL_WRITE_CONFLICT";
        throw error;
      }
      content = next;
      revision = revision === "R1" ? "R2" : "R3";
      return { revision };
    },
    ...(options.hosted ? {
      "change-request.read": () => ({ id: "CR-1", state: "open" }),
      "checks.read": () => [{ id: "ci", status: "completed", conclusion: "success" }],
      "identity.read": () => ({ id: "user-1", login: "tester" }),
    } : {}),
  });
}

test("live acceptance runner proves CAS conflict and reconnect revision", async () => {
  const provider = fakeStatefulProvider(createGenericGitAdapter);
  const result = await runProviderLiveAcceptance(provider, {
    repository: "org/governance",
    branch: "main",
    nonce: "n1",
  });

  assert.equal(result.evidence_class, "LIVE");
  assert.equal(result.revision_before, "R1");
  assert.equal(result.revision_after, "R2");
  assert.equal(result.stale_write_rejected, true);
  assert.match(result.object_after, /session-a/);
  assert.equal(result.optional.checks.status, "unavailable");
});

test("hosted provider optional CR checks identity are captured when available", async () => {
  const provider = fakeStatefulProvider(createGitLabAdapter, { hosted: true });
  const result = await runProviderLiveAcceptance(provider, {
    repository: "group/governance",
    branch: "main",
  });

  assert.equal(result.optional.change_request.status, "observed");
  assert.equal(result.optional.checks.status, "observed");
  assert.equal(result.optional.identity.status, "observed");
});

test("runner fails closed when provider accepts stale writer", async () => {
  let revision = "R1";
  const provider = createGenericGitAdapter({
    "repository.resolve": (repo) => ({ repository: repo, default_branch: "main" }),
    "branch.resolve": (repo, branch) => ({ repository: repo, branch }),
    "revision.read": () => revision,
    "object.read": () => null,
    "conditional-write": () => {
      revision = revision === "R1" ? "R2" : "R3";
      return { revision };
    },
  });

  await assert.rejects(
    () => runProviderLiveAcceptance(provider, { repository: "org/bad-governance" }),
    (error) => error.code === "ERR_PROVIDER_ACCEPTANCE_STALE_WRITE_NOT_REJECTED",
  );
});
