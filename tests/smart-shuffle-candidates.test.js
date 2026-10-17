'use strict';
// ============================================================
// /api/smart-shuffle/candidates —— 候选池与跨源归并测试
//
// 覆盖:
//   1. 跨源归并复用 neteaseSourceMatch* 指纹(不是另造一套)
//   2. **版本令牌防线**: 同名同艺人同长度的 Live/Remix/伴奏 绝不能被当成同一首
//   3. 保守可用性过滤
//   4. 架构红线: 服务端只回答"有哪些候选", **不打分**
//
// 说明: server.js 无法 require, 按仓库既有做法(vm + 真实源码切片)加载被测函数。
// 运行: node tests/smart-shuffle-candidates.test.js
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const SERVER = fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8');

const MATCHER_START = 'function neteaseSourceMatchText(value) {';
const MATCHER_END = 'function neteaseSourceMatchCacheKey(id, hints) {';
const POOL_START = 'const SMART_SHUFFLE_POOL_TTL_MS';
const POOL_END = 'function loginEasterEggGateUnlocked() {';
const ROUTE_MARK = "if (pn === '/api/smart-shuffle/candidates') {";

function slice(text, start, end, label) {
  const from = text.indexOf(start);
  const to = end ? text.indexOf(end, from) : text.length;
  assert.ok(from >= 0, label + ' 起点未找到: ' + start);
  assert.ok(end ? to > from : true, label + ' 终点未找到: ' + end);
  return text.slice(from, end ? to : undefined);
}

const matcherSrc = slice(SERVER, MATCHER_START, MATCHER_END, '指纹');
const poolSrc = slice(SERVER, POOL_START, POOL_END, '候选池');

const routeFrom = SERVER.indexOf(ROUTE_MARK);
assert.ok(routeFrom >= 0, '候选池路由未找到');
const routeTo = SERVER.indexOf('\n  if (pn === ', routeFrom + ROUTE_MARK.length);
const routeSrc = SERVER.slice(routeFrom, routeTo > routeFrom ? routeTo : routeFrom + 6000);

function makeSandbox() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, Array, Object, String, Number, Boolean, Date, RegExp, Error,
    Map, Set, isFinite, isNaN, parseInt, parseFloat, Infinity,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(matcherSrc, ctx, { filename: 'server.js#neteaseSourceMatch' });
  vm.runInContext(poolSrc, ctx, { filename: 'server.js#smartShufflePool' });
  return sandbox;
}

// 模拟四个源的标准化曲目(库适配器 toLibrarySong 的形状)
function track(provider, id, name, artist, durationSec, extra) {
  return Object.assign({
    provider, source: provider, type: provider,
    id, name, artist,
    artists: [{ id: '', name: artist }],
    durationMs: durationSec * 1000,
    duration: durationSec,
  }, extra || {});
}

