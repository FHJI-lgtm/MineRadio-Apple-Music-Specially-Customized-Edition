'use strict';
// ============================================================
// Smart Shuffle / P0 黑匣子 —— 固定数据单测 (Day 0-2)
//
// 覆盖: 评分 -> 候选排序 -> 冷却 -> 加权抽样 -> 插入 → 队列 整条链路,
//       以及 P0 事件表"短跳过必须留痕"这一硬要求。
//
// 说明: 用 vm 加载**真实源码**, 不复制实现, 不做源码字符串断言。
// 运行: node tests/smart-shuffle-scoring.test.js
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const playbackDir = path.join(appRoot, 'public', 'js', 'modules', '05-playback');
const SCORE_FILE = path.join(playbackDir, '02c-shuffle-score.js');
const EVENTS_FILE = path.join(playbackDir, '02b-play-events.js');

function makeSandbox() {
  const store = {};
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, Array, Object, String, Number, Boolean, Date, RegExp, Error, Promise,
    isFinite, isNaN, parseInt, parseFloat, setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  // 依赖桩: 真实环境由 09-queue-snapshot-autoplay.js 提供
  sandbox.queueItemKey = (song) => String((song && (song.key || song.id)) || '');
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(EVENTS_FILE, 'utf8'), ctx, { filename: '02b-play-events.js' });
  vm.runInContext(fs.readFileSync(SCORE_FILE, 'utf8'), ctx, { filename: '02c-shuffle-score.js' });
  return sandbox;
}

// vm 沙盒里的数组属于另一个 realm, assert.deepStrictEqual 会连原型一起比,
// 所以跨 realm 的数组一律先转成本 realm 的普通数组。
const arr = (value) => Array.prototype.slice.call(value);

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

// 任务书里的 fixture: A 高偏好 / B 中等 / C 刚播过(冷却窗内)
function fixtureCandidate(key, stats, extra) {
  return Object.assign({
    key,
    name: 'Song ' + key,
    artist: 'Artist ' + key,
    album: 'Album ' + key,
    stats,
  }, extra || {});
}
const FIXTURE = () => ({
  A: fixtureCandidate('A', { plays: 30, completed: 27, completionRate: 0.91, earlySkipRate: 0.02, lastPlayedAt: NOW - 9 * 24 * HOUR }),
  B: fixtureCandidate('B', { plays: 8, completed: 5, completionRate: 0.67, earlySkipRate: 0.30, lastPlayedAt: NOW - 2 * 24 * HOUR }),
  C: fixtureCandidate('C', { plays: 1, completed: 1, completionRate: 1.00, earlySkipRate: 0.00, lastPlayedAt: NOW - 1 * HOUR }),
});

function score(sb, candidate, ctx) {
  return sb.scoreCandidate(candidate, Object.assign({ now: NOW, weights: sb.shuffleDefaultWeights() }, ctx || {}));
}
function fixedRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

// ------------------------------------------------------------
test('TEST 1 — 评分: A(高偏好) 必须高于 B(中等)', () => {
  const sb = makeSandbox();
  const f = FIXTURE();
  const a = score(sb, f.A);
  const b = score(sb, f.B);
  assert.ok(a.score > b.score, 'A=' + a.score.toFixed(4) + ' B=' + b.score.toFixed(4));
});

test('TEST 2 — scoreBreakdown 必须能独立解释"为什么得这个分"', () => {
  const sb = makeSandbox();
  const f = FIXTURE();
  const a = score(sb, f.A);
  const w = a.breakdown.weights;
  // features(原始特征) 与 terms(加权贡献) 并存
  assert.ok(a.breakdown.features && a.breakdown.terms, 'features/terms 都要有');
  assert.strictEqual(a.breakdown.features.affinity, Math.min(1, Math.log1p(30) / Math.log1p(30)));
  // terms 必须等于 weight * feature
  assert.ok(Math.abs(a.breakdown.terms.affinity - w.affinity * a.breakdown.features.affinity) < 1e-12);
  assert.ok(Math.abs(a.breakdown.terms.completion - w.completion * 0.91) < 1e-12);
  // 分数等于各项之和
  const sum = Object.keys(a.breakdown.terms).reduce((s, k) => s + a.breakdown.terms[k], 0);
  assert.ok(Math.abs(sum - a.score) < 1e-9, 'score 必须等于 terms 之和');
});

