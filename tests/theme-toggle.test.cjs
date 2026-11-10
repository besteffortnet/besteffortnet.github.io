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
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const boot = scripts.find(script => script.includes("JSON.parse(saved)"));
const controls = scripts.find(script => script.includes("getElementById('theme-toggle')"));
assert(boot && controls);
for (const [saved, dark, expected, preference] of [
  [null, true, "light", "light"],
  ["invalid", true, "light", "light"],
  ["light", true, "light", "light"],
  ["dark", false, "dark", "dark"],
  ["system", true, "dark", "system"],
  ["system", false, "light", "system"],
  ['{"theme":"system"}', true, "dark", "system"],
  ['"dark"', false, "dark", "dark"],
]) {
  const values = new Map(saved === null ? [] : [["webui.theme", saved]]);
  const attrs = {}, handlers = {};
  const media = {matches: dark, addEventListener(name, listener) {handlers[name] = listener}};
  const button = {setAttribute(name, value) {attrs[name] = value}, addEventListener(name, listener) {handlers[name] = listener}};
  const document = {documentElement: {dataset: {}}, getElementById: () => button};
  const context = {document, window: {matchMedia: () => media},
    localStorage: {getItem: name => values.get(name) ?? null, setItem: (name, value) => values.set(name, value)}};
  vm.runInNewContext(boot, context);
  assert.equal(document.documentElement.dataset.theme, expected);
  vm.runInNewContext(controls, context);
  assert.equal(document.documentElement.dataset.themePreference, preference);
  assert.equal(document.documentElement.dataset.theme, expected);
  assert.equal(values.get("webui.theme") ?? null, saved);
  assert.equal(attrs["aria-label"], expected === "dark" ? "ライトモードに切り替え" : "ダークモードに切り替え");
  media.matches = !media.matches;
  handlers.change();
  assert.equal(document.documentElement.dataset.theme, preference === "system" ? (dark ? "light" : "dark") : expected);
  assert.equal(values.get("webui.theme") ?? null, saved);
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  handlers.click();
  assert.equal(document.documentElement.dataset.theme, next);
  assert.equal(values.get("webui.theme"), next);
  media.matches = !media.matches;
  handlers.change();
  assert.equal(document.documentElement.dataset.theme, next);
}
console.log('theme boot, OS changes, legacy values and explicit toggle checks passed');
