'use strict';
// ============================================================
// Smart Shuffle 主页洞察（02d）—— 只读 + 真实进度 + 安全回退
//
// 用真实源码(vm 加载 02c + 02d), 只替换数据来源(内存聚合/候选池缓存)。
// 重点验证: 不进网络、不动队列、不消耗随机、重复读取不推进进度。
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const SCORE = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '02c-shuffle-score.js'), 'utf8');
const INSIGHT = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '02d-shuffle-insight.js'), 'utf8');

function makeSandbox(opts) {
  opts = opts || {};
  const sb = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Date, RegExp, Error, Promise,
    isFinite, isNaN, parseInt, parseFloat, Infinity,
    setTimeout, clearTimeout,
    fetchCallCount: 0,
    playQueue: opts.queue || [],
    currentIdx: 0,
  };
  sb.window = sb;
  sb.globalThis = sb;
  sb.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  // 故意让 fetch 计数并抛错: 02d 一旦联网就会暴露
  sb.fetch = function () { sb.fetchCallCount += 1; return Promise.reject(new Error('network should not be used')); };
  // 数据来源(02b 的聚合 + 02c 的池缓存)
  sb.playEventsSongStatsMap = () => opts.songStats || {};
  sb.playEventsArtistStatsMap = () => opts.artistStats || {};
  sb.playEventsSignatureStatsMap = () => opts.signatureStats || {};
  sb.playEventsLooseStatsMap = () => opts.looseStats || {};
  const ctx = vm.createContext(sb);
  vm.runInContext(SCORE, ctx);
  vm.runInContext(INSIGHT, ctx);
  sb.smartShufflePoolState = { at: Date.now(), candidates: opts.pool || [], error: '' };
  return sb;
}

function buildPool(count, opts) {
  opts = opts || {};
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      provider: 'netease',
      id: 'p' + i,
      name: 'Song ' + i,
      artist: 'Artist ' + (i % (opts.artists || 12)),
      album: 'Album ' + (i % 7),
      durationMs: 180000 + (i % 5) * 1000,
      cover: opts.noCover ? '' : ('https://cover/' + i + '.jpg'),
      candidateSource: 'personal-playlists',
    });
  }
  return out;
}

// 直接造聚合: 让每首歌有指定次数的播放/完播/早跳
function buildSongStats(pool, perSong) {
  const stats = {};
  (pool || []).forEach((c, i) => {
    stats[c.id] = {
      key: c.id, name: c.name, artist: c.artist,
      plays: perSong.plays || 0,
      completed: perSong.completed || 0,
      earlySkips: perSong.earlySkips || 0,
      listenMs: perSong.listenMs || 0,
      lastPlayedAt: perSong.lastPlayedAt || 0,
    };
  });
  return stats;
}

function buildArtistStats(count) {
  const out = {};
  for (let i = 0; i < count; i += 1) out['Artist ' + i] = { name: 'Artist ' + i, plays: 5, listenMs: 60000, lastPlayedAt: 0 };
  return out;
}

test('01 无历史 + 空池 -> 学习态, 进度 0, 不抛错', () => {
  const sb = makeSandbox({ pool: [] });
  const insight = sb.smartShuffleHomeInsight(2);
  assert.strictEqual(insight.phase, 'learning');
  assert.strictEqual(insight.progress, 0);
  assert.strictEqual(insight.fallback, 'not-ready');
  assert.deepStrictEqual(Array.from(insight.songs), []);
  assert.strictEqual(sb.fetchCallCount, 0, '不得联网');
});

test('02 部分数据 -> 真实百分比(0<进度<100)且计数来自聚合', () => {
  const pool = buildPool(210);
  const stats = buildSongStats(pool.slice(0, 20), { plays: 2, completed: 1, earlySkips: 1, listenMs: 120000 });
  const sb = makeSandbox({ pool, songStats: stats, artistStats: buildArtistStats(5) });
  const insight = sb.smartShuffleHomeInsight(2);
  assert.strictEqual(insight.phase, 'learning');
  assert.ok(insight.progress > 0 && insight.progress < 100, '进度应为中间值, 实际=' + insight.progress);
  const snap = insight.snapshot;
  assert.strictEqual(snap.plays, 40, '有效播放 = 20 首 × 2 次');
  assert.strictEqual(snap.distinctSongs, 20);
  assert.strictEqual(snap.distinctArtists, 5);
  assert.strictEqual(snap.poolSize, 210);
});

