(() => {
  const button = document.querySelector('#observation-times');
  const summary = document.querySelector('#observation-times-result');
  if (!button || !summary) return;
  const rows = new Map(Array.from(document.querySelectorAll('[data-observation-id]'), node => [node.dataset.observationId, node]));
  const endpoint = button.dataset.endpoint;
  const missing = node => node.dataset.observationCompact === 'true'
    ? '観測未確認' : '観測時刻：未確認（遷移先で確認）';
  const staleAfter = 25 * 60 * 1000;
  let lastTimes = null, freshnessTimer = null;

  function clearFreshnessTimer() {
    if (freshnessTimer !== null) clearTimeout(freshnessTimer);
    freshnessTimer = null;
  }

  // 経過時間だけを再評価し、状態APIには追加でアクセスしない。
  function renderFreshness() {
    clearFreshnessTimer();
    if (!lastTimes) return 0;
    const now = Date.now();
    let displayed = 0, hasStale = false, nextChange = Infinity;
    for (const [id, node] of rows) {
      if (!lastTimes.has(id)) continue;
      const time = lastTimes.get(id);
      const compact = node.dataset.observationCompact === 'true';
      const stale = now - time > staleAfter;
      const text = (compact ? (stale ? '前回：' : '観測：') : (stale ? '前回の観測：' : '観測時刻：')) +
        new Date(time).toLocaleString('ja-JP');
      if (node.textContent !== text) node.textContent = text;
      displayed++;
      if (stale) hasStale = true;
      if (!stale) nextChange = Math.min(nextChange, time + staleAfter + 1);
    }
    if (displayed) {
      const text = (hasStale ? '前回の観測時刻を表示しています。' : '観測時刻を取得しました。') +
        '表示はこの端末の時刻設定に従います。';
      if (summary.textContent !== text) summary.textContent = text;
    }
    if (Number.isFinite(nextChange) && !document.hidden) {
      const delay = Math.max(1, Math.min(nextChange - Date.now(), 2147483647));
      freshnessTimer = setTimeout(renderFreshness, delay);
    }
    return displayed;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearFreshnessTimer();
    else renderFreshness();
  });
  window.addEventListener('pageshow', () => renderFreshness());

  button.addEventListener('click', async () => {
    clearFreshnessTimer();
    lastTimes = null;
    button.disabled = true;
    summary.textContent = '観測時刻を確認中…';
    for (const node of rows.values()) node.textContent = missing(node);
    const controller = new AbortController();
    let timeout;
    try {
      // 中断に応じない通信や本文取得でも、画面の操作を期限内に解放する。
      const request = (async () => {
        const response = await fetch(endpoint, {credentials:'omit', redirect:'error', cache:'no-store',
          referrerPolicy:'no-referrer', signal:controller.signal});
        if (!response.ok) throw Error('unavailable');
        return response.json();
      })();
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(Error('timeout'));
        }, 2500);
      });
      const data = await Promise.race([request, deadline]);
      if (!Array.isArray(data) || data.length > 100) throw Error('invalid response');
      const byId = new Map();
      let collectedAt;
      for (const item of data) {
        if (!item || Object.keys(item).sort().join(',') !== 'collected_at,id' ||
            typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.id) ||
            byId.has(item.id) || typeof item.collected_at !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(item.collected_at) ||
            (collectedAt && collectedAt !== item.collected_at)) throw Error('invalid entry');
        const time = Date.parse(item.collected_at);
        if (!Number.isFinite(time) || time > Date.now()) throw Error('invalid time');
        collectedAt = item.collected_at;
        byId.set(item.id,time);
      }
      lastTimes = byId;
      if (!renderFreshness()) summary.textContent = '観測時刻は未確認です。';
    } catch {
      clearFreshnessTimer();
      lastTimes = null;
      summary.textContent = '観測時刻は未確認です。状態を見るリンクから確認できます。';
    } finally {
      clearTimeout(timeout);
      button.disabled = false;
    }
  });
})();
