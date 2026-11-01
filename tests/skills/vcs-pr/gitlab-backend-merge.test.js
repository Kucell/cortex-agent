/**
 * tests/skills/vcs-pr/gitlab-backend-merge.test.js
 *
 * Unit tests for the gitlab backend merge() function.
 *
 * Background: the backend used to send `merge_commit_message: commit_message
 * || ""`.  A blank value is not the same as an absent field — GitLab
 * answers the whole PUT /merge with HTTP 422 "Branch cannot be merged" when
 * the field is present but empty (observed on the squash path, where the
 * commit message is derived from the MR title).  The backend must therefore
 * omit the field when the caller supplied no message.
 *
 * Test strategy: monkey-patch https.request (which `send` uses) and capture
 * the serialized request body so the payload shape can be asserted directly.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { resolveTemplatePath } = require('../../helpers/template-layers');
const gitlab = require(resolveTemplatePath('skills/vcs-pr/scripts/backends/gitlab.js', 'en'));

// ─── HTTP mock helper ────────────────────────────────────────────────────────

let originalHttpsRequest = null;
let originalHttpRequest = null;
let captured = [];

function installHttpsMock() {
  originalHttpsRequest = https.request;
  originalHttpRequest = http.request;
  captured = [];
  https.request = function mockHttpsRequest(_opts, cb) {
    const req = new EventEmitter();
    req.write = (chunk) => { captured.push(String(chunk)); };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      cb(res);
      process.nextTick(() => {
        res.emit('data', Buffer.from(JSON.stringify({ merged: true }), 'utf8'));
        res.emit('end');
      });
    };
    return req;
  };
}

function restoreHttpsMock() {
  if (originalHttpsRequest) https.request = originalHttpsRequest;
  if (originalHttpRequest) http.request = originalHttpRequest;
  captured = [];
}

function lastPayload() {
  assert.ok(captured.length > 0, 'expected a request body to be sent');
  return JSON.parse(captured[captured.length - 1]);
}

const baseConfig = { host: 'https://gitlab.example.com', default: { org: 'Kucell', repo: 'cortex-agent' } };
const baseToken = 'glpat-test-token';

// ─── Tests ───────────────────────────────────────────────────────────────────

test.beforeEach(() => { installHttpsMock(); });
test.afterEach(() => { restoreHttpsMock(); });

test('merge: empty commit_message omits merge_commit_message from the payload', async () => {
  await gitlab.merge({ config: baseConfig, token: baseToken, pr_number: 7, commit_message: '' });
  const payload = lastPayload();
  assert.equal('merge_commit_message' in payload, false);
  assert.equal(payload.squash, false);
  assert.equal(payload.should_remove_source_branch, true);
});

test('merge: absent commit_message omits merge_commit_message from the payload', async () => {
  await gitlab.merge({ config: baseConfig, token: baseToken, pr_number: 7 });
  assert.equal('merge_commit_message' in lastPayload(), false);
});

test('merge: a supplied commit_message is forwarded unchanged', async () => {
  await gitlab.merge({
    config: baseConfig, token: baseToken, pr_number: 7,
    commit_message: 'feat(coordination): add permit CLI entry (#136)',
  });
  const payload = lastPayload();
  assert.equal(payload.merge_commit_message, 'feat(coordination): add permit CLI entry (#136)');
});

test('merge: squash path still omits an empty merge_commit_message', async () => {
  await gitlab.merge({ config: baseConfig, token: baseToken, pr_number: 7, commit_message: '', squash: true });
  const payload = lastPayload();
  assert.equal('merge_commit_message' in payload, false);
  assert.equal(payload.squash, true);
});

test('merge: sha is forwarded when supplied and omitted otherwise', async () => {
  await gitlab.merge({ config: baseConfig, token: baseToken, pr_number: 7, sha: 'abc123' });
  assert.equal(lastPayload().sha, 'abc123');

  await gitlab.merge({ config: baseConfig, token: baseToken, pr_number: 7 });
  assert.equal('sha' in lastPayload(), false);
});

test('merge: HTTP failure surfaces as gitlab_merge_failed error', async () => {
  https.request = function failingRequest(_opts, cb) {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 422;
      res.headers = {};
      cb(res);
      process.nextTick(() => {
        res.emit('data', Buffer.from(JSON.stringify({ message: 'Branch cannot be merged' }), 'utf8'));
        res.emit('end');
      });
    };
    return req;
  };
  await assert.rejects(
    gitlab.merge({ config: baseConfig, token: baseToken, pr_number: 7, commit_message: '' }),
    /gitlab_merge_failed: HTTP 422/,
  );
});