test('03 达标 -> 推荐态, 歌曲来自真实候选池且理由非空', () => {
  const pool = buildPool(210);
  const stats = buildSongStats(pool.slice(0, 45), { plays: 4, completed: 1, earlySkips: 1, listenMs: 200000, lastPlayedAt: Date.now() - 30 * 24 * 3600 * 1000 });
  const sb = makeSandbox({ pool, songStats: stats, artistStats: buildArtistStats(14) });
  const insight = sb.smartShuffleHomeInsight(2);
  assert.strictEqual(insight.phase, 'ready', 'fallback=' + insight.fallback);
  assert.strictEqual(insight.progress, 100);
  assert.ok(insight.songs.length >= 1, '至少要有一首真实推荐');
  insight.songs.forEach((song, i) => {
    assert.ok(song.name, 'song ' + i + ' 必须有名字');
    assert.ok(song.artist, 'song ' + i + ' 必须有艺人');
    assert.ok(song.reason && song.reason.length > 0, 'song ' + i + ' 必须有推荐理由');
    assert.ok(pool.some(c => c.id === song.key), '推荐必须来自真实候选池: ' + song.key);
  });
  // 同一批推荐不重复艺人
  const artists = insight.songs.map(s => s.artist);
  assert.strictEqual(new Set(artists).size, artists.length, '推荐里不应重复艺人');
});

test('04 候选池为空 -> 回退学习态(不伪造推荐)', () => {
  const pool = [];
  const sb = makeSandbox({ pool, songStats: {}, artistStats: {} });
  const insight = sb.smartShuffleHomeInsight(2);
  assert.strictEqual(insight.phase, 'learning');
  assert.strictEqual(insight.songs.length, 0);
});

test('05 全部候选都在冷却窗内 -> 回退「等待候选」态且原因可查', () => {
  const pool = buildPool(210);
  // 所有候选刚播过 1 分钟 -> 冷却期(24h)内, 全被排除
  const stats = buildSongStats(pool, { plays: 4, completed: 1, earlySkips: 1, listenMs: 200000, lastPlayedAt: Date.now() - 60 * 1000 });
  const sb = makeSandbox({ pool, songStats: stats, artistStats: buildArtistStats(14) });
  const insight = sb.smartShuffleHomeInsight(2);
  assert.strictEqual(insight.phase, 'pool-pending', '全冷却时必须回退到"等待候选", 不摆假推荐');
  assert.strictEqual(insight.fallback, 'all-cooled');
  assert.strictEqual(insight.songs.length, 0);
});

test('06 缺封面/元数据不全 -> 仍可渲染, 缺封面的不丢整条', () => {
  const pool = buildPool(210, { noCover: true });
  const stats = buildSongStats(pool.slice(0, 45), { plays: 4, completed: 1, earlySkips: 1, listenMs: 200000, lastPlayedAt: Date.now() - 30 * 24 * 3600 * 1000 });
  const sb = makeSandbox({ pool, songStats: stats, artistStats: buildArtistStats(14) });
  const insight = sb.smartShuffleHomeInsight(2);
  assert.strictEqual(insight.phase, 'ready', 'fallback=' + insight.fallback);
  assert.ok(insight.songs.length >= 1);
  assert.strictEqual(insight.songs[0].cover, '', '无封面应为空串, 由 UI 显示占位块');
});

test('07 只读: 重复调用结果一致, 不联网, 不动播放队列', () => {
  const queue = [{ id: 'cur', name: 'Current', artist: 'X' }];
  const pool = buildPool(210);
  const stats = buildSongStats(pool.slice(0, 45), { plays: 4, completed: 1, earlySkips: 1, listenMs: 200000, lastPlayedAt: Date.now() - 30 * 24 * 3600 * 1000 });
  const sb = makeSandbox({ pool, songStats: stats, artistStats: buildArtistStats(14), queue });
  const before = JSON.stringify(sb.playQueue);
  const a = sb.smartShuffleHomeInsight(2);
  const b = sb.smartShuffleHomeInsight(2);
  const c = sb.smartShuffleHomeInsight(2);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), '两次结果必须完全一致');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(c)));
  assert.strictEqual(JSON.stringify(sb.playQueue), before, '不得修改播放队列');
  assert.strictEqual(sb.fetchCallCount, 0, '不得联网');
});

