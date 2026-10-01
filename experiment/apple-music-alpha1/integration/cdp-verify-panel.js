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
  const logs = [];
  await new Promise((res) => { ws.onopen = res; });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.method === 'Runtime.consoleAPICalled') { const t = (m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '); if (/Shelf|apple/i.test(t)) logs.push(t.slice(0, 200)); }
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails || {}; logs.push('EXC: ' + String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 200)); }
  });
  await send('Runtime.enable');
  const expr = `(async () => {
    const out = { fetched: [] };
    const orig = window.fetch;
    window.fetch = function (u, o) { const s = String(u && u.url ? u.url : u); if (s.indexOf('/api/apple/playlist/tracks') >= 0 || s.indexOf('/playlist/tracks') >= 0) { out.fetched.push(s); } return orig.apply(this, arguments); };
    const probe = async (raw) => { try { const r = await orig('/api/apple/playlist/tracks?id=' + encodeURIComponent(raw) + '&limit=5&offset=0', { headers: { accept: 'application/json' } }); const j = await r.json(); return { id: raw, tracks: (j.tracks || []).length, total: j.total, error: j.error || '' }; } catch (e) { return { id: raw, err: String(e && e.message || e) }; } };
    out.myPlaylist = await probe('p.MoGJ98ktvP9kMed');
    out.likedSongs = await probe('p.0YU0g1DPaJ');
    const m = window.shelfManager;
    const cards = (m.getCards ? m.getCards() : []) || [];
    const hit = cards.map((c) => ({ i: c.index, t: (c.item && c.item.title) || '', p: (c.item && c.item.provider) || '' })).find((x) => x.t.indexOf('回忆') >= 0);
    if (hit) { m.openContent(hit.i); out.opened = hit; } else { out.opened = null; }
    await new Promise((r) => setTimeout(r, 4500));
    window.fetch = orig;
    return JSON.stringify(out);
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log('result: ' + String(r && r.result && r.result.value).slice(0, 900));
  console.log('console: ' + logs.slice(0, 6).join(' | '));
  process.exit(0);
})().catch((e) => { console.log('probe error: ' + String(e && e.message || e)); process.exit(0); });