test('TEST 3 — earlySkipRate 未知时不得拿假数据凑分', () => {
  const sb = makeSandbox();
  const noStats = fixtureCandidate('N', { plays: 5, completed: 3, lastPlayedAt: NOW - 3 * 24 * HOUR });
  const s = score(sb, noStats);
  assert.strictEqual(s.breakdown.features.earlySkipKnown, false);
  assert.strictEqual(s.breakdown.terms.earlySkip, 0, '未知 -> 贡献必须为 0');
});

test('TEST 4 — earlySkipRate 已知时必须拉低分数', () => {
  const sb = makeSandbox();
  const base = { plays: 10, completed: 6, lastPlayedAt: NOW - 3 * 24 * HOUR };
  const clean = score(sb, fixtureCandidate('X', Object.assign({}, base, { earlySkipRate: 0.0 })));
  const skippy = score(sb, fixtureCandidate('Y', Object.assign({}, base, { earlySkipRate: 0.5 })));
  assert.ok(skippy.score < clean.score, '早跳率高的必须更低');
});

test('TEST 5 — 冷却: 冷却窗内的歌被硬屏蔽(不是降权)', () => {
  const sb = makeSandbox();
  const f = FIXTURE();
  const scored = [score(sb, f.C)];
  const gate = sb.applyCooldown(scored, { now: NOW, weights: sb.shuffleDefaultWeights() });
  assert.strictEqual(gate.kept.length, 0, 'C 不该被保留');
  assert.strictEqual(gate.excluded.length, 1);
  assert.strictEqual(gate.excluded[0].reason, 'cooldown');
});

test('TEST 6 — 同艺人相邻间隔: 上一个就是同艺人时必须挡掉', () => {
  const sb = makeSandbox();
  const x1 = fixtureCandidate('X1', { plays: 5, lastPlayedAt: 0 }, { artist: 'Same Artist', album: 'a1' });
  const x2 = fixtureCandidate('X2', { plays: 5, lastPlayedAt: 0 }, { artist: 'Same Artist', album: 'a2' });
  const scored = [score(sb, x1), score(sb, x2)];
  const blocked = sb.applyCooldown(scored, {
    now: NOW, weights: sb.shuffleDefaultWeights(), recentArtists: ['same artist'],
  });
  assert.strictEqual(blocked.kept.length, 0);
  assert.strictEqual(blocked.excluded[0].reason, 'artist-adjacent');
  // 没有最近艺人时两者都该放行
  const open = sb.applyCooldown(scored, { now: NOW, weights: sb.shuffleDefaultWeights() });
  assert.strictEqual(open.kept.length, 2);
});

test('TEST 7 — weightedSample: 注入 rng 可确定, 并回传 temperature/probability', () => {
  const sb = makeSandbox();
  const f = FIXTURE();
  const ranked = [score(sb, f.A), score(sb, f.B)];
  const first = sb.weightedSample(ranked, fixedRng([0.0]), 0.25);
  assert.strictEqual(first.picked.key, 'A', 'rng=0 应抽到最高分');
  const last = sb.weightedSample(ranked, fixedRng([0.999999]), 0.25);
  assert.ok(['A', 'B'].indexOf(last.picked.key) >= 0);
  assert.strictEqual(last.temperature, 0.25);
  assert.ok(last.probability > 0 && last.probability <= 1);
  assert.ok(first.probability > last.probability, 'A 的命中概率必须高于 B');
});

test('TEST 8 — 全链路: 评分->冷却->抽样 产出的队列每首恰好一次', () => {
  const sb = makeSandbox();
  const queue = ['t1', 't2', 't3', 't4', 't5', 't6'].map((k, i) =>
    fixtureCandidate(k, { plays: i, completed: i, lastPlayedAt: 0 }, { artist: 'A' + i, album: 'Al' + i }));
  const plan = sb.buildShuffleOrder(queue, {
    now: NOW, weights: sb.shuffleDefaultWeights(), rng: fixedRng([0.3, 0.6, 0.15, 0.8, 0.45]),
  });
  assert.strictEqual(plan.applied, true, 'reason=' + plan.reason);
  assert.strictEqual(plan.order.length, 6);
  assert.deepStrictEqual(arr(plan.order).sort(), ['t1', 't2', 't3', 't4', 't5', 't6']);
});

