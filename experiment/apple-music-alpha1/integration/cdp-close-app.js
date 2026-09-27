// Turn stealth ON, then close the MineRadio window gracefully (which must exit stealth mode).
(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const send = (id, expression) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 20000);
    const onMsg = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id === id) { clearTimeout(timer); ws.removeEventListener('message', onMsg); resolve(m.result && m.result.result && m.result.result.value); } };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: id, method: 'Runtime.evaluate', params: { expression: expression, awaitPromise: true, returnByValue: true } }));
  });
  await new Promise((res) => { ws.onopen = res; });
  const on = await send(1, "window.mineradio.appleStealthSet(true).then(r => JSON.stringify(r.status))");
  console.log('enabled:', on);
  await new Promise((r) => setTimeout(r, 3000));
  await send(2, 'window.close(), "closing"');
  console.log('close requested');
  setTimeout(() => process.exit(0), 1500);
})();