"use strict";

// ─── vcs-pr backend: gitlab ────────────────────────────────────────────────────
// GitLab REST v4 client.  Identifies projects by URL-encoded path, not by
// numeric id (more portable across self-hosted installs).

const https = require("https");
const http = require("http");
const { URL } = require("url");

function send(method, baseUrl, path, token, body) {
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
        "Accept": "application/json",
        "User-Agent": "cortex-agent-vcs-pr/1.0",
        ...(token ? { "PRIVATE-TOKEN": token } : {}),
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: body });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function projectUrl({ org, repo }, config) {
  const owner = org || config.default?.org;
  const repoName = repo || config.default?.repo;
  return encodeURIComponent(`${owner}/${repoName}`);
}

async function createPR(opts) {
  const { config, token, head, base, title, body } = opts;
  const pid = projectUrl(opts, config);
  const draftTitle = /^(?:Draft:|WIP:)/i.test(title || "") ? title : `Draft: ${title || ""}`;
  const res = await send("POST", config.host, `/api/v4/projects/${pid}/merge_requests`, token, {
    source_branch: head,
    target_branch: base || "main",
    title: draftTitle,
    description: body || "",
  });
  if (res.status !== 201) throw new Error(`gitlab_create_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  return {
    number: res.body.iid,
    url: res.body.web_url,
    state: res.body.state,
    head: res.body.source_branch,
    base: res.body.target_branch,
    raw: res.body,
  };
}

async function getStatus(opts) {
  const { config, token, pr_number } = opts;
  const pid = projectUrl(opts, config);
  const res = await send("GET", config.host, `/api/v4/projects/${pid}/merge_requests/${pr_number}`, token);
  if (res.status !== 200) throw new Error(`gitlab_status_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  return {
    number: res.body.iid,
    state: res.body.state,
    merged: res.body.state === "merged",
    url: res.body.web_url,
    title: res.body.title,
    raw: res.body,
  };
}

function isDraftMergeRequest(mr) {
  return mr.draft === true || mr.work_in_progress === true || /^(?:Draft:|WIP:)/i.test(mr.title || "");
}

function normalizePipelineStatus(status) {
  switch (status) {
    case "success": return "Succeeded";
    case "failed":
    case "canceled":
    case "skipped": return "Failed";
    case "running": return "Running";
    case "created":
    case "waiting_for_resource":
    case "preparing":
    case "waiting_for_callback":
    case "pending":
    case "canceling":
    case "manual":
    case "scheduled": return "Pending";
    default: return "Missing";
  }
}

async function getDeliveryStatus(opts) {
  const { config, token, pr_number } = opts;
  const pid = projectUrl(opts, config);
  const mr = await send("GET", config.host, `/api/v4/projects/${pid}/merge_requests/${pr_number}`, token);
  if (mr.status !== 200) {
    throw new Error(`gitlab_status_failed: HTTP ${mr.status} ${mr.raw?.slice(0, 200)}`);
  }

  const pipelines = await send(
    "GET",
    config.host,
    `/api/v4/projects/${pid}/merge_requests/${pr_number}/pipelines?per_page=20`,
    token
  );
  if (pipelines.status !== 200 || !Array.isArray(pipelines.body)) {
    throw new Error(`gitlab_pipelines_failed: HTTP ${pipelines.status} ${pipelines.raw?.slice(0, 200)}`);
  }

  const authoritative = pipelines.body
    .filter((pipeline) => pipeline && pipeline.source === "merge_request_event")
    .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))[0] || null;
  // GitLab exposes the current source-branch HEAD as `sha`. `diff_refs` is
  // populated asynchronously and may still describe the previous diff.
  const headSha = mr.body.sha || mr.body.diff_refs?.head_sha || null;
  return {
    number: mr.body.iid,
    url: mr.body.web_url,
    state: mr.body.state,
    head: mr.body.source_branch,
    base: mr.body.target_branch,
    head_sha: headSha,
    draft: isDraftMergeRequest(mr.body),
    ready: mr.body.state === "opened" && !isDraftMergeRequest(mr.body),
    reviewers: (mr.body.reviewers || []).map((reviewer) => ({
      id: reviewer.id,
      username: reviewer.username,
    })),
    pipeline: authoritative ? {
      id: authoritative.id,
      sha: authoritative.sha,
      status: authoritative.status,
      normalized_status: normalizePipelineStatus(authoritative.status),
      source: authoritative.source,
      url: authoritative.web_url || null,
      current_head: Boolean(headSha) && authoritative.sha === headSha,
    } : null,
  };
}