test('TEST 9 — 安全阀: 空 / 单曲 / 全被冷却 → applied=false 且顺序原样', () => {
  const sb = makeSandbox();
  const empty = sb.buildShuffleOrder([], { now: NOW });
  assert.strictEqual(empty.applied, false);
  assert.strictEqual(empty.reason, 'insufficient-candidates');

  const one = sb.buildShuffleOrder([fixtureCandidate('only', {})], { now: NOW });
  assert.strictEqual(one.applied, false);
  assert.deepStrictEqual(arr(one.order), ['only']);

  // 全部在冷却窗内: 必须老实说"什么都没做", 而不是谎报已优化
  const cooled = ['c1', 'c2', 'c3'].map((k) => fixtureCandidate(k, { plays: 5, lastPlayedAt: NOW - HOUR }, { artist: k, album: k }));
  const allCooled = sb.buildShuffleOrder(cooled, { now: NOW, weights: sb.shuffleDefaultWeights() });
  assert.strictEqual(allCooled.applied, false);
  assert.strictEqual(allCooled.reason, 'all-cooled');
  assert.deepStrictEqual(arr(allCooled.order), ['c1', 'c2', 'c3'], '必须原样返回');
});

test('TEST 10 — 插入比例: 每 3 首 1 首、不连续插、每首恰好一次', () => {
  const sb = makeSandbox();
  const queue = [];
  for (let i = 0; i < 9; i += 1) {
    queue.push(fixtureCandidate('s' + i, { plays: i, completed: i, lastPlayedAt: 0 }, { artist: 'Ar' + i, album: 'Alb' + i }));
  }
  const plan = sb.planSmartShuffleOrder(queue, {
    now: NOW, weights: sb.shuffleDefaultWeights(), rng: fixedRng([0.2, 0.7, 0.4, 0.9, 0.1, 0.55, 0.35, 0.65, 0.5]),
  });
  assert.strictEqual(plan.applied, true, 'reason=' + plan.reason);
  assert.strictEqual(plan.insertions.length, 3, '9 首 / N=3 应有 3 次插入');
  for (let i = 1; i < plan.insertions.length; i += 1) {
    assert.ok(plan.insertions[i].atIndex - plan.insertions[i - 1].atIndex >= 2, '不允许连续插入');
  }
  assert.strictEqual(plan.order.length, 9);
  const sorted = arr(plan.order).sort();
  assert.deepStrictEqual(sorted, queue.map((q) => q.key).sort(), '每首恰好出现一次');
});

// ------------------------------------------------------------
// P0 黑匣子
// ------------------------------------------------------------
function endSession(sb, key, listenMs, maxProgress, endReason, extra) {
  return sb.playEventFinalizeSession({
    sessionId: 'sess-' + key + '-' + Math.random().toString(36).slice(2, 8),
    key: key,
    song: { provider: 'netease', name: 'Song ' + key, artist: 'Artist ' + key, duration: 240 },
    startedAt: NOW,
    listenMs: listenMs,
    maxProgress: maxProgress,
    context: null,
  }, Object.assign({ completed: false, effective: false, endReason: endReason, durationMs: 240000 }, extra || {}));
}

test('TEST 11 — P0: <45s 短跳过必须留痕 (这正是旧实现丢掉的那一类)', () => {
  const sb = makeSandbox();
  const rec = endSession(sb, 'short', 12000, 0.05, 'next');
  assert.ok(rec, '必须返回记录');
  assert.strictEqual(rec.type, 'play');
  assert.strictEqual(rec.listenMs, 12000);
  assert.strictEqual(rec.maxProgress, 0.05);
  assert.strictEqual(rec.endReason, 'next');
  assert.strictEqual(rec.earlySkip, true, '12s / 5% 必须判定为早跳');
  assert.strictEqual(rec.completed, false);
  assert.strictEqual(sb.playEventsMemory.length, 1, '必须真的落库');
});

