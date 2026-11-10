const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'webui-apps.html'), 'utf8');
const head = html.slice(0, html.indexOf('</head>') + '</head>'.length);
const origin = 'https://fixture.invalid';
const key = 'webui.theme';

(async () => {
  for (const [name, type, options] of [
    ['Chrome', chromium, process.env.DIRECTORY_CHROME ? {executablePath: process.env.DIRECTORY_CHROME} : {}],
    ['WebKit', webkit, {}],
  ]) {
    const browser = await type.launch(options);
    try {
      for (const [os, stored, initial, followsSystem] of [
        ['dark', null, 'light', false],
        ['dark', 'light', 'light', false],
        ['light', 'dark', 'dark', false],
        ['dark', 'system', 'dark', true],
        ['light', '{"theme":"system"}', 'light', true],
      ]) {
        const context = await browser.newContext({viewport: {width: 390, height: 844}, colorScheme: os, serviceWorkers: 'block'});
        try {
          await context.route('**/*', route => {
            const req = route.request();
            const url = new URL(req.url());
            if (req.method() !== 'GET' || url.origin !== origin) return route.abort();
            if (url.pathname === '/first-paint.html') return route.fulfill({
              body: head + '<body><p>First paint fixture</p></body></html>', contentType: 'text/html; charset=utf-8',
            });
            if (!/^\/[a-zA-Z0-9._-]+$/.test(url.pathname)) return route.abort();
            const target = path.join(root, url.pathname.slice(1));
            if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return route.fulfill({status: 404});
            return route.fulfill({path: target, contentType: target.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript'});
          });
          if (stored !== null) await context.addInitScript(({key, value}) => {
            if (location.hostname === 'fixture.invalid' && !sessionStorage.getItem('theme-test-seeded')) {
              localStorage.setItem(key, value);
              sessionStorage.setItem('theme-test-seeded', 'true');
            }
          }, {key, value: stored});

          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          const theme = () => page.locator('html').evaluate(node => getComputedStyle(node).colorScheme);
          const saved = () => page.evaluate(name => localStorage.getItem(name), key);
          await page.goto(origin + '/first-paint.html');
          assert.equal(await theme(), initial);
          assert.equal(await saved(), stored);

          await page.goto(origin + '/webui-apps.html');
          const button = page.locator('#theme-toggle');
          const verifyControl = async appearance => {
            assert.equal(await theme(), appearance);
            const dark = appearance === 'dark';
            assert.equal(await button.getAttribute('aria-label'), dark ? 'ライトモードに切り替え' : 'ダークモードに切り替え');
            assert.equal(await button.locator('.icon-sun').isVisible(), dark);
            assert.equal(await button.locator('.icon-moon').isVisible(), !dark);
          };
          await verifyControl(initial);
          assert.equal(await saved(), stored);
          await page.emulateMedia({colorScheme: os === 'dark' ? 'light' : 'dark'});
          const changed = followsSystem ? (initial === 'dark' ? 'light' : 'dark') : initial;
          await page.waitForFunction(mode => document.documentElement.dataset.theme === mode, changed);
          await verifyControl(changed);
          await page.reload();
          await verifyControl(changed);
          assert.equal(await saved(), stored);

          await button.focus();
          await button.press('Enter');
          const explicit = changed === 'dark' ? 'light' : 'dark';
          await verifyControl(explicit);
          assert.equal(await saved(), explicit);
          await page.reload();
          await verifyControl(explicit);
          assert.deepEqual(errors, []);
          console.log(`PASS ${name} OS ${os}, saved ${stored}, first paint and persisted theme`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
