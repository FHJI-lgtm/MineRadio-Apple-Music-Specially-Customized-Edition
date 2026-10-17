// 05-playback/02d-shuffle-insight.js
// ============================================================
// Smart Shuffle 主页洞察 —— **纯只读**
//
// 两件事: 从已有聚合推导学习进度; 复用 02c 的评分/冷却算一份**每日冻结**的推荐。
// 绝不能: 发起播放决策、改 playQueue、写事件表、消耗 rng、重写候选筛选/评分/冷却/去重。
//
// 每日冻结(localStorage: mineradio-smart-shuffle-daily-v1)
//   { day: 'YYYY-MM-DD', songs: [...], failed: [key], pickedAt, updatedAt }
//   · 当天首次生成后不再变; 跨天重新生成
//   · 某首失效(播放失败)时**只替换那一首**, 不重算整张表
// ============================================================

var SMART_SHUFFLE_DAILY_STORE_KEY = 'mineradio-smart-shuffle-daily-v1';

// 学习完成门槛 —— **唯一配置点**。五项样本全部达标 **且** 候选池够大, 才算学完。
// 依据: 两周观察期的目的是"数据成熟", 所以门槛按**样本量**定, 不按天数。
function smartShuffleLearningTargets() {
  return {
    effectivePlays: 120,
    distinctSongs: 40,
    distinctArtists: 12,
    completionSignals: 30,
    skipSignals: 8,
    poolSize: 200,
  };
}

function smartShufflePlayedBuckets() {
  var maps = (typeof shuffleStatsMaps === 'function') ? shuffleStatsMaps() : {};
  return {
    songStats: (maps && maps.songStats) || {},
    signatureStats: (maps && maps.signatureStats) || {},
    artistStats: (maps && maps.artistStats) || {},
    looseStats: (maps && maps.looseStats) || {},
  };
}

// 只读快照: 真实计数 + 百分比。同一次调用内是纯函数, 重复调用不改变任何状态。
function smartShuffleLearningSnapshot() {
  var targets = smartShuffleLearningTargets();
  var buckets = smartShufflePlayedBuckets();
  var plays = 0, completed = 0, earlySkips = 0, listenMs = 0;
  function fold(map) {
    var keys = Object.keys(map || {});
    for (var i = 0; i < keys.length; i++) {
      var s = map[keys[i]] || {};
      plays += Number(s.plays) || 0;
      completed += Number(s.completed) || 0;
      earlySkips += Number(s.earlySkips) || 0;
      listenMs += Number(s.listenMs) || 0;
    }
  }
  fold(buckets.songStats);
  fold(buckets.signatureStats);
  var distinctSongs = Object.keys(buckets.songStats).length + Object.keys(buckets.signatureStats).length;
  var distinctArtists = Object.keys(buckets.artistStats).length;
  var pool = (typeof smartShuffleCachedPool === 'function') ? smartShuffleCachedPool() : [];

  var metrics = [
    { key: 'effectivePlays', label: '有效播放', value: plays, target: targets.effectivePlays, weight: 0.35 },
    { key: 'distinctSongs', label: '覆盖歌曲', value: distinctSongs, target: targets.distinctSongs, weight: 0.20 },
    { key: 'distinctArtists', label: '覆盖艺人', value: distinctArtists, target: targets.distinctArtists, weight: 0.15 },
    { key: 'completionSignals', label: '完播样本', value: completed, target: targets.completionSignals, weight: 0.20 },
    { key: 'skipSignals', label: '早跳样本', value: earlySkips, target: targets.skipSignals, weight: 0.10 },
  ];
  var weightSum = 0, ratioSum = 0, allMet = true;
  metrics.forEach(function (m) {
    var ratio = m.target > 0 ? Math.min(1, Math.max(0, m.value / m.target)) : 1;
    m.ratio = ratio;
    ratioSum += ratio * m.weight;
    weightSum += m.weight;
    if (m.value < m.target) allMet = false;
  });
  var progress = weightSum > 0 ? ratioSum / weightSum : 0;
  var percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
  var samplesMet = allMet;
  var poolMet = pool.length >= targets.poolSize;
  return {
    ready: samplesMet && poolMet,
    samplesMet: samplesMet,
    poolMet: poolMet,
    percent: percent,
    poolSize: pool.length,
    plays: plays,
    completed: completed,
    earlySkips: earlySkips,
    listenMs: listenMs,
    distinctSongs: distinctSongs,
    distinctArtists: distinctArtists,
    metrics: metrics,
    targets: targets,
  };
}

