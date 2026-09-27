// Read-only Chromium DevTools Protocol probe for MineRadio's lyric-stage scroll state.
// Uses only built-in Node APIs (fetch + WebSocket). No app code is modified.
//   node cdp-lyrics-probe.js snapshot  <outFile>
//   node cdp-lyrics-probe.js calibrate <outFile>   (scripted +20/-20 scroll on one container,
//                                                   to prove this probe CAN see a change)
const fs = require('fs');
const PORT = process.env.CDP_PORT || 9222;
const MODE = process.argv[2] || 'snapshot';
const OUT = process.argv[3] || 'cdp-lyrics-snapshot.json';
const SNAPSHOT_JS = `(() => {
  const out = { page: location.pathname, title: document.title, containers: [], lyric: {} };
  try {
    const els = Array.from(document.querySelectorAll('*'));
    for (const el of els) {
      const cs = getComputedStyle(el);
      const scrollable = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
      const cls = (typeof el.className === 'string' ? el.className : '');
      const looksLyric = /lyric/i.test(el.id + ' ' + cls);
      const transformed = cs.transform && cs.transform !== 'none';
      if (scrollable || (looksLyric && transformed)) {
        out.containers.push({ tag: el.tagName.toLowerCase(), id: el.id || '', cls: cls.trim().slice(0, 60),
          scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
          transform: String(cs.transform).slice(0, 60), lyric: looksLyric });
      }
    }
  } catch (e) { out.domError = String(e); }
  try {
    if (typeof scrollState !== 'undefined' && scrollState) {
      out.lyric.scrollState = { needed: !!scrollState.needed, overflow: Number(scrollState.overflow) || 0, limit: Number(scrollState.limit) || 0, offset: Number(scrollState.offset) || 0, dir: Number(scrollState.dir) || 0 };
    } else { out.lyric.scrollState = null; }
  } catch (e) { out.lyric.scrollStateError = String(e); }
  try { if (window.__mineradioPerfSnapshot) out.perf = window.__mineradioPerfSnapshot(); } catch (e) { out.perfError = String(e); }
  out.containerCount = out.containers.length;
  return JSON.stringify(out);
})()`;
const CALIBRATE_JS = `(() => {
  const all = Array.from(document.querySelectorAll('*'));
  const target = all.find(el => { const cs = getComputedStyle(el); return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 20; });
  if (!target) return JSON.stringify({ ok: false, reason: 'no scrollable container in this page' });
  const before = target.scrollTop;
  target.scrollTop = before + 20;
  const after = target.scrollTop;
  target.scrollTop = before;
  const restored = target.scrollTop;
  return JSON.stringify({ ok: true, tag: target.tagName.toLowerCase(), id: target.id || '', cls: String(target.className || '').slice(0, 50), before, after, restored, delta: after - before });
})()`;
const OPEN_LYRICS_JS = `(() => {
  try {
    if (typeof toggleLyricsPanel === 'function') { toggleLyricsPanel(); return JSON.stringify({ ok: true, how: 'toggleLyricsPanel' }); }
    const btn = document.getElementById('lyrics-toggle-btn');
    if (btn) { btn.click(); return JSON.stringify({ ok: true, how: 'lyrics-toggle-btn.click' }); }
    return JSON.stringify({ ok: false, reason: 'no lyrics toggle found' });
  } catch (e) { return JSON.stringify({ ok: false, error: String(e) }); }
})()`;

async function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => { try { ws.close(); } catch (e) { } reject(new Error('cdp timeout')); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: false } }));
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error('cdp ws error')); };
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id === id) {
          const res = msg.result && msg.result.result;
          resolve(res && typeof res.value === 'string' ? res.value : JSON.stringify(res || {}));
        }
      } catch (e) { /* ignore other events */ }
      try { ws.close(); } catch (e) { }
    };
  });
}
(async () => {
  const result = { at: new Date().toISOString(), port: PORT, mode: MODE, pages: [] };
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
    for (const p of pages) {
      const page = { url: p.url, title: p.title, ws: !!p.webSocketDebuggerUrl };
      try { page.snapshot = JSON.parse(await evaluate(p.webSocketDebuggerUrl, SNAPSHOT_JS)); } catch (e) { page.snapshotError = String(e && e.message || e); }
      if (MODE === 'calibrate') { try { page.calibration = JSON.parse(await evaluate(p.webSocketDebuggerUrl, CALIBRATE_JS)); } catch (e) { page.calibrationError = String(e && e.message || e); } }
      if (MODE === 'open-lyrics') { try { page.openLyrics = JSON.parse(await evaluate(p.webSocketDebuggerUrl, OPEN_LYRICS_JS)); } catch (e) { page.openLyricsError = String(e && e.message || e); } }
      result.pages.push(page);
    }
  } catch (e) { result.error = String(e && e.message || e); }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ mode: MODE, pages: result.pages.length, pagesDetail: result.pages.map(p => p.url + ' containers=' + (p.snapshot && p.snapshot.containerCount) + (p.calibration ? ' calibDelta=' + p.calibration.delta : '')) }));
})();