// Read the stealth watchdog status out of the running renderer (read-only).
const fs = require('fs');
(async () => {
  const out = { at: new Date().toISOString() };
  try {
    const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) { out.error = 'no page target'; }
    else {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      out.status = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('cdp timeout')), 8000);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.mineradio.appleStealthGet().then(r => JSON.stringify(r))', awaitPromise: true, returnByValue: true } }));
        ws.onerror = () => reject(new Error('ws error'));
        ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id === 1) { clearTimeout(timer); try { ws.close(); } catch (e) {} resolve(m.result && m.result.result && m.result.result.value); } };
      });
    }
  } catch (e) { out.error = String(e && e.message || e); }
  fs.writeFileSync(process.argv[2] || 'stealth-status.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
})();