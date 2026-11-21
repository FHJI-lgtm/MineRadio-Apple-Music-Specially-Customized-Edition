'use strict';
// ============================================================
// 资料库视图风格：网格（默认）/ 黑胶墙（薄板 · 一点透视）
//
// 与验收原型 public/lab/3d-album-wall 同一空间模型：
//   · 每张专辑 = w(纵深 1000) × h(高 430) × t(厚 34) 的薄板，绕 Y 轴转 90° 站立；
//   · 沿 X 轴排成一排（间距 96），舞台 perspective 正对，消失点在屏幕中央；
//   · 中间只露书脊、两侧露出封面 —— 由投影几何产生；
//   · 书脊底色取封面主色；下方地板倒影；离心越远越模糊越暗。
//
// 接入方式：**不改数据层**。直接把 06-music-library.js 渲染出来的现有卡片
// 就地改造成薄板（正面复用原 .mlib-art 节点，背面/书脊/纸边按需生成），
// 因此点击、播放、详情页等委托逻辑全部保持原样。
// ============================================================

var MLIB_SLAB_W = 1000;
var MLIB_SLAB_H = 430;
var MLIB_SLAB_T = 34;
var MLIB_SLAB_SPACING = 96;
var MLIB_SLAB_FLOOR_Y = 180;   // 地板线（相对舞台中心，向下为正）
var MLIB_SLAB_CENTER_Y = MLIB_SLAB_FLOOR_Y - MLIB_SLAB_H / 2;
var MLIB_SLAB_CENTER_Z = -MLIB_SLAB_W / 2;

function normalizeMlibViewStyle(value) {
  return value === 'vinyl' ? 'vinyl' : 'grid';
}

function mlibVinylLibraryEl() { return document.getElementById('music-library'); }

function mlibVinylActiveView() {
  var active = document.querySelector('#mlib-nav-children-views .mlib-nav-item.is-active');
  return active ? String(active.getAttribute('data-mlib-view') || '') : '';
}

function isMlibVinylActive() {
  var lib = mlibVinylLibraryEl();
  return !!(lib && lib.classList.contains('mlib-vinyl-style'));
}

function mlibVinylGrids() {
  return ['mlib-albums-grid', 'mlib-playlists-grid']
    .map(function (id) { return document.getElementById(id); })
    .filter(Boolean);
}

function mlibSlabStageOf(grid) {
  return grid && grid.closest ? grid.closest('.mlib-view') : null;
}

function clampNum(v, a, b) { return Math.max(a, Math.min(b, v)); }

// 按舞台尺寸自适应取景：薄板尺寸/间距/地板线全部跟随舞台高度，
// 保证整排薄板永远完整落在舞台内（不再出现顶部被裁切）。
function mlibSlabMetrics(grid) {
  var stage = mlibSlabStageOf(grid);
  var stageH = stage ? stage.clientHeight : 0;
  if (!stageH) stageH = 480;
  var h = Math.max(260, Math.min(430, stageH * 0.66));
  var ratio = h / 430;
  var w = 1000 * ratio;
  var t = 34 * ratio;
  var spacing = 96 * ratio;
  var floor = 180 * ratio;
  var centerY = floor - h / 2;
  if (grid) {
    grid.style.setProperty('--mlib-slab-w', w.toFixed(1) + 'px');
    grid.style.setProperty('--mlib-slab-h', h.toFixed(1) + 'px');
    grid.style.setProperty('--mlib-slab-t', t.toFixed(1) + 'px');
  }
  return { h: h, w: w, t: t, spacing: spacing, floor: floor, centerY: centerY, centerZ: -w / 2 };
}

function mlibSlabState(grid) {
  if (!grid.__mlibSlab) {
    grid.__mlibSlab = { pos: 0, velocity: 0, raf: 0, cards: [], reflections: [], dragging: false, bound: false, internalUntil: 0, rendering: false };
  }
  return grid.__mlibSlab;
}