// ------------------------------------------------------------
test('同艺人发现: 必须按艺人名过滤, 且不得写 playable:false', () => {
  const start = SERVER.indexOf('function smartShuffleArtistMoreCandidate(');
  assert.ok(start > 0, '必须有同艺人候选归一化函数');
  const body = SERVER.slice(start, SERVER.indexOf('\n}', start) + 2);
  const code = body.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/playable\s*:\s*false/.test(code), '不得写 playable:false（会被插入计划丢弃）');
  assert.ok(/candidateSource\s*:\s*'artist-more'/.test(code), "必须标记 candidateSource='artist-more'");
  assert.ok(/seedArtist\s*:/.test(code), '必须带 seedArtist');
  // 艺人名匹配器: 精确到"之一相等", 不能做包含匹配(否则 The Score 会吃掉 The Scorez)
  assert.ok(/function smartShuffleArtistNameMatches\(/.test(SERVER), '必须有艺人名匹配器');
  const mStart = SERVER.indexOf('function smartShuffleArtistNameMatches(');
  const mBody = SERVER.slice(mStart, SERVER.indexOf('\n}', mStart) + 2).replace(/\/\/[^\n]*/g, '');
  assert.ok(/\.some\(/.test(mBody), '必须逐段比较(多艺人用 / & 、 , 分隔)');
  assert.ok(!/indexOf\(/.test(mBody), '不得用包含匹配 —— 会误吞同名前缀艺人');
  // 路由存在
  assert.ok(SERVER.indexOf("'/api/smart-shuffle/artist-more'") > 0, '必须有 artist-more 路由');
});

test('发现层: 相似候选不得被打成 playable:false（否则会被插入计划整批丢弃）', () => {
  const start = SERVER.indexOf('function smartShuffleSimilarCandidate(');
  assert.ok(start > 0, '必须能找到相似候选归一化函数');
  const body = SERVER.slice(start, SERVER.indexOf('\n}', start) + 2);
  // 先剥掉注释再断言 —— 注释里为了说明问题本身就会提到 playable:false
  const code = body.replace(/\/\/[^\n]*/g, '');
  // 插入计划第一步是 `if (candidate.playable === false && !candidate.crossSource) -> dropped`
  // 所以归一化时写 playable:false 会把发现歌整批扔掉 —— 实测就是这条让发现层静默失效。
  assert.ok(!/playable\s*:\s*false/.test(code), '相似候选不得写 playable:false（会触发插入计划的 not-playable 丢弃）');
  assert.ok(/candidateSource\s*:\s*'similar'/.test(body), '必须标记 candidateSource=similar, 插入计划靠它识别发现位');
  assert.ok(/seedId\s*:/.test(body), '必须带 seedId 以便回溯');
});

test('TEST 1 — 跨源同一首歌必须归并成一个候选, 并保留全部来源', () => {
  const sb = makeSandbox();
  const clusters = sb.smartShuffleMergeCandidates([
    track('netease', '111', '晴天', '周杰伦', 269),
    track('qq', 'QQMID1', '晴天', '周杰伦', 269),
    track('kugou', 'HASH1', '晴天', '周杰伦', 269),
  ]);
  assert.strictEqual(clusters.length, 1, '三源同一首应合成 1 个候选');
  const candidate = sb.smartShuffleBuildCandidate(clusters[0]);
  assert.strictEqual(candidate.crossSource, true);
  assert.strictEqual(candidate.sources.length, 3);
  assert.deepStrictEqual(
    Array.prototype.slice.call(candidate.sources.map((s) => s.provider)).sort(),
    ['kugou', 'netease', 'qq']
  );
  assert.strictEqual(candidate.candidateSource, 'personal-playlists');
});

test('TEST 2 — 版本令牌防线: Live 版绝不能被当成录音室版(灾难场景)', () => {
  const sb = makeSandbox();
  const clusters = sb.smartShuffleMergeCandidates([
    track('netease', '111', '晴天', '周杰伦', 269),
    track('qq', 'QQMID1', '晴天 (Live)', '周杰伦', 269),
  ]);
  assert.strictEqual(clusters.length, 2, '录音室版与 Live 版必须分开');
  for (const cluster of clusters) {
    assert.strictEqual(cluster.length, 1, '任何一簇都不该把两者合并');
  }
});

test('TEST 3 — 伴奏/Remix 同样必须与本体分开', () => {
  const sb = makeSandbox();
  const pairs = [
    ['晴天', '晴天 (伴奏)'],
    ['晴天', '晴天 (Remix)'],
    ['晴天', '晴天 (Acoustic)'],
    ['晴天', '晴天 (重制版)'],
  ];
  for (const pair of pairs) {
    const clusters = sb.smartShuffleMergeCandidates([
      track('netease', 'a', pair[0], '周杰伦', 269),
      track('qq', 'b', pair[1], '周杰伦', 269),
    ]);
    assert.strictEqual(clusters.length, 2, pair.join(' vs ') + ' 必须分成两首');
  }
});

test('TEST 4 — 同曲名但时长差太大 / 艺人不同, 都不能归并', () => {
  const sb = makeSandbox();
  const byDuration = sb.smartShuffleMergeCandidates([
    track('netease', 'a', '后来', '刘若英', 300),
    track('qq', 'b', '后来', '刘若英', 360),
  ]);
  assert.strictEqual(byDuration.length, 2, '时长差 60s 不能归并');

  const byArtist = sb.smartShuffleMergeCandidates([
    track('netease', 'a', '晚安', '张三', 200),
    track('qq', 'b', '晚安', '李四', 200),
  ]);
  assert.strictEqual(byArtist.length, 2, '艺人不同不能归并');
});

test('TEST 5 — 归并候选的 primary 按 provider 优先级选, 指纹稳定可复现', () => {
  const sb = makeSandbox();
  const build = () => {
    const clusters = sb.smartShuffleMergeCandidates([
      track('qq', 'QQMID1', '夜曲', '周杰伦', 227),
      track('netease', '222', '夜曲', '周杰伦', 227),
    ]);
    return sb.smartShuffleBuildCandidate(clusters[0]);
  };
  const first = build();
  const second = build();
  assert.strictEqual(first.provider, 'netease', 'netease 优先级最高');
  assert.strictEqual(first.fingerprint, second.fingerprint, '指纹必须可复现');
  assert.ok(/^fp:/.test(first.fingerprint));
  assert.strictEqual(first.needsSourceSwitch, true, '有多个来源即可换源');
});

test('TEST 6 — 可用性过滤保守: 只剔除确定不可用的', () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.smartShuffleCandidateUsable(track('netease', '1', 'n', 'a', 200)), true);
  assert.strictEqual(sb.smartShuffleCandidateUsable(track('netease', '1', 'n', 'a', 200, { trial: true })), false, 'trial 剔除');
  assert.strictEqual(sb.smartShuffleCandidateUsable({ provider: 'netease', name: 'n' }), false, '无任何 id 剔除');
  assert.strictEqual(sb.smartShuffleCandidateUsable(track('netease', '1', 'n', 'a', 30)), false, '过短剔除');
  assert.strictEqual(sb.smartShuffleCandidateUsable(track('netease', '1', 'n', 'a', 1200)), false, '过长剔除');
  // 时长未知时不该被误杀(适配器可能给不出时长)
  assert.strictEqual(sb.smartShuffleCandidateUsable({ provider: 'qq', id: 'x', name: 'n', durationMs: 0 }), true);
  // fee 只表示付费曲目, 不等于不能播 -> 必须保留
  assert.strictEqual(sb.smartShuffleCandidateUsable(track('qq', 'x', 'n', 'a', 200, { fee: 1 })), true);
});

