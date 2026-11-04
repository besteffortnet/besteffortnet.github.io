const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'webui-release-history.json'), 'utf8')).versions[0].version;
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
      for (const width of [320, 390, 768, 1032, 1440]) {
        const context = await browser.newContext({viewport:{width,height:850},hasTouch:true,serviceWorkers:'block'});
        try {
          await context.route('**/*', route => {
            const request = route.request(), url = new URL(request.url());
            if (request.method() !== 'GET' || url.origin !== origin) return route.abort();
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
          assert.equal(await page.locator('.version-link').innerText(), `v${version}`);
          const card = page.locator('#webapp-common-entry');
          const description = card.locator('.desc-text');
          const toggle = card.locator('label.switch');
          assert.equal(await description.isHidden(), true);
          assert.equal(await card.locator('.service-link').getAttribute('href'), 'https://192.168.68.221:8013/');
          assert.equal(await card.locator('[data-observation-id="webapp-common"]').count(), 1);
          await toggle.tap();
          assert.equal(await description.isVisible(), true);
          const text = await description.innerText();
          assert.match(text, /登録サイト/);
          assert.match(text, /版はリンク先/);
          assert.doesNotMatch(text, /17サイト|v0\.3\.2/);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
          await toggle.tap();
          assert.equal(await description.isHidden(), true);
          assert.deepEqual(errors, []);
          console.log(JSON.stringify({browser:name,width,ok:true}));
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