test('TEST 12 — P0: 事件表只追加, 绝不按 key 去重', () => {
  const sb = makeSandbox();
  endSession(sb, 'same', 5000, 0.02, 'next');
  endSession(sb, 'same', 6000, 0.03, 'next');
  endSession(sb, 'same', 200000, 0.95, 'ended', { completed: true });
  assert.strictEqual(sb.playEventsMemory.length, 3, '同一首播 3 次 = 3 条');
  const agg = sb.playEventsSongStatsMap()['same'];
  assert.strictEqual(agg.plays, 3);
  assert.strictEqual(agg.completed, 1);
  assert.ok(Math.abs(agg.earlySkipRate - 2 / 3) < 1e-9, 'earlySkipRate=' + agg.earlySkipRate);
});

test('TEST 13 — P0: 每日汇总能算出"播放/完整/短跳/手动下一首"', () => {
  const sb = makeSandbox();
  endSession(sb, 'a', 12000, 0.05, 'next', { userInitiated: true });
  endSession(sb, 'b', 200000, 0.95, 'ended', { completed: true });
  endSession(sb, 'c', 300000, 1.0, 'prev', { userInitiated: true });
  // startedAt 必须显式给 —— 否则它取 Date.now(), 与上面钉死的 NOW 会分成两天
  // (这个测试曾经"刚好同一天"才通过, 时间一过就挂)
  sb.playEventRecord({ type: 'error', key: 'd', provider: 'kugou', startedAt: NOW });
  const rows = arr(sb.playEventDailySummary());
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].plays, 3);
  assert.strictEqual(rows[0].completed, 1);
  assert.strictEqual(rows[0].earlySkip, 1);
  assert.strictEqual(rows[0].manualNext, 2, 'next + prev 都算手动切歌');
  assert.strictEqual(rows[0].errors, 1);
});

test('TEST 14 — 事件表在无 IndexedDB 环境下也不抛异常', () => {
  const sb = makeSandbox();
  assert.doesNotThrow(() => sb.playEventRecord({ type: 'play', key: 'k' }));
  assert.doesNotThrow(() => sb.playEventRecord(null));
  assert.doesNotThrow(() => sb.playEventRecord('not an object'));
  assert.strictEqual(sb.playEventCount(), 3);
});

test('TEST 27 — 发现位配额: 资料库外的歌按配额插入, 且不连续', () => {
  const sb = makeSandbox();
  const queue = [];
  for (let i = 0; i < 30; i += 1) queue.push(fixtureCandidate('q' + i, { plays: 2, lastPlayedAt: NOW - 3 * 24 * HOUR }));
  // 资料库内候选(分数更高) + 资料库外候选(无历史, 分数天然低)
  const lib = [];
  for (let i = 0; i < 6; i += 1) {
    lib.push(fixtureCandidate('L' + i, { plays: 20, completed: 18, lastPlayedAt: NOW - 5 * 24 * HOUR }, { candidateSource: 'personal-playlists' }));
  }
  const disc = [];
  for (let i = 0; i < 4; i += 1) disc.push(fixtureCandidate('D' + i, {}, { candidateSource: 'similar', provider: 'netease' }));
  const pool = lib.concat(disc);
  const base = { now: NOW, weights: sb.shuffleDefaultWeights(), rng: fixedRng(new Array(800).fill(0.5)) };

  const none = sb.planSmartShuffleInsertions(queue, pool, Object.assign({}, base, { discoveryShare: 0 }));
  assert.ok(none.applied, 'reason=' + none.reason);
  assert.strictEqual(none.insertions.filter(x => x.discovery).length, 0, '配额 0 时不得插入发现歌');

  // 配额 1 = 最大密度: 每隔一首插入一首发现歌(绝不连续两首都是新的)
  const all = sb.planSmartShuffleInsertions(queue, pool, Object.assign({}, base, { discoveryShare: 1 }));
  assert.ok(all.applied, 'reason=' + all.reason);
  assert.ok(all.insertions.length >= 6, '长队列应有多次插入, 实际=' + all.insertions.length);
  const discCount = all.insertions.filter(x => x.discovery).length;
  assert.strictEqual(discCount, Math.floor(all.insertions.length / 2),
    '配额 1 时约为半数, 实际 ' + discCount + '/' + all.insertions.length);
  for (let i = 1; i < all.insertions.length; i += 1) {
    assert.ok(!(all.insertions[i].discovery && all.insertions[i - 1].discovery), '不得连续两首都是资料库外');
  }

  // 默认 0.35 也要真的能插进来(否则等于没做)
  const some = sb.planSmartShuffleInsertions(queue, pool, Object.assign({}, base, { discoveryShare: 0.35 }));
  assert.ok(some.applied, 'reason=' + some.reason);
  assert.ok(some.insertions.filter(x => x.discovery).length >= 1, '默认配额下至少要插进 1 首资料库外的歌');
});