function mlibSlabCards(grid) {
  var list = [];
  var kids = grid.children;
  for (var i = 0; i < kids.length; i += 1) {
    if (kids[i].classList && kids[i].classList.contains('mlib-album-card')) list.push(kids[i]);
  }
  return list;
}

function mlibSlabCoverOf(card) {
  var img = card.querySelector('.mlib-art img');
  return img ? String(img.getAttribute('src') || '') : '';
}

// 把现有卡片补成 6 面薄板（按需，只在进入视野时调用）
function ensureMlibSlabFaces(card) {
  if (!card || card.dataset.mlibSlab === '1') return;
  card.dataset.mlibSlab = '1';
  var cover = mlibSlabCoverOf(card);
  card.__mlibCover = cover;
  var nameEl = card.querySelector('.mlib-album-name');
  var subEl = card.querySelector('.mlib-album-sub');
  var name = nameEl ? String(nameEl.textContent || '').trim() : '';
  var sub = subEl ? String(subEl.textContent || '').trim() : '';
  card.__mlibTitle = name;
  card.__mlibSub = sub;

  var back = document.createElement('div');
  back.className = 'mlib-slab-back';
  if (cover) {
    var inner = document.createElement('div');
    inner.className = 'mlib-slab-back-inner';
    inner.style.backgroundImage = 'url("' + cover.replace(/"/g, '%22') + '")';
    back.appendChild(inner);
  }

  var spine = document.createElement('div');
  spine.className = 'mlib-slab-spine';
  var spineText = document.createElement('span');
  spineText.className = 'mlib-slab-spine-text';
  spineText.textContent = sub ? name + ' · ' + sub : name;
  spine.appendChild(spineText);

  var far = document.createElement('div'); far.className = 'mlib-slab-far';
  var top = document.createElement('div'); top.className = 'mlib-slab-top';
  var bottom = document.createElement('div'); bottom.className = 'mlib-slab-bottom';

  card.appendChild(back);
  card.appendChild(spine);
  card.appendChild(far);
  card.appendChild(top);
  card.appendChild(bottom);
}

// 轻量镜像盒：只做反射里看得见的两张面
function ensureMlibSlabReflection(grid, state, index) {
  var existing = state.reflections[index];
  if (existing && existing.isConnected) return existing;
  var card = state.cards[index];
  if (!card) return null;
  var cover = card.__mlibCover || mlibSlabCoverOf(card);
  var refl = document.createElement('div');
  refl.className = 'mlib-slab-reflection';
  refl.setAttribute('aria-hidden', 'true');
  var front = document.createElement('div');
  front.className = 'mlib-slab-refl-front';
  if (cover) front.style.backgroundImage = 'url("' + cover.replace(/"/g, '%22') + '")';
  var spine = document.createElement('div');
  spine.className = 'mlib-slab-refl-spine';
  refl.appendChild(front);
  refl.appendChild(spine);
  state.internalUntil = performance.now() + 400;
  grid.appendChild(refl);
  state.reflections[index] = refl;
  state.internalUntil = performance.now() + 400;
  return refl;
}

function mlibSlabShade(x, spacing) {
  var span = Math.max(1, spacing || 96);
  var d = Math.abs(x) / span;
  var light = 1 - Math.min(1, d / 14) * 0.42;
  var blur = Math.min(1.8, Math.max(0, (d - 5) / 7) * 1.8);
  return { light: light.toFixed(3), blur: blur.toFixed(2) + 'px' };
}

