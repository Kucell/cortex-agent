"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/npm-release.yml"), "utf8");
const docs = fs.readFileSync(path.join(root, "docs/releasing.md"), "utf8");

test("npm release stays manual-compatible and adds opt-in governed comment trigger", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /issue_comment:/);
  assert.match(workflow, /CORTEX_AUTO_RELEASE_ENABLED/);
  assert.match(workflow, /verify-approved-release\.cjs/);
  assert.doesNotMatch(workflow, /\npush:\s*\n/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
});

test("npm release workflow never relies on a long-lived npm publish token", () => {
  assert.doesNotMatch(workflow, /NPM_TOKEN/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
  assert.match(workflow, /npm publish --access public --tag/);
  assert.match(workflow, /npm install --global npm@11/);
  assert.match(workflow, /npm >= 11\.5\.1 required/);
});

test("npm release workflow validates before any release write", () => {
  const guard = workflow.indexOf("Run architecture guard");
  const focused = workflow.indexOf("Run focused product validation");
  const pack = workflow.indexOf("Verify package can be packed");
  const push = workflow.indexOf("Commit version and create tag");
  const publish = workflow.indexOf("Publish to npm with Trusted Publishing");

  assert.ok(guard >= 0);
  assert.ok(focused > guard);
  assert.ok(pack > focused);
  assert.ok(push > pack);
  assert.ok(publish > push);
});

test("npm release workflow exposes just one publish checkbox and keeps read-only dry run default", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /publish:\s*\n\s*description:/);
  assert.match(workflow, /default:\s*false/);
  for (const hidden of ["release_pr:", "expected_sha:", "decision_id:", "waitpoint_id:", "release_type:", "dist_tag:"]) {
    assert.ok(!workflow.includes(hidden), "unnecessary human input " + hidden);
  }
  assert.match(workflow, /RELEASE_TYPE: current/);
  assert.match(workflow, /DIST_TAG: latest/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && !inputs\.publish/);
  assert.match(workflow, /github\.event_name == 'issue_comment' \\|\\| inputs\.publish/);
});


test("npm release workflow is retry-safe for published versions and GitHub releases", () => {
  assert.match(workflow, /is already published; treating npm publish as completed/);
  assert.match(workflow, /gh release view/);
  assert.match(workflow, /git push origin HEAD:main/);
  assert.doesNotMatch(workflow, /git push .*--force/);
});

test("release documentation names the exact npm Trusted Publisher workflow", () => {
  assert.match(docs, /Workflow filename: `npm-release\.yml`/);
  assert.match(docs, /Organization or user: `Kucell`/);
  assert.match(docs, /Repository: `cortex-agent`/);
  assert.match(docs, /release_type=current/);
  assert.match(docs, /Never force-push `main`/);
});

test("automatic read-only preflight cannot trigger npm publication", () => {
  const preflight = fs.readFileSync(path.join(root, ".github/workflows/npm-release-preflight.yml"), "utf8");
  assert.match(preflight, /push:/);
  assert.match(preflight, /permissions:\s*\n\s*contents: read/);
  assert.match(preflight, /verify-approved-release\.test\.js/);
  assert.doesNotMatch(preflight, /npm publish|gh release create|git push|id-token:\s*write/);
});

test("release publication rechecks current main and live approval at the effect boundary", () => {
  const tag = workflow.indexOf("Commit version and create tag");
  const immutability = workflow.indexOf("Verify main/tag immutability before any registry write");
  const secondGate = workflow.indexOf("Revalidate Cortex authorization at npm effect boundary");
  const publishing = workflow.indexOf("Publish to npm with Trusted Publishing");
  assert.ok(tag >= 0 && immutability > tag && secondGate > immutability && publishing > secondGate);
  assert.match(workflow, /git ls-remote origin refs\/heads\/main/);
  assert.match(workflow, /refusing npm publish/);
});


test("v1.15.4 publication and preflight run real reconcile CLI subprocess regressions", () => {
  const preflight = fs.readFileSync(path.join(root, ".github/workflows/npm-release-preflight.yml"), "utf8");
  const command = "node --test tests/commands/reconcile.test.js tests/cli/reconcile-entrypoint.test.js tests/cli/cli-contract.test.js";
  for (const source of [workflow, preflight]) {
    assert.match(source, /Verify shipped reconcile CLI entrypoint/);
    assert.ok(source.includes(command));
    assert.match(source, /v1\.15\.4 requires the real reconcile CLI regression tests/);
    assert.ok(source.indexOf("Verify shipped reconcile CLI entrypoint") < source.indexOf("npm pack --dry-run"));
  }
});

