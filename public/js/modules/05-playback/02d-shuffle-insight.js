// 05-playback/02d-shuffle-insight.js
// ============================================================
// Smart Shuffle 主页洞察 —— **纯只读**
//
// 这个模块只做两件事: 从**已有聚合**推导学习进度, 用**已有评分/冷却函数**算一份可展示的
// 推荐预览。它绝不能:
//   · 发起网络请求(候选池只读 smartShuffleCachedPool() 的缓存; 空就是空)
//   · 调用 playQueueAt / 修改 playQueue / 写事件表 / 消耗 rng
//   · 重新实现候选筛选、评分、冷却、跨源去重 —— 全部复用 02c
//
// 学习进度只来自 playEvents 的内存聚合(四源桶 + SMTC 外部桶 + 艺人桶),
// 不新增统计体系, 不用前端访问次数/刷新次数推进。
// ============================================================

// 学习完成门槛 —— **唯一配置点**。五项全部达标 + 候选池够大 才算学习完成。
// 依据: 两周观察期的目的是"数据成熟", 所以门槛按**样本量**定, 不按天数。
function smartShuffleLearningTargets() {
  return {
    effectivePlays: 120,    // 有效播放(完整 + 跳过各算一次)
    distinctSongs: 40,      // 不同歌曲数
    distinctArtists: 12,    // 不同艺人数
    completionSignals: 30,  // 完播样本(正反馈)
    skipSignals: 8,         // 早跳样本(负反馈; 没有负反馈的模型不可信)
    poolSize: 200,          // 候选池下限, 太小的话推荐没有意义
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

// 只读快照: 真实计数 + 百分比。**同一次调用内纯函数**, 重复调用不会改变任何状态。
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
  var weightSum = 0;
  var ratioSum = 0;
  var allMet = true;
  metrics.forEach(function (m) {
    var ratio = m.target > 0 ? Math.min(1, Math.max(0, m.value / m.target)) : 1;
    m.ratio = ratio;
    ratioSum += ratio * m.weight;
    weightSum += m.weight;
    if (m.value < m.target) allMet = false;
  });
  var progress = weightSum > 0 ? ratioSum / weightSum : 0;
  var percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
  // 两件事必须分开判断: "样本学够了" 与 "候选池够用"。
  // 前者 = 学习完成; 后者才允许出推荐(池空/太小 -> 等待可用候选, 不伪造推荐)。
  var samplesMet = allMet;
  var poolMet = pool.length >= targets.poolSize;
  var ready = samplesMet && poolMet;
  return {
    ready: ready,
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

// 推荐理由: 只从**评分明细**里已有的特征生成, 不编造。
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

// 推荐预览: 复用 02c 的 scoreCandidate / applyCooldown, 对**缓存池**打分。
// 不调用 planSmartShuffleInsertions / buildShuffleOrder(那两条会产出队列计划),
// 也**不消耗 rng**: 按分数确定性排序, 所以反复渲染结果稳定。
function smartShuffleHomeRecommendation(limit) {
  var pool = (typeof smartShuffleCachedPool === 'function') ? smartShuffleCachedPool() : [];
  // 发现候选是**单独缓存**的(composePool 的临时合并结果不会回写池缓存),
  // 出推荐前必须把它并进来, 否则永远只有资料库的歌。
  var discoveryList = (smartShuffleInsightDiscovery && Array.isArray(smartShuffleInsightDiscovery.list))
    ? smartShuffleInsightDiscovery.list : [];
  if (!pool.length && !discoveryList.length) return { ok: false, reason: 'pool-empty', songs: [] };
  var candidates = pool.slice();
  if (discoveryList.length) {
    var seenSig = Object.create(null);
    pool.forEach(function (c) { var s = shuffleSongSignature(c); if (s) seenSig[s] = true; });
    discoveryList.forEach(function (c) {
      var sig = shuffleSongSignature(c);
      if (sig && seenSig[sig]) return;   // 库内已有的不重复加(composePool 已防过一次)
      if (sig) seenSig[sig] = true;
      candidates.push(c);
    });
  }
  if (!candidates.length) return { ok: false, reason: 'pool-empty', songs: [] };
  if (typeof scoreCandidate !== 'function' || typeof applyCooldown !== 'function') {
    return { ok: false, reason: 'scoring-unavailable', songs: [] };
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
  if (!kept.length) return { ok: false, reason: 'all-cooled', songs: [], poolSize: candidates.length };

  var sorted = kept.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
  var max = Math.max(1, Math.min(6, Math.round(Number(limit) || 3)));

  // 分两桶: 资料库内的歌 / 资料库外的发现歌。
  // 发现歌没有播放历史, 分数天然低于熟悉的歌 —— 只按分数取 top-N 会永远是资料库,
  // 所以要**分别取**: 一首资料库 + 一首资料库外(不足时互相补齐)。
  var buckets = { library: [], discovery: [] };
  for (var b = 0; b < sorted.length; b++) {
    var entryB = sorted[b];
    var candB = (entryB && entryB.candidate) || {};
    if (!candB.name || !candB.artist) continue;
    buckets[smartShuffleIsDiscoveryCandidate(candB) ? 'discovery' : 'library'].push(entryB);
  }
  var songs = [];
  var usedArtist = Object.create(null);
  var usedEntry = Object.create(null);

  function takeFrom(list) {
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!entry || usedEntry[entry.key]) continue;
      var candidate = entry.candidate || {};
      if (!candidate.name || !candidate.artist) continue;
      var artistKey = (entry.meta && entry.meta.artistKey) || '';
      if (artistKey && usedArtist[artistKey]) continue;   // 同一条推荐里不重复艺人
      usedEntry[entry.key] = true;
      if (artistKey) usedArtist[artistKey] = true;
      songs.push({
        key: String(entry.key || ''),
        name: String(candidate.name),
        artist: String(candidate.artist),
        album: String(candidate.album || ''),
        cover: String(candidate.cover || ''),
        provider: String(candidate.provider || ''),
        reason: smartShuffleHomeReason(entry),
        // 展示用: 这首歌来自资料库还是"资料库外的新发现"
        source: smartShuffleIsDiscoveryCandidate(candidate) ? 'discovery' : 'library',
        song: candidate,
        playKey: String(entry.key || ''),
        fingerprint: String(candidate.fingerprint || ''),
      });
      return true;
    }
    return false;
  }

  if (max >= 2) {
    takeFrom(buckets.library);    // 先保证一首资料库内的
    takeFrom(buckets.discovery);  // 再保证一首资料库外的
  }
  while (songs.length < max) {
    var gotLibrary = takeFrom(buckets.library);
    var gotDiscovery = gotLibrary ? false : takeFrom(buckets.discovery);
    if (!gotLibrary && !gotDiscovery) break;
  }

  if (!songs.length) return { ok: false, reason: 'no-displayable', songs: [] };
  return { ok: true, reason: 'ok', songs: songs, poolSize: candidates.length };
}

// 主页用的带缓存版本。
// 关键取舍: **进度每次实时算**(只遍历内存聚合, 便宜), 只有"全池打分"走缓存。
// 否则事件表重建后进度要被 60 秒缓存卡住, 用户会看到过期的百分比。
var smartShuffleInsightCache = { at: 0, rec: null };

function smartShuffleHomeInsightCached(limit, ttlMs) {
  var snapshot = smartShuffleLearningSnapshot();
  var base = { progress: snapshot.percent, snapshot: snapshot, songs: [], fallback: 'not-ready' };
  if (!snapshot.ready) { base.phase = 'learning'; return base; }
  var ttl = Math.max(1000, Number(ttlMs) || 60000);
  var now = Date.now();
  if (!smartShuffleInsightCache.rec || now - smartShuffleInsightCache.at >= ttl) {
    var rec = null;
    try { rec = smartShuffleHomeRecommendation(limit); } catch (err) { rec = null; }
    smartShuffleInsightCache = { at: now, rec: rec };
  }
  var cached = smartShuffleInsightCache.rec;
  if (!cached || !cached.ok) {
    base.phase = 'learning';
    base.fallback = (cached && cached.reason) || 'recommendation-unavailable';
    return base;
  }
  base.phase = 'ready';
  base.fallback = '';
  base.songs = cached.songs;
  return base;
}

// 供事件表重建后强制重算推荐(进度本来就实时, 只需清推荐缓存)
function smartShuffleHomeInsightInvalidate() {
  smartShuffleInsightCache = { at: 0, rec: null };
}

try {
  window.smartShuffleHomeInsight = smartShuffleHomeInsight;
  window.smartShuffleHomeInsightCached = smartShuffleHomeInsightCached;
  window.smartShuffleHomeInsightInvalidate = smartShuffleHomeInsightInvalidate;
  window.smartShuffleEnsurePoolCached = smartShuffleEnsurePoolCached;
  window.smartShuffleEnsureDiscoveryCached = smartShuffleEnsureDiscoveryCached;
} catch (e) { }

// ------------------------------------------------------------
// 池缓存的**按需填充**(主页专用)
// ------------------------------------------------------------
// 候选池缓存只由探针/手动入口填充, 而探针要求"有歌开始播" —— 用户重启后只看主页时缓存是空的,
// 卡片就会一直停在"等待候选"。这里走**同一条既有数据通路** smartShuffleFetchPool()
// (10 分钟 TTL + in-flight 去重), 它是纯数据读取: 不产生播放决策, 不改队列, 不动冷却。
// 注意: 与上面的 insight 函数分开 —— insight 仍然保证"零网络、零副作用"(有测试钉住)。
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
      smartShuffleHomeInsightInvalidate();
      return !!(Array.isArray(list) && list.length);
    })
    .catch(function () {
      smartShuffleEnsurePoolInflight = null;
      return false;
    });
  return smartShuffleEnsurePoolInflight;
}

