const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const live = process.env.DIRECTORY_TEST_LIVE === '1';
const origin = live ? 'https://besteffortnet.github.io' : 'https://fixture.invalid';

async function verify(name, engine, options, mode) {
  const browser = await engine.launch(options);
  const context = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true,
    serviceWorkers: 'block'});
  try {
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET' || url.origin !== origin) return route.abort();
      if (live) return route.continue();
      const name = url.pathname.slice(1) || 'webui-apps.html';
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) return route.abort();
      const file = path.join(root, name);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({status: 404});
      const ext = name.split('.').pop();
      return route.fulfill({path: file, contentType: {html: 'text/html; charset=utf-8',
        js: 'text/javascript', json: 'application/json'}[ext] || 'application/octet-stream'});
    });
    await context.addInitScript(({mode}) => {
      const nativeFetch = window.fetch;
      let calls = 0;
      window.fetch = (input, init) => {
        if (String(input) !== 'https://192.168.68.221:8013/api/public-observation-times') {
          return nativeFetch(input, init);
        }
        calls++;
        if (calls > 1) return Promise.resolve({ok: true, json: async () => [
          {id: 'toeic', collected_at: new Date(Date.now() - 60000).toISOString()},
        ]});
        window.oldSignal = init.signal;
        if (mode === 'fetch') return new Promise(resolve => { window.resolveOld = () => resolve({
          ok: true, json: async () => [{id: 'toeic', collected_at: new Date(Date.now() - 3600000).toISOString()}],
        }); });
        return Promise.resolve({ok: true, json: () => new Promise(resolve => {
          window.resolveOld = () => resolve([{id: 'toeic', collected_at: new Date(Date.now() - 3600000).toISOString()}]);
        })});
      };
    }, {mode});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/webui-apps.html`, {waitUntil: 'load'});
    await page.locator('#observation-times').tap();
    assert.equal(await page.locator('#observation-times').isDisabled(), true);
    await page.waitForFunction(() => !document.querySelector('#observation-times').disabled, null, {timeout: 6000});
    assert.equal(await page.evaluate(() => window.oldSignal.aborted), true);
    assert.match(await page.locator('#observation-times-result').innerText(), /未確認/);
    await page.locator('#observation-times').tap();
    await page.waitForFunction(() => document.querySelector('#observation-times-result').textContent.includes('取得しました'));
    const row = page.locator('[data-observation-id="toeic"]');
    const result = await row.innerText();
    assert.match(result, /^観測時刻：/);
    await page.evaluate(() => window.resolveOld());
    await page.waitForTimeout(50);
    assert.equal(await row.innerText(), result);
    assert.match(await page.locator('#observation-times-result').innerText(), /取得しました/);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({browser: name, mode, ok: true}));
  } finally {
    await context.close();
    await browser.close();
  }
}

Promise.all([
  ...['fetch', 'body'].map(mode => verify('Chrome', chromium,
    process.env.DIRECTORY_CHROME ? {executablePath: process.env.DIRECTORY_CHROME} : {}, mode)),
  ...['fetch', 'body'].map(mode => verify('WebKit', webkit, {}, mode)),
]).catch(error => {console.error(error); process.exitCode = 1;});
