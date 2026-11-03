(() => {
  const button = document.querySelector('#observation-times');
  const summary = document.querySelector('#observation-times-result');
  if (!button || !summary) return;
  const rows = new Map(Array.from(document.querySelectorAll('[data-observation-id]'), node => [node.dataset.observationId, node]));
  const endpoint = button.dataset.endpoint;
  const missing = '観測時刻：未確認（遷移先で確認）';
  button.addEventListener('click', async () => {
    button.disabled = true;
    summary.textContent = '観測時刻を確認中…';
    for (const node of rows.values()) node.textContent = missing;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(endpoint, {credentials:'omit', redirect:'error', cache:'no-store',
        referrerPolicy:'no-referrer', signal:controller.signal});
      if (!response.ok) throw Error('unavailable');
      const data = await response.json();
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
      let displayed = 0;
      for (const [id,node] of rows) {
        if (!byId.has(id)) continue;
        const time = byId.get(id);
        node.textContent = (Date.now()-time > 25*60*1000 ? '前回の観測：' : '観測時刻：') +
          new Date(time).toLocaleString('ja-JP');
        displayed++;
      }
      summary.textContent = displayed ? '観測時刻を取得しました。表示はこの端末の時刻設定に従います。' : '観測時刻は未確認です。';
    } catch {
      summary.textContent = '観測時刻は未確認です。状態を見るリンクから確認できます。';
    } finally {
      clearTimeout(timeout);
      button.disabled = false;
    }
  });
})();
