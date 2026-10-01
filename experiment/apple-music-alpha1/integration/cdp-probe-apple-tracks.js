// A: read-only probe of the route the desktop detail panel uses for Apple playlists.
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
    const pls = Array.isArray(window.applePlaylists) ? window.applePlaylists : [];
    const out = { count: pls.length, sample: pls.slice(0, 4).map((p) => ({ name: p && p.name, id: p && p.id, trackCount: p && p.trackCount })) };
    const target = pls.find((p) => p && /回忆/.test(String(p.name))) || pls[0];
    if (!target) return JSON.stringify(out);
    const pid = String(target.id || '').replace(/^apple:/, '');
    const url = '/api/apple/playlist/tracks?id=' + encodeURIComponent(pid) + '&limit=24&offset=0';
    out.probe = { name: target.name, id: pid, url: url };
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      const text = await res.text();
      out.probe.status = res.status;
      out.probe.body = text.slice(0, 600);
      try { const j = JSON.parse(text); out.probe.parsed = { keys: Object.keys(j), tracks: (j.tracks || []).length, total: j.total, hasMore: j.hasMore, error: j.error, message: j.message }; } catch (e) { }
    } catch (e) { out.probe.fetchError = String(e && e.message || e); }
    return JSON.stringify(out);
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log(String(r && r.result && r.result.value).slice(0, 1400));
  process.exit(0);
})().catch((e) => { console.log('probe error: ' + String(e && e.message || e)); process.exit(0); });