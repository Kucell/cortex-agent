"use strict";

// Regression coverage for the GitHub review surface.
//
// The review loop was half-missing: `vcs-pr` could open and merge a pull
// request but could not read what the pull request changed, could not read
// what had already been said about it, and could not write a finding back.
// These cases pin the routing and payload shape of the four operations that
// close that loop.
//
// Two routing facts are the reason this file exists:
//
//   * PR discussion comments live under `issues/{n}/comments`.  The
//     `pulls/{n}/comments` path 404s — a pull request is an issue
//     underneath, and GitHub exposes its timeline through the issue API.
//     Getting this wrong is silent until a 404 turns into a failed review.
//   * Reviews live under `pulls/{n}/reviews` and carry an `event`
//     (APPROVE / REQUEST_CHANGES / COMMENT).
//
// The diff request must ask for the diff media type: the default JSON form
// of `pulls/{n}` returns file metadata but not the hunks, so a reviewer
// built on it would see *which* files changed but never *what* changed.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const ROOT = path.resolve(__dirname, "..", "..");

// The backend ships in three places: the governance repo (L3, the source of
// truth) and the two L1 distribution layers that carry it.  Running the same
// suite against all three proves the shipped copies behave the same as the
// source — the content-parity gate proves the bytes match, this proves the
// behaviour matches.
const BACKEND_COPIES = [
  { label: "L3 governance", dir: path.join(ROOT, ".agent", "skills", "vcs-pr", "scripts", "backends") },
  { label: "L1 _shared", dir: path.join(ROOT, "templates", "_shared", ".agent", "skills", "vcs-pr", "scripts", "backends") },
  { label: "L1 en", dir: path.join(ROOT, "templates", "en", ".agent", "skills", "vcs-pr", "scripts", "backends") },
].filter((copy) => fs.existsSync(path.join(copy.dir, "github.js")));

function startServer(t, handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, method: request.method, headers: request.headers });
    handler(request, response);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      t.after(() => server.close());
      resolve({ requests, host: `http://127.0.0.1:${address.port}` });
    });
  });
}

for (const copy of BACKEND_COPIES) {
const github = require(path.join(copy.dir, "github.js"));

test(`[${copy.label}] getDiff asks for the diff media type and returns the raw patch`, async (t) => {
  const patch = [
    "diff --git a/lib/app.js b/lib/app.js",
    "index 111..222 100644",
    "--- a/lib/app.js",
    "+++ b/lib/app.js",
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "+const b = 2;",
    "",
  ].join("\n");

  const { requests, host } = await startServer(t, (request, response) => {
    response.setHeader("content-type", "application/vnd.github.v3.diff");
    response.end(patch);
  });

  const result = await github.getDiff({
    config: { host, default: { org: "kucell", repo: "cortex-agent" } },
    token: "test-token",
    pr_number: 42,
  });

  assert.equal(result.number, 42);
  assert.equal(result.patch, patch);
  assert.match(result.patch, /\+const b = 2;/);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/repos/kucell/cortex-agent/pulls/42");
  assert.equal(requests[0].headers.accept, "application/vnd.github.v3.diff");
});

test(`[${copy.label}] listComments reads the issue timeline, not the pull request path`, async (t) => {
  const { requests, host } = await startServer(t, (request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([
      {
        id: 501,
        body: "finding: null guard missing on line 12",
        user: { login: "reviewer" },
        created_at: "2026-10-23T00:00:00Z",
        html_url: "https://github.invalid/kucell/cortex-agent/pull/42#issuecomment-501",
      },
    ]));
  });

  const result = await github.listComments({
    config: { host, default: { org: "kucell", repo: "cortex-agent" } },
    token: "test-token",
    pr_number: 42,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 501);
  assert.equal(result[0].author, "reviewer");
  assert.match(result[0].body, /null guard/);

  // The path is the assertion that matters: `pulls/42/comments` 404s.
  assert.match(requests[0].url, /^\/repos\/kucell\/cortex-agent\/issues\/42\/comments/);
  assert.doesNotMatch(requests[0].url, /pulls\/42\/comments/);
});

test(`[${copy.label}] listReviews reads reviews and normalizes the review state`, async (t) => {
  const { requests, host } = await startServer(t, (request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([
      {
        id: 77,
        state: "CHANGES_REQUESTED",
        body: "two findings",
        user: { login: "reviewer" },
        submitted_at: "2026-10-23T01:00:00Z",
        html_url: "https://github.invalid/kucell/cortex-agent/pull/42#pullrequestreview-77",
      },
    ]));
  });

  const result = await github.listReviews({
    config: { host, default: { org: "kucell", repo: "cortex-agent" } },
    token: "test-token",
    pr_number: 42,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 77);
  assert.equal(result[0].state, "CHANGES_REQUESTED");
  assert.equal(result[0].author, "reviewer");

  assert.match(requests[0].url, /^\/repos\/kucell\/cortex-agent\/pulls\/42\/reviews/);
});

test(`[${copy.label}] createComment posts to the issue timeline and returns the created id`, async (t) => {
  let received = null;
  const { requests, host } = await startServer(t, (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = Buffer.concat(chunks).toString("utf8");
      response.statusCode = 201;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: 902,
        html_url: "https://github.invalid/kucell/cortex-agent/pull/42#issuecomment-902",
        user: { login: "cortex-agent" },
        created_at: "2026-10-23T02:00:00Z",
      }));
    });
  });

  const result = await github.createComment({
    config: { host, default: { org: "kucell", repo: "cortex-agent" } },
    token: "test-token",
    pr_number: 42,
    body: "## Guided review\n\n- finding: null guard missing",
  });

  assert.equal(result.id, 902);
  assert.equal(result.author, "cortex-agent");
  assert.match(result.url, /#issuecomment-902/);

  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].url, /^\/repos\/kucell\/cortex-agent\/issues\/42\/comments/);
  assert.deepEqual(JSON.parse(received), {
    body: "## Guided review\n\n- finding: null guard missing",
  });
});

