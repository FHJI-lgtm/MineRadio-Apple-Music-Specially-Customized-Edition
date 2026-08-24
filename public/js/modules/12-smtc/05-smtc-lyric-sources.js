// ============================================================
// 12-smtc/05-smtc-lyric-sources.js
// 多歌词源 + 可自定义优先级 (外部播放器/SMTC 歌词路径专用)
//
// 默认优先级: QQ 音乐 > 酷狗音乐 > 网易云音乐
//
// 复用现有管线, 不重写解析器:
//   apiJson / scoreSongSearchResult / isSameTitleArtist /
//   lyricEndpointForSong / mergeInlineLyricResponseForSong /
//   parseLyricResponseToOriginalState / setOriginalLyricsState /
//   applyOriginalLyricsState / writePersistentLyricCache
//
// 竞态: 由 01-smtc-lyric-loader 的 seq (generationId) 在每次 await 后校验,
//       歌曲 A 的晚到结果不会覆盖歌曲 B。
// 歌词模块与 Apple Music 播放 / SMTC / 音频捕获 / 封面 / 播放控制完全解耦。
// ============================================================

var SMTC_LYRIC_SOURCES_DEFAULT_ORDER = ['qq', 'kugou', 'netease'];
var SMTC_LYRIC_SOURCE_SETTINGS_KEY = 'mineradio-lyric-source-priority-v1';
var SMTC_LYRIC_SOURCE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 持久缓存 7 天

var SMTC_LYRIC_SOURCES = {
  qq: { id: 'qq', name: 'QQ 音乐' },
  kugou: { id: 'kugou', name: '酷狗音乐' },
  netease: { id: 'netease', name: '网易云音乐' },
};

// 会话内缓存: normKey -> { source, matchedTitle, matchedArtist, timestamp, response, synthetic }
var smtcLyricSourceMemoryCache = {};

// ---------- 设置持久化 (localStorage) ----------
function smtcLyricSourceSettings() {
  var settings = null;
  try {
    var raw = JSON.parse(localStorage.getItem(SMTC_LYRIC_SOURCE_SETTINGS_KEY) || 'null');
    if (raw && Array.isArray(raw.order) && raw.enabled && typeof raw.enabled === 'object') settings = raw;
  } catch (e) { }
  if (!settings) settings = { order: SMTC_LYRIC_SOURCES_DEFAULT_ORDER.slice(), enabled: {} };
  var known = {};
  Object.keys(SMTC_LYRIC_SOURCES).forEach(function (id) { known[id] = true; });
  var order = settings.order.filter(function (id) { return known[id]; });
  SMTC_LYRIC_SOURCES_DEFAULT_ORDER.forEach(function (id) {
    if (order.indexOf(id) < 0) order.push(id);
  });
  var enabled = {};
  SMTC_LYRIC_SOURCES_DEFAULT_ORDER.forEach(function (id) {
    enabled[id] = settings.enabled[id] !== false;
  });
  return { order: order, enabled: enabled };
}

function smtcSaveLyricSourceSettings(settings) {
  try {
    localStorage.setItem(SMTC_LYRIC_SOURCE_SETTINGS_KEY, JSON.stringify({
      order: (settings && settings.order || SMTC_LYRIC_SOURCES_DEFAULT_ORDER).slice(),
      enabled: Object.assign({}, settings && settings.enabled || {}),
    }));
  } catch (e) { }
}

function smtcResetLyricSourceSettings() {
  var defaults = { order: SMTC_LYRIC_SOURCES_DEFAULT_ORDER.slice(), enabled: { qq: true, kugou: true, netease: true } };
  smtcSaveLyricSourceSettings(defaults);
  return defaults;
}

// 按当前用户设置返回启用的源列表 (已按优先级排序)
function smtcEnabledLyricSourceList() {
  var settings = smtcLyricSourceSettings();
  return settings.order.filter(function (id) {
    return settings.enabled[id] !== false && SMTC_LYRIC_SOURCES[id];
  }).map(function (id, index) {
    return { id: id, name: SMTC_LYRIC_SOURCES[id].name, enabled: true, priority: index + 1 };
  });
}

function smtcLyricSourceName(id) {
  return (SMTC_LYRIC_SOURCES[id] && SMTC_LYRIC_SOURCES[id].name) || String(id || '');
}

