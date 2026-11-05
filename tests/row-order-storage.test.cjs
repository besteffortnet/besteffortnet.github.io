const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(process.env.ROW_ORDER_SOURCE || path.join(__dirname, '..', 'row-order.js'), 'utf8');
const storageKey = 'webui.row-order.v2.other';
const legacyStorageKey = 'webui.row-order.v1';

class FakeClassList {
  constructor(owner) { this.owner = owner; }
  values() { return new Set((this.owner.className || '').split(/\s+/).filter(Boolean)); }
  add(value) { const values = this.values(); values.add(value); this.owner.className = [...values].join(' '); }
  remove(value) { const values = this.values(); values.delete(value); this.owner.className = [...values].join(' '); }
  contains(value) { return this.values().has(value); }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.classList = new FakeClassList(this);
    this.cells = [];
    this.disabled = false;
    this.textContent = '';
  }
  append(...children) {
    for (const child of children) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  }
  insertBefore(child, reference) {
    if (child.parentElement) child.remove();
    const index = reference === null ? this.children.length : this.children.indexOf(reference);
    if (index < 0) throw new Error('reference is not a child');
    child.parentElement = this;
    this.children.splice(index, 0, child);
    return child;
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  get rows() { return this.children; }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) - 1] || null;
  }
  querySelector(selector) {
    if (selector === '.repo-link') return this.repoLink || null;
    if (selector === '.service-link') return this.serviceLink || null;
    if (selector === '.row-number') return this.children.find(child => child.classList.contains('row-number')) || null;
    return null;
  }
  contains(target) {
    for (let node = target; node; node = node.parentElement) {
      if (node === this) return true;
    }
    return false;
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (selector === 'tr' && node.tagName === 'TR') return node;
      if (selector.startsWith('.') && node.classList.contains(selector.slice(1))) return node;
    }
    return null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  click() { for (const callback of this.listeners.click || []) callback({stopPropagation() {}}); }
  focus() {}
  getBoundingClientRect() { return {left: 0, top: 0, width: 100, height: 30}; }
}

function makeAppRow(id) {
  const row = new FakeElement('tr');
  const cell = new FakeElement('td');
  cell.replaceChildren = function (...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  };
  row.cells = [cell];
  row.append(cell);
  row.repoLink = {href: `https://example.invalid/${id}`};
  row.serviceLink = new FakeElement('a');
  row.serviceLink.parentElement = row;
  row.serviceLink.hasPointerCapture = () => false;
  row.serviceLink.releasePointerCapture = () => {};
  return row;
}

function createHarness(raw, ids = ['a', 'b', 'c'], legacyRaw, additionalGroups = []) {
  const body = new FakeElement('tbody');
  body.dataset.orderGroup = 'other';
  const appRows = ids.map(makeAppRow);
  body.append(...appRows);
  const extraBodies = additionalGroups.map(({name, rows}) => {
    const extra = new FakeElement('tbody');
    extra.dataset.orderGroup = name;
    extra.append(...rows.map(makeAppRow));
    return extra;
  });
  const status = new FakeElement('p');
  const reset = new FakeElement('button');
  const addSpacer = new FakeElement('button');
  const documentElement = new FakeElement('html');
  const documentListeners = {};
  const windowListeners = {};
  const writes = [];
  const storage = new Map();
  if (raw !== undefined) storage.set(storageKey, raw);
  if (legacyRaw !== undefined) storage.set(legacyStorageKey, legacyRaw);
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { writes.push([key, value]); storage.set(key, value); },
  };
  const document = {
    documentElement,
    querySelectorAll(selector) { return selector === 'tbody[data-order-group]' ? [body, ...extraBodies] : []; },
    getElementById(id) {
      return {'order-status': status, 'reset-order': reset, 'add-spacer': addSpacer}[id] || null;
    },
    createElement(tagName) { return new FakeElement(tagName); },
    addEventListener(type, callback) { (documentListeners[type] ||= []).push(callback); },
  };
  const window = {
    addEventListener(type, callback) { (windowListeners[type] ||= []).push(callback); },
    scrollBy() {},
  };
  vm.runInNewContext(source, {document, localStorage, window, innerHeight: 900, setTimeout() {}});
  return {
    appRows, body, extraBodies, localStorage, reset, addSpacer, status, writes,
    order() { return body.rows.map(row => row.dataset.orderId); },
    startPointer(id = 7) {
      for (const callback of body.listeners.pointerdown || []) callback({
        target: appRows[0].serviceLink, button: 0, isPrimary: true, pointerId: id, clientX: 0, clientY: 0,
      });
    },
    releaseOutside(type, id = 7) {
      for (const callback of windowListeners[type] || []) callback({pointerId: id});
    },
    moveByKeyboard(row = appRows[0]) {
      for (const callback of documentListeners.keydown || []) callback({
        target: row.serviceLink, key: 'ArrowDown', altKey: true, preventDefault() {},
      });
    },
  };
}