// ------------------------------------------------------------
// 每日冻结存储
// ------------------------------------------------------------
var smartShuffleDailyMemory = null;

function smartShuffleDailyKey(timestamp) {
  var d = new Date(Number(timestamp) || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function smartShuffleDailyRead() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return smartShuffleDailyMemory;
    var raw = localStorage.getItem(SMART_SHUFFLE_DAILY_STORE_KEY);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return smartShuffleDailyMemory;
  }
}

function smartShuffleDailyWrite(store) {
  smartShuffleDailyMemory = store;
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return false;
    localStorage.setItem(SMART_SHUFFLE_DAILY_STORE_KEY, JSON.stringify(store));
    return true;
  } catch (e) {
    return false;
  }
}

// 某首推荐播放失败 -> 当天把它从冻结列表里摘掉并记入 failed, 下次渲染只补这一首。
function smartShuffleDailyMarkFailed(key) {
  key = String(key || '');
  if (!key) return false;
  var store = smartShuffleDailyRead();
  if (!store || store.day !== smartShuffleDailyKey()) return false;
  var before = Array.isArray(store.songs) ? store.songs.length : 0;
  store.songs = (Array.isArray(store.songs) ? store.songs : []).filter(function (s) {
    return s && s.key !== key;
  });
  store.failed = Array.isArray(store.failed) ? store.failed.slice() : [];
  if (store.failed.indexOf(key) < 0) store.failed.push(key);
  store.updatedAt = Date.now();
  smartShuffleDailyWrite(store);
  return store.songs.length !== before;
}

// ------------------------------------------------------------
// 候选 -> 打分 -> 分两桶(资料库 / 资料库外)
// ------------------------------------------------------------
function smartShuffleIsDiscoveryCandidate(candidate) {
  var src = candidate && candidate.candidateSource;
  return src === 'similar' || src === 'artist-more';
}

function smartShuffleHomeReason(entry) {
  var candidate = (entry && entry.candidate) || {};
  var breakdown = (entry && entry.breakdown) || {};
  var features = breakdown.features || {};
  if (candidate.candidateSource === 'artist-more') return '和你常听的艺人同一路线，你可能还没收过';
  if (candidate.candidateSource === 'similar') return '和资料库里的歌很像，你可能没听过';
  if ((Number(breakdown.plays) || 0) >= 3 && (Number(features.completion) || 0) >= 0.7) return '你经常把这类歌完整听完';
  if ((Number(features.affinity) || 0) >= 0.4) return '你常听这首歌';
  if ((Number(features.recency) || 0) >= 0.8) return '有一阵没听了，正好回来';
  if ((Number(features.novelty) || 0) >= 0.6) return '来自你的歌单，还没怎么听过';
  return '来自你收藏的歌单';
}

function smartShuffleMakeSong(entry, sourceLabel) {
  var candidate = (entry && entry.candidate) || {};
  return {
    key: String((entry && entry.key) || ''),
    name: String(candidate.name || ''),
    artist: String(candidate.artist || ''),
    album: String(candidate.album || ''),
    cover: String(candidate.cover || ''),
    provider: String(candidate.provider || ''),
    reason: smartShuffleHomeReason(entry),
    source: sourceLabel === 'discovery' ? 'discovery' : 'library',
    song: candidate,
    playKey: String((entry && entry.key) || ''),
    fingerprint: String(candidate.fingerprint || ''),
  };
}

