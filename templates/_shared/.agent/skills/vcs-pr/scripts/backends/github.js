"use strict";

// ─── vcs-pr backend: github ────────────────────────────────────────────────────
// GitHub REST v3 client.  Same async surface as `backends/gitea.js`.  Token
// uses `Bearer` instead of `token <hex>`.

const https = require("https");
const http = require("http");
const { URL } = require("url");

function send(method, baseUrl, path, token, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const lib = url.protocol === "https:" ? https : http;
    const payload = body ? JSON.stringify(body) : "";
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + (url.search || ""),
      headers: {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "cortex-agent-vcs-pr/1.0",
        ...(token ? { "Authorization": `Bearer ${token}` } : {}),
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        ...(extraHeaders || {}),
      },
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch (_) { /* leave null */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: body });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function mapRepo({ owner, repo }, config) {
  return { owner: owner || config.default?.org, repo: repo || config.default?.repo };
}

async function createPR(opts) {
  const { config, token, head, base, title, body } = opts;
  const { owner, repo } = mapRepo(opts, config);
  if (!owner || !repo) throw new Error("missing_owner_or_repo");
  const res = await send("POST", config.host, `/repos/${owner}/${repo}/pulls`, token, {
    title, head, base: base || "main", body: body || "",
  });
  if (res.status !== 201) throw new Error(`github_create_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  return {
    number: res.body.number,
    url: res.body.html_url,
    state: res.body.state,
    head: res.body.head?.ref || head,
    base: res.body.base?.ref || base,
    raw: res.body,
  };
}

async function getStatus(opts) {
  const { config, token, pr_number } = opts;
  const { owner, repo } = mapRepo(opts, config);
  const res = await send("GET", config.host, `/repos/${owner}/${repo}/pulls/${pr_number}`, token);
  if (res.status !== 200) throw new Error(`github_status_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  return { number: res.body.number, state: res.body.state, merged: !!res.body.merged, url: res.body.html_url, title: res.body.title, raw: res.body };
}

async function merge(opts) {
  const { config, token, pr_number, commit_message } = opts;
  const { owner, repo } = mapRepo(opts, config);
  const res = await send("PUT", config.host, `/repos/${owner}/${repo}/pulls/${pr_number}/merge`, token, {
    commit_message: commit_message || "",
    merge_method: opts.merge_method || "merge",
  });
  if (res.status !== 200) throw new Error(`github_merge_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  return { merged: true, raw: res.body };
}

async function list(opts) {
  const { config, token, state } = opts;
  const { owner, repo } = mapRepo(opts, config);
  const qs = state ? `?state=${encodeURIComponent(state)}` : "?state=open";
  const res = await send("GET", config.host, `/repos/${owner}/${repo}/pulls${qs}`, token);
  if (res.status !== 200) throw new Error(`github_list_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  return Array.isArray(res.body) ? res.body.map((pr) => ({
    number: pr.number, title: pr.title, state: pr.state, head: pr.head?.ref, base: pr.base?.ref, url: pr.html_url,
  })) : [];
}

// ─── review surface ─────────────────────────────────────────────────────────
//
// The four operations below are the missing half of the review loop: reading
// what a PR actually changed, reading what has already been said about it,
// and writing a finding back so a human can act on it.
//
// Two GitHub routing facts drive the implementation:
//
//   * PR *discussion comments* live under `issues/{n}/comments`, not under
//     `pulls/{n}/comments` — the latter 404s.  A PR is an issue underneath.
//   * PR *reviews* live under `pulls/{n}/reviews` and carry an `event`
//     (APPROVE / REQUEST_CHANGES / COMMENT).  A review body alone is a
//     top-level review; per-line comments ride in the `comments` array.
//
// The diff comes back as a unified patch from `pulls/{n}` with the diff
// media type.  `Accept: application/vnd.github.v3.diff` yields the raw
// patch, which is what a reviewer needs — the JSON form of the same endpoint
// returns file metadata but not the hunks.

async function getDiff(opts) {
  const { config, token, pr_number } = opts;
  const { owner, repo } = mapRepo(opts, config);
  const res = await send("GET", config.host, `/repos/${owner}/${repo}/pulls/${pr_number}`, token, null, {
    Accept: "application/vnd.github.v3.diff",
  });
  if (res.status !== 200) throw new Error(`github_diff_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  return { number: pr_number, patch: res.raw };
}

async function listComments(opts) {
  const { config, token, pr_number } = opts;
  const { owner, repo } = mapRepo(opts, config);
  const res = await send("GET", config.host, `/repos/${owner}/${repo}/issues/${pr_number}/comments?per_page=100`, token);
  if (res.status !== 200) throw new Error(`github_comments_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  return Array.isArray(res.body) ? res.body.map((comment) => ({
    id: comment.id,
    author: comment.user?.login || null,
    body: comment.body || "",
    created_at: comment.created_at || null,
    url: comment.html_url || null,
  })) : [];
}

async function listReviews(opts) {
  const { config, token, pr_number } = opts;
  const { owner, repo } = mapRepo(opts, config);
  const res = await send("GET", config.host, `/repos/${owner}/${repo}/pulls/${pr_number}/reviews?per_page=100`, token);
  if (res.status !== 200) throw new Error(`github_reviews_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  return Array.isArray(res.body) ? res.body.map((review) => ({
    id: review.id,
    author: review.user?.login || null,
    state: review.state || null,
    body: review.body || "",
    submitted_at: review.submitted_at || null,
    url: review.html_url || null,
  })) : [];
}

async function createComment(opts) {
  const { config, token, pr_number, body } = opts;
  const { owner, repo } = mapRepo(opts, config);
  if (!body || !String(body).trim()) throw new Error("missing_comment_body");
  const res = await send("POST", config.host, `/repos/${owner}/${repo}/issues/${pr_number}/comments`, token, {
    body: String(body),
  });
  if (res.status !== 201) throw new Error(`github_comment_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  return {
    id: res.body.id,
    url: res.body.html_url || null,
    author: res.body.user?.login || null,
    created_at: res.body.created_at || null,
  };
}

// `event` is one of APPROVE / REQUEST_CHANGES / COMMENT.  A review carrying
// inline comments must use the COMMENT or REQUEST_CHANGES event — GitHub
// rejects line-anchored comments on an APPROVE review.
async function submitReview(opts) {
  const { config, token, pr_number, body, event, comments } = opts;
  const { owner, repo } = mapRepo(opts, config);
  const payload = { body: body || "" };
  if (event) payload.event = event;
  if (Array.isArray(comments) && comments.length) payload.comments = comments;
  const res = await send("POST", config.host, `/repos/${owner}/${repo}/pulls/${pr_number}/reviews`, token, payload);
  if (res.status !== 200) throw new Error(`github_review_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  return {
    id: res.body.id,
    state: res.body.state || null,
    url: res.body.html_url || null,
    submitted_at: res.body.submitted_at || null,
  };
}

module.exports = {
  backend: "github",
  createPR,
  getStatus,
  merge,
  list,
  getDiff,
  listComments,
  listReviews,
  createComment,
  submitReview,
};