test('08 进度不因重复读取而增长', () => {
  const pool = buildPool(210);
  const stats = buildSongStats(pool.slice(0, 20), { plays: 2, completed: 1, earlySkips: 1, listenMs: 120000 });
  const sb = makeSandbox({ pool, songStats: stats, artistStats: buildArtistStats(5) });
  const first = sb.smartShuffleLearningSnapshot().percent;
  for (let i = 0; i < 10; i += 1) sb.smartShuffleLearningSnapshot();
  assert.strictEqual(sb.smartShuffleLearningSnapshot().percent, first, '重复读取不得推进进度');
});

test('09 静态边界: 02d 不得联网/动队列/消耗随机/重建算法', () => {
  const code = INSIGHT.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/fetch\s*\(/.test(code), '不得发起网络请求');
  assert.ok(!/playQueueAt|playInApp|playSongsInApp/.test(code), '不得播放');
  assert.ok(!/playQueue\s*(\.length\s*=|\.push|\.splice)/.test(code), '不得修改播放队列');
  assert.ok(!/Math\.random/.test(code), '不得消耗随机数(推荐必须确定性)');
  assert.ok(!/planSmartShuffleInsertions|buildShuffleOrder|planSmartShuffleOrder/.test(code),
    '不得重建插入/乱序计划 —— 必须复用 02c 的评分与冷却');
  assert.ok(/scoreCandidate/.test(code) && /applyCooldown/.test(code), '必须复用 02c 的评分与冷却');
  assert.ok(/smartShuffleCachedPool/.test(code), '必须只读现有池缓存');
});

test('10 主页接线: 卡片渲染进 daily-review-card 且不替换原内容', () => {
  const DASH = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '03a-home-dashboard.js'), 'utf8');
  assert.ok(/function renderHomeSmartShuffleCard\(\)/.test(DASH), '必须有渲染函数');
  assert.ok(/insertBefore\(block, actions\)/.test(DASH), '必须插到操作按钮之前, 不能覆盖卡片');
  assert.ok(!/daily-review-(date|time|quote|source)'\)[^\n]*textContent\s*=\s*['"]/.test(DASH.replace(/\/\/[^\n]*/g, '')),
    '不得写死日期/时钟/热评内容');
  assert.ok(/dataset\.ssFingerprint/.test(DASH), '必须有 fingerprint 幂等保护(避免每次重渲染抖动)');
  // 两个渲染入口都要带上它
  const hero = DASH.slice(DASH.indexOf('function renderHomeDashboardHero('), DASH.indexOf('function homeDashboardNextReview('));
  assert.ok(/renderHomeSmartShuffleCard\(\)/.test(hero), '时钟/热评渲染路径也要刷新');
  const dock = DASH.slice(DASH.indexOf('function renderHomeInsightDock('), DASH.indexOf('function renderHomeInsightDock(') + 400);
  assert.ok(/renderHomeSmartShuffleCard\(\)/.test(dock), 'insight dock 渲染路径也要刷新');
});

test('11 模块加载顺序: 02d 必须在 03a 之前', () => {
  const LOADER = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
  const i2d = LOADER.indexOf('02d-shuffle-insight.js');
  const i3a = LOADER.indexOf('03a-home-dashboard.js');
  assert.ok(i2d > 0, '02d 必须注册');
  assert.ok(i3a > 0 && i2d < i3a, '02d 必须在 03a 之前加载');
});

test('12 进度实时: 统计变化后立刻反映, 不被推荐缓存拖住', () => {
  const pool = buildPool(210);
  const few = buildSongStats(pool.slice(0, 10), { plays: 1, completed: 0, earlySkips: 0, listenMs: 60000 });
  const many = buildSongStats(pool.slice(0, 45), { plays: 4, completed: 1, earlySkips: 1, listenMs: 200000, lastPlayedAt: Date.now() - 30 * 24 * 3600 * 1000 });
  const sb = makeSandbox({ pool, songStats: few, artistStats: buildArtistStats(5) });
  const before = sb.smartShuffleHomeInsightCached(2, 60 * 60 * 1000);
  sb.playEventsSongStatsMap = () => many;
  sb.playEventsArtistStatsMap = () => buildArtistStats(14);
  const after = sb.smartShuffleHomeInsightCached(2, 60 * 60 * 1000);
  assert.ok(after.progress > before.progress, '进度必须实时增长: ' + before.progress + ' -> ' + after.progress);
});