// ------------------------------------------------------------
// 发现候选缓存(主页专用)
// ------------------------------------------------------------
// 候选池缓存里只有**资料库**的歌; 发现歌是 smartShuffleComposePool 临时合并出来的,
// 不会回写缓存。主页要展示"一首资料库 + 一首资料库外", 就得自己取一次发现候选。
// 复用既有的 composePool(内部走 similar / artist-more 两个只读接口, 各自有 TTL 缓存),
// 只把其中的发现候选留下来缓存 10 分钟。同样是纯数据读取, 不产生播放决策。
var SMART_SHUFFLE_INSIGHT_DISCOVERY_TTL_MS = 10 * 60 * 1000;
var smartShuffleInsightDiscovery = { at: 0, list: [] };
var smartShuffleInsightDiscoveryInflight = null;

function smartShuffleIsDiscoveryCandidate(candidate) {
  var src = candidate && candidate.candidateSource;
  return src === 'similar' || src === 'artist-more';
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
      smartShuffleHomeInsightInvalidate();
      return list;
    })
    .catch(function () {
      smartShuffleInsightDiscovery = { at: Date.now(), list: [] };
      smartShuffleInsightDiscoveryInflight = null;
      return [];
    });
  return smartShuffleInsightDiscoveryInflight;
}

