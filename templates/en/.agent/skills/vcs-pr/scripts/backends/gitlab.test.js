"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const gitlab = require("./gitlab.js");

test("delivery status returns only latest merge_request_event pipeline bound to MR head", async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url.includes("/pipelines")) {
      response.end(JSON.stringify([
        { id: 11, sha: "head-1", status: "success", source: "merge_request_event", web_url: "https://gitlab.invalid/11" },
        { id: 12, sha: "other", status: "success", source: "push", web_url: "https://gitlab.invalid/12" },
      ]));
      return;
    }
    response.end(JSON.stringify({
      iid: 7,
      web_url: "https://gitlab.invalid/mr/7",
      state: "opened",
      title: "Draft: Agentic UI delivery",
      draft: true,
      source_branch: "feat/agentic-ui",
      target_branch: "main",
      sha: "head-1",
      diff_refs: { head_sha: "stale-diff-head" },
      reviewers: [{ id: 9, username: "reviewer" }],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const result = await gitlab.getDeliveryStatus({
    config: {
      host: `http://127.0.0.1:${address.port}`,
      default: { org: "samkoon", repo: "samhmi" },
    },
    token: "test-token",
    pr_number: 7,
  });

  assert.equal(result.head_sha, "head-1");
  assert.equal(result.draft, true);
  assert.equal(result.ready, false);
  assert.deepEqual(result.reviewers, [{ id: 9, username: "reviewer" }]);
  assert.deepEqual(result.pipeline, {
    id: 11,
    sha: "head-1",
    status: "success",
    normalized_status: "Succeeded",
    source: "merge_request_event",
    url: "https://gitlab.invalid/11",
    current_head: true,
  });
  assert.equal(requests.length, 2);
});

test("delivery status keeps missing authoritative pipeline explicit", async (t) => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(request.url.includes("/pipelines")
      ? JSON.stringify([{ id: 12, sha: "head-1", status: "success", source: "push" }])
      : JSON.stringify({
          iid: 7,
          web_url: "https://gitlab.invalid/mr/7",
          state: "opened",
          title: "Agentic UI delivery",
          draft: false,
          source_branch: "feat/agentic-ui",
          target_branch: "main",
          diff_refs: { head_sha: "head-1" },
          reviewers: [],
        }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const result = await gitlab.getDeliveryStatus({
    config: {
      host: `http://127.0.0.1:${address.port}`,
      default: { org: "samkoon", repo: "samhmi" },
    },
    token: "test-token",
    pr_number: 7,
  });

  assert.equal(result.ready, true);
  assert.equal(result.pipeline, null);
});

test("pipeline status normalization fails closed for every non-success terminal", () => {
  assert.equal(gitlab._normalizePipelineStatus("success"), "Succeeded");
  assert.equal(gitlab._normalizePipelineStatus("running"), "Running");
  assert.equal(gitlab._normalizePipelineStatus("waiting_for_resource"), "Pending");
  assert.equal(gitlab._normalizePipelineStatus("manual"), "Pending");
  assert.equal(gitlab._normalizePipelineStatus("canceled"), "Failed");
  assert.equal(gitlab._normalizePipelineStatus("skipped"), "Failed");
  assert.equal(gitlab._normalizePipelineStatus("unknown"), "Missing");
});


// ─── createPR labels ────────────────────────────────────────────────────────

test("createPR forwards --labels as comma-joined GitLab payload", async (t) => {
  let createPayload = null;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url.endsWith("/merge_requests")) {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        createPayload = JSON.parse(raw);
        response.statusCode = 201;
        response.end(JSON.stringify({
          iid: 42,
          web_url: "https://gitlab.invalid/mr/42",
          state: "opened",
          labels: ["area/runtime", "mission/M-034"],
          source_branch: "feat/x",
          target_branch: "main",
        }));
      });
      return;
    }
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const result = await gitlab.createPR({
    config: {
      host: `http://127.0.0.1:${address.port}`,
      default: { org: "samkoon", repo: "samhmi" },
    },
    token: "test-token",
    head: "feat/x",
    base: "main",
    title: "Draft: feat test",
    labels: ["area/runtime", "mission/M-034"],
  });

  assert.equal(createPayload.labels, "area/runtime,mission/M-034");
  assert.deepEqual(result.labels, ["area/runtime", "mission/M-034"]);
  assert.equal(result.number, 42);
});

