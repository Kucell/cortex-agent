"use strict";

// ─── vcs-pr backend: github ────────────────────────────────────────────────────
// GitHub REST v3 client.  Same async surface as `backends/gitea.js`.  Token
// uses `Bearer` instead of `token <hex>`.

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
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "cortex-agent-vcs-pr/1.0",
        ...(token ? { "Authorization": `Bearer ${token}` } : {}),
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

module.exports = { backend: "github", createPR, getStatus, merge, list };
