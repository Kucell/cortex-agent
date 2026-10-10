"use strict";
// GitHub-native single-maintainer release authorization.
// Running a protected workflow_dispatch as the repository owner is the explicit
// human action. This is deliberately NOT a synthetic Cortex Decision/Waitpoint.
const fs = require("node:fs");
const path = require("node:path");

function block(reason) { throw new Error("OWNER_DISPATCH_RELEASE_BLOCKED: " + reason); }
function need(condition, reason) { if (!condition) block(reason); }

async function verifyOwnerDispatch({
  event, eventName, actor, ref, repo, sha, packageName, version,
  token, runId, http=fetch
}) {
  need(eventName === "workflow_dispatch", "manual workflow_dispatch only");
  need(repo === "Kucell/cortex-agent", "repository mismatch");
  need(ref === "refs/heads/main", "only main may publish");
  need(actor === "Kucell" && event?.sender?.login === actor,
    "interactive repository owner dispatch required");
  need(event?.repository?.full_name === repo,
    "dispatch repository mismatch");
  need(event?.inputs?.publish === true || event?.inputs?.publish === "true",
    "explicit checked publish confirmation required");
  need(packageName === "cortex-agent" &&
    typeof version === "string" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version),
    "prepared package name/version invalid");
  need(typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha),
    "invalid source commit SHA");
  need(typeof runId === "string" && /^[1-9][0-9]*$/.test(runId),
    "GitHub Actions run ID missing");
  need(typeof token === "string" && token.length > 0,
    "GitHub Actions credentials missing");
  let response;
  try {
    response = await http(
      "https://api.github.com/repos/Kucell/cortex-agent/git/ref/heads/main", {
        redirect: "error",
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        signal: AbortSignal.timeout(10000)
      });
  } catch (_) {
    block("current main could not be verified");
  }
  need(response?.ok === true, "GitHub main read denied");
  let remote;
  try { remote = await response.json(); }
  catch (_) { block("GitHub main response invalid"); }
  need(remote?.object?.sha === sha, "main moved; reauthorize exact candidate");
  return {
    authorization_mode: "github-owner-workflow-dispatch",
    repository: repo,
    actor,
    ref,
    candidate_sha: sha,
    package: packageName,
    version,
    run_id: runId,
    // The actual GitHub Actions event/run is the human approval audit trail.
    // This does not impersonate a canonical Decision/Waitpoint or a second reviewer.
    authorized: true
  };
}
async function main() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
  const result = await verifyOwnerDispatch({
    event, eventName:process.env.GITHUB_EVENT_NAME,
    actor:process.env.GITHUB_ACTOR, ref:process.env.GITHUB_REF,
    repo:process.env.GITHUB_REPOSITORY, sha:process.env.GITHUB_SHA,
    packageName:pkg.name, version:pkg.version, token:process.env.GITHUB_TOKEN,
    runId:process.env.GITHUB_RUN_ID
  });
  fs.writeFileSync("npm-owner-dispatch-audit.json",
    JSON.stringify(result, null, 2) + "\n", {flag:"w", mode:0o600});
  console.log("Owner dispatch authorized " + result.package + "@" +
    result.version + " on exact main " + result.candidate_sha +
    " (GitHub Actions run " + result.run_id + ")");
}
if(require.main === module) main().catch(e=>{
  console.error(String(e?.message || "").startsWith("OWNER_DISPATCH_RELEASE_BLOCKED:") ?
    e.message : "OWNER_DISPATCH_RELEASE_BLOCKED: unexpected error");
  process.exitCode=1;
});
module.exports = {verifyOwnerDispatch};