function testMissingKeyStillSavesNormally() {
  const harness = createHarness(undefined);
  assert.equal(harness.writes.length, 0);
  harness.addSpacer.click();
  assert.equal(harness.writes.length, 1);
  assert.deepEqual(JSON.parse(harness.localStorage.getItem(storageKey)).slice(0, 3), [
    'https://example.invalid/a', 'https://example.invalid/b', 'https://example.invalid/c',
  ]);
}

function testJsonNullIsPreservedUntilExplicitReset() {
  const harness = createHarness('null');
  assert.deepEqual(harness.order(), [
    'https://example.invalid/a', 'https://example.invalid/b', 'https://example.invalid/c',
  ]);
  assert.match(harness.status.textContent, /保存データは保持しています/);
  assert.equal(harness.reset.disabled, false);
  assert.equal(harness.writes.length, 0);

  harness.addSpacer.click();
  assert.equal(harness.localStorage.getItem(storageKey), 'null');
  assert.equal(harness.writes.length, 0);

  harness.reset.click();
  assert.equal(harness.writes.length, 1);
  assert.deepEqual(JSON.parse(harness.localStorage.getItem(storageKey)), [
    'https://example.invalid/a', 'https://example.invalid/b', 'https://example.invalid/c',
  ]);
}

function testValidOrderHandlesNewAndDeletedRows() {
  const saved = JSON.stringify([
    'https://example.invalid/b',
    'https://example.invalid/deleted',
    'https://example.invalid/a',
  ]);
  const harness = createHarness(saved, ['a', 'b', 'new']);
  assert.deepEqual(harness.order(), [
    'https://example.invalid/b', 'https://example.invalid/a', 'https://example.invalid/new',
  ]);
  assert.equal(harness.writes.length, 0);
  harness.addSpacer.click();
  const persisted = JSON.parse(harness.localStorage.getItem(storageKey));
  assert.deepEqual(persisted.slice(0, 3), harness.order().slice(0, 3));
  assert.equal(persisted.length, 4);
}

function testLegacyOrderIsMigratedWithoutOverwritingTheOriginal() {
  const legacy = JSON.stringify([
    'https://example.invalid/b', 'https://example.invalid/a', 'https://example.invalid/removed',
  ]);
  const harness = createHarness(undefined, ['a', 'b', 'c'], legacy);
  assert.deepEqual(harness.order(), [
    'https://example.invalid/b', 'https://example.invalid/a', 'https://example.invalid/c',
  ]);
  assert.equal(harness.writes.length, 0);
  harness.addSpacer.click();
  assert.equal(harness.localStorage.getItem(legacyStorageKey), legacy);
  assert.deepEqual(JSON.parse(harness.localStorage.getItem(storageKey)), harness.order());
}

function testGroupsMigrateAndSaveTheirOrderIndependently() {
  const legacy = JSON.stringify(['b', 'x', 'a', 'y'].map(id => `https://example.invalid/${id}`));
  const harness = createHarness(undefined, ['a', 'b'], legacy, [{name: 'study', rows: ['x', 'y']}]);
  const study = harness.extraBodies[0];
  assert.deepEqual(harness.order(), ['https://example.invalid/b', 'https://example.invalid/a']);
  assert.deepEqual(study.rows.map(row => row.dataset.orderId), [
    'https://example.invalid/x', 'https://example.invalid/y',
  ]);
  harness.moveByKeyboard(study.rows[0]);
  assert.deepEqual(study.rows.map(row => row.dataset.orderId), [
    'https://example.invalid/y', 'https://example.invalid/x',
  ]);
  assert.deepEqual(harness.order(), ['https://example.invalid/b', 'https://example.invalid/a']);
  assert.deepEqual(JSON.parse(harness.localStorage.getItem('webui.row-order.v2.study')),
    ['https://example.invalid/y', 'https://example.invalid/x']);
  assert.equal(harness.localStorage.getItem(storageKey), null);
  assert.equal(harness.localStorage.getItem(legacyStorageKey), legacy);
  harness.reset.click();
  assert.deepEqual(harness.order(), ['https://example.invalid/a', 'https://example.invalid/b']);
  assert.deepEqual(study.rows.map(row => row.dataset.orderId), [
    'https://example.invalid/x', 'https://example.invalid/y',
  ]);
}

function testOutsideReleaseDoesNotStrandPointerState() {
  for (const type of ['pointerup', 'pointercancel']) {
    const harness = createHarness(undefined);
    const before = harness.order();
    harness.startPointer();
    harness.releaseOutside(type, 8);
    harness.moveByKeyboard();
    assert.deepEqual(harness.order(), before, '別のポインターでは移動中状態を解除しない');
    harness.releaseOutside(type);
    harness.moveByKeyboard();
    assert.notDeepEqual(harness.order(), before, `${type}の後も並べ替えできる`);
    assert.deepEqual(JSON.parse(harness.localStorage.getItem(storageKey)), harness.order());
  }
}

testMissingKeyStillSavesNormally();
testJsonNullIsPreservedUntilExplicitReset();
testValidOrderHandlesNewAndDeletedRows();
testLegacyOrderIsMigratedWithoutOverwritingTheOriginal();
testGroupsMigrateAndSaveTheirOrderIndependently();
testOutsideReleaseDoesNotStrandPointerState();
console.log('row-order storage no-bind tests passed');
