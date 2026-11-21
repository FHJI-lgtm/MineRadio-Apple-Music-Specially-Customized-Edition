'use strict';
// ============================================================
// 黑胶墙 → 详情页 打开动画
//
// 时间轴（p: 0→1，总长 MLIB_OA_DURATION = 900ms）：
//   邻居 0–0.3 | 背景 0.15–0.3 | 主封面位移 0.15–1（缓出）
//   主封面旋转 0.2–1（先慢后快再慢）| 控件 0.2–0.5
//   主封面在 p=1 时仍差约 10° / 50px，再用 350ms 长尾收尾。
//
// 真实详情弹窗在点击瞬间就打开，但被 body.mlib-opening 隐藏；
// 动画结束后淡出覆盖层、露出真实详情页（数据/结构不动）。
// ============================================================

var MLIB_OA_DURATION = 900;
var MLIB_OA_TAIL = 350;

(function () {
  // 默认开启；需要临时关闭时调用 window.__mlibOpenAnimEnable(false)
  if (window.__mlibOpenAnimEnabled == null) window.__mlibOpenAnimEnabled = true;
  var busy = false;
  var overlay = null;
  var coverEl = null;
  var chromeEl = null;
  var bgEl = null;
  var spineColor = '#1b2a2e';
  var spineText = '';
  var coverSrc = '';
  var startRect = null;
  var endRect = null;
  var side = 1;
  var neighborCards = [];
  var neighborBase = [];
  var spacing = 96;
  var gridRef = null;
  var modalEl = null;
  var coverTarget = null;
  var freezeAt = null;
  var rafId = 0;

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function vinylActive() {
    return typeof isMlibVinylActive === 'function' && isMlibVinylActive();
  }

  function modalIdsFor(grid) {
    if (grid && grid.id === 'mlib-playlists-grid') {
      return { modal: 'am-playlist-detail-modal', cover: 'am-playlist-detail-cover' };
    }
    return { modal: 'am-album-detail-modal', cover: 'am-album-detail-cover' };
  }

  function cardsOf(grid) {
    var out = [];
    for (var i = 0; i < grid.children.length; i += 1) {
      var n = grid.children[i];
      if (n.classList && n.classList.contains('mlib-album-card') && !n.classList.contains('mlib-slab-reflection')) out.push(n);
    }
    return out;
  }

  // 取封面主色（与书脊同一套逻辑：/api/cover 代理 + canvas 采样）
  var colorCanvas = document.createElement('canvas');
  colorCanvas.width = 6; colorCanvas.height = 6;
  var colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });
  function sampleDarkColor(src) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          colorCtx.clearRect(0, 0, 6, 6);
          colorCtx.drawImage(img, 0, 0, 6, 6);
          var d = colorCtx.getImageData(0, 0, 6, 6).data;
          var r = 0, g = 0, b = 0, n = 0;
          for (var i = 0; i < d.length; i += 4) {
            var lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            if (lum < 8 || lum > 240) continue;
            r += d[i]; g += d[i + 1]; b += d[i + 2]; n += 1;
          }
          if (!n) { resolve('rgb(10,14,22)'); return; }
          r = r / n; g = g / n; b = b / n;
          // 压暗成深色背景（近黑的深蓝/深灰蓝）
          resolve('rgb(' + Math.round(r * 0.26 + 4) + ',' + Math.round(g * 0.27 + 8) + ',' + Math.round(b * 0.34 + 14) + ')');
        } catch (e) { resolve('rgb(10,14,22)'); }
      };
      img.onerror = function () { resolve('rgb(10,14,22)'); };
      img.src = '/api/cover?url=' + encodeURIComponent(src);
    });
  }

  // 强调色：取封面主色并提亮，写成 "R G B" 供 rgba(var(--x), a) 使用
  function sampleAccent(cover) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          colorCtx.clearRect(0, 0, 6, 6);
          colorCtx.drawImage(img, 0, 0, 6, 6);
          var d = colorCtx.getImageData(0, 0, 6, 6).data;
          var r = 0, g = 0, b = 0, n = 0;
          for (var i = 0; i < d.length; i += 4) {
            var lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            if (lum < 16 || lum > 235) continue;
            r += d[i]; g += d[i + 1]; b += d[i + 2]; n += 1;
          }
          if (!n) { resolve('120 150 160'); return; }
          r = r / n; g = g / n; b = b / n;
          // 提亮 + 轻微饱和，保证在深底上可读
          var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          var sat = mx === 0 ? 1 : (mx - mn) / mx;
          var boost = sat < 0.18 ? 1.18 : 1.0;
          function ch(v, b2) { return Math.max(40, Math.min(235, Math.round((v * 0.72 + 44) * b2))); }
          resolve(ch(r, boost) + ' ' + ch(g, boost) + ' ' + ch(b, boost));
        } catch (e) { resolve('120 150 160'); }
      };
      img.onerror = function () { resolve('120 150 160'); };
      img.src = '/api/cover?url=' + encodeURIComponent(cover);
    });
  }

  function buildOverlay(card, rect) {
    overlay = document.createElement('div');
    overlay.className = 'mlib-oa';
    bgEl = document.createElement('div');
    bgEl.className = 'mlib-oa-bg';
    overlay.appendChild(bgEl);

    var stage = document.createElement('div');
    stage.className = 'mlib-oa-stage';
    coverEl = document.createElement('div');
    coverEl.className = 'mlib-oa-cover';
    var box = document.createElement('div');
    box.className = 'mlib-oa-box';

    var front = document.createElement('div');
    front.className = 'mlib-oa-face mlib-oa-front';
    if (coverSrc) {
      var img = document.createElement('img');
      img.src = coverSrc;
      img.alt = '';
      front.appendChild(img);
    }
    var back = document.createElement('div');
    back.className = 'mlib-oa-face mlib-oa-back';
    back.style.transform = 'rotateY(180deg) translateZ(1px)';

    function spineFace(cls) {
      var s = document.createElement('div');
      s.className = 'mlib-oa-face mlib-oa-spine ' + cls;
      var t = document.createElement('span');
      t.className = 'mlib-oa-spine-text';
      t.textContent = spineText;
      s.appendChild(t);
      return s;
    }

    box.appendChild(front);
    box.appendChild(back);
    box.appendChild(spineFace('left'));
    box.appendChild(spineFace('right'));
    coverEl.appendChild(box);
    stage.appendChild(coverEl);

    chromeEl = document.createElement('div');
    chromeEl.className = 'mlib-oa-chrome';
    chromeEl.innerHTML =
      '<div class="mlib-oa-back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></div>'
      + '<div class="mlib-oa-title"></div>'
      + '<div class="mlib-oa-share"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 15V4M8.5 7.5 12 4l3.5 3.5"/><path d="M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11A1.5 1.5 0 0 0 19 18.5V13"/></svg></div>';
    overlay.appendChild(stage);
    overlay.appendChild(chromeEl);
    overlay.style.opacity = '1';
    document.body.appendChild(overlay);
    coverEl.style.setProperty('--mlib-oa-spine-color', spineColor);
  }

  function setRect(el, r) {
    el.style.left = r.left + 'px';
    el.style.top = r.top + 'px';
    el.style.width = r.width + 'px';
    el.style.height = r.height + 'px';
  }

  function applyP(p) {
    var pp = Math.max(0, Math.min(1.25, p));
    // 邻居：以被点专辑为中心推开，距离成正比；越远越淡越模糊
    var nk = easeOutCubic(clamp01(pp / 0.3));
    for (var i = 0; i < neighborCards.length; i += 1) {
      var card = neighborCards[i];
      var info = neighborBase[i];
      var push = info.dir * info.dist * 3 * spacing * nk;
      card.style.transform = 'translate3d(' + push.toFixed(1) + 'px, 0px, 0px) ' + info.base;
      card.style.setProperty('--mlib-light', String(Math.max(0.2, 1 - nk * 0.8)));
      card.style.setProperty('--mlib-blur', (nk * 3).toFixed(1) + 'px');
    }
    // 背景：0.15–0.3 变成详情页颜色（取自封面并压暗）
    if (bgEl) bgEl.style.opacity = String(clamp01((pp - 0.15) / 0.15));
    // 主封面位移：0.15–1 缓出；C 帧仍差 50px
    var tp = easeOutCubic(clamp01((pp - 0.15) / 0.85));
    if (coverEl && startRect && endRect) {
      var target = tp;
      var r = {
        left: lerp(startRect.left, endRect.left + 50, target),
        top: lerp(startRect.top, endRect.top, target),
        width: lerp(startRect.width, endRect.width, target),
        height: lerp(startRect.height, endRect.height, target)
      };
      setRect(coverEl, r);
      var t = Math.max(10, r.width * 0.08);
      coverEl.style.setProperty('--mlib-oa-t', t.toFixed(1) + 'px');
      coverEl.style.setProperty('--mlib-oa-w', r.width.toFixed(1) + 'px');
      // 旋转：0.2–0.5 从 90° 缓到 75°；0.5–1 快速转到约 10°
      var deg;
      if (pp < 0.5) {
        var k1 = clamp01((pp - 0.2) / 0.3);
        deg = 90 - 15 * easeOutCubic(k1);
      } else {
        var k2 = clamp01((pp - 0.5) / 0.5);
        deg = 75 - 65 * easeOutCubic(k2);
      }
      var rot = side * deg;
      coverEl.style.transform = 'perspective(1200px) rotateY(' + rot.toFixed(2) + 'deg)';
    }
    // 控件：0.2–0.5 交叉淡入
    if (chromeEl) chromeEl.style.opacity = String(clamp01((pp - 0.2) / 0.3));
    // 旧弹窗保持隐藏：动画结束后覆盖层原地变成新详情页
  }

  function waitForTracks(cb) {
    var tries = 0;
    (function poll() {
      var wrap = document.getElementById(gridRef && gridRef.id === 'mlib-playlists-grid' ? 'am-playlist-detail-tracks' : 'am-album-detail-tracks');
      if ((wrap && wrap.querySelectorAll('.am-album-track').length) || tries > 480) { cb(wrap); return; }
      tries += 1;
      requestAnimationFrame(poll);
    })();
  }

  function showDetail() {
    if (!overlay) { cleanup(); return; }
    var isPlaylist = gridRef && gridRef.id === 'mlib-playlists-grid';
    var suffix = isPlaylist ? 'am-playlist-detail' : 'am-album-detail';
    waitForTracks(function (trackWrap) {
      if (!overlay) return;
      // 隐藏动画用的封面盒与顶部控件，换成新详情布局
      var stage = overlay.querySelector('.mlib-oa-stage');
      if (stage) stage.style.display = 'none';
      var chrome = overlay.querySelector('.mlib-oa-chrome');
      if (chrome) chrome.style.display = 'none';
      var scrim = document.createElement('div');
      scrim.className = 'mlib-oa-scrim';
      overlay.appendChild(scrim);
      var pr = panelRect();
      var detail = document.createElement('div');
      detail.className = 'mlib-oa-detail';
      detail.style.left = pr.left + 'px';
      detail.style.top = pr.top + 'px';
      detail.style.width = pr.width + 'px';
      detail.style.height = pr.height + 'px';
      var hero = document.createElement('div');
      hero.className = 'mlib-oa-hero';
      hero.style.width = pr.heroW + 'px';
      if (coverSrc) { var im = document.createElement('img'); im.src = coverSrc; im.alt = ''; hero.appendChild(im); }
      var side = document.createElement('div');
      side.className = 'mlib-oa-side';
      function grab(id) { return document.getElementById(id); }
      var heading = grab(suffix + '-heading');
      var artist = grab(suffix + '-artist');
      var facts = grab(suffix + '-facts');
      if (heading) { var h = heading.cloneNode(true); h.id = 'mlib-oa-heading'; side.appendChild(h); }
      if (artist) { var a = artist.cloneNode(true); a.id = 'mlib-oa-artist'; side.appendChild(a); }
      if (facts && facts.textContent.trim()) { var f = facts.cloneNode(true); f.id = 'mlib-oa-facts'; side.appendChild(f); }
      // 简介（旧弹窗有则复用；默认 3 行，可展开）
      var descSrc = grab(suffix + '-desc');
      if (descSrc && descSrc.textContent.trim()) {
        var desc = document.createElement('p');
        desc.className = 'mlib-oa-desc';
        desc.textContent = descSrc.textContent.trim();
        side.appendChild(desc);
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'mlib-oa-desc-toggle';
        toggle.textContent = '展开简介';
        toggle.addEventListener('click', function () {
          var open = desc.classList.toggle('is-open');
          toggle.textContent = open ? '收起' : '展开简介';
        });
        side.appendChild(toggle);
      }
      var list = document.createElement('div');
      list.className = 'mlib-oa-tracks';
      if (trackWrap) {
        var rows = trackWrap.querySelectorAll('.am-album-track');
        for (var i = 0; i < rows.length; i += 1) list.appendChild(rows[i].cloneNode(true));
      }
      side.appendChild(list);
      // 曲目可能晚到：稍后到达时自动填充
      (function () {
        var wrap = trackWrap;
        if (!wrap || wrap.querySelectorAll('.am-album-track').length) return;
        if (typeof MutationObserver !== 'function') return;
        var obs = new MutationObserver(function () {
          var rows = wrap.querySelectorAll('.am-album-track');
          if (!rows.length) return;
          list.innerHTML = '';
          for (var i = 0; i < rows.length; i += 1) list.appendChild(rows[i].cloneNode(true));
          obs.disconnect();
        });
        obs.observe(wrap, { childList: true });
      })();
      detail.appendChild(hero);
      detail.appendChild(side);
      sampleAccent(coverSrc).then(function (rgb) { detail.style.setProperty('--mlib-oa-accent', rgb); });
      var close = document.createElement('button');
      close.className = 'mlib-oa-close';
      close.type = 'button';
      close.setAttribute('aria-label', '关闭');
      close.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      close.addEventListener('click', closeDetail);
      overlay.appendChild(close);
      list.addEventListener('click', function (event) {
        var row = event.target && event.target.closest ? event.target.closest('[data-am-track-index]') : null;
        if (!row) return;
        var idx = Number(row.getAttribute('data-am-track-index'));
        if (typeof playSongAt === 'function') playSongAt(idx);
      });
      overlay.appendChild(detail);
      overlay.classList.add('is-detail');
      overlay.style.opacity = '1';
      document.body.classList.remove('mlib-opening');
      busy = false;
    });
  }

  function closeDetail() {
    try {
      if (gridRef && gridRef.id === 'mlib-playlists-grid') { if (typeof window.closeAmPlaylistDetail === 'function') window.closeAmPlaylistDetail(); }
      else if (typeof window.closeAmAlbumDetail === 'function') window.closeAmAlbumDetail();
    } catch (e) {}
    cleanup();
  }

  function cleanup() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null; coverEl = null; chromeEl = null; bgEl = null;
    document.body.classList.remove('mlib-opening');
    for (var i = 0; i < neighborCards.length; i += 1) {
      var card = neighborCards[i];
      if (neighborBase[i]) card.style.transform = neighborBase[i].base;
      card.style.removeProperty('--mlib-light');
      card.style.removeProperty('--mlib-blur');
    }
    neighborCards = []; neighborBase = [];
    busy = false;
  }

  function tailSettle(fromRect) {
    var t0 = performance.now();
    function step(now) {
      var k = clamp01((now - t0) / MLIB_OA_TAIL);
      var e = easeOutCubic(k);
      if (coverEl) {
        var r = {
          left: lerp(fromRect.left, endRect.left, e),
          top: lerp(startRect.top, endRect.top, 1),
          width: lerp(fromRect.width, endRect.width, e),
          height: lerp(fromRect.height, endRect.height, e)
        };
        setRect(coverEl, r);
        coverEl.style.transform = 'perspective(1200px) rotateY(' + (side * 10 * (1 - e)).toFixed(2) + 'deg)';
      }
      if (overlay) overlay.style.opacity = String(1 - k);
      if (k < 1) { rafId = requestAnimationFrame(step); } else { showDetail(); }
    }
    rafId = requestAnimationFrame(step);
  }

  // 详情面板几何：居中面板（与 CSS 保持一致的取法）
  function panelRect() {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var w = Math.min(1100, Math.round(vw * 0.88));
    var h = Math.min(680, Math.round(vh * 0.82));
    var left = Math.round((vw - w) / 2);
    var top = Math.round((vh - h) / 2);
    var heroW = Math.round(Math.min(w * 0.52, 720));
    return { left: left, top: top, width: w, height: h, heroW: heroW };
  }

  function waitForCover(cb) {
    var tries = 0;
    (function poll() {
      var r = coverTarget ? coverTarget.getBoundingClientRect() : null;
      if ((r && r.width > 40 && r.height > 40) || tries > 70) { cb(r); return; }
      tries += 1;
      requestAnimationFrame(poll);
    })();
  }

  function begin(grid, card, freezeP) {
    if (busy || !grid || !card) return;
    var ids = modalIdsFor(grid);
    modalEl = document.getElementById(ids.modal);
    coverTarget = document.getElementById(ids.cover);
    if (!modalEl || !coverTarget) return;
    busy = true;
    freezeAt = freezeP == null ? null : freezeP;
    spineColor = card.style.getPropertyValue('--mlib-spine') || '#1b2a2e';
    var img = card.querySelector('.mlib-art img');
    coverSrc = img ? img.src : '';
    spineText = (card.querySelector('.mlib-slab-spine-text') || {}).textContent || '';
    var cardRect = card.getBoundingClientRect();
    var spineEl = card.querySelector('.mlib-slab-spine');
    var spineRect = spineEl ? spineEl.getBoundingClientRect() : cardRect;
    startRect = { left: spineRect.left, top: spineRect.top, width: Math.max(40, spineRect.width), height: spineRect.height };
    side = (cardRect.left + cardRect.width / 2) < window.innerWidth / 2 ? 1 : -1;
    spacing = (typeof mlibSlabMetrics === 'function' ? mlibSlabMetrics(grid).spacing : 96) || 96;
    var cards = cardsOf(grid);
    var clickedIndex = cards.indexOf(card);
    neighborCards = []; neighborBase = [];
    for (var i = 0; i < cards.length; i += 1) {
      if (i === clickedIndex || cards[i].style.display === 'none') continue;
      neighborCards.push(cards[i]);
      neighborBase.push({ base: cards[i].style.transform || '', dist: Math.abs(i - clickedIndex), dir: i < clickedIndex ? -1 : 1 });
    }
    document.body.classList.add('mlib-opening');
    setTimeout(function () {
      if (!overlay && busy) { cleanup(); }
    }, 1600);
    
    (function () {
      var pr = panelRect();
      endRect = { left: pr.left, top: pr.top, width: pr.heroW, height: pr.height };
      buildOverlay(card, startRect);
      sampleDarkColor(coverSrc).then(function (color) { if (bgEl) bgEl.style.background = color; });
      if (freezeAt != null) { applyP(freezeAt); return; }
      var t0 = performance.now();
      (function step(now) {
        var p = clamp01((now - t0) / MLIB_OA_DURATION);
        applyP(p);
        if (p < 1) { rafId = requestAnimationFrame(step); return; }
        var cur = { left: endRect.left + 50, top: endRect.top, width: endRect.width, height: endRect.height };
        tailSettle(cur);
      })(t0);
    })();
  }
  // 点击拦截：黑胶墙里的专辑/歌单卡片
  document.addEventListener('click', function (event) {
    // 默认关闭：动画尚未完成端到端验收，先保证点击行为与原来一致；
    // 验收时执行 window.__mlibOpenAnimEnable(true) 打开。
    if (!window.__mlibOpenAnimEnabled) return;
    if (!vinylActive() || busy) return;
    var target = event.target;
    if (!target || !target.closest) return;
    if (target.closest('[data-mlib-skip-open-anim]')) return;
    var card = target.closest('.mlib-album-card');
    if (!card || card.classList.contains('mlib-slab-reflection')) return;
    if (target.closest('.mlib-play-btn')) return;
    var grid = card.closest('#mlib-albums-grid, #mlib-playlists-grid');
    if (!grid) return;
    // 放行真实点击（由原逻辑打开详情）；动画层负责视觉
    try { begin(grid, card); } catch (e) { cleanup(); }
  }, true);

  window.__mlibOpenAnimEnable = function (on) { window.__mlibOpenAnimEnabled = on !== false; return window.__mlibOpenAnimEnabled; };

  // 测试/验收钩子：冻结在指定 p 便于截图
  window.__mlibOpenAnimPreview = function (p) {
    if (busy) { applyP(p); return true; }
    var grid = document.getElementById('mlib-albums-grid');
    if (!grid || grid.hidden) grid = document.getElementById('mlib-playlists-grid');
    if (!grid) return false;
    if (!vinylActive()) return false;
    var cards = cardsOf(grid);
    var target = null;
    for (var i = 0; i < cards.length; i += 1) {
      if (cards[i].dataset.mlibSlab === '1' && cards[i].style.display !== 'none') { target = cards[i]; break; }
    }
    if (!target) return false;
    target.dataset.mlibSkipOpenAnim = '1';
    target.click();
    delete target.dataset.mlibSkipOpenAnim;
    begin(grid, target, p);
    return true;
  };
  window.__mlibOpenAnimPlay = function () {
    freezeAt = null;
    var grid = document.getElementById('mlib-albums-grid');
    if (!grid) return false;
    var cards = cardsOf(grid);
    for (var i = 0; i < cards.length; i += 1) {
      if (cards[i].dataset.mlibSlab === '1' && cards[i].style.display !== 'none') { cards[i].click(); begin(grid, cards[i]); return true; }
    }
    return false;
  };
})();