(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    const onMsg = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id === myId) { ws.removeEventListener('message', onMsg); resolve(m.result); } };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method: method, params: params || {} }));
  });
  await new Promise((res) => { ws.onopen = res; });
  const expr = `(async () => {
    const probe = async (raw) => {
      const url = '/api/apple/playlist/tracks?id=' + encodeURIComponent(raw) + '&limit=5&offset=0';
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        const j = await res.json();
        return { sent: raw, status: res.status, tracks: (j.tracks || []).length, total: j.total, hasMore: j.hasMore, error: j.error || '', keys: Object.keys(j).length };
      } catch (e) { return { sent: raw, fetchError: String(e && e.message || e) }; }
    };
    return JSON.stringify({ plain: await probe('p.2P6Wg5KCVWOK3m2'), prefixed: await probe('apple:p.2P6Wg5KCVWOK3m2') });
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log(String(r && r.result && r.result.value).slice(0, 800));
  process.exit(0);
})().catch((e) => { console.log('probe error: ' + String(e && e.message || e)); process.exit(0); });