// 打分 + 冷却 + 分桶。不消耗 rng: 按分数确定性排序, 同一天重复计算结果一致。
function smartShuffleHomeBuckets(limit, exclude) {
  var pool = (typeof smartShuffleCachedPool === 'function') ? smartShuffleCachedPool() : [];
  var discoveryList = (smartShuffleInsightDiscovery && Array.isArray(smartShuffleInsightDiscovery.list))
    ? smartShuffleInsightDiscovery.list : [];
  var candidates = pool.slice();
  if (discoveryList.length) {
    var seenSig = Object.create(null);
    pool.forEach(function (c) { var s = shuffleSongSignature(c); if (s) seenSig[s] = true; });
    discoveryList.forEach(function (c) {
      var sig = shuffleSongSignature(c);
      if (sig && seenSig[sig]) return;
      if (sig) seenSig[sig] = true;
      candidates.push(c);
    });
  }
  var empty = { ok: false, library: [], discovery: [], poolSize: candidates.length };
  if (!candidates.length) return Object.assign({}, empty, { reason: 'pool-empty' });
  if (typeof scoreCandidate !== 'function' || typeof applyCooldown !== 'function') {
    return Object.assign({}, empty, { reason: 'scoring-unavailable' });
  }
  var cfg = (typeof readShuffleConfig === 'function') ? readShuffleConfig() : { weights: null };
  var buckets = smartShufflePlayedBuckets();
  var recent = (typeof shuffleRecentContext === 'function') ? shuffleRecentContext({}) : {};
  var ctx = {
    now: Date.now(),
    weights: cfg.weights,
    songStats: buckets.songStats,
    artistStats: buckets.artistStats,
    signatureStats: buckets.signatureStats,
    looseStats: buckets.looseStats,
    artistStatsByKey: (typeof shuffleArtistIndex === 'function') ? shuffleArtistIndex(buckets.artistStats) : null,
    recentKeys: recent.recentKeys || [],
    recentArtists: recent.recentArtists || [],
    recentAlbums: recent.recentAlbums || [],
  };
  var scored = candidates.map(function (candidate) { return scoreCandidate(candidate, ctx); });
  var gate = applyCooldown(scored, ctx);
  var kept = (gate && gate.kept) || [];
  if (!kept.length) return Object.assign({}, empty, { reason: 'all-cooled' });
  var sorted = kept.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
  var excludeMap = exclude || {};
  var out = { library: [], discovery: [], poolSize: candidates.length };
  for (var i = 0; i < sorted.length; i++) {
    var entry = sorted[i];
    var key = String((entry && entry.key) || '');
    if (key && excludeMap[key]) continue;
    var candidate = (entry && entry.candidate) || {};
    if (!candidate.name || !candidate.artist) continue;
    out[smartShuffleIsDiscoveryCandidate(candidate) ? 'discovery' : 'library'].push(entry);
  }
  if (!out.library.length && !out.discovery.length) {
    return { ok: false, reason: 'no-displayable', library: [], discovery: [], poolSize: candidates.length };
  }
  out.ok = true;
  return out;
}

// 组装: 保留 existing, 补齐到 limit。优先"一首资料库 + 一首资料库外", 某桶不足用另一桶补。
function smartShuffleFillSongs(existing, buckets, limit) {
  var max = Math.max(1, Math.min(6, Math.round(Number(limit) || 3)));
  var lib = (buckets && Array.isArray(buckets.library)) ? buckets.library : [];
  var disc = (buckets && Array.isArray(buckets.discovery)) ? buckets.discovery : [];
  var songs = (Array.isArray(existing) ? existing : []).filter(function (s) {
    return s && s.name && s.artist;
  }).slice(0, max);
  var usedKey = Object.create(null);
  var usedArtist = Object.create(null);
  songs.forEach(function (s) {
    if (s.key) usedKey[s.key] = true;
    var a = shuffleArtistPrimary(s.artist);
    if (a) usedArtist[a] = true;
  });
  function countSource(src) {
    var n = 0;
    songs.forEach(function (s) { if (s && s.source === src) n += 1; });
    return n;
  }
  function take(list, label) {
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i];
      if (!entry) continue;
      var key = String(entry.key || '');
      if (key && usedKey[key]) continue;
      var candidate = entry.candidate || {};
      if (!candidate.name || !candidate.artist) continue;
      var artistKey = (entry.meta && entry.meta.artistKey) || '';
      if (artistKey && usedArtist[artistKey]) continue;
      if (key) usedKey[key] = true;
      if (artistKey) usedArtist[artistKey] = true;
      songs.push(smartShuffleMakeSong(entry, label));
      return true;
    }
    return false;
  }
  if (max >= 2 && songs.length < max && countSource('library') < 1) take(lib, 'library');
  if (max >= 2 && songs.length < max && countSource('discovery') < 1) take(disc, 'discovery');
  while (songs.length < max) {
    var ok = take(lib, 'library');
    if (!ok) ok = take(disc, 'discovery');
    if (!ok) break;
  }
  return songs;
}

