const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(process.env.OBSERVATION_SOURCE || path.join(__dirname, '..', 'observation-times.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(fetch, compact = false) {
  let listener;
  let nextTimer = 0, clockOffset = 0;
  const timers = new Map(), documentListeners = {}, windowListeners = {};
  const realNow = Date.now.bind(Date);
  class TestDate extends Date { static now() { return realNow() + clockOffset; } }
  const button = {dataset: {endpoint: 'https://example.invalid/observations'}, disabled: false,
    addEventListener(name, fn) { assert.equal(name, 'click'); listener = fn; }};
  const summary = {textContent: ''};
  const row = {dataset: {observationId: 'app', observationCompact: compact ? 'true' : undefined}, textContent: ''};
  const document = {
    hidden: false,
    querySelector(selector) { return selector === '#observation-times' ? button : summary; },
    querySelectorAll() { return [row]; },
    addEventListener(name, fn) { documentListeners[name] = fn; },
  };
  const window = {addEventListener(name, fn) { windowListeners[name] = fn; }};
  const setTimeout = (fn, ms) => { const id = ++nextTimer; timers.set(id, {fn, ms}); return id; };
  const clearTimeout = id => { timers.delete(id); };
  vm.runInNewContext(source, {document, window, fetch, AbortController, Date:TestDate, setTimeout, clearTimeout});
  function fire(predicate) {
    const entry = [...timers].find(([, timer]) => predicate(timer));
    assert(entry, 'requested timer must exist');
    timers.delete(entry[0]);
    entry[1].fn();
  }
  return {button, summary, row, click: () => listener(),
    expire() { fire(timer => timer.ms === 2500); },
    advance(ms) { clockOffset += ms; },
    fireFreshness() { fire(timer => timer.ms !== 2500); },
    setHidden(value) { document.hidden = value; documentListeners.visibilitychange(); },
    pageShow() { windowListeners.pageshow(); },
    timerCount() { return timers.size; }};
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

test('省スペース表示でも失敗・新しい観測・古い観測を区別する', async () => {
  const failed = fixture(async () => ({ok: false}), true);
  await failed.click();
  assert.equal(failed.row.textContent, '観測未確認');

  const fresh = fixture(async () => ok(valid(new Date(Date.now() - 60 * 1000).toISOString())), true);
  await fresh.click();
  assert.match(fresh.row.textContent, /^観測：/);

  const old = fixture(async () => ok(valid(new Date(Date.now() - 60 * 60 * 1000).toISOString())), true);
  await old.click();
  assert.match(old.row.textContent, /^前回：/);

  const regular = fixture(async () => ok(valid(new Date(Date.now() - 60 * 1000).toISOString())));
  await regular.click();
  assert.match(regular.row.textContent, /^観測時刻：/);
});

test('観測の期限到達とページ復帰で追加通信なしに前回表示へ変わる', async () => {
  for (const compact of [false, true]) {
    let requests = 0;
    const ui = fixture(async () => {
      requests++;
      return ok(valid(new Date(Date.now() - 60 * 1000).toISOString()));
    }, compact);
    await ui.click();
    assert.match(ui.row.textContent, compact ? /^観測：/ : /^観測時刻：/);
    assert.equal(ui.timerCount(), 1);
    ui.advance(26 * 60 * 1000);
    ui.fireFreshness();
    assert.match(ui.row.textContent, compact ? /^前回：/ : /^前回の観測：/);
    assert.match(ui.summary.textContent, /前回の観測/);
    assert.equal(ui.timerCount(), 0);
    assert.equal(requests, 1);
  }

  let requests = 0;
  const ui = fixture(async () => {
    requests++;
    return ok(valid(new Date(Date.now() - 60 * 1000).toISOString()));
  });
  await ui.click();
  ui.setHidden(true);
  assert.equal(ui.timerCount(), 0);
  ui.advance(26 * 60 * 1000);
  ui.setHidden(false);
  assert.match(ui.row.textContent, /^前回の観測：/);
  ui.pageShow();
  assert.equal(ui.timerCount(), 0);
  assert.equal(requests, 1);
});

test('再取得が失敗した後に古い時刻が復活しない', async () => {
  let requests = 0;
  const ui = fixture(async () => {
    requests++;
    return requests === 1 ? ok(valid(new Date(Date.now() - 60 * 1000).toISOString())) : {ok:false};
  });
  await ui.click();
  assert.equal(ui.timerCount(), 1);
  await ui.click();
  assert.equal(ui.timerCount(), 0);
  ui.advance(26 * 60 * 1000);
  ui.pageShow();
  assert.match(ui.row.textContent, /未確認/);
  assert.match(ui.summary.textContent, /未確認/);
  assert.equal(requests, 2);
});
