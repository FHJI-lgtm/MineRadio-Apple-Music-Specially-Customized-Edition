// Open an Apple playlist card's detail panel through the app's own shelf API and capture the
// renderer console, so the real cause of '3D列表刷新失败' is visible.
const needle = process.argv[2] || '';
(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const logs = [];
  let id = 0;
  const send = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    const onMsg = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id === myId) { ws.removeEventListener('message', onMsg); resolve(m.result); } };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method: method, params: params || {} }));
  });
  await new Promise((res) => { ws.onopen = res; });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ');
      if (/Shelf|playlist|Error|amc/i.test(text)) logs.push(m.params.type + ': ' + text.slice(0, 300));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      logs.push('EXCEPTION: ' + String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 400));
    }
  });
  await send('Runtime.enable');
  const expr = '(() => { const m = window.shelfManager; if (!m) return JSON.stringify({ error: \'no shelfManager\' });'
    + ' const cards = (m.getCards ? m.getCards() : []) || [];'
    + ' const items = cards.map((c) => ({ i: c.index, t: (c.item && c.item.title) || "", p: (c.item && c.item.provider) || "" }));'
    + ' const hit = items.find((x) => x.t.indexOf(' + JSON.stringify(needle) + ') >= 0) || items.find((x) => x.p === \'apple\');'
    + ' if (!hit) return JSON.stringify({ error: \'card not found\', items: items.slice(0, 8) });'
    + ' m.openContent(hit.i); return JSON.stringify({ opened: hit }); })()';
  const r1 = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('action:', r1 && r1.result && r1.result.value);
  await new Promise((r) => setTimeout(r, 5000));
  console.log('console lines:', logs.length);
  console.log(logs.slice(0, 12).join('\n'));
  process.exit(0);
})().catch((e) => { console.log('cdp error: ' + String(e && e.message || e)); process.exit(1); });