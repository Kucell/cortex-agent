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
  const res = await send("POST", config.host, `/api/v4/projects/${pid}/merge_requests`, token, {
    source_branch: head,
    target_branch: base || "main",
    title,
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

async function merge(opts) {
  const { config, token, pr_number, commit_message } = opts;
  const pid = projectUrl(opts, config);
  const res = await send("PUT", config.host, `/api/v4/projects/${pid}/merge_requests/${pr_number}/merge`, token, {
    merge_commit_message: commit_message || "",
    squash: opts.squash === true,
    should_remove_source_branch: opts.remove_source !== false,
  });
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

module.exports = { backend: "gitlab", createPR, getStatus, merge, list };