test('TEST 28 — 发现池必须剔除资料库里已有的歌', () => {
  const sb = makeSandbox();
  const basePool = [
    { provider: 'netease', id: '1', name: 'Known Song', artist: 'Artist A', durationMs: 200000 },
    { provider: 'netease', id: '2', name: 'Another', artist: 'Artist B', durationMs: 210000 },
  ];
  // 服务端回来的相似歌: 第 1 首与资料库同曲(签名相同), 第 2 首是新歌
  const similar = [
    { provider: 'netease', id: '1', name: 'Known Song', artist: 'Artist A', durationMs: 200000, candidateSource: 'similar' },
    { provider: 'netease', id: '9', name: 'Brand New', artist: 'Artist Z', durationMs: 190000, candidateSource: 'similar' },
  ];
  sb.smartShuffleFetchSimilar = () => Promise.resolve(similar);
  sb.smartShufflePickSeeds = () => [{ provider: 'netease', id: '1' }];
  return sb.smartShuffleComposePool(basePool, { songStats: {} }, sb.shuffleDefaultWeights()).then(res => {
    assert.strictEqual(res.discovery, 1, '只应加进 1 首新歌, 实际=' + res.discovery);
    assert.strictEqual(res.pool.length, 3, '合并后应为 3 首');
    const added = res.pool.filter(c => c.candidateSource === 'similar');
    assert.strictEqual(added.length, 1);
    assert.strictEqual(added[0].name, 'Brand New');
  });
});

test('TEST 29 — 同艺人发现(artist-more)与 simi 一样算"发现位"', () => {
  const sb = makeSandbox();
  const queue = [];
  for (let i = 0; i < 24; i += 1) queue.push(fixtureCandidate('q' + i, { plays: 2, lastPlayedAt: NOW - 3 * 24 * HOUR }));
  const lib = [];
  for (let i = 0; i < 6; i += 1) lib.push(fixtureCandidate('L' + i, { plays: 20, lastPlayedAt: NOW - 5 * 24 * HOUR }, { candidateSource: 'personal-playlists' }));
  // 同艺人搜索回来的候选
  const artistMore = ['A1', 'A2', 'A3', 'A4'].map(k =>
    fixtureCandidate(k, {}, { candidateSource: 'artist-more', provider: 'qq', seedArtist: 'The Score' }));
  const plan = sb.planSmartShuffleInsertions(queue, lib.concat(artistMore), {
    now: NOW, weights: sb.shuffleDefaultWeights(), discoveryShare: 0.5, rng: fixedRng(new Array(600).fill(0.5)),
  });
  assert.ok(plan.applied, 'reason=' + plan.reason);
  const disc = plan.insertions.filter(x => x.discovery);
  assert.ok(disc.length >= 1, 'artist-more 候选必须能占到发现位, 实际=' + disc.length);
  assert.ok(disc.every(x => x.song && x.song.candidateSource === 'artist-more'));
});