function mlibSlabRender(grid) {
  if (!grid) return;
  var state = mlibSlabState(grid);
  if (state.rendering) return;
  if (!state.cards.length) state.cards = mlibSlabCards(grid);
  if (!state.cards.length) return;
  state.rendering = true;
  state.internalUntil = performance.now() + 400;
  var stage = mlibSlabStageOf(grid);
  var M = mlibSlabMetrics(grid);
  var half = Math.ceil(((stage ? stage.clientWidth : 1280) / 2 + M.w) / M.spacing) + 2;
  for (var i = 0; i < state.cards.length; i += 1) {
    var rel = i - state.pos;
    var card = state.cards[i];
    if (Math.abs(rel) > half) {
      if (card.style.display !== 'none') card.style.display = 'none';
      var hiddenRefl = state.reflections[i];
      if (hiddenRefl && hiddenRefl.style.display !== 'none') hiddenRefl.style.display = 'none';
      continue;
    }
    if (card.style.display === 'none') card.style.display = '';
    ensureMlibSlabFaces(card);
    var refl = ensureMlibSlabReflection(grid, state, i);
    var x = rel * M.spacing;
    var shade = mlibSlabShade(x, M.spacing);
    card.style.transform =
      'translate3d(' + x.toFixed(2) + 'px, ' + M.centerY.toFixed(1) + 'px, ' + M.centerZ.toFixed(1) + 'px)' +
      ' rotateY(90deg)';
    card.style.setProperty('--mlib-light', shade.light);
    card.style.setProperty('--mlib-blur', shade.blur);
    if (refl) {
      refl.style.display = '';
      refl.style.transform =
        'translate3d(' + x.toFixed(2) + 'px, ' + (2 * M.floor - M.centerY).toFixed(1) + 'px, ' + M.centerZ.toFixed(1) + 'px)' +
        ' rotateY(90deg) scaleY(-1)';
      refl.style.setProperty('--mlib-light', shade.light);
      if (card.style.getPropertyValue('--mlib-spine')) refl.style.setProperty('--mlib-spine', card.style.getPropertyValue('--mlib-spine'));
    }
    mlibSlabQueueSpineColor(card, refl);
  }
  state.internalUntil = performance.now() + 400;
  state.rendering = false;
}

// ---- 书脊主色：/api/cover 代理 + canvas 采样 ----
var mlibSpineColorCache = {};
var mlibSpineColorQueue = [];
var mlibSpineColorBusy = 0;
var mlibSpineCanvas = document.createElement('canvas');
mlibSpineCanvas.width = 6; mlibSpineCanvas.height = 6;
var mlibSpineCtx = mlibSpineCanvas.getContext('2d', { willReadFrequently: true });

function mlibSlabQueueSpineColor(card, refl) {
  if (!card || !card.__mlibCover || card.__mlibSpineDone) return;
  card.__mlibSpineDone = true;
  var cover = card.__mlibCover;
  if (mlibSpineColorCache[cover]) {
    card.style.setProperty('--mlib-spine', mlibSpineColorCache[cover]);
    if (refl) refl.style.setProperty('--mlib-spine', mlibSpineColorCache[cover]);
    return;
  }
  mlibSpineColorQueue.push({ card: card, cover: cover });
  mlibSpineColorPump();
}

function mlibSpineColorPump() {
  while (mlibSpineColorBusy < 4 && mlibSpineColorQueue.length) {
    var job = mlibSpineColorQueue.shift();
    mlibSpineColorBusy += 1;
    mlibSpineColorSample(job.cover).then(function (color) {
      if (color) {
        mlibSpineColorCache[job.cover] = color;
        job.card.style.setProperty('--mlib-spine', color);
      }
    }).catch(function () {}).then(function () {
      mlibSpineColorBusy -= 1;
      mlibSpineColorPump();
    });
  }
}

function mlibSpineColorSample(cover) {
  return new Promise(function (resolve) {
    if (!cover) { resolve(null); return; }
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = function () {
      try {
        mlibSpineCtx.clearRect(0, 0, 6, 6);
        mlibSpineCtx.drawImage(img, 0, 0, 6, 6);
        var data = mlibSpineCtx.getImageData(0, 0, 6, 6).data;
        var r = 0, g = 0, b = 0, n = 0;
        for (var i = 0; i < data.length; i += 4) {
          var rr = data[i], gg = data[i + 1], bb = data[i + 2];
          var lum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
          if (lum < 18 || lum > 244) continue;
          r += rr; g += gg; b += bb; n += 1;
        }
        if (!n) { resolve(null); return; }
        resolve('rgb(' + Math.round(r / n) + ',' + Math.round(g / n) + ',' + Math.round(b / n) + ')');
      } catch (e) { resolve(null); }
    };
    img.onerror = function () { resolve(null); };
    img.src = '/api/cover?url=' + encodeURIComponent(cover);
  });
}

