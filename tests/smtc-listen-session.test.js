'use strict';
// ============================================================
// 从 SMTC 反推 Apple Music 播放会话 —— 测试
//
// 覆盖:
//   1. 完整播放 / 短跳过都能成案, 且 <45s 不再被丢
//   2. 暂停时间不计入收听时长
//   3. 内部播放器活跃时外部会话必须让位(不重复计数)
//   4. 方向: 只有 MineRadio 界面上的下一首/上一首才带方向
//   5. 桥抖动不产生噪声事件
//   6. **与四源统计物理隔离**, 但评分层能按跨源签名归因
//
// 运行: node tests/smtc-listen-session.test.js
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const playbackDir = path.join(appRoot, 'public', 'js', 'modules', '05-playback');
const smtcDir = path.join(appRoot, 'public', 'js', 'modules', '12-smtc');

let fakeNow = 1700000000000;
let intervalId = 1;

function makeSandbox() {
  const store = {};
  const RealDate = Date;
  function FakeDate(...args) {
    return args.length ? new RealDate(...args) : new RealDate(fakeNow);
  }
  FakeDate.now = () => fakeNow;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, Array, Object, String, Number, Boolean, RegExp, Error, Promise,
    Date: FakeDate, isFinite, isNaN, parseInt, parseFloat, Infinity,
    // 模块加载时会调 smtcListenStart(): 这里给不真正调度的桩, 避免干扰假时钟
    setInterval: () => intervalId++,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  sandbox.queueItemKey = (song) => String((song && (song.key || song.id)) || '');
  // 外部播放事实源(测试里手动驱动)
  sandbox.smtcStore = {
    active: false, title: '', artist: '', album: '', aumid: '',
    status: '', isPlaying: false, durationMs: 0, positionMs: 0,
  };
  sandbox.internalAudioPlayingNow = () => false;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(playbackDir, '02b-play-events.js'), 'utf8'), ctx, { filename: '02b-play-events.js' });
  vm.runInContext(fs.readFileSync(path.join(playbackDir, '02c-shuffle-score.js'), 'utf8'), ctx, { filename: '02c-shuffle-score.js' });
  vm.runInContext(fs.readFileSync(path.join(smtcDir, '07-smtc-listen-session.js'), 'utf8'), ctx, { filename: '07-smtc-listen-session.js' });
  return sandbox;
}

function advance(ms) { fakeNow += ms; }

// 驱动一次"外部播放": 先 begin, 再按秒推进
function playExternal(sb, opts) {
  const o = Object.assign({ title: 'T', artist: 'A', durationMs: 240000, seconds: 30 }, opts || {});
  sb.smtcStore.active = true;
  sb.smtcStore.isPlaying = true;
  sb.smtcStore.title = o.title;
  sb.smtcStore.artist = o.artist;
  sb.smtcStore.album = 'Alb';
  sb.smtcStore.aumid = 'AppleInc.AppleMusicWin!App';
  sb.smtcStore.durationMs = o.durationMs;
  sb.smtcStore.positionMs = 0;
  sb.smtcListenTick(); // begin
  for (let i = 0; i < o.seconds; i += 1) {
    advance(1000);
    sb.smtcStore.positionMs += 1000;
    sb.smtcListenTick();
  }
}

function playRecords(sb) {
  return Array.prototype.slice.call(sb.playEventsMemory).filter((e) => e.type === 'play');
}

// ------------------------------------------------------------
test('TEST 1 — 完整播放: completed=true, endReason=ended', () => {
  const sb = makeSandbox();
  playExternal(sb, { seconds: 240, durationMs: 240000 });
  sb.smtcStore.active = false;
  sb.smtcListenTick();

  const records = playRecords(sb);
  assert.strictEqual(records.length, 1);
  const r = records[0];
  assert.strictEqual(r.provider, 'smtc-external');
  assert.strictEqual(r.completed, true);
  assert.strictEqual(r.endReason, 'ended');
  assert.ok(r.maxProgress >= 0.95, 'maxProgress=' + r.maxProgress);
  assert.ok(Math.abs(r.listenMs - 240000) <= 2000, 'listenMs=' + r.listenMs);
});

