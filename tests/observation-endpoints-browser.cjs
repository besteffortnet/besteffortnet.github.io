const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const live = process.env.DIRECTORY_TEST_LIVE === '1';
const realObservation = process.env.DIRECTORY_TEST_REAL_OBSERVATION === '1';
const origin = live || realObservation ? 'https://besteffortnet.github.io' : 'https://fixture.invalid';
const endpoint = 'https://192.168.68.221:8013/api/public-observation-times';
const engines = [
  ['Chrome', chromium, process.env.DIRECTORY_CHROME ? {executablePath:process.env.DIRECTORY_CHROME} : {}],
  ['WebKit', webkit, {}],
];

(async () => {
  for (const [name, engine, options] of engines) {
    const browser = await engine.launch(options);
    try {
      for (const width of [320, 390, 768, 1032, 1440]) {
        const scenarios = realObservation ? (name === 'Chrome' ? ['real', 'real-denied'] : ['real']) :
          ['both', 'missing-https', 'unavailable'];
        for (const scenario of scenarios) {
          const context = await browser.newContext({viewport:{width, height:850}, hasTouch:true, serviceWorkers:'block'});
          try {
            await context.route('**/*', route => {
              const request = route.request(), url = new URL(request.url());
              if (request.method() !== 'GET') return route.abort();
              if (url.href === endpoint) {
                if (scenario === 'real' || scenario === 'real-denied') return route.continue();
                if (scenario === 'unavailable') return route.fulfill({status:503});
                const collected_at = new Date(Date.now() - 60 * 1000).toISOString();
                const rows = [{id:'comic', collected_at}];
                if (scenario === 'both') rows.push({id:'comic-https', collected_at});
                return route.fulfill({json:rows});
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
            const observationResponses = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('response', response => {
              if (response.url() === endpoint) observationResponses.push(response.status());
            });
            if (realObservation && name === 'Chrome') {
              // この検証用コンテキストだけにLANへのアクセスを許可する。
              const cdp = await context.newCDPSession(page);
              const {targetInfo} = await cdp.send('Target.getTargetInfo');
              await cdp.send('Browser.setPermission', {permission:{name:'local-network'},
                setting:scenario === 'real-denied' ? 'denied' : 'granted',
                origin, browserContextId:targetInfo.browserContextId});
            }
            await page.goto(`${origin}/webui-apps.html`, {waitUntil:'load'});
            const rows = page.locator('tbody .app-card');
            const card = rows.filter({has:page.locator('a.repo-link[href="https://github.com/besteffortnet/comic-reader"]')});
            assert.equal(await card.count(), 1);
            assert.equal(await rows.count(), 23);
            assert.equal(await page.locator('[data-observation-id]').count(), 22);
            const httpStatus = card.locator('.status-link').nth(0);
            const httpsStatus = card.locator('.status-link').nth(1);
            assert.equal(await httpStatus.getAttribute('href'), 'https://192.168.68.221:8013/service-status.html?app=comic');
            assert.equal(await httpsStatus.getAttribute('href'), 'https://192.168.68.221:8013/service-status.html?app=comic-https');
            assert.match(await httpStatus.getAttribute('aria-label'), /8012/);
            assert.match(await httpsStatus.getAttribute('aria-label'), /8019/);
            const httpTime = card.locator('[data-observation-id="comic"]');
            const httpsTime = card.locator('[data-observation-id="comic-https"]');
            assert.match(await httpTime.textContent(), /未確認/);
            assert.match(await httpsTime.textContent(), /未確認/);
            const menu = page.locator('#more-toggle');
            if (await menu.isVisible()) await menu.tap();
            await page.locator('#observation-times').tap();
            await page.waitForFunction(() => {
              const text = document.querySelector('#observation-times-result').textContent;
              return text.includes('取得しました') || text.includes('前回の観測') || text.includes('未確認');
            });
            if (scenario === 'unavailable' || scenario === 'real-denied') {
              assert.match(await httpTime.textContent(), /未確認/);
              assert.match(await httpsTime.textContent(), /未確認/);
            } else {
              assert.match(await httpTime.textContent(), /^(観測|前回)：/);
              assert.doesNotMatch(await httpTime.textContent(), /未確認/);
              if (scenario === 'both' || scenario === 'real') assert.doesNotMatch(await httpsTime.textContent(), /未確認/);
              else assert.match(await httpsTime.textContent(), /未確認/);
            }
            assert.match(await httpTime.locator('..').textContent(), /^8012 /);
            assert.match(await httpsTime.locator('..').textContent(), /^8019 /);
            if (scenario === 'real') assert.deepEqual(observationResponses, [200]);
            if (scenario === 'real-denied') assert.deepEqual(observationResponses, []);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({browser:name, width, scenario, ok:true}));
          } finally { await context.close(); }
        }
      }
    } finally { await browser.close(); }
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
