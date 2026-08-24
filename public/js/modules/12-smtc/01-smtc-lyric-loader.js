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
  source: '',        // 多歌词源: 'qq' | 'kugou' | 'netease' | ''
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
  smtcLyricState.source = '';
  smtcClearLyrics();
  if (typeof smtcRenderChip === 'function') smtcRenderChip();

  var title = smtcNormalizedSearchTerm(smtcStore.title);
  if (!title) {
    smtcLyricState.loading = false;
    smtcLyricState.error = 'no-title';
    if (typeof smtcRenderChip === 'function') smtcRenderChip();
    return;
  }

  // 多源解析 (搜索/缓存/严格优先级 fallback 由 05-smtc-lyric-sources 编排,
  // 竞态由 seq generationId 在每次 await 后校验: A 的晚到结果不会覆盖 B)
  console.log('[LYRICS] request title=' + (smtcStore.title || '') + ' artist=' + (smtcStore.artist || ''));
  var result = null;
  try {
    result = await smtcResolveLyricViaSources(smtcStore.title, smtcStore.artist, seq);
  } catch (e) {
    result = null; // 编排器意外异常 -> 视为无歌词, 不阻塞歌词系统
  }
  if (seq !== smtcLyricState.seq) return;
  if (!result) {
    smtcLyricState.loading = false;
    smtcLyricState.loaded = false;
    smtcLyricState.hasLyrics = false;
    smtcLyricState.error = 'no-lyrics';
    smtcLogToFile('lyric no candidate: ' + (smtcStore.title || '') + ' - ' + (smtcStore.artist || ''));
    if (typeof smtcRenderChip === 'function') smtcRenderChip();
    return;
  }

  var synthetic = result.synthetic;
  smtcLyricState.source = result.source;
  try {
    // 解析并写入现有歌词状态 (stage 自动渲染; 对唱/背景人声等由现有解析器保留)
    console.log('[LYRIC][' + Date.now() + '] response received (T9) seq=' + seq + ' fromCache=' + result.fromCache + ' source=' + result.source + ' id=' + (synthetic.id || synthetic.mid || synthetic.hash || ''));
    var state = parseLyricResponseToOriginalState(synthetic, result.response);
    setOriginalLyricsState(state.lines, state.hasNativeKaraoke, state.timingSource, state.translationLines, state.translationSource);
    applyOriginalLyricsState({ reason: 'smtc' });
    smtcLyricState.hasLyrics = !!state.usableLyric;
    smtcLyricState.loaded = true;
    smtcLyricState.error = '';
    smtcLogToFile('lyric source=' + (typeof smtcLyricSourceName === 'function' ? smtcLyricSourceName(result.source) : result.source));
    // 主源无翻译且非网易云 -> 异步从网易云补翻译 (seq 保护, 不阻塞原文显示)
    if (state.usableLyric && !state.translationLines.length && result.source !== 'netease') {
      if (typeof smtcSupplementNeteaseTranslation === 'function') {
        smtcSupplementNeteaseTranslation(smtcStore.title, smtcStore.artist, seq);
      }
    }
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
      smtcLyricState.source = '';
      smtcClearLyrics();
    }
  }
  if (typeof smtcRenderChip === 'function') smtcRenderChip();
}
