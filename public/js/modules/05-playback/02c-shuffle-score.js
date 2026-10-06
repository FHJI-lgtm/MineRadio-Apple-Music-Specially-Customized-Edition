// ============================================================
// 05-playback/02c-shuffle-score.js
// Smart Shuffle 评分 / 冷却 / 抽样 —— 纯函数层。
//
// 本模块无 DOM、无 IndexedDB、无播放副作用, 可在 vm 沙盒里直接单测。
//
// 【架构约定 —— 三个函数严禁合并】
//   scoreCandidate(candidate, ctx)  -> "为什么它得这个分"     (纯评分, 不知道冷却的存在)
//   selectCandidates(scored, ctx)   -> "谁被挡掉了、为什么"   (冷却/间隔过滤 + 排序)
//   weightedSample(ranked, rng)     -> "最终为什么抽中了它"   (加权随机, 不认识分数含义)
//
//   全链路 = score -> select(cooldown) -> weightedSample
//   这样调参时 scoreBreakdown 始终可独立回放, 不会被抽样随机性污染。
//
// 【安全阀 —— 最高优先级】
//   候选为空 / 全部被冷却 / 数据非法 -> 一律原样返回传入顺序, applied=false。
//   推荐系统是增强层, 绝不是播放链路的单点故障; 宁可什么都不做, 也不要把正常播放搞坏。
//
// 【模式】(localStorage: mineradio-smart-shuffle-v1)
//   'off'    默认。不计算, 不改变任何行为。
//   'shadow' 影子。照常计算并写日志/事件, 但**绝不适**用结果。(Day 0-14 用这个)
//   'on'     启用。结果真的接管队列顺序。(真实权重校准之后再开)
// ============================================================

var SMART_SHUFFLE_STORE_KEY = 'mineradio-smart-shuffle-v1';
var smartShuffleLastProbeAt = 0;
var SMART_SHUFFLE_PROBE_MIN_GAP_MS = 4000;
var SMART_SHUFFLE_PROBE_MAX_CANDIDATES = 40;

// 权重默认值。校准前一律是"先验", 不是拍脑袋的最终值。
function shuffleDefaultWeights() {
  return {
    affinity: 0.35,      // 播放频次 (log 压缩)
    completion: 0.20,    // 完整播放率 (贝叶斯平滑)
    artist: 0.15,        // 艺人亲和度
    recency: 0.10,       // 距上次播放的冷却曲线
    novelty: 0.05,       // 没听过 / 很久没听
    earlySkip: -0.30,    // 早跳率 (最强负反馈)
    source: -0.15,       // 需换源 / 试听片段 / 不可播
    tempo: 0.00,         // 预留: 本地 BPM 分析接入后再抬权
    temperature: 0.25,   // weightedSample 的 softmax 温度, 越小越贪心
    shortlistK: 30,      // 大池先按分数取 top-K 再抽样(见下方注释), 池 <=K 时不生效
    cooldownMs: 24 * 60 * 60 * 1000,
    artistGap: 3,        // 同艺人之间至少隔 N 首
    artistWindow: 20,    // 最近 N 首
    artistWindowMax: 2,  // 最近 N 首内同艺人最多出现次数
    insertionN: 3        // 每 N 首由评分接管 1 首
  };
}

function readShuffleStored() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return {};
    var raw = localStorage.getItem(SMART_SHUFFLE_STORE_KEY);
    if (!raw) return {};
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) { return {}; }
}

function readShuffleConfig() {
  var stored = readShuffleStored();
  var mode = (stored.mode === 'shadow' || stored.mode === 'on') ? stored.mode : 'off';
  var weights = Object.assign({}, shuffleDefaultWeights(),
    stored.weights && typeof stored.weights === 'object' ? stored.weights : {});
  return { mode: mode, weights: weights };
}

function writeShuffleConfig(patch) {
  if (typeof localStorage === 'undefined' || !localStorage) return false;
  var current = readShuffleStored();
  var next = Object.assign({}, current, patch || {});
  if (patch && patch.weights) {
    next.weights = Object.assign({}, current.weights || {}, patch.weights);
  }
  try { localStorage.setItem(SMART_SHUFFLE_STORE_KEY, JSON.stringify(next)); return true; }
  catch (e) { return false; }
}

function shuffleMode() { return readShuffleConfig().mode; }