test('TEST 2 — <45s 短跳过必须留痕 (这正是内部路径旧实现会丢的那一类)', () => {
  const sb = makeSandbox();
  playExternal(sb, { title: 'Short', seconds: 20 });
  // AM 自己切歌 -> 身份变化
  sb.smtcStore.title = 'Next One';
  sb.smtcStore.positionMs = 0;
  sb.smtcListenTick();

  const records = playRecords(sb);
  assert.strictEqual(records.length, 1, '20 秒的跳过必须被记录');
  assert.ok(Math.abs(records[0].listenMs - 20000) <= 1500, 'listenMs=' + records[0].listenMs);
  assert.strictEqual(records[0].earlySkip, true);
  assert.strictEqual(records[0].completed, false);
  assert.strictEqual(records[0].endReason, 'track-change');
});

test('TEST 3 — 暂停时间不计入收听时长', () => {
  const sb = makeSandbox();
  sb.smtcStore.active = true;
  sb.smtcStore.isPlaying = true;
  sb.smtcStore.title = 'Paused'; sb.smtcStore.artist = 'A'; sb.smtcStore.album = 'Al';
  sb.smtcStore.aumid = 'AM'; sb.smtcStore.durationMs = 240000; sb.smtcStore.positionMs = 0;
  sb.smtcListenTick();
  for (let i = 0; i < 30; i += 1) { advance(1000); sb.smtcStore.positionMs += 1000; sb.smtcListenTick(); }
  // 暂停 60 秒: 位置不动
  sb.smtcStore.isPlaying = false;
  for (let i = 0; i < 60; i += 1) { advance(1000); sb.smtcListenTick(); }
  // 恢复 30 秒
  sb.smtcStore.isPlaying = true;
  for (let i = 0; i < 30; i += 1) { advance(1000); sb.smtcStore.positionMs += 1000; sb.smtcListenTick(); }
  sb.smtcStore.active = false;
  sb.smtcListenTick();

  const r = playRecords(sb)[0];
  assert.ok(r, '必须有记录');
  assert.ok(r.listenMs <= 64000, '暂停的 60 秒不能计入, listenMs=' + r.listenMs);
  assert.ok(r.listenMs >= 56000, '实际播放的 60 秒要在, listenMs=' + r.listenMs);
});

test('TEST 4 — 内部播放器在放时外部会话让位, 不重复计数', () => {
  const sb = makeSandbox();
  playExternal(sb, { title: 'Internal takeover', seconds: 25 });
  sb.internalAudioPlayingNow = () => true;
  advance(1000);
  sb.smtcListenTick();

  const records = playRecords(sb);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].endReason, 'internal-takeover');
  // 让位后不应再开新会话
  advance(1000);
  sb.smtcListenTick();
  assert.strictEqual(playRecords(sb).length, 1, '内部播放期间不能再产生外部记录');
});

test('TEST 5 — 方向: MineRadio 界面按下一首才带 userInitiated + endReason', () => {
  const sb = makeSandbox();
  playExternal(sb, { title: 'Direction', seconds: 12 });
  sb.smtcListenNoteCommand('next');
  sb.smtcStore.title = 'After Next';
  sb.smtcStore.positionMs = 0;
  sb.smtcListenTick();

  const r = playRecords(sb)[0];
  assert.strictEqual(r.userInitiated, true);
  assert.strictEqual(r.endReason, 'next');
});

test('TEST 6 — 桥抖动不产生噪声事件, 但真实短跳过仍保留', () => {
  const sb = makeSandbox();
  // 0.3 秒的闪烁样本
  sb.smtcStore.active = true; sb.smtcStore.isPlaying = true;
  sb.smtcStore.title = 'Flicker'; sb.smtcStore.artist = 'A'; sb.smtcStore.album = 'Al';
  sb.smtcStore.aumid = 'AM'; sb.smtcStore.durationMs = 240000; sb.smtcStore.positionMs = 0;
  sb.smtcListenTick();
  advance(300); sb.smtcStore.positionMs += 300; sb.smtcListenTick();
  sb.smtcStore.title = 'Other';
  sb.smtcListenTick();
  assert.strictEqual(playRecords(sb).length, 0, '0.3 秒抖动不该成案');

  // 1.2 秒的真实跳过: 必须保留
  playExternal(sb, { title: 'Real skip', seconds: 1 });
  sb.smtcStore.title = 'After';
  sb.smtcStore.positionMs = 0;
  sb.smtcListenTick();
  assert.strictEqual(playRecords(sb).length, 1, '1.2 秒的真实跳过必须成案');
});

