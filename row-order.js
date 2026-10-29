/* 行順はこのブラウザ内に保存。
   2列グリッド対応、position:fixedフローティングドラッグ（瞬間移動・ズレの完全防止）、
   リアルタイムプレースホルダー、FLIPスライドアニメーション、隙間マス対応。 */
(function () {
  'use strict';
  const body = document.querySelector('table tbody');
  if (!body) return;
  const original = Array.from(body.rows);
  const key = 'webui.row-order.v1';
  const status = document.getElementById('order-status');
  const reset = document.getElementById('reset-order');
  const addSpacer = document.getElementById('add-spacer');
  const rows = () => Array.from(body.rows).filter(r => !r.classList.contains('drag-placeholder') && r.style.position !== 'fixed');
  const maxSpacers = 100;
  let drag = null, suppressClick = false, invalidSavedOrder = false;

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
      reset.disabled = !invalidSavedOrder && !hasSpacer && current.every((r, i) => r === original[i]);
    }
  }

  function save(message) {
    refresh();
    if (invalidSavedOrder) {
      if (status) status.textContent = message + ' 保存済みの順序を保護しています。保存を再開するには初期順に戻してください。';
      return;
    }
    try { localStorage.setItem(key, JSON.stringify(rows().map(r => r.dataset.orderId))); }
    catch (_) { message += ' このブラウザでは保存できないため、再読込で元に戻ります。'; }
    if (status) status.textContent = message;
  }

  try {
    const raw = localStorage.getItem(key);
    const saved = raw === null ? null : JSON.parse(raw);
    const ids = original.map(r => r.dataset.orderId);
    const duplicateIds = new Set(ids).size !== ids.length || ids.some(id => !id);
    const invalidList = raw !== null && (!Array.isArray(saved) ||
      saved.some(id => typeof id !== 'string') ||
      saved.filter(id => id.startsWith('spacer:')).length > maxSpacers ||
      new Set(saved).size !== saved.length);
    if (duplicateIds || invalidList) {
      invalidSavedOrder = true;
      if (status) status.textContent = '保存順を安全に復元できないため初期順で表示しています。保存データは保持しています。';
    } else if (saved) {
      const remaining = new Map(original.map(r => [r.dataset.orderId, r]));
      body.replaceChildren();
      for (const id of saved) {
        if (id.startsWith('spacer:')) {
          body.append(createSpacerRow(id));
        } else if (remaining.has(id)) {
          body.append(remaining.get(id));
          remaining.delete(id);
        }
      }
      remaining.forEach(r => body.append(r));
    }
  } catch (_) {
    invalidSavedOrder = true;
    if (status) status.textContent = '保存順を読み取れないため初期順で表示しています。保存データは保持しています。';
  }
  refresh();

  function cleanupTransforms() {
    Array.from(body.children).forEach(r => {
      if (!drag || r !== drag.row) {
        r.style.transform = '';
        r.style.transition = '';
      }
    });
  }

  // プレースホルダーの挿入位置更新とFLIPアニメーション
  function updatePlaceholder(clientX, clientY) {
    if (!drag || !drag.placeholder) return;

    const bodyRect = body.getBoundingClientRect();
    const mx = clientX - bodyRect.left;
    const my = clientY - bodyRect.top;

    // グリッド内の全要素（プレースホルダーを含む、ドラッグ中のfixed行は除く）
    const gridItems = Array.from(body.children).filter(r => r !== drag.row);
    if (gridItems.length <= 1) return;

    const pIndex = gridItems.indexOf(drag.placeholder);
    if (pIndex === -1) return;

    // 各要素の静的中心座標（offsetLeft/offsetTop は CSS transform の影響を受けない）
    let closestItem = null;
    let minDistance = Infinity;

    gridItems.forEach((r, idx) => {
      const cx = r.offsetLeft + r.offsetWidth / 2;
      const cy = r.offsetTop + r.offsetHeight / 2;
      let dist = Math.hypot(mx - cx, my - cy);

      // 現在のプレースホルダー位置に吸着バイアス（ヒステリシス）を付与
      // 別のカードの中心に明確に近づくまで、現在の位置をキープする
      if (idx === pIndex) {
        dist *= 0.65; // 35%の吸着バイアスでチャタリング・ちらつきを完全防止
      }

      if (dist < minDistance) {
        minDistance = dist;
        closestItem = r;
      }
    });

    // 最も近いのが現在のプレースホルダーなら、何もしない（安定静止）
    if (!closestItem || closestItem === drag.placeholder) {
      return;
    }

    const tIndex = gridItems.indexOf(closestItem);
    // 挿入先の計算:
    // プレースホルダーより後方の要素に向かって移動したなら、その要素の後ろへ
    // プレースホルダーより前方の要素に向かって移動したなら、その要素の前へ
    const nextSibling = (pIndex < tIndex) ? closestItem.nextElementSibling : closestItem;

    // すでにその位置にある場合は何もしない
    if (drag.placeholder === nextSibling || drag.placeholder.nextElementSibling === nextSibling) {
      return;
    }

    // FLIP: 移動前の全グリッド要素の画面上Rectを記録
    const firstRects = new Map();
    gridItems.forEach(r => {
      if (r !== drag.placeholder) {
        firstRects.set(r, r.getBoundingClientRect());
      }
    });

    // DOM 移動
    body.insertBefore(drag.placeholder, nextSibling);
    refresh();

    // FLIP アニメーション適用（滑らかに退避移動）
    gridItems.forEach(r => {
      if (r === drag.placeholder) return;
      const first = firstRects.get(r);
      if (!first) return;
      const last = r.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;

      if (dx !== 0 || dy !== 0) {
        r.style.transition = 'none';
        r.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        r.offsetHeight; // 強制リフローで初期位置を確定
        r.style.transition = 'transform 0.22s cubic-bezier(0.2, 0, 0, 1)';
        r.style.transform = '';
      }
    });
  }

  function finish(cancelled) {
    if (!drag) return;
    const d = drag; drag = null;

    if (d.placeholder) {
      if (!cancelled) {
        body.insertBefore(d.row, d.placeholder);
      }
      d.placeholder.remove();
    }

    if (cancelled) {
      body.replaceChildren();
      d.before.forEach(r => body.append(r));
    }

    // fixed スタイルを完全にリセット
    d.row.classList.remove('row-dragging');
    d.row.style.position = '';
    d.row.style.left = '';
    d.row.style.top = '';
    d.row.style.width = '';
    d.row.style.height = '';
    d.row.style.margin = '';
    d.row.style.zIndex = '';
    d.row.style.transform = '';
    d.row.style.pointerEvents = '';
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
    const row = handle.closest('tr');
    drag = {
      row,
      handle,
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      before: rows(),
      active: false,
      placeholder: null,
      initialBox: null
    };
  });

  body.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (!drag.active) {
      if (Math.hypot(dx, dy) < 6) return;
      drag.active = true;

      // 移動前の矩形を正確に記録
      const box = drag.row.getBoundingClientRect();
      drag.initialBox = box;

      // プレースホルダーの生成と配置
      const ph = document.createElement('tr');
      ph.className = 'drag-placeholder ' + (drag.row.classList.contains('spacer-slot') ? 'spacer-placeholder' : 'app-placeholder');
      const td = document.createElement('td');
      td.colSpan = 4;
      ph.append(td);
      ph.style.height = box.height + 'px';
      ph.style.minHeight = box.height + 'px';

      drag.placeholder = ph;
      // 元の位置にプレースホルダーを配置
      body.insertBefore(ph, drag.row);

      // ドラッグ要素をグリッドフローから完全に切り離し、fixed で浮かせる（瞬間移動・ズレの完全防止）
      drag.row.classList.add('row-dragging');
      drag.row.style.position = 'fixed';
      drag.row.style.left = box.left + 'px';
      drag.row.style.top = box.top + 'px';
      drag.row.style.width = box.width + 'px';
      drag.row.style.height = box.height + 'px';
      drag.row.style.margin = '0';
      drag.row.style.zIndex = '9999';
      drag.row.style.pointerEvents = 'none';

      document.documentElement.classList.add('ordering');
      try { drag.handle.setPointerCapture(e.pointerId); } catch (_) {}
    }

    // fixed な要素を移動量 (dx, dy) でピタッとマウスに追従！
    drag.row.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.03)`;

    // 画面端の自動スクロール
    const edge = 65, y = e.clientY;
    if (y < edge) window.scrollBy(0, -10);
    else if (y > innerHeight - edge) window.scrollBy(0, 10);

    // プレースホルダーの移動と周囲要素のFLIPスライド
    updatePlaceholder(e.clientX, e.clientY);
  });

  body.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.id) finish(false); });
  body.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.id) finish(true); });
  window.addEventListener('blur', () => finish(true));

  // キーボード移動時もFLIPアニメーション
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drag) { e.preventDefault(); finish(true); return; }
    const handle = e.target.closest('.row-handle');
    if (!handle || !e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key) || drag) return;
    e.preventDefault();
    const row = handle.closest('tr');
    const isPrev = e.key === 'ArrowUp';
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
      if (rows().filter(r => r.classList.contains('spacer-slot')).length >= maxSpacers) {
        if (status) status.textContent = '隙間は100個まで追加できます。';
        return;
      }
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
      const ids = original.map(r => r.dataset.orderId);
      invalidSavedOrder = ids.some(id => !id) || new Set(ids).size !== ids.length;
      save('初期順に戻しました。');
    });
  }
})();
