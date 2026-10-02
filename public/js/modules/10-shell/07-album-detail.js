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

  function clearTheme() {
    var modal = maskEl();
    if (!modal) return;
    ['--am-theme-a', '--am-theme-b', '--am-theme-light', '--am-theme-dark', '--am-theme-glow'].forEach(function (k) {
      modal.style.removeProperty(k);
    });
  }

  function applyThemeVars(r, g, b) {
    var modal = maskEl();
    if (!modal) return;
    var v = rgbVars(r, g, b);
    modal.style.setProperty('--am-theme-a', v.a);
    modal.style.setProperty('--am-theme-b', v.a);
    modal.style.setProperty('--am-theme-light', v.light);
    modal.style.setProperty('--am-theme-dark', v.dark);
    modal.style.setProperty('--am-theme-glow', v.glow);
  }

  function applyCoverTheme(coverUrl) {
    clearTheme();
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
          applyThemeVars(Math.round(best.r), Math.round(best.g), Math.round(best.b));
        } else if (fallbackN) {
          applyThemeVars(
            Math.round(fallbackR / fallbackN),
            Math.round(fallbackG / fallbackN),
            Math.round(fallbackB / fallbackN)
          );
        }
      } catch (_) { /* 取色失败 -> CSS 深色默认值 */ }
    };
    img.onerror = function () { clearTheme(); };   // 封面失败 -> 深色降级
    img.src = coverUrl;
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

  function renderInfo(album, songs) {
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
      if (usedRebuild && rebuilt.albumNotes) {
        state.album = Object.assign({}, album, {
          editorialNotes: rebuilt.albumNotes.editorialNotes || null,
          copyright: rebuilt.albumNotes.copyright || ''
        });
      } else {
        state.album = album;
      }
      renderInfo(state.album, songs);
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
    // 音乐库模式下曲目行也走**资料库专辑链**：先强制切到「你的资料库」，再按「专辑」分区消歧播放整张专辑。
    // 不再走单曲通道（playAmcTrackFromSong）：音乐库播放只有一条语义 —— 让 Apple Music 播放这张专辑。
    if (state.playBusy) return;
    var album = state.album || {};
    var song = (state.songs && state.songs[index]) || null;
    var name = String(album.name || '').trim();
    if (!name) { setStatus('这张专辑没有可用的名称', 'warn'); return; }
    var amc = window.mineradio && window.mineradio.amc;
    if (!amc || typeof amc.playAlbum !== 'function') { setStatus('Apple Music 播放通道不可用', 'warn'); return; }
    setPlayBusy(true);
    setStatus('正在让 Apple Music 播放这张专辑…', '');
    Promise.resolve(amc.playAlbum({ name: name, scopeLabel: '你的资料库', sectionLabel: '专辑' })).then(function (res) {
      setPlayBusy(false);
      var stage = (res && res.stage) || 'NO_RESULT';
      var picked = (res && res.pickedName) ? res.pickedName : name;
      if (res && res.verified) {
        setStatus('✓ Apple Music 已开始播放这张专辑' + (song && song.name ? '（曲目行「' + song.name + '」在音乐库模式下按整张专辑播放）' : ''), 'ok');
      } else if (stage === 'AMBIGUOUS') setStatus('资料库里有多个同名专辑，无法确定播哪一个', 'warn');
      else if (stage === 'PLAYLIST_NOT_FOUND') setStatus('Apple Music 资料库里没找到：' + name, 'warn');
      else if (stage === 'SCOPE_CHIP_NOT_FOUND') setStatus('找不到 Apple Music 的「你的资料库」范围按钮，已中止播放', 'warn');
      else if (stage === 'SCOPE_SWITCH_FAILED') setStatus('未能切入 Apple Music「你的资料库」范围，已中止播放（不会去目录里找同名专辑）', 'warn');
      else setStatus('Apple Music 播放失败：' + stage + (picked && picked !== name ? '（选中：' + picked + '）' : ''), 'warn');
    }).catch(function () { setPlayBusy(false); setStatus('Apple Music 播放失败（IPC 错误）', 'warn'); });
  }

  window.playAmAlbumFromStart = function () {
    if (state.playBusy) return;
    var album = state.album || {};
    var name = String(album.name || '').trim();
    if (!name) { setStatus('这张专辑没有可用的名称', 'warn'); return; }
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
    var mask = maskEl();
    if (mask) {
      mask.addEventListener('click', function (event) {
        if (event.target === mask) window.closeAmAlbumDetail();
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();