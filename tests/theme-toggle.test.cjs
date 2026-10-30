const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync('webui-apps.html', 'utf8');
assert.equal((html.match(/id="theme-toggle"/g) || []).length, 1);
assert(html.indexOf('class="theme-bar"') < html.indexOf('<main>'));
assert.match(html, /\.theme-bar\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/s);
assert.match(html, /\.theme-toggle\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/s);
assert.match(html, /\.theme-toggle\s*\{[^}]*background:\s*var\(--paper\);[^}]*color:\s*var\(--accent\)/s);
assert.match(html, /data-theme="light"\] \.theme-toggle \.icon-moon\s*\{\s*display:\s*block/);
assert.match(html, /data-theme="dark"\] \.theme-toggle \.icon-sun\s*\{\s*display:\s*block/);
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes("getElementById('theme-toggle')"));
assert(script);
for (const savedTheme of ['light', 'dark']) {
  const values = new Map([['webui.theme', savedTheme]]), attrs = {}, handlers = {};
  const button = {setAttribute(k, v) {attrs[k] = v}, addEventListener(k, v) {handlers[k] = v}};
  const document = {documentElement: {dataset: {}}, getElementById: () => button};
  const context = {document, window: {matchMedia: () => ({matches: false, addEventListener(){}})}, localStorage: {getItem: k => values.get(k), setItem: (k,v) => values.set(k,v)}};
  vm.runInNewContext(script, context);
  assert.equal(document.documentElement.dataset.theme, savedTheme);
  assert.equal(attrs['aria-label'], savedTheme === 'dark' ? 'ライトモードに切り替え' : 'ダークモードに切り替え');
  handlers.click();
  assert.equal(document.documentElement.dataset.theme, savedTheme === 'dark' ? 'light' : 'dark');
  assert.equal(values.get('webui.theme'), document.documentElement.dataset.theme);
}
console.log('theme toggle no-browser checks passed');
