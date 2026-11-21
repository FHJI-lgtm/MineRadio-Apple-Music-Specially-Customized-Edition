'use strict';
// ============================================================
// 3D 专辑墙 · 独立原型
//
// 空间模型：
//   · 每张专辑 = 一块 w(纵深) × h(高) × t(厚) 的薄板，绕 Y 轴转 90° 垂直站立；
//   · 薄板沿 X 轴排成一排；镜头正对，一点透视，消失点在屏幕中央；
//   · 中间的板只剩书脊可见，越往两侧越能看到封面（这是投影的结果，不是逐张调角度）；
//   · 书脊底色取封面主色（经 /api/cover 代理后 canvas 采样，跨域可读）；
//   · 下方地板倒影 = 同一几何体沿地面镜像 + 渐隐 + 模糊。
//   · 离心越远：越模糊、越暗。
// ============================================================

(function () {
  var scene = document.getElementById('scene');
  var wall = document.getElementById('wall');

  // ---- 空间参数（与 CSS 中 --w/--h/--t 对应） ----
  var SLAB_W = 1000;     // 薄板纵深
  var SLAB_H = 430;      // 高度
  var SLAB_T = 34;       // 厚度 = 中间书脊的可见宽度
  var SPACING = 96;      // 薄板之间的 X 间距
  var FLOOR_Y = 235;     // 地板线（相对屏幕中心，向下为正）
  var CENTER_Y = FLOOR_Y - SLAB_H / 2;   // 薄板中心高度
  var CENTER_Z = 0 - SLAB_W / 2;         // 近边贴在 z=0 平面，向纵深里延伸

  var albums = [];
  var nodes = [];        // { box, mirror }
  var pos = 0;           // 当前连续位置（单位：张）
  var velocity = 0;      // 惯性（张/毫秒）
  var dragging = false;
  var lastT = 0;
  var dragX = 0;
  var dragT = 0;
  var moved = false;
  var snapTarget = null;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function buildBox(album, isMirror) {
    var el = document.createElement('div');
    el.className = 'album' + (isMirror ? ' is-reflection' : '');
    if (isMirror) el.setAttribute('aria-hidden', 'true');

    function face(cls) {
      var f = document.createElement('div');
      f.className = 'face ' + cls;
      return f;
    }

    function coverFace(cls) {
      var f = face(cls);
      if (album.cover) {
        var img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.src = album.cover;
        f.appendChild(img);
      }
      return f;
    }

    var sideL = face('side-l');
    var spine = document.createElement('span');
    spine.className = 'spine-text';
    spine.textContent = album.artist ? album.name + ' · ' + album.artist : album.name;
    sideL.appendChild(spine);

    el.appendChild(coverFace('front'));
    el.appendChild(coverFace('back'));
    el.appendChild(sideL);
    el.appendChild(face('side-r'));
    el.appendChild(face('edge-t'));
    el.appendChild(face('edge-b'));
    return el;
  }

  // ---- 离中心越远：越暗、越模糊 ----
  function shadeFor(x) {
    var d = Math.abs(x);
    var light = 1 - Math.min(1, d / 900) * 0.52;
    var blur = Math.min(4.2, Math.max(0, (d - 200) / 230));
    return { light: light.toFixed(3), blur: blur.toFixed(2) + 'px' };
  }

  function applyAlbum(node, x) {
    var shade = shadeFor(x);
    node.box.style.transform =
      'translate3d(' + x.toFixed(2) + 'px, ' + CENTER_Y + 'px, ' + CENTER_Z + 'px)' +
      ' rotateY(90deg)';
    node.box.style.setProperty('--light', shade.light);
    node.box.style.setProperty('--blur', shade.blur);
    // 倒影：沿地板线镜像（y → 2F − y），再纵向翻转
    node.mirror.style.transform =
      'translate3d(' + x.toFixed(2) + 'px, ' + (2 * FLOOR_Y - CENTER_Y) + 'px, ' + CENTER_Z + 'px)' +
      ' rotateY(90deg) scaleY(-1)';
    node.mirror.style.setProperty('--light', shade.light);
    node.mirror.style.setProperty('--blur', shade.blur);
  }

  function visibleHalf() {
    return Math.ceil((window.innerWidth / 2 + SLAB_W) / SPACING) + 2;
  }

  function render() {
    var half = visibleHalf();
    for (var i = 0; i < nodes.length; i += 1) {
      var rel = i - pos;
      var node = nodes[i];
      if (Math.abs(rel) > half) {
        if (node.box.style.display !== 'none') {
          node.box.style.display = 'none';
          node.mirror.style.display = 'none';
        }
        continue;
      }
      if (node.box.style.display === 'none') {
        node.box.style.display = '';
        node.mirror.style.display = '';
      }
      applyAlbum(node, rel * SPACING);
    }
  }

  // ---- 惯性循环 ----
  var raf = 0;
  function loop(now) {
    raf = 0;
    var dt = Math.min(48, now - (lastT || now));
    lastT = now;
    if (dragging) { raf = requestAnimationFrame(loop); return; }
    if (Math.abs(velocity) > 0.00035) {
      pos = clamp(pos + velocity * dt, 0, nodes.length - 1);
      velocity *= Math.pow(0.935, dt / 16.7);
      render();
      raf = requestAnimationFrame(loop);
      return;
    }
    velocity = 0;
    snapTarget = Math.round(pos);
    var diff = snapTarget - pos;
    if (Math.abs(diff) < 0.002) { pos = snapTarget; render(); return; }
    pos += diff * Math.min(1, 0.26 * (dt / 16.7));
    render();
    raf = requestAnimationFrame(loop);
  }
  function kick() { if (!raf) { lastT = 0; raf = requestAnimationFrame(loop); } }

  // ---- 交互：左右滑动 + 惯性 + 吸附 ----
  function bindInput() {
    scene.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true; moved = false; dragX = e.clientX; dragT = performance.now(); velocity = 0;
      lastT = 0;
      scene.classList.add('is-dragging');
      try { if (scene.setPointerCapture && e.pointerId != null) scene.setPointerCapture(e.pointerId); } catch (_) {}
    });
    scene.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - dragX;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      dragX = e.clientX;
      var now = performance.now();
      var dtm = Math.max(8, Math.min(120, now - dragT));
      dragT = now;
      var delta = -dx / SPACING;
      pos = clamp(pos + delta, 0, nodes.length - 1);
      // 惯性速度：张/毫秒（用真实事件间隔归一化，避免一下子冲到末端）
      velocity = delta / dtm;
      render();
    });
    function end() {
      if (!dragging) return;
      dragging = false;
      scene.classList.remove('is-dragging');
      kick();
    }
    scene.addEventListener('pointerup', end);
    scene.addEventListener('pointercancel', end);
    scene.addEventListener('wheel', function (e) {
      e.preventDefault();
      pos = clamp(pos + ((e.deltaY || 0) + (e.deltaX || 0)) / 260, 0, nodes.length - 1);
      render();
      kick();
    }, { passive: false });
    scene.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { pos = clamp(Math.round(pos) + 1, 0, nodes.length - 1); kick(); }
      else if (e.key === 'ArrowLeft') { pos = clamp(Math.round(pos) - 1, 0, nodes.length - 1); kick(); }
    });
    window.addEventListener('resize', render);
  }

  // ---- 书脊主色：走 /api/cover 代理后 canvas 采样 ----
  var colorQueue = [];
  var colorBusy = 0;
  function queueSpineColor(album, boxes) {
    colorQueue.push({ album: album, boxes: boxes });
    pumpColorQueue();
  }
  function pumpColorQueue() {
    while (colorBusy < 4 && colorQueue.length) {
      var job = colorQueue.shift();
      colorBusy += 1;
      sampleCoverColor(job.album).then(function (color) {
        if (color) {
          job.boxes.forEach(function (b) { b.style.setProperty('--spine', color); });
        }
      }).catch(function () {}).then(function () {
        colorBusy -= 1;
        pumpColorQueue();
      });
    }
  }
  var canvas = document.createElement('canvas');
  canvas.width = 6; canvas.height = 6;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  function sampleCoverColor(album) {
    return new Promise(function (resolve) {
      if (!album || !album.cover) { resolve(null); return; }
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';
      img.onload = function () {
        try {
          ctx.clearRect(0, 0, 6, 6);
          ctx.drawImage(img, 0, 0, 6, 6);
          var data = ctx.getImageData(0, 0, 6, 6).data;
          var r = 0, g = 0, b = 0, w = 0;
          for (var i = 0; i < data.length; i += 4) {
            var rr = data[i], gg = data[i + 1], bb = data[i + 2];
            // 过滤过亮/过暗的像素，取有色彩的中段做平均
            var lum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
            if (lum < 18 || lum > 244) continue;
            r += rr; g += gg; b += bb; w += 1;
          }
          if (!w) { resolve(null); return; }
          r = Math.round(r / w); g = Math.round(g / w); b = Math.round(b / w);
          resolve('rgb(' + r + ',' + g + ',' + b + ')');
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = '/api/cover?url=' + encodeURIComponent(album.cover);
    });
  }

  function normalizeAlbum(raw) {
    if (!raw) return null;
    var cover = String(raw.cover || raw.artwork || raw.artworkUrl || '').trim();
    if (!cover) return null;
    return {
      name: String(raw.name || raw.title || '未命名专辑'),
      artist: String(raw.artist || raw.artistName || ''),
      cover: cover.replace(/^http:/i, 'https:')
    };
  }

  function build(list) {
    albums = list.slice(0, 40);
    wall.innerHTML = '';
    nodes = [];
    for (var i = 0; i < albums.length; i += 1) {
      var box = buildBox(albums[i], false);
      var mirror = buildBox(albums[i], true);
      wall.appendChild(box);
      wall.appendChild(mirror);
      nodes.push({ box: box, mirror: mirror });
      queueSpineColor(albums[i], [box, mirror]);
    }
    pos = Math.floor(nodes.length / 2);
    render();
  }

  function bindSegmented() {
    var seg = document.getElementById('segmented');
    if (!seg) return;
    seg.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn) return;
      Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) {
        var on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    });
  }

  window.__labState = function () { return { pos: pos, velocity: velocity, count: nodes.length, dragging: dragging }; };

  function boot() {
    bindInput();
    bindSegmented();
    scene.focus();
    fetch('/api/apple/library/index', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (payload) {
        var mapped = ((payload && payload.albums) || []).map(normalizeAlbum).filter(Boolean);
        if (!mapped.length) throw new Error('empty');
        build(mapped);
      })
      .catch(function () { document.documentElement.classList.add('lab-no-data'); });
  }

  boot();
})();