test('13 推荐打分有节流, 失效后重算', () => {
  const pool = buildPool(210);
  const stats = buildSongStats(pool.slice(0, 45), { plays: 4, completed: 1, earlySkips: 1, listenMs: 200000, lastPlayedAt: Date.now() - 30 * 24 * 3600 * 1000 });
  const sb = makeSandbox({ pool, songStats: stats, artistStats: buildArtistStats(14) });
  let calls = 0;
  const original = sb.smartShuffleHomeRecommendation;
  sb.smartShuffleHomeRecommendation = function (limit) { calls += 1; return original(limit); };
  sb.smartShuffleHomeInsightCached(2, 60 * 60 * 1000);
  sb.smartShuffleHomeInsightCached(2, 60 * 60 * 1000);
  sb.smartShuffleHomeInsightCached(2, 60 * 60 * 1000);
  assert.strictEqual(calls, 1, '节流期内只应打一次分, 实际=' + calls);
  sb.smartShuffleHomeInsightInvalidate();
  sb.smartShuffleHomeInsightCached(2, 60 * 60 * 1000);
  assert.strictEqual(calls, 2, '失效后应重算一次');
});

test('14 四状态映射: learning / pool-pending / ready 各有明确判定', () => {
  const pool = buildPool(210);
  // 1) 样本不足 -> learning
  const sb1 = makeSandbox({ pool, songStats: {}, artistStats: {} });
  assert.strictEqual(sb1.smartShuffleHomeInsight(2).phase, 'learning');
  // 2) 样本够了但候选池为空 -> pool-pending
  const full = buildSongStats(pool.slice(0, 45), { plays: 4, completed: 1, earlySkips: 1, listenMs: 200000, lastPlayedAt: Date.now() - 30 * 24 * 3600 * 1000 });
  const sb2 = makeSandbox({ pool: [], songStats: full, artistStats: buildArtistStats(14) });
  const s2 = sb2.smartShuffleHomeInsight(2);
  assert.strictEqual(s2.phase, 'pool-pending');
  assert.strictEqual(s2.fallback, 'pool-empty');
  // 3) 样本够 + 池太小 -> pool-pending(pool-too-small)
  const sb2b = makeSandbox({ pool: buildPool(50), songStats: full, artistStats: buildArtistStats(14) });
  const s2b = sb2b.smartShuffleHomeInsight(2);
  assert.strictEqual(s2b.phase, 'pool-pending');
  assert.strictEqual(s2b.fallback, 'pool-too-small');
  // 4) 全齐 -> ready
  const sb3 = makeSandbox({ pool, songStats: full, artistStats: buildArtistStats(14) });
  assert.strictEqual(sb3.smartShuffleHomeInsight(2).phase, 'ready');
});

test('15 推荐项必须携带完整歌曲对象与稳定身份(不是裸歌名)', () => {
  const pool = buildPool(210);
  const stats = buildSongStats(pool.slice(0, 45), { plays: 4, completed: 1, earlySkips: 1, listenMs: 200000, lastPlayedAt: Date.now() - 30 * 24 * 3600 * 1000 });
  const sb = makeSandbox({ pool, songStats: stats, artistStats: buildArtistStats(14) });
  const insight = sb.smartShuffleHomeInsight(2);
  assert.strictEqual(insight.phase, 'ready');
  insight.songs.forEach(s => {
    assert.ok(s.song && typeof s.song === 'object', '必须带完整歌曲对象');
    assert.ok(s.song.provider, '对象必须带 provider');
    assert.ok(s.song.id, '对象必须带 id');
    assert.ok(s.playKey, '必须有稳定身份键');
  });
});

test('16 播放能力与推荐结果分离验证: 入口缺失时 canPlay=false, 存在时=true', () => {
  const pool = buildPool(210);
  const stats = buildSongStats(pool.slice(0, 45), { plays: 4, completed: 1, earlySkips: 1, listenMs: 200000, lastPlayedAt: Date.now() - 30 * 24 * 3600 * 1000 });
  // 没有公共入口 -> 有推荐但不可播
  const sbNo = makeSandbox({ pool, songStats: stats, artistStats: buildArtistStats(14) });
  sbNo.queueItemKey = (s) => (s && s.id ? 'song:' + s.id : '');   // 身份键能力存在, 但播放入口缺失
  const noEntry = sbNo.smartShuffleHomeInsight(2);
  assert.strictEqual(noEntry.phase, 'ready', '推荐仍要显示');
  assert.strictEqual(noEntry.canPlay, false, '没有入口时不得声称可播');
  // 有入口 -> canPlay=true
  const sbYes = makeSandbox({ pool, songStats: stats, artistStats: buildArtistStats(14) });
  sbYes.queueItemKey = (s) => (s && s.id ? 'song:' + s.id : '');
  sbYes.playSongEntry = function () { return Promise.resolve(true); };
  const withEntry = sbYes.smartShuffleHomeInsight(2);
  assert.strictEqual(withEntry.phase, 'ready');
  assert.strictEqual(withEntry.canPlay, true);
});

