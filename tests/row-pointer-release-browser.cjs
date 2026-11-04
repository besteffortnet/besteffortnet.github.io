const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(process.env.DIRECTORY_ROOT || path.resolve(__dirname, '..'));
const live = process.env.DIRECTORY_TEST_LIVE === '1';
const origin = live ? 'https://besteffortnet.github.io' : 'https://fixture.invalid';
const engines = [
  ['Chrome', chromium, process.env.DIRECTORY_CHROME ? {executablePath:process.env.DIRECTORY_CHROME} : {}],
  ['WebKit', webkit, {}],
];

(async () => {
  for (const [name, engine, options] of engines) {
    const browser = await engine.launch(options);
    try {
      for (const width of [320, 390, 1032, 1440]) {
        for (const scenario of ['outside-release', 'outside-cancel', 'active-cancel', 'regular-click']) {
          const context = await browser.newContext({viewport:{width, height:850}, serviceWorkers:'block'});
          try {
            await context.route('**/*', route => {
              const req = route.request(), url = new URL(req.url());
              if (req.method() !== 'GET' || url.origin !== origin) return route.abort();
              if (live) return route.continue();
              const file = url.pathname.slice(1) || 'webui-apps.html';
              if (!/^[a-zA-Z0-9._-]+$/.test(file)) return route.abort();
              const filePath = path.join(root, file);
              if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return route.fulfill({status:404});
              const ext = path.extname(file);
              return route.fulfill({path:filePath, contentType:ext === '.js' ? 'text/javascript' :
                ext === '.json' ? 'application/json' : 'text/html; charset=utf-8'});
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(`${origin}/webui-apps.html`, {waitUntil:'load'});
            await page.evaluate(() => {
              window.__testClickCount = 0;
              document.querySelector('tbody .row-handle').addEventListener('click', event => {
                event.preventDefault();
                window.__testClickCount++;
              });
              window.addEventListener('pointerdown', event => { window.__testPointerId = event.pointerId; });
            });
            const rows = page.locator('tbody .app-card');
            const handle = rows.first().locator('.row-handle');
            const order = () => rows.evaluateAll(items => items.map(row => row.dataset.orderId));
            const before = await order();
            if (scenario === 'regular-click') {
              await handle.click();
              assert.equal(await page.evaluate(() => window.__testClickCount), 1, '通常クリックを抑止しない');
              assert.deepEqual(await order(), before);
            } else {
              const start = await handle.boundingBox();
              await page.mouse.move(start.x + start.width/2, start.y + start.height/2);
              await page.mouse.down();
              if (scenario === 'active-cancel') {
                const target = await rows.nth(1).boundingBox();
                await page.mouse.move(target.x + target.width*.8, target.y + target.height*.8, {steps:12});
                assert.equal(await page.locator('html').evaluate(el => el.classList.contains('ordering')), true);
              } else {
                // pointermoveとpointerupの対象をtbodyの外にする。
                await page.mouse.move(2, 2);
              }
              if (scenario !== 'outside-release') {
                await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', {
                  pointerId:window.__testPointerId, isPrimary:true, bubbles:true,
                })));
              }
              await page.mouse.up();
              assert.deepEqual(await order(), before, '中断で並びを変えない');
              assert.equal(await page.locator('html').evaluate(el => el.classList.contains('ordering')), false);
              assert.equal(await page.evaluate(() => localStorage.getItem('webui.row-order.v1')), null);
              await handle.focus();
              await page.keyboard.press('Alt+ArrowDown');
              const after = await order();
              assert.notDeepEqual(after, before, '中断後も別操作で移動できる');
              await page.reload({waitUntil:'load'});
              assert.deepEqual(await order(), after, '変更した順序を再読込後も保持する');
            }
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({browser:name, width, scenario, ok:true}));
          } finally { await context.close(); }
        }
      }
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
