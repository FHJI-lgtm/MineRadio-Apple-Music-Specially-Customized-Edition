// ============================================================
// 12-smtc/01-smtc-lyric-loader.js
// SMTC 歌曲 identity 标准化 / 变化检测 / 歌词匹配与缓存
//
// 复用现有歌词管线：
//   - 搜索候选：现有 /api/search（网易云）+ scoreSongSearchResult
//   - 取词：lyricEndpointForSong + mergeInlineLyricResponseForSong
//   - 解析：parseLyricResponseToOriginalState（LRC/YRC）
//   - 状态写入：setOriginalLyricsState + applyOriginalLyricsState
//   - 缓存：readPersistentLyricCache / writePersistentLyricCache
//
// 歌词系统不感知来源是 Apple Music 还是其它播放器。
// ============================================================
function smtcLogToFile(message) {
  try {
    var api = window.desktopWindow;
    if (api && typeof api.logSmtc === 'function') api.logSmtc(String(message || '').slice(0, 400));
  } catch (e) { }
}
var smtcLyricState = {
  identity: '',
  seq: 0,
  loading: false,
  loaded: false,
  hasLyrics: false,
  error: '',
  neteaseId: '',
};

function smtcNormalizedIdentityToken(text) {
  return String(text || '')
    .normalize ? String(text).normalize('NFKC') : String(text);
}

function smtcSongIdentityKey() {
  return smtcNormalizedIdentityToken(smtcStore.title) + '||' + smtcNormalizedIdentityToken(smtcStore.artist);
}

