(async () => {
  let list;
  try { list = await (await fetch('http://127.0.0.1:9222/json/list')).json(); } catch (e) { console.log('no cdp: ' + String(e.message)); process.exit(0); }
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
  const expr = '(() => { const m = window.shelfManager; const items = (m.getCards ? m.getCards() : []).map((c) => c.item).filter((it) => it && it.provider === \'apple\');'
    + ' return JSON.stringify({ playlists: window.applePlaylists ? window.applePlaylists.slice(0, 5) : null, shelfItems: items.slice(0, 5) }); })()';
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('data:', String(r && r.result && r.result.value).slice(0, 900));
  process.exit(0);
})().catch((e) => { console.log('probe error: ' + String(e && e.message || e)); process.exit(0); });