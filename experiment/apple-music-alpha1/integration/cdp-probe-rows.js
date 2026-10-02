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
  const boot = await send('Runtime.evaluate', { expression: 'String(Math.round((Date.now() - performance.timeOrigin)/1000))', returnByValue: true });
  console.log('renderer age (s): ' + String(boot && boot.result && boot.result.value));
  const expr = `(async () => { const amc = window.mineradio && window.mineradio.amc; const out = []; const tracks = ['In Your Eyes','Faith']; for (const t of tracks) { const r = await amc.playAlbum({ name: 'After Hours', track: t, scopeLabel: '你的资料库', sectionLabel: '专辑' }); out.push({ track: t, stage: r && r.stage, target: r && r.aimTarget, aim: r && r.aimPoint, badge: r && r.badgeRect, title: r && r.titleRect, warn: r && r.aimWarn, dbl: r && r.trackDoubleClicked, attempts: (r && r.trackAttempts) || [] }); } return JSON.stringify(out); })()`;
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log('ROWS ' + String(res && res.result && res.result.value));
  process.exit(0);
})().catch((e) => { console.log('cdp error: ' + String(e && e.message || e)); process.exit(0); });