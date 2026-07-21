"use strict";

// ─── vcs-pr backend: gitea ─────────────────────────────────────────────────────
// Pure-stdlib Gitea REST client.  Designed so the same shape works for
// GitHub / GitLab with minimal edits — the orchestrator (vcs-pr/index.js)
// only depends on the small surface below.
//
// Endpoints used:
//   GET  /api/v1/repos/{owner}/{repo}
//   GET  /api/v1/repos/{owner}/{repo}/pulls/{number}
//   GET  /api/v1/repos/{owner}/{repo}/pulls?state=open
//   POST /api/v1/repos/{owner}/{repo}/pulls
//   POST /api/v1/repos/{owner}/{repo}/pulls/{number}/merge

const https = require("https");
const http = require("http");
const { URL } = require("url");

function send(method, baseUrl, path, token, body) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(baseUrl + path);
    } catch (err) {
      reject(new Error(`invalid_gitea_base_url: ${err.message}`));
      return;
    }
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
        ...(token ? { "Authorization": `token ${token}` } : {}),
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
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
  return {
    owner: owner || config.default?.org,
    repo: repo || config.default?.repo,
  };
}

async function createPR(opts) {
  // opts: {config, token, head, base, title, body}
  const { config, token, head, base, title, body } = opts;
  const { owner, repo } = mapRepo(opts, config);
  if (!owner || !repo) throw new Error("missing_owner_or_repo");
  const path = `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
  const res = await send("POST", config.host, path, token, {
    title,
    head,
    base: base || config.default?.base_branch || "main",
    body: body || "",
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`gitea_create_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  }
  return {
    number: res.body.number,
    url: res.body.html_url || res.body.url,
    state: res.body.state,
    head: res.body.head?.label || head,
    base: res.body.base?.label || base,
    raw: res.body,
  };
}

async function getStatus(opts) {
  const { config, token, pr_number } = opts;
  const { owner, repo } = mapRepo(opts, config);
  const path = `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr_number}`;
  const res = await send("GET", config.host, path, token);
  if (res.status !== 200) {
    throw new Error(`gitea_status_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  }
  return {
    number: res.body.number,
    state: res.body.state,
    merged: res.body.merged === true || res.body.state === "merged",
    url: res.body.html_url,
    title: res.body.title,
    raw: res.body,
  };
}

async function merge(opts) {
  const { config, token, pr_number, commit_message } = opts;
  const { owner, repo } = mapRepo(opts, config);
  const path = `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr_number}/merge`;
  const res = await send("POST", config.host, path, token, {
    Do: opts.merge_method || "merge",
    Merge_Message: commit_message || "",
  });
  if (res.status !== 200 && res.status !== 204 && res.status !== 201) {
    throw new Error(`gitea_merge_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  }
  return { merged: true, raw: res.body };
}

async function list(opts) {
  const { config, token, state } = opts;
  const { owner, repo } = mapRepo(opts, config);
  const qs = state ? `?state=${encodeURIComponent(state)}` : "?state=open";
  const path = `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls${qs}`;
  const res = await send("GET", config.host, path, token);
  if (res.status !== 200) {
    throw new Error(`gitea_list_failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`);
  }
  return Array.isArray(res.body) ? res.body.map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    head: pr.head?.label,
    base: pr.base?.label,
    url: pr.html_url,
  })) : [];
}

module.exports = { backend: "gitea", createPR, getStatus, merge, list };
