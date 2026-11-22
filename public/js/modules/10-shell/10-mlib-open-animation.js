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
  var panelSource = null;
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

  function accentFromRgbString(str) {
    var m = String(str || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!m) return null;
    var r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    var sat = mx === 0 ? 1 : (mx - mn) / mx;
    var boost = sat < 0.18 ? 1.18 : 1.0;
    function ch(v) { return Math.max(40, Math.min(235, Math.round((v * 0.72 + 44) * boost))); }
    return ch(r) + ' ' + ch(g) + ' ' + ch(b);
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

  function openedIsPlaylist() {
    var pl = document.getElementById('am-playlist-detail-modal');
    if (pl && pl.classList.contains('show')) return true;
    var al = document.getElementById('am-album-detail-modal');
    if (al && al.classList.contains('show')) return false;
    return !!(gridRef && gridRef.id === 'mlib-playlists-grid');
  }

  function waitForTracks(cb) {
    var tries = 0;
    (function poll() {
      var wrap = document.getElementById(openedIsPlaylist() ? 'am-playlist-detail-tracks' : 'am-album-detail-tracks');
      if ((wrap && wrap.querySelectorAll('.am-album-track').length) || tries > 480) { cb(wrap); return; }
      tries += 1;
      requestAnimationFrame(poll);
    })();
  }

  function fmtDur(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // 动态封面（Motion Artwork）：与旧详情页同一套逻辑 —— 只有单 mp4 才播，失败静默退回静态图
  function applyMotionArtwork(hero, src) {
    if (!src || !src.title || src.isPlaylist) return;
    var url = '/api/apple/library/album/motion?name=' + encodeURIComponent(src.title)
      + '&artist=' + encodeURIComponent(String(src.artist || ''));
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var m = data && data.motion;
        if (!m || !m.isDirectFile || !m.videoUrl) return;
        if (!hero.isConnected) return;
        var v = document.createElement('video');
        v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
        v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
        v.preload = 'auto';
        if (src.cover) v.poster = src.cover;
        v.setAttribute('aria-hidden', 'true');
        v.addEventListener('error', function () { try { v.remove(); } catch (_) {} });
        v.addEventListener('loadeddata', function () {
          var img = hero.querySelector('img');
          if (img) img.style.display = 'none';
        });
        v.src = '/api/audio?url=' + encodeURIComponent(m.videoUrl);
        hero.appendChild(v);
        try { v.play().catch(function () {}); } catch (_) {}
      })
      .catch(function () {});
  }

  // 播放：Apple 走 AMC（与旧详情页同一通道），非 Apple 才走内部播放器
  function appleSource() {
    try { return (typeof mlibActiveSource === 'string' && mlibActiveSource) ? mlibActiveSource : 'apple'; }
    catch (e) { return 'apple'; }
  }
  function amcBridge() {
    return (window.mineradio && window.mineradio.amc) || null;
  }
  function toast(msg) { if (typeof showToast === 'function') showToast(msg); }
  function playAlbumStart(src) {
    // 非 Apple：一律交给 Mineradio 自己的播放器，绝不碰 AMC/UIA
    if (src.provider !== 'apple') {
      if (typeof window.playSongsInApp === 'function') window.playSongsInApp(src.tracks, 0, src.provider, src.title);
      else toast('播放器尚未就绪');
      return;
    }
    var amc = amcBridge();
    if (amc && typeof amc.playAlbum === 'function') {
      toast('正在让 Apple Music 播放：' + src.title);
      Promise.resolve(amc.playAlbum({ name: src.title, scopeLabel: '你的资料库', sectionLabel: '专辑' }))
        .then(function (res) { toast(res && res.verified ? '✓ Apple Music 已开始播放' : 'Apple Music 播放未确认'); })
        .catch(function () { toast('Apple Music 播放失败'); });
      return;
    }
    if (typeof window.playSongsInApp === 'function') window.playSongsInApp(src.tracks, 0, src.provider, src.title);
  }
  function playAlbumTrack(src, index) {
    // 非 Apple：交给 Mineradio 播放器，并指定起始曲目
    if (src.provider !== 'apple') {
      if (typeof window.playSongsInApp === 'function') window.playSongsInApp(src.tracks, index, src.provider, src.title);
      else toast('播放器尚未就绪');
      return;
    }
    var trackName = String((src.tracks[index] && (src.tracks[index].name || src.tracks[index].title)) || '');
    var amc = amcBridge();
    if (amc && typeof amc.playAlbum === 'function') {
      toast('正在让 Apple Music 播放：' + trackName);
      Promise.resolve(amc.playAlbum({ name: src.title, track: trackName, scopeLabel: '你的资料库', sectionLabel: '专辑' }))
        .then(function (res) { toast(res && res.verified ? '✓ Apple Music 已开始播放：' + trackName : 'Apple Music 未确认播放：' + trackName); })
        .catch(function () { toast('Apple Music 播放失败'); });
      return;
    }
    if (typeof window.playSongsInApp === 'function') window.playSongsInApp(src.tracks, index, src.provider, src.title);
  }
  function playPlaylistStart(src, shuffled) {
    // 非 Apple：歌单（含随机）全部交给 Mineradio 播放器
    if (src.provider !== 'apple') {
      if (typeof window.playSongsInApp === 'function') {
        var arr0 = src.tracks.slice();
        if (shuffled) {
          for (var s0 = arr0.length - 1; s0 > 0; s0 -= 1) {
            var r0 = Math.floor(Math.random() * (s0 + 1));
            var tmp0 = arr0[s0]; arr0[s0] = arr0[r0]; arr0[r0] = tmp0;
          }
        }
        window.playSongsInApp(arr0, 0, src.provider, src.title + (shuffled ? ' · 随机' : ''));
      } else toast('播放器尚未就绪');
      return;
    }
    var amc = amcBridge();
    var fn = shuffled ? (amc && amc.playPlaylistShuffled) : (amc && amc.playPlaylist);
    if (typeof fn === 'function') {
      toast('正在让 Apple Music 播放：' + src.title + (shuffled ? '（随机）' : ''));
      Promise.resolve(fn.call(amc, { name: src.title, scopeLabel: '你的资料库' }))
        .then(function (res) { toast(res && res.verified ? '✓ Apple Music 已开始播放' : 'Apple Music 播放未确认'); })
        .catch(function () { toast('Apple Music 播放失败'); });
      return;
    }
    if (typeof window.playSongsInApp === 'function') {
      var arr = src.tracks.slice();
      if (shuffled) {
        for (var i = arr.length - 1; i > 0; i -= 1) {
          var j = Math.floor(Math.random() * (i + 1));
          var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        }
      }
      window.playSongsInApp(arr, 0, src.provider, src.title);
    }
  }

  function buildDetailPanel() {
    if (!overlay || !panelSource) return;
    var src = panelSource;
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
    if (src.cover) { var im = document.createElement('img'); im.src = src.cover; im.alt = ''; hero.appendChild(im); }
    applyMotionArtwork(hero, src);

    var side = document.createElement('div');
    side.className = 'mlib-oa-side';
    var h = document.createElement('h2');
    h.className = 'am-album-title';
    h.textContent = src.title || '未命名';
    side.appendChild(h);
    if (src.sub) {
      var a = document.createElement('div');
      a.className = 'am-album-artist';
      a.textContent = src.sub;
      side.appendChild(a);
    }
    var facts = [];
    if (src.total) facts.push(src.total + ' 首');
    if (src.tracks.length) {
      var totalSec = 0;
      src.tracks.forEach(function (t) { totalSec += Number(t.duration || 0); });
      if (totalSec > 0) facts.push(fmtDur(totalSec).replace(':', ' 分 ') + ' 秒');
    }
    if (facts.length) {
      var f = document.createElement('div');
      f.className = 'am-album-facts';
      f.textContent = facts.join('  ·  ');
      side.appendChild(f);
    }
    // 播放 / 随机播放：Apple 走原有播放逻辑（window.playSongsInApp）
    if (src.tracks.length && typeof window.playSongsInApp === 'function') {
      var actions = document.createElement('div');
      actions.className = 'mlib-oa-actions';
      var playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'mlib-oa-btn mlib-oa-btn-primary';
      playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 5.5v13l10.5-6.5z"/></svg><span>' + (src.isPlaylist ? '播放歌单' : '播放专辑') + '</span>';
      playBtn.addEventListener('click', function () {
        if (src.isPlaylist) playPlaylistStart(src, false);
        else playAlbumStart(src);
      });
      actions.appendChild(playBtn);
      if (src.isPlaylist) {
        var shuffleBtn = document.createElement('button');
        shuffleBtn.type = 'button';
        shuffleBtn.className = 'mlib-oa-btn mlib-oa-btn-ghost';
        shuffleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h4l8 10h4M4 17h4l8-10h4"/><path d="M17 4l3 3-3 3M17 14l3 3-3 3"/></svg><span>随机播放</span>';
        shuffleBtn.addEventListener('click', function () { playPlaylistStart(src, true); });
        actions.appendChild(shuffleBtn);
      }
      side.appendChild(actions);
    }
    if (src.desc) {
      var desc = document.createElement('p');
      desc.className = 'mlib-oa-desc';
      desc.textContent = src.desc;
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
    src.tracks.forEach(function (t, i) {
      var row = document.createElement('div');
      row.className = 'am-album-track';
      row.setAttribute('data-am-track-index', String(i));
      var no = document.createElement('div');
      no.className = 'am-album-track-no';
      no.textContent = String(Number(t.trackNumber) > 0 ? t.trackNumber : i + 1);
      var nm = document.createElement('div');
      nm.className = 'am-album-track-name';
      nm.textContent = String(t.name || t.title || '未命名曲目');
      var du = document.createElement('div');
      du.className = 'am-album-track-dur';
      du.textContent = fmtDur(t.duration);
      row.appendChild(no); row.appendChild(nm); row.appendChild(du);
      list.appendChild(row);
    });
    if (!src.tracks.length) {
      var empty = document.createElement('div');
      empty.className = 'am-album-status';
      empty.textContent = !src.ready ? '曲目加载中…' : (src.error ? ('曲目加载失败：' + src.error) : '没有可显示的曲目');
      list.appendChild(empty);
    }
    if (src.tracks.length && typeof window.playSongsInApp === 'function') {
      list.addEventListener('click', function (event) {
        var row = event.target && event.target.closest ? event.target.closest('[data-am-track-index]') : null;
        if (!row) return;
        var idx = Number(row.getAttribute('data-am-track-index'));
        if (isFinite(idx) && idx >= 0 && idx < src.tracks.length) {
          if (src.isPlaylist) {
            if (src.provider === 'apple') playPlaylistStart(src, false);
            else if (typeof window.playSongsInApp === 'function') window.playSongsInApp(src.tracks, idx, src.provider, src.title);
          } else {
            playAlbumTrack(src, idx);
          }
        }
      });
    }
    side.appendChild(list);
    detail.appendChild(hero);
    detail.appendChild(side);

    var quickAccent = accentFromRgbString(spineColor);
    if (quickAccent) detail.style.setProperty('--mlib-oa-accent', quickAccent);
    sampleAccent(src.cover).then(function (rgb) { detail.style.setProperty('--mlib-oa-accent', rgb); });

    var close = document.createElement('button');
    close.className = 'mlib-oa-close';
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.addEventListener('click', closeDetail);

    overlay.appendChild(detail);
    overlay.appendChild(close);
    overlay.classList.add('is-detail');
    overlay.style.opacity = '1';
    busy = false;
  }

  function showDetail() {
    if (!overlay) { cleanup(); return; }
    if (panelSource && panelSource.ready) { buildDetailPanel(); return; }
    // 数据还没到：等一小会儿（最多 ~4s），到齐或超时都构建
    var waited = 0;
    (function poll() {
      if (!overlay) return;
      if ((panelSource && panelSource.ready) || waited > 80) { buildDetailPanel(); return; }
      waited += 1;
      setTimeout(poll, 50);
    })();
  }
  function closeDetail() {
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
    var w = Math.min(1240, Math.round(vw * 0.92));
    var h = Math.min(720, Math.round(vh * 0.84));
    var left = Math.round((vw - w) / 2);
    var top = Math.round((vh - h) / 2);
    // 封面区取正方形（边长 = 面板高），保证封面不被左右裁切
    var heroW = Math.round(Math.min(h, Math.max(320, w - 360)));
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

  function currentProvider() {
    try { return (typeof mlibActiveSource === 'string' && mlibActiveSource) ? mlibActiveSource : 'apple'; }
    catch (e) { return 'apple'; }
  }
  function stripSourcePrefix(id) { return String(id || '').replace(/^(ne|kg|qq|qs|sp|am):/i, ''); }
  function providerOfId(id) {
    var m = /^(ne|kg|qq|qs|sp):/i.exec(String(id || ''));
    if (!m) return null;
    return ({ ne: 'netease', kg: 'kugou', qq: 'qq', qs: 'qishui', sp: 'spotify' })[m[1].toLowerCase()] || null;
  }
  // 旧详情页直接把**带前缀的 id**交给接口（服务端各自剥前缀）；这里保持一致
  function albumTracksUrl(provider, id) {
    var enc = encodeURIComponent(id);
    if (provider === 'apple') return '/api/apple/library/album/tracks?id=' + enc + '&limit=100';
    if (provider === 'kugou') return '/api/kugou/library/album/tracks?id=' + enc;
    if (provider === 'qq') return '/api/qq/library/album/tracks?id=' + enc;
    if (provider === 'qishui') return '/api/qishui/library/album/tracks?id=' + enc;
    if (provider === 'spotify') return '/api/spotify/library/album/tracks?id=' + enc;
    return '/api/netease/library/album/tracks?id=' + enc;
  }
  function playlistTracksUrl(provider, id) {
    var k = encodeURIComponent(stripSourcePrefix(id));
    if (provider === 'apple') return '/api/apple/playlist/tracks?id=' + encodeURIComponent(id) + '&all=1';
    if (provider === 'kugou') return '/api/kugou/library/playlist/tracks?id=' + k;
    if (provider === 'qq') return '/api/qq/library/playlist/tracks?id=' + k;
    if (provider === 'qishui') return '/api/qishui/library/playlist/tracks?id=' + k;
    if (provider === 'spotify') return '/api/spotify/library/playlist/tracks?id=' + k;
    return '/api/playlist/tracks?id=' + k;
  }
  function normalizeSong(t, i) {
    var dur = Number(t && (t.duration || t.durationMs || t.dt || 0)) || 0;
    if (dur > 10000) dur = Math.round(dur / 1000);   // 毫秒 → 秒
    return {
      name: String((t && (t.name || t.title)) || '未命名曲目'),
      duration: dur,
      trackNumber: Number(t && (t.trackNumber || t.no)) || (i + 1)
    };
  }

  // 黑胶模式不再打开旧详情弹窗：自己拉数据
  function panelSourceOf(grid, card) {
    var isPlaylist = grid && grid.id === 'mlib-playlists-grid';
    var nameEl = card.querySelector('.mlib-album-name');
    var subEl = card.querySelector('.mlib-album-sub');
    var title = nameEl ? String(nameEl.textContent || '').trim() : '';
    var sub = subEl ? String(subEl.textContent || '').trim() : '';
    return {
      isPlaylist: isPlaylist,
      provider: providerOfId(isPlaylist ? String(card.getAttribute('data-mlib-playlist-id') || '') : String(card.getAttribute('data-album-id') || '')) || currentProvider(),
      id: isPlaylist ? String(card.getAttribute('data-mlib-playlist-id') || '') : String(card.getAttribute('data-album-id') || ''),
      title: title,
      sub: sub,
      artist: sub,
      cover: mlibSlabCoverOf ? mlibSlabCoverOf(card) : (card.querySelector('.mlib-art img') || {}).src || '',
      tracks: [],
      total: 0,
      desc: '',
      ready: false
    };
  }

  function loadPanelData(src) {
    var tracksUrl = src.isPlaylist
      ? playlistTracksUrl(src.provider, src.id)
      : albumTracksUrl(src.provider, src.id);
    function fetchJson(url) {
      return fetch(url, { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .catch(function () { return { error: 'NETWORK' }; });
    }
    return fetchJson(tracksUrl)
      .then(function (j) {
        if (j && j.error && !((j.tracks || j.songs || []).length)) {
          return new Promise(function (res) { setTimeout(res, 600); }).then(function () { return fetchJson(tracksUrl); });
        }
        return j;
      })
      .then(function (j) {
        src.error = String((j && (j.error || j.reason)) || '');
        src.tracks = ((j && (j.songs || j.tracks)) || []).map(normalizeSong);
        src.total = Number(j && (j.total || src.tracks.length)) || src.tracks.length;
        if (!src.isPlaylist && src.provider === 'apple') {
          return fetch('/api/apple/library/album/notes?id=' + encodeURIComponent(src.id), { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (n) {
              var an = n && n.albumNotes;
              var notes = an && an.editorialNotes;
              var text = '';
              if (typeof notes === 'string') text = notes;
              else if (notes && typeof notes === 'object') text = String(notes.standard || notes.short || '');
              if (!text && an && typeof an.description === 'string') text = an.description;
              // 去 HTML 标签 + 解基本实体 + 折叠空白（与旧弹窗 stripEditorialHtml 等价的最小实现）
              text = String(text || '')
                .replace(/<br\s*\/?>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/gi, ' ')
                .replace(/&amp;/gi, '&')
                .replace(/&quot;/gi, '"')
                .replace(/&#39;/gi, "'")
                .replace(/\s+/g, ' ')
                .trim();
              src.desc = text;
            })
            .catch(function () {});
        }
      })
      .catch(function () {})
      .then(function () { src.ready = true; return src; });
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
    panelSource = panelSourceOf(grid, card);
    loadPanelData(panelSource);
    setTimeout(function () {
      if (!overlay && busy) { cleanup(); }
    }, 1600);
    // 硬兜底：无论数据/面板是否成功，最多 6s 后必须结束（清理并恢复书架）
    setTimeout(function () {
      if (busy) { cleanup(); }
    }, 6000);
    
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
    // 黑胶模式由新详情面板接管：阻止应用自己的旧详情处理器
    event.preventDefault();
    event.stopPropagation();
    try { begin(grid, card); } catch (e) { cleanup(); }
  }, true);

  // 切源 / 切视图时立刻收掉动画与面板，避免停留在半途（封面悬空、书架推空）
  function abortAll() {
    if (busy || overlay) { closeDetail(); }
  }
  document.addEventListener('click', function (event) {
    var t = event.target;
    if (!t || !t.closest) return;
    if (t.closest('#mlib-nav-children-source .mlib-nav-item') || t.closest('#mlib-nav-children-views .mlib-nav-item')) abortAll();
  }, true);
  window.addEventListener('mlib:source-changed', abortAll);

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