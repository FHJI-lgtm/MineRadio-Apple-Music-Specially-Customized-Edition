'use strict';

/* ------------------------------------------------------------------
 * 资料库专辑详情页（第一版）
 * 复用：.modal-mask/.modal 生命周期、library albums/tracks 接口、
 *       playAmcTrackFromSong（唯一播放发布点）、currentPlaybackContext（真实播放状态）
 * 身份边界：选中依据 library album id；曲目用 payload 的 library song id + 显式 catalogId。
 * ------------------------------------------------------------------ */
(function initAmAlbumDetail() {
  var modalId = 'am-album-detail-modal';
  var reqSeq = 0;
  var state = {
    album: null, songs: [], libraryCount: 0,
    status: 'idle',
    descExpanded: false, descFull: '', playingKey: '', playBusy: false
  };

  function el(id) { return document.getElementById(id); }
  function maskEl() { return el(modalId); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDuration(sec) {
    var s = Number(sec);
    if (!isFinite(s) || s <= 0) return '';
    var m = Math.floor(s / 60);
    var r = Math.round(s % 60);
    if (r === 60) { m += 1; r = 0; }
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  function fmtYear(dateStr) {
    var y = String(dateStr || '').slice(0, 4);
    return /^\d{4}$/.test(y) ? y : '';
  }
  // 总时长显示精确的 分:秒：整分钟取整在短专辑上会显示成 "0 分钟"。
  function fmtTotalDuration(songs) {
    var total = 0, known = 0;
    (songs || []).forEach(function (s) {
      var d = Number(s && s.duration);
      if (isFinite(d) && d > 0) { total += d; known += 1; }
    });
    if (!known) return '';
    var m = Math.floor(total / 60);
    var r = Math.round(total % 60);
    if (r === 60) { m += 1; r = 0; }
    return m + ' 分 ' + (r < 10 ? '0' : '') + r + ' 秒';
  }

  function trackKey(song) {
    if (!song) return '';
    if (song.catalogId !== undefined && song.catalogId !== null && String(song.catalogId) !== '') return 'c:' + String(song.catalogId);
    return song.id ? 'i:' + String(song.id) : '';
  }

  // 主题色：从封面提取一个偏饱和的主色，铺满整个窗口。
  // Apple Music 的做法是"整个页面都是专辑的颜色"，所以取色偏向色度高的像素，
  // 而不是简单全图平均（平均会把鲜艳封面算成灰褐色）。
  function rgbVars(r, g, b) {
    // 由主色派生同色相的亮/暗两端，避免渐变里出现黑色色块
    var h = rgbToHsl(r, g, b);
    return {
      a: r + ', ' + g + ', ' + b,
      light: hslToRgbStr(h.h, Math.min(1, h.s * 0.92), Math.min(0.62, h.l + 0.16)),
      dark: hslToRgbStr(h.h, Math.min(1, h.s * 1.04), Math.max(0.14, h.l - 0.20)),
      glow: hslToRgbStr(h.h, Math.min(1, h.s * 1.15), Math.min(0.60, h.l + 0.10))
    };
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h: h, s: s, l: l };
  }

  function hslToRgbStr(h, s, l) {
    h = ((h % 1) + 1) % 1;
    s = Math.max(0, Math.min(1, s));
    l = Math.max(0, Math.min(1, l));
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      var hk = h;
      var f = function (t) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      r = f(hk + 1 / 3); g = f(hk); b = f(hk - 1 / 3);
    }
    return Math.round(r * 255) + ', ' + Math.round(g * 255) + ', ' + Math.round(b * 255);
  }

  // 主题取色要能作用到"当前打开的那个弹窗"：专辑与歌单共用这套外观，
  // 但各自是独立的 DOM 节点 —— 变量必须写在目标弹窗上，否则另一个永远拿不到主色。
  function clearTheme(target) {
    var modal = target || maskEl();
    if (!modal) return;
    ['--am-theme-a', '--am-theme-b', '--am-theme-light', '--am-theme-dark', '--am-theme-glow'].forEach(function (k) {
      modal.style.removeProperty(k);
    });
  }

  function applyThemeVars(r, g, b, target) {
    var modal = target || maskEl();
    if (!modal) return;
    var v = rgbVars(r, g, b);
    modal.style.setProperty('--am-theme-a', v.a);
    modal.style.setProperty('--am-theme-b', v.a);
    modal.style.setProperty('--am-theme-light', v.light);
    modal.style.setProperty('--am-theme-dark', v.dark);
    modal.style.setProperty('--am-theme-glow', v.glow);
  }

  // 取色要在 canvas 里读像素，图片就必须带 CORS 头；否则 canvas 被污染、
  // getImageData 抛异常 -> 主题退回深色默认值（表现为「背景渐变失效」）。
  // 实测各源封面：Apple / 网易云 / 酷狗 都返回 Access-Control-Allow-Origin: *，
  // **QQ 的 y.qq.com 不返回** —— 所以只有这类源走本地代理 /api/cover
  //（那个端点本来就带 CORS 头，注释写明「给 canvas 提取像素用」）。
  var COVER_THEME_PROXY_HOSTS = ['y.qq.com', 'y.gtimg.cn', 'qpic.cn', 'qq.com'];
  function coverThemeSource(coverUrl) {
    var u = String(coverUrl || '').trim();
    if (!u) return u;
    var host = '';
    try { host = new URL(u, location.href).hostname.toLowerCase(); } catch (_) { return u; }
    var needsProxy = COVER_THEME_PROXY_HOSTS.some(function (h) {
      return host === h || host.slice(-(h.length + 1)) === '.' + h;
    });
    return needsProxy ? ('/api/cover?url=' + encodeURIComponent(u)) : u;
  }

  function applyCoverTheme(coverUrl, target) {
    var modal = target || maskEl();
    clearTheme(modal);
    if (!coverUrl) return;   // CSS 里的深色默认值接管（合理的降级）
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = function () {
      try {
        var n = 32;
        var c = document.createElement('canvas');
        c.width = n; c.height = n;
        var ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, n, n);
        var data = ctx.getImageData(0, 0, n, n).data;
        // 直方图选"出现最多且足够饱和"的颜色桶：比全图平均更接近封面的主色相，
        // 又能避开暗部/高光里那些接近灰的像素。
        var buckets = {};
        var fallbackR = 0, fallbackG = 0, fallbackB = 0, fallbackN = 0;
        for (var i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 200) continue;
          var r = data[i], g = data[i + 1], b = data[i + 2];
          fallbackR += r; fallbackG += g; fallbackB += b; fallbackN += 1;
          var hsl = rgbToHsl(r, g, b);
          if (hsl.l < 0.10 || hsl.l > 0.94) continue;
          var key = Math.round(hsl.h * 18) + ':' + Math.round(hsl.s * 3) + ':' + Math.round(hsl.l * 3);
          if (!buckets[key]) buckets[key] = { n: 0, r: 0, g: 0, b: 0, s: hsl.s };
          var bk = buckets[key];
          bk.n += 1; bk.r += r; bk.g += g; bk.b += b;
        }
        var best = null;
        Object.keys(buckets).forEach(function (k) {
          var b0 = buckets[k];
          // 权重 = 像素占比 × 饱和加成：面积大 AND 鲜艳的颜色胜出
          var score = b0.n * (0.45 + b0.s * 1.55);
          if (!best || score > best.score) best = { score: score, r: b0.r / b0.n, g: b0.g / b0.n, b: b0.b / b0.n };
        });
        if (best) {
          applyThemeVars(Math.round(best.r), Math.round(best.g), Math.round(best.b), modal);
        } else if (fallbackN) {
          applyThemeVars(
            Math.round(fallbackR / fallbackN),
            Math.round(fallbackG / fallbackN),
            Math.round(fallbackB / fallbackN),
            modal
          );
        }
      } catch (_) { /* 取色失败 -> CSS 深色默认值 */ }
    };
    img.onerror = function () { clearTheme(modal); };   // 封面失败 -> 深色降级
    img.src = coverThemeSource(coverUrl);
  }

  function setStatus(text, tone) {
    var s = el('am-album-detail-status');
    if (!s) return;
    if (!text) { s.hidden = true; s.textContent = ''; s.removeAttribute('data-tone'); return; }
    s.hidden = false;
    s.textContent = text;
    if (tone) s.setAttribute('data-tone', tone); else s.removeAttribute('data-tone');
  }

  function setPlayBusy(busy) {
    state.playBusy = !!busy;
    var btn = el('am-album-detail-play');
    var label = el('am-album-detail-play-label');
    if (btn) btn.disabled = !!busy;
    if (label) label.textContent = busy ? '正在播放…' : '播放专辑';
  }

  // 详情页顶部的小字：**按实际来源标注**，不再一律写 Apple Music。
  // 非 Apple 源的数据来自该源的个人库，写成 Apple 的语义会误导。
  var SOURCE_KICKER_LABELS = {
    apple: 'Apple Music',
    netease: '网易云音乐',
    kugou: '酷狗音乐',
    qq: 'QQ 音乐',
    qishui: '汽水音乐',
    spotify: 'Spotify',
  };
  function sourceLabelOf(provider) {
    return SOURCE_KICKER_LABELS[String(provider || 'apple')] || 'Apple Music';
  }

  // 非 Apple 源**不走 UIA**，走 MineRadio 自己的播放链路：
  // 把曲目装进 playQueue 后交给 playQueueAt —— 播放入口会按 songProviderKey(song)
  // 选到该源的取流端点（netease -> /api/song/url?id=），并自行处理试听片段。
  function isNonAppleSource(provider) {
    return String(provider || 'apple') !== 'apple';
  }

  // 曲目 -> 播放器可消费的形状。
  // 播放器用 song.id 取流、用 provider 选源，两者都必须有。
  // Apple 的专辑文案是 HTML（含 <b>/<i>/<br> 等）；资料库里的简介按纯文本渲染，
  // 所以先转成纯文本：<br> 与 </p> 变换行，其余标签去掉，顺带还原常见实体。
  function stripEditorialHtml(notes) {
    if (!notes) return '';
    var raw = '';
    if (typeof notes === 'string') raw = notes;
    else if (typeof notes === 'object') raw = String(notes.standard || notes.short || '');
    if (!raw) return '';
    return raw
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function toPlayableSong(song, provider) {
    return {
      id: String((song && (song.id || song.sourceSongId)) || ''),
      provider: provider,
      source: provider,
      name: String((song && song.name) || ''),
      artist: String((song && song.artist) || ''),
      artists: Array.isArray(song && song.artists) ? song.artists : [],
      artistId: (song && song.artistId) || '',
      album: String((song && (song.albumName || song.album)) || ''),
      albumId: String((song && song.albumId) || ''),
      cover: String((song && song.cover) || ''),
      duration: Number((song && song.duration) || 0),
      // 试听/权益由取流端点判定，这里不预判
      playable: !!(song && song.playable),
    };
  }

  // 歌单详情版的应用内播放：状态写到**歌单弹窗**的状态区，不能写错弹窗。
  function playPlaylistInApp(songs, startIndex, playlistName, provider) {
    var list = (Array.isArray(songs) ? songs : []).map(function (s) { return toPlayableSong(s, provider); })
      .filter(function (s) { return s.id && s.name; });
    if (!list.length) { plSetStatus('这些曲目缺少可播放的标识，无法播放', 'warn'); return Promise.resolve(false); }
    if (typeof playQueueAt !== 'function') { plSetStatus('内部播放器尚未就绪', 'warn'); return Promise.resolve(false); }
    plSetBusy(true);
    plSetStatus('正在用 MineRadio 播放器播放…');
    playQueue = list;
    currentIdx = Math.max(0, Math.min(list.length - 1, Number(startIndex) || 0));
    if (typeof safeRenderQueuePanel === 'function') safeRenderQueuePanel('mlib-playlist-' + provider, { scrollCurrent: true });
    if (typeof safeShelfRebuild === 'function') safeShelfRebuild('mlib-playlist-' + provider, true);
    if (typeof forcePlaybackControlsInteractive === 'function') forcePlaybackControlsInteractive();
    return Promise.resolve(playQueueAt(currentIdx, {
      manual: true,
      context: { type: 'music-library-source-playlist', provider: provider, playlistName: playlistName },
    })).then(function () {
      plSetBusy(false);
      plSetStatus('已交给 MineRadio 播放器：' + list[currentIdx].name, 'ok');
      return true;
    }).catch(function (err) {
      plSetBusy(false);
      plSetStatus('播放失败：' + ((err && err.message) || '未知错误'), 'warn');
      return false;
    });
  }

  // 统一入口：把一批曲目交给 MineRadio 自有播放器（非 Apple 源）。
  // 专辑详情、发行卡、歌单详情都走这里，避免各处各写一遍队列逻辑。
  window.playSongsInApp = function (songs, startIndex, provider, label) {
    var list = (Array.isArray(songs) ? songs : []).map(function (s) { return toPlayableSong(s, provider); })
      .filter(function (s) { return s.id && s.name; });
    if (!list.length) { if (typeof showToast === 'function') showToast('这些曲目缺少可播放的标识'); return; }
    if (typeof playQueueAt !== 'function') { if (typeof showToast === 'function') showToast('内部播放器尚未就绪'); return; }
    playQueue = list;
    currentIdx = Math.max(0, Math.min(list.length - 1, Number(startIndex) || 0));
    if (typeof safeRenderQueuePanel === 'function') safeRenderQueuePanel('mlib-source-' + provider, { scrollCurrent: true });
    if (typeof safeShelfRebuild === 'function') safeShelfRebuild('mlib-source-' + provider, true);
    if (typeof forcePlaybackControlsInteractive === 'function') forcePlaybackControlsInteractive();
    if (typeof showToast === 'function') showToast('交给 MineRadio 播放器：' + list[currentIdx].name);
    Promise.resolve(playQueueAt(currentIdx, {
      manual: true,
      context: { type: 'music-library-source', provider: provider, albumName: label || '' },
    })).catch(function (err) {
      if (typeof showToast === 'function') showToast('播放失败：' + ((err && err.message) || '未知错误'));
    });
  };

  // 用 MineRadio 自有播放器播放一批曲目（非 Apple 源）。
  function playInApp(songs, startIndex, context, provider) {
    var list = (Array.isArray(songs) ? songs : []).map(function (s) { return toPlayableSong(s, provider); })
      .filter(function (s) { return s.id && s.name; });
    if (!list.length) { setStatus('这些曲目缺少可播放的标识，无法播放', 'warn'); return Promise.resolve(false); }
    if (typeof playQueueAt !== 'function') { setStatus('内部播放器尚未就绪', 'warn'); return Promise.resolve(false); }
    setPlayBusy(true);
    setStatus('正在用 MineRadio 播放器播放…');
    playQueue = list;
    currentIdx = Math.max(0, Math.min(list.length - 1, Number(startIndex) || 0));
    if (typeof safeRenderQueuePanel === 'function') safeRenderQueuePanel('mlib-' + provider, { scrollCurrent: true });
    if (typeof safeShelfRebuild === 'function') safeShelfRebuild('mlib-' + provider, true);
    if (typeof forcePlaybackControlsInteractive === 'function') forcePlaybackControlsInteractive();
    return Promise.resolve(playQueueAt(currentIdx, {
      manual: true,
      context: Object.assign({ type: 'music-library-source', provider: provider }, context || {}),
    })).then(function () {
      setPlayBusy(false);
      // 不谎报成功：播放器自己会处理失败与试听提示；这里只说明已交给自有播放器
      setStatus('已交给 MineRadio 播放器：' + list[currentIdx].name, 'ok');
      return true;
    }).catch(function (err) {
      setPlayBusy(false);
      setStatus('播放失败：' + ((err && err.message) || '未知错误'), 'warn');
      return false;
    });
  }
  function setKicker(id, provider, axisLabel) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = sourceLabelOf(provider) + ' · ' + axisLabel;
  }

  function renderInfo(album, songs) {
    setKicker('am-album-detail-kicker', album && album.provider, '资料库专辑');
    var cover = el('am-album-detail-cover');
    if (cover) {
      cover.innerHTML = album.cover
        ? '<img src="' + esc(album.cover) + '" alt="" referrerpolicy="no-referrer">'
        : '';
    }
    var h = el('am-album-detail-heading');
    if (h) { h.textContent = album.name || '未命名专辑'; h.title = album.name || ''; }
    var artist = el('am-album-detail-artist');
    if (artist) artist.textContent = album.artist || '';

    // 资料库专辑接口实测不返回 editorialNotes，所以简介通常为空 -> 整块隐藏。
    // 保留 description / editorialNotes 读取，一旦数据源提供就自动显示。
    var notes = album.editorialNotes;
    var notesText = '';
    if (notes && typeof notes === 'object') notesText = String(notes.standard || notes.short || '');
    else if (typeof notes === 'string') notesText = notes;
    state.descFull = String(album.description || notesText || '').trim();
    var desc = el('am-album-detail-desc');
    var toggle = el('am-album-detail-desc-toggle');
    if (!state.descFull) {
      if (desc) { desc.hidden = true; desc.textContent = ''; desc.classList.remove('expanded'); }
      if (toggle) { toggle.hidden = true; toggle.textContent = '展开简介'; }
      state.descExpanded = false;
    } else {
      if (desc) {
        desc.hidden = false;
        desc.textContent = state.descFull;
        desc.classList.toggle('expanded', state.descExpanded);
      }
      if (toggle) { toggle.hidden = false; toggle.textContent = state.descExpanded ? '收起简介' : '展开简介'; }
    }

    var facts = [];
    var year = fmtYear(album.releaseDate);
    if (year) facts.push('<span>' + esc(year) + '</span>');
    // 曲目数必须等于实际渲染的行数。Apple 的 album.trackCount 是"整张发行版"的曲目数，
    // 而 /me/library/albums/<id>/tracks 只返回资料库里已保存的曲目 —— 两者会不一致
    // （实测 My Dear Melancholy, trackCount=6 但库内只有 2 首，序号 3、6）。
    // 直接显示 trackCount 会让用户看到"6 首"却只有 2 行。
    var libraryCount = state.libraryCount || 0;
    if (libraryCount > 0) facts.push('<span>' + libraryCount + ' 首</span>');
    var totalDur = fmtTotalDuration(songs);
    if (totalDur) facts.push('<span>' + esc(totalDur) + '</span>');
    if (Array.isArray(album.genreNames) && album.genreNames.length) facts.push('<span>' + esc(album.genreNames[0]) + '</span>');
    var factsEl = el('am-album-detail-facts');
    if (factsEl) factsEl.innerHTML = facts.join('');
  }

  // 合并列表：库内曲目在前按 album 序号，catalog 补充曲目按原序号插入位置由调用方决定。
  // 每行都带 source（library / catalog），来源永远可区分。
  // 只渲染资料库实际保存的曲目。不做 Catalog 补全，因此不存在"不可播"的行。
  function renderTracks(songs) {
    var wrap = el('am-album-detail-tracks');
    if (!wrap) return;
    if (!songs.length) {
      wrap.innerHTML = '<div class="am-album-empty">这张专辑在资料库里没有可显示的曲目。</div>';
      wrap.setAttribute('aria-busy', 'false');
      return;
    }
    wrap.innerHTML = songs.map(function (song, i) {
      var key = trackKey(song);
      var playing = key && key === state.playingKey;
      var dur = fmtDuration(song.duration);
      // 序号用接口给的专辑内序号（会跳号，这是正常的），缺失时退回列表位置。
      var no = Number(song.trackNumber) > 0 ? String(song.trackNumber) : String(i + 1);
      return '<div class="am-album-track" role="button" tabindex="0"' +
        ' data-am-track-index="' + i + '"' +
        ' data-playing="' + (playing ? 'true' : 'false') + '"' +
        ' aria-label="' + esc(song.name || '') + '">' +
        '<div class="am-album-track-no">' + esc(no) + '</div>' +
        '<div class="am-album-track-name" title="' + esc(song.name || '') + '">' + esc(song.name || '未命名曲目') + '</div>' +
        '<div class="am-album-track-artist">' + esc(song.artist || '') + '</div>' +
        '<div class="am-album-track-dur">' + esc(dur) + '</div>' +
        '<button class="am-album-track-more" type="button" data-am-track-more="' + i + '"' +
        ' title="在 Apple Music 中播放" aria-label="播放 ' + esc(song.name || '') + '">' +
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">' +
        '<path d="M9 5.5v13l10.5-6.5z"/></svg></button>' +
        '</div>';
    }).join('');
    wrap.setAttribute('aria-busy', 'false');
  }

  function refreshPlayingHighlight() {
    var ctx = null;
    try { ctx = (typeof currentPlaybackContext !== 'undefined') ? currentPlaybackContext : null; } catch (_) { ctx = null; }
    var key = '';
    if (ctx && ctx.provider === 'apple' && ctx.catalogId !== undefined && ctx.catalogId !== null && String(ctx.catalogId) !== '') {
      key = 'c:' + String(ctx.catalogId);
    }
    state.playingKey = key;
    var rows = document.querySelectorAll('#am-album-detail-tracks .am-album-track');
    Array.prototype.forEach.call(rows, function (row) {
      var i = Number(row.getAttribute('data-am-track-index'));
      var rowKey = trackKey(state.songs[i]);
      row.setAttribute('data-playing', (key && rowKey === key) ? 'true' : 'false');
    });
  }

  function albumIdOf(album) {
    return String((album && (album.libraryId || album.id)) || '').trim();
  }

  function renderTracksError(message) {
    var wrap = el('am-album-detail-tracks');
    if (!wrap) return;
    wrap.setAttribute('aria-busy', 'false');
    wrap.innerHTML = '<div class="am-album-error">' + esc(message) +
      '<div><button class="am-album-retry" type="button" onclick="retryAmAlbumDetail()">重试</button></div></div>';
  }

  async function loadAlbum(album) {
    var albumId = albumIdOf(album);
    var seq = ++reqSeq;
    state.album = album;
    state.songs = [];
    state.libraryCount = 0;
    state.descExpanded = false;
    state.descFull = '';
    state.status = 'loading';
    state.playingKey = '';
    setPlayBusy(false);
    setStatus('');
    renderInfo(album, []);
    applyCoverTheme(album.cover);
    var tracks = el('am-album-detail-tracks');
    if (tracks) {
      tracks.setAttribute('aria-busy', 'true');
      tracks.innerHTML = '<div class="am-album-skeleton" style="width:62%"></div>' +
        '<div class="am-album-skeleton" style="width:78%"></div>' +
        '<div class="am-album-skeleton" style="width:54%"></div>';
    }
    if (!albumId) {
      state.status = 'error';
      renderTracksError('这张专辑缺少资料库 ID，无法加载曲目。');
      return;
    }
    // 非 Apple 源：id 带源前缀（ne: / kg:），走该源的取数端点。
    // 不能落到 Apple 端点上 —— 那会拿不到任何曲目，看起来就像"点不开"。
    if (/^(ne|kg|qq):/.test(albumId)) {
      try {
        var isKugouAlbum = /^kg:/.test(albumId);
        var isQQAlbum = /^qq:/.test(albumId);
        var albumTracksUrl = isKugouAlbum
          ? '/api/kugou/library/album/tracks?id=' + encodeURIComponent(albumId)
          : (isQQAlbum
            ? '/api/qq/library/album/tracks?id=' + encodeURIComponent(albumId)
            : '/api/netease/library/album/tracks?id=' + encodeURIComponent(albumId));
        var neData = await apiJson(albumTracksUrl);
        if (seq !== reqSeq) return;
        var neSongs = (neData && Array.isArray(neData.tracks)) ? neData.tracks : [];
        if (neData && neData.error && !neSongs.length) {
          state.status = 'error';
          renderTracksError(neData.message || ('接口返回 ' + neData.error));
          return;
        }
        state.songs = neSongs;
        // 服务端返回的专辑元数据（含**简介**）并入当前专辑对象后重渲染信息区。
        // 列表里的对象只有 name/cover 等，不带简介；不合并的话简介区块永远不显示。
        var neAlbum = (neData && neData.album) || null;
        if (neAlbum) {
          if (neAlbum.description) state.album.description = neAlbum.description;
          if (neAlbum.name) state.album.name = neAlbum.name;
          if (neAlbum.cover) state.album.cover = neAlbum.cover;
          if (neAlbum.artist) state.album.artist = neAlbum.artist;
          // 发行日期：酷狗提供（已归一为 YYYY-MM-DD）、网易云不提供（空串）。
          // 只有真有值才覆盖，避免把列表里可能存在的值抹掉。
          if (neAlbum.releaseDate) state.album.releaseDate = neAlbum.releaseDate;
        }
        renderInfo(state.album, neSongs);
        renderTracks(neSongs);
        var srcName = isKugouAlbum ? '酷狗音乐' : (isQQAlbum ? 'QQ 音乐' : '网易云音乐');
        setStatus(neSongs.length ? '' : '这张专辑在' + srcName + '没有返回曲目。');
        return;
      } catch (err) {
        if (seq !== reqSeq) return;
        state.status = 'error';
        renderTracksError('读取' + (isKugouAlbum ? '酷狗' : (isQQAlbum ? 'QQ 音乐' : '网易云')) + '专辑曲目失败：' + ((err && err.message) || '未知错误'));
        return;
      }
    }
    try {
      // 数据来源始终是本地资料库索引（只含已加入资料库的歌曲）。
      // 白名单内的专辑走重建（本地归组 + catalogId 校验归属），修复关联端点的系统性漏报；
      // 其余专辑走原有 /tracks 端点。详情页本身不触发全量扫描 —— 索引同步由索引接口负责。
      var songs = null;
      var usedRebuild = false;
      var rebuilt = null;
      var hasMore = false;
      var apiMessage = '';
      try {
        rebuilt = await apiJson('/api/apple/library/album/rebuilt?id=' + encodeURIComponent(albumId)
          + '&name=' + encodeURIComponent(album.name || '')
          + '&artist=' + encodeURIComponent(album.artist || ''));
      } catch (_) { rebuilt = null; }
      if (seq !== reqSeq) return;
      if (rebuilt && rebuilt.ok && Array.isArray(rebuilt.verified) && rebuilt.verified.length) {
        songs = rebuilt.verified;
        usedRebuild = true;
      }
      if (!songs) {
        var data = await apiJson('/api/apple/library/album/tracks?id=' + encodeURIComponent(albumId) + '&limit=100');
        if (seq !== reqSeq) return;
        if (data && data.error && !((data.songs || []).length)) {
          state.status = 'error';
          renderTracksError(data.message || ('接口返回 ' + data.error));
          return;
        }
        songs = (data && Array.isArray(data.songs)) ? data.songs : [];
        hasMore = !!(data && data.hasMore);
        apiMessage = (data && data.message) || '';
      }
      state.songs = songs;
      state.libraryCount = songs.length;
      state.status = songs.length ? 'ready' : 'empty';
      // 专辑级元数据（简介/版权）只在重建路径上拿得到 —— 它随归属校验一起返回，不额外请求。
      // 资料库专辑接口本身不返回 editorialNotes，所以这是简介的唯一来源。
      if (!rebuilt || !rebuilt.albumNotes) {
        // 重建没有候选（例如专辑名被本地化且关联端点为空）时，仍尝试用索引里的
        // 「库内专辑 -> catalog 专辑」映射取简介 —— 简介与曲目列表相互独立。
        try {
          var notesRes = await apiJson('/api/apple/library/album/notes?id=' + encodeURIComponent(albumId));
          if (notesRes && notesRes.albumNotes) rebuilt = Object.assign({}, rebuilt || {}, { albumNotes: notesRes.albumNotes });
        } catch (_) { }
      }
      // 简介与曲目列表**相互独立**：只要拿到了文案就用，不要绑定在「是否走了重建路径」上。
      // （原先的条件是 usedRebuild && ...，于是走普通曲目端点的专辑即使文案已取到也会被丢掉。）
      var notes = (rebuilt && rebuilt.albumNotes) || null;
      if (notes) {
        state.album = Object.assign({}, album, {
          // Apple 的 editorialNotes.standard 带 HTML（<b>/<i>/<br>），渲染前去掉标签
          editorialNotes: stripEditorialHtml(notes.editorialNotes) || null,
          copyright: String(notes.copyright || '').trim()
        });
      } else {
        state.album = album;
      }
      renderTracks(songs);
      if (usedRebuild) {
        // 重建成功：如实报告校验结果与未能验证的曲目（不猜归属、不并入）。
        var unv = (rebuilt.unverified || []).length;
        if (unv) {
          setStatus('已按资料库保存的歌曲重建列表（' + songs.length + ' 首）；另有 ' + unv
            + ' 首未能通过身份校验，暂未并入。', 'warn');
        }
        if (rebuilt.confidence && rebuilt.confidence !== 'verified') {
          setStatus('列表已重建（' + songs.length + ' 首），但校验置信度较低：' + rebuilt.confidence, 'warn');
        }
      } else if (hasMore) {
        setStatus('资料库中该专辑曲目较多，当前仅显示前 ' + songs.length + ' 首。', 'warn');
      } else if (apiMessage) {
        setStatus(apiMessage, 'warn');
      }
      refreshPlayingHighlight();
    } catch (err) {
      if (seq !== reqSeq) return;
      state.status = 'error';
      renderTracksError('读取专辑曲目失败：' + ((err && err.message) || '未知错误'));
    }
  }

  function modelFor(song) {
    return {
      provider: 'apple',
      catalogId: song.catalogId,
      name: String(song.name || ''),
      artist: String(song.artist || ''),
      albumName: String(song.albumName || song.album || (state.album && state.album.name) || ''),
      cover: String(song.cover || (state.album && state.album.cover) || ''),
      storefront: String(song.storefront || 'us'),
      durationMs: Number(song.durationMs) || 0
    };
  }

  function playSongAt(index) {
    // 曲目行 = 播这一首：搜索曲目名 -> 强制切「你的资料库」-> 认「歌曲」分区并取第一个候选 -> 点播放 -> SMTC 判定。
    // 专辑按钮仍走 playAmAlbumFromStart：那是播整张专辑，从第 1 首开始，语义不同。
    if (state.playBusy) return;
    var album = state.album || {};
    var song = (state.songs && state.songs[index]) || null;
    var trackName = String((song && song.name) || '').trim();
    if (!trackName) { setStatus('这首曲目没有可用的名称', 'warn'); return; }
    // 非 Apple 源：走 MineRadio 自有播放器，不碰 UIA
    if (isNonAppleSource(album.provider)) {
      playInApp(state.songs, index, { albumName: String(album.name || '') }, album.provider);
      return;
    }
    var amc = window.mineradio && window.mineradio.amc;
    if (!amc || typeof amc.playAlbum !== 'function') { setStatus('Apple Music 播放通道不可用', 'warn'); return; }
    setPlayBusy(true);
    setStatus('正在让 Apple Music 播放：' + trackName + '…', '');
    Promise.resolve(amc.playAlbum({ name: String(album.name || ''), track: trackName, scopeLabel: '你的资料库', sectionLabel: '专辑' })).then(function (res) {
      setPlayBusy(false);
      var stage = (res && res.stage) || 'NO_RESULT';
      if (res && res.verified) setStatus('✓ Apple Music 已开始播放：' + trackName, 'ok');
      else if (stage === 'PLAYLIST_NOT_FOUND') setStatus('Apple Music 资料库里没找到：' + trackName, 'warn');
      else if (stage === 'SCOPE_CHIP_NOT_FOUND') setStatus('找不到 Apple Music 的「你的资料库」范围按钮，已中止播放', 'warn');
      else if (stage === 'SCOPE_SWITCH_FAILED') setStatus('未能切入 Apple Music「你的资料库」范围，已中止播放', 'warn');
      else if (stage === 'TRACK_ROW_NOT_FOUND') setStatus('这首歌在 Apple Music 页面里没能被 UI 定位到，已改为播放整张专辑', 'warn');
      else if (stage === 'TRACK_CLICKED_UNVERIFIED') setStatus('已点中该曲目行，但 SMTC 未确认切歌（可能仍停在别的曲目）', 'warn');
      else setStatus('Apple Music 播放失败：' + stage, 'warn');
    }).catch(function () { setPlayBusy(false); setStatus('Apple Music 播放失败（IPC 错误）', 'warn'); });
  }

  window.playAmAlbumFromStart = function () {
    if (state.playBusy) return;
    var album = state.album || {};
    var name = String(album.name || '').trim();
    if (!name) { setStatus('这张专辑没有可用的名称', 'warn'); return; }
    // 非 Apple 源：整张专辑从第 1 首开始，走 MineRadio 自有播放器
    if (isNonAppleSource(album.provider)) {
      playInApp(state.songs, 0, { albumName: name }, album.provider);
      return;
    }
    // 与音乐库卡片同一个入口：交给 AMC 的资料库专辑链（先强制切到「你的资料库」，
    // 再按「专辑」分区消歧，最后才点播放）。音乐库模式下单曲不单独走一条通道。
    var amc = window.mineradio && window.mineradio.amc;
    if (!amc || typeof amc.playAlbum !== 'function') { setStatus('Apple Music 播放通道不可用', 'warn'); return; }
    setPlayBusy(true);
    setStatus('正在让 Apple Music 播放这张专辑…', '');
    Promise.resolve(amc.playAlbum({ name: name, scopeLabel: '你的资料库', sectionLabel: '专辑' })).then(function (res) {
      setPlayBusy(false);
      var stage = (res && res.stage) || 'NO_RESULT';
      if (res && res.verified) { state.playingKey = ''; setStatus('✓ Apple Music 已开始播放这张专辑', 'ok'); }
      else if (stage === 'AMBIGUOUS') setStatus('资料库里有多个同名专辑，无法确定播哪一个', 'warn');
      else if (stage === 'PLAYLIST_NOT_FOUND') setStatus('Apple Music 资料库里没找到这张专辑', 'warn');
      else if (stage === 'SCOPE_CHIP_NOT_FOUND') setStatus('找不到 Apple Music 的「你的资料库」范围按钮，已中止播放', 'warn');
      else if (stage === 'SCOPE_SWITCH_FAILED') setStatus('未能切入 Apple Music「你的资料库」范围，已中止播放（不会去目录里找同名专辑）', 'warn');
      else setStatus('Apple Music 播放失败：' + stage, 'warn');
    }).catch(function () { setPlayBusy(false); setStatus('Apple Music 播放失败（IPC 错误）', 'warn'); });
  };

  window.toggleAmAlbumDescription = function () {
    if (!state.descFull) return;
    state.descExpanded = !state.descExpanded;
    var desc = el('am-album-detail-desc');
    var toggle = el('am-album-detail-desc-toggle');
    if (desc) desc.classList.toggle('expanded', state.descExpanded);
    if (toggle) toggle.textContent = state.descExpanded ? '收起简介' : '展开简介';
  };

  window.retryAmAlbumDetail = function () {
    if (state.album) loadAlbum(state.album);
  };

  window.closeAmAlbumDetail = function () {
    var mask = maskEl();
    if (!mask) return;
    closeGsapModal(mask, function () {
      ['--am-theme-a', '--am-theme-b', '--am-theme-light', '--am-theme-dark', '--am-theme-glow'].forEach(function (k) {
        mask.style.removeProperty(k);
      });
      state.status = 'idle';
      state.playingKey = '';
    });
  };

  window.openAmAlbumDetail = function (album) {
    if (!album) return;
    var mask = maskEl();
    if (!mask) return;
    try { if (typeof immersiveMode !== 'undefined' && immersiveMode && typeof setImmersiveMode === 'function') setImmersiveMode(false); } catch (_) { }
    state.descExpanded = false;
    state.playingKey = '';
    state.songs = [];
    var scroll = el('am-album-detail-scroll');
    if (scroll) scroll.scrollTop = 0;
    openGsapModal(mask);
    loadAlbum(album);
  };

  function bindTracks() {
    var wrap = el('am-album-detail-tracks');
    if (!wrap || wrap.dataset.amAlbumBound === '1') return;
    wrap.dataset.amAlbumBound = '1';
    wrap.addEventListener('click', function (event) {
      var t = event.target;
      if (!t || !t.closest) return;
      var more = t.closest('[data-am-track-more]');
      if (more) {
        event.preventDefault();
        event.stopPropagation();
        playSongAt(Number(more.getAttribute('data-am-track-more')));
        return;
      }
      var row = t.closest('.am-album-track');
      if (!row || !wrap.contains(row)) return;
      event.preventDefault();
      playSongAt(Number(row.getAttribute('data-am-track-index')));
    });
    wrap.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var row = event.target && event.target.closest ? event.target.closest('.am-album-track') : null;
      if (!row) return;
      event.preventDefault();
      playSongAt(Number(row.getAttribute('data-am-track-index')));
    });
  }

  function init() {
    bindTracks();
    plInit();
    var mask = maskEl();
    if (mask) {
      mask.addEventListener('click', function (event) {
        if (event.target === mask) window.closeAmAlbumDetail();
      });
    }
  }

  // ============================================================
  // 歌单详情（与专辑详情同构）
  //
  // 数据来自**已存在**的只读接口 /api/apple/playlist/tracks；
  // 播放复用**已存在**的 amc.playPlaylist（歌单链，按名字 + 资料库作用域定位）。
  // 这里不新增任何 IPC、不新增样式（复用 .am-album-* 的度量）。
  // ============================================================
  var PL_MODAL_ID = 'am-playlist-detail-modal';
  var plSeq = 0;
  var plState = { playlist: null, tracks: [], status: 'idle', busy: false };

  function plEl(id) { return document.getElementById(id); }
  function plMask() { return plEl(PL_MODAL_ID); }

  function plSetStatus(text, tone) {
    var node = plEl('am-playlist-detail-status');
    if (!node) return;
    if (!text) { node.hidden = true; node.textContent = ''; node.removeAttribute('data-tone'); return; }
    node.hidden = false;
    node.textContent = text;
    if (tone) node.setAttribute('data-tone', tone); else node.removeAttribute('data-tone');
  }

  function plSetBusy(busy) {
    plState.busy = !!busy;
    var btn = plEl('am-playlist-detail-play');
    if (btn) { btn.disabled = !!busy; btn.setAttribute('aria-busy', busy ? 'true' : 'false'); }
    // 随机按钮同样受忙碌态约束，避免重复触发
    var sh = plEl('am-playlist-detail-shuffle');
    if (sh) { sh.disabled = !!busy; sh.setAttribute('aria-busy', busy ? 'true' : 'false'); }
  }

  function plRenderInfo(playlist) {
    var cover = plEl('am-playlist-detail-cover');
    if (cover) {
      cover.innerHTML = playlist.cover
        ? '<img src="' + esc(playlist.cover) + '" alt="" referrerpolicy="no-referrer">'
        : '';
    }
    setKicker('am-playlist-detail-kicker', playlist.provider, playlist.isLiked ? '个人库 · 喜欢的音乐' : '个人库歌单');
    var h = plEl('am-playlist-detail-heading');
    if (h) { h.textContent = playlist.name || '未命名歌单'; h.title = playlist.name || ''; }
    var creator = plEl('am-playlist-detail-creator');
    if (creator) creator.textContent = playlist.creator || 'Apple Music';
    var facts = [];
    // 曲目数只报**实际读到的行数**，不猜测；Apple 的资料库歌单接口不返回总曲目数。
    if (plState.tracks.length) facts.push('<span>' + plState.tracks.length + ' 首</span>');
    var total = fmtTotalDuration(plState.tracks);
    if (total) facts.push('<span>' + esc(total) + '</span>');
    var factsEl = plEl('am-playlist-detail-facts');
    if (factsEl) factsEl.innerHTML = facts.join('');
  }

  function plRenderTracks(tracks) {
    var wrap = plEl('am-playlist-detail-tracks');
    if (!wrap) return;
    if (!tracks.length) {
      wrap.innerHTML = '<div class="am-album-empty">这个歌单里没有可显示的曲目。</div>';
      wrap.setAttribute('aria-busy', 'false');
      return;
    }
    wrap.innerHTML = tracks.map(function (track, i) {
      var dur = fmtDuration(track.duration);
      return '<div class="am-album-track" role="button" tabindex="0"' +
        ' data-am-pl-track-index="' + i + '"' +
        ' aria-label="' + esc(track.name || '') + '">' +
        '<div class="am-album-track-no">' + String(i + 1) + '</div>' +
        '<div class="am-album-track-name" title="' + esc(track.name || '') + '">' + esc(track.name || '未命名曲目') + '</div>' +
        '<div class="am-album-track-artist">' + esc(track.artist || '') + '</div>' +
        '<div class="am-album-track-dur">' + esc(dur) + '</div>' +
        '<button class="am-album-track-more" type="button" data-am-pl-track-more="' + i + '"' +
        ' title="在 Apple Music 中播放" aria-label="播放 ' + esc(track.name || '') + '">' +
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">' +
        '<path d="M9 5.5v13l10.5-6.5z"/></svg></button>' +
        '</div>';
    }).join('');
    wrap.setAttribute('aria-busy', 'false');
  }

  // 歌单播放：沿用 amc.playPlaylist（歌单链）。SMTC 确认才算成功，不把"点了"当"在播"。
  function plPlay(what, startIndex) {
    var playlist = plState.playlist || {};
    var name = String(playlist.name || '').trim();
    if (!name) { plSetStatus('这个歌单没有可用的名称', 'warn'); return; }
    // 非 Apple 源：走 MineRadio 自有播放器，不碰 UIA。
    // 之前这里一律调 amc.playPlaylist，网易云歌单会得到「Apple Music 资料库里没找到这个歌单」。
    if (isNonAppleSource(playlist.provider)) {
      if (!plState.tracks.length) { plSetStatus('这个歌单还没有可播放的曲目', 'warn'); return; }
      return playPlaylistInApp(plState.tracks, startIndex || 0, name, playlist.provider);
    }
    var amc = window.mineradio && window.mineradio.amc;
    if (!amc || typeof amc.playPlaylist !== 'function') {
      plSetStatus('Apple Music 播放通道不可用', 'warn');
      return;
    }
    var url = String(playlist.appleUrl || '').trim();
    var payload = { name: name };
    if (url) payload.url = url;
    else payload.scopeLabel = '你的资料库';
    plSetBusy(true);
    plSetStatus('正在让 Apple Music 播放' + what + '…', '');
    return Promise.resolve(amc.playPlaylist(payload)).then(function (res) {
      plSetBusy(false);
      var stage = (res && res.stage) || 'NO_RESULT';
      if (res && res.verified) plSetStatus('✓ Apple Music 已开始播放' + what, 'ok');
      else if (stage === 'AMBIGUOUS') plSetStatus('资料库里有多个同名歌单，无法确定播哪一个', 'warn');
      else if (stage === 'PLAYLIST_NOT_FOUND') plSetStatus('Apple Music 资料库里没找到这个歌单', 'warn');
      else if (stage === 'SCOPE_NOT_VERIFIED') plSetStatus('未能切入 Apple Music「你的资料库」范围，已中止播放（不会去目录里找同名歌单）', 'warn');
      else if (stage === 'SCOPE_CHIP_NOT_FOUND') plSetStatus('找不到 Apple Music 的「你的资料库」范围按钮，已中止播放', 'warn');
      else plSetStatus('Apple Music 播放失败：' + stage, 'warn');
    }).catch(function () {
      plSetBusy(false);
      plSetStatus('Apple Music 播放失败（IPC 错误）', 'warn');
    });
  }

  function plLoad(playlist) {
    var id = String(playlist.id || '').trim();
    var seq = ++plSeq;
    plState.playlist = playlist;
    plState.tracks = [];
    plState.status = 'loading';
    plSetBusy(false);
    plSetStatus('');
    plRenderInfo(playlist);
    // 关键：主题取色必须指定歌单弹窗，否则变量会被写到专辑弹窗上，
    // 歌单这边永远只剩 CSS 的深色默认值（渐变就没了）。
    applyCoverTheme(playlist.cover, plMask());
    var wrap = plEl('am-playlist-detail-tracks');
    if (wrap) {
      wrap.setAttribute('aria-busy', 'true');
      wrap.innerHTML = '<div class="am-album-skeleton" style="width:62%"></div>' +
        '<div class="am-album-skeleton" style="width:78%"></div>' +
        '<div class="am-album-skeleton" style="width:54%"></div>';
    }
    if (!id) {
      plState.status = 'error';
      if (wrap) { wrap.innerHTML = '<div class="am-album-empty">这个歌单缺少 ID，无法加载曲目。</div>'; wrap.setAttribute('aria-busy', 'false'); }
      return;
    }
    var done = function (tracks) {
      if (seq !== plSeq) return;              // 旧请求不得覆盖新歌单
      plState.tracks = tracks;
      plState.status = tracks.length ? 'ready' : 'empty';
      plRenderTracks(tracks);
      plRenderInfo(plState.playlist);
    };
    var fail = function (message) {
      if (seq !== plSeq) return;
      plState.status = 'error';
      if (wrap) { wrap.innerHTML = '<div class="am-album-empty">' + esc(message) + '</div>'; wrap.setAttribute('aria-busy', 'false'); }
    };
    // 按源取曲目：
    //   Apple   -> /api/apple/playlist/tracks?all=1（单页上限 100，必须分页取全）
    //   非 Apple -> 走该源自己的端点。**不能落到 Apple 端点上** ——
    //              截图里那句「Apple Music Web 返回 HTTP 404」就是这么来的。
    // 按源取曲目。酷狗的歌单浏览尚未接入（playlistTracks 为 null）——如实说明，
    // 不能悄悄落到 Apple 端点上（那会得到「Apple Music Web 返回 HTTP 404」）。
    var prov = String(playlist.provider || '');
    var isNetease = /^ne:/.test(id) || prov === 'netease';
    var isKugou = /^kg:/.test(id) || prov === 'kugou';
    var isQQ = /^qq:/.test(id) || prov === 'qq';
    // 酷狗：走自己的端点按歌单原始顺序取全（内部逐页取全，实测 475/475）。
    // 不用 /api/playlist/tracks 是因为那个端点额外做了"最近添加在前"的排序与适配，
    // 而歌单详情应当保持歌单自身顺序。
    var url = isKugou
      ? '/api/kugou/library/playlist/tracks?id=' + encodeURIComponent(id.replace(/^kg:/, ''))
      : (isQQ
        ? '/api/qq/library/playlist/tracks?id=' + encodeURIComponent(id.replace(/^qq:/, ''))
        : (isNetease
          ? '/api/playlist/tracks?id=' + encodeURIComponent(id.replace(/^ne:/, ''))
          : '/api/apple/playlist/tracks?id=' + encodeURIComponent(id) + '&all=1'));
    apiJson(url).then(function (data) {
      if (seq !== plSeq) return;
      var tracks = (data && Array.isArray(data.tracks)) ? data.tracks : [];
      if (data && data.error && !tracks.length) { fail(data.message || ('接口返回 ' + data.error)); return; }
      // 链路自己报了截断才提示，不静默丢歌
      if (data && data.truncated) plSetStatus('这个歌单曲目较多，已显示前 ' + tracks.length + ' 首', 'warn');
      done(tracks);
    }).catch(function (err) {
      fail('读取歌单曲目失败：' + ((err && err.message) || '未知错误'));
    });
  }

  window.openAmPlaylistDetail = function (playlist) {
    if (!playlist) return;
    var mask = plMask();
    if (!mask) return;
    try { if (typeof immersiveMode !== 'undefined' && immersiveMode && typeof setImmersiveMode === 'function') setImmersiveMode(false); } catch (_) { }
    var scroll = plEl('am-playlist-detail-scroll');
    if (scroll) scroll.scrollTop = 0;
    openGsapModal(mask);
    plLoad(playlist);
  };

  window.closeAmPlaylistDetail = function () {
    var mask = plMask();
    if (mask) closeGsapModal(mask);
  };

  // 随机播放入口。**真正的随机播放行为由 UIA 侧实现** —— 这里只负责触发，
  // 并把"点击发生了"如实反馈到状态区（不谎报已开始播放）。
  window.playAmPlaylistShuffled = function () {
    var name = String((plState.playlist && plState.playlist.name) || '').trim();
    if (!name) { plSetStatus('这个歌单没有可用的名称', 'warn'); return; }
    // 非 Apple 源：随机播放同样走 MineRadio 自有播放器，**不碰 UIA**。
    // "随机"由我们自己在本地打乱曲序实现（UIA 那条通道只对 Apple 有效）。
    var plProv = String((plState.playlist && plState.playlist.provider) || 'apple');
    if (isNonAppleSource(plProv)) {
      var list = (plState.tracks || []).slice();
      if (!list.length) { plSetStatus('这个歌单还没有可播放的曲目', 'warn'); return; }
      for (var i = list.length - 1; i > 0; i -= 1) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
      }
      plSetStatus('正在随机播放…', '');
      playInApp(list, 0, { playlistName: name, shuffled: true }, plProv);
      return;
    }
    var amc = window.mineradio && window.mineradio.amc;
    if (!amc || typeof amc.playPlaylistShuffled !== 'function') {
      plSetStatus('随机播放通道尚未接入', 'warn');
      return;
    }
    plSetBusy(true);
    plSetStatus('正在让 Apple Music 随机播放…', '');
    Promise.resolve(amc.playPlaylistShuffled({ name: name })).then(function (res) {
      plSetBusy(false);
      if (res && res.verified) plSetStatus('✓ Apple Music 已开始随机播放', 'ok');
      else plSetStatus('随机播放未完成：' + ((res && res.stage) || 'NO_RESULT'), 'warn');
    }).catch(function () {
      plSetBusy(false);
      plSetStatus('随机播放失败（IPC 错误）', 'warn');
    });
  };

  window.playAmPlaylistFromStart = function () { return plPlay('这个歌单'); };

  function plBindTracks() {
    var wrap = plEl('am-playlist-detail-tracks');
    if (!wrap || wrap.dataset.amPlaylistBound === '1') return;
    wrap.dataset.amPlaylistBound = '1';
    wrap.addEventListener('click', function (event) {
      var t = event.target;
      if (!t || !t.closest) return;
      var more = t.closest('[data-am-pl-track-more]');
      var row = more || t.closest('.am-album-track');
      if (!row || !wrap.contains(row)) return;
      event.preventDefault();
      // 非 Apple 源：真正的逐曲播放（自有播放器可以指定起始曲目）。
      if (isNonAppleSource((plState.playlist || {}).provider)) {
        var idx = Array.prototype.indexOf.call(wrap.querySelectorAll('.am-album-track'), row);
        plPlay('这个歌单', idx >= 0 ? idx : 0);
        return;
      }
      // Apple 侧：进入该歌单后从第一首开始，这里不谎称"播的就是这一首"—— 只如实告知入口。
      plPlay('这个歌单');
    });
    wrap.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var row = event.target && event.target.closest ? event.target.closest('.am-album-track') : null;
      if (!row) return;
      event.preventDefault();
      plPlay('这个歌单');
    });
  }

  function plInit() {
    plBindTracks();
    var mask = plMask();
    if (mask) {
      mask.addEventListener('click', function (event) {
        if (event.target === mask) window.closeAmPlaylistDetail();
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();