const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'webui-release-history.json'), 'utf8')).versions[0].version;
const live = process.env.DIRECTORY_TEST_LIVE === '1';
const origin = live ? 'https://besteffortnet.github.io' : 'https://fixture.invalid';
const sizes = [320, 390, 768, 800, 810, 1032, 1440];
const engines = [
  ['Chrome', chromium, process.env.DIRECTORY_CHROME ? {executablePath: process.env.DIRECTORY_CHROME} : {}],
  ['WebKit', webkit, {}],
];

function contrast(rgb1, rgb2) {
  const luminance = value => {
    const channels = value.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number).map(n => {
      n /= 255;
      return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
    });
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const a = luminance(rgb1), b = luminance(rgb2);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

(async () => {
  for (const [name, engine, options] of engines) {
    const browser = await engine.launch(options);
    try {
      for (const width of sizes) {
        const context = await browser.newContext({viewport: {width, height: 850}, hasTouch: true,
          colorScheme: 'light', serviceWorkers: 'block'});
        const errors = [];
        let observation = 'success';
        try {
          await context.route('**/*', async route => {
            const req = route.request(), url = new URL(req.url());
            if (url.href === 'https://192.168.68.221:8013/api/public-observation-times') {
              if (req.method() !== 'GET') return route.abort();
              if (observation === 'error') return route.fulfill({status: 503});
              if (observation === 'timeout') {
                await new Promise(resolve => setTimeout(resolve, 3000));
                return route.abort().catch(() => {});
              }
              const collected_at = new Date(Date.now() - 120000).toISOString();
              return route.fulfill({json: [{id: 'toeic', collected_at}, {id: 'comic', collected_at}]});
            }
            if (req.method() !== 'GET' || url.origin !== origin) return route.abort();
            if (live) return route.continue();
            const name = url.pathname.slice(1) || 'webui-apps.html';
            if (!/^[a-zA-Z0-9._-]+$/.test(name)) return route.abort();
            const file = path.join(root, name);
            if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({status: 404});
            const ext = name.split('.').pop();
            return route.fulfill({path: file, contentType: {html: 'text/html; charset=utf-8',
              js: 'text/javascript', json: 'application/json'}[ext] || 'application/octet-stream'});
          });
          const page = await context.newPage();
          page.on('pageerror', e => errors.push(e.message));
          await page.goto(`${origin}/webui-apps.html`, {waitUntil: 'load'});
          const rows = page.locator('tbody .app-card');
          assert.equal(await rows.count(), 21);
          assert.equal(await page.locator('tbody .port-badge').count(), 22);
          assert.equal(await page.locator('tbody').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), width <= 800 ? 2 : 3);
          const first = await rows.first().boundingBox();
          const nav = await page.locator('.theme-bar').boundingBox();
          assert(first && nav && first.y <= (width <= 720 ? 120 : 75), `${name} ${width}: first card ${first?.y}`);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
          assert.equal(await page.locator('h1').innerText(), 'WebUIアプリ一覧');
          assert.equal(await page.locator('.version-link').innerText(), `v${version}`);
          assert.equal(await page.locator('.version-link').getAttribute('href'), 'webui-releases.html');
          assert.equal(await page.locator('.featured-app').getAttribute('href'), 'https://192.168.68.221:8013/');
          assert.match(await page.locator('.featured-app').getAttribute('rel'), /noopener/);
          for (const selector of ['.featured-app', '#observation-times', '#add-spacer', '#reset-order', '#toolbar-help summary', '#theme-toggle']) {
            const control = page.locator(selector), rect = await control.boundingBox();
            assert(rect && rect.width >= 44 && rect.height >= 44, `${selector} has a small target`);
            assert(await control.getAttribute('aria-label'));
          }
          assert.equal(await page.locator('#observation-times-result').isVisible(), false);
          const help = page.locator('#toolbar-help');
          await help.locator('summary').tap();
          assert.equal(await help.evaluate(el => el.open), true);
          const popover = await help.locator('.help-content').boundingBox();
          assert(popover.x >= 0 && popover.x + popover.width <= width + 1);
          assert.match(await help.innerText(), /Alt/);
          await page.keyboard.press('Escape');
          assert.equal(await help.evaluate(el => el.open), false);

          const theme = page.locator('#theme-toggle');
          for (const mode of ['light', 'dark']) {
            if (await page.locator('html').getAttribute('data-theme') !== mode) await theme.tap();
            const styles = await theme.evaluate(el => ({color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor}));
            assert(contrast(styles.color, styles.background) >= 3);
            assert.equal(await theme.locator(mode === 'light' ? '.icon-moon' : '.icon-sun').isVisible(), true);
          }
          await page.reload();
          assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');

          await page.locator('#add-spacer').tap();
          assert.equal(await page.locator('tbody .spacer-slot').count(), 1);
          await page.reload();
          assert.equal(await page.locator('tbody .spacer-slot').count(), 1);
          await page.locator('#reset-order').tap();
          assert.equal(await page.locator('tbody .spacer-slot').count(), 0);
          assert.equal(await page.locator('#reset-order').isDisabled(), true);

          const ids = () => rows.evaluateAll(items => items.map(row => row.dataset.orderId));
          const initial = await ids();
          const handle = rows.nth(0).locator('.row-handle');
          assert.equal(await handle.getAttribute('aria-describedby'), 'order-help');
          await handle.focus();
          await handle.press('Alt+ArrowDown');
          const ordered = await ids();
          assert.notDeepEqual(ordered, initial);
          await page.reload();
          assert.deepEqual(await ids(), ordered);

          if (width === 390 || width === 1032) {
            await rows.nth(0).scrollIntoViewIfNeeded();
            const a = await rows.nth(0).locator('.row-handle').boundingBox();
            const b = await rows.nth(1).boundingBox();
            await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
            await page.mouse.down();
            await page.mouse.move(b.x + b.width * .85, b.y + b.height * .85, {steps: 14});
            await page.mouse.up();
            const moved = await ids();
            assert.notDeepEqual(moved, ordered);
            await page.reload();
            assert.deepEqual(await ids(), moved);
          }

          if (width === 390 && name === 'Chrome') {
            if (await page.locator('#reset-order').isEnabled()) await page.locator('#reset-order').tap();
            const beforeTouch = await ids();
            const a = await rows.nth(0).locator('.row-handle').boundingBox();
            const b = await rows.nth(1).boundingBox();
            const start = {x: a.x + a.width / 2, y: a.y + a.height / 2};
            const end = {x: b.x + b.width * .85, y: b.y + b.height * .85};
            const cdp = await context.newCDPSession(page);
            await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [start]});
            for (let step = 1; step <= 12; step++) {
              const x = start.x + (end.x - start.x) * step / 12;
              const y = start.y + (end.y - start.y) * step / 12;
              await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x, y}]});
            }
            await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
            await cdp.detach();
            const touchOrder = await ids();
            assert.notDeepEqual(touchOrder, beforeTouch);
            await page.reload();
            assert.deepEqual(await ids(), touchOrder);
          }

          await page.locator('#observation-times').tap();
          await page.waitForFunction(() => document.querySelector('#observation-times-result').textContent.includes('取得しました'));
          assert.match(await page.locator('[data-observation-id="toeic"]').innerText(), /観測時刻/);
          assert.equal(await page.locator('#observation-times').isEnabled(), true);
          observation = 'error';
          await page.locator('#observation-times').tap();
          await page.waitForFunction(() => document.querySelector('#observation-times-result').textContent.includes('未確認'));
          assert.equal(await page.locator('#observation-times').isEnabled(), true);
          if (width === 390) {
            observation = 'timeout';
            await page.locator('#observation-times').tap();
            await page.waitForFunction(() => !document.querySelector('#observation-times').disabled, null, {timeout: 5000});
            assert.match(await page.locator('#observation-times-result').innerText(), /未確認/);
          }
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
          await page.locator('.version-link').click();
          await page.locator('#versions li').first().waitFor();
          assert((await page.locator('#versions li').first().innerText()).includes(version));
          assert.deepEqual(errors, []);
          console.log(JSON.stringify({browser: name, width, firstCardTop: first.y, headerHeight: nav.height, ok: true}));
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