test("one-click owner manual dispatch and automatic comment path both have three strict auth checks", () => {
  const checkSteps = [
    "Verify exact-head Cortex release authorization",
    "Revalidate Cortex authorization before Git tag write",
    "Revalidate Cortex authorization at npm effect boundary"
  ];
  const checkedGate = "if: ${{ github.event_name == 'issue_comment' || inputs.publish }}";
  for (const name of checkSteps) {
    const stepStart=workflow.indexOf("- name: "+name);
    assert.ok(stepStart>0, "missing gate "+name);
    const nextStep=workflow.indexOf("\n      - ",stepStart+10);
    const block=workflow.slice(stepStart,nextStep<0?undefined:nextStep);
    assert.ok(block.includes(checkedGate), "unprotected gate "+name);
    assert.ok(block.includes("node scripts/release/verify-owner-dispatch.cjs"), "owner gate missing "+name);
    assert.ok(block.includes("node scripts/release/verify-approved-release.cjs"), "canonical gate missing "+name);
  }
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /GITHUB_EVENT_NAME/);
  assert.match(workflow, /npm-owner-dispatch-audit\.json/);
});

const { verifyOwnerDispatch } = require("../../scripts/release/verify-owner-dispatch.cjs");
const sampleEvent = {
  sender: {login:"Kucell"},
  repository: {full_name:"Kucell/cortex-agent"},
  inputs: {publish:"true"}
};
const sourceSha = "a".repeat(40);
const dispatchOptions = () => ({
  event:sampleEvent, eventName:"workflow_dispatch",actor:"Kucell",
  ref:"refs/heads/main",repo:"Kucell/cortex-agent",
  sha:sourceSha, packageName:"cortex-agent",version:"1.15.4",
  token:"DUMMY_TEST_GITHUB_TOKEN",runId:"38000000001",
  http:async()=>({ok:true,async json(){return {object:{sha:sourceSha}};}})
});
test("explicit owner dispatch authorizes only the exact prepared main candidate",async()=>{
  const receipt=await verifyOwnerDispatch(dispatchOptions());
  assert.equal(receipt.authorization_mode,"github-owner-workflow-dispatch");
  assert.equal(receipt.candidate_sha,sourceSha);
  assert.equal(receipt.version,"1.15.4");
  assert.equal(receipt.run_id,"38000000001");
  assert.equal(receipt.authorized,true);
  assert.doesNotMatch(JSON.stringify(receipt),/DUMMY_TEST_GITHUB_TOKEN/);
});
test("owner dispatch authorization blocks nonowner, other repo/ref and unchecked checkbox",async()=>{
  const base=dispatchOptions();
  for(const changes of [
    {actor:"attacker"},
    {event:{...sampleEvent,sender:{login:"attacker"}}},
    {ref:"refs/heads/release"},
    {repo:"Kucell/attacker-repo"},
    {eventName:"issue_comment"},
    {event:{...sampleEvent,inputs:{publish:"false"}}},
    {event:{...sampleEvent,inputs:{}}},
    {version:"1.15.4; rm -rf /"},
    {packageName:"wrong-package"},
    {runId:""},
  ]){
    await assert.rejects(()=>verifyOwnerDispatch({...base,...changes}),/OWNER_DISPATCH_RELEASE_BLOCKED/);
  }
});
test("owner dispatch refuses missing token, denied GitHub, network errors, and main drift",async()=>{
  const base=dispatchOptions();
  for(const changes of [
    {token:null},
    {http:async()=>({ok:false,status:403})},
    {http:async()=>({ok:true,async json(){return {object:{sha:"b".repeat(40)}};}})},
    {http:async()=>{throw Error("FAKE_TEST_SECRET");}},
  ]){
    await assert.rejects(()=>verifyOwnerDispatch({...base,...changes}),/OWNER_DISPATCH_RELEASE_BLOCKED/);
  }
});
test("one-click has no silent schedule or push publishing trigger",()=>{
  assert.doesNotMatch(workflow,/^\s*schedule:/m);
  assert.doesNotMatch(workflow,/^\s*push:/m);
  assert.match(workflow,/github.actor == github.repository_owner/);
  assert.match(workflow,/npm-owner-dispatch-audit.json/);
});
