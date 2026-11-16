const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const origin = 'https://fixture.invalid';
const root = path.resolve(__dirname, '..');
const legacyKey = 'webui.row-order.v2.other';

(async () => {
  for (const [name, engine, options] of [
    ['Chrome', chromium, process.env.DIRECTORY_CHROME ? {executablePath: process.env.DIRECTORY_CHROME} : {}],
    ['WebKit', webkit, {}],
  ]) {
    const browser = await engine.launch(options);
    try {
      for (const [width, height] of [[390, 844], [810, 1080], [1440, 900]]) {
        const context = await browser.newContext({viewport: {width, height}, hasTouch: width < 1440, serviceWorkers: 'block'});
        try {
          await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (route.request().method() !== 'GET' || url.origin !== origin) return route.abort();
            const file = path.join(root, url.pathname.slice(1));
            if (!/^\/[\w.-]+$/.test(url.pathname) || !fs.existsSync(file)) return route.fulfill({status: 404});
            return route.fulfill({path: file, contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript'});
          });
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(origin + '/webui-apps.html');
          const groupB = page.locator('[data-group="layer-b"]');
          const groupC = page.locator('[data-group="layer-c"]');
          const other = page.locator('[data-group="other"]');
          const links = group => group.locator('.service-link');
          const title = group => group.locator('summary');
          const names = group => links(group).allTextContents();
          assert.deepEqual(await names(groupB), ['Fireworks', 'hubterm']);
          assert.deepEqual(await names(groupC), ['AllTimeBest Navigator', 'Narrative Tsuzuri', 'uekiakio.com']);
          assert.equal(await links(groupB).first().isVisible(), false);
          assert.equal(await links(groupC).first().isVisible(), false);

          const legacy = await page.locator('[data-order-group="other"] .app-card, [data-order-group^="layer-"] .app-card')
            .evaluateAll(rows => rows.map(row => row.dataset.orderId).reverse());
          legacy.splice(2, 0, 'spacer:old-layout');
          await page.evaluate(({legacyKey, legacy}) => localStorage.setItem(legacyKey, JSON.stringify(legacy)), {legacyKey, legacy});
          await page.reload();

          await title(groupB).focus();
          await title(groupB).press('Enter');
          assert.equal(await links(groupB).first().isVisible(), true);
          assert.equal(await links(groupC).first().isVisible(), false);
          await page.keyboard.press(name === 'WebKit' ? 'Alt+Tab' : 'Tab');
          assert.equal(await links(groupB).first().evaluate(link => link === document.activeElement), true);
          await title(groupC).press('Space');
          assert.equal(await links(groupC).first().isVisible(), true);
          assert.deepEqual(await names(groupB), ['hubterm', 'Fireworks']);
          assert.deepEqual(await names(groupC), ['uekiakio.com', 'Narrative Tsuzuri', 'AllTimeBest Navigator']);
          assert.equal(await other.locator('.spacer-slot').count(), 1);
          assert.equal(await groupB.locator('.spacer-slot').count(), 0);
          assert.equal(await groupC.locator('.spacer-slot').count(), 0);
          const columns = width <= 800 ? 2 : 3;
          for (const group of [groupB, groupC]) {
            assert.equal(await group.locator('tbody').evaluate(body => getComputedStyle(body).gridTemplateColumns.split(' ').length), columns);
            assert.equal(await group.locator('.port-badge').count(), await links(group).count());
          }

          await links(groupB).first().press('Alt+ArrowDown');
          assert.deepEqual(await names(groupB), ['Fireworks', 'hubterm']);
          await links(groupB).last().press('Alt+ArrowDown');
          assert.deepEqual(await names(groupB), ['Fireworks', 'hubterm']);
          if (width === 1440) {
            const first = links(groupB).first();
            await first.scrollIntoViewIfNeeded();
            const source = await first.boundingBox();
            const target = await links(groupC).first().boundingBox();
            await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
            await page.mouse.down();
            await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {steps: 10});
            await page.mouse.up();
            assert.deepEqual((await names(groupB)).sort(), ['Fireworks', 'hubterm']);
            assert.equal(await page.locator('.drag-placeholder').count(), 0);
          }

          const beforeReload = await names(groupB);
          await title(groupC).press('Enter');
          await page.waitForFunction(() => localStorage.getItem('webui.group.layer-c') === 'closed');
          await page.reload();
          assert.equal(await links(groupB).first().isVisible(), true);
          assert.equal(await links(groupC).first().isVisible(), false);
          assert.deepEqual(await names(groupB), beforeReload);
          assert.deepEqual(await names(groupC), ['uekiakio.com', 'Narrative Tsuzuri', 'AllTimeBest Navigator']);
          assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), legacyKey), legacy);
          if (width <= 720) await page.locator('#more-toggle').tap();
          await page.locator('#add-spacer').click();
          assert.equal(await other.locator('.spacer-slot').count(), 2);
          if (width <= 720) await page.locator('#more-toggle').tap();
          await page.locator('#reset-order').click();
          assert.equal(await other.locator('.spacer-slot').count(), 0);
          assert.deepEqual(await names(groupB), ['Fireworks', 'hubterm']);
          assert.deepEqual(await names(groupC), ['AllTimeBest Navigator', 'Narrative Tsuzuri', 'uekiakio.com']);
          assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), legacyKey), legacy);
          assert.deepEqual(errors, []);
          console.log(`PASS ${name} ${width}×${height} layers, keyboard, storage and grid`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
