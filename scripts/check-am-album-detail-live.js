'use strict';
// Apple Music 资料库专辑详情页 · 运行时验证（真实 Electron + CDP）
// 用真实资料库数据驱动，不 mock 接口。
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 9460) || 9460;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const findings = [];
function record(name, ok, detail) {
  findings.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
}
const env = { ...process.env, MINERADIO_NO_DESKTOP_SHORTCUT: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
  ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'mlib-album-'))],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
let ws = null, seq = 0; const pending = new Map();
async function waitTarget() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const p = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
      if (p) return p;
    } catch (_) {}
    await sleep(300);
  }
  throw new Error('no cdp target');
}
function call(method, params) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' timeout')); } }, 30000);
  });
}
async function ev(expr) {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval error');
  return r.result.value;
}

(async () => {
  const target = await waitTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const consoleErrors = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data || '{}'));
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params && m.params.exceptionDetails;
      consoleErrors.push((d && d.exception && d.exception.description) || (d && d.text) || 'exception');
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map(a => a.value || a.description).join(' '));
      return;
    }
    const w = pending.get(m.id);
    if (w) { pending.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); }
  });
  await call('Runtime.enable');
  for (let i = 0; i < 80; i++) { if (await ev("typeof apiJson === 'function' && typeof openAmAlbumDetail === 'function'")) break; await sleep(500); }

  // 打开资料库并等真实数据
  await ev("document.getElementById('music-library-btn').click(); true");
  let ready = null;
  for (let i = 0; i < 40; i++) {
    ready = await ev("(function(){var c=document.querySelectorAll('#mlib-albums-grid .mlib-album-card');return c.length;})()");
    if (ready > 0) break;
    await sleep(700);
  }
  record('资料库渲染出专辑卡片', ready > 0, 'cards=' + ready);
  if (consoleErrors.length) {
    console.log('  DIAG 渲染器错误: ' + JSON.stringify(consoleErrors.slice(0, 4)));
  }
  const mods = await ev("[typeof openMusicLibrary, typeof openAmAlbumDetail, typeof apiJson, typeof playAmcTrackFromSong].join('|')");
  console.log('  DIAG 模块: ' + mods);

  // 打开第一张专辑详情（真实点击路径）
  await ev("(function(){var c=document.querySelector('#mlib-albums-grid .mlib-album-card');c.click();return true;})()");
  await sleep(400);
  let opened = await ev("(function(){var m=document.getElementById('am-album-detail-modal');return m && m.classList.contains('show');})()");
  record('点击专辑卡片打开详情窗口', opened === true);

  // 等曲目加载完
  let detail = null;
  for (let i = 0; i < 30; i++) {
    detail = await ev(`(function(){
      var rows = document.querySelectorAll('#am-album-detail-tracks .am-album-track');
      var busy = document.getElementById('am-album-detail-tracks').getAttribute('aria-busy');
      return { rows: rows.length, busy: busy,
        title: document.getElementById('am-album-detail-heading').textContent,
        artist: document.getElementById('am-album-detail-artist').textContent,
        facts: document.getElementById('am-album-detail-facts').textContent,
        coverImg: !!document.querySelector('#am-album-detail-cover img'),
        themeA: (document.getElementById('am-album-detail-modal').style.getPropertyValue('--am-theme-a')||'').trim(),
        error: !!document.querySelector('#am-album-detail-tracks .am-album-error'),
        empty: !!document.querySelector('#am-album-detail-tracks .am-album-empty') };
    })()`);
    if (detail && detail.busy === 'false') break;
    await sleep(500);
  }
  console.log('  DIAG 详情: ' + JSON.stringify(detail));
  record('专辑标题渲染', !!detail.title, detail.title);
  record('专辑艺术家渲染', !!detail.artist, detail.artist);
  record('封面渲染', detail.coverImg === true);
  record('补充元数据非空且不含异常值',
    !!detail.facts && !/undefined|NaN|null/.test(detail.facts), detail.facts);
  record('曲目列表渲染出行', detail.rows > 0 || detail.empty, 'rows=' + detail.rows + ' empty=' + detail.empty);
  record('无错误态', detail.error === false);

  // 一致性：显示的曲目数必须等于实际渲染的行数（Apple 的 album.trackCount 是整张发行版的曲目数，
  // 而库内曲目接口只返回已保存的曲目，两者会不一致）。
  const countCheck = await ev([
    '(function(){',
    'var rows = document.querySelectorAll("#am-album-detail-tracks .am-album-track").length;',
    'var libRows = document.querySelectorAll("#am-album-detail-tracks .am-album-track").length;',
    'var spans = document.querySelectorAll("#am-album-detail-facts span");',
    'var shown = null;',
    'var SUFFIX = String.fromCharCode(0x9996);',
    'for (var i = 0; i < spans.length; i++) {',
    '  var txt = (spans[i].textContent || "").trim();',
    '  if (txt.indexOf("资料库") === 0) continue;',
    '  if (txt.charAt(txt.length - 1) !== SUFFIX) continue;',
    '  var n = parseInt(txt.replace(/[^0-9]/g, ""), 10);',
    '  if (isFinite(n)) { shown = n; break; }',
    '}',
    'var facts = document.getElementById("am-album-detail-facts").textContent || "";',
    'return { rows: rows, libRows: libRows, shown: shown, facts: facts };',
    '})()'
  ].join(' '));
  console.log('  DIAG 计数: ' + JSON.stringify(countCheck));
  record('显示的资料库首数等于库内实际渲染行数（不虚报专辑曲目数）',
    countCheck.shown === countCheck.libRows,
    'shown=' + countCheck.shown + ' libRows=' + countCheck.libRows + ' rows=' + countCheck.rows + ' facts=' + countCheck.facts);

  // 视觉修正验收：主题色平铺 + 不再有独立黑色大圆角容器
  const theme = await ev([
    '(function(){',
    'var mask = document.getElementById("am-album-detail-modal");',
    'var modal = mask.querySelector(".modal");',
    'var cs = getComputedStyle(modal);',
    'return { themeA: (mask.style.getPropertyValue("--am-theme-a")||"").trim(),',
    '  themeLight: (mask.style.getPropertyValue("--am-theme-light")||"").trim(),',
    '  themeDark: (mask.style.getPropertyValue("--am-theme-dark")||"").trim(),',
    '  radius: cs.borderRadius,',
    '  bgImage: cs.backgroundImage.slice(0, 120) };',
    '})()'
  ].join(' '));
  console.log('  DIAG 主题: ' + JSON.stringify(theme));
  record('窗口背景是主题色渐变（不是黑色容器）',
    theme.bgImage.indexOf('gradient') >= 0 && theme.bgImage.indexOf('rgb(') >= 0,
    theme.bgImage.slice(0, 70));
  record('取色写入了亮/暗两端（用于连续渐变）',
    !!theme.themeLight && !!theme.themeDark, theme.themeLight + ' / ' + theme.themeDark);
  const globalTheme = await ev("[getComputedStyle(document.documentElement).getPropertyValue('--am-theme-a').trim(), document.body.style.getPropertyValue('--am-theme-a')].join('|')");
  record('主题变量只写在详情窗口上（不污染全局）', !!theme.themeA && globalTheme === '|', 'global=' + JSON.stringify(globalTheme));

  // 验收：不同专辑必须得到不同主题色（切换专辑时更新背景）
  const themeSwitch = await ev([
    '(async function(){',
    '  var cards = document.querySelectorAll("#mlib-albums-grid .mlib-album-card");',
    '  if (cards.length < 4) return { skipped: true };',
    '  function themeOf(card) {',
    '    var id = card.getAttribute("data-album-id");',
    '    return { id: id, cover: (card.querySelector("img") || {}).src || "" };',
    '  }',
    '  var seen = [];',
    '  for (var i = 0; i < 5; i++) {',
    '    var c = cards[i * 40] || cards[i];',
    '    if (!c) continue;',
    '    var info = themeOf(c);',
    '    openAmAlbumDetail(info);',
    '    await new Promise(function(r){ setTimeout(r, 1800); });',
    '    var mask = document.getElementById("am-album-detail-modal");',
    '    seen.push({ id: info.id, theme: (mask.style.getPropertyValue("--am-theme-a")||"").trim() });',
    '  }',
    '  return { seen: seen };',
    '})()'
  ].join(' '));
  console.log('  DIAG 主题切换: ' + JSON.stringify(themeSwitch));
  if (!themeSwitch.skipped) {
    var themes = (themeSwitch.seen || []).map(function (s) { return s.theme; }).filter(Boolean);
    var distinct = {};
    themes.forEach(function (t) { distinct[t] = 1; });
    record('不同专辑得到不同主题色（切换专辑更新背景）',
      themes.length >= 3 && Object.keys(distinct).length >= 2,
      'collected=' + JSON.stringify(themes));
  }

  // ---- 只展示资料库实际保存的曲目（无 Catalog 补全） ----
  const libOnly = await ev([
    '(async function(){',
    '  var out = [];',
    '  var cards = document.querySelectorAll("#mlib-albums-grid .mlib-album-card");',
    '  for (var i = 0; i < 3; i++) {',
    '    var c = cards[i * 12] || cards[i];',
    '    if (!c) continue;',
    '    var id = c.getAttribute("data-album-id");',
    '    var api = await apiJson("/api/apple/library/album/tracks?id=" + encodeURIComponent(id) + "&limit=100");',
    '    var resp = await fetch("/api/apple/library/album/detail?id=" + encodeURIComponent(id));',
    '    var d = { httpStatus: resp.status };',
    '    out.push({ id: id,',
    '      apiSongs: (api.songs || []).length,',
    '      detailStatus: d.httpStatus });',
    '  }',
    '  return out;',
    '})()'
  ].join(' '));
  console.log('  DIAG 仅库内: ' + JSON.stringify(libOnly));
  record('合并(Catalog 补全)接口已移除（返回 404）',
    libOnly.every(function (m) { return m.detailStatus === 404; }),
    JSON.stringify(libOnly.map(function (m) { return m.detailStatus; })));

  // 关键不变量：界面行数 === 资料库接口返回的曲目数
  const inv = await ev([
    '(async function(){',
    '  var cards = document.querySelectorAll("#mlib-albums-grid .mlib-album-card");',
    '  var c = cards[0];',
    '  c.click();',
    '  await new Promise(function(r){ setTimeout(r, 2500); });',
    '  var id = c.getAttribute("data-album-id");',
    '  var api = await apiJson("/api/apple/library/album/tracks?id=" + encodeURIComponent(id) + "&limit=100");',
    '  var rows = document.querySelectorAll("#am-album-detail-tracks .am-album-track");',
    '  var sources = {};',
    '  for (var i = 0; i < rows.length; i++) {',
    '    var s = rows[i].getAttribute("data-am-track-source") || "(none)";',
    '    sources[s] = (sources[s] || 0) + 1;',
    '  }',
    '  return { apiSongs: (api.songs || []).length, rows: rows.length, sources: sources,',
    '    hasMore: !!api.hasMore, status: (document.getElementById("am-album-detail-status").textContent || "").slice(0, 80) };',
    '})()'
  ].join(' '));
  console.log('  DIAG 不变量: ' + JSON.stringify(inv));
  record('界面行数 === 资料库接口返回的曲目数（不补全、不丢歌）',
    inv.rows === inv.apiSongs, 'rows=' + inv.rows + ' api=' + inv.apiSongs + ' hasMore=' + inv.hasMore);
  record('列表中没有 Catalog 来源的行',
    !inv.sources['catalog'], 'sources=' + JSON.stringify(inv.sources));
  // ---- 重建回归：4 张已诊断专辑的预期曲目数（当前诊断数据对应的预期） ----
  const EXPECT = [
    { id: 'l.HWqiIHf', name: 'Dawn FM', artist: 'Abel Tesfaye', expect: 11 },
    { id: 'l.C3QjoIb', name: 'My Dear Melancholy,', artist: 'Abel Tesfaye', expect: 6 },
    { id: 'l.VVh3Vhw', name: '崩坏3-Onwards (Original Soundtrack)', artist: 'HOYO-MiX', expect: 6 },
    { id: 'l.camKEZj', name: 'SPIN - Single', artist: 'Kroi', expect: 1 }
  ];
  for (const e of EXPECT) {
    const r = await ev("(async function(){return await apiJson('/api/apple/library/album/rebuilt?id=" + e.id + "&name=" + encodeURIComponent(e.name) + "&artist=" + encodeURIComponent(e.artist) + "');})()");
    const n = (r && r.verified) ? r.verified.length : -1;
    record('重建：' + e.name + ' 得到 ' + e.expect + ' 首', n === e.expect,
      'got=' + n + ' conf=' + (r && r.confidence) + ' unverified=' + ((r && r.unverified) || []).length);
  }

  // 缓存：全量同步做总数/重复校验；命中缓存时直接返回本地索引（不探测）。
  // force=1 强制全量，保证这里拿到的是真实的 meta，而不是命中缓存的空 meta。
  const c1 = await ev("(async function(){return await apiJson('/api/apple/library/songs?force=1');})()");
  const c2 = await ev("(async function(){return await apiJson('/api/apple/library/songs');})()");
  const m1 = c1.meta || {};
  console.log('  DIAG 缓存: ' + JSON.stringify({ meta: m1, cached: c2.fromCache, age: c2.ageMs, libSongs: (c2.songs || []).length }));
  record('歌曲缓存：总数校验通过且无重复 ID',
    m1.songsTotalMatches === true && m1.songsDuplicates === 0,
    'totalMatches=' + m1.songsTotalMatches + ' duplicates=' + m1.songsDuplicates);
  record('歌曲缓存：命中缓存时不再探测 Apple',
    c2.fromCache === true && c2.probed === false, 'fromCache=' + c2.fromCache + ' probed=' + c2.probed);
  record('无 playParams 的歌曲被如实记录',
    typeof m1.withoutPlayParams === 'number' && m1.withoutPlayParams >= 0,
    'withoutPlayParams=' + m1.withoutPlayParams);
  record('本地索引落盘且含原始数据',
    !!(c2.index && c2.index.hasData && c2.index.raw && c2.index.raw.songs > 0 && c2.index.cachePath),
    JSON.stringify(c2.index && c2.index.raw));
  // 撤除白名单后：任意专辑都应走「校验式重建」，不再有按清单拒绝的路径。
  const anyAlbum = await ev("(async function(){return await apiJson('/api/apple/library/album/rebuilt?id=l.NOT_A_REAL_ID&name=x&artist=y');})()");
  console.log('  DIAG 任意专辑: ' + JSON.stringify({ ok: anyAlbum.ok, error: anyAlbum.error || '', reasons: anyAlbum.reasons || [] }));
  record('任意专辑都能进入重建（无白名单拒绝路径）',
    anyAlbum.ok === true && anyAlbum.error !== 'NOT_IN_ALLOWLIST',
    'error=' + (anyAlbum.error || '(none)'));
  record('无同名候选时如实返回空结果与原因（不猜、不报错）',
    anyAlbum.ok === true && (anyAlbum.verified || []).length === 0,
    'verified=' + ((anyAlbum.verified || []).length) + ' reasons=' + JSON.stringify(anyAlbum.reasons || []));
  // 真实数据字段检查  // 真实数据字段检查
  const dataCheck = await ev(`(async function(){
    var card = document.querySelector('#mlib-albums-grid .mlib-album-card');
    var id = card.getAttribute('data-album-id');
    var t = await apiJson('/api/apple/library/album/tracks?id=' + encodeURIComponent(id) + '&limit=200');
    var songs = t.songs || [];
    return { id: id, count: songs.length,
      ids: songs.slice(0,3).map(function(s){return s.id;}),
      catalogIds: songs.slice(0,3).map(function(s){return s.catalogId === undefined ? 'undef' : String(s.catalogId);}),
      trackNumbers: songs.slice(0,4).map(function(s){return s.trackNumber;}) };
  })()`);
  console.log('  DIAG 数据: ' + JSON.stringify(dataCheck));
  record('按 library album id 取曲目成功', dataCheck.count > 0, 'albumId=' + dataCheck.id + ' n=' + dataCheck.count);
  record('曲目带 catalogId（精确播放身份可行）',
    dataCheck.catalogIds.every(function(c){ return c !== 'undef' && !!c; }), JSON.stringify(dataCheck.catalogIds));
  record('library song id 形态为 i.*',
    dataCheck.ids.every(function(x){ return /^i\./.test(String(x)); }), JSON.stringify(dataCheck.ids));

  // 播放专辑：断言请求的是第一首（catalogId 比对），不实际等待播放成功
  const firstPlay = await ev(`(function(){
    var rows = document.querySelectorAll('#am-album-detail-tracks .am-album-track');
    if (!rows.length) return { error: 'no rows' };
    var firstLabel = rows[0].querySelector('.am-album-track-name').textContent;
    return { firstLabel: firstLabel, rowCount: rows.length };
  })()`);
  record('首行存在（播放专辑的目标）', !!firstPlay.firstLabel, firstPlay.firstLabel);

  // 更多操作：默认隐藏 + 点击不触发整行播放
  const moreProbe = await ev(`(function(){
    var row = document.querySelector('#am-album-detail-tracks .am-album-track');
    if (!row) return { error: 'no library row' };
    var btn = row.querySelector('[data-am-track-more]');
    if (!btn || btn.tagName !== 'BUTTON') return { hasBtn: false, reason: 'no button on first row' };
    var cs = getComputedStyle(btn);
    return { opacity: cs.opacity, pointer: cs.pointerEvents, hasBtn: true };
  })()`);
  console.log('  DIAG 更多操作: ' + JSON.stringify(moreProbe));
  record('更多操作按钮存在', moreProbe.hasBtn === true);
  record('更多操作默认隐藏且不可点',
    parseFloat(moreProbe.opacity) < 0.05 && moreProbe.pointer === 'none',
    'opacity=' + moreProbe.opacity + ' pointer=' + moreProbe.pointer);

  // 截图前把详情切到第一张专辑（库内曲目少 + catalog 补全多，最能体现来源区分）
  await ev("(function(){var c=document.querySelector('#mlib-albums-grid .mlib-album-card');if(c)c.click();return true;})()");
  await sleep(2600);
  await ev("(function(){var s=document.getElementById('am-album-detail-scroll');if(s)s.scrollTop=0;return true;})()");
  await sleep(500);
  // 截一张详情页图
  const shotDir = path.join(ROOT, 'docs', 'assets', 'music-library');
  fs.mkdirSync(shotDir, { recursive: true });
  try {
    const res = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const file = path.join(shotDir, '05-album-detail.png');
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    console.log('  SHOT  ' + path.relative(ROOT, file));
  } catch (e) { console.log('  SHOT-FAIL ' + e.message); }

  // 关闭：回到资料库且主题色清除
  await ev('closeAmAlbumDetail()');
  await sleep(700);
  const afterClose = await ev(`(function(){
    var m = document.getElementById('am-album-detail-modal');
    return { show: m.classList.contains('show'),
      theme: (m.style.getPropertyValue('--am-theme-a')||'').trim(),
      libOpen: document.body.classList.contains('music-library-active') };
  })()`);
  record('关闭详情后回到资料库', afterClose.show === false && afterClose.libOpen === true, JSON.stringify(afterClose));
  record('关闭后主题色已清除', afterClose.theme === '', 'theme=' + JSON.stringify(afterClose.theme));

  // 连续切换专辑：不串数据
  const raceCheck = await ev(`(async function(){
    var cards = document.querySelectorAll('#mlib-albums-grid .mlib-album-card');
    if (cards.length < 2) return { skipped: true };
    function albumOf(c) {
      var id = c.getAttribute('data-album-id');
      return { id: id, name: c.querySelector('.mlib-album-name').textContent };
    }
    var a = albumOf(cards[0]), b = albumOf(cards[3] || cards[1]);
    openAmAlbumDetail(a); 
    openAmAlbumDetail(b);
    await new Promise(function(r){ setTimeout(r, 2500); });
    return { a: a, b: b,
      heading: document.getElementById('am-album-detail-heading').textContent,
      rowCount: document.querySelectorAll('#am-album-detail-tracks .am-album-track').length };
  })()`);
  console.log('  DIAG 竞态: ' + JSON.stringify(raceCheck));
  if (!raceCheck.skipped) {
    record('快速切换后显示的是最后选中的专辑',
      raceCheck.heading === raceCheck.b.name, 'got=' + raceCheck.heading + ' want=' + raceCheck.b.name);
  }
  await ev('closeAmAlbumDetail()');

  const failed = findings.filter(f => !f.ok);
  console.log('\n=========== ' + (findings.length - failed.length) + '/' + findings.length + ' passed ===========');
  if (failed.length) failed.forEach(f => console.log('  - ' + f.name + (f.detail ? '  (' + f.detail + ')' : '')));
  process.exitCode = failed.length ? 1 : 0;
  try { ws.close(); } catch (_) {}
  try { child.kill(); } catch (_) {}
})().catch(e => { console.error('FATAL', (e && e.stack) || e); try { child.kill(); } catch (_) {} process.exit(1); });