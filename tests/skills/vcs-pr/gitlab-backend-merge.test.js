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
const baseCred = 'glpat-test-token';

// ─── Tests ───────────────────────────────────────────────────────────────────

test.beforeEach(() => { installHttpsMock(); });
test.afterEach(() => { restoreHttpsMock(); });

test('merge: empty commit_message omits merge_commit_message from the payload', async () => {
  await gitlab.merge({ config: baseConfig, token: baseCred, pr_number: 7, commit_message: '' });
  const payload = lastPayload();
  assert.equal('merge_commit_message' in payload, false);
  assert.equal(payload.squash, false);
  assert.equal(payload.should_remove_source_branch, true);
});

test('merge: absent commit_message omits merge_commit_message from the payload', async () => {
  await gitlab.merge({ config: baseConfig, token: baseCred, pr_number: 7 });
  assert.equal('merge_commit_message' in lastPayload(), false);
});

test('merge: a supplied commit_message is forwarded unchanged', async () => {
  await gitlab.merge({
    config: baseConfig, token: baseCred, pr_number: 7,
    commit_message: 'feat(coordination): add permit CLI entry (#136)',
  });
  const payload = lastPayload();
  assert.equal(payload.merge_commit_message, 'feat(coordination): add permit CLI entry (#136)');
});

test('merge: squash path still omits an empty merge_commit_message', async () => {
  await gitlab.merge({ config: baseConfig, token: baseCred, pr_number: 7, commit_message: '', squash: true });
  const payload = lastPayload();
  assert.equal('merge_commit_message' in payload, false);
  assert.equal(payload.squash, true);
});

test('merge: sha is forwarded when supplied and omitted otherwise', async () => {
  await gitlab.merge({ config: baseConfig, token: baseCred, pr_number: 7, sha: 'abc123' });
  assert.equal(lastPayload().sha, 'abc123');

  await gitlab.merge({ config: baseConfig, token: baseCred, pr_number: 7 });
  assert.equal('sha' in lastPayload(), false);
});

test('merge: HTTP failure surfaces as gitlab_merge_failed error', async () => {
  https.request = function routedRequest(opts, cb) {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      const isIdentityCheck = String(opts.path).endsWith('/api/v4/user');
      res.statusCode = isIdentityCheck ? 200 : 422;
      res.headers = {};
      cb(res);
      process.nextTick(() => {
        res.emit('data', Buffer.from(JSON.stringify(
          isIdentityCheck ? { id: 1, username: 'alice', bot: false } : { message: 'Branch cannot be merged' },
        ), 'utf8'));
        res.emit('end');
      });
    };
    return req;
  };
  await assert.rejects(
    gitlab.merge({ config: baseConfig, token: baseCred, pr_number: 7, commit_message: '' }),
    /gitlab_merge_failed: HTTP 422/,
  );
});

test('merge: a bot token is refused before any merge request is sent', async () => {
  const seen = [];
  https.request = function routedRequest(opts, cb) {
    seen.push(`${opts.method} ${opts.path}`);
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      cb(res);
      process.nextTick(() => {
        res.emit('data', Buffer.from(JSON.stringify({ id: 2, username: 'project_1_bot_cicd', bot: true }), 'utf8'));
        res.emit('end');
      });
    };
    return req;
  };
  await assert.rejects(
    () => gitlab.merge({ config: baseConfig, token: 'bot-token', pr_number: 524 }),
    (error) => {
      assert.match(error.message, /gitlab_merge_bot_token_forbidden/);
      assert.match(error.message, /project_1_bot_cicd/);
      assert.match(error.message, /§9\.1\/§9\.3/);
      assert.match(error.message, /\/Kucell\/cortex-agent\/-\/merge_requests\/524/);
      return true;
    },
  );
  assert.deepEqual(seen, ['GET /api/v4/user'], 'the merge PUT must never be issued for a bot token');
});

test('merge: reports merged_by from the identity check', async () => {
  const original = https.request;
  https.request = function routedRequest(opts, cb) {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      cb(res);
      process.nextTick(() => {
        res.emit('data', Buffer.from(JSON.stringify(
          String(opts.path).endsWith('/api/v4/user') ? { username: 'alice' } : { merged: true },
        ), 'utf8'));
        res.emit('end');
      });
    };
    return req;
  };
  try {
    const result = await gitlab.merge({ config: baseConfig, token: baseCred, pr_number: 9 });
    assert.equal(result.merged, true);
    assert.equal(result.merged_by, 'alice');
  } finally {
    https.request = original;
  }
});
