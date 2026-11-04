// 実際に描画される復元コマンドを、独立した一時cloneで検証する。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const vm = require('node:vm');
const {restoreArgs} = require('./restore-command-grammar.cjs');

const repo = path.resolve(__dirname, '..');
const allowed = ['webui-apps.html', 'row-order.js', 'observation-times.js'];

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {cwd, timeout: 30000, maxBuffer: 20 * 1024 * 1024, ...options});
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed (${result.status ?? result.error?.message}): ${String(result.stderr || '').trim()}`);
  }
  return result.stdout;
}
const git = (cwd, ...args) => run('git', args, cwd);

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.textContent = ''; this.dataset = {}; }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener() {}
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

async function renderedRows(data) {
  const root = new Element('html'); root.dataset.theme = 'light';
  const button = new Element('button'), status = new Element('status'), list = new Element('ol');
  const document = {documentElement: root,
    getElementById: id => ({theme: button, status, versions: list})[id],
    createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'),
    createTextNode: text => ({textContent: text})};
  vm.runInNewContext(fs.readFileSync(path.join(repo, 'webui-releases.js'), 'utf8'), {
    document, localStorage: {setItem() {}}, fetch: async () => ({ok: true, json: async () => data}), Intl, Date,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(status.textContent, `${data.versions.length}件の履歴`);
  assert.equal(list.children.length, 1);
  return list.children[0].children;
}

async function main() {
  assert.equal(git(repo, 'rev-parse', '--is-shallow-repository').toString().trim(), 'false',
    'Full history is required; use a full clone or configure checkout with fetch-depth: 0.');
  const sourceStatus = git(repo, 'status', '--porcelain=v1', '-z');
  const history = fs.readFileSync(path.join(repo, 'webui-release-history.json'));
  const data = JSON.parse(history);
  assert.equal(data.schema, 1);
  assert(Array.isArray(data.versions) && data.versions.length > 0 && data.versions.length <= 500);
  const rows = await renderedRows(data);
  assert.equal(rows.length, data.versions.length);
  const seenVersions = new Set(), seenRefs = new Set();
  let previousTime = Infinity;
  for (const record of data.versions) {
    assert(!seenVersions.has(record.version) && !seenRefs.has(record.ref), 'duplicate version or ref');
    seenVersions.add(record.version); seenRefs.add(record.ref);
    assert(typeof record.timestamp === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(record.timestamp));
    const currentTime = Date.parse(record.timestamp);
    assert(Number.isFinite(currentTime) && currentTime <= previousTime, 'history must be newest first');
    previousTime = currentTime;
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-restore-audit-'));
  try {
    const clone = path.join(sandbox, 'repo');
    run('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--no-hardlinks', '--', repo, clone], sandbox);
    git(clone, 'config', '--local', 'core.hooksPath', '/dev/null');
    assert.deepEqual(fs.readFileSync(path.join(clone, 'webui-release-history.json')), history,
      'The audit requires committed history matching the working copy.');
    let count = 0;
    for (let i = 0; i < data.versions.length; i++) {
      const record = data.versions[i], row = rows[i];
      assert.equal(row.children.find(node => node.tag === 'h2')?.textContent,
        `版 ${record.version}${record.candidate === true ? '（候補）' : ''}`);
      const details = row.children.find(node => node.tag === 'details');
      if (record.candidate === true) { assert.equal(details, undefined); continue; }
      const command = details?.children.find(node => node.tag === 'code')?.textContent;
      const args = restoreArgs(command, record);
      const output = JSON.parse(run(args[0], args.slice(1), clone).toString());
      assert.equal(output.ok, true);
      assert.equal(output.original_worktree_modified, false);
      assert.equal(output.publish_push_merge_performed, false);
      const destination = path.join(sandbox, `webui-restore-${record.version}`);
      assert.equal(fs.realpathSync(output.worktree_path), fs.realpathSync(destination));
      assert.deepEqual(fs.readFileSync(path.join(destination, 'webui-release-history.json')), history);
      const target = git(clone, 'rev-parse', '--verify', `${record.ref}^{commit}`).toString().trim();
      assert.equal(output.target_commit, target);
      const manifest = new Map(output.files.map(file => [file.path, file]));
      assert.deepEqual([...manifest.keys()].sort(), [...allowed].sort());
      for (const name of allowed) {
        const entry = git(clone, 'ls-tree', '-z', target, '--', name).toString();
        const local = path.join(destination, name);
        if (!entry) {
          assert.equal(manifest.get(name).present, false);
          assert.equal(fs.existsSync(local), false);
          continue;
        }
        const match = entry.match(/^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)\0$/);
        assert(match && match[3] === name, `${record.version}: unexpected Git tree entry`);
        assert(fs.lstatSync(local).isFile() && !fs.lstatSync(local).isSymbolicLink());
        assert.equal(manifest.get(name).mode, match[1]);
        assert.equal(Boolean(fs.statSync(local).mode & 0o111), match[1] === '100755');
        const bytes = git(clone, 'cat-file', 'blob', match[2]);
        assert.deepEqual(fs.readFileSync(local), bytes, `${record.version}: ${name}`);
        assert.equal(manifest.get(name).sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
      }
      count++;
    }
    assert.deepEqual(git(clone, 'status', '--porcelain=v1', '-z'), Buffer.alloc(0));
    assert.deepEqual(git(repo, 'status', '--porcelain=v1', '-z'), sourceStatus);
    console.log(`Rendered restore commands verified: ${count}; historical file bytes and current history match.`);
  } finally {
    fs.rmSync(sandbox, {recursive: true, force: true});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