// ---- 交互：拖拽 + 惯性 + 吸附 ----
function mlibSlabKick(grid) {
  var state = mlibSlabState(grid);
  if (state.raf) return;
  var last = 0;
  function tick(now) {
    state.raf = 0;
    var dt = Math.min(48, now - (last || now));
    last = now;
    if (state.dragging) { state.raf = requestAnimationFrame(tick); return; }
    if (Math.abs(state.velocity) > 0.00035) {
      state.pos = clampNum(state.pos + state.velocity * dt, 0, state.cards.length - 1);
      state.velocity *= Math.pow(0.935, dt / 16.7);
      mlibSlabRender(grid);
      state.raf = requestAnimationFrame(tick);
      return;
    }
    state.velocity = 0;
    var snap = Math.round(state.pos);
    var diff = snap - state.pos;
    if (Math.abs(diff) < 0.002) { state.pos = snap; mlibSlabRender(grid); return; }
    state.pos += diff * Math.min(1, 0.26 * (dt / 16.7));
    mlibSlabRender(grid);
    state.raf = requestAnimationFrame(tick);
  }
  state.raf = requestAnimationFrame(tick);
}

function bindMlibSlabInput(grid) {
  var state = mlibSlabState(grid);
  if (state.bound) return;
  var stage = mlibSlabStageOf(grid);
  if (!stage) return;
  state.bound = true;
  var down = false, lastX = 0, lastT = 0, moved = false;
  stage.addEventListener('pointerdown', function (e) {
    if (!isMlibVinylActive() || grid.hidden) return;
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('button,a,input')) return;
    state.cards = mlibSlabCards(grid);
    down = true; moved = false; lastX = e.clientX; lastT = performance.now();
    state.dragging = true; state.velocity = 0;
    stage.classList.add('is-dragging');
    // 不调用 setPointerCapture：它会把后续 click 的目标重定向到舞台，
    // 导致卡片上的委托点击（播放/打开详情）收不到事件。
  });
  stage.addEventListener('pointermove', function (e) {
    if (!down) return;
    var dx = e.clientX - lastX;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    var now = performance.now();
    var dtm = Math.max(8, Math.min(120, now - lastT));
    lastT = now; lastX = e.clientX;
    var delta = -dx / mlibSlabMetrics(grid).spacing;
    state.pos = clampNum(state.pos + delta, 0, state.cards.length - 1);
    state.velocity = delta / dtm;
    mlibSlabRender(grid);
  });
  function end() {
    if (!down) return;
    down = false; state.dragging = false;
    stage.classList.remove('is-dragging');
    mlibSlabKick(grid);
  }
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', function (e) {
    if (!isMlibVinylActive() || grid.hidden) return;
    e.preventDefault();
    state.cards = mlibSlabCards(grid);
    state.pos = clampNum(state.pos + ((e.deltaY || 0) + (e.deltaX || 0)) / (mlibSlabMetrics(grid).spacing * 2.7), 0, state.cards.length - 1);
    mlibSlabRender(grid);
    mlibSlabKick(grid);
  }, { passive: false });
  stage.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    state.cards = mlibSlabCards(grid);
    state.pos = clampNum(Math.round(state.pos) + (e.key === 'ArrowRight' ? 1 : -1), 0, state.cards.length - 1);
    mlibSlabKick(grid);
  });
  stage.addEventListener('click', function (e) {
    if (!moved) return;
    moved = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

// 切回网格：把就地改造过的卡片恢复原样（清内联 transform / 拆掉六个面 / 移除倒影）
function teardownMlibSlabGrid(grid) {
  var state = mlibSlabState(grid);
  state.internalUntil = performance.now() + 400;
  var cards = state.cards.length ? state.cards : mlibSlabCards(grid);
  cards.forEach(function (card) {
    card.style.transform = '';
    card.style.display = '';
    card.style.removeProperty('--mlib-light');
    card.style.removeProperty('--mlib-blur');
    card.style.removeProperty('--mlib-spine');
    card.dataset.mlibSlab = '';
    card.__mlibCover = '';
    card.__mlibSpineDone = false;
    ['mlib-slab-back', 'mlib-slab-spine', 'mlib-slab-far', 'mlib-slab-top', 'mlib-slab-bottom'].forEach(function (cls) {
      var nodes = card.querySelectorAll('.' + cls);
      for (var i = 0; i < nodes.length; i += 1) nodes[i].parentNode.removeChild(nodes[i]);
    });
  });
  state.reflections.forEach(function (r) { if (r && r.parentNode) r.parentNode.removeChild(r); });
  state.reflections = [];
  var leftovers = grid.querySelectorAll('.mlib-slab-reflection');
  for (var k = 0; k < leftovers.length; k += 1) leftovers[k].parentNode.removeChild(leftovers[k]);
  state.cards = [];
  state.pos = 0;
  state.velocity = 0;
  state.internalUntil = performance.now() + 400;
}

function resetMlibSlabGrid(grid) {
  var state = mlibSlabState(grid);
  state.internalUntil = performance.now() + 400;
  state.cards = mlibSlabCards(grid);
  state.reflections.forEach(function (r) { if (r && r.parentNode) r.parentNode.removeChild(r); });
  state.reflections = [];
  state.pos = Math.floor(state.cards.length / 2);
  state.velocity = 0;
  if (state.cards.length) mlibSlabRender(grid);
}

// ---- 胶囊（专辑 / 歌单） ----
function ensureMlibVinylPill() {
  var existing = document.getElementById('mlib-vinyl-view-switch');
  if (existing) return existing;
  var scroll = document.getElementById('music-library-scroll');
  if (!scroll) return null;
  var pill = document.createElement('div');
  pill.id = 'mlib-vinyl-view-switch';
  pill.className = 'mlib-vinyl-view-switch';
  pill.setAttribute('role', 'group');
  pill.setAttribute('aria-label', '资料库视图：专辑 / 歌单');
  pill.hidden = true;
  pill.innerHTML = '<button type="button" data-mlibview="albums">专辑</button>'
    + '<button type="button" data-mlibview="playlists">歌单</button>';
  pill.addEventListener('click', function (event) {
    var btn = event.target && event.target.closest ? event.target.closest('[data-mlibview]') : null;
    if (!btn) return;
    var nav = document.getElementById('mlib-nav-item-' + btn.getAttribute('data-mlibview'));
    if (nav) nav.click();
  });
  var navSection = document.getElementById('mlib-nav-section');
  if (navSection && navSection.parentElement === scroll) navSection.insertAdjacentElement('afterend', pill);
  else scroll.insertBefore(pill, scroll.firstChild);
  return pill;
}

function syncMlibVinylPill() {
  var pill = ensureMlibVinylPill();
  if (!pill) return;
  var view = mlibVinylActiveView();
  pill.hidden = !isMlibVinylActive();
  Array.prototype.forEach.call(pill.querySelectorAll('[data-mlibview]'), function (btn) {
    var on = btn.getAttribute('data-mlibview') === view;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function applyMlibViewStyle(value, opts) {
  opts = opts || {};
  var style = normalizeMlibViewStyle(value == null ? (typeof fx === 'object' && fx ? fx.mlibViewStyle : 'grid') : value);
  if (typeof fx === 'object' && fx) fx.mlibViewStyle = style;
  var lib = mlibVinylLibraryEl();
  if (lib) lib.classList.toggle('mlib-vinyl-style', style === 'vinyl');
  if (style === 'vinyl' && mlibVinylActiveView() === 'artists') {
    var albumsNav = document.getElementById('mlib-nav-item-albums');
    if (albumsNav) albumsNav.click();
  }
  var seg = document.getElementById('mlib-view-style-seg');
  if (seg) {
    Array.prototype.forEach.call(seg.querySelectorAll('[data-mlib-style]'), function (btn) {
      var on = btn.getAttribute('data-mlib-style') === style;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  syncMlibVinylPill();
  if (style === 'vinyl') {
    mlibVinylGrids().forEach(function (grid) {
      bindMlibSlabInput(grid);
      if (!grid.hidden) resetMlibSlabGrid(grid);
    });
  } else {
    mlibVinylGrids().forEach(function (grid) { teardownMlibSlabGrid(grid); });
  }
  if (opts.persist === true && typeof saveLyricLayout === 'function') {
    saveLyricLayout({ user: true, reason: 'mlibViewStyle' });
  }
  return style;
}
window.setMlibViewStyle = applyMlibViewStyle;

function disableMlibNativeDrag() {
  var lib = mlibVinylLibraryEl();
  if (!lib || lib.dataset.mlibNoDrag === '1') return;
  lib.dataset.mlibNoDrag = '1';
  lib.addEventListener('dragstart', function (event) {
    if (event.target && event.target.closest && event.target.closest('img,a[href],input')) event.preventDefault();
  });
}

function bindMlibViewStyleSeg() {
  var seg = document.getElementById('mlib-view-style-seg');
  if (!seg || seg.dataset.mlibStyleBound === '1') return;
  seg.dataset.mlibStyleBound = '1';
  seg.addEventListener('click', function (event) {
    var btn = event.target && event.target.closest ? event.target.closest('[data-mlib-style]') : null;
    if (!btn) return;
    var style = applyMlibViewStyle(btn.getAttribute('data-mlib-style'), { persist: true });
    if (typeof showToast === 'function') showToast('资料库视图: ' + (style === 'vinyl' ? '黑胶墙' : '网格'));
  });
}

function initMlibVinylView() {
  disableMlibNativeDrag();
  bindMlibViewStyleSeg();
  ensureMlibVinylPill();
  mlibVinylGrids().forEach(function (grid) {
    bindMlibSlabInput(grid);
    if (grid.dataset.mlibSlabObserved === '1') return;
    grid.dataset.mlibSlabObserved = '1';
    if (typeof MutationObserver === 'function') {
      new MutationObserver(function () {
        var state = mlibSlabState(grid);
        if (performance.now() < state.internalUntil) return;
        state.cards = [];
        state.reflections = [];
        state.pos = 0;
        if (isMlibVinylActive() && !grid.hidden) resetMlibSlabGrid(grid);
      }).observe(grid, { childList: true });
    }
  });
  var viewsNav = document.getElementById('mlib-nav-children-views');
  if (viewsNav && viewsNav.dataset.mlibSlabObserved !== '1') {
    viewsNav.dataset.mlibSlabObserved = '1';
    if (typeof MutationObserver === 'function') {
      new MutationObserver(function () {
        syncMlibVinylPill();
        mlibVinylGrids().forEach(function (grid) {
          if (isMlibVinylActive() && !grid.hidden) resetMlibSlabGrid(grid);
        });
      }).observe(viewsNav, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }
  }
  window.addEventListener('resize', function () {
    if (!isMlibVinylActive()) return;
    mlibVinylGrids().forEach(function (grid) { if (!grid.hidden) mlibSlabRender(grid); });
  }, { passive: true });
  applyMlibViewStyle((typeof fx === 'object' && fx) ? fx.mlibViewStyle : 'grid', { persist: false });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMlibVinylView, { once: true });
} else {
  initMlibVinylView();
}