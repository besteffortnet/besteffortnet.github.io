const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const {pathToFileURL} = require('node:url');

const source = path.resolve(__dirname, '..');
function command(cwd, executable, args, expectSuccess = true) {
  const result = spawnSync(executable, args, {cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024});
  if (expectSuccess && (result.error || result.status !== 0)) throw new Error(result.stderr || String(result.error));
  return result;
}
function git(cwd, ...args) { return command(cwd, 'git', args); }
function commit(cwd, message) {
  git(cwd, 'add', '--all');
  git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', message);
}
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-audit-fixture-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const repo = path.join(temp, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '--quiet');
  fs.writeFileSync(path.join(repo, 'webui-apps.html'), 'first version\n');
  commit(repo, 'first');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'tag', '-a', 'webui-apps-v2026.11.04.1', '-m', 'first');
  fs.writeFileSync(path.join(repo, 'webui-apps.html'), 'second version\n');
  fs.writeFileSync(path.join(repo, 'row-order.js'), '// second\n');
  fs.writeFileSync(path.join(repo, 'observation-times.js'), '// second\n');
  commit(repo, 'second');
  git(repo, 'tag', 'webui-apps-v2026.11.04.2');
  for (const name of ['webui-releases.js', 'tools/prepare-webui-restore.py',
    'tests/audit-displayed-restores.cjs', 'tests/restore-command-grammar.cjs']) {
    const dest = path.join(repo, name);
    fs.mkdirSync(path.dirname(dest), {recursive: true});
    fs.copyFileSync(path.join(source, name), dest);
  }
  const versions = [2, 1].map(n => ({version: `2026.11.04.${n}`, ref: `webui-apps-v2026.11.04.${n}`,
    timestamp: `2026-11-04T00:0${n}:00+09:00`, actor: 'fixture', summary: 'fixture', files: []}));
  fs.writeFileSync(path.join(repo, 'webui-release-history.json'), JSON.stringify({schema: 1, versions}));
  commit(repo, 'history');
  return {repo, temp, versions};
}
function audit(repo) { return command(repo, process.execPath, ['tests/audit-displayed-restores.cjs'], false); }

test('注釈タグ・通常タグと古い版にない任意ファイルを検証し、元を変更しない', t => {
  const {repo} = fixture(t);
  const before = git(repo, 'rev-parse', 'HEAD').stdout;
  git(repo, 'checkout', '--quiet', '--detach');
  const result = audit(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified: 2/);
  assert.equal(git(repo, 'rev-parse', 'HEAD').stdout, before);
  assert.equal(git(repo, 'status', '--porcelain').stdout, '');
});

test('履歴参照の欠落と重複を検出する', t => {
  const {repo, versions} = fixture(t);
  const file = path.join(repo, 'webui-release-history.json');
  versions[0].ref = 'webui-apps-v2026.11.04.99';
  fs.writeFileSync(file, JSON.stringify({schema: 1, versions})); commit(repo, 'missing tag');
  const missing = audit(repo);
  assert.notEqual(missing.status, 0);
  versions[0].ref = versions[1].ref;
  fs.writeFileSync(file, JSON.stringify({schema: 1, versions})); commit(repo, 'duplicate');
  const duplicate = audit(repo);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate version or ref/);
  assert.equal(git(repo, 'status', '--porcelain').stdout, '');
});

test('固定点がない候補を実行せず、降順と日時のタイムゾーンを検査する', t => {
  const {repo, versions} = fixture(t);
  const file = path.join(repo, 'webui-release-history.json');
  versions.unshift({version: '2026.11.04.3', ref: 'webui-apps-v2026.11.04.3', candidate: true,
    timestamp: '2026-11-04T00:03:00+09:00', actor: 'fixture', summary: 'candidate', files: []});
  fs.writeFileSync(file, JSON.stringify({schema: 1, versions})); commit(repo, 'unpublished candidate');
  const candidate = audit(repo);
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.match(candidate.stdout, /verified: 2/);
  versions[0].timestamp = '2026-11-04T00:00:00+09:00';
  fs.writeFileSync(file, JSON.stringify({schema: 1, versions})); commit(repo, 'wrong order');
  assert.notEqual(audit(repo).status, 0);
  versions[0].timestamp = '2026-11-04T00:03:00';
  fs.writeFileSync(file, JSON.stringify({schema: 1, versions})); commit(repo, 'no timezone');
  assert.notEqual(audit(repo).status, 0);
});

test('画面に混入したシェル構文を実行せず拒否する', t => {
  const {repo} = fixture(t);
  const js = path.join(repo, 'webui-releases.js');
  const original = fs.readFileSync(js, 'utf8');
  const changed = original.replace('--repo . --worktree-path', '--repo .; touch injected --worktree-path');
  assert.notEqual(changed, original);
  fs.writeFileSync(js, changed); commit(repo, 'alter displayed command');
  const result = audit(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /allowed grammar/);
  assert.equal(fs.existsSync(path.join(repo, 'injected')), false);
});

test('浅いcloneを不足した履歴として明示する', t => {
  const {repo, temp} = fixture(t);
  const shallow = path.join(temp, 'shallow');
  command(temp, 'git', ['clone', '--quiet', '--depth=1', pathToFileURL(repo).href, shallow]);
  const result = audit(shallow);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Full history is required/);
});
