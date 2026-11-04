const assert = require('node:assert/strict');
const test = require('node:test');
const {restoreArgs} = require('./restore-command-grammar.cjs');

function display(version, ref) {
  return `python3 tools/prepare-webui-restore.py ${ref} --repo . --worktree-path ../webui-restore-${version} --branch restore/webui-${version}`;
}

test('版タグと完全なcommit SHAのコマンドだけを安全な引数として返す', () => {
  for (const ref of ['webui-apps-v2026.11.04.5', 'a'.repeat(40)]) {
    const version = '2026.11.04.5';
    assert.deepEqual(restoreArgs(display(version, ref), {version, ref}),
      ['python3', 'tools/prepare-webui-restore.py', ref, '--repo', '.', '--worktree-path',
        '../webui-restore-2026.11.04.5', '--branch', 'restore/webui-2026.11.04.5']);
  }
});

test('変更されたコマンド、危険なパス、不正な参照を拒否する', () => {
  const record = {version: '2026.11.04.5', ref: 'webui-apps-v2026.11.04.5'};
  const valid = display(record.version, record.ref);
  for (const text of [valid + '; echo injected', valid + '\n', valid.replace(' --repo', '  --repo'),
    valid.replace('--repo .', '--repo ../elsewhere'), '', null]) {
    assert.throws(() => restoreArgs(text, record));
  }
  for (const version of ['', '../x', '-x', 'x/y', 'a'.repeat(65), '日本語']) {
    assert.throws(() => restoreArgs(display(version, record.ref), {version, ref: record.ref}));
  }
  for (const ref of ['', 'A'.repeat(40), 'a'.repeat(39), 'webui-apps-v2026.11.04.5;id', '../tag']) {
    assert.throws(() => restoreArgs(display(record.version, ref), {version: record.version, ref}));
  }
  assert.throws(() => restoreArgs(valid, null));
});