test("updatePR with add_labels writes add_labels field", async (t) => {
  let updatePayload = null;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "PUT" && request.url.includes("/merge_requests/7") && !request.url.includes("/merge_requests/7/merge")) {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        updatePayload = JSON.parse(raw);
        response.statusCode = 200;
        response.end(JSON.stringify({
          iid: 7,
          web_url: "https://gitlab.invalid/mr/7",
          state: "opened",
          title: "feat test",
          draft: false,
          labels: ["area/runtime", "mission/M-034"],
          reviewers: [],
        }));
      });
      return;
    }
    // GET fallback: return current MR for updatePR title de-drafting path.
    if (request.method === "GET" && request.url.includes("/merge_requests/7") && !request.url.includes("/merge_requests/7/merge")) {
      response.statusCode = 200;
      response.end(JSON.stringify({
        iid: 7, web_url: "https://gitlab.invalid/mr/7", state: "opened",
        title: "feat test", draft: false, source_branch: "feat/test",
        target_branch: "main", reviewers: [],
      }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  await gitlab.updatePR({
    config: {
      host: `http://127.0.0.1:${address.port}`,
      default: { org: "samkoon", repo: "samhmi" },
    },
    token: "test-token",
    pr_number: 7,
    add_labels: ["area/runtime", "mission/M-034"],
  });

  assert.equal(updatePayload.add_labels, "area/runtime,mission/M-034");
  assert.equal(updatePayload.remove_labels, undefined);
});

test("updatePR with remove_labels writes remove_labels field", async (t) => {
  let updatePayload = null;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "PUT" && request.url.includes("/merge_requests/7") && !request.url.includes("/merge_requests/7/merge")) {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        updatePayload = JSON.parse(raw);
        response.statusCode = 200;
        response.end(JSON.stringify({
          iid: 7,
          web_url: "https://gitlab.invalid/mr/7",
          state: "opened",
          title: "feat test",
          draft: false,
          labels: [],
          reviewers: [],
        }));
      });
      return;
    }
    if (request.method === "GET" && request.url.includes("/merge_requests/7") && !request.url.includes("/merge_requests/7/merge")) {
      response.statusCode = 200;
      response.end(JSON.stringify({
        iid: 7, web_url: "https://gitlab.invalid/mr/7", state: "opened",
        title: "feat test", draft: false, source_branch: "feat/test",
        target_branch: "main", reviewers: [],
      }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  await gitlab.updatePR({
    config: {
      host: `http://127.0.0.1:${address.port}`,
      default: { org: "samkoon", repo: "samhmi" },
    },
    token: "test-token",
    pr_number: 7,
    remove_labels: ["stale/old"],
  });

  assert.equal(updatePayload.remove_labels, "stale/old");
  assert.equal(updatePayload.add_labels, undefined);
});

test("createPR without --labels omits labels field", async (t) => {
  let createPayload = null;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url.endsWith("/merge_requests")) {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        createPayload = JSON.parse(raw);
        response.statusCode = 201;
        response.end(JSON.stringify({
          iid: 43,
          web_url: "https://gitlab.invalid/mr/43",
          state: "opened",
          labels: [],
          source_branch: "feat/y",
          target_branch: "main",
        }));
      });
      return;
    }
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  await gitlab.createPR({
    config: {
      host: `http://127.0.0.1:${address.port}`,
      default: { org: "samkoon", repo: "samhmi" },
    },
    token: "test-token",
    head: "feat/y",
    base: "main",
    title: "feat y",
  });

  assert.equal(createPayload.labels, undefined);
});
