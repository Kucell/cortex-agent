/**
 * tests/skills/vcs-pr/gitlab-backend-update.test.js
 *
 * M-013 SP-007 / VC-013: Unit tests for gitlab backend updatePR() function.
 * Source: templates/en/.agent/skills/vcs-pr/scripts/backends/gitlab.js
 *
 * Test strategy: monkey-patch https.request (which `send` uses) to route
 * to scripted responses. Each test provides the full scripted queue before
 * calling updatePR.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const gitlab = require('../../../templates/en/.agent/skills/vcs-pr/scripts/backends/gitlab');

// ─── HTTP mock helper ────────────────────────────────────────────────────────

let originalHttpsRequest = null;
let originalHttpRequest = null;
let script = [];

function installHttpsMock() {
  originalHttpsRequest = https.request;
  originalHttpRequest = http.request;
  https.request = function mockHttpsRequest(_opts, cb) {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const next = script.shift();
      if (!next) {
        req.emit('error', new Error('mock_no_scripted_response'));
        return;
      }
      const res = new EventEmitter();
      res.statusCode = next.status || 200;
      res.headers = next.headers || {};
      cb(res);
      process.nextTick(() => {
        const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
        res.emit('data', Buffer.from(body, 'utf8'));
        res.emit('end');
      });
    };
    return req;
  };
}

function restoreHttpsMock() {
  if (originalHttpsRequest) https.request = originalHttpsRequest;
  if (originalHttpRequest) http.request = originalHttpRequest;
  script = [];
}

function withScript(scripted, fn) {
  script = scripted.slice();
  return fn();
}

// ─── Test fixtures ───────────────────────────────────────────────────────────

const baseConfig = { host: 'https://gitlab.example.com', default: { org: 'Kucell', repo: 'cortex-agent' } };
const baseToken = 'glpat-test-token';
const standardPutResponse = {
  iid: 7,
  web_url: 'https://gitlab.example.com/Kucell/cortex-agent/-/merge_requests/7',
  state: 'opened',
  title: 'New title',
  draft: false,
  reviewers: []
};

// ─── Tests ───────────────────────────────────────────────────────────────────

test.beforeEach(() => {
  installHttpsMock();
});
test.afterEach(() => {
  restoreHttpsMock();
});

test('updatePR: title only sends PUT with title payload', async () => {
  const result = await withScript(
    [{ status: 200, body: standardPutResponse }],
    () => gitlab.updatePR({ config: baseConfig, token: baseToken, pr_number: 7, title: 'New title' })
  );
  assert.equal(result.number, 7);
  assert.equal(result.state, 'opened');
  assert.equal(result.title, 'New title');
});

test('updatePR: close flag returns the closed state from API', async () => {
  const result = await withScript(
    [{ status: 200, body: { ...standardPutResponse, state: 'closed' } }],
    () => gitlab.updatePR({ config: baseConfig, token: baseToken, pr_number: 7, close: true })
  );
  assert.equal(result.state, 'closed');
});

test('updatePR: PUT failure surfaces as gitlab_update_failed error', async () => {
  await assert.rejects(
    withScript(
      [{ status: 500, body: { message: 'internal error' } }],
      () => gitlab.updatePR({ config: baseConfig, token: baseToken, pr_number: 7, title: 'x' })
    ),
    /gitlab_update_failed: HTTP 500/,
  );
});

test('updatePR: reviewers list — lookup success populates reviewer_ids and result.reviewers', async () => {
  const result = await withScript(
    [
      { status: 200, body: [{ id: 101, username: 'alice', state: 'active' }] },
      { status: 200, body: [{ id: 102, username: 'bob', state: 'active' }] },
      { status: 200, body: { ...standardPutResponse, reviewers: [{ username: 'alice' }, { username: 'bob' }] } },
    ],
    () => gitlab.updatePR({
      config: baseConfig, token: baseToken, pr_number: 7,
      title: 'Updated', reviewers: ['alice', 'bob']
    })
  );
  assert.equal(result.reviewers.length, 2);
  assert.deepEqual(result.reviewers, ['alice', 'bob']);
});

test('updatePR: reviewer not found throws gitlab_reviewer_not_found', async () => {
  await assert.rejects(
    withScript(
      [{ status: 200, body: [{ id: 101, username: 'someone-else', state: 'active' }] }],
      () => gitlab.updatePR({ config: baseConfig, token: baseToken, pr_number: 7, reviewers: ['alice'] })
    ),
    /gitlab_reviewer_not_found: alice/,
  );
});

test('updatePR: reviewer lookup HTTP failure throws gitlab_reviewer_lookup_failed', async () => {
  await assert.rejects(
    withScript(
      [{ status: 404, body: { message: 'not found' } }],
      () => gitlab.updatePR({ config: baseConfig, token: baseToken, pr_number: 7, reviewers: ['alice'] })
    ),
    /gitlab_reviewer_lookup_failed: alice HTTP 404/,
  );
});

test('updatePR: ready=true without title fetches current MR and strips draft prefix', async () => {
  const result = await withScript(
    [
      { status: 200, body: { iid: 7, title: 'Draft: New login flow', web_url: 'u', state: 'opened', draft: false } },
      { status: 200, body: { ...standardPutResponse, title: 'New login flow' } },
    ],
    () => gitlab.updatePR({ config: baseConfig, token: baseToken, pr_number: 7, ready: true })
  );
  assert.equal(result.title, 'New login flow');
});

test('updatePR: ready=true with explicit title uses the explicit title (no GET)', async () => {
  const result = await withScript(
    [{ status: 200, body: { ...standardPutResponse, title: 'Custom' } }],
    () => gitlab.updatePR({ config: baseConfig, token: baseToken, pr_number: 7, ready: true, title: 'Custom' })
  );
  assert.equal(result.title, 'Custom');
});

test('updatePR: ready=true but GET current MR fails surfaces gitlab_status_failed', async () => {
  await assert.rejects(
    withScript(
      [{ status: 500, body: { message: 'oops' } }],
      () => gitlab.updatePR({ config: baseConfig, token: baseToken, pr_number: 7, ready: true })
    ),
    /gitlab_status_failed: HTTP 500/,
  );
});

test('updatePR: empty reviewers array does not invoke user lookup', async () => {
  const result = await withScript(
    [{ status: 200, body: { ...standardPutResponse, title: 't' } }],
    () => gitlab.updatePR({ config: baseConfig, token: baseToken, pr_number: 7, title: 't', reviewers: [] })
  );
  assert.equal(result.title, 't');
});

test('updatePR: non-array reviewers does not invoke user lookup', async () => {
  const result = await withScript(
    [{ status: 200, body: { ...standardPutResponse, title: 't' } }],
    () => gitlab.updatePR({ config: baseConfig, token: baseToken, pr_number: 7, title: 't', reviewers: 'alice' })
  );
  assert.equal(result.title, 't');
});