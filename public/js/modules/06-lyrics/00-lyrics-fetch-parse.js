function hasUsableLyricLines(lines) {
  return (Array.isArray(lines) ? lines : []).some(function (line) {
    return line && !line.fallback && !isNoLyricText(line.text);
  });
}
var lyricTranslationFallbackCache = {};
var lyricTranslationFallbackMissCache = {};
var lyricQueuePrefetchTimer = 0;
var lyricQueuePrefetchToken = 0;
var lyricQueuePrefetchBusy = false;
var lyricQueuePrefetchKeys = {};
function lyricTranslationTextFromAliases(source) {
  source = source || {};
  return source.tlyric || source.trans || source.translatedLyric || source.translation || source.translated_lyric || '';
}
function lyricEndpointForSong(songOrId) {
  var song = (songOrId && typeof songOrId === 'object') ? songOrId : null;
  var provider = song ? songProviderKey(song) : 'netease';
  if (provider === 'qq') {
    var mid = song.mid || song.songmid || song.id || '';
    var qqId = song.qqId || (/^\d+$/.test(String(song.id || '')) ? song.id : '');
    return '/api/qq/lyric?mid=' + encodeURIComponent(mid) + '&id=' + encodeURIComponent(qqId);
  }
  if (provider === 'kugou') {
    return '/api/kugou/lyric?hash=' + encodeURIComponent(song.hash || song.fileHash || song.audioHash || song.id || '') +
      '&albumAudioId=' + encodeURIComponent(song.albumAudioId || song.album_audio_id || song.mixSongId || '') +
      '&duration=' + encodeURIComponent(playbackDurationFromSong(song) || '');
  }
  if (provider === 'qishui') {
    return '/api/qishui/lyric?id=' + encodeURIComponent(song.id || song.providerSongId || '');
  }
  if (provider === 'spotify') {
    return '/api/spotify/lyric?id=' + encodeURIComponent(song.id || song.providerSongId || song.spotifyId || '');
  }
  if (provider === 'apple') {
    return '/api/apple/lyric?id=' + encodeURIComponent(song.id || song.providerSongId || song.appleId || '');
  }
  var songId = song ? song.id : songOrId;
  return '/api/lyric?id=' + encodeURIComponent(songId);
}

function persistentLyricCacheKey(song) {
  song = song || {};
  var provider = typeof songProviderKey === 'function' ? songProviderKey(song) : (song.source || song.provider || 'netease');
  var id = song.id || song.mid || song.songmid || song.hash || '';
  var artist = song.artist || song.singer || song.artists || '';
  return ['lyrics-v1', provider, id, song.name || song.title || '', artist].join('|');
}

function readPersistentLyricCache(song) {
  if (!window.desktopWindow || typeof window.desktopWindow.readLyricCache !== 'function') return Promise.resolve(null);
  return window.desktopWindow.readLyricCache(persistentLyricCacheKey(song)).then(function (result) {
    return result && result.ok && result.hit && result.payload ? result.payload : null;
  }).catch(function () { return null; });
}

function writePersistentLyricCache(song, payload) {
  if (!window.desktopWindow || typeof window.desktopWindow.writeLyricCache !== 'function' || !payload || typeof payload !== 'object') return;
  window.desktopWindow.writeLyricCache(persistentLyricCacheKey(song), payload).catch(function () {});
}

function lyricQueuePrefetchCandidate(song) {
  if (!song || song.type === 'podcast' || song.type === 'local' || song.source === 'local' || song.localUrl) return false;
  return !!(song.id || song.mid || song.songmid || song.hash || song.name || song.title);
}

function nextQueueLyricPrefetchSong(fromIndex) {
  if (!Array.isArray(playQueue) || playQueue.length < 2) return null;
  var total = playQueue.length;
  var from = isFinite(Number(fromIndex)) ? Math.round(Number(fromIndex)) : currentIdx;
  for (var step = 1; step < total; step++) {
    var index = (from + step + total) % total;
    if (index === currentIdx) continue;
    var song = playQueue[index];
    if (!lyricQueuePrefetchCandidate(song)) continue;
    var key = persistentLyricCacheKey(song);
    if (!key || lyricQueuePrefetchKeys[key]) continue;
    return { song: song, key: key };
  }
  return null;
}

function scheduleQueueLyricPrefetch(fromIndex, delay) {
  if (lyricQueuePrefetchTimer) clearTimeout(lyricQueuePrefetchTimer);
  lyricQueuePrefetchTimer = 0;
  if (lyricQueuePrefetchBusy || !Array.isArray(playQueue) || playQueue.length < 2) return false;
  var token = ++lyricQueuePrefetchToken;
  var wait = Math.max(1200, Number(delay) || 2400);
  lyricQueuePrefetchTimer = setTimeout(function () {
    lyricQueuePrefetchTimer = 0;
    runQueueLyricPrefetch(fromIndex, token);
  }, wait);
  return true;
}

async function runQueueLyricPrefetch(fromIndex, token) {
  if (token !== lyricQueuePrefetchToken || lyricQueuePrefetchBusy) return false;
  if (audio && audio.paused) return false;
  var candidate = nextQueueLyricPrefetchSong(fromIndex);
  if (!candidate) return false;
  lyricQueuePrefetchKeys[candidate.key] = true;
  lyricQueuePrefetchBusy = true;
  try {
    var cached = await readPersistentLyricCache(candidate.song);
    if (token !== lyricQueuePrefetchToken) return false;
    if (cached) return true;
    var response = await apiJson(lyricEndpointForSong(candidate.song));
    if (token !== lyricQueuePrefetchToken) return false;
    var merged = mergeInlineLyricResponseForSong(candidate.song, response || {});
    var state = parseLyricResponseToOriginalState(candidate.song, merged);
    if (!state || !state.usableLyric) return false;
    writePersistentLyricCache(candidate.song, merged);
    return true;
  } catch (_) {
    return false;
  } finally {
    lyricQueuePrefetchBusy = false;
  }
}

