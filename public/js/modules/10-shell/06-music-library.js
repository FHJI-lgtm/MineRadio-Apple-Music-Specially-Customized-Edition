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
  var MLIB_RECENT_LIMIT = 40;    // 最近添加：AM 也只列最近的一部分
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

  function albumCardHtml(album) {
    var cover = String(album.cover || '').trim();
    var img = cover
      ? '<img src="' + escHtml(cover) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
      : '';
    return '<article class="mlib-album-card" role="listitem" data-album-id="' + escHtml(album.id || '') + '">' +
      '<div class="mlib-art' + (cover ? '' : ' is-loaded') + '">' + img + '</div>' +
      '<div class="mlib-album-meta">' +
      '<div class="mlib-album-name" title="' + escHtml(album.name || '') + '">' + escHtml(album.name || '未命名专辑') + '</div>' +
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

    async function load() {
      if (state.loaded || state.loading) return;
      if (typeof apiJson !== 'function') { setState('页面脚本尚未就绪，稍后重试。', 'warn'); return; }
      state.loading = true;
      var grid = gridEl();
      if (grid) grid.setAttribute('aria-busy', 'true');
      setState('正在读取 Apple Music 资料库…');
      try {
        var data = await apiJson('/api/apple/library/albums?limit=' + config.limit + '&offset=0');
        var albums = (data && Array.isArray(data.albums)) ? data.albums : [];
        if (!albums.length) {
          // 未登录 / 出错 / 真的没有专辑，三种情况都要说清楚，不能给一个空网格
          setState((data && data.message) || '资料库里还没有可显示的专辑。', (data && data.error) ? 'warn' : '');
          if (grid) grid.setAttribute('aria-busy', 'false');
          state.loaded = true;
          return;
        }
        render(albums, Number(data.total) || albums.length);
        state.loaded = true;
        if (data.message || data.error) setState(data.message || data.error, 'warn'); else setState('');
      } catch (err) {
        setState('读取 Apple Music 资料库失败：' + (err && err.message ? err.message : '未知错误'), 'warn');
        if (grid) grid.setAttribute('aria-busy', 'false');
      } finally {
        state.loading = false;
      }
    }

    return { load: load, render: render, setState: setState, state: state };
  }

  var recentSection = createAlbumSection({
    gridId: 'mlib-recent-grid',
    countId: 'mlib-recent-count',
    stateId: 'mlib-recent-state',
    limit: MLIB_RECENT_LIMIT
  });
  var albumsSection = createAlbumSection({
    gridId: 'mlib-albums-grid',
    countId: 'mlib-albums-count',
    stateId: 'mlib-albums-state',
    hintId: 'mlib-albums-hint',
    limit: MLIB_ALBUMS_LIMIT
  });

  function loadLibraryAlbums() {
    recentSection.load();
    albumsSection.load();
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
      if (event.target !== homeBtn) return;   // 点击内部 svg 时让既有 handler 处理
      if (!isLibraryOpen()) return;
      closeMusicLibrary();
    }, true);
  }

  // 全局暴露给 inline onclick（模块是拼接加载的，但仍显式挂到 window）
  window.openMusicLibrary = openMusicLibrary;
  window.closeMusicLibrary = closeMusicLibrary;
  window.toggleMusicLibrary = toggleMusicLibrary;
  // 供胶囊自动隐藏状态变化时重算锚点（02-preferences-ui-modes.js 调用）
  window.syncMlibNavState = syncMlibNavState;
  // 测试/预览用钩子：把一组专辑喂给**真实渲染路径**。
  // 存在的理由：本地没有 Apple 凭据时，专辑墙的版面无法通过真实接口验证。
  // 它不做任何排序或加工 —— 传进去什么顺序就画什么顺序，和真实数据一致。
  window.__mlibShowAlbumsForPreview = function (albums, total) {
    var list = Array.isArray(albums) ? albums : [];
    recentSection.render(list, Number(total) || list.length);
    recentSection.setState('');
    // 关键：不要把它当作"已加载真实数据"。否则真实数据永远不会被请求，
    // 预览就会一直占着网格 —— 这正是第一次验证时封面为空的原因。
    recentSection.state.loaded = false;
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
