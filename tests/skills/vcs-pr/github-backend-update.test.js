/**
 * tests/skills/vcs-pr/github-backend-update.test.js
 *
 * Unit tests for the github backend updatePR() function.
 * Source: the English template surface (language overlay over shared).
 *
 * GitHub's update path is REST-narrow, so these tests pin the consequences
 * rather than the implementation: PATCH carries title / body / state only,
 * reviewers are appended through `requested_reviewers` (logins, no id lookup),
 * `ready` on a real draft goes through the GraphQL mark-ready mutation, and the
 * merge-time knobs (`remove_source`, `squash`) are reported as ignored instead
 * of being silently dropped.  A title edit must never promote a draft, because
 * on GitHub draft-ness is a field, not a title prefix.
 *
 * Strategy: monkey-patch https.request (which `send` uses) to route to scripted
 * responses, recording every outbound request for assertions.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { resolveTemplatePath } = require('../../helpers/template-layers');
const github = require(resolveTemplatePath('skills/vcs-pr/scripts/backends/github.js', 'en'));

// ─── HTTP mock helper ────────────────────────────────────────────────────────

let originalHttpsRequest = null;
let originalHttpRequest = null;
let script = [];
let requests = [];

function installHttpsMock() {
  originalHttpsRequest = https.request;
  originalHttpRequest = http.request;
  https.request = function mockHttpsRequest(opts, cb) {
    const record = { method: opts.method, path: opts.path };
    requests.push(record);
    const req = new EventEmitter();
    req.write = (chunk) => {
      record.body = JSON.parse(String(chunk));
    };
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
  requests = [];
}

function withScript(scripted, fn) {
  script = scripted.slice();
  return fn();
}

// ─── Test fixtures ───────────────────────────────────────────────────────────

const baseConfig = { host: 'https://api.github.com', default: { org: 'Kucell', repo: 'cortex-agent' } };
const baseCred = 'test-token-not-a-secret';
const pullPath = '/repos/Kucell/cortex-agent/pulls/7';

const openPrResponse = {
  status: 200,
  body: {
    number: 7,
    title: 'feat(login): add flow',
    state: 'open',
    draft: false,
    node_id: 'PR_node_7',
    html_url: 'https://github.com/Kucell/cortex-agent/pull/7',
    labels: [{ name: 'feat' }],
    requested_reviewers: [],
  },
};

const draftPrResponse = {
  status: 200,
  body: { ...openPrResponse.body, draft: true },
};

const readyMutationResponse = {
  status: 200,
  body: {
    data: {
      markPullRequestReadyForReview: { pullRequest: { number: 7, isDraft: false } },
    },
  },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

test.beforeEach(() => {
  installHttpsMock();
});
test.afterEach(() => {
  restoreHttpsMock();
});

test('updatePR: title + body send one PATCH with only those fields', async () => {
  const result = await withScript(
    [{ status: 200, body: { ...openPrResponse.body, title: 'New title' } }],
    () => github.updatePR({
      config: baseConfig, token: baseCred, pr_number: 7,
      title: 'New title', body: 'new body',
    }),
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'PATCH');
  assert.equal(requests[0].path, pullPath);
  assert.deepEqual(requests[0].body, { title: 'New title', body: 'new body' });
  assert.equal(result.number, 7);
  assert.equal(result.title, 'New title');
  assert.deepEqual(result.labels, ['feat']);
});

test('updatePR: close maps to state=closed and returns the closed state', async () => {
  const result = await withScript(
    [{ status: 200, body: { ...openPrResponse.body, state: 'closed' } }],
    () => github.updatePR({ config: baseConfig, token: baseCred, pr_number: 7, close: true }),
  );
  assert.deepEqual(requests[0].body, { state: 'closed' });
  assert.equal(result.state, 'closed');
});

test('updatePR: reviewers are appended via requested_reviewers (no id lookup)', async () => {
  const result = await withScript(
    [{
      status: 201,
      body: { ...openPrResponse.body, requested_reviewers: [{ login: 'alice' }, { login: 'bob' }] },
    }],
    () => github.updatePR({
      config: baseConfig, token: baseCred, pr_number: 7,
      reviewers: ['alice', 'bob'],
    }),
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].path, `${pullPath}/requested_reviewers`);
  assert.deepEqual(requests[0].body, { reviewers: ['alice', 'bob'] });
  assert.deepEqual(result.reviewers, ['alice', 'bob']);
});

test('updatePR: ready on a draft fetches the PR then runs markPullRequestReadyForReview', async () => {
  const result = await withScript(
    [draftPrResponse, readyMutationResponse],
    () => github.updatePR({ config: baseConfig, token: baseCred, pr_number: 7, ready: true }),
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].path, pullPath);
  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].path, '/graphql');
  assert.match(requests[1].body.query, /markPullRequestReadyForReview/);
  assert.deepEqual(requests[1].body.variables, { id: 'PR_node_7' });
  assert.equal(result.draft, false);
});

test('updatePR: ready on a non-draft PR is a no-op (no GraphQL call)', async () => {
  const result = await withScript(
    [openPrResponse],
    () => github.updatePR({ config: baseConfig, token: baseCred, pr_number: 7, ready: true }),
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(result.draft, false);
});

test('updatePR: ready + explicit title PATCHes first, then promotes', async () => {
  const result = await withScript(
    [
      draftPrResponse,
      { status: 200, body: { ...draftPrResponse.body, title: 'New title' } },
      readyMutationResponse,
    ],
    () => github.updatePR({
      config: baseConfig, token: baseCred, pr_number: 7,
      ready: true, title: 'New title',
    }),
  );
  assert.deepEqual(requests.map((r) => r.method), ['GET', 'PATCH', 'POST']);
  assert.deepEqual(requests[1].body, { title: 'New title' });
  assert.equal(requests[2].path, '/graphql');
  assert.equal(result.title, 'New title');
  assert.equal(result.draft, false);
});

test('updatePR: a title edit on a draft does not promote it', async () => {
  const result = await withScript(
    [{ status: 200, body: { ...draftPrResponse.body, title: 'Fix typo' } }],
    () => github.updatePR({ config: baseConfig, token: baseCred, pr_number: 7, title: 'Fix typo' }),
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'PATCH');
  assert.equal(result.draft, true);
});

test('updatePR: remove_source and squash are reported as ignored, not sent', async () => {
  const result = await withScript(
    [openPrResponse],
    () => github.updatePR({
      config: baseConfig, token: baseCred, pr_number: 7,
      remove_source: true, squash: true,
    }),
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].path, pullPath);
  assert.deepEqual(result.ignored, ['remove_source_branch', 'squash']);
});

test('updatePR: PATCH failure surfaces as github_update_failed', async () => {
  await assert.rejects(
    withScript(
      [{ status: 500, body: { message: 'internal error' } }],
      () => github.updatePR({ config: baseConfig, token: baseCred, pr_number: 7, title: 'x' }),
    ),
    /github_update_failed: HTTP 500/,
  );
});

test('updatePR: status fetch failure on ready surfaces github_status_failed', async () => {
  await assert.rejects(
    withScript(
      [{ status: 404, body: { message: 'Not Found' } }],
      () => github.updatePR({ config: baseConfig, token: baseCred, pr_number: 7, ready: true }),
    ),
    /github_status_failed: HTTP 404/,
  );
});

test('updatePR: GraphQL errors surface as github_ready_failed with the API message', async () => {
  await assert.rejects(
    withScript(
      [
        draftPrResponse,
        { status: 200, body: { errors: [{ message: 'Resource not accessible by integration' }] } },
      ],
      () => github.updatePR({ config: baseConfig, token: baseCred, pr_number: 7, ready: true }),
    ),
    /github_ready_failed: Resource not accessible by integration/,
  );
});

test('updatePR: requested_reviewers failure surfaces as github_reviewer_request_failed', async () => {
  await assert.rejects(
    withScript(
      [{ status: 422, body: { message: 'Reviews may only be requested from collaborators' } }],
      () => github.updatePR({ config: baseConfig, token: baseCred, pr_number: 7, reviewers: ['nobody'] }),
    ),
    /github_reviewer_request_failed: HTTP 422/,
  );
});

test('updatePR: a fully empty request still returns the current PR', async () => {
  const result = await withScript(
    [openPrResponse],
    () => github.updatePR({ config: baseConfig, token: baseCred, pr_number: 7 }),
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(result.title, 'feat(login): add flow');
  assert.deepEqual(result.ignored, []);
});