test('17 播放链路契约: 公共入口复用 queueSong/playQueueAt, 主页不自行换源或改队列', () => {
  const QUEUE = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '10-queue-actions.js'), 'utf8');
  const DASH = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '03a-home-dashboard.js'), 'utf8');
  const entry = QUEUE.slice(QUEUE.indexOf('function playSongEntry('), QUEUE.indexOf('function playSearchResult('));
  assert.ok(/queueSong\(song, \{ position: 'next' \}\)/.test(entry), '必须复用 queueSong 做队列管理');
  assert.ok(/playQueueAt\(currentIdx/.test(entry), '必须走 playQueueAt');
  assert.ok(/queueItemKey\(song\)/.test(entry), '必须校验稳定身份');
  assert.ok(!/provider.*switch|resolvePlaybackProvider|switchPlaybackSource/.test(entry), '入口不得自行换源');
  const play = DASH.slice(DASH.indexOf('function homeSmartShufflePlay('), DASH.indexOf('function renderHomeSmartShuffleCard('));
  assert.ok(/playSongEntry\(/.test(play), '主页必须只调公共入口');
  assert.ok(!/playQueueAt|playQueue\s*\.|provider/.test(play.replace(/provider: String\(song\.provider/, '')), '主页不得直接改队列或选源');
  assert.ok(/dataset\.ssFingerprint/.test(DASH), '仍保留幂等保护');
});

test('18 池缓存已有数据时, ensurePool 不再发起任何请求', () => {
  const pool = buildPool(210);
  const sb = makeSandbox({ pool, songStats: {}, artistStats: {} });
  let fetchPoolCalls = 0;
  sb.smartShuffleFetchPool = function () { fetchPoolCalls += 1; return Promise.resolve(pool); };
  return sb.smartShuffleEnsurePoolCached().then(ok => {
    assert.strictEqual(ok, true);
    assert.strictEqual(fetchPoolCalls, 0, '缓存命中时不得重复拉取');
    assert.strictEqual(sb.fetchCallCount, 0);
  });
});

test('19 池为空时 ensurePool 只拉一次(并发去重), 且不碰播放/队列', () => {
  const pool = buildPool(210);
  const queue = [{ id: 'cur', name: 'Current', artist: 'X' }];
  const sb = makeSandbox({ pool: [], songStats: {}, artistStats: {}, queue });
  let fetchPoolCalls = 0;
  sb.smartShuffleFetchPool = function () {
    fetchPoolCalls += 1;
    sb.smartShufflePoolState = { at: Date.now(), candidates: pool, error: '' };
    return Promise.resolve(pool);
  };
  const before = JSON.stringify(sb.playQueue);
  return Promise.all([sb.smartShuffleEnsurePoolCached(), sb.smartShuffleEnsurePoolCached()]).then(results => {
    assert.deepStrictEqual(Array.from(results), [true, true]);
    assert.strictEqual(fetchPoolCalls, 1, '并发调用应合并为一次, 实际=' + fetchPoolCalls);
    assert.strictEqual(JSON.stringify(sb.playQueue), before, '不得修改播放队列');
  });
});

test('20 主页按需拉池的边界: 只在 pool-empty 触发, 且有防重入标志', () => {
  const DASH = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '03a-home-dashboard.js'), 'utf8');
  assert.ok(/insight\.fallback === 'pool-empty'/.test(DASH), '只对 pool-empty 触发');
  assert.ok(/homeSmartShufflePoolRequested/.test(DASH), '必须有防重入标志');
  const INS = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '02d-shuffle-insight.js'), 'utf8');
  const ensure = INS.slice(INS.indexOf('function smartShuffleEnsurePoolCached('), INS.indexOf('// 播放能力探测'));
  assert.ok(/smartShuffleFetchPool/.test(ensure), '必须复用既有数据通路');
  assert.ok(!/playQueueAt|playSongEntry|playInApp|playQueue\s*(\.length\s*=|\.push|\.splice)/.test(ensure),
    '拉池不得触发播放或改队列');
});