test('TEST 7 — 归并不吞掉独苗: 四源各不相同的歌全部保留', () => {
  const sb = makeSandbox();
  const list = [
    track('netease', '1', 'A', 'a1', 200),
    track('qq', '2', 'B', 'a2', 210),
    track('kugou', '3', 'C', 'a3', 220),
    track('qishui', '4', 'D', 'a4', 230),
  ];
  const clusters = sb.smartShuffleMergeCandidates(list);
  assert.strictEqual(clusters.length, 4);
  const total = clusters.reduce((sum, c) => sum + c.length, 0);
  assert.strictEqual(total, 4, '不能丢歌');
});

// ------------------------------------------------------------
// 架构红线
// ------------------------------------------------------------
test('TEST 8 — 服务端只回答"有哪些候选", 绝不打分', () => {
  const banned = ['scoreCandidate', 'weightedSample', 'shuffleDefaultWeights', 'applyCooldown', 'affinity', 'earlySkipRate'];
  for (const token of banned) {
    assert.ok(routeSrc.indexOf(token) < 0, '候选池接口不该出现评分概念: ' + token);
  }
  assert.ok(/scoring: 'renderer'/.test(routeSrc), '必须显式声明评分在渲染端');
  assert.ok(/playabilityVerified: false/.test(routeSrc), '不得假装验证过可播性');
});

test('TEST 9 — 候选池确实汇聚四个国内源, 且每源独立容错', () => {
  for (const collector of ['collectNeteaseLibrarySongs', 'collectQQLibrary', 'collectKugouLibrary', 'collectQishuiLibrary']) {
    assert.ok(routeSrc.indexOf(collector) >= 0, '缺少来源: ' + collector);
  }
  assert.ok(/netease,qq,kugou,qishui/.test(routeSrc), '默认应覆盖四个源');
  assert.ok(/smartShuffleCandidateUsable/.test(routeSrc), '必须做可用性过滤');
  assert.ok(/smartShuffleMergeCandidates/.test(routeSrc), '必须做跨源归并');
  // 失败时给空池而不是抛错
  assert.ok(/ok: false[\s\S]{0,200}candidates: \[\]/.test(routeSrc), '失败必须返回空池');
});

test('TEST 10 — 归并复用既有指纹, 不另造一套归一化', () => {
  assert.ok(poolSrc.indexOf('neteaseSourceMatchText') >= 0, '分块必须用既有归一化');
  assert.ok(poolSrc.indexOf('neteaseSourceMatchCandidateScore') >= 0, '判定必须用既有指纹评分');
  // 不允许出现自造的版本令牌规则表
  assert.ok(poolSrc.indexOf('remaster') < 0, '版本令牌规则只能来自 neteaseSourceMatchVersionTokens');
});