test('TEST 30 — 同艺人发现的种子艺人: 有收听历史时按播放次数取, 无历史按池内出现次数', () => {
  const sb = makeSandbox();
  const pool = [
    { provider: 'qq', id: '1', name: 'a', artist: 'Alpha / X' },
    { provider: 'qq', id: '2', name: 'b', artist: 'Beta' },
    { provider: 'qq', id: '3', name: 'c', artist: 'Beta' },
    { provider: 'qq', id: '4', name: 'd', artist: 'Beta' },
  ];
  const withHistory = sb.smartShufflePickArtists(pool, { artistStats: { Beta: { plays: 9 }, Alpha: { plays: 3 } } }, 2);
  // 跨 vm 领域: sandbox 里的 Array 原型不同, 必须先转成本地数组
  assert.deepStrictEqual(arr(withHistory), ['Beta', 'Alpha'], '按播放次数降序');
  const noHistory = sb.smartShufflePickArtists(pool, { artistStats: {} }, 2);
  assert.strictEqual(noHistory[0], 'Beta', '无历史时按池内出现次数');
});

test('TEST 24 — 首页今日口径: 事件表同时覆盖内部播放与 AM 外部播放', () => {
  const sb = makeSandbox();
  endSession(sb, 'inner1', 60000, 0.9, 'ended', { completed: true });   // 内部播放
  endSession(sb, 'inner2', 30000, 0.5, 'next');                        // 内部短跳过
  sb.playEventRecord({                                                 // AM 外部播放
    type: 'play', provider: 'smtc-external', key: 'smtc:X|Y',
    sig: 'Y|X|200', sigLoose: 'x|40', listenMs: 90000, completed: false,
    startedAt: NOW,   // 必须钉住, 否则它会落在"今天", 与上面三个分成两天
  });

  // 查询也用 NOW 推导的日期 —— 不能写 Date.now(), 那是时间炸弹
  const dayKey = sb.playEventsDayKey(NOW);
  const day = sb.playEventsDailySummaryFor(dayKey);
  assert.strictEqual(day.has, true, '当天必须有记录');
  assert.strictEqual(day.plays, 3, 'plays=' + day.plays);
  assert.strictEqual(day.external, 1, 'external=' + day.external);
  assert.strictEqual(day.songCount, 3, '不同歌曲数 songCount=' + day.songCount);
  assert.strictEqual(day.listenMs, 180000, 'listenMs=' + day.listenMs);
  assert.ok(sb.playEventsDailyDayKeys().indexOf(dayKey) >= 0, '日期索引要包含今天');
});

test('TEST 25 — 首页必须用事件表**覆盖**今日指标, 不能相加(否则内部播放算两遍)', () => {
  const src = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '03a-home-dashboard.js'), 'utf8');
  const start = src.indexOf('function homeDashboardTodayListenMetrics()');
  assert.ok(start >= 0, '必须找得到该函数');
  const body = src.slice(start, start + 3500);
  assert.ok(/playEventsDailySummaryFor/.test(body), '必须读事件表');
  assert.ok(/listenMs = eventToday\.listenMs/.test(body), '必须是覆盖赋值');
  assert.ok(!/listenMs \+= eventToday/.test(body), '绝不能相加');
  // songCount 必须有变量声明(曾漏过: 赋值给了未声明的名字, 返回值不受影响)
  assert.ok(/var songCount = Object\.keys\(keys\)\.length/.test(body), 'songCount 必须声明为变量');
  assert.ok(/songCount: songCount/.test(body), '返回值必须用该变量');
});

test('TEST 26 — 试听风险(fee>0)软降权, 并写进决策行', () => {
  const sb = makeSandbox();
  const risky = fixtureCandidate('r1', { plays: 3, lastPlayedAt: 0 }, { trialRisk: true });
  const safe = fixtureCandidate('s1', { plays: 3, lastPlayedAt: 0 }, { trialRisk: false });
  const a = sb.scoreCandidate(risky, { now: NOW, weights: sb.shuffleDefaultWeights() });
  const b = sb.scoreCandidate(safe, { now: NOW, weights: sb.shuffleDefaultWeights() });
  assert.ok(a.breakdown.features.source >= 0.5, '试听风险惩罚应有 0.5, 实际=' + a.breakdown.features.source);
  assert.ok(a.score < b.score, '带试听风险的必须更低分');
  const row = sb.smartShuffleDecisionRow('r1', 'n', a.score, a.breakdown, 0.1, false, '', true);
  assert.strictEqual(row.trialRisk, true, '决策行必须标记试听风险');
});

