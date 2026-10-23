/* 行順はこのブラウザ内に保存。リンク操作とドラッグ操作を分離する。 */
(function () {
  'use strict';
  const body = document.querySelector('table tbody');
  if (!body) return;
  const original = Array.from(body.rows);
  const key = 'webui.row-order.v1';
  const status = document.getElementById('order-status');
  const reset = document.getElementById('reset-order');
  const rows = () => Array.from(body.rows);
  let drag = null, frame = 0;
  original.forEach(row => {
    const link = row.querySelector('.repo-link');
    row.dataset.orderId = link.href;
    const cell = row.cells[0];
    cell.replaceChildren();
    const number = document.createElement('span');
    number.className = 'row-number';
    const handle = document.createElement('button');
    handle.type = 'button'; handle.className = 'row-handle'; handle.textContent = '⠿';
    const name = row.querySelector('.service-link').textContent;
    handle.setAttribute('aria-label', name + 'の順序を変更');
    handle.setAttribute('aria-describedby', 'order-help');
    handle.title = 'ドラッグ、または Alt＋↑／↓ で移動';
    cell.append(number, handle);
  });
  function refresh() {
    rows().forEach((r, i) => r.querySelector('.row-number').textContent = i + 1);
    reset.disabled = rows().every((r, i) => r === original[i]);
  }
  function save(message) {
    refresh();
    try { localStorage.setItem(key, JSON.stringify(rows().map(r => r.dataset.orderId))); }
    catch (_) { message += ' このブラウザでは保存できないため、再読込で元に戻ります。'; }
    status.textContent = message;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(saved)) {
      const remaining = new Map(original.map(r => [r.dataset.orderId, r]));
      for (const id of saved) if (remaining.has(id)) { body.append(remaining.get(id)); remaining.delete(id); }
      remaining.forEach(r => body.append(r));
    }
  } catch (_) { /* 壊れた保存値は初期順へ戻す。 */ }
  refresh();
  function place(y) {
    const other = rows().filter(r => r !== drag.row);
    const next = other.find(r => { const box = r.getBoundingClientRect(); return y < box.top + box.height / 2; });
    body.insertBefore(drag.row, next || null);
    refresh();
  }
  function tick() {
    if (!drag) return;
    if (drag.active) {
      const edge = 65, y = drag.y;
      const dy = y < edge ? -12 : y > innerHeight - edge ? 12 : 0;
      if (dy) { window.scrollBy(0, dy); place(y); }
    }
    frame = requestAnimationFrame(tick);
  }
  function finish(cancelled) {
    if (!drag) return;
    const d = drag; drag = null; cancelAnimationFrame(frame);
    if (cancelled) d.before.forEach(r => body.append(r));
    d.row.classList.remove('row-dragging');
    document.documentElement.classList.remove('ordering');
    if (d.handle.hasPointerCapture(d.id)) d.handle.releasePointerCapture(d.id);
    refresh(); d.handle.focus({preventScroll:true});
    if (d.active && !cancelled) save('順序を保存しました。' + (rows().indexOf(d.row) + 1) + '番目に移動しました。');
    if (cancelled) status.textContent = '移動を取り消しました。';
  }
  body.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.row-handle');
    if (!handle || e.button !== 0 || !e.isPrimary || drag) return;
    e.preventDefault(); handle.focus();
    drag = {row:handle.closest('tr'), handle, id:e.pointerId, y:e.clientY, start:e.clientY, before:rows(), active:false};
    handle.setPointerCapture(e.pointerId); frame = requestAnimationFrame(tick);
  });
  body.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.y = e.clientY;
    if (!drag.active && Math.abs(drag.y - drag.start) < 5) return;
    drag.active = true;
    drag.row.classList.add('row-dragging'); document.documentElement.classList.add('ordering');
    place(e.clientY);
    // DOMの並べ替え後にもキャプチャを維持する。
    drag.handle.setPointerCapture(e.pointerId);
  });
  body.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.id) finish(false); });
  body.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.id) finish(true); });
  window.addEventListener('blur', () => finish(true));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drag) { e.preventDefault(); finish(true); return; }
    const handle = e.target.closest('.row-handle');
    if (!handle || !e.altKey || !['ArrowUp','ArrowDown'].includes(e.key) || drag) return;
    e.preventDefault(); const row = handle.closest('tr');
    const sibling = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling) return;
    body.insertBefore(row, e.key === 'ArrowUp' ? sibling : sibling.nextElementSibling);
    handle.focus(); save((rows().indexOf(row) + 1) + '番目に移動して保存しました。');
  });
  reset.addEventListener('click', () => {
    finish(true); original.forEach(r => body.append(r)); save('初期順に戻しました。');
  });
})();