// ---------- 标题/艺术家规范化 ----------
function smtcLyricCleanVersion(text) {
  return String(text || '')
    .replace(/[（(【\[].*?(?:feat\.?|ft\.?|featuring|remix|remaster|radio\s*edit|live|deluxe|edition|bonus|acoustic|demo|karaoke|with|piano|ver\.?|version).*?[）)】\]]/ig, '')
    .replace(/\s*(?:feat\.?|ft\.?|featuring|with)\s+[A-Za-z0-9&.\s'-]+/ig, '')
    .replace(/\s*[（(【\[].*?[）)】\]]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function smtcLyricNormText(text) {
  var raw = String(text || '');
  if (raw.normalize) raw = raw.normalize('NFKC'); // 全角/半角统一
  return smtcLyricCleanVersion(raw)
    .toLowerCase()
    .replace(/[\s·・,，。.!！?？'"“”‘’|\-_/（）()【】\[\]~～：:;；&＋+]+/g, '');
}

// 缓存 key: normalizedTitle + normalizedArtist
function smtcLyricNormKey(title, artist) {
  var t = smtcLyricNormText(title);
  var a = smtcLyricNormText(artist);
  if (!t) return '';
  return t + '|' + a;
}

// 多策略搜索查询: 歌手+歌名 -> 清洗版本后 -> 仅歌名
function smtcLyricQueries(title, artist) {
  title = String(title || '').trim();
  artist = String(artist || '').trim();
  var queries = [];
  if (artist && title) queries.push(artist + ' ' + title);
  var cleanTitle = smtcLyricCleanVersion(title);
  var cleanArtist = smtcLyricCleanVersion(artist);
  if (cleanArtist && cleanTitle && (cleanArtist !== artist || cleanTitle !== title)) {
    queries.push(cleanArtist + ' ' + cleanTitle);
  }
  if (title && queries.indexOf(title) < 0) queries.push(title);
  return queries;
}

// ---------- 候选匹配 (不要盲目采用第一条) ----------
function smtcLyricPickBest(list, query, title, artist) {
  if (!Array.isArray(list) || !list.length) return null;
  var best = null;
  var bestScore = -Infinity;
  list.forEach(function (candidate, index) {
    if (!candidate || !candidate.name) return;
    var score = typeof scoreSongSearchResult === 'function' ? scoreSongSearchResult(candidate, query, index) : 0;
    if (score > bestScore) { bestScore = score; best = candidate; }
  });
  if (!best) return null;
  // 精确标题+艺术家匹配 -> 直接采用
  if (typeof isSameTitleArtist === 'function') {
    try {
      if (isSameTitleArtist({ name: title || smtcStore.title, title: title || smtcStore.title, artist: artist || smtcStore.artist }, best)) return best;
    } catch (e) { }
  }
  // 否则要求足够高的匹配分
  return bestScore >= 34 ? best : null;
}

// ---------- 三源实现 (search / getLyrics) ----------
function smtcLyricSyntheticForCandidate(sourceId, candidate, title, artist) {
  var base = {
    name: String(candidate.name || candidate.title || title || ''),
    title: String(candidate.name || candidate.title || title || ''),
    artist: String(candidate.artist || artist || ''),
    album: String(candidate.album || smtcStore.album || ''),
    duration: Number(candidate.duration || smtcDurationSeconds()) || 0,
    smtcExternal: true,
  };
  if (sourceId === 'qq') {
    base.provider = 'qq'; base.source = 'qq'; base.type = 'qq';
    base.id = String(candidate.qqId || candidate.id || '');
    base.mid = String(candidate.mid || candidate.songmid || '');
    base.qqId = String(candidate.qqId || candidate.id || '');
  } else if (sourceId === 'kugou') {
    base.provider = 'kugou'; base.source = 'kugou'; base.type = 'kugou';
    var hash = String(candidate.hash || candidate.fileHash || candidate.FileHash || '');
    base.id = hash;
    base.hash = hash;
    base.fileHash = hash;
    base.albumAudioId = String(candidate.albumAudioId || candidate.album_audio_id || candidate.mixSongId || '');
    base.album_audio_id = base.albumAudioId;
  } else {
    base.provider = 'netease'; base.source = 'netease'; base.type = 'netease';
    base.id = String(candidate.id || '');
    base.mid = String(candidate.mid || candidate.id || '');
  }
  return base;
}

function smtcLyricSyntheticForSourceId(sourceId, title, artist) {
  var base = {
    provider: sourceId, source: sourceId, type: sourceId,
    id: '', mid: '', hash: '',
    name: String(title || ''), title: String(title || ''),
    artist: String(artist || ''), album: String(smtcStore.album || ''),
    duration: Number(smtcDurationSeconds()) || 0, smtcExternal: true,
  };
  if (sourceId === 'kugou') base.hash = '';
  return base;
}

var smtcLyricSourceImpls = {
  qq: {
    search: function (query) {
      return apiJson('/api/qq/search?keywords=' + encodeURIComponent(query) + '&limit=8', { timeoutMs: 4800 })
        .then(function (data) {
          return smtcLyricPickBest(data && data.songs, query, smtcStore.title, smtcStore.artist);
        })
        .catch(function () { return null; });
    },
    getLyrics: function (candidate, synthetic) {
      if (!synthetic.mid && !synthetic.id) return Promise.resolve(null);
      return apiJson(lyricEndpointForSong(synthetic), { timeoutMs: 6500 })
        .then(function (r) { return mergeInlineLyricResponseForSong(synthetic, r || {}); })
        .catch(function () { return null; });
    },
  },
  kugou: {
    search: function (query) {
      return apiJson('/api/kugou/search?keywords=' + encodeURIComponent(query) + '&limit=8', { timeoutMs: 4800 })
        .then(function (data) {
          return smtcLyricPickBest(data && data.songs, query, smtcStore.title, smtcStore.artist);
        })
        .catch(function () { return null; });
    },
    getLyrics: function (candidate, synthetic) {
      if (!synthetic.hash && !synthetic.id) return Promise.resolve(null);
      return apiJson(lyricEndpointForSong(synthetic), { timeoutMs: 6500 })
        .then(function (r) { return mergeInlineLyricResponseForSong(synthetic, r || {}); })
        .catch(function () { return null; });
    },
  },
  netease: {
    search: function (query) {
      return apiJson('/api/search?keywords=' + encodeURIComponent(query) + '&limit=8', { timeoutMs: 4800 })
        .then(function (data) {
          return smtcLyricPickBest(data && (data.songs || data.result), query, smtcStore.title, smtcStore.artist);
        })
        .catch(function () { return null; });
    },
    getLyrics: function (candidate, synthetic) {
      if (!synthetic.id) return Promise.resolve(null);
      return apiJson(lyricEndpointForSong(synthetic), { timeoutMs: 6500 })
        .then(function (r) { return mergeInlineLyricResponseForSong(synthetic, r || {}); })
        .catch(function () { return null; });
    },
  },
};

// ---------- 持久缓存 (identity 键, 跨会话) ----------
function smtcLyricPersistentKey(normKey) {
  return 'lyric-source-v1|' + String(normKey || '');
}

function smtcLyricReadPersistentCache(normKey) {
  if (!window.desktopWindow || typeof window.desktopWindow.readLyricCache !== 'function') return Promise.resolve(null);
  return window.desktopWindow.readLyricCache(smtcLyricPersistentKey(normKey)).then(function (result) {
    return result && result.ok && result.hit && result.payload ? result.payload : null;
  }).catch(function () { return null; });
}

function smtcLyricWritePersistentCache(normKey, entry) {
  if (!window.desktopWindow || typeof window.desktopWindow.writeLyricCache !== 'function') return;
  try {
    window.desktopWindow.writeLyricCache(smtcLyricPersistentKey(normKey), {
      version: 1,
      source: entry.source,
      matchedTitle: String(entry.matchedTitle || ''),
      matchedArtist: String(entry.matchedArtist || ''),
      timestamp: Date.now(),
      response: entry.response,
      synthetic: entry.synthetic,
    }).catch(function () { });
  } catch (e) { }
}

function smtcLyricCacheEntryUsable(entry, title, artist) {
  if (!entry || !entry.response || !entry.source) return null;
  if (entry.timestamp && Date.now() - Number(entry.timestamp) > SMTC_LYRIC_SOURCE_CACHE_TTL_MS) return null;
  var synthetic = entry.synthetic || smtcLyricSyntheticForSourceId(entry.source, title, artist);
  try {
    var state = parseLyricResponseToOriginalState(synthetic, entry.response);
    return state && state.usableLyric ? { synthetic: synthetic, state: state } : null;
  } catch (e) {
    return null; // 缓存损坏 -> 不阻塞 fallback
  }
}

// ---------- 主编排器 (严格按用户优先级 fallback) ----------
// 返回 { response, source, synthetic, fromCache } 或 null (全部失败)
async function smtcResolveLyricViaSources(title, artist, seq) {
  var normKey = smtcLyricNormKey(title, artist);
  if (!normKey) return null;

  // 1) 会话内缓存
  var mem = smtcLyricSourceMemoryCache[normKey];
  var memHit = mem ? smtcLyricCacheEntryUsable(mem, title, artist) : null;
  if (memHit) {
    console.log('[LYRICS] cache HIT source=' + smtcLyricSourceName(mem.source));
    return { response: mem.response, source: mem.source, synthetic: memHit.synthetic, fromCache: true };
  }

  // 2) 持久缓存 (命中但内容为空/损坏 -> 继续 fallback, 不阻塞)
  var persistent = await smtcLyricReadPersistentCache(normKey);
  if (seq !== smtcLyricState.seq) return null;
  var perHit = persistent ? smtcLyricCacheEntryUsable(persistent, title, artist) : null;
  if (perHit) {
    smtcLyricSourceMemoryCache[normKey] = persistent;
    console.log('[LYRICS] persistent cache HIT source=' + smtcLyricSourceName(persistent.source));
    return { response: persistent.response, source: persistent.source, synthetic: perHit.synthetic, fromCache: true };
  }

  // 3) 按优先级依次尝试 (任一失败 -> 下一源)
  var sources = smtcEnabledLyricSourceList();
  if (!sources.length) {
    console.log('[LYRICS] all sources disabled');
    return null;
  }
  var queries = smtcLyricQueries(title, artist);
  for (var i = 0; i < sources.length; i++) {
    if (seq !== smtcLyricState.seq) return null;
    var impl = smtcLyricSourceImpls[sources[i].id];
    if (!impl) continue;
    var sourceName = sources[i].name;
    console.log('[LYRICS] trying source=' + sourceName);
    var candidate = null;
    for (var qi = 0; qi < queries.length; qi++) {
      if (seq !== smtcLyricState.seq) return null;
      candidate = await impl.search(queries[qi]);
      if (candidate) break;
    }
    if (seq !== smtcLyricState.seq) return null;
    if (!candidate) {
      console.log('[LYRICS] ' + sourceName + ' no result');
      continue;
    }
    var synthetic = smtcLyricSyntheticForCandidate(sources[i].id, candidate, title, artist);
    var response = await impl.getLyrics(candidate, synthetic);
    if (seq !== smtcLyricState.seq) return null;
    if (!response) {
      console.log('[LYRICS] ' + sourceName + ' fetch failed');
      continue;
    }
    var state = null;
    try {
      state = parseLyricResponseToOriginalState(synthetic, response);
    } catch (e) {
      state = null; // 歌词格式解析失败 -> 视为不可用, 进入下一源
    }
    if (!state || !state.usableLyric) {
      console.log('[LYRICS] ' + sourceName + ' empty lyric');
      continue;
    }
    console.log('[LYRICS] ' + sourceName + ' matched');
    var entry = {
      source: sources[i].id,
      matchedTitle: String(candidate.name || candidate.title || ''),
      matchedArtist: String(candidate.artist || ''),
      timestamp: Date.now(),
      response: response,
      synthetic: synthetic,
    };
    smtcLyricSourceMemoryCache[normKey] = entry;
    smtcLyricWritePersistentCache(normKey, entry);
    try { writePersistentLyricCache(synthetic, response); } catch (e) { }
    console.log('[LYRICS] selected source=' + sourceName);
    return { response: response, source: sources[i].id, synthetic: synthetic, fromCache: false };
  }
  console.log('[LYRICS] all sources failed');
  return null;
}

// ---------- 翻译补齐: 主源无翻译时从网易云补 (SMTC 路径, seq 保护) ----------
// QQ/酷狗对部分歌曲(尤其英文歌)不返回翻译; 网易云 tlyric 通常可用。
// 复用现有 buildLyricTranslationPayload + attachLyricTranslations,
// 不阻塞原文显示, 竞态由 seq 校验 (A 的晚到翻译不会覆盖 B)。
var smtcTranslationSupplementDone = {};
async function smtcSupplementNeteaseTranslation(title, artist, seq) {
  try {
    var normKey = smtcLyricNormKey(title, artist);
    if (!normKey || smtcTranslationSupplementDone[normKey]) return false;
    smtcTranslationSupplementDone[normKey] = true; // 会话内每首歌只补一次
    if (typeof buildLyricTranslationPayload !== 'function' || typeof attachLyricTranslations !== 'function') return false;
    if (seq !== smtcLyricState.seq) return false;
    var queries = smtcLyricQueries(title, artist);
    var candidate = null;
    for (var i = 0; i < queries.length; i++) {
      if (seq !== smtcLyricState.seq) return false;
      candidate = await smtcLyricSourceImpls.netease.search(queries[i]);
      if (candidate) break;
    }
    if (seq !== smtcLyricState.seq || !candidate || !candidate.id) return false;
    var synthetic = smtcLyricSyntheticForCandidate('netease', candidate, title, artist);
    var response = await smtcLyricSourceImpls.netease.getLyrics(candidate, synthetic);
    if (seq !== smtcLyricState.seq || !response) return false;
    var payload = buildLyricTranslationPayload(response);
    if (!payload || !payload.lines || !payload.lines.length) return false;
    if (seq !== smtcLyricState.seq) return false;
    var current = (typeof originalLyricsState === 'object' && originalLyricsState) ? originalLyricsState : null;
    if (!current || !current.lines || !current.lines.length) return false;
    var merged = attachLyricTranslations(current.lines, payload.lines);
    if (!merged.some(function (line) { return line && line.translation; })) return false;
    if (seq !== smtcLyricState.seq) return false;
    setOriginalLyricsState(merged, current.hasNativeKaraoke, current.timingSource, payload.lines, 'netease-supplement');
    applyOriginalLyricsState({ reason: 'smtc-translation-supplement' });
    console.log('[LYRICS] translation supplemented from 网易云音乐 (' + payload.lines.length + ' lines)');
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- 设置 UI (触发按钮 + 优先级面板: 拖动排序/启用禁用/恢复默认) ----------
var smtcLyricSettingsDragId = '';
var smtcLyricSettingsReloadTimer = 0;

function smtcScheduleLyricReloadAfterSettingsChange() {
  if (smtcLyricSettingsReloadTimer) clearTimeout(smtcLyricSettingsReloadTimer);
  smtcLyricSettingsReloadTimer = setTimeout(function () {
    smtcLyricSettingsReloadTimer = 0;
    if (smtcStore && smtcStore.active && typeof smtcLoadLyrics === 'function') {
      smtcLoadLyrics(); // 按新优先级立即重试当前歌曲 (seq 防竞态)
    }
  }, 350);
}

function smtcEnsureLyricSourceUi() {
  if (document.getElementById('smtc-lyric-source-btn')) return;
  var btn = document.createElement('button');
  btn.id = 'smtc-lyric-source-btn';
  btn.textContent = '词源';
  btn.title = '歌词源优先级设置';
  btn.style.cssText = [
    'position:fixed', 'top:230px', 'right:16px', 'z-index:4797',
    'padding:4px 10px', 'border-radius:8px', 'font-size:11px',
    'color:rgba(255,255,255,0.78)', 'background:rgba(14,16,18,0.82)',
    'border:1px solid rgba(255,255,255,0.10)', 'cursor:pointer', 'user-select:none',
  ].join(';');
  btn.addEventListener('click', function () { smtcToggleLyricSourcePanel(); });
  document.body.appendChild(btn);

  var panel = document.createElement('div');
  panel.id = 'smtc-lyric-source-panel';
  panel.style.cssText = [
    'position:fixed', 'top:264px', 'right:16px', 'z-index:4796',
    'width:216px', 'padding:8px', 'border-radius:10px',
    'color:rgba(255,255,255,0.85)', 'background:rgba(14,16,18,0.92)',
    'border:1px solid rgba(255,255,255,0.12)', 'display:none',
    'font-size:11px', 'line-height:1.5', 'user-select:none',
  ].join(';');
  document.body.appendChild(panel);
  smtcRenderLyricSourcePanel();
}

function smtcToggleLyricSourcePanel() {
  var panel = document.getElementById('smtc-lyric-source-panel');
  if (!panel) { smtcEnsureLyricSourceUi(); panel = document.getElementById('smtc-lyric-source-panel'); }
  if (!panel) return;
  var visible = panel.style.display === 'block';
  panel.style.display = visible ? 'none' : 'block';
  if (!visible) smtcRenderLyricSourcePanel();
}

function smtcLyricSourceRow(panel, settings, id) {
  var name = SMTC_LYRIC_SOURCES[id] ? SMTC_LYRIC_SOURCES[id].name : id;
  var row = document.createElement('div');
  row.setAttribute('draggable', 'true');
  row.style.cssText = [
    'display:flex', 'align-items:center', 'gap:6px', 'padding:4px 6px',
    'margin:2px 0', 'border-radius:6px', 'background:rgba(255,255,255,0.06)',
    'cursor:grab',
  ].join(';');
  var handle = document.createElement('span');
  handle.textContent = '≡';
  handle.style.cssText = 'opacity:0.5;cursor:grab;';
  var label = document.createElement('span');
  label.textContent = name;
  label.style.cssText = 'flex:1;';
  var cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = settings.enabled[id] !== false;
  cb.style.cssText = 'cursor:pointer;';
  cb.addEventListener('change', function () {
    var s = smtcLyricSourceSettings();
    s.enabled[id] = cb.checked;
    smtcSaveLyricSourceSettings(s);
    smtcRenderLyricSourcePanel();
    smtcScheduleLyricReloadAfterSettingsChange();
  });
  row.appendChild(handle);
  row.appendChild(label);
  row.appendChild(cb);
  row.addEventListener('dragstart', function (e) {
    smtcLyricSettingsDragId = id;
    row.style.opacity = '0.4';
    try { e.dataTransfer.setData('text/plain', id); } catch (err) { }
  });
  row.addEventListener('dragend', function () {
    row.style.opacity = '';
    smtcRenderLyricSourcePanel();
  });
  row.addEventListener('dragover', function (e) { e.preventDefault(); });
  row.addEventListener('drop', function (e) {
    e.preventDefault();
    var fromId = smtcLyricSettingsDragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
    var toId = id;
    if (!fromId || fromId === toId) return;
    var s = smtcLyricSourceSettings();
    var from = s.order.indexOf(fromId);
    var to = s.order.indexOf(toId);
    if (from < 0 || to < 0) return;
    s.order.splice(from, 1);
    s.order.splice(to, 0, fromId);
    smtcSaveLyricSourceSettings(s);
    smtcRenderLyricSourcePanel();
    smtcScheduleLyricReloadAfterSettingsChange();
  });
  panel.appendChild(row);
}

function smtcRenderLyricSourcePanel() {
  var panel = document.getElementById('smtc-lyric-source-panel');
  if (!panel) return;
  panel.innerHTML = '';
  var settings = smtcLyricSourceSettings();
  var title = document.createElement('div');
  title.textContent = '歌词源优先级';
  title.style.cssText = 'font-weight:700;margin:0 0 4px 2px;opacity:0.9;';
  panel.appendChild(title);
  settings.order.forEach(function (id) {
    if (!SMTC_LYRIC_SOURCES[id]) return;
    smtcLyricSourceRow(panel, settings, id);
  });
  var hint = document.createElement('div');
  hint.textContent = '拖动排序 · 取消勾选禁用';
  hint.style.cssText = 'margin:4px 2px;opacity:0.45;font-size:10px;';
  panel.appendChild(hint);
  var reset = document.createElement('button');
  reset.textContent = '恢复默认顺序';
  reset.style.cssText = [
    'width:100%', 'margin-top:4px', 'padding:4px 0', 'border-radius:6px',
    'font-size:11px', 'color:rgba(255,255,255,0.8)',
    'background:rgba(255,255,255,0.08)', 'border:1px solid rgba(255,255,255,0.14)',
    'cursor:pointer',
  ].join(';');
  reset.addEventListener('click', function () {
    smtcResetLyricSourceSettings();
    smtcRenderLyricSourcePanel();
    smtcScheduleLyricReloadAfterSettingsChange();
  });
  panel.appendChild(reset);
}

smtcEnsureLyricSourceUi();