test('TEST 7 — 与四源统计物理隔离: 外部收听不污染 playEventsSongStats', () => {
  const sb = makeSandbox();
  playExternal(sb, { title: 'Isolated', artist: 'Artist X', seconds: 40 });
  sb.smtcStore.active = false;
  sb.smtcListenTick();

  const r = playRecords(sb)[0];
  assert.ok(/^smtc:/.test(r.key), 'key 必须是合成 key, key=' + r.key);
  assert.ok(r.sig, '必须带跨源签名');

  assert.strictEqual(Object.keys(sb.playEventsSongStatsMap()).length, 0, '四源统计必须为空');
  const sigStats = sb.playEventsSignatureStatsMap();
  assert.strictEqual(Object.keys(sigStats).length, 1, '必须进签名统计桶');
  assert.strictEqual(sigStats[r.sig].plays, 1);
});

test('TEST 8 — 评分层能按签名把 Apple Music 收听归因到候选池里的同一首歌', () => {
  const sb = makeSandbox();
  playExternal(sb, { title: '归因测试', artist: '歌手 Y', durationMs: 200000, seconds: 60 });
  sb.smtcStore.active = false;
  sb.smtcListenTick();

  const maps = sb.shuffleStatsMaps();
  const candidate = {
    key: 'netease:123', name: '归因测试', artist: '歌手 Y', album: 'Alb',
    durationMs: 200000, provider: 'netease',
  };
  const scored = sb.scoreCandidate(candidate, {
    now: Date.now(), weights: sb.shuffleDefaultWeights(),
    songStats: maps.songStats, signatureStats: maps.signatureStats,
    artistStats: maps.artistStats,
  });
  assert.strictEqual(scored.breakdown.statsSource, 'smtc-external', '必须按签名命中外部统计');
  assert.strictEqual(scored.breakdown.plays, 1);
  assert.ok(scored.score > 0, '命中后分数不应为 0');
});

// ------------------------------------------------------------
// 无队列模式 (pool-only) + 源限制闸门
// ------------------------------------------------------------
test('TEST 14 — SMTC 的 artist 是"艺人 — 专辑"时必须拆开, 否则归因永远失败', () => {
  const sb = makeSandbox();
  sb.smtcStore.active = true;
  sb.smtcStore.isPlaying = true;
  sb.smtcStore.title = 'How Long';
  sb.smtcStore.artist = 'Charlie Puth \u2014 Voicenotes';   // ← 真实 Apple Music 形态
  sb.smtcStore.album = 'Voicenotes';
  sb.smtcStore.durationMs = 200000;
  sb.smtcStore.positionMs = 0;
  sb.smtcStore.aumid = 'AppleInc.AppleMusicWin!App';
  sb.smtcListenTick();
  for (let i = 0; i < 40; i += 1) { advance(1000); sb.smtcStore.positionMs += 1000; sb.smtcListenTick(); }
  sb.smtcStore.active = false;
  sb.smtcListenTick();

  const rec = playRecords(sb)[0];
  assert.ok(rec, '必须成案');
  assert.strictEqual(rec.artist, 'Charlie Puth', '事件里的艺人必须已拆净, 实际=' + rec.artist);
  assert.ok(rec.key.indexOf('Voicenotes') < 0, 'key 不该带专辑名: ' + rec.key);

  // 池里同一首歌必须能被归因 —— 修好之前这里恒为 'none'
  const maps = sb.shuffleStatsMaps();
  const candidate = { key: 'netease:9', name: 'How Long', artist: 'Charlie Puth', durationMs: 200000, provider: 'netease' };
  const scored = sb.scoreCandidate(candidate, {
    now: Date.now(), weights: sb.shuffleDefaultWeights(),
    songStats: maps.songStats, signatureStats: maps.signatureStats,
  });
  assert.strictEqual(scored.breakdown.statsSource, 'smtc-external', '必须命中 (修复前是 none)');
});

