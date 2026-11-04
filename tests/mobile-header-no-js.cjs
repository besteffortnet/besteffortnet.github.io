const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const live = process.env.DIRECTORY_TEST_LIVE === '1';
const origin = live ? 'https://besteffortnet.github.io' : 'https://fixture.invalid';

(async () => {
  for (const [name, engine, options] of [
    ['Chrome', chromium, process.env.DIRECTORY_CHROME ? {executablePath: process.env.DIRECTORY_CHROME} : {}],
    ['WebKit', webkit, {}],
  ]) {
    const browser = await engine.launch(options);
    const context = await browser.newContext({viewport: {width: 320, height: 568}, hasTouch: true,
      javaScriptEnabled: false, serviceWorkers: 'block'});
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
      const page = await context.newPage();
      await page.goto(`${origin}/webui-apps.html`, {waitUntil: 'load'});
      assert.equal(await page.locator('#more-toggle').isVisible(), false);
      assert.equal(await page.locator('#toolbar-actions').isVisible(), true);
      assert.equal(await page.locator('.version-link').isVisible(), true);
      for (const selector of ['.featured-app', '#observation-times', '#add-spacer', '#reset-order', '#toolbar-help summary']) {
        const rect = await page.locator(selector).boundingBox();
        assert(rect && rect.width >= 44 && rect.height >= 44);
      }
      await page.locator('#toolbar-help summary').tap();
      assert.equal(await page.locator('#toolbar-help').evaluate(el => el.open), true);
      const help = await page.locator('.help-content').boundingBox();
      assert(help.x >= 0 && help.x + help.width <= 321);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
      console.log(JSON.stringify({browser: name, javascript: false, ok: true}));
    } finally { await context.close(); await browser.close(); }
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