// 清洗版本信息（用于第二条搜索策略），保持保守，避免过度清洗。
function smtcCleanVersionInfo(text) {
  return String(text || '')
    .replace(/[（(【\[].*?(feat\.?|ft\.?|featuring|remix|remaster|live|deluxe|edition|bonus|acoustic|demo|karaoke).*?[）)】\]]/ig, '')
    .replace(/\s*(feat\.?|ft\.?|featuring)\s+[A-Za-z0-9&.\s'-]+/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function smtcNormalizedSearchTerm(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// 多策略搜索：优先 歌手+歌名，其次 清洗版本后，最后 仅歌名。
function smtcSearchQueries() {
  var title = smtcNormalizedSearchTerm(smtcStore.title);
  var artist = smtcNormalizedSearchTerm(smtcStore.artist);
  var queries = [];
  if (artist && title) queries.push(artist + ' ' + title);
  var cleanTitle = smtcCleanVersionInfo(title);
  var cleanArtist = smtcCleanVersionInfo(artist);
  if (cleanArtist && cleanTitle && (cleanArtist !== artist || cleanTitle !== title)) {
    queries.push(cleanArtist + ' ' + cleanTitle);
  }
  if (title) queries.push(title);
  return queries;
}

function smtcSearchBestCandidate(query) {
  return apiJson('/api/search?keywords=' + encodeURIComponent(query) + '&limit=8', { timeoutMs: 4800 })
    .then(function (data) {
      var list = data && (data.songs || data.result || []);
      if (!Array.isArray(list) || !list.length) return null;
      var best = null;
      var bestScore = -Infinity;
      list.forEach(function (candidate, index) {
        if (!candidate || !candidate.id || !candidate.name) return;
        var score = typeof scoreSongSearchResult === 'function'
          ? scoreSongSearchResult(candidate, query, index)
          : 0;
        if (score > bestScore) { bestScore = score; best = candidate; }
      });
      return best;
    })
    .catch(function () { return null; });
}

// 用匹配到的网易云歌曲构造合成 song，让现有歌词链路（含缓存）完全复用。
function smtcBuildSyntheticSong(candidate) {
  var title = smtcNormalizedSearchTerm(smtcStore.title);
  var artist = smtcNormalizedSearchTerm(smtcStore.artist);
  return {
    provider: 'netease',
    source: 'netease',
    type: 'netease',
    id: String(candidate.id || ''),
    mid: String(candidate.mid || candidate.id || ''),
    name: String(candidate.name || title || ''),
    title: String(candidate.name || title || ''),
    artist: String(candidate.artist || artist || ''),
    album: String(candidate.album || smtcStore.album || ''),
    duration: Number(candidate.duration || smtcDurationSeconds()) || 0,
    smtcExternal: true,
  };
}

function smtcClearLyrics() {
  try {
    if (typeof resetLyricsForTrackSwitch === 'function') resetLyricsForTrackSwitch();
  } catch (e) { }
  try {
    setOriginalLyricsState([], false, 'none', [], 'none');
    applyOriginalLyricsState({ reason: 'smtc-clear' });
  } catch (e) { }
}

async function smtcLoadLyrics() {
  var seq = ++smtcLyricState.seq;
  console.log('[LYRIC][' + Date.now() + '] search started (T8) seq=' + seq + ' title=' + smtcStore.title + ' artist=' + smtcStore.artist);
  smtcLogToFile('lyric search started: ' + (smtcStore.title || '') + ' - ' + (smtcStore.artist || ''));
  smtcLyricState.loading = true;
  smtcLyricState.loaded = false;
  smtcLyricState.hasLyrics = false;
  smtcLyricState.error = '';
  smtcClearLyrics();
  if (typeof smtcRenderChip === 'function') smtcRenderChip();

  var title = smtcNormalizedSearchTerm(smtcStore.title);
  if (!title) {
    smtcLyricState.loading = false;
    smtcLyricState.error = 'no-title';
    if (typeof smtcRenderChip === 'function') smtcRenderChip();
    return;
  }

  // 1) 多策略搜索候选（网络只在歌曲变化时发生一次）
  var candidate = null;
  var queries = smtcSearchQueries();
  for (var i = 0; i < queries.length; i++) {
    if (seq !== smtcLyricState.seq) return;
    candidate = await smtcSearchBestCandidate(queries[i]);
    if (candidate) break;
  }
  if (seq !== smtcLyricState.seq) return;
  if (!candidate) {
    smtcLyricState.loading = false;
    smtcLyricState.error = 'no-lyrics';
    smtcLyricState.neteaseId = '';
    smtcLogToFile('lyric no candidate: ' + (smtcStore.title || '') + ' - ' + (smtcStore.artist || ''));
    if (typeof smtcRenderChip === 'function') smtcRenderChip();
    return;
  }

  var synthetic = smtcBuildSyntheticSong(candidate);
  smtcLyricState.neteaseId = String(candidate.id || '');
  try {
    // 2) 优先缓存，命中则不再请求 API
    var response = await readPersistentLyricCache(synthetic);
    var fromCache = !!response;
    if (!response) {
      var r = await apiJson(lyricEndpointForSong(synthetic), { timeoutMs: 6500 });
      response = mergeInlineLyricResponseForSong(synthetic, r || {});
    }
    if (seq !== smtcLyricState.seq) return;
    // 3) 解析并写入现有歌词状态（stage 会自动渲染）
    console.log('[LYRIC][' + Date.now() + '] response received (T9) seq=' + seq + ' fromCache=' + fromCache + ' neteaseId=' + (synthetic.id || ''));
    var state = parseLyricResponseToOriginalState(synthetic, response);
    setOriginalLyricsState(state.lines, state.hasNativeKaraoke, state.timingSource, state.translationLines, state.translationSource);
    applyOriginalLyricsState({ reason: 'smtc' });
    smtcLyricState.hasLyrics = !!state.usableLyric;
    smtcLyricState.loaded = true;
    smtcLyricState.error = '';
    if (state.usableLyric && !fromCache) writePersistentLyricCache(synthetic, response);
  } catch (err) {
    if (seq !== smtcLyricState.seq) return;
    smtcLyricState.loaded = false;
    smtcLyricState.hasLyrics = false;
    smtcLyricState.error = 'lyric-fetch-failed';
    smtcLogToFile('lyric fetch failed: ' + (err && err.message || err));
  } finally {
    if (seq === smtcLyricState.seq) {
      smtcLyricState.loading = false;
      if (typeof smtcRenderChip === 'function') smtcRenderChip();
    }
  }
}

// 歌曲变化检测：identity 未变化时不重新搜索歌词。
function onSmtcStateChanged(prevActive, prevPlaying) {
  var key = smtcSongIdentityKey();
  if (key && key !== smtcLyricState.identity) {
    console.log('[LYRIC][' + Date.now() + '] identity changed (T7): ' + smtcLyricState.identity + ' -> ' + key);
    smtcLyricState.identity = key;
    if (smtcStore.active && key) {
      smtcLoadLyrics();
    } else {
      smtcLyricState.seq += 1;
      smtcLyricState.loading = false;
      smtcLyricState.loaded = false;
      smtcLyricState.hasLyrics = false;
      smtcLyricState.error = '';
      smtcClearLyrics();
    }
  }
  if (typeof smtcRenderChip === 'function') smtcRenderChip();
}