async function updatePR(opts) {
  const { config, token, pr_number, title, body, reviewers, ready, close, remove_source, squash } = opts;
  const pid = projectUrl(opts, config);
  const payload = {};

  if (title) payload.title = title;
  if (body != null) payload.description = body;
  if (close) payload.state_event = "close";
  if (remove_source) payload.remove_source_branch = true;
  if (squash) payload.squash = true;

  if (Array.isArray(reviewers) && reviewers.length > 0) {
    const reviewerIds = [];
    for (const username of reviewers) {
      const users = await send(
        "GET",
        config.host,
        `/api/v4/users?username=${encodeURIComponent(username)}`,
        token
      );
      if (users.status !== 200 || !Array.isArray(users.body)) {
        throw new Error(`gitlab_reviewer_lookup_failed: ${username} HTTP ${users.status}`);
      }
      const exact = users.body.find((user) => user.username === username && user.state === "active");
      if (!exact) throw new Error(`gitlab_reviewer_not_found: ${username}`);
      reviewerIds.push(exact.id);
    }
    payload.reviewer_ids = reviewerIds;
  }

  if (ready && !payload.title) {
    const current = await send("GET", config.host, `/api/v4/projects/${pid}/merge_requests/${pr_number}`, token);
    if (current.status !== 200) {
      throw new Error(`gitlab_status_failed: HTTP ${current.status} ${current.raw?.slice(0, 200)}`);
    }
    payload.title = current.body.title.replace(/^(?:Draft:\s*|WIP:\s*)/i, "");
  }

  const res = await send("PUT", config.host, `/api/v4/projects/${pid}/merge_requests/${pr_number}`, token, payload);
  if (res.status !== 200) throw new Error(`gitlab_update_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  return {
    number: res.body.iid,
    url: res.body.web_url,
    state: res.body.state,
    title: res.body.title,
    draft: res.body.draft,
    reviewers: (res.body.reviewers || []).map((reviewer) => reviewer.username),
    raw: res.body,
  };
}

async function merge(opts) {
  const { config, token, pr_number, commit_message, sha } = opts;
  const pid = projectUrl(opts, config);
  // GitLab API 18+ requires an explicit `sha` on PUT merge.  Forward it when
  // supplied; otherwise omit the field so older GitLab versions still accept
  // the request.
  const payload = {
    merge_commit_message: commit_message || "",
    squash: opts.squash === true,
    should_remove_source_branch: opts.remove_source !== false,
  };
  if (sha) payload.sha = sha;
  const res = await send("PUT", config.host, `/api/v4/projects/${pid}/merge_requests/${pr_number}/merge`, token, payload);
  if (res.status !== 200) throw new Error(`gitlab_merge_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  return { merged: true, raw: res.body };
}

async function list(opts) {
  const { config, token, state } = opts;
  const pid = projectUrl(opts, config);
  const qs = state ? `?state=${encodeURIComponent(state)}` : "?state=opened";
  const res = await send("GET", config.host, `/api/v4/projects/${pid}/merge_requests${qs}`, token);
  if (res.status !== 200) throw new Error(`gitlab_list_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  return Array.isArray(res.body) ? res.body.map((mr) => ({
    number: mr.iid, title: mr.title, state: mr.state, head: mr.source_branch, base: mr.target_branch, url: mr.web_url,
  })) : [];
}

module.exports = {
  backend: "gitlab",
  createPR,
  getStatus,
  getDeliveryStatus,
  updatePR,
  merge,
  list,
  _send: send,
  _projectUrl: projectUrl,
  _isDraftMergeRequest: isDraftMergeRequest,
  _normalizePipelineStatus: normalizePipelineStatus,
};