test('TEST 15 — 各专辑分隔符都要能拆, 且不乱拆', () => {
  const sb = makeSandbox();
  // 关键: 第二项故意让 album 字段与嵌入文本**不一致** —— 这是旧实现(比对后缀)会漏掉的情况
  const cases = [
    ['Abel Tesfaye \u2014 Dawn FM', 'Dawn FM', 'Abel Tesfaye'],   // 项目注释里的实测值
    ['Charlie Puth \u2014 Voicenotes', 'Voicenotes - Single', 'Charlie Puth'],
    ['A \u2013 Alb', 'Alb', 'A'],
    ['A - Alb', 'Alb', 'A'],
    ['Charlie Puth', 'Voicenotes', 'Charlie Puth'],
    ['Marshmello', '', 'Marshmello'],
  ];
  for (const item of cases) {
    const got = sb.smtcListenCleanArtist({ artist: item[0], album: item[1] });
    assert.strictEqual(got, item[2], 'artist="' + item[0] + '" album="' + item[1] + '" -> ' + got);
  }
});

test('TEST 16 — pool-only 必须排除"当前正在听的那首", 且 top 都带真实概率', async () => {
  const sb = makeSandbox();
  sb.writeShuffleConfig({ mode: 'shadow' });
  sb.smtcStore.active = true;
  sb.smtcStore.isPlaying = true;
  sb.smtcStore.title = 'How Long';
  sb.smtcStore.artist = 'Charlie Puth \u2014 Voicenotes';
  sb.smtcStore.album = 'Voicenotes';
  sb.smtcStore.durationMs = 200000;
  sb.smtcStore.positionMs = 60000;
  sb.smtcStore.aumid = 'AppleInc.AppleMusicWin!App';

  const pool = [
    // 正是当前在听的这首 —— 绝不能被推荐
    { key: 'netease:now', name: 'How Long', artist: 'Charlie Puth', durationMs: 200000, provider: 'netease', stats: {} },
    { key: 'netease:other1', name: 'Other One', artist: 'Someone', durationMs: 210000, provider: 'netease', stats: {} },
    { key: 'qq:other2', name: 'Other Two', artist: 'Someone Else', durationMs: 220000, provider: 'qq', stats: {} },
  ];
  sb.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, candidates: pool }) });

  sb.smartShuffleShadowProbe('smtc-track-start');
  await new Promise((r) => setTimeout(r, 40));

  const shadow = Array.prototype.slice.call(sb.playEventsMemory).filter((e) => e.type === 'shuffle-shadow')[0];
  assert.ok(shadow, '必须有影子决策');
  assert.strictEqual(shadow.droppedNowPlaying, 1, '必须丢掉"正在听的那首", dropped=' + shadow.droppedNowPlaying);
  const keys = shadow.decisions.map((d) => d.key);
  assert.strictEqual(keys.indexOf('netease:now'), -1, '正在听的歌不能出现在推荐里');
  // 每条 top 都要有真实概率, 且恰好一条被抽中
  assert.ok(shadow.decisions.every((d) => d.probability > 0), 'top 候选都要有非零概率');
  const pickedCount = shadow.decisions.filter((d) => d.picked).length;
  assert.strictEqual(pickedCount, 1, '恰好一条被抽中, 实际=' + pickedCount);
  const sum = shadow.decisions.reduce((s, d) => s + d.probability, 0);
  assert.ok(sum <= 1.0001, '概率和不能超过 1, sum=' + sum);
});

test('TEST 17 — 大池必须先取短名单再抽样, 否则 picked 等于随机', () => {
  const sb = makeSandbox();
  const pool = [];
  for (let i = 0; i < 200; i += 1) {
    pool.push({
      key: 'p' + i,
      name: 'Song ' + i,
      artist: 'Artist ' + i,
      durationMs: 180000 + i * 100,
      provider: 'netease',
      stats: { plays: i % 5, lastPlayedAt: 0 },
    });
  }
  const pick = sb.planSmartShufflePoolPick(pool, {
    now: Date.now(), weights: sb.shuffleDefaultWeights(), rng: () => 0.5,
  });
  assert.strictEqual(pick.applied, true, 'reason=' + pick.reason);
  assert.ok(pick.eligible > 100, 'eligible=' + pick.eligible);
  assert.strictEqual(pick.shortlistSize, 30, 'shortlistSize=' + pick.shortlistSize);
  // 真正的判据: 首选概率必须**显著高于**在整个合格池里均匀随机的水平。
  // (不能断言 top5 概率和 > 某值 —— 无数据时分数几乎相同, 短名单内本来就接近均匀,
  //  那正是"只有先验"的正常形态; 有真实数据后分数方差变大, 集中度会自然上升。)
  const uniform = 1 / pick.eligible;
  assert.ok(
    pick.top[0].probability > uniform * 3,
    '首选概率应远超均匀分布: top1=' + pick.top[0].probability.toFixed(4) + ' uniform=' + uniform.toFixed(4)
  );
  // 抽中的那首**必须出现在报告里**(哪怕它排在第 15 位) —— 否则日志看不到实际选了什么
  const pickedRows = pick.top.filter((e) => e.picked);
  assert.strictEqual(pickedRows.length, 1, '恰好一条被抽中, 实际=' + pickedRows.length);
  assert.strictEqual(pickedRows[0].key, pick.pick.key, '标记的那条必须就是抽中的那条');
  assert.ok(pick.top.length >= 5 && pick.top.length <= 6, 'top 长度=' + pick.top.length);
});