function applyFetchedLyricResponse(song, token, response, options) {
  options = options || {};
  if (token !== trackSwitchToken) return null;
  var mergedResponse = mergeInlineLyricResponseForSong(song, response || {});
  cancelPendingTrackFallbackLyrics();
  var state = parseLyricResponseToOriginalState(song, mergedResponse);
  setOriginalLyricsState(state.lines, state.hasNativeKaraoke, state.timingSource, state.translationLines, state.translationSource);
  applyPreferredLyricsForCurrent(true);
  scheduleNeteaseLyricTranslationFallback(song, token, state);
  if (state.usableLyric && options.persist !== false) writePersistentLyricCache(song, mergedResponse);
  return state;
}

function refreshPersistentLyricCache(song) {
  apiJson(lyricEndpointForSong(song)).then(function (response) {
    var mergedResponse = mergeInlineLyricResponseForSong(song, response || {});
    var state = parseLyricResponseToOriginalState(song, mergedResponse);
    if (state && state.usableLyric) writePersistentLyricCache(song, mergedResponse);
  }).catch(function () {});
}
function mergeInlineLyricResponseForSong(song, response) {
  response = Object.assign({}, response || {});
  if (!response.tlyric) response.tlyric = lyricTranslationTextFromAliases(response);
  if (!song || typeof song !== 'object') return response;
  if (!response.lyric && song.lyric) response.lyric = song.lyric;
  if (!response.tlyric) response.tlyric = lyricTranslationTextFromAliases(song);
  if (!response.yrc && (song.yrc || song.qrc)) response.yrc = song.yrc || song.qrc;
  if (!response.ytlrc && song.ytlrc) response.ytlrc = song.ytlrc;
  return response;
}
function lyricTranslationFallbackKey(song) {
  song = song || {};
  return [
    simpleSearchNorm(song.name || song.title || ''),
    simpleSearchNorm(song.artist || ''),
    simpleSearchNorm(song.album || '')
  ].join('|');
}
function shouldFetchNeteaseLyricTranslationFallback(song, state) {
  if (!song || !state || !state.usableLyric) return false;
  if (song.type === 'local' || song.source === 'local' || song.localUrl || song.type === 'podcast') return false;
  if (songProviderKey(song) === 'netease') return false;
  if (state.translationLines && state.translationLines.length) return false;
  if (!String(song.name || song.title || '').trim()) return false;
  var key = lyricTranslationFallbackKey(song);
  var missedAt = lyricTranslationFallbackMissCache[key] || 0;
  return !missedAt || Date.now() - missedAt > 10 * 60 * 1000;
}
function lyricNeteaseFallbackSearchQuery(song) {
  song = song || {};
  var artist = String(song.artist || '').split(/\s*\/\s*|\s*,\s*|\s*&\s*/)[0] || '';
  return [song.name || song.title || '', artist].filter(Boolean).join(' ').trim();
}
async function findNeteaseLyricFallbackCandidate(song) {
  var query = lyricNeteaseFallbackSearchQuery(song);
  if (!query) return null;
  var data = await apiJson('/api/search?keywords=' + encodeURIComponent(query) + '&limit=8', { timeoutMs: 4800 });
  var list = data && (data.songs || data.result || []);
  if (!Array.isArray(list) || !list.length) return null;
  list = list.filter(function (candidate) {
    return !(typeof sourceCandidateRejectReason === 'function' && sourceCandidateRejectReason(song, candidate, 'netease'));
  });
  if (!list.length) return null;
  for (var i = 0; i < list.length; i++) {
    if (typeof isSameTitleArtist === 'function' && isSameTitleArtist(song, list[i])) return list[i];
  }
  list = list.slice().sort(function (a, b) {
    var sa = typeof scoreSongSearchResult === 'function' ? scoreSongSearchResult(a, query, 0) : 0;
    var sb = typeof scoreSongSearchResult === 'function' ? scoreSongSearchResult(b, query, 0) : 0;
    if (a && a.playable === false) sa -= 20;
    if (b && b.playable === false) sb -= 20;
    return sb - sa;
  });
  var best = list[0];
  var bestScore = typeof scoreSongSearchResult === 'function' ? scoreSongSearchResult(best, query, 0) : 0;
  return best && best.id && bestScore >= 28 ? best : null;
}
function mergeNeteaseFallbackTranslationsIntoCurrent(song, token, payload, cacheKey) {
  if (!payload || !payload.lines || !payload.lines.length) return false;
  if (token !== trackSwitchToken) return false;
  var currentSong = typeof currentLyricSong === 'function' ? currentLyricSong() : null;
  if (lyricTranslationFallbackKey(currentSong) !== cacheKey) return false;
  if (originalLyricsState && originalLyricsState.translationLines && originalLyricsState.translationLines.length) return false;
  var mergedLines = attachLyricTranslations(originalLyricsState.lines || [], payload.lines);
  var attached = mergedLines.some(function (line) { return line && line.translation; });
  if (!attached) return false;
  setOriginalLyricsState(
    mergedLines,
    originalLyricsState.hasNativeKaraoke,
    originalLyricsState.timingSource,
    payload.lines,
    'netease-fallback+' + (payload.source || 'tlyric')
  );
  applyPreferredLyricsForCurrent(true);
  return true;
}
async function fetchNeteaseLyricTranslationFallback(song, token, cacheKey) {
  if (!song || token !== trackSwitchToken) return false;
  var cached = lyricTranslationFallbackCache[cacheKey];
  if (cached) return mergeNeteaseFallbackTranslationsIntoCurrent(song, token, cached, cacheKey);
  try {
    var candidate = await findNeteaseLyricFallbackCandidate(song);
    if (token !== trackSwitchToken || !candidate || !candidate.id) return false;
    var response = await apiJson('/api/lyric?id=' + encodeURIComponent(candidate.id), { timeoutMs: 5200 });
    if (token !== trackSwitchToken) return false;
    var translationPayload = buildLyricTranslationPayload(response || {});
    if (!translationPayload.lines.length) {
      lyricTranslationFallbackMissCache[cacheKey] = Date.now();
      return false;
    }
    cached = {
      lines: cloneLyricLines(translationPayload.lines),
      source: translationPayload.source,
      candidateId: candidate.id,
      cachedAt: Date.now()
    };
    lyricTranslationFallbackCache[cacheKey] = cached;
    return mergeNeteaseFallbackTranslationsIntoCurrent(song, token, cached, cacheKey);
  } catch (err) {
    lyricTranslationFallbackMissCache[cacheKey] = Date.now();
    console.warn('[LyricTranslationFallback]', err);
    return false;
  }
}
function scheduleNeteaseLyricTranslationFallback(song, token, state) {
  if (!shouldFetchNeteaseLyricTranslationFallback(song, state)) return;
  var cacheKey = lyricTranslationFallbackKey(song);
  var cached = lyricTranslationFallbackCache[cacheKey];
  if (cached) {
    setTimeout(function () { mergeNeteaseFallbackTranslationsIntoCurrent(song, token, cached, cacheKey); }, 0);
    return;
  }
  var start = function () {
    if (token === trackSwitchToken) fetchNeteaseLyricTranslationFallback(song, token, cacheKey);
  };
  setTimeout(function () {
    if (window.requestIdleCallback) requestIdleCallback(start, { timeout: 1800 });
    else start();
  }, 420);
}
function lyricFallbackTextForSong(song) {
  song = song || {};
  var title = String(song.name || song.title || '').trim();
  var artist = String(song.artist || '').trim();
  if (!title && document) title = String(document.getElementById('thumb-title') && document.getElementById('thumb-title').textContent || '').trim();
  if (!artist && document) artist = String(document.getElementById('thumb-artist') && document.getElementById('thumb-artist').textContent || '').trim();
  if (!title) return '';
  return artist ? title + ' - ' + artist : title;
}
function withLyricFallbackForSong(song, lines) {
  lines = Array.isArray(lines) ? lines.filter(function (line) { return line && String(line.text || '').trim(); }) : [];
  if (lines.length && !lines.every(function (line) { return isNoLyricText(line.text); })) return lines;
  var text = lyricFallbackTextForSong(song);
  return text ? [{ t: 0, text: text, duration: 9999, charCount: Math.max(1, text.length), fallback: true }] : [];
}
// ============================================================
// 背景人声 (Apple Music ttm:role="x-bg") —— 可选字段, 不改变既有数据结构语义
//   - 默认作为"当前主歌词的附属视觉行": 挂在主 line 上 (line.background*)
//   - 只有 standalone=true 且无法归属主行时, 才成为独立时间轴行 (role === "x-bg")
//   - 旧 provider 不带 bg 时, 下面的函数完全不会被调用, 行为不变
// ============================================================
function normalizeLyricBackgroundEntries(value) {
  if (!Array.isArray(value)) return [];
  var out = [];
  for (var i = 0; i < value.length; i++) {
    var raw = value[i];
    if (!raw || typeof raw !== 'object') continue;
    var text = String(raw.text == null ? '' : raw.text).replace(/\s+/g, ' ').trim();
    var words = [];
    if (Array.isArray(raw.words)) {
      for (var w = 0; w < raw.words.length; w++) {
        var rw = raw.words[w];
        if (!rw || typeof rw !== 'object') continue;
        var wt = String(rw.text == null ? '' : rw.text);
        // 注意: Number(null) === 0, 必须显式判空, 否则会把"无时间"伪造成 0
        var ws = (rw.t == null || rw.t === '') ? NaN : Number(rw.t);
        if (!wt && !isFinite(ws)) continue;
        words.push({ text: wt, t: isFinite(ws) ? ws : 0, d: Math.max(0.06, Number(rw.d) || 0.24), c0: 0, c1: wt.length, role: 'x-bg' });
      }
    }
    if (!text && !words.length) continue;
    out.push({
      t: (raw.t == null || raw.t === '') ? null : (isFinite(Number(raw.t)) ? Number(raw.t) : null),
      duration: (raw.duration == null) ? 0 : Math.max(0, Number(raw.duration) || 0),
      text: text || words.map(function (x) { return x.text; }).join('').trim(),
      words: words,
      standalone: raw.standalone === true,
      // 背景人声的官方译文 (可选, 来自 Apple localization): 只跟随 bg 本身, 不进入主歌词 translation
      translation: String(raw.translation == null ? '' : raw.translation).replace(/\s+/g, ' ').trim(),
      parentT: (raw.parentT == null || raw.parentT === '') ? null : (isFinite(Number(raw.parentT)) ? Number(raw.parentT) : null)
    });
  }
  return out;
}
function mergeLyricBackgroundText(a, b) {
  var left = String(a || '').replace(/\s+/g, ' ').trim();
  var right = String(b || '').replace(/\s+/g, ' ').trim();
  if (!left) return right;
  if (!right) return left;
  if (left.indexOf(right) >= 0) return left;
  return left + ' ' + right;
}
// 找 bg 归属的主行: 1) parentT 精确匹配(无时间 bg 也靠它) 2) 时间包含 3) 最近前一行
function findLyricLineIndexForBackground(lines, bg) {
  var i;
  if (bg.parentT != null) {
    for (i = 0; i < lines.length; i++) {
      var parent = lines[i];
      if (parent && parent.role !== 'x-bg' && isFinite(Number(parent.t)) && Math.abs(Number(parent.t) - bg.parentT) <= 0.05) return i;
    }
  }
  if (bg.t == null) return -1;
  for (i = lines.length - 1; i >= 0; i--) {
    var line = lines[i];
    if (!line || line.role === 'x-bg' || !isFinite(Number(line.t))) continue;
    var span = Math.max(0.4, Number(line.duration) || 0);
    if (bg.t >= Number(line.t) - 0.05 && bg.t <= Number(line.t) + span + 0.35) return i;
  }
  var best = -1;
  for (i = 0; i < lines.length; i++) {
    var candidate = lines[i];
    if (!candidate || candidate.role === 'x-bg' || !isFinite(Number(candidate.t))) continue;
    if (Number(candidate.t) <= bg.t + 0.05 && (bg.t - Number(candidate.t)) <= 1.2) best = i;
  }
  return best;
}
function makeLyricBackgroundLine(bg, t) {
  var text = String(bg.text || '').replace(/\s+/g, ' ').trim();
  var words = (bg.words || []).map(function (w) {
    var wt = String(w.text == null ? '' : w.text);
    return { text: wt, t: Number(w.t) || 0, d: Math.max(0.06, Number(w.d) || 0.24), c0: 0, c1: wt.length, role: 'x-bg' };
  });
  return {
    t: Number(t) || 0,
    duration: Math.max(0.4, Number(bg.duration) || 0),
    text: text,
    words: words,
    charCount: Math.max(1, text.length),
    source: 'apple-bg',
    role: 'x-bg',
    // 独立成行的 bg 也保留自己的官方译文 (可选)
    backgroundTranslation: String(bg.translation || '').replace(/\s+/g, ' ').trim()
  };
}
function attachLyricBackgrounds(lines, backgrounds) {
  var out = Array.isArray(lines) ? lines.slice() : [];
  backgrounds.forEach(function (bg) {
    var index = findLyricLineIndexForBackground(out, bg);
    if (index >= 0) {
      var line = out[index];
      line.background = mergeLyricBackgroundText(line.background, bg.text);
      line.backgroundRole = 'x-bg';
      // 背景人声的官方译文单独挂在 backgroundTranslation 上, 绝不写入 line.translation
      if (bg.translation) line.backgroundTranslation = mergeLyricBackgroundText(line.backgroundTranslation, bg.translation);
      if (bg.words && bg.words.length) {
        line.backgroundWords = (line.backgroundWords || []).concat(bg.words);
        line.backgroundWords.sort(function (a, b) { return (Number(a.t) || 0) - (Number(b.t) || 0); });
      }
      return;
    }
    var t = bg.t != null ? bg.t : bg.parentT;
    if (t == null) {
      // 既无自身时间也无父行引用: 挂到最后一行, 保证不丢文本且不伪造时间
      var last = out.length ? out[out.length - 1] : null;
      if (last && last.role !== 'x-bg') {
        last.background = mergeLyricBackgroundText(last.background, bg.text);
        last.backgroundRole = 'x-bg';
        if (bg.translation) last.backgroundTranslation = mergeLyricBackgroundText(last.backgroundTranslation, bg.translation);
      } else if (bg.text) {
        out.push(makeLyricBackgroundLine(bg, 0));
      }
      return;
    }
    out.push(makeLyricBackgroundLine(bg, t));
  });
  // 时间轴必须保持 t 升序 (查找用二分)
  out.sort(function (a, b) { return (Number(a.t) || 0) - (Number(b.t) || 0); });
  return out;
}
function parseLyricResponseToOriginalState(song, response) {
  response = response || {};
  var nativeLines = parseYrcText(response.yrc || '');
  var lrcLines = parseLyricText(response.lyric || '');
  var translationPayload = buildLyricTranslationPayload(response);
  var translationLines = translationPayload.lines;
  var hasNativeKaraoke = nativeLines.some(function (line) { return line.words && line.words.length; });
  var timingSource = hasNativeKaraoke ? 'yrc-word' : (nativeLines.length ? 'yrc-line' : (lrcLines.length ? 'lrc-line' : 'fallback'));
  var primaryLines = nativeLines.length ? nativeLines : lrcLines;
  var lines = withLyricFallbackForSong(song, attachLyricTranslations(primaryLines, translationLines));
  // 背景人声: 默认作为主行附属视觉行; 仅 standalone 且无法归属时才独立成行
  var lyricBackgrounds = normalizeLyricBackgroundEntries(response.bg);
  if (lyricBackgrounds.length) lines = attachLyricBackgrounds(lines, lyricBackgrounds);
  if (lines.length && lines[0].fallback) timingSource = 'fallback';
  return {
    lines: cloneLyricLines(lines),
    hasNativeKaraoke: hasNativeKaraoke,
    timingSource: timingSource,
    translationLines: cloneLyricLines(translationLines),
    translationSource: translationPayload.source,
    usableLyric: hasUsableLyricLines(lines),
    cachedAt: Date.now()
  };
}
function shouldRetryStartupLyricFetch(song, token, attempt) {
  if (!song || token !== trackSwitchToken || (attempt || 0) >= 3) return false;
  if (song.type === 'local' || song.source === 'local' || song.localKey || song.type === 'podcast') return false;
  return !!(startupAutoplayPreference || restoredLastPlaybackSnapshot || pendingPlaybackResumeAt > 0);
}
function scheduleStartupLyricFetchRetry(song, token, attempt) {
  var delays = [700, 1600, 3200];
  var delay = delays[Math.max(0, Math.min(delays.length - 1, attempt || 0))];
  setTimeout(function () {
    if (token === trackSwitchToken) fetchLyric(song, token, (attempt || 0) + 1);
  }, delay);
}
var pendingTrackFallbackLyricTimer = 0;
function cancelPendingTrackFallbackLyrics() {
  if (pendingTrackFallbackLyricTimer) {
    clearTimeout(pendingTrackFallbackLyricTimer);
    pendingTrackFallbackLyricTimer = 0;
  }
}
function resetLyricsForTrackSwitch() {
  cancelPendingTrackFallbackLyrics();
  setOriginalLyricsState([], false, 'pending', [], 'none');
  lyricsHasNativeKaraoke = false;
  lyricsTimingSource = 'pending';
  lyricsTranslationLines = [];
  lyricsTranslationSource = 'none';
  lyricsLines = [];
  if (typeof invalidateStageLyricPayloadForNewLyrics === 'function') invalidateStageLyricPayloadForNewLyrics('track-switch-pending');
  else if (typeof clearStageLyrics === 'function') clearStageLyrics();
  updateCustomLyricControls();
}
function scheduleTrackSwitchFallbackLyrics(song, token, delay) {
  cancelPendingTrackFallbackLyrics();
  var multiLineDelay = (typeof stageLyricMultiLineWarmupLoad === 'function' && stageLyricMultiLineWarmupLoad()) ? 1850 : 180;
  pendingTrackFallbackLyricTimer = setTimeout(function () {
    pendingTrackFallbackLyricTimer = 0;
    if (token != null && token !== trackSwitchToken) return;
    if (hasUsableLyricLines(originalLyricsState && originalLyricsState.lines)) return;
    setOriginalLyricsState(withLyricFallbackForSong(song || currentLyricSong(), []), false, 'fallback', [], 'none');
    applyPreferredLyricsForCurrent(true);
  }, Math.max(multiLineDelay, Number(delay) || 720));
}
async function fetchLyric(songOrId, token, attempt) {
  attempt = Math.max(0, Number(attempt) || 0);
  var song;
  try {
    song = (songOrId && typeof songOrId === 'object') ? songOrId : null;
    var cachedResponse = song ? await readPersistentLyricCache(song) : null;
    if (cachedResponse) {
      var cachedState = applyFetchedLyricResponse(song, token, cachedResponse, { persist: false });
      if (cachedState && cachedState.usableLyric) {
        refreshPersistentLyricCache(song);
        return;
      }
    }
    var r = await apiJson(lyricEndpointForSong(song || songOrId));
    var state = applyFetchedLyricResponse(song, token, r);
    if (!state) return;
    if (!state.usableLyric && shouldRetryStartupLyricFetch(song, token, attempt)) scheduleStartupLyricFetchRetry(song, token, attempt);
  } catch (e) {
    if (token !== trackSwitchToken) return;
    cancelPendingTrackFallbackLyrics();
    var fallbackLines = withLyricFallbackForSong(song || currentLyricSong(), []);
    setOriginalLyricsState(fallbackLines, false, 'fallback', [], 'none');
    applyPreferredLyricsForCurrent(true);
    if (shouldRetryStartupLyricFetch(song, token, attempt)) scheduleStartupLyricFetchRetry(song, token, attempt);
  }
}
function currentLyricFallbackText() {
  return lyricFallbackTextForSong(currentLyricSong() || {});
}
function isNoLyricText(text) {
  var compact = String(text || '').replace(/\s+/g, '').replace(/[，,。.!！?？、~～]/g, '');
  return !compact ||
    compact === '纯音乐请欣赏' ||
    compact === '暂无歌词' ||
    compact === '暂无歌词敬请期待' ||
    compact === '此歌曲为没有填词的纯音乐请您欣赏';
}
function withLyricFallback(lines) {
  return withLyricFallbackForSong(currentLyricSong(), lines);
}
function lyricsAreFallbackTitleOnly(lines) {
  lines = Array.isArray(lines) ? lines.filter(function (line) { return line && String(line.text || '').trim(); }) : [];
  return lines.length === 1 && !!lines[0].fallback;
}
function lyricTagTimeToSeconds(min, sec, frac) {
  var t = (parseInt(min, 10) || 0) * 60 + (parseInt(sec, 10) || 0);
  if (frac) t += (parseInt(frac, 10) || 0) / Math.pow(10, Math.min(3, frac.length));
  return t;
}
function finalizeLyricLineDurations(lines) {
  lines.sort(function (a, b) { return a.t - b.t; });
  for (var i = 0; i < lines.length; i++) {
    var next = lines[i + 1];
    var inferred = next && next.t > lines[i].t ? next.t - lines[i].t : 4.8;
    if (!isFinite(lines[i].duration) || lines[i].duration <= 0) lines[i].duration = inferred;
    lines[i].duration = Math.max(0.45, Math.min(12, lines[i].duration));
    lines[i].charCount = Math.max(1, lines[i].charCount || String(lines[i].text || '').length);
  }
  return lines;
}
function parseLyricText(text) {
  var lines = [], reg = /\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g;
  text.split(/\r?\n/).forEach(function (line) {
    var tags = [], times = [], m;
    reg.lastIndex = 0;
    while ((m = reg.exec(line))) {
      var t = lyricTagTimeToSeconds(m[1], m[2], m[3]);
      times.push(t);
      tags.push({ t: t, index: m.index, end: reg.lastIndex });
    }
    if (!times.length) return;
    var hasInterleavedText = false;
    for (var i = 0; i < tags.length - 1; i++) {
      if (line.slice(tags[i].end, tags[i + 1].index).trim()) {
        hasInterleavedText = true;
        break;
      }
    }
    if (hasInterleavedText) {
      for (var si = 0; si < tags.length; si++) {
        var segment = line.slice(tags[si].end, si + 1 < tags.length ? tags[si + 1].index : line.length).trim();
        if (segment) lines.push({ t: tags[si].t, text: segment, source: 'lrc' });
      }
      return;
    }
    var txt = line.replace(reg, '').trim();
    if (!txt) return;
    times.forEach(function (t) { lines.push({ t: t, text: txt, source: 'lrc' }); });
  });
  return finalizeLyricLineDurations(lines);
}
function normalizeLyricTranslationText(text) {
  text = normalizeStageLyricText(text);
  if (!text || isNoLyricText(text)) return '';
  return text;
}
function usableLyricTranslationLines(lines) {
  return (Array.isArray(lines) ? lines : []).filter(function (line) {
    return line && normalizeLyricTranslationText(line.text);
  });
}
function isLyricCreditLineText(text) {
  var raw = normalizeStageLyricText(text);
  if (!raw || raw.length > 96) return false;
  if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(raw)) return false;
  var cleaned = raw
    .replace(/^[\s"'([{]+|[\s"'\])}]+$/g, '')
    .replace(/[.:：;；]+$/g, '')
    .trim();
  if (!cleaned) return false;
  var hasCreditPunctuation = /[:：]\s*$/.test(raw);
  var split = cleaned.split(/\s*(?:\/|,|&|\+|;|\band\b|\bfeat\.?\b|\bft\.?\b|\bwith\b)\s*/i);
  var tokens = [];
  split.forEach(function (part) {
    String(part || '').split(/\s+/).forEach(function (token) {
      token = token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.'-]+$/g, '');
      if (token) tokens.push(token);
    });
  });
  if (!tokens.length || tokens.length > 10) return false;
  var lyricWords = /\b(?:i|me|my|mine|you|your|yours|we|us|our|ours|he|him|his|she|her|they|them|it|love|die|want|need|know|gotta|gonna|wanna|would|could|should|can|cant|can't|dont|don't|ain't|is|are|am|be|been|being|was|were|do|does|did|go|come|make|take|throw|lock|away|world|force|key|place|baby|girl|boy|night|heart|life)\b/i;
  if (!hasCreditPunctuation && tokens.length > 1 && lyricWords.test(cleaned)) return false;
  var nameLike = 0;
  tokens.forEach(function (token) {
    if (/^(?:the|and|feat|ft|with)$/i.test(token)) {
      nameLike++;
    } else if (/^[A-Z0-9][A-Z0-9.'-]*$/.test(token) || /^[A-Z][A-Za-z0-9.'-]*$/.test(token)) {
      nameLike++;
    }
  });
  if (hasCreditPunctuation) return nameLike >= Math.max(1, tokens.length - 1);
  if (tokens.length <= 2 && /^[A-Z0-9 .,'-]+[.:]?$/.test(raw)) return true;
  return tokens.length >= 2 && nameLike >= tokens.length - 1 && /(?:\/|,|&|\+|\band\b|\bfeat\.?\b|\bft\.?\b|\bwith\b)/i.test(cleaned);
}
function markLyricLineSource(lines, source) {
  return usableLyricTranslationLines(lines || []).map(function (line) {
    var copy = Object.assign({}, line);
    if (Array.isArray(line.words)) copy.words = line.words.map(function (w) { return Object.assign({}, w); });
    copy.source = source || copy.source || 'translation';
    return copy;
  });
}
function mergeLyricTranslationLineSources() {
  var out = [];
  function hasSameLine(candidate) {
    var candidateText = normalizeLyricTranslationText(candidate && candidate.text);
    var candidateTime = Number(candidate && candidate.t) || 0;
    for (var i = 0; i < out.length; i++) {
      var item = out[i];
      if (Math.abs((Number(item.t) || 0) - candidateTime) <= 0.12 &&
        normalizeLyricTranslationText(item.text) === candidateText) return true;
    }
    return false;
  }
  for (var s = 0; s < arguments.length; s++) {
    var lines = usableLyricTranslationLines(arguments[s] || []);
    for (var i = 0; i < lines.length; i++) {
      if (!hasSameLine(lines[i])) out.push(lines[i]);
    }
  }
  return finalizeLyricLineDurations(out);
}
function buildLyricTranslationPayload(response) {
  response = response || {};
  // 翻译来源标识: Apple 官方翻译 (apple-web) 必须按 Apple 记账, 否则会被当成通用 tlyric
  // 并被 UI 显示成别的来源; 其它 provider 保持既有 tlyric/ytlrc 语义不变。
  var appleWebTranslation = String(response.source || '') === 'apple-web';
  var lrcSourceId = appleWebTranslation ? 'apple-web' : 'tlyric';
  var yrcSourceId = appleWebTranslation ? 'apple-web' : 'ytlrc';
  var lrcTranslations = markLyricLineSource(parseLyricText(lyricTranslationTextFromAliases(response)), lrcSourceId);
  var yrcTranslations = markLyricLineSource(parseYrcText(response.ytlrc || ''), yrcSourceId);
  var lines = mergeLyricTranslationLineSources(lrcTranslations, yrcTranslations);
  var sources = [];
  if (lrcTranslations.length) sources.push(lrcSourceId);
  if (yrcTranslations.length && sources.indexOf(yrcSourceId) < 0) sources.push(yrcSourceId);
  return { lines: lines, source: sources.length ? sources.join('+') : 'none' };
}
function attachLyricTranslations(primaryLines, translationLines) {
  var primary = cloneLyricLines(primaryLines || []);
  var translations = usableLyricTranslationLines(translationLines || []);
  if (!primary.length || !translations.length) return primary;
  var assignments = {};
  var usedTranslations = {};
  function translationToleranceForLine(line) {
    var lineDuration = Math.max(0.9, Math.min(5.5, Number(line && line.duration) || 3.2));
    return Math.max(0.55, Math.min(2.4, lineDuration * 0.62 + 0.18));
  }
  function canUseTranslation(line, tr) {
    var translated = normalizeLyricTranslationText(tr && tr.text);
    return !!(line && tr && translated &&
      !isLyricCreditLineText(line.text) &&
      !isLyricCreditLineText(translated) &&
      translated !== normalizeStageLyricText(line.text));
  }
  function assignTranslation(lineIndex, trIndex, delta, phase) {
    var line = primary[lineIndex];
    var tr = translations[trIndex];
    if (!canUseTranslation(line, tr) || usedTranslations[trIndex]) return false;
    assignments[lineIndex] = { line: tr, delta: delta, index: trIndex, phase: phase || 'time' };
    usedTranslations[trIndex] = true;
    return true;
  }
  primary.forEach(function (line, lineIndex) {
    if (!line || line.fallback) return;
    var bestIndex = -1;
    var bestDelta = Infinity;
    for (var trIndex = 0; trIndex < translations.length; trIndex++) {
      if (usedTranslations[trIndex]) continue;
      var tr = translations[trIndex];
      if (!canUseTranslation(line, tr)) continue;
      var delta = Math.abs((Number(tr.t) || 0) - (Number(line.t) || 0));
      if (delta > translationToleranceForLine(line)) continue;
      if (delta < bestDelta) {
        bestIndex = trIndex;
        bestDelta = delta;
      }
    }
    if (bestIndex >= 0) assignTranslation(lineIndex, bestIndex, bestDelta, 'time');
  });
  if (translations.length >= Math.max(2, primary.length * 0.58)) {
    var orderedPrimaryIndexes = [];
    primary.forEach(function (line, lineIndex) {
      if (line && !line.fallback && !isLyricCreditLineText(line.text)) orderedPrimaryIndexes.push(lineIndex);
    });
    var primaryDen = Math.max(1, orderedPrimaryIndexes.length - 1);
    var translationDen = Math.max(1, translations.length - 1);
    orderedPrimaryIndexes.forEach(function (lineIndex, orderPos) {
      var line = primary[lineIndex];
      if (!line || line.fallback || assignments[lineIndex]) return;
      var expected = Math.round((orderPos / primaryDen) * translationDen);
      var bestIndex = -1;
      var bestScore = Infinity;
      var bestDelta = Infinity;
      for (var trIndex = 0; trIndex < translations.length; trIndex++) {
        if (usedTranslations[trIndex]) continue;
        var tr = translations[trIndex];
        if (!canUseTranslation(line, tr)) continue;
        var orderGap = Math.abs(trIndex - expected);
        if (orderGap > 5 && translations.length <= primary.length * 1.25) continue;
        var delta = Math.abs((Number(tr.t) || 0) - (Number(line.t) || 0));
        var fallbackTolerance = Math.max(translationToleranceForLine(line) * 1.35, 2.8);
        if (delta > fallbackTolerance && orderGap > 2) continue;
        var score = orderGap * 0.72 + Math.min(delta, 8) * 0.22;
        if (score < bestScore) {
          bestIndex = trIndex;
          bestScore = score;
          bestDelta = delta;
        }
      }
      if (bestIndex >= 0) assignTranslation(lineIndex, bestIndex, bestDelta, 'order');
    });
  }
  Object.keys(assignments).forEach(function (key) {
    var lineIndex = Number(key);
    var line = primary[lineIndex];
    var best = assignments[key] && assignments[key].line;
    if (line && best) {
      var translated = normalizeLyricTranslationText(best.text);
      if (translated && translated !== normalizeStageLyricText(line.text)) {
        line.translation = translated;
        line.translationTime = best.t;
        line.translationSource = best.source || 'tlyric';
        line.translationMatch = assignments[key].phase || 'time';
      }
    }
  });
  return primary;
}
function parseYrcText(text) {
  var lines = [];
  String(text || '').split(/\r?\n/).forEach(function (line) {
    var m = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!m) return;
    var lineStartMs = parseInt(m[1], 10) || 0;
    var lineDurMs = parseInt(m[2], 10) || 0;
    var body = m[3] || '';
    var words = [], fullText = '';
    var reg = /\((\d+),(\d+),\d+\)([^()]*)/g, wm;
    while ((wm = reg.exec(body))) {
      var txt = (wm[3] || '').replace(/\s+/g, ' ');
      if (!txt) continue;
      var rawStart = parseInt(wm[1], 10) || 0;
      var rawDur = parseInt(wm[2], 10) || 0;
      var absStartMs = rawStart >= lineStartMs - 500 ? rawStart : lineStartMs + rawStart;
      var c0 = fullText.length;
      fullText += txt;
      words.push({ text: txt, t: absStartMs / 1000, d: Math.max(0.06, rawDur / 1000), c0: c0, c1: fullText.length });
    }
    if (!fullText) fullText = body.replace(/\(\d+,\d+,\d+\)/g, '').replace(/\s+/g, ' ');
    var leading = (fullText.match(/^\s+/) || [''])[0].length;
    fullText = fullText.replace(/\s+/g, ' ').trim();
    if (!fullText) return;
    if (words.length) {
      words.forEach(function (w) {
        w.c0 = Math.max(0, Math.min(fullText.length, w.c0 - leading));
        w.c1 = Math.max(w.c0, Math.min(fullText.length, w.c1 - leading));
      });
      words = words.filter(function (w) { return w.c1 > w.c0; });
    }
    lines.push({ t: lineStartMs / 1000, duration: lineDurMs / 1000, text: fullText, words: words, charCount: Math.max(1, fullText.length), source: words.length ? 'yrc-word' : 'yrc-line' });
  });
  return finalizeLyricLineDurations(lines);
}
function renderLyrics(options) {
  options = options || {};
  var renderSignature = typeof stageLyricRenderSignatureForCurrentState === 'function' ? stageLyricRenderSignatureForCurrentState() : '';
  if (options.preserveSame && typeof stageLyricCanPreserveSameRender === 'function' && stageLyricCanPreserveSameRender(renderSignature)) {
    if (typeof markStageLyricsPlaybackResume === 'function') markStageLyricsPlaybackResume(options.reason || 'preserve-same-lyrics');
    return;
  }
  var fallbackTitleOnly = lyricsAreFallbackTitleOnly(lyricsLines);
  var warmupReason = fallbackTitleOnly ? 'renderLyrics-title' : 'renderLyrics';
  var restoreWarmup = typeof stageLyricRestoreWarmupSeconds === 'function' && stageLyricRestoreWarmupSeconds() != null;
  var prewarmReason = restoreWarmup ? 'startup-restore-lyrics' : warmupReason;
  if (typeof invalidateStageLyricPayloadForNewLyrics === 'function') invalidateStageLyricPayloadForNewLyrics('renderLyrics');
  else clearStageLyrics();
  if (typeof stageLyrics !== 'undefined' && stageLyrics && renderSignature) stageLyrics.renderSignature = renderSignature;
  if (typeof requestStageLyricWarmup === 'function') requestStageLyricWarmup(prewarmReason, fallbackTitleOnly ? 120 : 900);
  if (restoreWarmup && typeof scheduleStageLyricRestorePrewarm === 'function') {
    scheduleStageLyricRestorePrewarm(prewarmReason, fallbackTitleOnly ? 40 : 16);
  } else if (typeof scheduleStageLyricPrewarm === 'function') {
    scheduleStageLyricPrewarm(warmupReason, fallbackTitleOnly ? 56 : 32);
  }
  if (!fallbackTitleOnly && typeof scheduleStageLyricSingleLineBootstrapPrewarm === 'function') {
    scheduleStageLyricSingleLineBootstrapPrewarm(prewarmReason, restoreWarmup ? 24 : 44);
  }
  if (!fallbackTitleOnly && typeof scheduleStageLyricFullTrackWarmup === 'function') {
    scheduleStageLyricFullTrackWarmup(restoreWarmup ? 'track-ready-fast' : 'lyrics-ready-preload', restoreWarmup ? 120 : 24);
  }
  // v8: 歌词渲染由 stageLyrics 在每帧 tickLyricsParticles 里推动
}
function toggleLyricsPanel(force) {
  if (force === false) fx.particleLyrics = false;
  else if (force === true) fx.particleLyrics = true;
  else fx.particleLyrics = !fx.particleLyrics;
  if (fx.particleLyrics) {
    createLyricsParticles();
    if (typeof requestStageLyricWarmup === 'function') requestStageLyricWarmup('toggleLyricsPanel', 150);
    if (typeof scheduleStageLyricPrewarm === 'function') scheduleStageLyricPrewarm('toggleLyricsPanel', 48);
    if (typeof scheduleStageLyricFullTrackWarmup === 'function') scheduleStageLyricFullTrackWarmup('track-ready', 220);
    showToast('歌词已开启');
  } else {
    clearStageLyrics();
    showToast('歌词已关闭');
  }
  lyricsVisible = fx.particleLyrics;
}
function updateLyricsHighlight() { /* v8: 由 tickLyricsParticles 接管 */ }

// ============================================================
//  播放列表面板