// 即时推荐(不冻结)。与"每日生成"共用同一条打分/组装逻辑。
function smartShuffleHomeRecommendation(limit) {
  var max = Math.max(1, Math.min(6, Math.round(Number(limit) || 3)));
  var buckets = smartShuffleHomeBuckets(max);
  if (!buckets.ok) return { ok: false, reason: buckets.reason || 'unavailable', songs: [], poolSize: buckets.poolSize || 0 };
  var songs = smartShuffleFillSongs([], buckets, max);
  if (!songs.length) return { ok: false, reason: 'no-displayable', songs: [] };
  return { ok: true, reason: 'ok', songs: songs, poolSize: buckets.poolSize };
}

// 每日推荐: 当天冻结。跨天重新生成; 有 failed 时只补缺口, 不动已冻结的那几首。
function smartShuffleDailySongs(limit) {
  var max = Math.max(1, Math.min(6, Math.round(Number(limit) || 3)));
  var day = smartShuffleDailyKey();
  var store = smartShuffleDailyRead();
  var failed = Object.create(null);
  var existing = [];
  if (store && store.day === day) {
    (Array.isArray(store.failed) ? store.failed : []).forEach(function (k) { if (k) failed[k] = true; });
    existing = (Array.isArray(store.songs) ? store.songs : []).filter(function (s) {
      return s && s.key && !failed[s.key] && s.name && s.artist;
    }).slice(0, max);
  }
  if (existing.length >= max) {
    return { ok: true, songs: existing, day: day, pinned: true, generated: false };
  }
  var buckets = smartShuffleHomeBuckets(max, failed);
  if (!buckets.ok && !existing.length) {
    return { ok: false, reason: buckets.reason || 'unavailable', songs: [], day: day };
  }
  var songs = smartShuffleFillSongs(existing, buckets, max);
  if (!songs.length) return { ok: false, reason: 'no-displayable', songs: [], day: day };
  smartShuffleDailyWrite({
    day: day,
    songs: songs,
    failed: Object.keys(failed),
    pickedAt: (store && store.day === day && store.pickedAt) ? store.pickedAt : Date.now(),
    updatedAt: Date.now(),
  });
  return { ok: true, songs: songs, day: day, pinned: true, generated: true };
}

// ------------------------------------------------------------
// 池缓存 / 发现候选的按需填充(纯数据, 不产生播放决策)
// ------------------------------------------------------------
var smartShuffleEnsurePoolInflight = null;

function smartShuffleEnsurePoolCached() {
  var current = (typeof smartShuffleCachedPool === 'function') ? smartShuffleCachedPool() : [];
  if (current.length) return Promise.resolve(true);
  if (typeof smartShuffleFetchPool !== 'function') return Promise.resolve(false);
  if (smartShuffleEnsurePoolInflight) return smartShuffleEnsurePoolInflight;
  smartShuffleEnsurePoolInflight = Promise.resolve()
    .then(function () { return smartShuffleFetchPool(); })
    .then(function (list) {
      smartShuffleEnsurePoolInflight = null;
      return !!(Array.isArray(list) && list.length);
    })
    .catch(function () {
      smartShuffleEnsurePoolInflight = null;
      return false;
    });
  return smartShuffleEnsurePoolInflight;
}

var SMART_SHUFFLE_INSIGHT_DISCOVERY_TTL_MS = 10 * 60 * 1000;
var smartShuffleInsightDiscovery = { at: 0, list: [] };
var smartShuffleInsightDiscoveryInflight = null;

function smartShuffleDiscoveryAttempted() {
  return !!(smartShuffleInsightDiscovery && smartShuffleInsightDiscovery.at);
}