test('TEST 18 — 艺人改名场景: 严格签名失败时必须靠宽松签名归因', () => {
  const sb = makeSandbox();
  // 真实案例: The Weeknd 已正式改用本名 Abel Tesfaye, Apple 用新名, 国内四源还是旧名
  sb.smtcStore.active = true;
  sb.smtcStore.isPlaying = true;
  sb.smtcStore.title = 'StarBoy (feat. Daft Punk)';   // Apple 把 feat 写进标题
  sb.smtcStore.artist = 'Abel Tesfaye';               // 本名
  sb.smtcStore.album = 'Starboy';
  sb.smtcStore.durationMs = 230000;
  sb.smtcStore.positionMs = 0;
  sb.smtcStore.aumid = 'AppleInc.AppleMusicWin!App';
  sb.smtcListenTick();
  for (let i = 0; i < 45; i += 1) { advance(1000); sb.smtcStore.positionMs += 1000; sb.smtcListenTick(); }
  sb.smtcStore.active = false;
  sb.smtcListenTick();

  const rec = playRecords(sb)[0];
  assert.ok(rec, '必须成案');
  assert.ok(rec.sig, '必须带严格签名');
  assert.ok(rec.sigLoose, '必须带宽松签名');
  assert.notStrictEqual(rec.sig, rec.sigLoose, '两个签名必须不同');

  const maps = sb.shuffleStatsMaps();
  // 池里同一首歌: 艺名 + (Clean) 标注
  const candidate = {
    key: 'kugou:star', name: 'Starboy (Clean)',
    artist: 'The Weeknd / Daft Punk', durationMs: 230000, provider: 'kugou',
  };
  const scored = sb.scoreCandidate(candidate, {
    now: Date.now(), weights: sb.shuffleDefaultWeights(),
    songStats: maps.songStats, signatureStats: maps.signatureStats, looseStats: maps.looseStats,
  });
  assert.strictEqual(scored.breakdown.statsSource, 'smtc-external-loose',
    '必须走宽松归因 (严格签名在这种情况下必然失败)');
  assert.strictEqual(scored.breakdown.plays, 1);
});

test('TEST 20 — 时长跨桶边界(232s vs 234s)仍必须能归因', () => {
  const sb = makeSandbox();
  // Apple 232s -> 桶 46; 池 234s -> 桶 47 —— 一桶之隔, 靠相邻桶登记救回来
  sb.smtcStore.active = true;
  sb.smtcStore.isPlaying = true;
  sb.smtcStore.title = 'Boundary Song';
  sb.smtcStore.artist = 'Some Artist';
  sb.smtcStore.album = 'Alb';
  sb.smtcStore.durationMs = 232000;
  sb.smtcStore.positionMs = 0;
  sb.smtcStore.aumid = 'AM';
  sb.smtcListenTick();
  for (let i = 0; i < 40; i += 1) { advance(1000); sb.smtcStore.positionMs += 1000; sb.smtcListenTick(); }
  sb.smtcStore.active = false;
  sb.smtcListenTick();

  const rec = playRecords(sb)[0];
  assert.ok(rec.sigLooseVariants && rec.sigLooseVariants.length === 3, '必须登记相邻桶');
  const maps = sb.shuffleStatsMaps();
  const candidate = { key: 'qq:b', name: 'Boundary Song', artist: 'Some Artist', durationMs: 234000, provider: 'qq' };
  const scored = sb.scoreCandidate(candidate, {
    now: Date.now(), weights: sb.shuffleDefaultWeights(),
    songStats: maps.songStats, signatureStats: maps.signatureStats, looseStats: maps.looseStats,
  });
  assert.strictEqual(scored.breakdown.statsSource, 'smtc-external-loose', '跨桶边界仍要归因成功');
});

