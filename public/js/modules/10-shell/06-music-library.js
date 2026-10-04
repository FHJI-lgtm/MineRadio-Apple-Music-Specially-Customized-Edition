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
      // 父级计数由 syncNavAlbumCount 统一写入（它显示的是当前视图的数量）。
      if (typeof config.onCount === 'function') config.onCount(list.length, total);
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
  // 快照**按源分开存**：切换源时不能把上一个源的列表留在界面上。
  var libraryIndexSnapshots = {};

  // 每个源的资料库索引端点。返回形状统一为 { albums, changed }。
  function libraryIndexEndpoint(src) {
    if (src === 'netease') return '/api/netease/library/index';
    return '/api/apple/library/index';
  }

  function fetchLibraryIndex(src) {
    var s2 = src || mlibActiveSource;
    if (libraryIndexInflight && libraryIndexInflight.src === s2) return libraryIndexInflight.promise;
    var promise = apiJson(libraryIndexEndpoint(s2))
      .then(function (data) {
        // 网易云端点不返回 changed（那套"探测 Apple 是否有变动"的语义只属于本地索引），
        // 这里补成 true，让上层按"新数据"处理。
        if (data && data.changed === undefined) data.changed = true;
        libraryIndexSnapshots[s2] = data;
        return data;
      })
      .then(function (d) { libraryIndexInflight = null; return d; },
        function (err) { libraryIndexInflight = null; throw err; });
    libraryIndexInflight = { src: s2, promise: promise };
    return promise;
  }

  // 取当前源的快照（计数等处使用）
  function getLibraryIndexSnapshot() {
    return libraryIndexSnapshots[mlibActiveSource] || null;
  }

  // 变更检测：Apple 侧有变化（changed=true）时才需要把列表换掉。
  function libraryIndexChanged(data) {
    return !!(data && data.changed);
  }

  // 当前专辑网格里的数据来自哪个源。
  // 切源时**必须无条件重渲染** —— 不能交给 changed 标记决定，否则会留着上一个源的列表。
  var albumsRenderedSource = '';

  function pickAlbums(data, limit) {
    var all = (data && Array.isArray(data.albums)) ? data.albums : [];
    // 索引里的顺序就是 dateAdded 新→旧（同步时按同一规则排好），这里只切片。
    return { list: all.slice(0, limit), total: all.length };
  }

  var albumsSection = createAlbumSection({
    gridId: 'mlib-albums-grid',
    stateId: 'mlib-albums-state',
    hintId: 'mlib-albums-hint',
    limit: MLIB_ALBUMS_LIMIT,
    onCount: function () { syncNavAlbumCount(); }
  });

  // 打开资料库页：一次请求拿本地索引（内含"Apple 是否有变动"的探测结果）。
  // 已有数据且 Apple 无变化时不重复渲染，避免无谓的 DOM 重建与滚动位置丢失。
  function loadLibraryAlbums() {
    if (typeof apiJson !== 'function') return;
    var snap = getLibraryIndexSnapshot();
    // 网格是空的、或当前网格属于**别的源**时，都按"首次"处理并渲染
    var sourceChanged = albumsRenderedSource !== mlibActiveSource;
    var first = !(snap && snap.albums) || sourceChanged;
    if (first) { albumsSection.begin(); }
    var requestedSource = mlibActiveSource;
    return fetchLibraryIndex(requestedSource).then(function (data) {
      // 期间用户又切了源：丢弃这次结果，别把旧源的数据画到新源下
      if (requestedSource !== mlibActiveSource) return data;
      var changed = first || libraryIndexChanged(data);
      if (!changed) return data;
      albumsSection.apply(data);
      albumsRenderedSource = requestedSource;
      syncNavAlbumCount();
      return data;
    }).catch(function (err) {
      if (first) { albumsSection.fail(err); }
      else { setLibraryIndexStale(err); }
      return null;
    });
  }

  // ---- 音乐源（资料库的数据来源）----
  //
  // 结构：上面是**源**（可展开，用于切换音乐源），下面是**视图**（专辑 / 艺人 / 歌单，常驻）。
  // 视图刻意不可折叠：折叠态一旦被持久化，入口就会消失、看起来"点不动"。
  //
  // 六个源全部登记（需求方要求列出），但只有真正接入数据层的源标 ready:true。
  // 未接入的源渲染为 disabled 并写明「未接入资料库」—— 既如实告知，
  // 又不做成"点进去得到空页面"或"点了没反应"那种会被当成 bug 的形态。
  var MLIB_SOURCE_KEY = 'mineradio.mlib.source';
  // 换键：旧键 'mineradio.mlib.sourceOpen' 曾被写成 0，导致视图入口被折叠隐藏
  // （用户反馈"点不动"）。现在视图常驻，源列表用新键，旧值自然失效。
  var MLIB_SOURCE_OPEN_KEY = 'mineradio.mlib.sourceListOpen';
  // 需求方要求把这六个源都列出来。但**只有 Apple 已接入资料库数据层** ——
  // 其余源如实标注「未接入」且不可点，绝不做成"能点进去的空页面"。
  var MLIB_SOURCES = {
    apple: { label: 'Apple Music', ready: true },
    qq: { label: 'QQ 音乐', ready: false },
    kugou: { label: '酷狗音乐', ready: false },
    // 网易云的「专辑」轴已接入并实测通过（/api/netease/library/index）：
    // 3 个歌单 / 8+251+286 首、专辑按 albumId 正确归并。
    netease: { label: '网易云音乐', ready: true },
    qishui: { label: '汽水音乐', ready: false },
    spotify: { label: 'Spotify', ready: false },
  };
  var MLIB_SOURCE_ORDER = ['apple', 'qq', 'kugou', 'netease', 'qishui', 'spotify'];
  // 未接入的源在界面上统一用这句，保持口径一致
  var MLIB_SOURCE_NOT_READY = '未接入资料库';

  function readActiveSource() {
    var v = readPref(MLIB_SOURCE_KEY);
    return MLIB_SOURCE_ORDER.indexOf(v) >= 0 ? v : 'apple';
  }
  var mlibActiveSource = readActiveSource();
  // 源的展开态 = 视图树的展开态（两者本就是一棵树）。
  // 默认展开：首次进入必须能直接看到三个视图入口。
  var mlibNavOpen = readPref(MLIB_SOURCE_OPEN_KEY) !== '0';

  // 每个源的三个视图计数：{ apple: { albums: '549', artists: '506', playlists: '4' } }
  // 切换源时换一整套，绝不把上一个源的数字留在界面上（那会被读成新源的数据）。
  var navViewCountsBySource = {};
  MLIB_SOURCE_ORDER.forEach(function (s) { navViewCountsBySource[s] = { albums: '', artists: '', playlists: '' }; });

  function sourceCounts(src) {
    var s2 = MLIB_SOURCES[src] ? src : 'apple';
    if (!navViewCountsBySource[s2]) navViewCountsBySource[s2] = { albums: '', artists: '', playlists: '' };
    return navViewCountsBySource[s2];
  }

  function applyNavViewLabel() {
    var text = sourceCounts(mlibActiveSource)[mlibActiveView] || '';
    // 顶级项是**源**：它的标题写源名，右侧写当前视图在该源下的数量。
    var count = document.getElementById('mlib-nav-source-count');
    if (count) count.textContent = text;
    var headingEl = document.getElementById('mlib-nav-source-heading');
    if (headingEl) {
      var cur = MLIB_SOURCES[mlibActiveSource] || {};
      // 标题固定写「音乐源（当前源）」，让"这是干什么用的"一眼可见
      headingEl.textContent = '音乐源（' + (cur.label || 'Apple Music') + '）';
      if (!cur.ready) headingEl.setAttribute('data-mlib-not-ready', '1');
      else headingEl.removeAttribute('data-mlib-not-ready');
    }
    // 子项各自显示自己的数量（只属于当前源）
    MLIB_VIEWS.forEach(function (v) {
      var item = document.getElementById('mlib-nav-count-' + v);
      if (item) item.textContent = sourceCounts(mlibActiveSource)[v] || '';
    });
    var view = document.getElementById('mlib-view-' + mlibActiveView);
    if (view) view.setAttribute('aria-label', MLIB_VIEW_LABELS[mlibActiveView] || '专辑');
  }

  function setNavViewCount(view, text, source) {
    var src = source || mlibActiveSource;
    sourceCounts(src)[view] = text || '';
    if (src === mlibActiveSource) applyNavViewLabel();
  }

  // 专辑数量（本地索引）。只写当前源的计数 —— 其它源的索引尚未接入。
  function syncNavAlbumCount() {
    var snap = getLibraryIndexSnapshot();
    var total = (snap && Array.isArray(snap.albums)) ? snap.albums.length : 0;
    setNavViewCount('albums', total ? String(total) : '');
  }

  // 子菜单里每个入口自带的数量（专辑由 syncNavAlbumCount 写，艺人/歌单在各自视图加载后写）。
  function setNavItemCount(view, text) {
    setNavViewCount(view, text);
  }

  // 已有数据时刷新失败：保留当前列表，只在提示区说明，不把网格清空。
  function setLibraryIndexStale(err) {
    var msg = '索引刷新失败：' + (err && err.message ? err.message : '未知错误') + '（继续显示已有数据）';
    var s3 = document.getElementById('mlib-albums-state');
    if (s3) {
      s3.hidden = false;
      s3.textContent = msg;
      s3.setAttribute('data-tone', 'warn');
    }
  }

  // ----------------------------------------------------------------
  // 纵向导航：源 -> 专辑 / 艺人 / 歌单
  //
  // 状态管理刻意保持轻量（项目没有路由系统）：
  //   - 选中项 = 视图名（'albums' | 'artists' | 'playlists'），用 hidden + is-active 落到 DOM；
  //   - 展开态独立于选中项：折叠/展开不改变当前页面；
  //   - 两者都持久化到 localStorage，与项目既有偏好持久化风格一致（不需要新存储机制）；
  //   - 首次进入固定为专辑：只有**用户自己的选择**才写偏好，默认值不写，
  //     所以"没选过"时永远回到专辑页。
  // ----------------------------------------------------------------
  var MLIB_VIEW_KEY = 'mineradio.mlib.view';
  var MLIB_VIEWS = ['albums', 'artists', 'playlists'];
  var MLIB_VIEW_LABELS = { albums: '专辑', artists: '艺人', playlists: '歌单' };

  function readPref(key) {
    try { return window.localStorage ? window.localStorage.getItem(key) : null; } catch (_) { return null; }
  }
  function writePref(key, value) {
    try { if (window.localStorage) window.localStorage.setItem(key, value); } catch (_) { }
  }
  function readActiveView() {
    var v = readPref(MLIB_VIEW_KEY);
    return MLIB_VIEWS.indexOf(v) >= 0 ? v : 'albums';
  }

  var mlibActiveView = readActiveView();

  function viewEl(name) { return document.getElementById('mlib-view-' + name); }
  function navItemEl(name) { return document.getElementById('mlib-nav-item-' + name); }

  // 展开/收起：**只有源列表可折叠**。视图（专辑/艺人/歌单）常驻，
  // 因为折叠态一旦被持久化，入口就会从界面上消失、看起来"点不动"。
  function applyNavOpen() {
    var parent = document.getElementById('mlib-nav-parent-source');
    var children = document.getElementById('mlib-nav-children-source');
    if (parent) parent.setAttribute('aria-expanded', mlibNavOpen ? 'true' : 'false');
    if (children) children.classList.toggle('is-collapsed', !mlibNavOpen);
  }

  function toggleMlibSourceOpen(force) {
    mlibNavOpen = (typeof force === 'boolean') ? force : !mlibNavOpen;
    applyNavOpen();
    writePref(MLIB_SOURCE_OPEN_KEY, mlibNavOpen ? '1' : '0');
  }

  // 渲染源列表。已接入的源可点；未接入的源 disabled 并标注原因 ——
  // 不用"点了没反应"来表达不可用，那会被当成 bug。
  function renderSourceList() {
    var box = document.getElementById('mlib-nav-children-source');
    if (!box) return;
    box.innerHTML = MLIB_SOURCE_ORDER.map(function (key) {
      var src = MLIB_SOURCES[key] || {};
      var ready = !!src.ready;
      var label = src.label || key;
      var active = key === mlibActiveSource;
      var note = ready ? '' : '<span class="mlib-nav-note">' + escHtml(MLIB_SOURCE_NOT_READY) + '</span>';
      return '<button class="mlib-nav-item' + (active ? ' is-active' : '') + (ready ? '' : ' is-unsupported') + '"' +
        ' id="mlib-nav-source-' + key + '" type="button" role="listitem"' +
        ' data-mlib-source="' + key + '" data-mlib-source-ready="' + (ready ? '1' : '0') + '"' +
        (ready ? '' : ' disabled aria-disabled="true"') +
        (active ? ' aria-current="true"' : '') +
        ' title="' + escHtml(ready ? label : label + '（' + MLIB_SOURCE_NOT_READY + '）') + '">' +
        '<span class="mlib-nav-dot" aria-hidden="true"></span>' +
        '<span class="mlib-nav-label">' + escHtml(label) + '</span>' +
        note +
        '</button>';
    }).join('');
  }

  // 切换源：换掉整套计数并重绘。
  // 目前只有 Apple 一个源已接入，数据侧无需重取；接入新源时在这里挂载该源的加载入口，
  // 并把 MLIB_SOURCES / MLIB_SOURCE_ORDER 一起扩上（DOM 里的源组也按同一结构追加）。
  function setMlibSource(name, opts) {
    opts = opts || {};
    if (MLIB_SOURCE_ORDER.indexOf(name) < 0) name = 'apple';
    if (name === mlibActiveSource) {
      if (opts.persist !== false) writePref(MLIB_SOURCE_KEY, name);
      return;
    }
    mlibActiveSource = name;
    // 必须**重新渲染源列表**：选中态（.is-active / 高亮点）是 renderSourceList 写进 DOM 的，
    // 只调 applyNavViewLabel 的话标题会变、但高亮仍留在上一个源上（看起来像没切换）。
    renderSourceList();
    applyNavViewLabel();
    if (opts.persist !== false) writePref(MLIB_SOURCE_KEY, name);
    // 视图名在源之间保持不变；计数与列表都必须**换成新源的数据**，
    // 否则界面上会留着上一个源的列表和数字（那会被读成新源的内容）。
    if (opts.eager !== false) {
      // 先按新源的缓存把计数落位，再触发加载
      syncNavAlbumCount();
      applyNavViewLabel();
      loadLibraryAlbums();
      if (typeof ensureViewData === 'function') ensureViewData(mlibActiveView);
    }
  }

  // 切换视图：只改 hidden / is-active / aria-current，不动数据。
  // 已经加载过的视图不重复请求（见 ensureViewData 的 loaded 标记）。
  function setMlibView(name, opts) {
    opts = opts || {};
    var eager = opts.eager !== false;
    if (MLIB_VIEWS.indexOf(name) < 0) name = 'albums';
    mlibActiveView = name;
    MLIB_VIEWS.forEach(function (v) {
      var el = viewEl(v);
      if (el) {
        var on = v === name;
        el.hidden = !on;
        el.classList.toggle('is-active', on);
      }
      var item = navItemEl(v);
      if (item) {
        var active = v === name;
        item.classList.toggle('is-active', active);
        if (active) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      }
    });
    applyNavViewLabel();
    if (opts.persist !== false) writePref(MLIB_VIEW_KEY, name);
    if (eager) ensureViewData(name);
  }

  // ---- 艺人视图 ----
  // 数据来自 /api/apple/library/artists（服务端从本地索引聚合，零额外网络）。
  var artistsState = { loaded: false, loading: false, seq: 0, source: '' };
  // 首字母占位规则（规格要求三种情况都要正确）：
  //   英文 -> 第一个有效英文字母，大写（"The Weeknd" -> "T"）
  //   中文 -> 第一个有效汉字（"张杰" -> "张"）
  //   空/无效 -> 通用音乐图标（由调用方给空串，渲染层画图标）
  function artistInitial(name) {
    var s = String(name || '').trim();
    if (!s) return '';
    var latin = s.match(/[A-Za-z]/);
    var han = s.match(/[\u4e00-\u9fff\u3400-\u4dbf]/);
    // 谁先出现用谁（"Aero 张" -> A；"张 Aero" -> 张）
    if (latin && han) return latin.index <= han.index ? latin[0].toUpperCase() : han[0];
    if (latin) return latin[0].toUpperCase();
    if (han) return han[0];
    var any = s.match(/[^\s\p{P}\p{S}]/u);
    return any ? any[0].toUpperCase() : '';
  }

  // 头像 HTML：有可信头像则用图片（加载期间先显示首字母，成功再替换）；
  // 没有则首字母占位；首字母也取不到则音乐图标。**绝不用专辑封面冒充**。
  function artistAvatarHtml(image, name) {
    var initial = artistInitial(name);
    var fallback = initial
      ? '<span class="mlib-artist-initial" aria-hidden="true">' + escHtml(initial) + '</span>'
      : '<span class="mlib-artist-initial is-icon" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
        '<path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" />' +
        '</svg></span>';
    if (!image) return { html: fallback, initial: initial };
    // 图片未加载完/加载失败时，首字母占位仍在下面（图加载成功才隐藏）
    return {
      html: fallback + '<img class="mlib-artist-img" src="' + escHtml(image) + '" alt="" loading="lazy" ' +
        'decoding="async" referrerpolicy="no-referrer">',
      initial: initial,
    };
  }

  function artistCardHtml(artist) {
    var name = String(artist.name || '未知艺人');
    var av = artistAvatarHtml(artist.image, name);
    var sub = [];
    if (artist.albumCount) sub.push(artist.albumCount + ' 张专辑');
    if (artist.songCount) sub.push(artist.songCount + ' 首');
    // 合作关系用小字标注（不建主次分类 —— 目前数据无法可靠区分）
    if (artist.collab) sub.push('合作');
    return '<article class="mlib-album-card mlib-artist-card" role="listitem" tabindex="0"' +
      ' data-mlib-artist-id="' + escHtml(artist.artistId || '') + '"' +
      ' aria-label="打开艺人：' + escHtml(name) + '">' +
      '<div class="mlib-art mlib-artist-art' + (av.initial || !artist.image ? ' is-loaded' : '') + '">' + av.html + '</div>' +
      '<div class="mlib-album-meta">' +
      '<div class="mlib-album-name" title="' + escHtml(name) + '">' + escHtml(name) + '</div>' +
      '<div class="mlib-album-sub">' + escHtml(sub.join(' · ')) + '</div>' +
      '</div></article>';
  }

  // 头像图片的加载/失败处理：**加载期间保留首字母占位**，成功才隐藏占位；
  // 失败则移除 img 并恢复占位 —— 不允许出现破图或空白头像。
  // （img 的 load/error 不冒泡，所以在网格上用捕获阶段委托。）
  function bindArtistAvatar(scope) {
    if (!scope || scope.dataset.mlibArtistAvBound === '1') return;
    scope.dataset.mlibArtistAvBound = '1';
    scope.addEventListener('load', function (event) {
      var img = event.target;
      if (!img || img.tagName !== 'IMG' || !img.classList.contains('mlib-artist-img')) return;
      var art = img.parentNode;
      if (art) { art.classList.add('is-loaded'); art.classList.add('has-image'); }
    }, true);
    scope.addEventListener('error', function (event) {
      var img = event.target;
      if (!img || img.tagName !== 'IMG' || !img.classList.contains('mlib-artist-img')) return;
      var art = img.parentNode;
      if (art) { art.classList.remove('has-image'); art.classList.add('is-loaded'); }
      try { img.remove(); } catch (_) { }
    }, true);
  }

  function setViewState(name, text, tone) {
    var el = document.getElementById('mlib-' + name + '-state');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; el.removeAttribute('data-tone'); return; }
    el.hidden = false;
    el.textContent = text;
    if (tone) el.setAttribute('data-tone', tone); else el.removeAttribute('data-tone');
  }
  function loadArtistsView() {
    // 艺人轴目前只有 Apple 接入。切到其它源时必须**如实说明未接入**，
    // 不能继续显示 Apple 的艺人 —— 那会让人以为看到的是该源的艺人。
    // 这个判断必须在 early return 之前，否则已经加载过时就什么都不做了。
    if (mlibActiveSource !== 'apple') {
      var srcLabel = (MLIB_SOURCES[mlibActiveSource] || {}).label || mlibActiveSource;
      setViewState('artists', srcLabel + ' 的艺人资料尚未接入。', 'warn');
      var g0 = document.getElementById('mlib-artists-grid');
      if (g0) g0.innerHTML = '';
      artistsState.loaded = false;
      artistsState.source = '';
      return;
    }
    if (artistsState.loaded && artistsState.source === mlibActiveSource) return;
    if (artistsState.loading) return;
    if (typeof apiJson !== 'function') { setViewState('artists', '页面脚本尚未就绪，稍后重试。', 'warn'); return; }
    var grid = document.getElementById('mlib-artists-grid');
    var seq = ++artistsState.seq;
    artistsState.loading = true;
    if (grid) grid.setAttribute('aria-busy', 'true');
    // 首次是**完整解析**：要把资料库里出现过的艺人全部向 Apple 解析一次并写入本地缓存，
    // 后续打开只读缓存。signed 进度与"可能耗时"要如实告知，不要静默转圈。
    setViewState('artists', '正在获取艺人信息，这可能需要一些时间（首次会从 Apple 完整解析并缓存，之后打开会很快）…');

    // 看门狗：第一次解析确实可能持续数分钟。超过阈值就把"还在进行"如实说出来，
    // 但不取消请求、也不谎报失败。
    var stillWorking = false;
    var watchdog = setTimeout(function () {
      if (seq !== artistsState.seq || !artistsState.loading) return;
      stillWorking = true;
      setViewState('artists', '仍在获取艺人信息…首次解析需要逐首向 Apple 查询，请稍候（完成前不会写入不完整的结果）');
    }, 45000);

    apiJson('/api/apple/library/artists?resolve=1').then(function (data) {
      clearTimeout(watchdog);
      if (seq !== artistsState.seq) return;            // 旧请求不得覆盖新视图
      artistsState.loading = false;
      var list = (data && Array.isArray(data.artists)) ? data.artists : [];
      if (grid) {
        // 在"其他"分组（数字/符号开头）之前插入分界，否则列表末尾的乱序感会被当成 bug。
        var parts = [];
        var insertedDivider = false;
        list.forEach(function (a) {
          if (!insertedDivider && Number(a.bucket) === 1) {
            insertedDivider = true;
            parts.push('<div class="mlib-artist-divider" role="separator">其他</div>');
          }
          parts.push(artistCardHtml(a));
        });
        grid.innerHTML = parts.join('');
        Array.prototype.forEach.call(grid.querySelectorAll('.mlib-art img'), bindCover);
        grid.setAttribute('aria-busy', 'false');
      }
      setNavItemCount('artists', list.length ? String(list.length) : '');
      artistsState.loaded = true;
      if (!list.length) {
        setViewState('artists', (data && data.message) || '资料库里还没有可用的艺人信息。');
        return;
      }
      // 如实汇报：多少位没有合格头像（用首字母占位）、多少首歌的艺人身份尚未解析。
      var noImage = Math.max(0, list.length - (Number(data && data.withImage) || 0));
      var pendingSongs = Number(data && data.pendingSongs) || 0;
      var notes = [];
      if (noImage > 0) notes.push(noImage + ' 位暂无合格的艺人代表图像，已用名称首字母占位');
      if (pendingSongs > 0) notes.push(pendingSongs + ' 首歌的艺人身份尚未解析（仍保留在资料库中）');
      setViewState('artists', notes.length ? ('共 ' + list.length + ' 位；' + notes.join('；') + '。') : '');
    }).catch(function (err) {
      clearTimeout(watchdog);
      if (seq !== artistsState.seq) return;
      artistsState.loading = false;
      if (grid) grid.setAttribute('aria-busy', 'false');
      setViewState('artists', '读取艺人失败：' + ((err && err.message) || '未知错误'), 'warn');
    });
  }

  // ---- 艺人详情（艺人视图内的二级页面）----
  // 只展示**本地资料库中与该艺人关联**的作品；不展示 catalog 全量作品。
  // 首屏用本地数据渲染，缺失的艺人元数据（名称/流派/头像）为后台渐进补齐的结果，
  // 拿不到就不显示 —— 不编造。
  var artistDetailState = { artistId: '', name: '', seq: 0, loading: false, listScrollTop: 0 };

  function renderReleaseCard(release) {
    var name = String(release.name || '未命名发行');
    var cover = String(release.cover || '').trim();
    var img = cover
      ? '<img src="' + escHtml(cover) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
      : '';
    var year = '';
    var m2 = String(release.releaseDate || '').match(/^(\d{4})/);
    if (m2) year = m2[1];
    var sub = [];
    if (release.songCount) sub.push(release.songCount + ' 首');
    if (year) sub.push(year);
    // 有 libraryAlbumId 才能沿用既有专辑详情入口；否则只做展示，不发明新的播放行为
    var canOpen = !!release.libraryAlbumId;
    // 发行对象存进模块 Map，按 libraryAlbumId 取回（与专辑/歌单卡片同一套做法）
    if (canOpen) albumPayloads[String(release.libraryAlbumId)] = {
      id: release.libraryAlbumId, libraryId: release.libraryAlbumId,
      name: name, cover: cover, artist: artistDetailState.name || '', releaseDate: release.releaseDate || '',
    };
    return '<article class="mlib-album-card' + (canOpen ? ' is-openable' : '') + '" role="listitem"' +
      (canOpen ? ' tabindex="0" data-mlib-release-album="' + escHtml(release.libraryAlbumId) + '"' +
        ' aria-label="打开专辑：' + escHtml(name) + '"' : ' aria-label="' + escHtml(name) + '"') + '>' +
      '<div class="mlib-art' + (cover ? '' : ' is-loaded') + '">' + img +
      // 悬浮播放按钮：与专辑卡片/歌单卡片同一套类名与悬停规则。
      // 只有能确定是哪张资料库专辑时才给按钮（否则不知道要播什么，不发明行为）。
      (canOpen ? '<button class="mlib-play-btn" type="button" data-mlib-play-release="1"' +
        ' title="播放专辑" aria-label="播放专辑：' + escHtml(name) + '">' + playGlyphSvg() + '</button>' : '') +
      '</div>' +
      '<div class="mlib-album-meta">' +
      '<div class="mlib-album-name" title="' + escHtml(name) + '">' + escHtml(name) + '</div>' +
      '<div class="mlib-album-sub">' + escHtml(sub.join(' · ')) + '</div>' +
      '</div></article>';
  }

  function renderArtistDetail(data) {
    var hero = document.getElementById('mlib-artist-hero-art');
    var nameEl = document.getElementById('mlib-artist-hero-name');
    var genresEl = document.getElementById('mlib-artist-hero-genres');
    var factsEl = document.getElementById('mlib-artist-hero-facts');
    var sectionsEl = document.getElementById('mlib-artist-sections');
    var displayName = String((data && data.name) || artistDetailState.name || '艺人');
    if (nameEl) nameEl.textContent = displayName;
    if (hero) {
      var av = artistAvatarHtml((data && data.image) || '', displayName);
      hero.className = 'mlib-artist-hero-art' + (av.initial || !(data && data.image) ? ' is-loaded' : '');
      hero.innerHTML = av.html;
      if (data && data.image) {
        var hi = hero.querySelector('img');
        if (hi) {
          if (hi.complete && hi.naturalWidth) { hero.classList.add('has-image'); }
          else {
            hi.addEventListener('load', function () { hero.classList.add('has-image'); }, { once: true });
            hi.addEventListener('error', function () {
              hero.classList.remove('has-image');
              try { hi.remove(); } catch (_) { }
            }, { once: true });
          }
        }
      }
    }
    // 流派：有值才显示（不显示空字段）
    var genres = (data && Array.isArray(data.genres)) ? data.genres.filter(Boolean) : [];
    if (genresEl) {
      genresEl.textContent = genres.join(' · ');
      genresEl.hidden = genres.length === 0;
    }
    // 统计：只用本地资料库里的关联数量，不混入 catalog 全量
    if (factsEl) {
      var facts = [];
      if (data && data.releaseTotal) facts.push(data.releaseTotal + ' 张发行');
      if (data && data.songTotal) facts.push(data.songTotal + ' 首歌曲');
      factsEl.textContent = facts.join(' · ');
      factsEl.hidden = facts.length === 0;
    }
    // 简介（Wikipedia）：只有 status=ok 才显示，并带「来源: Wikipedia」小标注。
    // 拿不到（无条目/消歧/网络不可达）就不显示该区块 —— 不编造。
    renderArtistBio(data && data.wiki);
    if (!sectionsEl) return;
    var sec = (data && data.sections) || {};
    var SPEC = [
      { key: 'album', title: '专辑' },
      { key: 'single', title: 'Single' },
      { key: 'ep', title: 'EP' },
    ];
    var html = '';
    SPEC.forEach(function (s2) {
      var list = Array.isArray(sec[s2.key]) ? sec[s2.key] : [];
      if (!list.length) return;   // 空分区不渲染，避免"强行归类"的观感
      html += '<section class="mlib-artist-section"><div class="mlib-section-head">' +
        '<h4 class="mlib-section-title">' + escHtml(s2.title) + '</h4>' +
        '<span class="mlib-section-count">' + list.length + '</span></div>' +
        '<div class="mlib-grid mlib-grid-releases" role="list">' +
        list.map(renderReleaseCard).join('') + '</div></section>';
    });
    sectionsEl.innerHTML = html;
    // 关键：封面默认 opacity:0，只有挂上 is-loaded 才显示（与专辑墙同一套机制）。
    // #mlib-artist-sections 之前没有绑定，所以图片其实加载成功却一直是透明的。
    Array.prototype.forEach.call(sectionsEl.querySelectorAll('.mlib-art img'), bindCover);
    if (!html) {
      sectionsEl.innerHTML = '<div class="am-album-empty">这个艺人在你的资料库里没有可展示的发行。</div>';
    }
  }

  // 简介渲染：正文 + 极小的来源标注（可点进维基条目）。
  // 长简介默认收起为若干行，避免顶部信息区挤占下方作品主体；只有真的溢出才给展开按钮。
  function renderArtistBio(wiki) {
    var box = document.getElementById('mlib-artist-hero-bio');
    var text = document.getElementById('mlib-artist-bio-text');
    var link = document.getElementById('mlib-artist-bio-link');
    var toggle = document.getElementById('mlib-artist-bio-toggle');
    if (!box || !text) return;
    var extract = wiki && wiki.extract ? String(wiki.extract).trim() : '';
    if (!extract) {
      box.hidden = true;
      text.textContent = '';
      text.classList.remove('is-expanded');
      if (toggle) { toggle.hidden = true; toggle.textContent = '展开'; }
      if (link) { link.hidden = true; link.removeAttribute('href'); }
      return;
    }
    box.hidden = false;
    text.textContent = extract;
    text.classList.remove('is-expanded');
    // 来源如实标注（维基 / 国内源），不写死
    var srcEl = document.getElementById('mlib-artist-bio-source-text');
    if (srcEl) srcEl.textContent = '来源: ' + (wiki.source || 'Wikipedia');
    if (link) {
      if (wiki.url) { link.hidden = false; link.href = wiki.url; }
      else { link.hidden = true; link.removeAttribute('href'); }
    }
    // 收起态下若没有溢出，则不显示按钮（避免无意义的"展开"）
    if (toggle) {
      toggle.textContent = '展开';
      toggle.hidden = true;
      requestAnimationFrame(function () {
        if (box.hidden) return;
        if (text.scrollHeight - text.clientHeight > 2) toggle.hidden = false;
      });
    }
  }

  // 展开/收起简介
  window.toggleArtistBio = function () {
    var text = document.getElementById('mlib-artist-bio-text');
    var toggle = document.getElementById('mlib-artist-bio-toggle');
    if (!text) return;
    var expanded = text.classList.toggle('is-expanded');
    if (toggle) toggle.textContent = expanded ? '收起' : '展开';
  };

  // 详情返回时通常还没有简介（首次要现取）。这里不改动已渲染的页面，
  // 只在后台把结果补上；拿不到就什么都不做。
  function fetchArtistBioIfMissing(artistId, name, currentLang) {
    var seq = artistDetailState.seq;
    // 已有简介且已经是中文 -> 不用再取；
    // 已有英文简介时仍试一次（中文条目可能通过搜索映射拿到，实测 Abel Tesfaye -> 威肯）。
    if (currentLang === 'zh') return;
    apiJson('/api/apple/library/artist/wiki?id=' + encodeURIComponent(artistId)
      + '&name=' + encodeURIComponent(name || '')).then(function (data) {
      if (seq !== artistDetailState.seq) return;
      if (data && data.wiki) renderArtistBio(data.wiki);
    }).catch(function () { /* 维基不可达：保持不显示，不影响详情页 */ });
  }

  function loadArtistDetail(artistId) {
    var seq = ++artistDetailState.seq;
    artistDetailState.loading = true;
    setViewState('artist-detail', '正在读取艺人作品…');
    apiJson('/api/apple/library/artist/detail?id=' + encodeURIComponent(artistId)).then(function (data) {
      if (seq !== artistDetailState.seq) return;
      artistDetailState.loading = false;
      if (!data || data.ok === false) {
        setViewState('artist-detail', '读取艺人作品失败：' + ((data && data.error) || '未知错误'), 'warn');
        renderArtistDetail({ name: artistDetailState.name, sections: {} });
        return;
      }
      renderArtistDetail(data);
      // 首次进入时简介还没取到（详情端点为不阻塞返回），后台补齐
      fetchArtistBioIfMissing(artistId, data.name || artistDetailState.name, data.wikiLang || (data.wiki && data.wiki.lang));
      // 渲染完成后**再次**置顶：打开详情时先把列表隐藏，滚动容器高度会瞬间塌缩，
      // scrollTop 被浏览器钳到 0；内容渲染回来后浏览器会恢复旧值，
      // 于是详情页在中途位置打开、看起来叠在导航上。这里补一次置顶。
      if (typeof scrollLibraryToTop === 'function') scrollLibraryToTop();
      // 有数据时清掉提示；没有作品时如实说明
      if (!data.songTotal) {
        setViewState('artist-detail', '这个艺人在你的资料库里还没有关联的歌曲。');
      } else {
        setViewState('artist-detail', '');
      }
    }).catch(function (err) {
      if (seq !== artistDetailState.seq) return;
      artistDetailState.loading = false;
      setViewState('artist-detail', '读取艺人作品失败：' + ((err && err.message) || '未知错误') + '（可重试）', 'warn');
    });
  }

  // 把资料库滚动容器移回顶部（两级 rAF：等隐藏/显示引起的重排结算完再设，
  // 否则会被浏览器随后恢复的旧值覆盖）。
  function scrollLibraryToTop() {
    var sc = document.getElementById('music-library-scroll');
    if (!sc) return;
    sc.scrollTop = 0;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        sc.scrollTop = 0;
        requestAnimationFrame(function () { sc.scrollTop = 0; });
      });
    }
  }

  function setArtistPane(showDetail) {
    var list = document.getElementById('mlib-artist-list');
    var detail = document.getElementById('mlib-artist-detail');
    if (list) list.hidden = !!showDetail;
    if (detail) detail.hidden = !showDetail;
  }

  window.openArtistDetail = function (artistId, name) {
    var id = String(artistId || '').trim();
    if (!id) return;
    // 记录列表滚动位置，返回时恢复（规格要求）
    var sc = document.getElementById('music-library-scroll');
    artistDetailState.listScrollTop = sc ? sc.scrollTop : 0;
    artistDetailState.artistId = id;
    artistDetailState.name = String(name || '');
    setArtistPane(true);
    scrollLibraryToTop();
    loadArtistDetail(id);
  };

  window.backToArtistList = function () {
    artistDetailState.seq += 1;   // 让在途请求失效，避免回来后覆盖列表
    renderArtistBio(null);        // 清掉上一位艺人的简介，避免残留（含展开态）
    setArtistPane(false);
    var sc = document.getElementById('music-library-scroll');
    if (sc) sc.scrollTop = artistDetailState.listScrollTop || 0;
  };

  // ---- 歌单视图 ----
  // 真实数据来自既有只读接口 /api/apple/user/playlists；不新建、不虚构歌单。
  var playlistsState = { loaded: false, loading: false, seq: 0, source: '' };
  var playlistPayloads = Object.create(null);
  function playlistCardHtml(pl) {
    var cover = String(pl.cover || '').trim();
    var img = cover
      ? '<img src="' + escHtml(cover) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
      : '';
    var name = String(pl.name || '未命名歌单');
    var sub = String(pl.creator || '').trim() || 'Apple Music';
    // 歌单对象存在模块内 Map，按 id 取回（与专辑卡片同一套做法，不塞进 HTML 属性）。
    if (pl && pl.id) playlistPayloads[String(pl.id)] = pl;
    return '<article class="mlib-album-card" role="listitem" data-mlib-playlist-id="' + escHtml(pl.id || '') + '"' +
      ' tabindex="0" aria-label="打开歌单：' + escHtml(name) + '">' +
      '<div class="mlib-art mlib-playlist-art' + (cover ? '' : ' is-loaded') + '">' + img +
      // 与专辑卡片同一个悬浮播放按钮：同样的类名、同样的悬停显示规则、同样的无 hover 降级。
      '<button class="mlib-play-btn" type="button" data-mlib-play-playlist="1"' +
      ' title="播放歌单" aria-label="播放歌单：' + escHtml(name) + '">' + playGlyphSvg() + '</button>' +
      '</div>' +
      '<div class="mlib-album-meta">' +
      '<div class="mlib-album-name" title="' + escHtml(name) + '">' + escHtml(name) + '</div>' +
      '<div class="mlib-album-sub">' + escHtml(sub) + '</div>' +
      '</div></article>';
  }
  function loadPlaylistsView() {
    // 与艺人视图同理：数据只对**当时那个源**有效，切源后必须重取。
    if (playlistsState.loaded && playlistsState.source === mlibActiveSource) return;
    if (playlistsState.loading) return;
    if (typeof apiJson !== 'function') { setViewState('playlists', '页面脚本尚未就绪，稍后重试。', 'warn'); return; }
    var grid = document.getElementById('mlib-playlists-grid');
    var seq = ++playlistsState.seq;
    playlistsState.loading = true;
    if (grid) grid.setAttribute('aria-busy', 'true');
    var isNetease = mlibActiveSource === 'netease';
    setViewState('playlists', '正在读取' + (isNetease ? '网易云音乐' : ' Apple Music') + '歌单…');
    // 网易云的歌单随资料库索引一起返回，无需第二个请求
    var playlistsRequest = isNetease
      ? fetchLibraryIndex('netease').then(function (d) { return { playlists: (d && d.playlists) || [] }; })
      : apiJson('/api/apple/user/playlists?limit=300');
    playlistsRequest.then(function (data) {
      if (seq !== playlistsState.seq) return;
      playlistsState.loading = false;
      playlistsState.source = mlibActiveSource;
      playlistsState.loaded = true;
      // 过滤虚拟条目：Apple Music 资料库卡片（virtual / id=apple-liked）不是真实歌单，
      // 它的内容是"全部已保存歌曲"，不是歌单 —— 按要求不在这里显示。
      var list = ((data && Array.isArray(data.playlists)) ? data.playlists : []).filter(function (pl) {
        if (!pl) return false;
        if (pl.virtual === true) return false;
        if (String(pl.id || '') === 'apple-liked') return false;
        return true;
      });
      if (grid) {
        grid.innerHTML = list.map(playlistCardHtml).join('');
        Array.prototype.forEach.call(grid.querySelectorAll('.mlib-art img'), bindCover);
        grid.setAttribute('aria-busy', 'false');
      }
      setNavItemCount('playlists', list.length ? String(list.length) : '');
      playlistsState.loaded = true;
      if (!list.length) {
        setViewState('playlists', (data && data.message) || '暂无歌单。', (data && data.error) ? 'warn' : '');
      } else {
        setViewState('playlists', '');
      }
    }).catch(function (err) {
      if (seq !== playlistsState.seq) return;
      playlistsState.loading = false;
      if (grid) grid.setAttribute('aria-busy', 'false');
      setViewState('playlists', '读取歌单失败：' + ((err && err.message) || '未知错误'), 'warn');
    });
  }

  // 只在该视图真正被打开时取数；已加载过就不重复请求。
  function ensureViewData(name) {
    if (name === 'artists') loadArtistsView();
    else if (name === 'playlists') loadPlaylistsView();
  }

  // 播放歌单：复用既有的 amc.playPlaylist（歌单链，按名字 + 资料库作用域定位）。
  // 与专辑卡片的 playLibraryAlbum 同一套语义：只有链路自己报 verified 才算成功。
  function playLibraryPlaylist(playlist) {
    var name = String((playlist && playlist.name) || '').trim();
    if (!name) {
      if (typeof showToast === 'function') showToast('这个歌单没有可用的名称，无法交给 Apple Music');
      return;
    }
    var amc = window.mineradio && window.mineradio.amc;
    if (!amc || typeof amc.playPlaylist !== 'function') {
      if (typeof showToast === 'function') showToast('Apple Music 播放不可用（IPC 未就绪）');
      return;
    }
    var url = String(playlist.appleUrl || '').trim();
    var payload = { name: name };
    if (url) payload.url = url;
    else {
      payload.scopeLabel = (typeof AMC_PLAYLIST_SCOPE_LABEL === 'string' && AMC_PLAYLIST_SCOPE_LABEL)
        ? AMC_PLAYLIST_SCOPE_LABEL : '你的资料库';
    }
    if (typeof showToast === 'function') showToast('交给 Apple Music 播放：' + name);
    Promise.resolve(amc.playPlaylist(payload)).then(function (res) {
      if (typeof showToast !== 'function') return;
      var stage = (res && res.stage) || 'NO_RESULT';
      var via = (res && res.playVia) || '';
      if (res && res.verified) showToast('✓ Apple Music 已开始播放：' + name + (via ? ' · ' + via : ''));
      else if (stage === 'AMBIGUOUS') showToast('资料库里有多个同名歌单，无法确定播哪一个');
      else if (stage === 'PLAYLIST_NOT_FOUND') showToast('Apple Music 资料库里没找到：' + name);
      else if (stage === 'SCOPE_NOT_VERIFIED') showToast('未能切入 Apple Music「你的资料库」范围，已中止播放（不会去目录里找同名歌单）');
      else if (stage === 'SCOPE_CHIP_NOT_FOUND') showToast('找不到 Apple Music 的「你的资料库」范围按钮，已中止播放');
      else showToast('Apple Music 播放失败：' + stage);
    }).catch(function () {
      if (typeof showToast === 'function') showToast('Apple Music 播放失败（IPC 错误）');
    });
  }

  // 打开歌单详情：复用已存在的 window.openAmPlaylistDetail（07-album-detail.js）。
  function openLibraryPlaylist(id) {
    var playlist = playlistPayloads[String(id || '')];
    if (!playlist) return;
    if (typeof window.openAmPlaylistDetail === 'function') window.openAmPlaylistDetail(playlist);
  }

  function bindLibraryNav() {
    renderSourceList();
    applyNavOpen();
    // 源父级：整行点击 = 展开/收起源列表（这是唯一可折叠的部分）
    var sourceParent = document.getElementById('mlib-nav-parent-source');
    if (sourceParent && sourceParent.dataset.mlibNavBound !== '1') {
      sourceParent.dataset.mlibNavBound = '1';
      sourceParent.addEventListener('click', function () { toggleMlibSourceOpen(); });
    }
    var sourceChildren = document.getElementById('mlib-nav-children-source');
    if (sourceChildren && sourceChildren.dataset.mlibNavBound !== '1') {
      sourceChildren.dataset.mlibNavBound = '1';
      sourceChildren.addEventListener('click', function (event) {
        var btn = event.target && event.target.closest ? event.target.closest('[data-mlib-source]') : null;
        if (!btn) return;
        event.stopPropagation();
        // 未接入的源不可选（按钮本身也是 disabled，这里是第二道防线）
        if (btn.getAttribute('data-mlib-source-ready') !== '1') return;
        setMlibSource(btn.getAttribute('data-mlib-source'));
      });
    }
    // 视图：常驻，直接绑定
    var children = document.getElementById('mlib-nav-children-views');
    if (children && children.dataset.mlibNavBound !== '1') {
      children.dataset.mlibNavBound = '1';
      children.addEventListener('click', function (event) {
        var btn = event.target && event.target.closest ? event.target.closest('[data-mlib-view]') : null;
        if (!btn) return;
        event.stopPropagation();
        setMlibView(btn.getAttribute('data-mlib-view'));
      });
    }
    var artistsGrid = document.getElementById('mlib-artists-grid');
    if (artistsGrid) {
      bindArtistAvatar(artistsGrid);
      if (artistsGrid.dataset.mlibNavBound !== '1') {
        artistsGrid.dataset.mlibNavBound = '1';
        // 点卡片进艺人详情（用卡片自己的 artistId，不按名字猜）
        artistsGrid.addEventListener('click', function (event) {
          var card = event.target && event.target.closest ? event.target.closest('[data-mlib-artist-id]') : null;
          if (!card || !artistsGrid.contains(card)) return;
          var nm = card.querySelector('.mlib-album-name');
          window.openArtistDetail(card.getAttribute('data-mlib-artist-id'), nm ? nm.textContent : '');
        });
        artistsGrid.addEventListener('keydown', function (event) {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          var card = event.target && event.target.closest ? event.target.closest('[data-mlib-artist-id]') : null;
          if (!card) return;
          event.preventDefault();
          var nm = card.querySelector('.mlib-album-name');
          window.openArtistDetail(card.getAttribute('data-mlib-artist-id'), nm ? nm.textContent : '');
        });
      }
    }
    // 艺人详情里的发行卡片：复用既有专辑详情入口（不发明新的播放/跳转行为）
    var sections = document.getElementById('mlib-artist-sections');
    if (sections && sections.dataset.mlibReleaseBound !== '1') {
      sections.dataset.mlibReleaseBound = '1';
      // 挂在捕获阶段：播放按钮与"点卡片主体进详情"是两个动作，不能一次点击同时触发。
      sections.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        if (target.closest('[data-mlib-play-release]')) {
          event.preventDefault();
          event.stopPropagation();
          var pid = target.closest('[data-mlib-release-album]');
          var palbum = pid ? albumPayloads[String(pid.getAttribute('data-mlib-release-album') || '')] : null;
          if (palbum) playLibraryAlbum(palbum);
          return;
        }
        var card = target.closest('[data-mlib-release-album]');
        if (!card) return;
        var album = albumPayloads[String(card.getAttribute('data-mlib-release-album') || '')];
        if (album && typeof window.openAmAlbumDetail === 'function') window.openAmAlbumDetail(album);
      }, true);
      sections.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (event.target && event.target.closest && event.target.closest('[data-mlib-play-release]')) return;
        var card = event.target && event.target.closest ? event.target.closest('[data-mlib-release-album]') : null;
        if (!card) return;
        event.preventDefault();
        var album = albumPayloads[String(card.getAttribute('data-mlib-release-album') || '')];
        if (album && typeof window.openAmAlbumDetail === 'function') window.openAmAlbumDetail(album);
      });
    }
    // 歌单卡片 -> 歌单详情页（与专辑详情同构）。事件委托，卡片重渲染后依然有效。
    var playlistsGrid = document.getElementById('mlib-playlists-grid');
    if (playlistsGrid && playlistsGrid.dataset.mlibPlBound !== '1') {
      playlistsGrid.dataset.mlibPlBound = '1';
      // 挂在捕获阶段：播放按钮与"点卡片主体"是两个不同动作，不能一次点击同时触发。
      playlistsGrid.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        var card = target.closest('[data-mlib-playlist-id]');
        if (!card || !playlistsGrid.contains(card)) return;
        var id = card.getAttribute('data-mlib-playlist-id');
        if (target.closest('[data-mlib-play-playlist]')) {
          event.preventDefault();
          event.stopPropagation();
          playLibraryPlaylist(playlistPayloads[String(id || '')]);
          return;
        }
        openLibraryPlaylist(id);
      }, true);
      playlistsGrid.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        var target = event.target;
        if (!target || !target.closest) return;
        // 播放按钮自己有独立语义，不在这里抢
        if (target.closest('[data-mlib-play-playlist]')) return;
        var card = target.closest('[data-mlib-playlist-id]');
        if (!card) return;
        event.preventDefault();
        openLibraryPlaylist(card.getAttribute('data-mlib-playlist-id'));
      });
    }
  }

  // 打开资料库时恢复上次的选中项与展开态（首次进入 = 专辑 + 展开）。
  function restoreLibraryNav() {
    applyNavOpen();
    setMlibView(mlibActiveView, { persist: false, eager: false });
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
    // 三个视图都是同级 .mlib-section，取所有可见 section 的并集作为"内容列"。
    var sections = document.querySelectorAll('#music-library .mlib-section');
    if (!sections.length) return false;   // 还没有内容时不接管这个手势
    var colLeft = Infinity, colRight = -Infinity;
    Array.prototype.forEach.call(sections, function (node) {
      if (node.hidden) return;
      var r = node.getBoundingClientRect();
      if (!r.width) return;
      if (r.left < colLeft) colLeft = r.left;
      if (r.right > colRight) colRight = r.right;
    });
    if (!(colRight > colLeft)) return false;
    var x = event.clientX;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    // 严格在内容列之外：列内（卡片、文字、导航、任何区块）一律不触发。
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
      bindLibraryNav();
      restoreLibraryNav();
    });
  } else {
    syncMlibNavState();
    bindHomeReturn();
    bindLibraryNav();
    restoreLibraryNav();
  }
})();
