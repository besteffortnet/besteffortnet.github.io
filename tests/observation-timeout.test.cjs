const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'observation-times.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(fetch) {
  let listener;
  let timeout;
  const button = {dataset: {endpoint: 'https://example.invalid/observations'}, disabled: false,
    addEventListener(name, fn) { assert.equal(name, 'click'); listener = fn; }};
  const summary = {textContent: ''};
  const row = {dataset: {observationId: 'app'}, textContent: ''};
  const document = {
    querySelector(selector) { return selector === '#observation-times' ? button : summary; },
    querySelectorAll() { return [row]; },
  };
  const setTimeout = (fn, ms) => { assert.equal(ms, 2500); timeout = fn; return 1; };
  const clearTimeout = () => { timeout = undefined; };
  vm.runInNewContext(source, {document, fetch, AbortController, Date, setTimeout, clearTimeout});
  return {button, summary, row, click: () => listener(),
    expire() { assert(timeout, 'deadline must exist'); timeout(); }};
}

const valid = when => [{id: 'app', collected_at: when}];
const ok = data => ({ok: true, json: async () => data});

test('fetch が中断を無視しても期限後に再試行でき、遅れた旧応答は反映しない', async () => {
  let resolveOld;
  let firstSignal;
  let calls = 0;
  const oldTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const newTime = new Date(Date.now() - 60 * 1000).toISOString();
  const ui = fixture((url, options) => {
    calls++;
    if (calls === 1) {
      firstSignal = options.signal;
      return new Promise(resolve => { resolveOld = resolve; });
    }
    return Promise.resolve(ok(valid(newTime)));
  });
  const first = ui.click();
  await flush();
  assert.equal(ui.button.disabled, true);
  ui.expire();
  await flush();
  assert.equal(firstSignal.aborted, true);
  assert.equal(ui.button.disabled, false);
  assert.match(ui.summary.textContent, /未確認/);
  await ui.click();
  assert.equal(ui.button.disabled, false);
  assert.match(ui.summary.textContent, /取得しました/);
  const current = ui.row.textContent;
  resolveOld(ok(valid(oldTime)));
  await first;
  await flush();
  assert.equal(ui.row.textContent, current);
  assert.match(ui.summary.textContent, /取得しました/);
});

test('応答本文が中断を無視しても期限後に操作を解放する', async () => {
  let signal;
  const ui = fixture((url, options) => {
    signal = options.signal;
    return Promise.resolve({ok: true, json: () => new Promise(() => {})});
  });
  const request = ui.click();
  await flush();
  ui.expire();
  await flush();
  assert.equal(signal.aborted, true);
  assert.equal(ui.button.disabled, false);
  assert.match(ui.summary.textContent, /未確認/);
  await request;
});

test('不正な応答は詳細を表示せず、ボタンを再び有効にする', async () => {
  const ui = fixture(async () => ok([{id: 'app', collected_at: 'SECRET'}]));
  await ui.click();
  assert.equal(ui.button.disabled, false);
  assert.match(ui.summary.textContent, /未確認/);
  assert.doesNotMatch(ui.summary.textContent + ui.row.textContent, /SECRET/);
});
