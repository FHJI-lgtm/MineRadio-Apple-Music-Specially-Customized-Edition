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
  const expr = `(async () => { const amc = window.mineradio && window.mineradio.amc; const r = await amc.playAlbum({ name: 'After Hours', track: 'Faith', scopeLabel: '你的资料库', sectionLabel: '专辑' }); return JSON.stringify({ stage: r && r.stage, smtcTitle: r && r.smtcTitle, matchedName: r && r.trackMatchedName, picked: r && r.pickedName }); })()`;
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log('BASELINE ' + String(res && res.result && res.result.value));
  process.exit(0);
})().catch((e) => { console.log('BASELINE_ERR ' + String(e && e.message || e)); process.exit(0); });