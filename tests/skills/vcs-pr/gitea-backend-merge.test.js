/**
 * tests/skills/vcs-pr/gitea-backend-merge.test.js
 *
 * Unit tests for the gitea backend merge() function: an empty merge message
 * must be omitted from the payload, and the merge strategy must be
 * selectable instead of always being a merge commit.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { resolveTemplatePath } = require('../../helpers/template-layers');
const gitea = require(resolveTemplatePath('skills/vcs-pr/scripts/backends/gitea.js', 'en'));

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

const baseConfig = { host: 'https://gitea.example.com', default: { org: 'Kucell', repo: 'cortex-agent' } };
const baseToken = 'gitea-test-token';

test.beforeEach(() => { installHttpsMock(); });
test.afterEach(() => { restoreHttpsMock(); });

test('merge: empty commit_message omits Merge_Message from the payload', async () => {
  await gitea.merge({ config: baseConfig, token: baseToken, pr_number: 7, commit_message: '' });
  assert.equal('Merge_Message' in lastPayload(), false);
});

test('merge: a supplied commit_message is forwarded unchanged', async () => {
  await gitea.merge({ config: baseConfig, token: baseToken, pr_number: 7, commit_message: 'fix(vcs-pr): omit blank merge message' });
  assert.equal(lastPayload().Merge_Message, 'fix(vcs-pr): omit blank merge message');
});

test('merge: merge strategy defaults to merge and honours an explicit squash', async () => {
  await gitea.merge({ config: baseConfig, token: baseToken, pr_number: 7 });
  assert.equal(lastPayload().Do, 'merge');

  await gitea.merge({ config: baseConfig, token: baseToken, pr_number: 7, merge_method: 'squash' });
  assert.equal(lastPayload().Do, 'squash');
});