test('TEST 15 — 关闭状态(off)下不产生任何影子事件', () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.shuffleMode(), 'off', '默认必须是 off');
  const probe = sb.smartShuffleShadowProbe('test');
  assert.strictEqual(probe, null);
  assert.strictEqual(sb.playEventsMemory.length, 0);
});

// ------------------------------------------------------------
// P2: 插入规划 (允许新增, 但异常一律退回原计划)
// ------------------------------------------------------------
function queueFixture(keys) {
  return keys.map((k, i) => fixtureCandidate(k, { plays: i, completed: i, lastPlayedAt: 0 }, { artist: 'Ar' + i, album: 'Alb' + i }));
}
function poolFixture(keys) {
  return keys.map((k) => fixtureCandidate(k, { plays: 0, lastPlayedAt: 0 }, { artist: 'Po' + k, album: 'PoA' + k, name: 'Pool ' + k }));
}
const RNG = () => fixedRng([0.2, 0.6, 0.9, 0.4, 0.7, 0.35, 0.55, 0.8, 0.25]);

test('TEST 16 — 插入是追加: 每隔 N 首加 1 首, 原曲一首不少', () => {
  const sb = makeSandbox();
  const keys = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
  const plan = sb.planSmartShuffleInsertions(queueFixture(keys), poolFixture(['p1', 'p2', 'p3']), {
    now: NOW, weights: sb.shuffleDefaultWeights(), rng: RNG(),
  });
  assert.strictEqual(plan.applied, true, 'reason=' + plan.reason);
  const outKeys = arr(plan.order).map((s) => s.key);
  for (const k of keys) assert.ok(outKeys.indexOf(k) >= 0, k + ' 不能被丢掉');
  assert.strictEqual(plan.order.length, keys.length + plan.insertions.length, '长度=原曲+插入');
  assert.ok(plan.insertions.length >= 1, '至少插一首');
  // 每 3 首 1 首, 6 首最多 1 首 (不在末尾插)
  assert.ok(plan.insertions.length <= Math.floor((keys.length - 1) / 3), '插入数不得超过槽位数');
});

test('TEST 17 — 绝不连续插入', () => {
  const sb = makeSandbox();
  const plan = sb.planSmartShuffleInsertions(queueFixture(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9']),
    poolFixture(['p1', 'p2', 'p3']), { now: NOW, weights: sb.shuffleDefaultWeights(), rng: RNG() });
  assert.strictEqual(plan.applied, true, 'reason=' + plan.reason);
  const keys = arr(plan.order).map((s) => s.key);
  const poolKeys = ['p1', 'p2', 'p3'];
  const positions = keys.map((k, i) => (poolKeys.indexOf(k) >= 0 ? i : -1)).filter((i) => i >= 0);
  assert.ok(positions.length >= 2, '应有多次插入');
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] - positions[i - 1] >= 2, '插入位置不能相邻: ' + positions.join(','));
  }
});

test('TEST 18 — 安全阀: 候选池为空 -> 原样返回, applied=false', () => {
  const sb = makeSandbox();
  const keys = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
  const plan = sb.planSmartShuffleInsertions(queueFixture(keys), [], { now: NOW, weights: sb.shuffleDefaultWeights() });
  assert.strictEqual(plan.applied, false);
  assert.strictEqual(plan.reason, 'empty-pool');
  assert.deepStrictEqual(arr(plan.order).map((s) => s.key), keys, '必须原样返回');
});

