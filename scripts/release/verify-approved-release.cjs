"use strict";
// Read-only fail-closed authorization gate. It never grants Decision/Waitpoint or publishes.
const fs = require("node:fs");
const path = require("node:path");
const MATCH = /^\/cortex-release publish v(\d+\.\d+\.\d+) decision=(D-[A-Za-z0-9._-]+) waitpoint=(WP-[A-Za-z0-9._-]+)$/;
const ALLOWED = new Set(["package.json","package-lock.json","pnpm-lock.yaml",".claude-plugin/plugin.json",".claude-plugin/marketplace.json","CHANGELOG.md","tests/release/release-version-consistency.test.js"]);
function must(ok, reason) { if (!ok) throw new Error("RELEASE_GATE_BLOCKED: " + reason); }
function parseCommand(body) {
  const m = String(body || "").trim().match(MATCH);
  must(m, "strict command with Decision and Waitpoint IDs required");
  return { version:m[1], decision:m[2], waitpoint:m[3] };
}
function hasIndependentApproval(pr, reviews) {
  const states = new Map();
  for (const r of reviews) if (r.user && r.user.login) states.set(r.user.login.toLowerCase(), r);
  return [...states.values()].some(r => r.state === "APPROVED" &&
    r.user.login.toLowerCase() !== pr.user.login.toLowerCase() &&
    r.commit_id === pr.head.sha);
}
function validateGovernance(decision, waitpoint, sha, now=new Date()) {
  const target = "release:cortex-agent@" + sha;
  must(decision.type === "approval" && decision.status === "approved" &&
    decision.selected_option === "approve", "approved release Decision required");
  must(decision.gate && decision.gate.action === "release" &&
    decision.gate.resource_ref === target, "Decision resource mismatch");
  must(waitpoint.status === "released" && waitpoint.decision_id === decision.decision_id &&
    waitpoint.gate && waitpoint.gate.action === "release" &&
    waitpoint.gate.resource_ref === target, "matching released Waitpoint required");
  if (waitpoint.expires_at) must(Date.parse(waitpoint.expires_at) > +now, "Waitpoint expired");
  return target;
}
async function getJson(uri, token, http=fetch) {
  must(token, "read-only GitHub credential absent");
  const response = await http(uri, { headers: {Authorization:"Bearer "+token, Accept:"application/vnd.github+json", "X-GitHub-Api-Version":"2022-11-28"} });
  must(response.ok, "GitHub restricted resource read failed (HTTP "+response.status+")");
  return response.json();
}
async function verifyApproval({event,repo,mainSha,packageVersion,repoToken,governanceToken,http=fetch,now=new Date()}) {
  must(repo === "Kucell/cortex-agent", "wrong repository");
  must(event.action === "created" && event.issue && event.issue.pull_request &&
    event.sender && event.sender.login === "Kucell" &&
    event.comment && event.comment.user && event.comment.user.login === "Kucell" &&
    event.comment.author_association === "OWNER", "GitHub repository owner on PR required");
  const command = parseCommand(event.comment.body);
  must(command.version === packageVersion, "version differs from committed package");
  const api = "https://api.github.com/repos/Kucell/cortex-agent";
  const pr = await getJson(api+"/pulls/"+event.issue.number, repoToken, http);
  must(pr.merged === true && pr.base && pr.base.ref === "main", "release PR must be merged to main");
  must(pr.merge_commit_sha === mainSha, "release PR merge digest differs from current HEAD");
  const branch = await getJson(api+"/git/ref/heads/main",repoToken,http);
  must(branch.object && branch.object.sha === mainSha,"main moved; new approval needed");
  const files = await getJson(api+"/pulls/"+event.issue.number+"/files?per_page=100",repoToken,http);
  must(Array.isArray(files) && files.length > 0 && files.length < 100 &&
    files.every(f=>ALLOWED.has(f.filename)), "release prep PR contains unreviewed path");
  const reviews = await getJson(api+"/pulls/"+event.issue.number+"/reviews?per_page=100",repoToken,http);
  must(hasIndependentApproval(pr,reviews),"independent APPROVED review bound to exact PR head required");
  must(governanceToken, "private governance read-only token absent");
  const base = "https://api.github.com/repos/Kucell/cortex-agent-agent/contents";
  function decode(data) {
    must(data && data.encoding === "base64" && data.content, "invalid private governance response");
    return JSON.parse(Buffer.from(data.content,"base64").toString("utf8"));
  }
  const decision = decode(await getJson(base+"/decisions/"+command.decision+".json?ref=main",governanceToken,http));
  const waitpoint = decode(await getJson(base+"/waitpoints/"+command.waitpoint+".json?ref=main",governanceToken,http));
  must(decision.decision_id === command.decision && waitpoint.waitpoint_id === command.waitpoint,"governance ID mismatch");
  validateGovernance(decision,waitpoint,mainSha,now);
  return {version:command.version,sha:mainSha,pr:pr.number};
}
async function main() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,"utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname,"..","..","package.json"),"utf8"));
  const result = await verifyApproval({event,repo:process.env.GITHUB_REPOSITORY,mainSha:process.env.GITHUB_SHA,
    packageVersion:pkg.version,repoToken:process.env.GITHUB_TOKEN,
    governanceToken:process.env.CORTEX_GOVERNANCE_READ_TOKEN});
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,"target="+result.version+"\n");
  console.log("Governed release gate verified exact HEAD "+result.sha+" from merged PR #"+result.pr);
}
if (require.main === module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports = {parseCommand,hasIndependentApproval,validateGovernance,verifyApproval};