test('TEST 19 — 宽松桶与严格桶/四源桶三者物理隔离', () => {
  const sb = makeSandbox();
  playExternal(sb, { title: 'Bucket Test', artist: 'Somebody', durationMs: 200000, seconds: 40 });
  sb.smtcStore.active = false;
  sb.smtcListenTick();

  const rec = playRecords(sb)[0];
  assert.strictEqual(Object.keys(sb.playEventsSongStatsMap()).length, 0, '四源桶必须为空');
  assert.strictEqual(Object.keys(sb.playEventsSignatureStatsMap()).length, 1, '严格桶 1 条');
  // 宽松桶登记 ±1 相邻桶(消除时长桶边界问题), 所以是 3 条
  assert.strictEqual(Object.keys(sb.playEventsLooseStatsMap()).length, 3, '宽松桶 3 条(相邻桶)');
  assert.notStrictEqual(rec.sig, rec.sigLoose, '两个 key 不能相同');
  assert.ok(rec.sigLooseVariants.indexOf(rec.sigLoose) >= 0, '基准桶必须在变体里');
});

test('TEST 10 — 源限制闸门: 只允许国内四源接管', () => {
  const sb = makeSandbox();
  const q = (provider) => [{ provider, key: provider + ':1', name: 'n', artist: 'a' }];
  for (const ok of ['netease', 'qq', 'kugou', 'qishui']) {
    const g = sb.smartShuffleApplyGuard(q(ok));
    assert.strictEqual(g.allowed, true, ok + ' 应允许, reason=' + g.reason);
  }
  for (const no of ['apple', 'spotify', 'local', 'smtc-external']) {
    const g = sb.smartShuffleApplyGuard(q(no));
    assert.strictEqual(g.allowed, false, no + ' 不该允许');
    assert.strictEqual(g.reason, 'foreign-source');
  }
  assert.strictEqual(sb.smartShuffleApplyGuard([]).allowed, false, '空队列不接管');
  assert.strictEqual(sb.smartShuffleApplyGuard([{ key: 'x', name: 'n' }]).allowed, false, '无来源信息不接管');
  // 混合: 只要有一首是外来源就不接管
  const mixed = [{ provider: 'netease' }, { provider: 'apple' }];
  assert.strictEqual(sb.smartShuffleApplyGuard(mixed).allowed, false, '混合队列不接管');
});

test('TEST 11 — pool-only: 无队列 + Apple Music 正在播放, 也要产出决策数据', async () => {
  const sb = makeSandbox();
  sb.writeShuffleConfig({ mode: 'shadow' });
  // 没有 playQueue / currentIdx —— 正是"只用 Apple Music 听歌"的情形
  sb.smtcStore.active = true;
  sb.smtcStore.isPlaying = true;
  sb.smtcStore.title = 'El Mismo Sol';
  sb.smtcStore.artist = 'Alvaro Soler';
  sb.smtcStore.album = 'Eterno Agosto';
  sb.smtcStore.durationMs = 188000;
  sb.smtcStore.positionMs = 125000;
  sb.smtcStore.aumid = 'AppleInc.AppleMusicWin!App';
  const pool = [
    { key: 'netease:1', name: '候选一', artist: '歌手甲', durationMs: 200000, provider: 'netease', stats: { plays: 5, lastPlayedAt: 0 } },
    { key: 'qq:2', name: '候选二', artist: '歌手乙', durationMs: 210000, provider: 'qq', stats: { plays: 2, lastPlayedAt: 0 } },
  ];
  sb.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, candidates: pool }) });

  assert.strictEqual(sb.smartShuffleShadowProbe('smtc-track-start'), true);
  await new Promise((r) => setTimeout(r, 40));

  const shadow = Array.prototype.slice.call(sb.playEventsMemory).filter((e) => e.type === 'shuffle-shadow');
  assert.strictEqual(shadow.length, 1, '必须留下一条影子决策');
  assert.strictEqual(shadow[0].planMode, 'pool-only', '必须走无队列模式');
  assert.ok(shadow[0].decisions.length > 0, '必须有候选决策');
  assert.ok(shadow[0].nowPlayingKey, '必须记录"以哪首为上下文"');
  assert.strictEqual(shadow[0].applyAllowed, false, '空队列不允许接管');
  const first = shadow[0].decisions[0];
  assert.ok(first.final !== undefined, '决策必须带分数');
  assert.ok(first.terms, '决策必须带 scoreBreakdown');
});