function smartShuffleEnsureDiscoveryCached(force) {
  var now = Date.now();
  if (!force && smartShuffleInsightDiscovery.at
      && now - smartShuffleInsightDiscovery.at < SMART_SHUFFLE_INSIGHT_DISCOVERY_TTL_MS) {
    return Promise.resolve(smartShuffleInsightDiscovery.list);
  }
  if (smartShuffleInsightDiscoveryInflight) return smartShuffleInsightDiscoveryInflight;
  var basePool = (typeof smartShuffleCachedPool === 'function') ? smartShuffleCachedPool() : [];
  if (!basePool.length || typeof smartShuffleComposePool !== 'function') return Promise.resolve([]);
  var cfg = (typeof readShuffleConfig === 'function') ? readShuffleConfig() : { weights: null };
  var buckets = smartShufflePlayedBuckets();
  smartShuffleInsightDiscoveryInflight = Promise.resolve()
    .then(function () { return smartShuffleComposePool(basePool, buckets, cfg.weights); })
    .then(function (composed) {
      var merged = (composed && Array.isArray(composed.pool)) ? composed.pool : [];
      var list = merged.filter(smartShuffleIsDiscoveryCandidate);
      smartShuffleInsightDiscovery = { at: Date.now(), list: list };
      smartShuffleInsightDiscoveryInflight = null;
      return list;
    })
    .catch(function () {
      smartShuffleInsightDiscovery = { at: Date.now(), list: [] };
      smartShuffleInsightDiscoveryInflight = null;
      return [];
    });
  return smartShuffleInsightDiscoveryInflight;
}

// 「算出了歌」≠「能安全播这首歌」, 两条能力分别验证。
function smartShufflePlayEntryAvailable() {
  return typeof playSongEntry === 'function' && typeof queueItemKey === 'function';
}

// ------------------------------------------------------------
// 主页四状态
// ------------------------------------------------------------
function smartShuffleComposeHomeInsight(snapshot, daily) {
  var base = { progress: snapshot.percent, snapshot: snapshot, songs: [], canPlay: false, fallback: '', pinned: false, dayKey: '' };
  if (!snapshot.samplesMet) {
    base.phase = 'learning';
    base.fallback = 'not-ready';
    return base;
  }
  if (!snapshot.poolMet) {
    base.phase = 'pool-pending';
    base.fallback = snapshot.poolSize ? 'pool-too-small' : 'pool-empty';
    return base;
  }
  if (!daily || !daily.ok) {
    base.phase = 'pool-pending';
    base.fallback = (daily && daily.reason) || 'recommendation-unavailable';
    return base;
  }
  base.phase = 'ready';
  base.songs = daily.songs;
  base.pinned = !!daily.pinned;
  base.dayKey = daily.day || '';
  base.canPlay = smartShufflePlayEntryAvailable() && daily.songs.every(function (s) {
    return !!(s && s.song && s.playKey);
  });
  return base;
}

function smartShuffleHomeInsight(limit, options) {
  options = options || {};
  var snapshot = smartShuffleLearningSnapshot();
  if (!snapshot.samplesMet || !snapshot.poolMet) return smartShuffleComposeHomeInsight(snapshot, null);
  // 生成当天推荐之前, 先确保"发现候选"已经尝试过 —— 否则会把两条资料库的歌冻结一整天。
  if (options.requireDiscoveryAttempt
      && typeof smartShuffleEnsureDiscoveryCached === 'function'
      && !smartShuffleDiscoveryAttempted()) {
    var pending = smartShuffleComposeHomeInsight(snapshot, null);
    pending.phase = 'pool-pending';
    pending.fallback = 'discovery-pending';
    return pending;
  }
  return smartShuffleComposeHomeInsight(snapshot, smartShuffleDailySongs(limit));
}

// 保留带缓存的名字(外部模块按老签名调用): 每日冻结本身已经是缓存, 这里直接委托。
function smartShuffleHomeInsightCached(limit, ttlMs, options) {
  return smartShuffleHomeInsight(limit, options);
}

// 兼容旧调用点。每日冻结后推荐不应因事件表重建而变, 所以是空操作。
function smartShuffleHomeInsightInvalidate() {
  return false;
}

try {
  window.smartShuffleHomeInsight = smartShuffleHomeInsight;
  window.smartShuffleHomeInsightCached = smartShuffleHomeInsightCached;
  window.smartShuffleHomeInsightInvalidate = smartShuffleHomeInsightInvalidate;
  window.smartShuffleEnsurePoolCached = smartShuffleEnsurePoolCached;
  window.smartShuffleEnsureDiscoveryCached = smartShuffleEnsureDiscoveryCached;
  window.smartShuffleDailySongs = smartShuffleDailySongs;
  window.smartShuffleDailyMarkFailed = smartShuffleDailyMarkFailed;
  window.smartShuffleDailyRead = smartShuffleDailyRead;
} catch (e) { }
