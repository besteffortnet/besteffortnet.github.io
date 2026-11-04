const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const live = process.env.DIRECTORY_TEST_LIVE === '1';
const origin = live ? 'https://besteffortnet.github.io' : 'https://fixture.invalid';
const endpoint = 'https://192.168.68.221:8013/api/public-observation-times';
const engines = [
  ['Chrome', chromium, process.env.DIRECTORY_CHROME ? {executablePath:process.env.DIRECTORY_CHROME} : {}],
  ['WebKit', webkit, {}],
];

(async () => {
  for (const [name, engine, options] of engines) {
    const browser = await engine.launch(options);
    try {
      for (const width of [320, 390, 1032, 1440]) {
        for (const scenario of ['return', 'pageshow', 'timer', 'stale-initial']) {
          const context = await browser.newContext({viewport:{width,height:850},hasTouch:true,serviceWorkers:'block'});
          try {
            await context.addInitScript(() => {
              const actual = Date.now.bind(Date);
              let offset = 0, hidden = false;
              Date.now = () => actual() + offset;
              Object.defineProperty(document, 'hidden', {configurable:true, get:() => hidden});
              window.__advanceClock = ms => { offset += ms; };
              window.__setHidden = value => {
                hidden = value;
                document.dispatchEvent(new Event('visibilitychange'));
              };
            });
            let requests = 0;
            await context.route('**/*', route => {
              const request = route.request(), url = new URL(request.url());
              if (request.method() !== 'GET') return route.abort();
              if (url.href === endpoint) {
                requests++;
                const age = scenario === 'timer' ? 25 * 60 * 1000 - 2200 :
                  scenario === 'stale-initial' ? 26 * 60 * 1000 : 60 * 1000;
                const collected_at = new Date(Date.now() - age).toISOString();
                return route.fulfill({json:[{id:'toeic',collected_at},{id:'comic',collected_at}]});
              }
              if (url.origin !== origin) return route.abort();
              if (live) return route.continue();
              const name = url.pathname.slice(1) || 'webui-apps.html';
              if (!/^[a-zA-Z0-9._-]+$/.test(name)) return route.abort();
              const file = path.join(root, name);
              if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({status:404});
              const ext = path.extname(name);
              return route.fulfill({path:file, contentType:ext === '.js' ? 'text/javascript' :
                ext === '.json' ? 'application/json' : 'text/html; charset=utf-8'});
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(`${origin}/webui-apps.html`, {waitUntil:'load'});
            const more = page.locator('#more-toggle');
            if (await more.isVisible()) await more.tap();
            await page.locator('#observation-times').tap();
            await page.waitForFunction(() => {
              const text = document.querySelector('#observation-times-result').textContent;
              return text.includes('取得しました') || text.includes('前回の観測');
            });
            const regular = page.locator('[data-observation-id="toeic"]');
            const compact = page.locator('[data-observation-id="comic"]');
            if (scenario !== 'stale-initial') {
              assert.match(await regular.textContent(), /^観測時刻：/);
              assert.match(await compact.textContent(), /^観測：/);
            }
            if (scenario === 'return') {
              await page.evaluate(() => {
                window.__observedMutations = 0;
                window.__freshnessObserver = new MutationObserver(records => { window.__observedMutations += records.length; });
                window.__freshnessObserver.observe(document.querySelector('#observation-times-result'), {childList:true});
                window.__freshnessObserver.observe(document.querySelector('[data-observation-id="toeic"]'), {childList:true});
                window.dispatchEvent(new Event('pageshow'));
              });
              await page.waitForTimeout(0);
              assert.equal(await page.evaluate(() => window.__observedMutations), 0, '同じ表示を再通知しない');
              await page.evaluate(() => window.__freshnessObserver.disconnect());
              await page.evaluate(() => {
                window.__setHidden(true);
                window.__advanceClock(26 * 60 * 1000);
                window.__setHidden(false);
              });
            } else if (scenario === 'pageshow') {
              await page.evaluate(() => {
                window.__advanceClock(26 * 60 * 1000);
                window.dispatchEvent(new Event('pageshow'));
              });
            }
            await page.waitForFunction(() =>
              document.querySelector('[data-observation-id="toeic"]').textContent.startsWith('前回の観測：'),
              null, {timeout:6000});
            assert.match(await compact.textContent(), /^前回：/);
            assert.match(await page.locator('#observation-times-result').textContent(), /前回の観測/);
            assert.equal(requests, 1, '鮮度更新で追加通信しない');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({browser:name,width,scenario,ok:true}));
          } finally { await context.close(); }
        }
      }
    } finally { await browser.close(); }
  }
})().catch(error => {console.error(error); process.exitCode=1;});
