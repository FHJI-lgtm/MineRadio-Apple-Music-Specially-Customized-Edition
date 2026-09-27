// Drive a REAL AMC play through the app's own renderer IPC (the gated path).
const fs = require('fs');
(async () => {
  const out = { at: new Date().toISOString() };
  try {
    const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const track = JSON.stringify({ title: 'Blinding Lights', artist: 'Teddy Swims', trackId: 1513133940, storefront: 'us' });
    const expr = 'window.mineradio.amc.playTrack(' + track + ').then(r => JSON.stringify({ ok: r.ok, verified: r.verified, stage: r.stage, actual: r.actual }))';
    out.result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdp timeout')), 60000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
      ws.onerror = () => reject(new Error('ws error'));
      ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id === 1) { clearTimeout(timer); try { ws.close(); } catch (e) {} resolve(m.result && m.result.result && m.result.result.value); } };
    });
  } catch (e) { out.error = String(e && e.message || e); }
  fs.writeFileSync(process.argv[2] || 'amc-gated-play.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
})();