// 播放能力探测: 「算出了歌」≠「能安全播这首歌」, 两条能力分别验证。
// 入口必须存在, 且交给它的必须是带稳定身份的歌曲对象。
function smartShufflePlayEntryAvailable() {
  return typeof playSongEntry === 'function' && typeof queueItemKey === 'function';
}

// 把快照 + 推荐结果组装成主页要的 4 种状态:
//   learning     : 样本不足        -> 显示进度
//   pool-pending : 样本够但没候选  -> 等待可用候选
//   ready        : 有推荐          -> canPlay 决定是否给播放操作
function smartShuffleComposeHomeInsight(snapshot, rec) {
  var base = { progress: snapshot.percent, snapshot: snapshot, songs: [], canPlay: false, fallback: '' };
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
  if (!rec || !rec.ok) {
    base.phase = 'pool-pending';
    base.fallback = (rec && rec.reason) || 'recommendation-unavailable';
    return base;
  }
  base.phase = 'ready';
  base.songs = rec.songs;
  base.canPlay = smartShufflePlayEntryAvailable() && rec.songs.every(function (s) {
    return !!(s && s.song && s.playKey);
  });
  return base;
}

function smartShuffleHomeInsight(limit) {
  var snapshot = smartShuffleLearningSnapshot();
  if (!snapshot.samplesMet || !snapshot.poolMet) return smartShuffleComposeHomeInsight(snapshot, null);
  return smartShuffleComposeHomeInsight(snapshot, smartShuffleHomeRecommendation(limit));
}

// 主页用的带缓存版本: **进度每次实时算**(只遍历内存聚合), 只有"全池打分"走节流。
// 否则事件表重建后进度要被缓存卡住, 用户会看到过期百分比。
var smartShuffleInsightCache = { at: 0, rec: null };

function smartShuffleHomeInsightCached(limit, ttlMs) {
  var snapshot = smartShuffleLearningSnapshot();
  if (!snapshot.samplesMet || !snapshot.poolMet) return smartShuffleComposeHomeInsight(snapshot, null);
  var ttl = Math.max(1000, Number(ttlMs) || 60000);
  var now = Date.now();
  if (!smartShuffleInsightCache.rec || now - smartShuffleInsightCache.at >= ttl) {
    var rec = null;
    try { rec = smartShuffleHomeRecommendation(limit); } catch (err) { rec = null; }
    smartShuffleInsightCache = { at: now, rec: rec };
  }
  return smartShuffleComposeHomeInsight(snapshot, smartShuffleInsightCache.rec);
}

// 事件表重建后强制重算推荐(进度本来就实时, 只需清推荐缓存)
function smartShuffleHomeInsightInvalidate() {
  smartShuffleInsightCache = { at: 0, rec: null };
}

try {
  window.smartShuffleHomeInsight = smartShuffleHomeInsight;
  window.smartShuffleHomeInsightCached = smartShuffleHomeInsightCached;
  window.smartShuffleHomeInsightInvalidate = smartShuffleHomeInsightInvalidate;
} catch (e) { }
