// Toggle the stealth mode from the running renderer (read/write via the app's own IPC).
const fs = require('fs');
const enabled = process.argv[2] === 'on';
(async () => {
  const out = { at: new Date().toISOString(), enabled: enabled };
  try {
    const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const expr = 'window.mineradio.appleStealthSet(' + (enabled ? 'true' : 'false') + ').then(r => JSON.stringify(r))';
    out.result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdp timeout')), 20000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
      ws.onerror = () => reject(new Error('ws error'));
      ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id === 1) { clearTimeout(timer); try { ws.close(); } catch (e) {} resolve(m.result && m.result.result && m.result.result.value); } };
    });
  } catch (e) { out.error = String(e && e.message || e); }
  console.log(JSON.stringify(out));
})();