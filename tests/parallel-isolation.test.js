const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

for (const locale of ['zh', 'en']) {
  test(`${locale} parallel workflow defines automatic isolation preflight`, () => {
    const workflow = read(`templates/${locale}/.agent/workflows/parallel.md`);
    for (const marker of [
      '--isolation auto|shared|worktree',
      'execution_isolation:',
      'resolved: shared | locked | worktree | serial',
      '/worktree plan <task-ids>',
      '/worktree create',
      '--dry-run',
    ]) {
      assert.ok(workflow.includes(marker), `${locale} parallel workflow is missing ${marker}`);
    }
  });

  test(`${locale} parallel workflow fails closed on overlapping writes`, () => {
    const workflow = read(`templates/${locale}/.agent/workflows/parallel.md`);
    assert.match(workflow, /same file|同一文件/);
    assert.match(workflow, /shared contract|共享契约|公共契约/);
    assert.match(workflow, /serial/);

    const rule = read(`templates/${locale}/.agent/rules/task-decomposition.md`);
    assert.match(rule, /shared.*locked.*worktree.*serial|shared.*locked.*worktree.*serial/s);
    assert.match(rule, /cannot be made parallel|不能通过 worktree 变成可并行任务/);
  });
}
