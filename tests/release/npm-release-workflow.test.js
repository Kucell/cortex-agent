"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/npm-release.yml"), "utf8");
const docs = fs.readFileSync(path.join(root, "docs/releasing.md"), "utf8");

test("npm release publishes only from a governed owner dispatch", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /issue_comment:/);
  assert.doesNotMatch(workflow, /CORTEX_AUTO_RELEASE_ENABLED/);
  assert.match(workflow, /verify-approved-release\.cjs/);
  assert.match(workflow, /verify-owner-dispatch\.cjs/);
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

test("npm release workflow requires the governed release inputs and keeps read-only dry run default", () => {
  assert.ok(workflow.includes("workflow_dispatch:"));
  assert.ok(workflow.includes("publish:"));
  assert.ok(workflow.includes("default: false"));
  for (const required of ["release_pr:", "expected_sha:", "decision_id:", "waitpoint_id:", "release_type:", "dist_tag:"]) {
    assert.ok(workflow.includes(required), "missing governed input " + required);
  }
  assert.ok(workflow.includes("RELEASE_TYPE: current"));
  assert.ok(workflow.includes("DIST_TAG: latest"));
  assert.ok(workflow.includes("if: ${{ !inputs.publish }}"));
  assert.ok(workflow.includes("if: ${{ inputs.publish }}"));
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

test("release documentation names the dispatched trigger and drops the comment command", () => {
  assert.ok(docs.includes("gh workflow run npm-release.yml"));
  assert.ok(docs.includes("decision_id=D-release-..."));
  assert.ok(docs.includes("waitpoint_id=WP-release-..."));
  assert.ok(!docs.includes("/cortex-release publish"));
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


test("publication and preflight isolate the nine real CLI regressions before release", () => {
  const preflight = fs.readFileSync(path.join(root, ".github/workflows/npm-release-preflight.yml"), "utf8");
  const runner = fs.readFileSync(path.join(root, "scripts/release/targeted-cli-validation.py"), "utf8");
  const oldCommand = "node --test tests/commands/reconcile.test.js tests/cli/reconcile-entrypoint.test.js tests/cli/cli-contract.test.js";
  for (const source of [workflow, preflight]) {
    const validation = source.split("  targeted-cli-validation:\n")[1]?.split(/\n  [a-z][a-z-]*:\n/)[0];
    assert.ok(validation, "isolated CLI validation job missing");
    assert.match(validation, /permissions:\s*\n\s*contents: read/);
    assert.match(validation, /submodules: false/);
    assert.match(validation, /persist-credentials: false/);
    assert.match(validation, /Verify shipped reconcile CLI entrypoint in isolated environment/);
    assert.match(validation, /\/usr\/bin\/env -i PATH=\/usr\/bin:\/bin \/usr\/bin\/python3 -I/);
    assert.match(validation, /scripts\/release\/targeted-cli-validation\.py/);
    assert.match(validation, /--expected-head "\$SOURCE_HEAD" --node "\$node_bin"/);
    assert.doesNotMatch(validation, /secrets\.|id-token: write|npm install|pnpm install/);
    assert.ok(!source.includes(oldCommand), "unsafe inherited-environment CLI entrypoint remains");
    assert.ok(source.indexOf("Verify shipped reconcile CLI entrypoint") < source.indexOf("npm pack --dry-run"));
  }
  assert.match(workflow, /\n  release:\n    needs: \[targeted-cli-validation\]/);
  assert.match(preflight, /\n  verify:\n    needs: \[targeted-cli-validation\]/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(preflight, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  for (const testPath of ["tests/commands/reconcile.test.js", "tests/cli/reconcile-entrypoint.test.js", "tests/cli/cli-contract.test.js"]) {
    assert.ok(runner.includes('"' + testPath + '":'), "reviewed CLI test missing: " + testPath);
  }
  assert.match(runner, /EXPECTED_TESTS = 9/);
  assert.match(runner, /start_new_session=True/);
  assert.match(runner, /"PATH": ""/);
  assert.match(runner, /"governance checkout must be absent or an empty non-link directory"/);
});

test("owner dispatch runs the owner identity and the canonical governance check at all three effect boundaries", () => {
  const checkSteps = [
    "Verify exact-head Cortex release authorization",
    "Revalidate Cortex authorization before Git tag write",
    "Revalidate Cortex authorization at npm effect boundary"
  ];
  const checkedGate = "if: ${{ inputs.publish }}";
  for (const name of checkSteps) {
    const stepStart=workflow.indexOf("- name: "+name);
    assert.ok(stepStart>0, "missing gate "+name);
    const nextStep=workflow.indexOf("\n      - ",stepStart+10);
    const block=workflow.slice(stepStart,nextStep<0?undefined:nextStep);
    assert.ok(block.includes(checkedGate), "unprotected gate "+name);
    assert.ok(block.includes("node scripts/release/verify-owner-dispatch.cjs"), "owner gate missing "+name);
    assert.ok(block.includes("node scripts/release/verify-approved-release.cjs"), "canonical gate missing "+name);
    assert.ok(
      block.includes("CORTEX_GOVERNANCE_READ_TOKEN: ${{ secrets.CORTEX_GOVERNANCE_READ_TOKEN }}"),
      "private governance credential missing "+name
    );
  }
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /npm-owner-dispatch-audit\.json/);
});

test("workflow dispatch inputs satisfy the canonical governance gate contract", () => {
  const { resolveReleaseTrigger } = require("../../scripts/release/verify-approved-release.cjs");
  const declared = workflow
    .slice(workflow.indexOf("  workflow_dispatch:"), workflow.indexOf("permissions:"))
    .split("\n")
    .map(line => /^ {6}([a-z_]+):$/.exec(line))
    .filter(Boolean)
    .map(match => match[1]);
  assert.deepEqual(declared.sort(), [
    "decision_id", "dist_tag", "expected_sha", "publish", "release_pr", "release_type", "waitpoint_id"
  ]);

  const sha = "b".repeat(40);
  const inputs = {
    publish: "true",
    release_type: "current",
    dist_tag: "latest",
    release_pr: "113",
    expected_sha: sha,
    decision_id: "D-release-1",
    waitpoint_id: "WP-release-1"
  };
  const event = { sender: { login: "Kucell" }, repository: { full_name: "Kucell/cortex-agent" }, inputs };
  const command = resolveReleaseTrigger(event, "workflow_dispatch", "Kucell", sha, "1.15.6");
  assert.equal(command.decision, "D-release-1");
  assert.equal(command.waitpoint, "WP-release-1");
  assert.equal(command.prNumber, 113);

  for (const key of Object.keys(inputs)) {
    const missing = { ...inputs };
    delete missing[key];
    const incomplete = { sender: { login: "Kucell" }, repository: { full_name: "Kucell/cortex-agent" }, inputs: missing };
    assert.throws(
      () => resolveReleaseTrigger(incomplete, "workflow_dispatch", "Kucell", sha, "1.15.6"),
      /RELEASE_GATE_BLOCKED/,
      "omitting " + key + " must fail closed"
    );
  }
});

const { verifyOwnerDispatch } = require("../../scripts/release/verify-owner-dispatch.cjs");
const sampleEvent = {
  sender: {login:"Kucell"},
  repository: {full_name:"Kucell/cortex-agent"},
  inputs: {publish:"true"}
};
const sourceSha = "a".repeat(40);
const dispatchOptions = () => ({
  event:sampleEvent, eventName:"workflow_dispatch",actor:"Kucell",triggeringActor:"Kucell",
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
    {triggeringActor:"other-collaborator"},
    {triggeringActor:null},
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
test("owner dispatch has no silent schedule, push or comment publishing trigger",()=>{
  assert.doesNotMatch(workflow,/^\s*schedule:/m);
  assert.doesNotMatch(workflow,/^\s*push:/m);
  assert.doesNotMatch(workflow,/^\s*issue_comment:/m);
  assert.match(workflow,/npm-owner-dispatch-audit.json/);
});