test(`[${copy.label}] createComment refuses an empty body before touching the network`, async (t) => {
  const { requests, host } = await startServer(t, (request, response) => {
    response.end("[]");
  });

  await assert.rejects(
    () => github.createComment({
      config: { host, default: { org: "kucell", repo: "cortex-agent" } },
      token: "test-token",
      pr_number: 42,
      body: "   ",
    }),
    /missing_comment_body/
  );

  assert.equal(requests.length, 0);
});

test(`[${copy.label}] submitReview sends the event and the inline comments`, async (t) => {
  let received = null;
  const { requests, host } = await startServer(t, (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = Buffer.concat(chunks).toString("utf8");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: 333,
        state: "changes_requested",
        submitted_at: "2026-10-23T03:00:00Z",
        html_url: "https://github.invalid/kucell/cortex-agent/pull/42#pullrequestreview-333",
      }));
    });
  });

  const result = await github.submitReview({
    config: { host, default: { org: "kucell", repo: "cortex-agent" } },
    token: "test-token",
    pr_number: 42,
    body: "Two findings, both mechanical.",
    event: "REQUEST_CHANGES",
    comments: [
      { path: "lib/app.js", line: 12, body: "null guard missing" },
    ],
  });

  assert.equal(result.id, 333);
  assert.equal(result.state, "changes_requested");

  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].url, /^\/repos\/kucell\/cortex-agent\/pulls\/42\/reviews/);

  const payload = JSON.parse(received);
  assert.equal(payload.event, "REQUEST_CHANGES");
  assert.equal(payload.body, "Two findings, both mechanical.");
  assert.equal(payload.comments.length, 1);
  assert.equal(payload.comments[0].path, "lib/app.js");
  assert.equal(payload.comments[0].line, 12);
});

test(`[${copy.label}] submitReview omits the comments array when there are no inline comments`, async (t) => {
  let received = null;
  const { requests, host } = await startServer(t, (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = Buffer.concat(chunks).toString("utf8");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: 334, state: "commented" }));
    });
  });

  await github.submitReview({
    config: { host, default: { org: "kucell", repo: "cortex-agent" } },
    token: "test-token",
    pr_number: 42,
    body: "Top-level note only.",
    event: "COMMENT",
  });

  const payload = JSON.parse(received);
  assert.equal(payload.event, "COMMENT");
  assert.equal("comments" in payload, false);
});

test(`[${copy.label}] review surface operations surface upstream failures instead of returning empty`, async (t) => {
  const { host } = await startServer(t, (request, response) => {
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "Not Found" }));
  });

  const opts = {
    config: { host, default: { org: "kucell", repo: "cortex-agent" } },
    token: "test-token",
    pr_number: 42,
  };

  await assert.rejects(() => github.getDiff(opts), /github_diff_failed: HTTP 404/);
  await assert.rejects(() => github.listComments(opts), /github_comments_failed: HTTP 404/);
  await assert.rejects(() => github.listReviews(opts), /github_reviews_failed: HTTP 404/);
  await assert.rejects(
    () => github.createComment({ ...opts, body: "x" }),
    /github_comment_failed: HTTP 404/
  );
  await assert.rejects(
    () => github.submitReview({ ...opts, body: "x", event: "COMMENT" }),
    /github_review_failed: HTTP 404/
  );
});
}