test('TEST 19 — 已在队列里的歌不会被重复插入', () => {
  const sb = makeSandbox();
  // 队列必须 >= 2 首才会走到去重逻辑(单曲队列直接判定不值得动)
  const queue = [
    { key: 'q0', name: '夜曲', artist: '周杰伦', durationMs: 227000, stats: {} },
    { key: 'q1', name: '晴天', artist: '周杰伦', durationMs: 269000, stats: {} },
  ];
  const sameSong = { key: 'other-source:晴天', name: '晴天', artist: '周杰伦', durationMs: 269000, stats: {} };
  const plan = sb.planSmartShuffleInsertions(queue, [sameSong], { now: NOW, weights: sb.shuffleDefaultWeights() });
  assert.strictEqual(plan.applied, false);
  const reasons = arr(plan.excluded).map((e) => e.reason);
  assert.ok(reasons.indexOf('already-queued') >= 0, '必须按签名去重, reasons=' + JSON.stringify(reasons));
});

test('TEST 20 — 插入的歌曲必须带 provenance (insertedBy)', () => {
  const sb = makeSandbox();
  const plan = sb.planSmartShuffleInsertions(queueFixture(['q1', 'q2', 'q3', 'q4', 'q5', 'q6']),
    poolFixture(['p1', 'p2', 'p3']), { now: NOW, weights: sb.shuffleDefaultWeights(), rng: RNG() });
  assert.strictEqual(plan.applied, true);
  const inserted = arr(plan.order).filter((s) => s.insertedBy === 'smart-shuffle');
  assert.strictEqual(inserted.length, plan.insertions.length, '每首插入曲都要有 insertedBy');
  assert.ok(plan.insertions[0].breakdown, '必须留下 scoreBreakdown 供调参回放');
});

test('TEST 21 — 冷却期内的候选宁可不插, 也不硬塞', () => {
  const sb = makeSandbox();
  const cooled = [fixtureCandidate('x1', { plays: 5, lastPlayedAt: NOW - HOUR }, { artist: 'X', album: 'X', name: 'Cooled' })];
  const plan = sb.planSmartShuffleInsertions(queueFixture(['q1', 'q2', 'q3', 'q4', 'q5', 'q6']), cooled,
    { now: NOW, weights: sb.shuffleDefaultWeights(), rng: RNG() });
  assert.strictEqual(plan.applied, false);
  assert.strictEqual(plan.reason, 'no-insertion-selected');
  assert.deepStrictEqual(arr(plan.order).map((s) => s.key), ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
});

test('TEST 22 — 明确不可播且无备用源的候选直接剔除', () => {
  const sb = makeSandbox();
  const bad = [Object.assign(fixtureCandidate('bad', { plays: 0, lastPlayedAt: 0 }), { name: 'Bad', playable: false, crossSource: false })];
  const plan = sb.planSmartShuffleInsertions(queueFixture(['q1', 'q2', 'q3', 'q4', 'q5', 'q6']), bad,
    { now: NOW, weights: sb.shuffleDefaultWeights() });
  assert.strictEqual(plan.applied, false);
  const reasons = arr(plan.excluded).map((e) => e.reason);
  assert.ok(reasons.indexOf('not-playable') >= 0, 'reasons=' + JSON.stringify(reasons));
});

test('TEST 23 — shadow 推演绝不修改 playQueue / currentIdx (核心不变量)', async () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.writeShuffleConfig({ mode: 'shadow' }), true);
  const queue = queueFixture(['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
  const pool = poolFixture(['p1', 'p2', 'p3']);
  sb.playQueue = queue;
  sb.currentIdx = 0;
  sb.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, candidates: pool }) });

  const before = arr(queue).map((s) => s.key).join(',');
  const idxBefore = sb.currentIdx;
  assert.strictEqual(sb.smartShuffleShadowProbe('test'), true, '影子模式应排队异步推演');
  await new Promise((r) => setTimeout(r, 40));

  assert.strictEqual(arr(sb.playQueue).map((s) => s.key).join(','), before, 'playQueue 绝不能被修改');
  assert.strictEqual(sb.currentIdx, idxBefore, 'currentIdx 绝不能被修改');
  assert.strictEqual(arr(sb.playQueue).length, queue.length, '队列长度也不能变');
  const shadowEvents = arr(sb.playEventsMemory).filter((e) => e.type === 'shuffle-shadow');
  assert.strictEqual(shadowEvents.length, 1, '必须留下一条影子决策记录');
  assert.ok(Array.isArray(shadowEvents[0].decisions), '决策记录必须带 scoreBreakdown');
});
