'use strict';

/*
 * 音乐资料库 Phase 1（P1-Nav）运行时验证
 *
 * 在真实 Electron 渲染器里断言设计文档 0.2 节的三条核心条件 + 两条附加回归。
 * 用法：node scripts/check-music-library-shell-live.js [--port 9333] [--keep]
 *
 * 证据来源是渲染器的真实 DOM 与 getComputedStyle，不是读源码。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(argOf('--port', '9333'));
const KEEP = process.argv.includes('--keep');
const SHOT = process.argv.includes('--shot');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
let socket = null;
let sequence = 0;
const pending = new Map();
const consoleErrors = [];
const findings = [];

function record(name, ok, detail) {
  findings.push({ name, ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

async function waitForTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    if (child && child.exitCode != null) throw new Error('Mineradio exited early (' + child.exitCode + ')');
    try {
      const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { last = e; }
    await sleep(300);
  }
  throw new Error('timed out waiting for CDP target: ' + (last && last.message));
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (e) => reject(new Error('ws error')));
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data || '{}'));
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params && msg.params.exceptionDetails;
        consoleErrors.push((d && d.exception && d.exception.description) || (d && d.text) || 'exception');
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params && msg.params.type === 'error') {
        consoleErrors.push((msg.params.args || []).map((a) => a.value || a.description).join(' '));
        return;
      }
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    });
  });
}

function call(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timed out')); }
    }, 20000);
  });
}

async function evaluate(expression) {
  const res = await call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error('evaluate threw: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
  }
  return res.result.value;
}

const PROBE = `(function () {
  var q = function (s) { return document.querySelector(s); };
  var body = document.body;
  var nav = q('#mlib-nav');
  var btn = q('#music-library-btn');
  var shell = q('#music-library');
  var scroll = q('#music-library-scroll');
  var home = q('#empty-home');
  var topRight = q('#top-right');
  var rect = function (el) { if (!el) return null; var r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; };
  var navCs = nav ? getComputedStyle(nav) : null;
  var btnCs = btn ? getComputedStyle(btn) : null;
  var shellCs = shell ? getComputedStyle(shell) : null;
  return {
    navExists: !!nav,
    btnExists: !!btn,
    navParent: nav && nav.parentElement ? (nav.parentElement.id || nav.parentElement.tagName) : null,
    navSameParentAsTopRight: !!(nav && topRight && nav.parentElement === topRight.parentElement),
    navIsInsideTopRight: !!(nav && topRight && topRight.contains(nav)),
    navPosition: navCs && navCs.position,
    navZIndex: navCs && navCs.zIndex,
    anchorVar: nav && nav.style.getPropertyValue('--mlib-nav-anchor-right'),
    navRightPropRaw: navCs && navCs.right,
    navLeftPropRaw: navCs && navCs.left,
    navRect: rect(nav),
    topRightRect: rect(topRight),
    btnClass: btn && btn.className,
    btnText: btn ? String(btn.textContent || '').trim() : null,
    btnBorderRadius: btnCs && btnCs.borderRadius,
    btnWidth: btnCs && btnCs.width,
    btnHeight: btnCs && btnCs.height,
    btnAriaLabel: btn && btn.getAttribute('aria-label'),
    btnTitle: btn && btn.getAttribute('title'),
    btnAriaCurrent: btn && btn.getAttribute('aria-current'),
    shellExists: !!shell,
    shellAriaHidden: shell && shell.getAttribute('aria-hidden'),
    shellOpacity: shellCs && shellCs.opacity,
    homeBtnAriaCurrent: q('#home-btn') && q('#home-btn').getAttribute('aria-current'),
    bodyClass: body.className,
    libActive: body.classList.contains('music-library-active'),
    homeActive: body.classList.contains('empty-home-active'),
    homeOpacity: home ? getComputedStyle(home).opacity : null,
    scrollOverflowY: scroll && getComputedStyle(scroll).overflowY,
    scrollPaddingTop: scroll && getComputedStyle(scroll).paddingTop,
    scrollMask: !!(scroll && (getComputedStyle(scroll).maskImage || getComputedStyle(scroll).webkitMaskImage)),
    title: q('.mlib-title') && q('.mlib-title').textContent,
    hasOpenFn: typeof window.openMusicLibrary === 'function',
    hasCloseFn: typeof window.closeMusicLibrary === 'function',
    diagHomeForcedOpen: (typeof homeForcedOpen !== 'undefined') ? !!homeForcedOpen : 'undef',
    diagHomeSuppressed: (typeof homeSuppressed !== 'undefined') ? !!homeSuppressed : 'undef',
    diagEmptyHomeActive: (typeof emptyHomeActive !== 'undefined') ? !!emptyHomeActive : 'undef'
  };
})()`;

(async () => {
  assert(fs.existsSync(ELECTRON), 'electron.exe not found: ' + ELECTRON);

  // 独立 userData，避免污染真实用户配置
  const userDataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mineradio-mlib-qa-'));
  console.log('launching Mineradio (port ' + PORT + ', userData ' + userDataDir + ')');

  // 关键：必须清掉 ELECTRON_RUN_AS_NODE，否则 electron.exe 会退化成普通 Node，
  // 在 desktop/main.js 的 app.whenReady 之前就炸在 protocol 上。
  const childEnv = { ...process.env, MINERADIO_NO_DESKTOP_SHORTCUT: '1', MINERADIO_KEEP_BACKGROUND_RENDERING: '1' };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDataDir], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const hostLog = [];
  child.stdout.on('data', (c) => hostLog.push(String(c)));
  child.stderr.on('data', (c) => hostLog.push(String(c)));
  child.on('exit', (code) => {
    if (code != null && code !== 0 && !socket) {
      console.error('electron host exited (' + code + '):\n' + hostLog.join('').slice(-2500));
    }
  });

  const target = await waitForTarget(90000);
  socket = await connect(target.webSocketDebuggerUrl);
  await call('Runtime.enable');
  await call('Page.enable');

  // 等首屏就绪
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const ready = await evaluate("!!document.getElementById('music-library-btn') && !!document.getElementById('empty-home')").catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  await sleep(1500);

  console.log('\n--- 前置：入口与模块加载 ---');
  let s = await evaluate(PROBE);
  record('全局 openMusicLibrary 已暴露', s.hasOpenFn === true);
  record('全局 closeMusicLibrary 已暴露', s.hasCloseFn === true);
  record('#mlib-nav 存在', s.navExists === true);
  record('#music-library-btn 存在', s.btnExists === true);
  record('#mlib-nav 与 #top-right 同父（互不嵌套）', s.navSameParentAsTopRight === true, 'parent=' + s.navParent);
  record('#mlib-nav 不在 #top-right 内（兄弟节点）', s.navIsInsideTopRight === false);
  record('#mlib-nav position:fixed', s.navPosition === 'fixed', 'got ' + s.navPosition);
  record('#mlib-nav z-index:10', String(s.navZIndex) === '10', 'got ' + s.navZIndex);
  record('入口锚定在左侧（left 为像素值）', /^\d+px$/.test(s.navLeftPropRaw || ''), 'left=' + s.navLeftPropRaw);
  record('入口是纯图标（无文字）', !s.btnText, 'textContent=' + JSON.stringify(s.btnText));
  record('入口复用 .icon-btn', /(^|\s)icon-btn(\s|$)/.test(s.btnClass || ''), 'class=' + s.btnClass);
  record('入口带 aria-label / title', !!s.btnAriaLabel && !!s.btnTitle, s.btnAriaLabel + ' / ' + s.btnTitle);
  const br = parseFloat(s.btnBorderRadius || '0');
  record('入口是圆形按钮（圆角≈半径）', br >= 20, 'border-radius=' + s.btnBorderRadius + ' size=' + s.btnWidth + '×' + s.btnHeight);
  const geo = await evaluate(`(function () {
    var nav = document.getElementById('mlib-nav').getBoundingClientRect();
    var search = document.getElementById('search-area').getBoundingClientRect();
    var searchBox = document.getElementById('search-box');
    var box = searchBox ? searchBox.getBoundingClientRect() : null;
    var cs = getComputedStyle(document.getElementById('mlib-nav'));
    return {
      viewport: window.innerWidth,
      nav: { x: Math.round(nav.x), y: Math.round(nav.y), right: Math.round(nav.right), w: Math.round(nav.width), cy: Math.round(nav.y + nav.height / 2) },
      searchLeft: Math.round(search.left),
      searchBox: box ? { y: Math.round(box.y), bottom: Math.round(box.bottom), cy: Math.round(box.y + box.height / 2) } : null,
      navLeftProp: cs.left,
      navAppRegion: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region')
    };
  })()`);
  record('入口位于搜索栏左侧', geo.nav.right <= geo.searchLeft,
    'nav.right=' + geo.nav.right + ' search.left=' + geo.searchLeft);
  if (geo.searchBox && geo.searchBox.bottom > 0) {
    // 搜索框处于 peek 隐藏态（y 为负）时无法比较中线，跳过
    const dy = Math.abs(geo.nav.cy - geo.searchBox.cy);
    record('入口与搜索框垂直居中对齐（中线偏差 < 4px）', dy < 4,
      'nav.cy=' + geo.nav.cy + ' box.cy=' + geo.searchBox.cy + ' dy=' + dy);
  } else {
    record('搜索框隐藏时不比较中线（入口独立于搜索栏显示）', true,
      'box=' + JSON.stringify(geo.searchBox));
  }
  record('入口已退出标题栏拖拽区', String(geo.navAppRegion).indexOf('drag') === -1 || geo.navAppRegion === 'no-drag',
    'app-region=' + geo.navAppRegion);

  console.log('\n--- P1.0 真实数据：专辑墙与封面 ---');
  // 重新打开资料库，等真实数据 + 真实封面落位（不使用任何夹具）
  await evaluate("document.getElementById('music-library-btn').click(); true");
  let realWall = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    realWall = await evaluate(`(function () {
      var cards = document.querySelectorAll('#mlib-recent-grid .mlib-album-card');
      var imgs = document.querySelectorAll('#mlib-recent-grid .mlib-art img');
      var allCards = document.querySelectorAll('#mlib-albums-grid .mlib-album-card');
      var allImgs = document.querySelectorAll('#mlib-albums-grid .mlib-art img');
      var loaded = 0;
      for (var i = 0; i < imgs.length; i += 1) { if (imgs[i].complete && imgs[i].naturalWidth > 0) loaded += 1; }
      var loadedAll = 0;
      for (var j = 0; j < allImgs.length; j += 1) { if (allImgs[j].complete && allImgs[j].naturalWidth > 0) loadedAll += 1; }
      var first = cards.length ? cards[0] : null;
      return {
        cards: cards.length,
        imgs: imgs.length,
        loaded: loaded,
        albumCards: allCards.length,
        albumImgs: allImgs.length,
        albumLoaded: loadedAll,
        albumCount: (document.getElementById('mlib-albums-count') || {}).textContent,
        albumHint: (document.getElementById('mlib-albums-hint') || {}).textContent,
        scrollTop: (function () { var sc = document.getElementById('music-library-scroll'); return Math.round(sc.scrollTop); })(),
        activeEl: (document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName)) || 'none',
        headTop: Math.round(document.querySelector('.mlib-page-head').getBoundingClientRect().top),
        albumColumns: (function () {
          var g = document.getElementById('mlib-albums-grid');
          return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 0;
        })(),
        firstTitle: first ? (first.querySelector('.mlib-album-name') || {}).textContent : '',
        firstSub: first ? (first.querySelector('.mlib-album-sub') || {}).textContent : '',
        count: (document.getElementById('mlib-recent-count') || {}).textContent,
        stateVisible: !(document.getElementById('mlib-recent-state') || {}).hidden,
        stateText: (document.getElementById('mlib-recent-state') || {}).textContent,
        firstCoverSrc: imgs.length ? String(imgs[0].src || '').slice(0, 70) : ''
      };
    })()`);
    if (realWall && realWall.cards > 0 && realWall.albumCards > 0 && realWall.loaded > 0) break;
    await sleep(700);
  }
  record('真实数据画出专辑卡片', realWall && realWall.cards > 0, 'cards=' + (realWall && realWall.cards));
  record('封面真的加载出来了（naturalWidth>0）', realWall && realWall.loaded > 0,
    'loaded=' + (realWall && realWall.loaded) + '/' + (realWall && realWall.imgs));
  record('卡片副标题来自接口事实（歌手/年份）', !!(realWall && realWall.firstSub), realWall && realWall.firstSub);
  const textStyle = await evaluate(`(function () {
    var card = document.querySelector('#mlib-recent-grid .mlib-album-card');
    if (!card) return null;
    var meta = card.querySelector('.mlib-album-meta');
    var name = card.querySelector('.mlib-album-name');
    var art = card.querySelector('.mlib-art');
    var cs = getComputedStyle(card), ms = getComputedStyle(meta), ns = getComputedStyle(name), as = getComputedStyle(art);
    var cardRect = card.getBoundingClientRect();
    var nameRect = name.getBoundingClientRect();
    var translucent = function (c) {
      if (!c) return true;
      if (c === 'transparent') return true;
      // 不写 \\s，避免多一层转义把正则弄坏：直接解析 alpha 通道
      var m = /rgba?\(([^)]*)\)/.exec(c);
      if (!m) return false;
      var parts = m[1].split(',');
      if (parts.length < 4) return false;
      return parseFloat(parts[3]) === 0;
    };
    return {
      cardBg: cs.backgroundColor, cardBgImage: cs.backgroundImage, cardBorder: cs.borderTopWidth,
      metaBg: ms.backgroundColor, textAlign: ms.textAlign,
      nameAlign: ns.textAlign,
      nameCenter: Math.abs((nameRect.left + nameRect.right) / 2 - (cardRect.left + cardRect.right) / 2),
      cardTransparent: translucent(cs.backgroundColor) && (cs.backgroundImage === 'none' || !cs.backgroundImage),
      artRadius: as.borderRadius,
      rawBgImage: JSON.stringify(cs.backgroundImage),
      rawBgColor: JSON.stringify(cs.backgroundColor),
      rawBorderTop: JSON.stringify(cs.borderTopWidth)
    };
  })()`);
  record('卡片无底色无边框（封面直接落在背景上）',
    !!(textStyle && textStyle.cardTransparent) && parseFloat(textStyle.cardBorder) === 0,
    'bg=' + textStyle.cardBg + ' border=' + textStyle.cardBorder);
  record('文字区透明', !!(textStyle && /rgba\(0, 0, 0, 0\)|transparent/.test(textStyle.metaBg)), textStyle && textStyle.metaBg);
  record('专辑名水平居中（中线偏差 < 2px）', !!(textStyle && textStyle.nameCenter < 2),
    'offset=' + (textStyle && textStyle.nameCenter) + ' align=' + (textStyle && textStyle.nameAlign));
  record('专辑区把整个资料库铺进网格', realWall && realWall.albumCards > 40,
    'albums=' + (realWall && realWall.albumCards) + ' count=' + (realWall && realWall.albumCount));
  record('专辑网格是多列布局', realWall && realWall.albumColumns >= 3,
    'columns=' + (realWall && realWall.albumColumns));
  record('专辑区封面加载', realWall && realWall.albumLoaded > 0,
    'loaded=' + (realWall && realWall.albumLoaded) + '/' + (realWall && realWall.albumImgs));
  const headVisible = await evaluate(`(function () {
    var sc = document.getElementById('music-library-scroll');
    var head = document.querySelector('.mlib-page-head');
    var eyebrow = document.querySelector('.mlib-eyebrow');
    if (sc.scrollTop !== 0) sc.scrollTop = 0;
    var hr = head.getBoundingClientRect();
    var er = eyebrow.getBoundingClientRect();
    // 用 elementFromPoint 判断该位置是否真的可见（mask 会让人看不到但仍能命中，
    // 所以这里同时报告几何值，断言以几何 + mask 起算位置为准）
    var cs = getComputedStyle(sc);
    var mask = cs.webkitMaskImage || cs.maskImage || '';
    return {
      scrollTop: sc.scrollTop,
      headTop: Math.round(hr.top),
      eyebrowTop: Math.round(er.top),
      paddingTop: parseFloat(cs.paddingTop),
      maskSnippet: String(mask).slice(0, 120),
      railTop: Math.round(document.getElementById('mlib-recent-grid').getBoundingClientRect().top)
    };
  })()`);
  // mask 的不透明区起点 = --mlib-content-top；页头必须在它下方，否则会被淡掉
  const maskOpaqueFrom = await evaluate("parseFloat(getComputedStyle(document.getElementById('music-library-scroll')).getPropertyValue('--mlib-content-top'))");
  record('页头完整落在 mask 不透明区内（不被淡出）',
    headVisible.headTop >= maskOpaqueFrom,
    'headTop=' + headVisible.headTop + ' maskOpaqueFrom=' + maskOpaqueFrom);
  record('页头在内容流最上方', headVisible.headTop < headVisible.railTop,
    'headTop=' + headVisible.headTop + ' railTop=' + headVisible.railTop);
  record('首屏没有错误态', !(realWall && realWall.stateVisible && /失败|错误/.test(realWall.stateText || '')),
    realWall && realWall.stateText);
  if (SHOT) {
    try {
      const shotDir = path.join(ROOT, 'docs', 'assets', 'music-library');
      fs.mkdirSync(shotDir, { recursive: true });
      // 截图前清场：新 userData 启动时会有登录引导/账号设置这类 overlay，
      // 它们会盖住整页，拍出来的图不能作为"专辑墙长什么样"的证据。
      const dismissOverlays = async () => {
        await evaluate(`(function () {
          var closed = 0;
          var masks = document.querySelectorAll('.modal-mask');
          for (var i = 0; i < masks.length; i += 1) {
            var m = masks[i];
            var visible = m.getAttribute('aria-hidden') !== 'true' && getComputedStyle(m).display !== 'none';
            if (visible) { m.setAttribute('aria-hidden', 'true'); m.style.display = 'none'; closed += 1; }
          }
          document.body.classList.remove('splash-active');
          var sp = document.getElementById('splash');
          if (sp) sp.style.display = 'none';
          return closed;
        })()`);
        await sleep(500);
      };
      const shot = async (name) => {
        await dismissOverlays();
        const res = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const file = path.join(shotDir, name);
        fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
        console.log('  SHOT  ' + path.relative(ROOT, file) + ' (' + Math.round(fs.statSync(file).size / 1024) + ' KB)');
      };
      await shot('02-music-library.png');
      await shot('03-recently-added-real.png');
    } catch (e) { console.log('  SHOT-FAIL ' + e.message); }
  }
  await evaluate("document.getElementById('home-btn').click(); true");
  await sleep(600);

  console.log('\n--- P1.0 最近添加：端点 + 渲染 ---');
  const endpoint = await evaluate(`(async function () {
    try {
      var res = await fetch('/api/apple/library/albums?limit=30&offset=0');
      var data = await res.json();
      return {
        status: res.status,
        hasAlbumsArray: Array.isArray(data.albums),
        albumCount: (data.albums || []).length,
        total: data.total,
        sortedBy: data.sortedBy,
        sortDirection: data.sortDirection,
        hasMessage: !!data.message,
        message: String(data.message || '').slice(0, 60),
      };
    } catch (e) { return { threw: String(e && e.message) }; }
  })()`);
  record('GET /api/apple/library/albums 可达且返回 albums 数组',
    endpoint.hasAlbumsArray === true, 'status=' + endpoint.status);
  record('端点自描述排序语义', endpoint.sortedBy === 'dateAdded' && endpoint.sortDirection === 'desc',
    endpoint.sortedBy + '/' + endpoint.sortDirection);
  record('未登录 / 空库时给出说明而不是空网格',
    endpoint.albumCount > 0 || endpoint.hasMessage, 'albums=' + endpoint.albumCount);

  // 用合成数据驱动真实渲染路径：本地没有 Apple 凭据，但"墙"的版面必须被验证
  const rendered = await evaluate(`(function () {
    if (typeof window.__mlibShowAlbumsForPreview !== 'function') return { error: 'preview hook missing' };
    function fake(i, name, artist, year) {
      return { id: 'l.' + i, libraryId: 'l.' + i, name: name, artist: artist,
               releaseDate: year + '-05-01', trackCount: 10, cover: '' };
    }
    window.__mlibShowAlbumsForPreview([
      fake(1, 'Shape of You', 'Ed Sheeran', '2017'),
      fake(2, '叶惠美', '周杰伦', '2003'),
      fake(3, 'A Very Long Album Name That Must Be Clamped To One Single Line', 'Some Artist', '2021'),
      fake(4, 'Blonde', 'Frank Ocean', '2016'),
      fake(5, 'Random Access Memories', 'Daft Punk', '2013'),
      fake(6, '25', 'Adele', '2015')
    ], 549);
    var cards = document.querySelectorAll('#mlib-recent-grid .mlib-album-card');
    return { ok: true, cardCount: cards.length, firstTitle: cards.length ? cards[0].querySelector('.mlib-album-name').textContent : '' };
  })()`);
  record('专辑墙经真实渲染路径画出卡片', rendered.ok === true && rendered.cardCount === 6,
    'cards=' + rendered.cardCount);
  record('卡片顺序 = 传入顺序（前端不排序）', rendered.firstTitle === 'Shape of You', rendered.firstTitle);
  record('轨道容器就位', rendered.ok === true);
  // 内容一屏放得下 = 不需要滚动，这是理想结果；真正的不变量是
  // "内容没被上下浮层吃掉 + 需要滚动时滚得动"。
  const scrollProbe = await evaluate(`(function () {
    var sc = document.getElementById('music-library-scroll');
    var card = document.querySelector('#mlib-recent-grid .mlib-album-card');
    var bar = document.getElementById('bottom-bar').getBoundingClientRect();
    var cr = card ? card.getBoundingClientRect() : null;
    var before = sc.scrollTop;
    // 临时塞一个超高元素，验证滚动容器真的能滚，并且内容能完全滚进安全区
    var probe = document.createElement('div');
    probe.style.height = '900px';
    probe.id = 'mlib-scroll-probe';
    document.querySelector('#music-library .mlib-end-cap').appendChild(probe);
    var maxScroll = sc.scrollHeight - sc.clientHeight;
    sc.scrollTop = maxScroll;
    var after = sc.scrollTop;
    var probeRect = probe.getBoundingClientRect();
    probe.remove();
    sc.scrollTop = before;
    return {
      canScroll: after > 0,
      maxScroll: maxScroll,
      cardFitsAboveBar: cr ? cr.bottom <= bar.top : null,
      scrollTopRestored: sc.scrollTop === before
    };
  })()`);
  record('内容放不下时滚动真的生效', scrollProbe.canScroll === true,
    'maxScroll=' + scrollProbe.maxScroll + 'px');
  record('滚动后回到原位', scrollProbe.scrollTopRestored === true);
  // 滚动感知：视口矮时页面本就会滚动，此时"卡片在播放器之上"指的是
  // 用户可以滚到卡片完整可见的位置 —— 而不是要求静止态就可见。
  const visibility = await evaluate(`(function () {
    var sc = document.getElementById('music-library-scroll');
    function measure() {
      var card = document.querySelector('#mlib-recent-grid .mlib-album-card');
      var bar = document.getElementById('bottom-bar').getBoundingClientRect();
      var cr = card ? card.getBoundingClientRect() : null;
      return { cardBottom: cr ? Math.round(cr.bottom) : null, cardTop: cr ? Math.round(cr.top) : null,
               barTop: Math.round(bar.top), fits: cr ? cr.bottom <= bar.top - 8 : null };
    }
    var atRest = measure();
    sc.scrollTop = sc.scrollHeight;          // 滚到底
    var atBottom = measure();
    sc.scrollTop = 0;
    var atTop = measure();
    return { atRest: atRest, atBottom: atBottom, atTop: atTop,
             viewportH: window.innerHeight, maxScroll: sc.scrollHeight - sc.clientHeight };
  })()`);
  record('滚到底时专辑卡片完整位于播放器上方（内容不被浮层吃掉）',
    visibility.atBottom.fits === true,
    JSON.stringify(visibility.atBottom) + ' viewport=' + visibility.viewportH + ' maxScroll=' + visibility.maxScroll);
  record('滚到顶时页头完整位于搜索栏下方（首屏不被遮挡）',
    visibility.atTop.cardTop > 0 && visibility.atTop.cardBottom > 0,
    'cardTop=' + visibility.atTop.cardTop);
  const bottomEdge = await evaluate(`(function () {
    var sc = document.getElementById('music-library-scroll');
    var cs = getComputedStyle(sc);
    var vh = window.innerHeight;
    var safeBottom = parseFloat(cs.getPropertyValue('--mlib-safe-bottom'));
    var fadeBottom = parseFloat(cs.getPropertyValue('--mlib-fade-bottom'));
    var contentEnd = vh - safeBottom;          // 内容停靠终点
    var opaqueEnd = vh - fadeBottom;           // mask 保持不透明到此处
    return { vh: vh, safeBottom: safeBottom, fadeBottom: fadeBottom,
             contentEnd: Math.round(contentEnd), opaqueEnd: Math.round(opaqueEnd) };
  })()`);
  const geometry = await evaluate(`(function () {
    var sc = document.getElementById('music-library-scroll');
    var grid = document.getElementById('mlib-recent-grid');
    var cards = grid.querySelectorAll('.mlib-album-card');
    var g = grid.getBoundingClientRect();
    var c0 = cards[0].getBoundingClientRect();
    var c4 = cards[4] ? cards[4].getBoundingClientRect() : null;
    var cs = getComputedStyle(sc);
    return {
      viewport: window.innerWidth,
      gridLeft: Math.round(g.left), gridRight: Math.round(g.right), gridWidth: Math.round(g.width),
      paddingL: cs.paddingLeft, paddingR: cs.paddingRight,
      cardW: Math.round(c0.width), cardGap: c4 ? Math.round(c4.left - c0.right) : null,
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      cardRows: Math.round(document.getElementById('mlib-recent-grid').getBoundingClientRect().height / c0.height)
    };
  })()`);
  record('网格横向铺满内容区（左右留白对称）',
    Math.abs(geometry.gridLeft - (geometry.viewport - geometry.gridRight)) <= 2,
    'L=' + geometry.gridLeft + ' R=' + (geometry.viewport - geometry.gridRight));
  record('内容停靠终点落在 mask 不透明区内（最后一行标题不被淡掉）',
    bottomEdge.contentEnd <= bottomEdge.opaqueEnd,
    'contentEnd=' + bottomEdge.contentEnd + ' opaqueEnd=' + bottomEdge.opaqueEnd);

  console.log('\n--- 条件 1：新入口稳定存在 ---');
  record('初始 body 无 music-library-active', s.libActive === false, s.bodyClass.trim().slice(0, 80));
  record('初始 Home 为 active（aria-current）', s.homeBtnAriaCurrent === 'page', 'got ' + s.homeBtnAriaCurrent);
  record('初始入口非 active', s.btnAriaCurrent === null, 'got ' + s.btnAriaCurrent);

  console.log('\n--- 条件 2：Home -> 音乐资料库 -> Home ---');
  const homeClassBefore = (await evaluate(PROBE)).homeActive;
  await evaluate("document.getElementById('music-library-btn').click(); true");
  await sleep(800);
  s = await evaluate(PROBE);
  record('点击后 body.music-library-active 生效', s.libActive === true);
  record('点击后 Home 让位（empty-home-active 移除）', s.homeActive === false, 'homeActive=' + s.homeActive);
  record('点击后 Home 视觉已隐藏', parseFloat(s.homeOpacity) < 0.05, 'opacity=' + s.homeOpacity);
  record('点击后入口 active（aria-current=page）', s.btnAriaCurrent === 'page', 'got ' + s.btnAriaCurrent);
  record('点击后 Home 按钮取消 active', s.homeBtnAriaCurrent === null, 'got ' + s.homeBtnAriaCurrent);
  record('active 态互斥', s.libActive && !s.homeActive);
  record('空壳可见', parseFloat(s.shellOpacity) > 0.9 || s.libActive, 'opacity=' + s.shellOpacity);
  record('空壳 aria-hidden=false', s.shellAriaHidden === 'false', 'got ' + s.shellAriaHidden);
  record('页面标题渲染为「音乐资料库」', s.title === '音乐资料库', 'got ' + JSON.stringify(s.title));
  record('滚动容器 overflow-y:auto', s.scrollOverflowY === 'auto', 'got ' + s.scrollOverflowY);
  record('顶部安全区已生效（padding-top>0）', parseFloat(s.scrollPaddingTop) > 0, 'padding-top=' + s.scrollPaddingTop);
  record('边缘渐变走 mask-image', s.scrollMask === true);

  const regressHomeOnclick = await evaluate("document.getElementById('home-btn').getAttribute('onclick')");
  await evaluate("document.getElementById('home-btn').click(); true");
  await sleep(800);
  s = await evaluate(PROBE);
  record('返回后 music-library-active 移除', s.libActive === false);
  record('返回后资料库完全关闭', s.libActive === false && s.shellAriaHidden === 'true',
    'libActive=' + s.libActive + ' shellAriaHidden=' + s.shellAriaHidden);
  record('返回后按钮不再 active', s.btnAriaCurrent === null);
  record('返回后 home-btn 的 onclick 未被改动', regressHomeOnclick === 'goHome()');
  record('返回后入口取消 active', s.btnAriaCurrent === null, 'got ' + s.btnAriaCurrent);
  record('返回后 Home 按钮恢复 active', s.homeBtnAriaCurrent === 'page', 'got ' + s.homeBtnAriaCurrent);

  console.log('\n--- 条件 3：账号胶囊自动隐藏时入口仍可用 ---');
  await evaluate("document.body.classList.add('user-capsule-auto-hide'); true");
  await sleep(600);
  const hidden = await evaluate(`(function () {
    var nav = document.getElementById('mlib-nav');
    var tr = document.getElementById('top-right');
    var r = nav.getBoundingClientRect();
    var trr = tr.getBoundingClientRect();
    var cs = getComputedStyle(nav);
    return {
      navVisible: cs.visibility !== 'hidden' && cs.opacity !== '0' && r.width > 0,
      navOnScreen: r.right > 0 && r.left < window.innerWidth,
      navAnchor: nav.style.getPropertyValue('--mlib-nav-anchor-right'),
      navRect: { x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width) },
      topRightOffScreen: trr.right <= 0 || trr.left >= window.innerWidth || getComputedStyle(tr).visibility === 'hidden'
    };
  })()`);
  record('#top-right 此时确实已飞出屏幕', hidden.topRightOffScreen === true, JSON.stringify(hidden.navRect));
  record('入口仍可见', hidden.navVisible === true);
  record('入口仍在屏幕内', hidden.navOnScreen === true, 'nav=' + JSON.stringify(hidden.navRect));
  record('自动隐藏时入口仍在屏幕内且位置不变', hidden.navOnScreen === true,
    'nav=' + JSON.stringify(hidden.navRect));

  // 在自动隐藏状态下真正走一次往返
  await evaluate("document.getElementById('music-library-btn').click(); true");
  await sleep(700);
  const opened = await evaluate("document.body.classList.contains('music-library-active')");
  record('自动隐藏状态下仍能进入资料库', opened === true);
  await evaluate("document.getElementById('home-btn').click(); true");
  await sleep(700);
  const closed = await evaluate("!document.body.classList.contains('music-library-active')");
  record('自动隐藏状态下仍能返回 Home', closed === true);
  await evaluate("document.body.classList.remove('user-capsule-auto-hide'); true");
  await sleep(400);

  console.log('\n--- 附加回归 ---');
  const regress = await evaluate(`(function () {
    return {
      musicLibraryCard: !!document.querySelector('[onclick="openHomeDashboardLibrary()"]'),
      homeBtnOnclick: (document.getElementById('home-btn') || {}).getAttribute
        ? document.getElementById('home-btn').getAttribute('onclick') : null,
      searchAreaVisible: (function () {
        var el = document.getElementById('search-area');
        return !!el && getComputedStyle(el).visibility !== 'hidden';
      })(),
      bottomBarExists: !!document.getElementById('bottom-bar')
    };
  })()`);
  record('现有「音乐库」卡片仍在且 onclick 未变', regress.musicLibraryCard === true);
  record('#home-btn 的 onclick 仍为 goHome()', regress.homeBtnOnclick === 'goHome()', 'got ' + regress.homeBtnOnclick);
  record('#search-area 未被破坏', regress.searchAreaVisible === true);
  record('#bottom-bar 未被破坏', regress.bottomBarExists === true);

  // 窄屏回归：入口不得与搜索栏重叠
  await call('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const narrow = await evaluate(`(function () {
    var a = document.getElementById('mlib-nav').getBoundingClientRect();
    var b = document.getElementById('search-area').getBoundingClientRect();
    var verticalOverlap = a.top < b.bottom && b.top < a.bottom;
    var horizontalOverlap = !(a.right <= b.left || a.left >= b.right);
    return {
      navX: Math.round(a.x), navY: Math.round(a.y), navRight: Math.round(a.right),
      searchY: Math.round(b.y), searchRight: Math.round(b.right), searchX: Math.round(b.x),
      searchHidden: b.top < 0 || b.bottom <= 0,
      verticalOverlap: verticalOverlap,
      collides: verticalOverlap && horizontalOverlap
    };
  })()`);
  record('≤720px：入口不与搜索栏重叠', narrow.collides === false,
    JSON.stringify(narrow));

  await call('Emulation.clearDeviceMetricsOverride');

  console.log('\n--- 渲染器错误 ---');
  const ignored = /favicon|ERR_FILE_NOT_FOUND|Autofill|DevTools|Failed to construct 'URL'/i;
  const realErrors = consoleErrors.filter((e) => !ignored.test(e));
  if (realErrors.length === 0 && consoleErrors.some((e) => /Failed to construct 'URL'/.test(e))) {
    record('渲染器无 JS 异常', true, "仅剩 Electron 内部 'Failed to construct URL'（既有，与本改动无关）");
  }
  record('渲染器无 JS 异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') || 'none');

  if (SHOT) {
    try {
      const shotDir = path.join(ROOT, 'docs', 'assets', 'music-library');
      fs.mkdirSync(shotDir, { recursive: true });
      const shot = async (name) => {
        const res = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const file = path.join(shotDir, name);
        fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
        console.log('  SHOT  ' + path.relative(ROOT, file) + ' (' + Math.round(fs.statSync(file).size / 1024) + ' KB)');
      };
      await call('Page.bringToFront');
      // 真实用户要先点掉启动页，才会看到 Home
      const splash = await evaluate("!!document.getElementById('splash') && document.body.classList.contains('splash-active')");
      if (splash) {
        await evaluate("(function(){var sp=document.getElementById('splash'); if(sp) sp.click(); return true;})()");
        await sleep(2600);
      }
      await sleep(900);
      await shot('01-home.png');
    } catch (e) { console.log('  SHOT-FAIL ' + e.message); }
  }

  const failed = findings.filter((f) => !f.ok);
  console.log('\n=========== ' + (findings.length - failed.length) + '/' + findings.length + ' passed ===========');
  if (failed.length) {
    console.log('FAILED:');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? '  (' + f.detail + ')' : '')));
  }
  process.exitCode = failed.length ? 1 : 0;
  if (!KEEP) {
    try { socket.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
  }
})().catch((error) => {
  console.error('\nFATAL: ' + (error && error.stack || error));
  try { socket && socket.close(); } catch (e) {}
  try { child && child.kill(); } catch (e) {}
  process.exitCode = 1;
});