// ------------------------------------------------------------
// 小工具 (纯)
// ------------------------------------------------------------
function shuffleClamp01(v) {
  v = Number(v);
  if (!isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
function shuffleClampNum(v, lo, hi, fallback) {
  v = Number(v);
  if (!isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}
// 贝叶斯平滑: 样本少时向先验收敛, 避免 1 次播放 100% 完播直接登顶
function shuffleBayesRate(success, total, prior, alpha) {
  success = Math.max(0, Number(success) || 0);
  total = Math.max(success, Number(total) || 0);
  prior = shuffleClamp01(prior == null ? 0.5 : prior);
  alpha = Number(alpha) > 0 ? Number(alpha) : 2;
  return (success + prior * alpha) / (total + alpha);
}
function shuffleArtistPrimary(name) {
  var text = String(name == null ? '' : name);
  var first = text.split(/\s*\/\s*|\s*,\s*|、|&|\s+feat\.?\s+/i)[0];
  return String(first || text).replace(/\s+/g, ' ').trim().toLowerCase();
}
// 时长归一化(秒/毫秒自动判别)。02c **自己**持有, 不依赖 02b —— 否则单独加载本模块就会 ReferenceError。
function shuffleDurationMs(song) {
  song = song || {};
  var n = Number(song.durationMs);
  if (!isFinite(n) || n <= 0) n = Number(song.duration);
  if (!isFinite(n) || n <= 0) return 0;
  return n > 10000 ? n : Math.round(n * 1000);
}

function shuffleKeyOf(song) {
  if (typeof queueItemKey === 'function') {
    try { var k = queueItemKey(song); if (k) return k; } catch (e) { }
  }
  song = song || {};
  return String(song.key || song.id || (song.name || song.title || '') + '|' + (song.artist || ''));
}
function shuffleMsAny(v) {
  var n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return n > 10000 ? n : Math.round(n * 1000); // 秒/毫秒自动判别 (与 listenSnapshotDurationMs 同规则)
}

// 把 "候选" 归一成评分需要的最小结构。
// stats 显式传入优先(单测/fixture), 否则查 ctx.songStats, 否则全 0。
function shuffleCandidateMeta(candidate, ctx) {
  candidate = candidate || {};
  var song = candidate.song || candidate;
  var key = candidate.key || shuffleKeyOf(song);
  // stats 可以挂在候选包装上, 也可以直接挂在歌曲对象上(调用方/单测传 fixture 时更自然)
  var explicit = (candidate.stats && typeof candidate.stats === 'object') ? candidate.stats
    : (song.stats && typeof song.stats === 'object') ? song.stats : null;
  var fromMap = (ctx && ctx.songStats && ctx.songStats[key]) || null;
  // 四源没有这歌的统计时, 再按跨源签名找"外部(SMTC/Apple Music)听过"的统计。
  // 签名算法两边一致(不剥括号), 所以 Live 版不会误配到录音室版。
  var fromSignature = (!fromMap && ctx && ctx.signatureStats)
    ? (ctx.signatureStats[shuffleSongSignature(song)] || null)
    : null;
  // 严格签名失败再试宽松签名(艺人本名/艺名不一致、标题带 (feat.)/(Clean) 时靠它救回来)
  var fromLoose = (!fromMap && !fromSignature && ctx && ctx.looseStats)
    ? (ctx.looseStats[shuffleLooseSignature(song)] || null)
    : null;
  var stats = explicit || fromMap || fromSignature || fromLoose || {};
  var plays = Math.max(0, Number(stats.plays) || 0);
  var completed = Math.max(0, Number(stats.completed != null ? stats.completed : stats.completedPlays) || 0);
  var artistName = stats.artist || song.artist || '';
  return {
    key: key,
    song: song,
    name: stats.name || song.name || song.title || '',
    artist: artistName,
    artistKey: shuffleArtistPrimary(artistName),
    album: stats.album || song.album || song.albumName || '',
    plays: plays,
    completed: Math.min(completed, plays),
    listenMs: Math.max(0, Number(stats.listenMs) || 0),
    lastPlayedAt: Math.max(0, Number(stats.lastPlayedAt) || 0),
    completionRate: stats.completionRate != null
      ? shuffleClamp01(stats.completionRate)
      : shuffleBayesRate(completed, plays, 0.5, 2),
    // 早跳率在 P0 事件聚合落地前是"未知"; 未知就不参与评分(记 source='unknown'), 不拿假数据凑
    earlySkipRate: stats.earlySkipRate == null ? null : shuffleClamp01(stats.earlySkipRate),
    statsSource: explicit ? 'explicit'
      : (fromMap ? 'listen-stats'
        : (fromSignature ? 'smtc-external'
          : (fromLoose ? 'smtc-external-loose' : 'none')))
  };
}

// 可播性惩罚: Apple 元数据曲目必须换源; 试听片段 / 明确不可播同样降权。
// 注意: 这里只降权, 不硬排除 —— 换源是否成功只有播放链路知道, 评分层无权断言。
function shuffleSourcePenalty(candidate) {
  candidate = candidate || {};
  var penalty = 0;
  if (candidate.playable === false) penalty = Math.max(penalty, 1);
  if (candidate.isTrial || candidate.trial) penalty = Math.max(penalty, 1);
  if (candidate.needsSourceSwitch) penalty = Math.max(penalty, 0.7);
  if (candidate.resolvedPlaybackProvider && candidate.playbackProvider &&
      candidate.resolvedPlaybackProvider !== candidate.playbackProvider) {
    penalty = Math.max(penalty, 0.5);
  }
  return penalty;
}

// ------------------------------------------------------------
// 1) scoreCandidate —— 纯评分。不认识冷却, 不认识随机。
// ------------------------------------------------------------
function scoreCandidate(candidate, ctx) {
  ctx = ctx || {};
  var w = Object.assign({}, shuffleDefaultWeights(), ctx.weights || {});
  var now = Number(ctx.now) || Date.now();
  var meta = shuffleCandidateMeta(candidate, ctx);

  var elapsedMs = meta.lastPlayedAt > 0 ? Math.max(0, now - meta.lastPlayedAt) : Infinity;
  var elapsedDays = elapsedMs === Infinity ? Infinity : elapsedMs / 86400000;

  var features = {
    affinity: Math.min(1, Math.log1p(meta.plays) / Math.log1p(30)),
    completion: meta.completionRate,
    artist: shuffleArtistAffinity(meta, ctx),
    // 越久没听越高; 从没听过按最久算(1)。tau = 7 天
    recency: elapsedDays === Infinity ? 1 : shuffleClamp01(1 - Math.exp(-elapsedDays / 7)),
    novelty: elapsedDays === Infinity ? 1 : shuffleClamp01(elapsedDays / 14),
    earlySkip: meta.earlySkipRate == null ? 0 : meta.earlySkipRate,
    earlySkipKnown: meta.earlySkipRate != null,
    source: shuffleSourcePenalty(candidate)
  };

  var terms = {
    affinity: w.affinity * features.affinity,
    completion: w.completion * features.completion,
    artist: w.artist * features.artist,
    recency: w.recency * features.recency,
    novelty: w.novelty * features.novelty,
    earlySkip: w.earlySkip * features.earlySkip,
    source: w.source * features.source,
    tempo: 0
  };
  // 归一化 -0 (负权重 × 0 特征): 让 breakdown 可比较、可断言、可 JSON 往返
  Object.keys(terms).forEach(function (k) { if (terms[k] === 0) terms[k] = 0; });
  var score = terms.affinity + terms.completion + terms.artist + terms.recency +
    terms.novelty + terms.earlySkip + terms.source + terms.tempo;
  if (score === 0) score = 0;

  return {
    key: meta.key,
    candidate: candidate,
    meta: meta,
    score: score,
    breakdown: {
      features: features,
      terms: terms,
      weights: w,
      statsSource: meta.statsSource,
      plays: meta.plays,
      lastPlayedAt: meta.lastPlayedAt
    }
  };
}

// 归一化艺人索引: 一次构建, 避免每首候选都全量扫 artistStats。
// 影子探针跑在切歌路径上, 这个 O(n*m) 扫描会变成可感知的卡顿。
function shuffleArtistIndex(artistStats) {
  var index = {};
  if (!artistStats) return index;
  Object.keys(artistStats).forEach(function (name) {
    var key = shuffleArtistPrimary(name);
    if (key && !index[key]) index[key] = artistStats[name];
  });
  return index;
}

function shuffleArtistAffinity(meta, ctx) {
  if (!meta.artistKey) return 0;
  var index = (ctx && ctx.artistStatsByKey) || null;
  var stat = index ? index[meta.artistKey] : null;
  if (!stat) {
    var artists = (ctx && ctx.artistStats) || null;
    if (!artists) return 0;
    var keys = Object.keys(artists);
    for (var i = 0; i < keys.length; i++) {
      if (shuffleArtistPrimary(keys[i]) === meta.artistKey) { stat = artists[keys[i]]; break; }
    }
  }
  if (!stat) return 0;
  var plays = Math.max(0, Number(stat.plays) || 0);
  var listenMs = Math.max(0, Number(stat.listenMs) || 0);
  var byPlays = Math.min(1, Math.log1p(plays) / Math.log1p(40));
  return shuffleClamp01(byPlays * 0.7 + Math.min(1, listenMs / (90 * 60 * 1000)) * 0.3);
}

// ------------------------------------------------------------
// 2) applyCooldown —— 冷却 / 间隔过滤。只回答"能不能进", 不改分。
// ------------------------------------------------------------
// 重复用【硬屏蔽】而不是软惩罚: 软惩罚仍可能让冷却期内的歌排到第一, 那正是"总是听到同一首"的来源。
function applyCooldown(scored, ctx) {
  scored = Array.isArray(scored) ? scored : [];
  ctx = ctx || {};
  var w = Object.assign({}, shuffleDefaultWeights(), ctx.weights || {});
  var now = Number(ctx.now) || Date.now();
  var recentKeys = ctx.recentKeys || [];
  var recentArtists = ctx.recentArtists || [];
  var recentAlbums = ctx.recentAlbums || [];
  var cooldownMs = Math.max(0, Number(w.cooldownMs) || 0);

  var seenInRun = ctx.seenInRun || [];
  var lastArtist = recentArtists.length ? recentArtists[recentArtists.length - 1] : '';
  var lastAlbum = recentAlbums.length ? recentAlbums[recentAlbums.length - 1] : '';

  var kept = [];
  var excluded = [];
  for (var i = 0; i < scored.length; i++) {
    var entry = scored[i];
    var meta = entry.meta || {};
    var reason = '';

    if (seenInRun.indexOf(meta.key) >= 0) reason = 'duplicate';
    else if (cooldownMs > 0 && meta.lastPlayedAt > 0 && (now - meta.lastPlayedAt) < cooldownMs) reason = 'cooldown';
    else if (recentKeys.indexOf(meta.key) >= 0) reason = 'recent-key';
    else if (meta.album && lastAlbum && meta.album === lastAlbum) reason = 'album-adjacent';
    else if (meta.artistKey && w.artistGap > 0) {
      // 同艺人必须间隔 >= artistGap 首: 检查最近 artistGap 个位置
      var gapWindow = Math.max(1, Math.round(Number(w.artistGap) || 0));
      var gapFrom = Math.max(0, recentArtists.length - gapWindow);
      for (var g = gapFrom; g < recentArtists.length; g++) {
        if (recentArtists[g] === meta.artistKey) { reason = 'artist-adjacent'; break; }
      }
    }
    if (!reason && meta.artistKey) {
      var windowCount = 0;
      var from = Math.max(0, recentArtists.length - Math.max(1, w.artistWindow));
      for (var j = from; j < recentArtists.length; j++) if (recentArtists[j] === meta.artistKey) windowCount++;
      if (windowCount >= Math.max(1, w.artistWindowMax)) reason = 'artist-window';
    }

    // 必须回传原始 entry: 调用方要把被挡的放回池子重试, 只带 key 会丢 meta
    if (reason) excluded.push({ entry: entry, key: meta.key, score: entry.score, reason: reason });
    else kept.push(entry);
  }
  return { kept: kept, excluded: excluded };
}

// 排序 + 逐个接纳: 间隔规则依赖"已经接纳的顺序", 所以必须边走边判, 不能先排序再过滤。
function selectCandidates(scored, ctx) {
  ctx = ctx || {};
  var w = Object.assign({}, shuffleDefaultWeights(), ctx.weights || {});
  var pool = (Array.isArray(scored) ? scored.slice() : []).sort(function (a, b) { return b.score - a.score; });
  var recentKeys = (ctx.recentKeys || []).slice();
  var recentArtists = (ctx.recentArtists || []).slice();
  var recentAlbums = (ctx.recentAlbums || []).slice();
  var accepted = [];
  var excluded = [];
  var guard = pool.length + 1;

  while (pool.length && guard-- > 0) {
    var result = applyCooldown(pool, {
      now: ctx.now,
      weights: w,
      recentKeys: recentKeys,
      recentArtists: recentArtists,
      recentAlbums: recentAlbums,
      seenInRun: accepted.map(function (a) { return a.meta.key; })
    });
    if (!result.kept.length) {
      // 剩下的全被挡: 全部记原因, 由调用方决定降级(安全阀)
      for (var e = 0; e < result.excluded.length; e++) excluded.push(result.excluded[e]);
      break;
    }
    var pick = result.kept[0];
    accepted.push(pick);
    // 未被接纳的(被挡的 + 本轮落选的)回到池子(用原始 entry, 不是只带 key 的报告对象)
    pool = result.excluded.map(function (x) { return x.entry; }).concat(result.kept.slice(1));
    recentKeys.push(pick.meta.key);
    recentArtists.push(pick.meta.artistKey);
    recentAlbums.push(pick.meta.album || '');
    if (recentKeys.length > Math.max(30, w.artistWindow)) {
      recentKeys.shift(); recentArtists.shift(); recentAlbums.shift();
    }
  }
  return { ranked: accepted, excluded: excluded, fullySelected: pool.length === 0 };
}

// ------------------------------------------------------------
// 3) weightedSample —— 最终抽取。不认识分数含义, 只按权重掷骰子。
// ------------------------------------------------------------
function shuffleSoftmaxWeights(ranked, temperature) {
  var t = Number(temperature) > 0.01 ? Number(temperature) : 0.25;
  var maxScore = -Infinity;
  for (var i = 0; i < ranked.length; i++) if (ranked[i].score > maxScore) maxScore = ranked[i].score;
  var weights = [];
  var total = 0;
  for (var j = 0; j < ranked.length; j++) {
    var wv = Math.exp((ranked[j].score - maxScore) / t);
    if (!isFinite(wv) || wv < 0) wv = 0;
    weights.push(wv);
    total += wv;
  }
  return { weights: weights, total: total };
}

function weightedSample(ranked, rng, temperature) {
  ranked = Array.isArray(ranked) ? ranked : [];
  if (!ranked.length) return { picked: null, reason: 'empty-pool', weights: [], totalWeight: 0, temperature: 0 };
  var w = shuffleSoftmaxWeights(ranked, temperature);
  var random = typeof rng === 'function' ? rng : Math.random;
  var roll = random() * w.total;
  var acc = 0;
  var index = ranked.length - 1;
  for (var i = 0; i < ranked.length; i++) {
    acc += w.weights[i];
    if (roll <= acc) { index = i; break; }
  }
  var picked = ranked[index];
  return {
    picked: picked,
    reason: 'weighted',
    index: index,
    weight: w.weights[index],
    totalWeight: w.total,
    temperature: shuffleClampNum(temperature, 0.01, 10, 0.25),
    probability: w.total > 0 ? w.weights[index] / w.total : 0
  };
}

// ------------------------------------------------------------
// 4) 全链路: 评分 -> 冷却 -> 逐个加权抽样, 产出重排后的顺序
// ------------------------------------------------------------
// ctx: { now, weights, songStats, artistStats, recentKeys, recentArtists, recentAlbums, rng }
function buildShuffleOrder(queue, ctx) {
  ctx = ctx || {};
  var w = Object.assign({}, shuffleDefaultWeights(), ctx.weights || {});
  var queueList = Array.isArray(queue) ? queue.slice() : [];
  var original = queueList.map(shuffleKeyOf);
  var base = {
    applied: false,
    mode: ctx.mode || shuffleMode(),
    original: original,
    order: original,
    picks: [],
    excluded: [],
    reason: ''
  };

  // 安全阀 1: 没有候选
  if (queueList.length < 2) return Object.assign(base, { reason: 'insufficient-candidates' });

  // 直接持有原始歌曲对象: 否则调用方挂在歌上的 stats / 标记会被包装层吃掉, 评分静默退化成全 0
  var remaining = queueList.slice();
  var recentKeys = (ctx.recentKeys || []).slice();
  var recentArtists = (ctx.recentArtists || []).slice();
  var recentAlbums = (ctx.recentAlbums || []).slice();
  var picks = [];
  var excluded = [];
  var cooledTail = false;
  var guard = remaining.length + 1;

  while (remaining.length && guard-- > 0) {
    var scored = remaining.map(function (song) { return scoreCandidate(song, ctx); });
    var gate = applyCooldown(scored, {
      now: ctx.now, weights: w,
      recentKeys: recentKeys, recentArtists: recentArtists, recentAlbums: recentAlbums,
      seenInRun: picks.map(function (p) { return p.key; })
    });
    if (!gate.kept.length) {
      // 安全阀 2: 剩余全被冷却 -> 原序补齐, 不丢歌
      cooledTail = true;
      for (var t = 0; t < remaining.length; t++) {
        var tailKey = shuffleKeyOf(remaining[t]);
        excluded.push({ key: tailKey, reason: 'cooled-out-tail' });
        picks.push({ key: tailKey, score: null, breakdown: null, cooledTail: true });
      }
      remaining = [];
      break;
    }
    var draw = weightedSample(gate.kept, ctx.rng, w.temperature);
    var chosen = draw.picked;
    picks.push({
      key: chosen.key,
      score: chosen.score,
      breakdown: chosen.breakdown,
      probability: draw.probability,
      reason: 'weighted'
    });
    for (var x = 0; x < gate.excluded.length; x++) excluded.push(gate.excluded[x]);
    recentKeys.push(chosen.meta.key);
    recentArtists.push(chosen.meta.artistKey);
    recentAlbums.push(chosen.meta.album || '');
    remaining = remaining.filter(function (song) { return shuffleKeyOf(song) !== chosen.meta.key; });
  }

  var order = picks.map(function (p) { return p.key; });
  // 安全阀 3: 任何原因导致顺序不完整 -> 原样返回, 绝不产出残缺队列
  if (order.length !== original.length || !sameKeyMultiset(order, original)) {
    return Object.assign(base, { reason: 'order-incomplete', excluded: excluded });
  }
  // 安全阀 4: 一次真实抽取都没发生(全被冷却) -> 老实报 applied:false, 不谎称"已优化"
  var realPicks = picks.filter(function (p) { return !p.cooledTail; }).length;
  if (realPicks === 0) {
    return Object.assign(base, { applied: false, order: original, picks: [], excluded: excluded, reason: 'all-cooled' });
  }
  return Object.assign(base, {
    applied: true,
    order: order,
    picks: picks,
    excluded: excluded,
    reason: cooledTail ? 'ok-with-cooled-tail' : 'ok'
  });
}

function sameKeyMultiset(a, b) {
  if (a.length !== b.length) return false;
  var sortedA = a.slice().sort();
  var sortedB = b.slice().sort();
  for (var i = 0; i < sortedA.length; i++) if (sortedA[i] !== sortedB[i]) return false;
  return true;
}

// ------------------------------------------------------------
// 5) 插入比例: 每 N 位由评分接管 1 位, 其余保持用户原序
// ------------------------------------------------------------
// 保证: 每首歌恰好出现一次; N>=2 时不会连续插入。
function planSmartShuffleOrder(queue, ctx) {
  ctx = ctx || {};
  var w = Object.assign({}, shuffleDefaultWeights(), ctx.weights || {});
  var n = Math.max(1, Math.round(Number(w.insertionN) || 3));
  var queueList = Array.isArray(queue) ? queue.slice() : [];
  var original = queueList.map(shuffleKeyOf);
  var base = { applied: false, mode: ctx.mode || shuffleMode(), original: original, order: original, insertions: [], reason: '' };

  if (queueList.length < 2) return Object.assign(base, { reason: 'insufficient-candidates' });
  if (n <= 1) n = 2; // 不许连续插入

  var scored = buildShuffleOrder(queueList, ctx);
  if (!scored.applied) {
    return Object.assign(base, { reason: scored.reason, excluded: scored.excluded });
  }

  var pool = scored.order.slice();
  var used = {};
  var out = [];
  var insertions = [];
  var origIdx = 0;

  for (var i = 0; i < original.length; i++) {
    var slot = (i % n) === (n - 1);
    var key = null;
    if (slot) {
      // 取评分顺序里下一个还没用过的
      for (var p = 0; p < pool.length; p++) {
        if (!used[pool[p]]) { key = pool[p]; break; }
      }
      if (key) {
        var pickInfo = null;
        for (var q = 0; q < scored.picks.length; q++) if (scored.picks[q].key === key) { pickInfo = scored.picks[q]; break; }
        insertions.push({ atIndex: i, key: key, score: pickInfo ? pickInfo.score : null, reason: 'smart-shuffle-slot' });
      }
    }
    if (!key) {
      while (origIdx < original.length && used[original[origIdx]]) origIdx++;
      if (origIdx < original.length) { key = original[origIdx]; origIdx++; }
    }
    if (!key) {
      for (var r = 0; r < pool.length; r++) if (!used[pool[r]]) { key = pool[r]; break; }
    }
    if (!key) break;
    used[key] = true;
    out.push(key);
  }

  if (out.length !== original.length || !sameKeyMultiset(out, original)) {
    return Object.assign(base, { applied: false, reason: 'order-incomplete' });
  }
  return Object.assign(base, {
    applied: true,
    order: out,
    insertions: insertions,
    excluded: scored.excluded,
    reason: 'ok'
  });
}

// ------------------------------------------------------------
// 6) 上下文构建: 从当前播放器状态取"最近"窗口 (队列已播前缀, 零新增持久化)
// ------------------------------------------------------------
function shuffleRecentContext(ctx) {
  ctx = ctx || {};
  var recentKeys = (ctx.recentKeys || []).slice();
  var recentArtists = (ctx.recentArtists || []).slice();
  var recentAlbums = (ctx.recentAlbums || []).slice();
  if ((!recentKeys.length) && ctx.includeQueuePrefix !== false) {
    try {
      if (typeof playQueue !== 'undefined' && Array.isArray(playQueue) && typeof currentIdx !== 'undefined' && currentIdx >= 0) {
        var from = Math.max(0, currentIdx - 19);
        for (var i = from; i <= currentIdx && i < playQueue.length; i++) {
          var song = playQueue[i] || {};
          recentKeys.push(shuffleKeyOf(song));
          recentArtists.push(shuffleArtistPrimary(song.artist));
          recentAlbums.push(song.album || song.albumName || '');
        }
      }
    } catch (e) { }
  }
  return { recentKeys: recentKeys, recentArtists: recentArtists, recentAlbums: recentAlbums };
}

function shuffleStatsMaps() {
  var songStats = {}, artistStats = {}, signatureStats = {}, looseStats = {};
  try {
    if (typeof listenStatsState !== 'undefined' && listenStatsState) {
      songStats = listenStatsState.songs || {};
      artistStats = listenStatsState.artists || {};
    }
  } catch (e) { }
  // P0 事件聚合补上 listen-stats 拿不到的字段(尤其 earlySkipRate)。
  // 规则: 两边都有 -> 只补新字段, 不用事件表覆盖已有更长历史的 plays/listenMs;
  //       只有事件表有 -> 整条采用(典型情况: 只被短跳过、因此从未进过 listen-stats 的歌)。
  try {
    if (typeof playEventsSongStatsMap === 'function') {
      var ev = playEventsSongStatsMap() || {};
      Object.keys(ev).forEach(function (key) {
        var base = songStats[key];
        if (base) {
          songStats[key] = Object.assign({}, base, {
            earlySkipRate: ev[key].earlySkipRate,
            earlySkips: ev[key].earlySkips
          });
        } else {
          songStats[key] = ev[key];
        }
      });
    }
    if (typeof playEventsArtistStatsMap === 'function') {
      var ea = playEventsArtistStatsMap() || {};
      Object.keys(ea).forEach(function (name) {
        artistStats[name] = Object.assign({}, ea[name], artistStats[name] || {});
      });
    }
    // 外部(SMTC)收听: 单独一桶, 由 shuffleCandidateMeta 按签名回退查找
    if (typeof playEventsSignatureStatsMap === 'function') {
      signatureStats = playEventsSignatureStatsMap() || {};
    }
    if (typeof playEventsLooseStatsMap === 'function') {
      looseStats = playEventsLooseStatsMap() || {};
    }
  } catch (e) { }
  return { songStats: songStats, artistStats: artistStats, signatureStats: signatureStats, looseStats: looseStats };
}

// 宽松签名: **只用于外部收听归因**, 不参与冷却/排除/去重。
//
// 为什么需要它 —— 实测 Apple Music 的 SMTC 元数据与国内四源对不齐:
//   SMTC : "StarBoy (feat. Daft Punk)" / "Abel Tesfaye"   (本名)
//   四源 : "Starboy (Clean)"           / "The Weeknd"     (艺名)
// 艺人名是本名 vs 艺名, 标题还带 (feat.)/(Clean) 标注 —— 严格签名必然失败,
// 这类歌的 AM 收听就一条都归因不到, B 方案等于白做。
//
// 宽松签名 = 去掉括号内容后的曲名 + 5 秒粒度的时长, **不含艺人**。
// 已知代价(承认): 同一首歌的 Live/Remix 版本会被算成同一首 -> 只影响 affinity 统计,
// 不影响播放顺序, 也不会让冷却规则变松(冷却仍用严格签名)。命中会标记为
// statsSource='smtc-external-loose', 两周后可以据此判断它值不值得留。
function shuffleNormalizeTitle(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC').toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[\s·・\-—_.,，。:：'"“”‘’/\\|!?！？]+/g, '');
}

var SHUFFLE_LOOSE_BUCKET_MS = 5000;

function shuffleLooseSignature(song) {
  song = song || {};
  var ms = shuffleDurationMs(song);
  return shuffleNormalizeTitle(song.name || song.title) + '|' + Math.round(ms / SHUFFLE_LOOSE_BUCKET_MS);
}

// 登记时同时写入**相邻桶**: 两个源的时长差 1 秒也可能落在桶边界两侧
// (实测 Apple 230s / 池 231s 同桶没问题, 但 232s vs 234s 就会一桶之隔)。
// 采集侧写 ±1, 查询侧只需查自己的那个桶, 覆盖 |时长差| ≲7.5s。
function shuffleLooseSignatureVariants(song) {
  song = song || {};
  var title = shuffleNormalizeTitle(song.name || song.title);
  if (!title) return [];
  var ms = shuffleDurationMs(song);
  if (!ms) return [];
  var base = Math.round(ms / SHUFFLE_LOOSE_BUCKET_MS);
  var out = [];
  [-1, 0, 1].forEach(function (delta) {
    var bucket = base + delta;
    if (bucket < 0) return;
    var key = title + '|' + bucket;
    if (out.indexOf(key) < 0) out.push(key);
  });
  return out;
}

// ------------------------------------------------------------
// 6.5) 候选池拉取 (P2)
// ------------------------------------------------------------
// 服务端只回答"有哪些候选"; 这里只负责把它取回来并缓存。
var smartShufflePoolState = { at: 0, candidates: [], error: '' };
var SMART_SHUFFLE_POOL_TTL_MS = 60 * 1000;
var smartShufflePoolInflight = null;

function smartShuffleFetchPool(force) {
  var now = Date.now();
  if (!force && smartShufflePoolState.at && now - smartShufflePoolState.at < SMART_SHUFFLE_POOL_TTL_MS) {
    return Promise.resolve(smartShufflePoolState.candidates);
  }
  if (smartShufflePoolInflight) return smartShufflePoolInflight;
  if (typeof fetch !== 'function') return Promise.resolve([]);
  // 必须显式要全量: 服务端默认 limit=800, 不传就会静默截断(实测 1429 只拿到 800, 且截断有偏)
  smartShufflePoolInflight = fetch('/api/smart-shuffle/candidates?limit=3000', { method: 'GET' })
    .then(function (resp) { return resp && resp.ok ? resp.json() : null; })
    .then(function (data) {
      var list = data && Array.isArray(data.candidates) ? data.candidates : [];
      smartShufflePoolState = { at: Date.now(), candidates: list, error: data && data.ok === false ? String(data.error || 'POOL_FAILED') : '' };
      return list;
    })
    .catch(function (err) {
      // 接口挂了绝不能影响播放: 退回空池 -> 上层安全阀 -> 原队列
      smartShufflePoolState = { at: Date.now(), candidates: [], error: (err && err.message) || 'POOL_REQUEST_FAILED' };
      return [];
    })
    .then(function (list) { smartShufflePoolInflight = null; return list; });
  return smartShufflePoolInflight;
}

// 队列内 / 候选池之间的"同一首歌"签名。
// 只用于**去重**(别把已在队列里的歌又插一遍), 不做跨源录音级判定
// —— 录音级判定在服务端由 neteaseSourceMatch* 完成, 这里不重复造。
function shuffleSongSignature(song) {
  song = song || {};
  return shuffleArtistPrimary(song.artist) + '|' + String(song.name || song.title || '').replace(/\s+/g, '').toLowerCase() +
    '|' + Math.round(shuffleDurationMs(song) / 1000);
}

// ------------------------------------------------------------
// 6.6) 插入规划: 在保留全部原曲的前提下, 每隔 N 首追加 1 首候选
// ------------------------------------------------------------
// 与 planSmartShuffleOrder 的分工(两者都不要合并):
//   planSmartShuffleOrder      -> 只重排, 多重集必须相等, 绝不新增
//   planSmartShuffleInsertions -> 允许新增, 但任何异常都退回原计划
function planSmartShuffleInsertions(queue, pool, ctx) {
  ctx = ctx || {};
  var w = Object.assign({}, shuffleDefaultWeights(), ctx.weights || {});
  var n = Math.max(2, Math.round(Number(w.insertionN) || 3)); // n>=2: 绝不连续插入
  var queueList = Array.isArray(queue) ? queue.slice() : [];
  var base = {
    applied: false,
    original: queueList.map(shuffleKeyOf),
    order: queueList,
    insertions: [],
    excluded: [],
    reason: ''
  };

  // 安全阀 1: 队列太短, 不值得动
  if (queueList.length < 2) return Object.assign(base, { reason: 'insufficient-candidates' });

  // 去重: 已在队列里的歌不能再插一遍
  var queued = {};
  queueList.forEach(function (song) { queued[shuffleSongSignature(song)] = true; });
  var extras = [];
  var dropped = [];
  (Array.isArray(pool) ? pool : []).forEach(function (candidate) {
    if (!candidate || !candidate.name) return;
    if (candidate.playable === false && !candidate.crossSource) { dropped.push({ key: shuffleKeyOf(candidate), reason: 'not-playable' }); return; }
    var signature = shuffleSongSignature(candidate);
    if (queued[signature]) { dropped.push({ key: shuffleKeyOf(candidate), reason: 'already-queued' }); return; }
    queued[signature] = true;
    extras.push(candidate);
  });

  // 安全阀 2: 没有可插的候选 -> 明确回"什么都没做"
  if (!extras.length) return Object.assign(base, { reason: 'empty-pool', excluded: dropped });

  var recentKeys = (ctx.recentKeys || []).slice();
  var recentArtists = (ctx.recentArtists || []).slice();
  var recentAlbums = (ctx.recentAlbums || []).slice();
  var maxInsertions = Math.max(0, Math.floor((queueList.length - 1) / n)); // 不在末尾追加
  if (!maxInsertions) return Object.assign(base, { reason: 'no-insertion-slot', excluded: dropped });

  var out = [];
  var insertions = [];
  var remaining = extras.slice();
  var excludedAll = dropped.slice();

  for (var i = 0; i < queueList.length; i++) {
    out.push(queueList[i]);
    recentKeys.push(shuffleKeyOf(queueList[i]));
    recentArtists.push(shuffleArtistPrimary(queueList[i] && queueList[i].artist));
    recentAlbums.push((queueList[i] && (queueList[i].album || queueList[i].albumName)) || '');

    if (insertions.length >= maxInsertions) continue;
    if ((i + 1) % n !== 0) continue;           // 每隔 n 首才考虑插一次 -> 天然不会连续插

    var scored = remaining.map(function (candidate) { return scoreCandidate(candidate, ctx); });
    var gate = applyCooldown(scored, {
      now: ctx.now, weights: w,
      recentKeys: recentKeys, recentArtists: recentArtists, recentAlbums: recentAlbums,
      seenInRun: insertions.map(function (item) { return item.key; })
    });
    for (var x = 0; x < gate.excluded.length; x++) excludedAll.push(gate.excluded[x]);
    if (!gate.kept.length) continue;            // 全被冷却 -> 这个槽位就空着, 不强插

    var draw = weightedSample(gate.kept, ctx.rng, w.temperature);
    if (!draw || !draw.picked) continue;
    var chosen = draw.picked;
    // 播放对象: 原候选 + provenance, 供事件表记录"这首歌是插进来的"
    var playableSong = Object.assign({}, chosen.candidate, { insertedBy: 'smart-shuffle' });
    out.push(playableSong);
    insertions.push({
      atIndex: out.length - 1,
      afterIndex: i,
      key: chosen.key,
      score: chosen.score,
      breakdown: chosen.breakdown,
      probability: draw.probability,
      reason: 'smart-shuffle-slot',
      song: playableSong
    });
    recentKeys.push(chosen.meta.key);
    recentArtists.push(chosen.meta.artistKey);
    recentAlbums.push(chosen.meta.album || '');
    remaining = remaining.filter(function (candidate) { return shuffleKeyOf(candidate) !== chosen.meta.key; });
  }

  // 安全阀 3: 一首都没插成 -> 老实报 applied:false
  if (!insertions.length) return Object.assign(base, { reason: 'no-insertion-selected', excluded: excludedAll });

  // 安全阀 4: 原曲必须一首不少(插入是**追加**, 不是替换)
  var outKeys = out.map(shuffleKeyOf);
  var baseKeys = queueList.map(shuffleKeyOf);
  for (var b = 0; b < baseKeys.length; b++) {
    if (outKeys.indexOf(baseKeys[b]) < 0) {
      return Object.assign(base, { reason: 'original-track-lost', excluded: excludedAll });
    }
  }

  return Object.assign(base, {
    applied: true,
    order: out,
    insertions: insertions,
    excluded: excludedAll,
    reason: 'ok'
  });
}

// ------------------------------------------------------------
// 6.7) 最终开关的源限制 + 无队列推演 (让 Apple Music 外部播放也能产出决策数据)
// ------------------------------------------------------------
// Smart Shuffle **最终只服务国内四源**: Apple Music / Spotify / 本地 的队列一律不接管。
// 注意区分: 这只限制**接管**, 不限制**采集** —— 影子推演对任何来源都照常记录(我们只要数据)。
var SMART_SHUFFLE_ALLOWED_SOURCES = ['netease', 'qq', 'kugou', 'qishui'];
var SMART_SHUFFLE_POOL_SCAN_MAX = 3000;

function smartShuffleSongProvider(song) {
  song = song || {};
  return String(song.provider || song.source || song.type || song.resolvedPlaybackProvider || '').toLowerCase();
}

// 唯一的"是否允许接管"判定点。将来 mode='on' 接线时必须先过这里。
function smartShuffleApplyGuard(queue) {
  var list = Array.isArray(queue) ? queue : [];
  if (!list.length) return { allowed: false, reason: 'no-queue' };
  var foreign = 0;
  var known = 0;
  list.forEach(function (song) {
    var provider = smartShuffleSongProvider(song);
    if (!provider) return;
    known += 1;
    if (SMART_SHUFFLE_ALLOWED_SOURCES.indexOf(provider) < 0) foreign += 1;
  });
  if (!known) return { allowed: false, reason: 'unknown-source' };
  if (foreign > 0) return { allowed: false, reason: 'foreign-source', foreign: foreign, known: known };
  return { allowed: true, reason: 'ok' };
}

// Apple Music 的 SMTC artist 是 "<艺人> — <专辑>"(见 apple-music-control.js:321)。
// 这里必须有**自己的**兜底实现: 02c 比 12-smtc 先加载, 不能假设 smtcListenCleanArtist 已存在。
// 与 desktop/apple-music-control.js#splitArtistAlbum 同一套规则(实测 "Abel Tesfaye - Dawn FM" U+2014)。
// 只用于**外部 SMTC 的 artist**, 绝不套在候选池的 artist 上(那里已经是干净的)。
var SHUFFLE_ARTIST_ALBUM_RE = /\s+[\u2014\u2013-]\s+/;

function shuffleStripAlbumSuffix(artist) {
  var raw = String(artist == null ? '' : artist).trim();
  if (!raw) return '';
  return (raw.split(SHUFFLE_ARTIST_ALBUM_RE)[0] || '').trim();
}

// 当前正在听什么: 内部队列优先, 否则用 SMTC(Apple Music 外部播放)。
function smartShuffleNowPlaying() {
  try {
    if (typeof currentQueueSong === 'function') {
      var queued = currentQueueSong();
      if (queued && (queued.name || queued.title)) return { song: queued, source: 'internal' };
    }
  } catch (e) { }
  try {
    if (typeof smtcStore !== 'undefined' && smtcStore && smtcStore.active === true &&
        (smtcStore.title || smtcStore.artist)) {
      var liveAlbum = String(smtcStore.album || '');
      var liveArtist = String(smtcStore.artist || '');
      // 必须拆掉专辑后缀: 否则签名带着专辑名, 永远匹配不上候选池,
      // 既排不掉"正在听的那首", 也归因不到任何候选。
      if (typeof smtcListenCleanArtist === 'function') {
        try { liveArtist = smtcListenCleanArtist(smtcStore) || liveArtist; } catch (e) { }
      } else {
        liveArtist = shuffleStripAlbumSuffix(liveArtist);
      }
      return {
        song: {
          name: String(smtcStore.title || ''),
          artist: liveArtist,
          album: liveAlbum,
          durationMs: Number(smtcStore.durationMs) || 0,
          provider: 'smtc-external'
        },
        source: 'smtc'
      };
    }
  } catch (e) { }
  return { song: null, source: 'none' };
}

// 无队列模式: 只回答"以当前正在听的歌为上下文, 下一首会从池里插哪首"。
// 没有队列可重排, 所以这里只排序 + 冷却 + 抽样, 不做任何顺序改写。
function planSmartShufflePoolPick(pool, ctx) {
  ctx = ctx || {};
  var w = Object.assign({}, shuffleDefaultWeights(), ctx.weights || {});
  var seen = {};
  var list = [];
  (Array.isArray(pool) ? pool : []).forEach(function (candidate) {
    if (!candidate || !candidate.name) return;
    var signature = shuffleSongSignature(candidate);
    if (seen[signature]) return;
    seen[signature] = true;
    list.push(candidate);
  });
  if (!list.length) return { applied: false, reason: 'empty-pool', top: [], excluded: [] };
  var scanned = list.length > SMART_SHUFFLE_POOL_SCAN_MAX ? list.slice(0, SMART_SHUFFLE_POOL_SCAN_MAX) : list;
  // 已冷却的候选在池里占比可能很高(个人歌单重复听的概率大), 这里如实报告而不是硬塞。
  var scored = scanned.map(function (candidate) { return scoreCandidate(candidate, ctx); });
  var gate = applyCooldown(scored, {
    now: ctx.now, weights: w,
    recentKeys: ctx.recentKeys || [], recentArtists: ctx.recentArtists || [], recentAlbums: ctx.recentAlbums || []
  });
  if (!gate.kept.length) {
    return { applied: false, reason: 'all-cooled', top: [], excluded: gate.excluded, scanned: scanned.length, total: list.length };
  }
  var ranked = gate.kept.slice().sort(function (a, b) { return b.score - a.score; });
  // 大池必须先取短名单再抽样。
  // temperature=0.25 时, 分数差 0.08 只值 exp(0.08/0.25)≈1.38 倍偏好 —— 在 1400 个候选里
  // 等于均匀随机, picked 字段就失去意义。先按分数取 top-K, 再在短名单内加权抽样,
  // 这是"大目录里选一首"的标准做法, 也让 probability 变得可读。
  var shortlistK = Math.max(1, Math.round(Number(w.shortlistK) || 30));
  var shortlist = ranked.length > shortlistK ? ranked.slice(0, shortlistK) : ranked;
  var draw = weightedSample(shortlist, ctx.rng, w.temperature);
  var softmax = shuffleSoftmaxWeights(shortlist, w.temperature);
  var pickedKey = draw.picked ? draw.picked.key : '';
  return {
    applied: true,
    reason: 'ok',
    pick: draw.picked,
    probability: draw.probability,
    eligible: ranked.length,
    shortlistSize: shortlist.length,
    top: smartShufflePoolTopRows(shortlist, softmax, pickedKey),
    excluded: gate.excluded,
    scanned: scanned.length,
    total: list.length,
    eligible: ranked.length,
    shortlistSize: shortlist.length
  };
}

// 报告用的候选行: top-N 按分数, 但**必须把实际抽中的那一首也带上** ——
// 它可能排在第 15 位, 不在 top-5 里; 而"到底选了什么"恰恰是两周后最要看的一行。
function smartShufflePoolTopRows(shortlist, softmax, pickedKey) {
  var probabilityAt = function (index) {
    return softmax && softmax.total > 0 ? softmax.weights[index] / softmax.total : 0;
  };
  var rowAt = function (entry, index) {
    return {
      key: entry.key,
      name: (entry.candidate && entry.candidate.name) || '',
      score: entry.score,
      breakdown: entry.breakdown,
      probability: probabilityAt(index),
      picked: entry.key === pickedKey
    };
  };
  var rows = shortlist.slice(0, 5).map(function (entry, index) { return rowAt(entry, index); });
  if (pickedKey && !rows.some(function (row) { return row.key === pickedKey; })) {
    for (var i = 0; i < shortlist.length; i++) {
      if (shortlist[i].key === pickedKey) { rows.push(rowAt(shortlist[i], i)); break; }
    }
  }
  return rows;
}

// 排除项瘦身: 内部重试池需要完整 entry, 但**报告/日志只需要可读字段**。
// 不瘦身的话单条日志 15kB(完整 candidate + meta.song 各一份), DevTools 基本没法看。
function smartShuffleExclusionRow(item) {
  item = item || {};
  var meta = item.meta || (item.entry && item.entry.meta) || {};
  var candidate = (item.entry && item.entry.candidate) || {};
  return {
    key: item.key || meta.key || '',
    name: candidate.name || meta.name || '',
    artist: candidate.artist || meta.artist || '',
    reason: item.reason || '',
    score: Number((item.score || (item.entry && item.entry.score) || 0).toFixed(4))
  };
}

// 影子日志里的单条决策: 把"为什么得这个分"完整摊开, 供两周后调参回放。
function smartShuffleDecisionRow(key, name, score, breakdown, probability, crossSource, afterKey, picked) {
  var f = (breakdown && breakdown.features) || {};
  var t = (breakdown && breakdown.terms) || {};
  return {
    after: afterKey || '',
    key: key || '',
    name: name || '',
    statsSource: (breakdown && breakdown.statsSource) || 'none',
    final: Number((score || 0).toFixed(4)),
    affinity: Number((f.affinity || 0).toFixed(3)),
    completion: Number((f.completion || 0).toFixed(3)),
    artist: Number((f.artist || 0).toFixed(3)),
    recency: Number((f.recency || 0).toFixed(3)),
    earlySkip: f.earlySkipKnown ? Number((f.earlySkip || 0).toFixed(3)) : null,
    cooldown: 'PASS',
    terms: {
      affinity: Number((t.affinity || 0).toFixed(4)),
      completion: Number((t.completion || 0).toFixed(4)),
      artist: Number((t.artist || 0).toFixed(4)),
      recency: Number((t.recency || 0).toFixed(4)),
      earlySkip: Number((t.earlySkip || 0).toFixed(4)),
      source: Number((t.source || 0).toFixed(4))
    },
    probability: Number((probability || 0).toFixed(4)),
    picked: !!picked,
    crossSource: !!crossSource
  };
}

// ------------------------------------------------------------
// 7) Shadow Mode: 照常算, 只写日志, 绝不改队列
// ------------------------------------------------------------
function smartShuffleShadowProbe(reason, extra) {
  var cfg = readShuffleConfig();
  if (cfg.mode === 'off') return null;
  // 节流: 影子推演是 O(n^2) 打分, 不能每次切歌都全量跑
  var probeNow = Date.now();
  if (probeNow - smartShuffleLastProbeAt < SMART_SHUFFLE_PROBE_MIN_GAP_MS) return null;
  smartShuffleLastProbeAt = probeNow;

  var queue = [];
  var idx = -1;
  try {
    if (typeof playQueue !== 'undefined' && Array.isArray(playQueue)) queue = playQueue;
    if (typeof currentIdx !== 'undefined') idx = currentIdx;
  } catch (e) { return null; }
  var tail = idx >= 0 ? queue.slice(idx + 1) : queue.slice();
  if (tail.length > SMART_SHUFFLE_PROBE_MAX_CANDIDATES) tail = tail.slice(0, SMART_SHUFFLE_PROBE_MAX_CANDIDATES);
  // 注意: 这里**不能**因为队列不足就退出 —— 队列为空时要走"无队列模式"(见下方分支)

  var head = (extra && extra.headKey) || (idx >= 0 && queue[idx] ? shuffleKeyOf(queue[idx]) : '');
  var probeReason = reason || 'probe';

  // 候选池要走 HTTP, 所以整段异步 fire-and-forget: 切歌路径绝不被它阻塞。
  // 不变量(全程): 不碰 playQueue / currentIdx / audio。
  Promise.resolve()
    .then(function () { return smartShuffleFetchPool(false); })
    .then(function (pool) {
      var maps = shuffleStatsMaps();
      var recent = shuffleRecentContext({});
      var ctx = {
        now: Date.now(),
        weights: cfg.weights,
        mode: cfg.mode,
        songStats: maps.songStats,
        artistStats: maps.artistStats,
        signatureStats: maps.signatureStats,
        looseStats: maps.looseStats,
        artistStatsByKey: shuffleArtistIndex(maps.artistStats),
        recentKeys: recent.recentKeys,
        recentArtists: recent.recentArtists,
        recentAlbums: recent.recentAlbums,
        rng: Math.random
      };
      // 两种推演模式:
      //   queue     —— 内部队列剩余 >=2 首: 重排 + 插入 (原行为)
      //   pool-only —— 没有可用队列(典型: 正在用 Apple Music 外部播放, MineRadio 队列是空的):
      //                以"当前正在听什么"为上下文, 从候选池推演"下一首会插哪首"
      // 影子模式对任何来源都记录 —— 我们只要数据; 但**接管**只允许国内四源(见 applyGuard)。
      var applyGuard = smartShuffleApplyGuard(queue);
      var nowPlaying = smartShuffleNowPlaying();
      var planMode = tail.length >= 2 ? 'queue' : (nowPlaying.song ? 'pool-only' : 'none');
      var reorder = { applied: false, reason: 'skipped' };
      var insertPlan = { applied: false, reason: 'skipped', count: 0, excluded: [] };
      var decisions = [];

      if (planMode === 'queue') {
        reorder = planSmartShuffleOrder(tail, ctx);
        var insertion = planSmartShuffleInsertions(tail, pool, ctx);
        insertPlan = {
          applied: insertion.applied,
          reason: insertion.reason,
          count: insertion.insertions.length,
          excluded: insertion.excluded
        };
        decisions = insertion.insertions.slice(0, 5).map(function (item) {
          var afterSong = insertion.order[item.afterIndex];
          return smartShuffleDecisionRow(item.key, (item.song && item.song.name) || '', item.score,
            item.breakdown, item.probability, !!(item.song && item.song.crossSource),
            afterSong ? shuffleKeyOf(afterSong) : '');
        });
      } else if (planMode === 'pool-only') {
        // 把"当前正在听的歌"当作刚播过的那一首, 冷却/间隔规则才会生效
        var seedCtx = Object.assign({}, ctx, {
          recentKeys: recent.recentKeys.concat([shuffleKeyOf(nowPlaying.song)]),
          recentArtists: recent.recentArtists.concat([shuffleArtistPrimary(nowPlaying.song.artist || '')]),
          recentAlbums: recent.recentAlbums.concat([nowPlaying.song.album || ''])
        });
        // 当前正在听的那首必须排除: 它的 key 是 smtc: 空间, 和候选的 queueItemKey 不同,
        // 光靠 recentKeys 排不掉 —— 会用签名再筛一遍, 否则会"推荐你正在听的歌"。
        var nowSignature = shuffleSongSignature(nowPlaying.song);
        var poolForPick = [];
        var droppedNowPlaying = 0;
        (Array.isArray(pool) ? pool : []).forEach(function (candidate) {
          if (shuffleSongSignature(candidate) === nowSignature) { droppedNowPlaying += 1; return; }
          poolForPick.push(candidate);
        });
        var poolPick = planSmartShufflePoolPick(poolForPick, seedCtx);
        insertPlan = {
          applied: poolPick.applied,
          reason: poolPick.reason,
          count: 0,
          excluded: poolPick.excluded || [],
          eligible: poolPick.eligible || 0,
          shortlistSize: poolPick.shortlistSize || 0,
          poolTotal: (pool || []).length,
          poolScanned: poolPick.scanned || 0,
          droppedNowPlaying: droppedNowPlaying
        };
        if (droppedNowPlaying > 0 && !poolPick.applied) insertPlan.reason = poolPick.reason + '+now-playing-only';
        if (poolPick.applied && poolPick.top) {
          decisions = poolPick.top.map(function (entry) {
            return smartShuffleDecisionRow(entry.key, entry.name, entry.score, entry.breakdown,
              entry.probability || 0, false, shuffleKeyOf(nowPlaying.song), entry.picked);
          });
        }
      } else {
        return null; // 既没有队列也没在听 -> 没有可推演的东西
      }

      var report = {
        at: ctx.now,
        reason: probeReason,
        mode: cfg.mode,
        planMode: planMode,
        fromKey: head,
        nowPlaying: nowPlaying.song
          ? { key: shuffleKeyOf(nowPlaying.song), from: nowPlaying.source, name: nowPlaying.song.name || '' }
          : null,
        queueTail: tail.length,
        poolSize: (pool || []).length,
        poolError: smartShufflePoolState.error || '',
        applyGuard: applyGuard,
        reorder: { applied: reorder.applied, reason: reorder.reason },
        poolScanned: insertPlan.poolScanned || 0,
        droppedNowPlaying: insertPlan.droppedNowPlaying || 0,
        insertion: {
          applied: insertPlan.applied,
          reason: insertPlan.reason,
          count: insertPlan.count,
          decisions: decisions
        },
        eligible: insertPlan.eligible || 0,
        shortlistSize: insertPlan.shortlistSize || 0,
        excluded: (insertPlan.excluded || []).slice(0, 5).map(smartShuffleExclusionRow)
      };
      // 影子模式: 只记录, 绝不采用。这里是全链路唯一"输出决策"的地方。
      try { console.log('[SmartShuffle][shadow] ' + JSON.stringify(report)); } catch (e) { }
      if (typeof playEventRecord === 'function') {
        playEventRecord({
          type: 'shuffle-shadow',
          reason: probeReason,
          planMode: planMode,
          fromKey: head,
          nowPlayingKey: report.nowPlaying ? report.nowPlaying.key : '',
          queueTail: tail.length,
          poolSize: (pool || []).length,
          poolScanned: report.poolScanned || 0,
          droppedNowPlaying: report.droppedNowPlaying || 0,
          eligible: report.eligible || 0,
          shortlistSize: report.shortlistSize || 0,
          wouldInsert: insertPlan.applied,
          insertionReason: insertPlan.reason,
          applyAllowed: applyGuard.allowed,
          decisions: decisions
        });
      }
      return report;
    })
    .catch(function (err) {
      try { console.warn('[SmartShuffle][shadow] probe failed:', err && err.message); } catch (e) { }
      return null;
    });
  return true; // 已排队(异步), 调用方不需要等待
}

if (typeof window !== 'undefined' && window) {
  try { window.smartShuffleShadowProbe = smartShuffleShadowProbe; } catch (e) { }
}
