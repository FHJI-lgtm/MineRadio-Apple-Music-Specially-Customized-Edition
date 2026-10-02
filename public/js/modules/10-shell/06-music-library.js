'use strict';

/* ------------------------------------------------------------------
 * 音乐资料库 / Music Library —— Phase 1（P1-Nav）
 *
 * 本阶段只做三件事：
 *   1. 顶部导航入口（#music-library-btn）能稳定存在；
 *   2. Home <-> 音乐资料库 双向切换，active 互斥；
 *   3. 账号胶囊自动隐藏时入口仍完全可用。
 *
 * P1.0：最近添加 + 专辑两个区块，数据来自 /api/apple/library/albums。
 * 排序由读取层负责，这里只按接口返回顺序渲染。
 *
 * 设计依据：docs/MUSIC_LIBRARY_PAGE_DESIGN.md 0.2 节
 *   - active 态唯一真相源是 body class，不由 JS 切 class；
 *   - #mlib-nav 只有定位，视觉全部继承既有 .icon-btn；
 *   - 不引入 Provider / registry / capability 抽象（0.3 节护栏）。
 * ------------------------------------------------------------------ */
(function initMusicLibraryShell() {
  var closingTimer = null;

  function navEl() { return document.getElementById('mlib-nav'); }
  function shellEl() { return document.getElementById('music-library'); }
  function buttonEl() { return document.getElementById('music-library-btn'); }

  function isLibraryOpen() {
    return document.body.classList.contains('music-library-active');
  }

  // 入口位置完全交给 CSS（#mlib-nav 锚在左侧、no-drag）。
  // 曾经的"实测 #top-right 宽度再算锚点"已随入口移到左侧而删除：
  // 右侧宽度会随账号胶囊/多账号变化，而左侧是一个常量，没必要引入运行时测量。
  function syncMlibNavState() {
    var open = isLibraryOpen();
    var btn = buttonEl();
    if (btn) {
      // 只是把视觉上已经成立的 active 态同步给读屏，不参与视觉表达
      if (open) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }
    var homeBtn = document.getElementById('home-btn');
    if (homeBtn) {
      if (open) homeBtn.removeAttribute('aria-current');
      else homeBtn.setAttribute('aria-current', 'page');
    }
    var shell = shellEl();
    if (shell) shell.setAttribute('aria-hidden', open ? 'false' : 'true');
  }

  // ----------------------------------------------------------------
  // 资料库专辑数据：/api/apple/library/albums
  //
  // 排序不在这里。读取层已经读完整库、按 dateAdded 排好新→旧再切窗口，
  // 所以这里拿到的就是全局序，前端只负责"照这个顺序展示"。
  // 任何时候都不要在这个文件里加 sort —— 那会让分页重新变成每页各自排序。
  // ----------------------------------------------------------------
  var MLIB_ALBUMS_LIMIT = 1000;  // 专辑：整个资料库（实测 549，留足余量）

  // 副标题只展示接口确实给了的事实：歌手 + 发行年。
  // 不用 dateAdded 当"加入日期"展示 —— 那需要确认时区语义，这刀不碰。
  function albumSubtitle(album) {
    var parts = [];
    var artist = String(album.artist || '').trim();
    if (artist) parts.push(artist);
    var year = String(album.releaseDate || '').slice(0, 4);
    if (/^\d{4}$/.test(year)) parts.push(year);
    if (!parts.length && Number(album.trackCount) > 0) parts.push(album.trackCount + ' 首');
    return parts.join(' · ') || '未知专辑';
  }

  // 渲染过的专辑数据：键 = 专辑 id（与卡片的 data-album-id 一一对应）。
  // 卡片重建时重填；旧条目留着不会张冠李戴（id 是唯一键）。
  var albumPayloads = Object.create(null);

  // 播放图标（播放态）。用内联 SVG，与项目既有图标同一套画法，不新增图标依赖。
  function playGlyphSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 5.5v13l10.5-6.5z"/></svg>';
  }

  function albumCardHtml(album) {
    var cover = String(album.cover || '').trim();
    var img = cover
      ? '<img src="' + escHtml(cover) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
      : '';
    // 专辑数据存模块内 Map，按 id 取回 —— 不塞进 HTML 属性。
    // （塞属性需要 JSON+HTML 双层转义，实测会把属性值截断在第一个引号处。）
    if (album && album.id) albumPayloads[String(album.id)] = album;
    // 按钮放在封面容器内，定位相对封面；type=button 避免任何表单语义。
    // aria-label 带专辑名，读屏能区分不同卡片的同一个按钮。
    var name = String(album.name || '未命名专辑');
    return '<article class="mlib-album-card" role="listitem" data-album-id="' + escHtml(album.id || '') + '">' +
      '<div class="mlib-art' + (cover ? '' : ' is-loaded') + '">' + img +
      '<button class="mlib-play-btn" type="button" data-mlib-play="1"' +
      ' title="播放专辑" aria-label="播放专辑：' + escHtml(name) + '">' + playGlyphSvg() + '</button>' +
      '</div>' +
      '<div class="mlib-album-meta">' +
      '<div class="mlib-album-name" title="' + escHtml(name) + '">' + escHtml(name) + '</div>' +
      '<div class="mlib-album-sub">' + escHtml(albumSubtitle(album)) + '</div>' +
      '</div></article>';
  }

  function bindCover(img) {
    var art = img.parentNode;
    var done = function () { if (art) art.classList.add('is-loaded'); };
    if (img.complete && img.naturalWidth) { done(); return; }
    img.addEventListener('load', done, { once: true });
    // 封面失败时不显示破图，退化成骨架底色（保持版面稳定）
    img.addEventListener('error', function () {
      if (art) { art.classList.add('is-loaded'); img.remove(); }
    }, { once: true });
  }

  // 通用区块：最近添加与专辑共用同一条渲染/加载路径，避免两套各写一遍。
  function createAlbumSection(config) {
    var state = { loaded: false, loading: false };
    function gridEl() { return document.getElementById(config.gridId); }
    function pick(id) { return document.getElementById(id); }

    function setState(text, tone) {
      var el = pick(config.stateId);
      if (!el) return;
      if (!text) { el.hidden = true; el.textContent = ''; el.removeAttribute('data-tone'); return; }
      el.hidden = false;
      el.textContent = text;
      if (tone) el.setAttribute('data-tone', tone); else el.removeAttribute('data-tone');
    }

    function render(albums, total) {
      var grid = gridEl();
      if (!grid) return;
      var list = Array.isArray(albums) ? albums : [];
      grid.innerHTML = list.map(albumCardHtml).join('');
      Array.prototype.forEach.call(grid.querySelectorAll('.mlib-art img'), bindCover);
      grid.setAttribute('aria-busy', 'false');
      var count = pick(config.countId);
      if (count) count.textContent = total > list.length ? (list.length + ' / ' + total) : (total ? String(total) : '');
      var hint = config.hintId ? pick(config.hintId) : null;
      if (hint) {
        if (total > list.length) { hint.hidden = false; hint.textContent = '已显示前 ' + list.length + ' 张，共 ' + total + ' 张'; }
        else { hint.hidden = true; hint.textContent = ''; }
      }
    }

    // 由外部（loadLibraryAlbums）喂数据，区块自己不发请求。
    function apply(data) {
      var grid = gridEl();
      if (grid) grid.setAttribute('aria-busy', 'false');
      var picked = pickAlbums(data, config.limit);
      if (!picked.total) {
        setState((data && (data.error || data.message)) || '资料库里还没有可显示的专辑。',
          (data && data.error) ? 'warn' : '');
        state.loaded = true;
        return;
      }
      render(picked.list, picked.total);
      state.loaded = true;
      if (data && (data.error || data.probeFailed)) {
        setState(data.error ? ('索引刷新失败：' + data.error) : '索引暂时无法校验更新，显示的可能是稍早的数据。', 'warn');
      } else {
        setState('');
      }
    }

    function begin() {
      state.loading = true;
      var grid = gridEl();
      if (grid) grid.setAttribute('aria-busy', 'true');
      setState('正在读取资料库索引…');
    }

    function fail(err) {
      state.loading = false;
      setState('读取资料库索引失败：' + (err && err.message ? err.message : '未知错误'), 'warn');
      var grid = gridEl();
      if (grid) grid.setAttribute('aria-busy', 'false');
    }

    return { apply: apply, begin: begin, fail: fail, render: render, setState: setState, state: state };
  }

  // 资料库页的数据来源：本地索引。
  // 只在 Apple 有变化时才重新对账并重渲染 —— 打开页面不再每次都扫全库。
  var libraryIndexInflight = null;
  var libraryIndexSnapshot = null;

  function fetchLibraryIndex() {
    if (libraryIndexInflight) return libraryIndexInflight;   // 两个区块共用一次请求
    libraryIndexInflight = apiJson('/api/apple/library/index')
      .then(function (data) {
        libraryIndexSnapshot = data;
        return data;
      })
      .then(function (d) { libraryIndexInflight = null; return d; },
        function (err) { libraryIndexInflight = null; throw err; });
    return libraryIndexInflight;
  }

  // 变更检测：Apple 侧有变化（changed=true）时才需要把列表换掉。
  function libraryIndexChanged(data) {
    return !!(data && data.changed);
  }

  function pickAlbums(data, limit) {
    var all = (data && Array.isArray(data.albums)) ? data.albums : [];
    // 索引里的顺序就是 dateAdded 新→旧（同步时按同一规则排好），这里只切片。
    return { list: all.slice(0, limit), total: all.length };
  }

  var albumsSection = createAlbumSection({
    gridId: 'mlib-albums-grid',
    countId: 'mlib-albums-count',
    stateId: 'mlib-albums-state',
    hintId: 'mlib-albums-hint',
    limit: MLIB_ALBUMS_LIMIT
  });

  // 打开资料库页：一次请求拿本地索引（内含"Apple 是否有变动"的探测结果）。
  // 已有数据且 Apple 无变化时不重复渲染，避免无谓的 DOM 重建与滚动位置丢失。
  function loadLibraryAlbums() {
    if (typeof apiJson !== 'function') return;
    var first = !(libraryIndexSnapshot && libraryIndexSnapshot.albums);
    if (first) { albumsSection.begin(); }
    return fetchLibraryIndex().then(function (data) {
      var changed = first || libraryIndexChanged(data);
      if (!changed) return data;
      albumsSection.apply(data);
      return data;
    }).catch(function (err) {
      if (first) { albumsSection.fail(err); }
      else { setLibraryIndexStale(err); }
      return null;
    });
  }

  // 已有数据时刷新失败：保留当前列表，只在提示区说明，不把网格清空。
  function setLibraryIndexStale(err) {
    var msg = '索引刷新失败：' + (err && err.message ? err.message : '未知错误') + '（继续显示已有数据）';
    var s2 = document.getElementById('mlib-albums-state');
    [s2].forEach(function (el) {
      if (!el) return;
      el.hidden = false;
      el.textContent = msg;
      el.setAttribute('data-tone', 'warn');
    });
  }

  // ----------------------------------------------------------------
  // 专辑播放
  //
  // 复用的是**已有的 Apple Music 播放入口**：window.mineradio.amc.playPlaylist，
  // 与 04-shelf/01-manager-core.js 的「播放歌单」、06-lyrics 面板的「播放歌单」同一条
  // IPC（amc:play-playlist → appleMusicControl.playPlaylist）。
  //
  // 现状（如实记录，不粉饰）：
  //   - AMC 只暴露 searchTracks / playTrack / playPlaylist / openLogin，**没有专辑级入口**；
  //   - desktop/apple-music-control.js 文件头写明 "No queue / album play / artist pages ... in this slice"；
  //   - playPlaylist 的定位方式是"按名字搜索 → 切到资料库 scope → 点卡片"，
  //     payload.url 存在时会跳过名字搜索直接导航（确定性更强）。
  //   - 资料库专辑的 appleUrl 在 payload 里就是空的（web-api 注释：library album 不携带 catalog 链接），
  //     所以这里没有 url 可传，只能走名字搜索那条路。
  // 因此：本次**不新增任何搜索/兜底逻辑**，直接把专辑名交给这条既有链路。
  // 已知限制（本次不解决）：同名专辑会 AMBIGUOUS；链路判定是 SMTC 转换，不是"歌对了"。
  // ----------------------------------------------------------------
  var AMC_ALBUM_SCOPE_LABEL = '你的资料库';   // 与 02-playlist-detail.js 实测到的同一个本地化标签
  var AMC_ALBUM_SECTION_LABEL = '专辑';        // 搜索结果里「专辑」分组（同名专辑卡 vs 同名单曲行的消歧依据）

  function readCardAlbum(card) {
    if (!card || !card.getAttribute) return null;
    var id = card.getAttribute('data-album-id');
    if (!id) return null;
    return albumPayloads[id] || null;
  }

  function playLibraryAlbum(album) {
    var name = String((album && album.name) || '').trim();
    if (!name) {
      if (typeof showToast === 'function') showToast('这张专辑没有可用的名称，无法交给 Apple Music');
      return;
    }
    var amc = window.mineradio && window.mineradio.amc;
    if (!amc || typeof amc.playAlbum !== 'function') {
      // 沿用项目既有措辞，不新造错误文案
      if (typeof showToast === 'function') showToast('Apple Music 播放不可用（IPC 未就绪）');
      return;
    }
    if (typeof showToast === 'function') showToast('交给 Apple Music 播放：' + name);
    var payload = { name: name, scopeLabel: AMC_ALBUM_SCOPE_LABEL, sectionLabel: AMC_ALBUM_SECTION_LABEL };
    Promise.resolve(amc.playAlbum(payload)).then(function (res) {
      if (typeof showToast !== 'function') return;
      var stage = (res && res.stage) || 'NO_RESULT';
      var via = (res && res.playVia) || '';
      // 只有链路自己报的 verified 才算成功 —— 不把"点了"当成"在播"
      if (res && res.verified) showToast('✓ Apple Music 已开始播放：' + name + (via ? ' · ' + via : ''));
      else if (stage === 'AMBIGUOUS') showToast('资料库里有多个同名专辑，无法确定播哪一个');
      else if (stage === 'PLAYLIST_NOT_FOUND') showToast('Apple Music 资料库里没找到：' + name);
      // 范围硬闸门：链侧没能在『你的资料库』范围内确认目标就中止了 ——
      // 这不是"没找到"，而是"没能进入资料库范围"，绝不能当成目录里的同名条目来播。
      else if (stage === 'SCOPE_NOT_VERIFIED') showToast('未能切入 Apple Music「你的资料库」范围，已中止播放（不会去目录里找同名专辑）');
      else if (stage === 'SCOPE_CHIP_NOT_FOUND') showToast('找不到 Apple Music 的「你的资料库」范围按钮，已中止播放');
      // 链侧卡死由 JS 硬 deadline 兜底清理，这里给出可重试的明确提示，
      // 不再让"卡住"表现成"点了没反应"。
      else if (stage === 'UIA_TIMEOUT') showToast('Apple Music 响应超时（已在 ' + Math.round((res && res.elapsedMs || 0) / 1000) + 's 后终止），可以重试');
      else if (stage === 'RESULT_NOT_STABLE') showToast('搜索结果还没稳定，稍后重试');
      else showToast('Apple Music 播放失败：' + stage);
    }).catch(function () {
      if (typeof showToast === 'function') showToast('Apple Music 播放失败（IPC 错误）');
    });
  }

  // 专辑详情页（10-shell/07-album-detail.js）复用同一个播放入口，避免两套语义。
  window.playMlibAlbum = playLibraryAlbum;

  // 事件委托挂在两个网格上：卡片是 innerHTML 重建的，逐个绑定会随重渲染失效。
  // 用 closest 取到"这一张卡片"，所以永远只用当前卡片自己的数据。
  function bindAlbumPlayDelegation() {
    var grids = [document.getElementById('mlib-albums-grid')];
    grids.forEach(function (grid) {
      if (!grid || grid.dataset.mlibPlayBound === '1') return;
      grid.dataset.mlibPlayBound = '1';

      grid.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        var card = target.closest('.mlib-album-card');
        if (!card || !grid.contains(card)) return;
        var album = readCardAlbum(card);

        var playBtn = target.closest('[data-mlib-play]');
        if (playBtn) {
          // 阻止冒泡：播放按钮与"点封面"是两个不同动作，不能一次点击同时触发。
          event.preventDefault();
          event.stopPropagation();
          playLibraryAlbum(album);
          return;
        }

        // 点卡片主体 -> 打开专辑详情页（用这张卡片自己的资料库专辑数据）。
        // 播放按钮分支已在上方 return，所以两者互斥。
        if (typeof window.openAmAlbumDetail === 'function') {
          event.preventDefault();
          window.openAmAlbumDetail(album);
          return;
        }
        // 详情模块尚未就绪时的降级：保持"点封面即播放"的既有行为。
        if (target.closest('.mlib-art')) {
          event.preventDefault();
          playLibraryAlbum(album);
        }
      }, true);

      // 键盘：卡片可聚焦，Enter/Space 打开详情（与鼠标点击同一入口）
      grid.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        var target = event.target;
        if (!target || !target.closest) return;
        // 播放按钮自己有独立语义，不在这里抢
        if (target.closest('[data-mlib-play]')) return;
        var card = target.closest('.mlib-album-card');
        if (!card || !grid.contains(card)) return;
        if (typeof window.openAmAlbumDetail !== 'function') return;
        event.preventDefault();
        window.openAmAlbumDetail(readCardAlbum(card));
      });
    });
  }

  // 桌面/hover 能力探测：用 matchMedia 的结果落一个根类，CSS 据此决定按钮显隐。
  // 不用纯 CSS @media (hover:none)：在 CDP 模拟等环境下它会误命中，把桌面按钮变成常显。
  function applyMlibInputMode() {
    var hasHover = true;
    try {
      hasHover = !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
    } catch (_) { hasHover = true; }
    document.documentElement.classList.toggle('mlib-has-hover', hasHover);
  }

  // ----------------------------------------------------------------
  // 双击两侧空白区 -> 进入歌词舞台
  //
  // 边界（已确认）：
  //   * 只进入，不切换：已经在舞台时双击不做任何事（不关掉它）；
  //   * 只在内容列之外的左右条带内生效，中间区域完全不受影响；
  //   * 只在音乐资料库页生效。
  //
  // 为什么不挂在 renderer.domElement 上：资料库打开时 #music-library 是 fixed/inset:0 且

  // pointer-events:auto，盖在 canvas 之上，canvas 上的既有双击（回正相机）根本收不到事件。
  // 所以这个手势挂在资料库容器自己身上，不会碰既有的双击回正。
  // 键盘/读屏用户仍可用底部「词」按钮（既有路径）。

  function lyricsStageIsOn() {
    try {
      return !!(typeof fx !== 'undefined' && fx && fx.particleLyrics);
    } catch (_) { return false; }
  }

  function pointerInSideGutter(event) {
    // 用真实内容元素的边界判定，而不是自己算：(--mlib-gutter 是自定义属性，getPropertyValue
    // 返回的是未解析的 clamp(...) 字符串，parseFloat 得 0；自己算不如直接量。)
    var sections = document.querySelectorAll('#music-library .mlib-section');
    if (!sections.length) return false;   // 还没有内容时不接管这个手势
    var first = sections[0].getBoundingClientRect();
    var last = sections[sections.length - 1].getBoundingClientRect();
    var colLeft = first.left;
    var colRight = last.right;
    if (!(colRight > colLeft)) return false;
    var x = event.clientX;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    // 严格在内容列之外：列内（卡片、文字、任何区块）一律不触发。
    return (x > 0 && x < colLeft) || (x > colRight && x < vw);
  }

  function bindLyricsStageGesture() {
    if (document.documentElement.dataset.mlibLyricsGesture === '1') return;
    document.documentElement.dataset.mlibLyricsGesture = '1';
    // 必须挂在 document 上：#canvas-container 是 #music-library 的兄弟节点，
    // canvas 上的双击不会冒泡到资料库容器，挂在那里收不到事件。
    // 用 isLibraryOpen() 把生效范围限定在音乐资料库页（首页维持既有双击回正）。
    document.addEventListener('dblclick', function (event) {
      if (!isLibraryOpen()) return;
      // 两侧条带上可能压着搜索栏/导航/播放器这类浮层，落在它们上面时不触发。
      if (typeof isPointerOverUi === 'function' && isPointerOverUi(event)) return;
      if (!pointerInSideGutter(event)) return;
      // 只进入：已在舞台则无操作（也不重复弹提示）。
      if (lyricsStageIsOn()) return;
      if (typeof toggleLyricsPanel !== 'function') return;
      event.preventDefault();
      toggleLyricsPanel(true);
    });
  }

  function syncEmptyHomeForLibrary() {
    if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility();
  }

  function openMusicLibrary() {
    if (closingTimer) { clearTimeout(closingTimer); closingTimer = null; }
    document.body.classList.remove('music-library-leaving');
    document.body.classList.add('music-library-active');
    // 资料库首屏需要搜索栏在位（页面顶部结构依赖它），复用既有 peek 机制
    if (typeof setPeek === 'function') setPeek(document.getElementById('search-area'), true, 'search');
    syncEmptyHomeForLibrary();
    syncMlibNavState();
    var scroll = document.getElementById('music-library-scroll');
    if (scroll) scroll.scrollTop = 0;
    applyMlibInputMode();
    bindAlbumPlayDelegation();
    bindLyricsStageGesture();
    loadLibraryAlbums();
  }

  function closeMusicLibrary() {
    if (!isLibraryOpen()) return;
    document.body.classList.remove('music-library-active');
    syncEmptyHomeForLibrary();
    syncMlibNavState();
  }

  function toggleMusicLibrary() {
    if (isLibraryOpen()) closeMusicLibrary();
    else openMusicLibrary();
  }

  // Home 返回入口：既有 #home-btn 的 goHome() 是"切换/收起"语义
  // （emptyHomeActive 为 false 时它会走 homeForcedOpen 分支而收起首页），
  // 而从资料库返回应当是"关闭资料库，Home 按原逻辑自然恢复"。
  // goHome() 本身不改 —— 在捕获阶段先关掉资料库，再让它的原有逻辑跑。
  function bindHomeReturn() {
    var homeBtn = document.getElementById('home-btn');
    if (!homeBtn || homeBtn.dataset.mlibBound === '1') return;
    homeBtn.dataset.mlibBound = '1';
    homeBtn.addEventListener('click', function (event) {
      // 命中判定必须用 contains：按钮里是 <svg><path>，用户点"首页图标"时
      // event.target 是那个 path 而不是按钮本身。用 === 比较会漏掉绝大多数点击，
      // 表现为"点首页图标有时回不去"。
      if (!homeBtn.contains(event.target)) return;
      if (!isLibraryOpen()) return;
      // 先关掉资料库，再让既有的 inline onclick="goHome()" 按原逻辑跑
      // （goHome 本身不改：它此时看到 emptyHomeActive=false，会走"打开 Home"分支）。
      closeMusicLibrary();
    }, true);
  }

  // 全局暴露给 inline onclick（模块是拼接加载的，但仍显式挂到 window）
  window.openMusicLibrary = openMusicLibrary;
  window.closeMusicLibrary = closeMusicLibrary;
  window.toggleMusicLibrary = toggleMusicLibrary;
  // 供胶囊自动隐藏状态变化时重算锚点（02-preferences-ui-modes.js 调用）
  window.syncMlibNavState = syncMlibNavState;
  // 只读解析 seam：给定卡片元素，返回播放时会用到的专辑对象。
  // 它不参与播放路径（playLibraryAlbum 走的是同一个 readCardAlbum），
  // 存在的唯一目的是让"卡片 → 专辑"的绑定可被测试与调试验证 ——
  // IPC 边界由 contextBridge 暴露为只读对象，无法从外部替换 amc 打桩。
  window.__mlibAlbumForCard = function (card) { return readCardAlbum(card); };
  // 测试/预览用钩子：把一组专辑喂给**真实渲染路径**。
  // 存在的理由：本地没有 Apple 凭据时，专辑墙的版面无法通过真实接口验证。
  // 它不做任何排序或加工 —— 传进去什么顺序就画什么顺序，和真实数据一致。
  window.__mlibShowAlbumsForPreview = function (albums, total) {
    var list = Array.isArray(albums) ? albums : [];
    albumsSection.render(list, Number(total) || list.length);
    albumsSection.setState('');
    // 关键：不要把它当作"已加载真实数据"。否则真实数据永远不会被请求，
    // 预览就会一直占着网格 —— 这正是第一次验证时封面为空的原因。
    albumsSection.state.loaded = false;
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      syncMlibNavState();
      bindHomeReturn();
    });
  } else {
    syncMlibNavState();
    bindHomeReturn();
  }
})();
