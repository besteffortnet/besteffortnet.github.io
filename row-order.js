/* 行順はこのブラウザ内に保存。
   2列グリッド対応、ドラッグ時のFLIPスライドアニメーション、隙間のマス（スペーサー）に対応。 */
(function () {
  'use strict';
  const body = document.querySelector('table tbody');
  if (!body) return;
  const original = Array.from(body.rows);
  const key = 'webui.row-order.v1';
  const status = document.getElementById('order-status');
  const reset = document.getElementById('reset-order');
  const addSpacer = document.getElementById('add-spacer');
  const rows = () => Array.from(body.rows);
  let drag = null, frame = 0, suppressClick = false;

  function initAppRow(row) {
    row.classList.add('app-card');
    const link = row.querySelector('.repo-link');
    if (link) row.dataset.orderId = link.href;

    const cell = row.cells[0];
    cell.replaceChildren();
    const number = document.createElement('span');
    number.className = 'row-number';
    cell.append(number);

    const handle = row.querySelector('.service-link');
    if (handle) {
      handle.classList.add('row-handle');
      handle.setAttribute('draggable', 'false');
      handle.setAttribute('aria-describedby', 'order-help');
      handle.title = 'ドラッグで移動（クリックで開く）';
    }
  }

  function createSpacerRow(id) {
    const tr = document.createElement('tr');
    tr.className = 'spacer-slot row-handle';
    tr.dataset.orderId = id || ('spacer:' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
    tr.setAttribute('draggable', 'false');
    tr.title = 'ドラッグで移動';

    const td = document.createElement('td');
    td.colSpan = 4;

    const label = document.createElement('span');
    label.className = 'spacer-label';
    label.textContent = '隙間';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'spacer-remove';
    removeBtn.setAttribute('aria-label', '隙間を削除');
    removeBtn.title = 'この隙間を削除';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      tr.remove();
      refresh();
      save('隙間のマスを削除しました。');
    });

    td.append(label, removeBtn);
    tr.append(td);
    return tr;
  }

  original.forEach(initAppRow);

  function refresh() {
    let count = 0;
    rows().forEach(r => {
      if (r.classList.contains('app-card')) {
        count++;
        const num = r.querySelector('.row-number');
        if (num) num.textContent = count;
      }
    });
    if (reset) {
      const current = rows();
      const hasSpacer = current.some(r => r.classList.contains('spacer-slot'));
      reset.disabled = !hasSpacer && current.every((r, i) => r === original[i]);
    }
  }

  function save(message) {
    refresh();
    try { localStorage.setItem(key, JSON.stringify(rows().map(r => r.dataset.orderId))); }
    catch (_) { message += ' このブラウザでは保存できないため、再読込で元に戻ります。'; }
    if (status) status.textContent = message;
  }

  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(saved)) {
      const remaining = new Map(original.map(r => [r.dataset.orderId, r]));
      body.replaceChildren();
      for (const id of saved) {
        if (typeof id === 'string' && id.startsWith('spacer:')) {
          body.append(createSpacerRow(id));
        } else if (remaining.has(id)) {
          body.append(remaining.get(id));
          remaining.delete(id);
        }
      }
      remaining.forEach(r => body.append(r));
    }
  } catch (_) { /* 壊れた保存値は初期順へ戻す。 */ }
  refresh();

  function cleanupTransforms() {
    rows().forEach(r => {
      r.style.transform = '';
      r.style.transition = '';
    });
  }

  // FLIPアニメーションで移動先オブジェクトを滑らかに退避
  function place(x, y) {
    const other = rows().filter(r => r !== drag.row);
    const next = other.find(r => {
      const box = r.getBoundingClientRect();
      if (y < box.top) return true;
      if (y <= box.bottom) {
        if (x < box.left + box.width / 2) return true;
      }
      return false;
    }) || null;

    // 挿入位置が変わっていないならDOM変更・アニメーションを行わない
    if (drag.row.nextElementSibling === next) {
      return;
    }

    // 1. First: 移動前の全カードの矩形位置を記録
    const firstRects = new Map();
    rows().forEach(r => {
      firstRects.set(r, r.getBoundingClientRect());
    });

    // 2. DOMの順序変更
    body.insertBefore(drag.row, next);
    refresh();

    // 3. Last & Invert & Play: 移動したカードをスライドアニメーション
    rows().forEach(r => {
      if (r === drag.row) return; // 掴んでいるカード自身は別スタイリング
      const first = firstRects.get(r);
      if (!first) return;
      const last = r.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;

      if (dx !== 0 || dy !== 0) {
        r.style.transition = 'none';
        r.style.transform = `translate(${dx}px, ${dy}px)`;
        // 強制リフローで transform を適用
        r.offsetHeight;
        r.style.transition = 'transform 0.22s cubic-bezier(0.2, 0, 0, 1)';
        r.style.transform = '';
      }
    });
  }

  function tick() {
    if (!drag) return;
    if (drag.active) {
      const edge = 65, y = drag.y;
      const dy = y < edge ? -12 : y > innerHeight - edge ? 12 : 0;
      if (dy) { window.scrollBy(0, dy); place(drag.x, y); }
    }
    frame = requestAnimationFrame(tick);
  }

  function finish(cancelled) {
    if (!drag) return;
    const d = drag; drag = null; cancelAnimationFrame(frame);
    if (cancelled) {
      body.replaceChildren();
      d.before.forEach(r => body.append(r));
    }
    d.row.classList.remove('row-dragging');
    document.documentElement.classList.remove('ordering');
    try {
      if (d.handle.hasPointerCapture(d.id)) d.handle.releasePointerCapture(d.id);
    } catch (_) {}
    cleanupTransforms();
    refresh();
    if (d.active) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 120);
      d.handle.focus({preventScroll:true});
      if (!cancelled) save('順序を保存しました。');
    }
    if (cancelled && status) status.textContent = '移動を取り消しました。';
  }

  body.addEventListener('dragstart', e => {
    if (e.target.closest('.row-handle')) e.preventDefault();
  });

  body.addEventListener('click', e => {
    if (suppressClick && e.target.closest('.row-handle')) {
      e.preventDefault();
      e.stopPropagation();
      suppressClick = false;
    }
  }, true);

  body.addEventListener('pointerdown', e => {
    if (e.target.closest('.spacer-remove')) return;
    const handle = e.target.closest('.row-handle');
    if (!handle || e.button !== 0 || !e.isPrimary || drag) return;
    drag = {
      row: handle.closest('tr'),
      handle,
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      before: rows(),
      active: false
    };
  });

  body.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
      drag.active = true;
      try { drag.handle.setPointerCapture(e.pointerId); } catch (_) {}
      drag.row.classList.add('row-dragging');
      document.documentElement.classList.add('ordering');
      frame = requestAnimationFrame(tick);
    }
    place(e.clientX, e.clientY);
  });

  body.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.id) finish(false); });
  body.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.id) finish(true); });
  window.addEventListener('blur', () => finish(true));

  // キーボード移動時もFLIPアニメーションを適用
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drag) { e.preventDefault(); finish(true); return; }
    const handle = e.target.closest('.row-handle');
    if (!handle || !e.altKey || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key) || drag) return;
    e.preventDefault();
    const row = handle.closest('tr');
    const isPrev = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
    const sibling = isPrev ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling) return;

    const firstRects = new Map();
    rows().forEach(r => firstRects.set(r, r.getBoundingClientRect()));

    body.insertBefore(row, isPrev ? sibling : sibling.nextElementSibling);
    refresh();

    rows().forEach(r => {
      const first = firstRects.get(r);
      if (!first) return;
      const last = r.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (dx !== 0 || dy !== 0) {
        r.style.transition = 'none';
        r.style.transform = `translate(${dx}px, ${dy}px)`;
        r.offsetHeight;
        r.style.transition = 'transform 0.22s cubic-bezier(0.2, 0, 0, 1)';
        r.style.transform = '';
      }
    });

    handle.focus();
    save('順序を保存しました。');
  });

  // 概要トグルスイッチの開閉
  body.addEventListener('change', e => {
    if (e.target.matches('.desc-switch')) {
      const cell = e.target.closest('td');
      if (cell) {
        const text = cell.querySelector('.desc-text');
        if (text) text.hidden = !e.target.checked;
      }
    }
  });

  // 隙間のマスを追加するボタン
  if (addSpacer) {
    addSpacer.addEventListener('click', () => {
      const spacer = createSpacerRow();
      body.append(spacer);
      refresh();
      save('隙間のマスを追加しました。ドラッグして任意の位置へ移動できます。');
    });
  }

  // 初期順に戻すボタン
  if (reset) {
    reset.addEventListener('click', () => {
      finish(true);
      body.replaceChildren();
      original.forEach(r => body.append(r));
      save('初期順に戻しました。');
    });
  }
})();
