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
  const expr = 'JSON.stringify(((window.shelfManager&&window.shelfManager.getCards)?window.shelfManager.getCards():[]).map((c)=>({t:(c.item&&c.item.title)||\'\',p:(c.item&&c.item.provider)||\'\',pid:(c.item&&c.item.playlistId)||\'\'})).slice(0,6))';
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('cards: ' + String(r && r.result && r.result.value));
  process.exit(0);
})().catch((e) => { console.log('probe error: ' + String(e && e.message || e)); process.exit(0); });