/**
 * tests/skills/vcs-pr/github-backend-merge.test.js
 *
 * Unit tests for the github backend merge() function.
 *
 * Two defects are covered:
   1. An empty commit message used to be sent as `commit_message: ""`.  The
      field must be omitted so GitHub applies the default message for the
      selected merge method.
   2. The merge strategy was hard-coded to "merge", which made the squash
      path unreachable through this backend.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { resolveTemplatePath } = require('../../helpers/template-layers');
const github = require(resolveTemplatePath('skills/vcs-pr/scripts/backends/github.js', 'en'));

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

const baseConfig = { host: 'https://api.github.com', default: { org: 'Kucell', repo: 'cortex-agent' } };
const baseToken = 'ghp-test-token';

test.beforeEach(() => { installHttpsMock(); });
test.afterEach(() => { restoreHttpsMock(); });

test('merge: empty commit_message omits commit_message from the payload', async () => {
  await github.merge({ config: baseConfig, token: baseToken, pr_number: 7, commit_message: '' });
  assert.equal('commit_message' in lastPayload(), false);
});

test('merge: a supplied commit_message is forwarded unchanged', async () => {
  await github.merge({ config: baseConfig, token: baseToken, pr_number: 7, commit_message: 'fix(vcs-pr): omit blank merge message' });
  assert.equal(lastPayload().commit_message, 'fix(vcs-pr): omit blank merge message');
});

test('merge: merge_method defaults to merge and honours an explicit squash', async () => {
  await github.merge({ config: baseConfig, token: baseToken, pr_number: 7 });
  assert.equal(lastPayload().merge_method, 'merge');

  await github.merge({ config: baseConfig, token: baseToken, pr_number: 7, merge_method: 'squash' });
  assert.equal(lastPayload().merge_method, 'squash');
});