test('TEST 12 — 无队列模式下候选全部被冷却时老实报 all-cooled', async () => {
  const sb = makeSandbox();
  sb.writeShuffleConfig({ mode: 'shadow' });
  sb.smtcStore.active = true;
  sb.smtcStore.isPlaying = true;
  sb.smtcStore.title = 'Now'; sb.smtcStore.artist = 'A';
  sb.smtcStore.durationMs = 200000; sb.smtcStore.positionMs = 60000;
  sb.smtcStore.aumid = 'AM';
  const cooled = [
    { key: 'netease:1', name: '刚听过', artist: '歌手甲', durationMs: 200000, provider: 'netease', stats: { plays: 5, lastPlayedAt: Date.now() - 60000 } },
  ];
  sb.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, candidates: cooled }) });

  sb.smartShuffleShadowProbe('smtc-track-start');
  await new Promise((r) => setTimeout(r, 40));
  const shadow = Array.prototype.slice.call(sb.playEventsMemory).filter((e) => e.type === 'shuffle-shadow');
  assert.strictEqual(shadow.length, 1);
  assert.strictEqual(shadow[0].wouldInsert, false);
  assert.strictEqual(shadow[0].insertionReason, 'all-cooled');
});

test('TEST 13 — 队列存在时仍走原 queue 模式(不退化)', async () => {
  const sb = makeSandbox();
  sb.writeShuffleConfig({ mode: 'shadow' });
  sb.playQueue = [
    { key: 'netease:q1', name: '队列一', artist: '甲', durationMs: 200000, provider: 'netease', stats: {} },
    { key: 'netease:q2', name: '队列二', artist: '乙', durationMs: 200000, provider: 'netease', stats: {} },
    { key: 'netease:q3', name: '队列三', artist: '丙', durationMs: 200000, provider: 'netease', stats: {} },
  ];
  sb.currentIdx = 0;
  const pool = [{ key: 'netease:p1', name: '池候选', artist: '丁', durationMs: 200000, provider: 'netease', stats: {} }];
  sb.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, candidates: pool }) });

  sb.smartShuffleShadowProbe('track-start');
  await new Promise((r) => setTimeout(r, 40));
  const shadow = Array.prototype.slice.call(sb.playEventsMemory).filter((e) => e.type === 'shuffle-shadow');
  assert.strictEqual(shadow.length, 1);
  assert.strictEqual(shadow[0].planMode, 'queue', '有队列时必须走 queue 模式');
  assert.strictEqual(shadow[0].applyAllowed, true, '四源队列应允许接管');
});

test('TEST 9 — Live 版不会被签名误配到录音室版', () => {
  const sb = makeSandbox();
  playExternal(sb, { title: '同名歌', artist: '歌手 Z', durationMs: 200000, seconds: 40 });
  sb.smtcStore.active = false;
  sb.smtcListenTick();

  const maps = sb.shuffleStatsMaps();
  const studio = { key: 'netease:1', name: '同名歌', artist: '歌手 Z', durationMs: 200000 };
  const live = { key: 'netease:2', name: '同名歌 (Live)', artist: '歌手 Z', durationMs: 200000 };

  const a = sb.scoreCandidate(studio, { now: Date.now(), weights: sb.shuffleDefaultWeights(), songStats: maps.songStats, signatureStats: maps.signatureStats });
  const b = sb.scoreCandidate(live, { now: Date.now(), weights: sb.shuffleDefaultWeights(), songStats: maps.songStats, signatureStats: maps.signatureStats });
  assert.strictEqual(a.breakdown.statsSource, 'smtc-external', '录音室版应命中');
  assert.strictEqual(b.breakdown.statsSource, 'none', 'Live 版不该命中(签名不剥括号)');
});
