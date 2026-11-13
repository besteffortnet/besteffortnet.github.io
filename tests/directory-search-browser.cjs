const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const origin = 'https://fixture.invalid';
const root = path.resolve(__dirname, '..');
const orderKey = 'webui.row-order.v2.library';

// 検索・絞り込み・概要の先出し・スマホ1列表示を、実ブラウザで確認する。
(async () => {
  for (const [name, engine, options] of [
    ['Chrome', chromium, process.env.DIRECTORY_CHROME ? {executablePath: process.env.DIRECTORY_CHROME} : {}],
    ['WebKit', webkit, {}],
  ]) {
    const browser = await engine.launch(options);
    try {
      for (const [width, height] of [[320, 740], [390, 844], [810, 1080], [1440, 900]]) {
        const context = await browser.newContext({viewport: {width, height}, hasTouch: width < 1440, serviceWorkers: 'block'});
        try {
          await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (route.request().method() !== 'GET' || url.origin !== origin) return route.abort();
            const file = path.join(root, url.pathname === '/' ? 'webui-apps.html' : url.pathname.slice(1));
            if (!/^\/(?:[\w.-]+)?$/.test(url.pathname) || !fs.existsSync(file)) return route.fulfill({status: 404});
            return route.fulfill({path: file, contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript'});
          });
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(origin + '/webui-apps.html');

          const search = page.locator('#app-search');
          const status = page.locator('#filter-status');
          const visibleCards = () => page.locator('tbody tr.app-card:not(.is-filtered-out)').count();
          const chip = id => page.locator(`#group-chips .chip[data-group="${id}"]`);
          const storedGroup = id => page.evaluate(key => localStorage.getItem(key), 'webui.group.' + id);

          // 初期表示: 検索欄は JS 準備後に現れ、全件を表示する。
          assert.equal(await page.locator('#filter-bar').isVisible(), true);
          assert.equal(await visibleCards(), 22);
          assert.equal(await status.textContent(), '全22件を表示');
          assert.equal(await chip('all').getAttribute('aria-pressed'), 'true');
          assert.deepEqual(await page.locator('#group-chips .chip-count').allTextContents(), ['22', '3', '7', '7', '2', '3']);

          // カード: 先頭の一文、詳細トグル、メタ行（状態リンクと観測時刻）が揃っている。
          const toeic = page.locator('tbody tr.app-card').filter({hasText: 'TOEIC Study'});
          assert.match(await toeic.locator('.desc-lead').textContent(), /^本人提供の公式問題集で学ぶ個人用サイト。$/);
          assert.equal(await toeic.locator('.desc-title').textContent(), '詳細');
          assert.equal(await toeic.locator('.card-meta .status-link').count(), 1);
          assert.equal(await toeic.locator('.card-meta [data-observation-id="toeic"]').count(), 1);
          assert.equal(await toeic.locator('.desc-text').isVisible(), false);

          // 列数: 560px 以下は1列、800px 以下は2列、それより広いと3列。
          const columns = await page.locator('.app-group[open] tbody').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
          assert.equal(columns, width <= 560 ? 1 : width <= 800 ? 2 : 3);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);

          // 検索: 全角・大文字小文字を同一視し、複数語は AND で絞る。
          await search.fill('ＰＯＲＴ 8015');
          assert.equal(await visibleCards(), 1);
          assert.equal(await page.locator('tbody tr.app-card:not(.is-filtered-out) .service-link').textContent(), '音の本棚');
          assert.equal(await status.textContent(), '22件中 1件を表示');
          assert.equal(await page.locator('.app-group[data-group="library"] .group-count').textContent(), '1/7件');
          assert.equal(await page.locator('.app-group[data-group="study"]').isVisible(), false);
          assert.equal(new URL(page.url()).searchParams.get('q'), 'ＰＯＲＴ 8015');

          // 閉じているグループにも該当を出し、解除すると元の開閉へ戻る。保存値は変えない。
          await search.fill('hubterm');
          assert.equal(await visibleCards(), 1);
          const layerB = page.locator('.app-group[data-group="layer-b"]');
          assert.equal(await layerB.evaluate(el => el.open), true);
          assert.equal(await storedGroup('layer-b'), null);
          await page.locator('#search-clear').click();
          assert.equal(await search.inputValue(), '');
          assert.equal(await layerB.evaluate(el => el.open), false);
          assert.equal(await storedGroup('layer-b'), null);
          assert.equal(await visibleCards(), 22);
          assert.equal(new URL(page.url()).searchParams.has('q'), false);

          // 該当なし: 説明と解除ボタンを出す。
          await search.fill('存在しない語');
          assert.equal(await visibleCards(), 0);
          assert.equal(await page.locator('#empty-state').isVisible(), true);
          await page.locator('#empty-reset').click();
          assert.equal(await page.locator('#empty-state').isVisible(), false);
          assert.equal(await visibleCards(), 22);

          // グループチップ: 1つに絞り、もう一度押すと全件へ戻る。
          await chip('library').click();
          assert.equal(await visibleCards(), 7);
          assert.equal(await chip('library').getAttribute('aria-pressed'), 'true');
          assert.equal(new URL(page.url()).searchParams.get('g'), 'library');
          assert.equal(await page.locator('.app-group[data-group="study"]').isVisible(), false);
          await chip('library').click();
          assert.equal(await visibleCards(), 22);

          // 検索中は並べ替えを止め、検索解除後は従来どおり並べ替えられる。
          await search.fill('shelf');
          const handle = page.locator('tbody tr.app-card:not(.is-filtered-out) .row-handle').first();
          await handle.focus();
          const beforeOrder = await page.evaluate(key => localStorage.getItem(key), orderKey);
          await page.keyboard.press('Alt+ArrowDown');
          assert.equal(await page.evaluate(key => localStorage.getItem(key), orderKey), beforeOrder);
          assert.match(await page.locator('#order-status').textContent(), /検索中は並べ替えできません/);
          await search.fill('');
          const library = page.locator('tbody[data-order-group="library"] .service-link');
          const first = (await library.allTextContents())[0];
          await library.first().focus();
          await page.keyboard.press('Alt+ArrowDown');
          assert.notEqual((await library.allTextContents())[0], first);
          await page.locator('#reset-order').evaluate(el => el.click());

          // 詳細の一括表示: 全カードを開閉し、保存する。個別操作と同期する。
          await page.locator('#detail-all').evaluate(el => el.click());
          assert.equal(await page.locator('tbody .desc-text:visible').count() > 0, true);
          assert.equal(await toeic.locator('.desc-text').isVisible(), true);
          assert.equal(await page.evaluate(() => localStorage.getItem('webui.detail-all')), '1');
          await toeic.locator('.desc-switch').evaluate(el => el.click());
          assert.equal(await page.locator('#detail-all').isChecked(), false);
          await page.locator('#detail-all').evaluate(el => el.click());
          await page.locator('#detail-all').evaluate(el => el.click());
          assert.equal(await toeic.locator('.desc-text').isVisible(), false);

          // `/` で検索欄へ移動し、Esc で入力を消す。
          await page.locator('body').click({position: {x: 1, y: 1}});
          await page.keyboard.press('/');
          assert.equal(await search.evaluate(el => el === document.activeElement), true);
          await page.keyboard.type('toeic');
          assert.equal(await visibleCards(), 1);
          await page.keyboard.press('Escape');
          assert.equal(await search.inputValue(), '');

          // URL の検索語とグループから同じ表示を復元する。
          await page.goto(origin + '/webui-apps.html?q=comic&g=library');
          assert.equal(await search.inputValue(), 'comic');
          assert.equal(await visibleCards(), 1);
          assert.equal(await chip('library').getAttribute('aria-pressed'), 'true');
          await page.goto(origin + '/webui-apps.html?g=unknown');
          assert.equal(await visibleCards(), 22);

          assert.deepEqual(errors, []);
          console.log(`PASS ${name} ${width}×${height} search, filters, details and keyboard`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
