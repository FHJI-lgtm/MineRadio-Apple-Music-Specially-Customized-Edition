'use strict';
// ============================================================
// Timeline Stabilizer Plus (12-smtc/08) —— 行为测试
//
// 覆盖需求文档第十三节的全部场景：
//   基础: 正常播放 / 暂停 / 恢复 / 下一首 / 上一首 / 自然结束 / 手动 seek
//   异常: 正常+300+正常 / +800x3 / 正常+回退500+正常
//   验收: 连续性 / 异常隔离 / seek 正确性 / 切歌正确性 / Pause-Resume / 歌词同步
//
// 时钟模型（与真机一致，见 T15 的真机抓包回放）：
//   QPC  = performance.now()（虚拟时钟，测试完全控制；绝不使用墙钟）
//   SMTC = 每 5s 一个样本（desktop/smtc-bridge.ps1 实测：Apple Music 播放期间
//          只有 5s fallback poll 在推 state）
//   quantize:true  = 真机 Apple Music 形态：Position 只按整秒上报
//   quantize:false = 毫秒级播放器形态（Position 连续，带 137ms 相位）
//
// 运行: node --test tests/smtc-timeline-stabilizer-plus.test.js
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const smtcDir = path.join(appRoot, 'public', 'js', 'modules', '12-smtc');
const TSP_SRC = fs.readFileSync(path.join(smtcDir, '08-timeline-stabilizer-plus.js'), 'utf8');
const STORE_SRC = fs.readFileSync(path.join(smtcDir, '00-smtc-store.js'), 'utf8');

const TRACK_A = { title: 'Song A', artist: 'Artist A', album: 'Album A', aumid: 'AppleInc.AppleMusicWin!App' };
const TRACK_B = { title: 'Song B', artist: 'Artist B', album: 'Album B', aumid: 'AppleInc.AppleMusicWin!App' };

function makeSandbox() {
  let clock = 0;                 // QPC (performance.now) —— 唯一主时钟
  let wall = 1791275600000;      // 墙钟 (Date.now) —— 仅 PCM 新鲜度
  const intervals = [];
  const logs = [];
  const store = {};
  const RealDate = Date;
  function FakeDate(...args) { return args.length ? new RealDate(...args) : new RealDate(wall); }
  FakeDate.now = () => wall;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;

  const sandbox = {
    console: {
      log: (...a) => { logs.push(a.join(' ')); },
      warn: (...a) => { logs.push('WARN ' + a.join(' ')); },
      error: (...a) => { logs.push('ERR ' + a.join(' ')); },
    },
    Date: FakeDate,
    performance: { now: () => clock },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
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
  // 04-smtc-audio 的采集状态桩（PCM 置信度校验用）
  sandbox.smtcAudioState = { active: false, rms: 0, updatedAt: 0, mode: 'none', error: '' };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(TSP_SRC, ctx, { filename: '08-timeline-stabilizer-plus.js' });
  vm.runInContext(STORE_SRC, ctx, { filename: '00-smtc-store.js' });

  sandbox.__advance = (ms) => { clock += ms; wall += ms; };
  sandbox.__tick = () => { for (const fn of intervals) fn(); };
  sandbox.__wallNow = () => wall;
  sandbox.__logs = logs;
  return sandbox;
}

// 播放世界：真值播放头 + 显式 SMTC 采样 + 连续读取记录（无隐式采样，测试完全可控）
function world(opts) {
  opts = opts || {};
  const sb = makeSandbox();
  // 真实渲染进程里 performance.now() 早已 > 0；从非零起点开始可以避免
  // v4 legacy 的 anchorAt>0 哨兵在时钟原点正好为 0 时误判（那是宿主特性，不是被测行为）。
  const clockOrigin = opts.clockOrigin != null ? opts.clockOrigin : 12345;
  sb.__advance(clockOrigin);
  const W = {
    sb,
    durationMs: opts.durationMs != null ? opts.durationMs : 240000,
    track: opts.track || TRACK_A,
    quantize: opts.quantize !== false,
    playing: opts.playing !== false,
    truthMs: opts.positionMs || 0,
    smtcOffsetMs: opts.offsetMs || 0,     // 让 SMTC 整体偏移（模拟持续异常）
    sampleInterval: opts.sampleInterval != null ? opts.sampleInterval : 5000,
    clock: clockOrigin,
    nextTickAt: clockOrigin,
    pendingRaw: null,
    rawLog: [],
    readings: [],
  };
  W.advance = (ms) => {
    sb.__advance(ms);
    W.clock += ms;
    if (W.playing) W.truthMs += ms;
  };
  // 毫秒级播放器带 137ms 非整秒相位，避免被误判为整秒量化
  W.rawOf = (truth) => {
    const v = truth + W.smtcOffsetMs + (W.quantize ? 0 : 137);
    return W.quantize ? Math.floor(v / 1000) * 1000 : Math.round(v);
  };
  W.rawNow = () => W.rawOf(W.truthMs);
  W.sample = (over) => {
    let raw = W.rawNow();
    if (W.pendingRaw != null) { raw = W.pendingRaw; W.pendingRaw = null; }
    if (over && over.positionMs != null) raw = over.positionMs;
    const state = Object.assign({
      active: true, bridgeReady: true,
      status: W.playing ? 'Playing' : 'Paused',
      isPlaying: W.playing,
      durationMs: W.durationMs,
      positionMs: raw,
      lastUpdatedMs: 0,
    }, W.track, over || {});
    W.sb.smtcApplyBridgeState(state);
    W.rawLog.push({ t: W.clock, raw });
    return W.sb.smtcTspSnapshot();
  };
  W.read = () => {
    const stable = W.sb.smtcStablePositionMsNow();
    W.readings.push({ t: W.clock, stable, truth: W.playing ? W.truthMs : null });
    return stable;
  };
  W.stepTo = (t) => {
    while (W.clock < t) {
      const step = Math.min(50, t - W.clock);
      W.advance(step);
      if (W.clock >= W.nextTickAt) {
        if (W.sb.smtcAudioState.active) W.sb.smtcAudioState.updatedAt = W.sb.__wallNow();
        W.sb.__tick();
        W.nextTickAt += 250;
      }
      W.read();
    }
  };
  W.stepSamples = (n) => {
    for (let i = 0; i < n; i += 1) { W.stepTo(W.clock + W.sampleInterval); W.sample(); }
  };
  // 完整采样周期 + 该拍注入异常偏移（异常发生在采样瞬间）
  W.glitchSample = (glitchMs) => {
    W.stepTo(W.clock + W.sampleInterval);
    W.pendingRaw = W.rawNow() + glitchMs;
    W.sample();
  };
  W.seekTo = (ms) => { W.truthMs = ms; };
  W.resets = () => W.sb.smtcTspSnapshot().anchorResets;
  return W;
}

function maxReadDelta(readings, fromIdx) {
  let max = 0;
  for (let i = Math.max(1, fromIdx || 1); i < readings.length; i += 1) {
    const d = readings[i].stable - readings[i - 1].stable;
    if (Math.abs(d) > Math.abs(max)) max = d;
  }
  return max;
}
function backwardCount(readings, fromIdx) {
  let n = 0;
  for (let i = Math.max(1, fromIdx || 1); i < readings.length; i += 1) {
    if (readings[i].stable < readings[i - 1].stable - 0.001) n += 1;
  }
  return n;
}
function maxAbsOffset(readings) {
  let m = 0;
  for (const r of readings) {
    if (r.truth == null) continue;
    m = Math.max(m, Math.abs(r.stable - r.truth));
  }
  return m;
}

// ------------------------------------------------------------
// 基础 1: 正常播放 10 分钟（整秒量化 + 5s 采样）
// ------------------------------------------------------------
test('T1 正常播放连续性与异常隔离(整秒量化,10分钟)', () => {
  const W = world({ positionMs: 38000, durationMs: 300000, quantize: true });
  W.sample();
  W.read();
  for (let i = 0; i < 120; i += 1) W.stepSamples(1);   // 120 * 5s = 10 分钟

  assert.ok(W.readings.length > 10000, 'reads captured: ' + W.readings.length);
  assert.strictEqual(backwardCount(W.readings), 0, 'Stable Position 绝不应倒退');
  const maxDelta = maxReadDelta(W.readings);
  assert.ok(maxDelta < 80, '单次 50ms 步进内不应出现可见跳变, got ' + maxDelta.toFixed(1) + 'ms');
  const maxOff = maxAbsOffset(W.readings);
  assert.ok(maxOff <= 1000, '整秒量化下与真值偏差应 <= 1 个量化步长, got ' + maxOff.toFixed(0) + 'ms');
  assert.strictEqual(W.resets(), 1, '只应有首个 anchor（无任何锚点重置/误判 seek）');
  const snap = W.sb.smtcTspSnapshot();
  assert.strictEqual(snap.quantumMs, 1000, '应识别出整秒量化');
  assert.strictEqual(snap.phase, 'playing');
  assert.ok(snap.stableMs > 636000 && snap.stableMs < 640000, '10 分钟后位置正确: ' + snap.stableMs);
});

// ------------------------------------------------------------
// 基础 1b: 采样间隔抖动（真机事件驱动会插播样本）
// ------------------------------------------------------------
test('T1b 采样间隔抖动 + 整秒量化: 不得误判 seek', () => {
  const W = world({ positionMs: 10000, durationMs: 300000, quantize: true });
  W.sample();
  W.read();
  const jitter = [4469, 5254, 4988, 5103, 4469, 5253, 4900, 5120];
  for (let i = 0; i < jitter.length * 6; i += 1) {
    W.stepTo(W.clock + jitter[i % jitter.length]);
    W.sample();
  }
  assert.strictEqual(W.resets(), 1, '抖动不得造成 anchor 重置');
  assert.strictEqual(backwardCount(W.readings), 0, 'Stable Position 不得倒退');
  assert.ok(maxReadDelta(W.readings) < 80, '不得出现可见跳变: ' + maxReadDelta(W.readings).toFixed(1));
  assert.ok(maxAbsOffset(W.readings) <= 1500, '抖动下偏差仍有界: ' + maxAbsOffset(W.readings).toFixed(0));
});

// ------------------------------------------------------------
// 基础 2/3: 暂停 / 恢复
// ------------------------------------------------------------
test('T2 暂停: Stable Position 停止增长', () => {
  const W = world({ positionMs: 60000, quantize: false });
  W.sample();
  W.stepSamples(2);
  const before = W.read();
  W.playing = false;
  W.sample();                       // Paused 样本
  W.stepTo(W.clock + 6000);         // 暂停期间推进 6s
  const after = W.read();
  assert.strictEqual(Math.round(after), Math.round(before), '暂停期间位置必须冻结');
  assert.strictEqual(backwardCount(W.readings, W.readings.length - 130), 0);
});

test('T3 恢复: 重新读取 SMTC position 并从正确位置继续', () => {
  const W = world({ positionMs: 60000, quantize: false });
  W.sample();
  W.playing = false;
  W.stepTo(W.clock + 1000);
  W.sample();
  W.stepTo(W.clock + 2000);
  const frozen = W.read();
  // 暂停期间用户在 Apple Music 里拖到 120s, 然后恢复播放
  W.playing = true;
  W.seekTo(120000);
  W.sample();
  const resumed = W.read();
  assert.ok(Math.abs(resumed - 120000) < 400, '恢复后应锚定到 SMTC 的新位置: ' + resumed);
  assert.ok(resumed > frozen, '恢复后位置必须前进');
  W.stepSamples(1);
  const later = W.read();
  assert.ok(later - resumed > 4800 && later - resumed < 5600, '恢复后按 1x 推进: ' + (later - resumed));
});

// ------------------------------------------------------------
// 基础 4: 下一首（含 Apple 仍上报上一首 position 的陈旧样本）
// ------------------------------------------------------------
test('T4 下一首: 不继承上一首 anchor, 陈旧 position 被丢弃', () => {
  const W = world({ positionMs: 183400, durationMs: 200000, quantize: true });
  W.sample();
  W.stepSamples(2);
  const beforeSwitch = W.read();
  assert.ok(beforeSwitch > 180000);

  // 切歌: identity 变化, 但 SMTC 这一拍还在上报上一首的 183.4s
  W.track = TRACK_B;
  W.truthMs = 0;
  W.pendingRaw = 183400;
  const snap = W.sample();
  assert.strictEqual(snap.lastAction, 'track-reset');
  const afterSwitch = W.read();
  const newTrackMark = W.readings.length;   // 旧 anchor 被丢弃那一刻的位置跳变是合法的
  assert.ok(afterSwitch < 1000, '切歌后不得继承 183.4s: ' + afterSwitch);
  assert.strictEqual(W.sb.smtcConsumeSeekFlag(), true, '切歌必须置 seek 标记(歌词允许跳转)');

  // 下一个样本: 新歌真实位置 ~0.5s
  W.stepTo(W.clock + 500);
  W.sample();
  const anchored = W.read();
  assert.ok(Math.abs(anchored - 500) < 700, '新 anchor 应建立在新歌位置: ' + anchored);

  // 继续播放: 从新 anchor 正常推进
  W.stepSamples(4);
  const later = W.read();
  assert.ok(later > 18000 && later < 23000, '新歌时间轴正常推进: ' + later);
  assert.ok(later < beforeSwitch, '不应回到上一首的时间轴');
  assert.strictEqual(backwardCount(W.readings, newTrackMark), 0, '新歌建立 anchor 后不得出现倒退');
});

// ------------------------------------------------------------
// 基础 5: 上一首（新歌位置很大 -> 立刻采纳）
// ------------------------------------------------------------
test('T5 上一首: 直接采纳新歌的中段位置', () => {
  const W = world({ positionMs: 30000, durationMs: 300000, quantize: true });
  W.sample();
  W.stepSamples(2);
  W.track = TRACK_B;
  W.truthMs = 200000;
  const snap = W.sample();
  const stable = W.read();
  assert.strictEqual(snap.lastAction, 'track-anchor');
  assert.ok(Math.abs(stable - 200000) < 800, '应直接采纳 200s 位置: ' + stable);
});

// ------------------------------------------------------------
// 基础 6: 自然播放结束
// ------------------------------------------------------------
test('T6 自然结束: 会话关闭后无时间轴', () => {
  const W = world({ positionMs: 130000, durationMs: 137000, quantize: true });
  W.sample();
  W.stepSamples(1);
  W.sb.smtcApplyBridgeState({
    active: false, bridgeReady: true, isPlaying: false, positionMs: 133000, durationMs: 137000,
    title: 'Song A', artist: 'Artist A', album: 'Album A', aumid: TRACK_A.aumid,
  });
  assert.strictEqual(W.sb.smtcPositionSecondsNow(), -1, '会话结束后对外返回 -1');
  assert.strictEqual(W.sb.smtcTspSnapshot().phase, 'idle');
  W.stepTo(W.clock + 10000);
  assert.strictEqual(W.sb.smtcTspSnapshot().stableMs, 0, '会话结束后稳定位置必须归零');
});

// ------------------------------------------------------------
// 基础 7: 手动 seek（毫秒级播放器, 真实前向 +60s）
// ------------------------------------------------------------
test('T7 手动 seek +60s: 单次不跳, 连续一致才重建 anchor', () => {
  const W = world({ positionMs: 10000, durationMs: 300000, quantize: false });
  W.sample();
  W.stepSamples(2);
  const beforeSeek = W.read();

  W.seekTo(70000);
  const snap1 = W.sample();                    // seek 后第 1 拍
  const s1 = W.read();
  assert.strictEqual(snap1.lastAction, 'suspicious-1-3', '第 1 拍只能记为可疑');
  assert.ok(Math.abs(s1 - beforeSeek) < 60, 'seek 第 1 拍不得跳变: ' + s1);
  assert.strictEqual(W.resets(), 1, '第 1 拍不得重建 anchor');

  W.stepSamples(1);
  const snap2 = W.sb.smtcTspSnapshot();
  const s2 = W.read();
  assert.strictEqual(snap2.lastAction, 'suspicious-2-3');
  assert.ok(Math.abs(s2 - (s1 + 5000)) < 60, 'seek 第 2 拍仍不得跳变: ' + s2);

  W.stepSamples(1);
  const snap3 = W.sb.smtcTspSnapshot();
  const s3 = W.read();
  assert.strictEqual(snap3.lastAction, 'confirmed-seek', '第 3 拍确认真实 seek');
  assert.ok(Math.abs(s3 - W.rawNow()) < 700, 'anchor 必须重建到 seek 目标: ' + s3);
  assert.strictEqual(W.sb.smtcConsumeSeekFlag(), true, '真实 seek 必须置 seek 标记');
  assert.ok(W.resets() >= 2);
});

test('T7b 手动向后 seek -30s: 连续确认后同样重建', () => {
  const W = world({ positionMs: 120000, durationMs: 300000, quantize: false });
  W.sample();
  W.stepSamples(2);
  const before = W.read();
  W.seekTo(90000);
  for (let i = 0; i < 3; i += 1) W.stepSamples(1);
  const after = W.read();
  assert.ok(after < before - 20000, '向后 seek 必须最终生效: ' + after);
  assert.ok(Math.abs(after - W.rawNow()) < 700, 'anchor 重建到 seek 目标: ' + after);
  assert.strictEqual(W.sb.smtcTspSnapshot().lastAction, 'confirmed-seek');
});

// ------------------------------------------------------------
// 异常模拟 A: 正常 正常 正常 +300 正常
// ------------------------------------------------------------
test('T8 单次 +300ms 异常: 不得污染时间轴', () => {
  const W = world({ positionMs: 50000, durationMs: 300000, quantize: false });
  W.sample();
  W.stepSamples(3);
  const mark = W.readings.length;
  const before = W.read();
  W.glitchSample(300);                        // 正常, 正常, 正常, +300
  W.stepSamples(2);                           // 之后恢复正常
  const after = W.read();
  assert.strictEqual(W.resets(), 1, '不得因此重置 anchor');
  assert.ok(maxReadDelta(W.readings, mark) < 80, '不得出现可见跳变: ' + maxReadDelta(W.readings, mark).toFixed(1));
  assert.ok(Math.abs(after - before - 15000) < 500, '整体仍按 1x 推进: ' + (after - before));
  assert.strictEqual(backwardCount(W.readings, mark), 0);
});

// ------------------------------------------------------------
// 异常模拟 B: 正常 正常 +800 +800 +800 -> 最终识别为真实 seek
// ------------------------------------------------------------
test('T9 持续 +800ms x3: 最终识别为真实 seek 并重建 anchor', () => {
  const W = world({ positionMs: 50000, durationMs: 300000, quantize: false });
  W.sample();
  W.stepSamples(2);
  const mark = W.readings.length;
  const before = W.read();
  W.smtcOffsetMs = 800;                       // 之后 SMTC 一直偏 +800ms
  W.stepSamples(1);
  assert.strictEqual(W.sb.smtcTspSnapshot().lastAction, 'suspicious-1-3');
  const s1 = W.read();
  assert.ok(Math.abs(s1 - (before + 5000)) < 60, '第 1 次不得跳变(只按 1x 前进): ' + s1);
  assert.strictEqual(W.resets(), 1, '第 1 次不得重建 anchor');
  W.stepSamples(1);
  assert.strictEqual(W.sb.smtcTspSnapshot().lastAction, 'suspicious-2-3');
  W.stepSamples(1);
  assert.strictEqual(W.sb.smtcTspSnapshot().lastAction, 'confirmed-seek');
  const s3 = W.read();
  assert.ok(Math.abs((s3 - s1 - 10000) - 800) < 300,
    '确认后必须重建到新位置(相对正常 1x 前进额外 +800ms): ' + (s3 - s1));
  assert.ok(Math.abs(s3 - W.rawNow()) < 700);
  assert.strictEqual(W.sb.smtcConsumeSeekFlag(), true);
  assert.ok(maxReadDelta(W.readings, mark) < 1000, '除确认那一次外不得有额外跳变');
});

// ------------------------------------------------------------
// 异常模拟 C: 正常 正常 position 回退 500ms 正常
// ------------------------------------------------------------
test('T10 单次回退 500ms: 不得把歌词拉回去', () => {
  const W = world({ positionMs: 80000, durationMs: 300000, quantize: false });
  W.sample();
  W.stepSamples(2);
  const mark = W.readings.length;
  const beforeBack = W.readings[W.readings.length - 1].stable;
  W.glitchSample(-500);
  const during = W.read();
  assert.ok(during >= beforeBack - 0.001, 'Stable Position 绝不回退: ' + during + ' vs ' + beforeBack);
  W.stepSamples(3);
  assert.strictEqual(backwardCount(W.readings, mark), 0, '不得出现任何倒退');
  assert.strictEqual(W.resets(), 1, '单次回退不得重置 anchor');
  assert.ok(maxReadDelta(W.readings, mark) < 80, '不得出现可见跳变');
});

// ------------------------------------------------------------
// 整秒量化下的单次 +1000ms 异常（真机形态）
// ------------------------------------------------------------
test('T11 真机量化形态: 单次 +1000ms 不得产生任何跳变', () => {
  const W = world({ positionMs: 38000, durationMs: 300000, quantize: true });
  W.sample();
  W.stepSamples(2);
  const mark = W.readings.length;
  W.sb.smtcConsumeSeekFlag();      // 清掉首帧建立的合法 seek 标记
  W.glitchSample(1000);
  W.stepSamples(3);
  assert.strictEqual(W.resets(), 1, '单次整秒异常不得重置 anchor');
  assert.ok(maxReadDelta(W.readings, mark) < 80, '无可见跳变: ' + maxReadDelta(W.readings, mark).toFixed(1));
  assert.strictEqual(backwardCount(W.readings, mark), 0);
  assert.strictEqual(W.sb.smtcConsumeSeekFlag(), false, '异常样本不得触发歌词跳转');
});

// ------------------------------------------------------------
// 曲末回卷（单曲循环 / 重播）
// ------------------------------------------------------------
test('T12 曲末回卷: 2 次一致确认后重建到曲首', () => {
  const W = world({ positionMs: 193000, durationMs: 200000, quantize: true });
  W.sample();
  W.stepSamples(1);
  W.seekTo(0);                                // Apple 重播: identity 未变, position 回到 0
  W.sample();
  assert.strictEqual(W.sb.smtcTspSnapshot().lastAction, 'suspicious-1-2');
  W.stepSamples(1);
  const snap = W.sb.smtcTspSnapshot();
  assert.strictEqual(snap.lastAction, 'repeat-restart');
  const stable = W.read();
  assert.ok(stable < 12000, '回卷后时间轴回到曲首: ' + stable);
});

// ------------------------------------------------------------
// PCM: 只做状态置信度, 不做时间轴开关
// ------------------------------------------------------------
test('T13a SMTC=Playing + PCM 无能量: 降低置信度但不冻结时间轴', () => {
  const W = world({ positionMs: 30000, quantize: true });
  W.sb.smtcAudioState.active = true;
  W.sb.smtcAudioState.rms = 0.2;
  W.sb.smtcAudioState.updatedAt = W.sb.__wallNow();
  W.sample();
  W.stepSamples(1);                 // 5s 正常采样节奏
  assert.strictEqual(W.sb.smtcTspSnapshot().pcmState, 'active');
  assert.strictEqual(W.sb.smtcTspSnapshot().confidence, 1);

  // 音频断掉（安静歌曲 / 采集丢帧 / DRM 端点变化都走这条路径）;
  // SMTC 仍按真实的 5s 节奏正常上报 -> 时间轴必须继续推进, 只降低置信度。
  W.sb.smtcAudioState.rms = 0;
  const before = W.read();
  W.stepSamples(1);                 // 5s（含一次 SMTC 样本, PCM 滑窗已转静音）
  W.stepTo(W.clock + 3000);         // 再 3s（未超过下一个样本）
  const after = W.read();
  const snap = W.sb.smtcTspSnapshot();
  assert.strictEqual(snap.pcmState, 'silent');
  assert.ok(snap.confidence <= 0.45, '只降低置信度: ' + snap.confidence);
  assert.ok(after - before > 7800, '绝不因 PCM 无能量而冻结/暂停时间轴: ' + (after - before));
  assert.ok(W.resets() === 1, 'PCM 静音不得触发任何 anchor 重建');
});

test('T13b SMTC=Paused + PCM 持续有能量: 标记可疑暂停, 时间轴仍冻结', () => {
  const W = world({ positionMs: 45000, quantize: true });
  W.sb.smtcAudioState.active = true;
  W.sb.smtcAudioState.rms = 0.25;
  W.sb.smtcAudioState.updatedAt = W.sb.__wallNow();
  W.sample();
  W.stepTo(W.clock + 4000);
  W.playing = false;
  W.sample();
  const frozen = W.read();
  W.stepTo(W.clock + 4000);
  const snap = W.sb.smtcTspSnapshot();
  assert.strictEqual(snap.pauseSuspicious, true, '应标记可疑暂停');
  assert.strictEqual(snap.confidence, 0.35);
  assert.strictEqual(Math.round(W.read()), Math.round(frozen), 'PCM 不得把暂停的时间轴推走');
});

test('T13c 采集不可用: 置信度回落到 SMTC-only', () => {
  const W = world({ positionMs: 30000, quantize: true });
  W.sb.smtcAudioState.active = false;
  W.sample();
  W.stepTo(W.clock + 4000);
  const snap = W.sb.smtcTspSnapshot();
  assert.strictEqual(snap.pcmState, 'unknown');
  assert.strictEqual(snap.confidence, 0.75);
});

// ------------------------------------------------------------
// A/B 回退: legacy (v4) 仍然可用
// ------------------------------------------------------------
test('T14 legacy 回退: 关闭 TSP 后仍走 v4 平滑器', () => {
  const W = world({ positionMs: 40000, durationMs: 300000, quantize: true });
  W.sb.smtcTspSetMode('legacy');
  assert.strictEqual(W.sb.tspIsTimelineActive(), false);
  assert.strictEqual(W.sb.tspHandleBridgeState({ active: true, positionMs: 40000, isPlaying: true }, 0, {}), null,
    'legacy 模式下 TSP 必须彻底让位');
  W.sample();
  W.stepSamples(2);
  assert.ok(W.sb.smtcStore.positionMs > 40000, 'legacy 仍然产出位置: ' + W.sb.smtcStore.positionMs);
  assert.ok(W.sb.smtcPositionSecondsNow() > 40);
  W.sb.smtcTspSetMode('tsp');
  assert.strictEqual(W.sb.tspIsTimelineActive(), true);
  W.sample();
  W.stepSamples(1);
  assert.strictEqual(W.sb.smtcTspSnapshot().phase, 'playing');
});

// ------------------------------------------------------------
// 实测抓包回放: desktop/smtc-bridge.ps1 在真机 Apple Music 上录到的 20 个样本
// （整秒 position, 5s 采样, Broken Boy 38s -> 133s, aumid AppleInc.AppleMusicWin_...）
// ------------------------------------------------------------
test('T15 真机抓包回放: 无 anchor 重置, 连续单调', () => {
  const positions = [38000, 43000, 48000, 53000, 58000, 63000, 68000, 73000, 78000, 83000,
    88000, 93000, 98000, 103000, 108000, 113000, 118000, 123000, 128000, 133000];
  const sb = makeSandbox();
  let t = 0;
  const readings = [];
  for (let i = 0; i < positions.length; i += 1) {
    if (i > 0) {
      for (let k = 0; k < 100; k += 1) {       // 5s / 50ms = 100 次读取
        t += 50;
        sb.__advance(50);
        sb.__tick();
        readings.push(sb.smtcStablePositionMsNow());
      }
    }
    sb.smtcApplyBridgeState({
      active: true, bridgeReady: true, isPlaying: true, status: 'Playing',
      title: 'Broken Boy', artist: 'Anson Seabra — Broken Boy - Single', album: '',
      aumid: 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App',
      durationMs: 137000, positionMs: positions[i], lastUpdatedMs: t,
    });
  }
  const last = sb.smtcTspSnapshot();
  assert.strictEqual(last.anchorResets, 1, '真机轨迹不得出现任何 anchor 重置: ' + last.anchorResets);
  assert.strictEqual(last.quantumMs, 1000, '真机整秒量化必须被识别');
  for (let i = 1; i < readings.length; i += 1) {
    assert.ok(readings[i] >= readings[i - 1] - 0.001, '必须单调不递减 @' + i);
    assert.ok(readings[i] - readings[i - 1] < 80, '50ms 步进不得跳变 @' + i);
  }
  assert.ok(last.stableMs >= 133000 && last.stableMs < 134500, '末位置正确: ' + last.stableMs);
});

// ------------------------------------------------------------
// 验收 6: 歌词同步质量对比（TSP vs 旧 v4 平滑器, 同一异常流）
// ------------------------------------------------------------
function lyricIndexAt(lines, seconds) {
  let idx = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] <= seconds + 1e-9) idx = i; else break;
  }
  return idx;
}
function lyricTrace(readings, lines) {
  let prev = -1;
  let flips = 0;
  let flipsBack = 0;
  for (const r of readings) {
    const idx = lyricIndexAt(lines, r.stable / 1000);
    if (prev >= 0) {
      if (idx < prev) flipsBack += 1;
      else if (idx > prev) flips += 1;
    }
    prev = idx;
  }
  return { flips, flipsBack };
}
function runLyricScenario(mode) {
  const W = world({ positionMs: 5000, durationMs: 400000, quantize: false, sampleInterval: 5000 });
  if (mode === 'legacy') W.sb.smtcTspSetMode('legacy');
  W.sample();
  W.read();
  // ~8 分钟: 每 35s 注入一次 +600ms 的单次跳变（用户描述的 300~800ms 异常）
  for (let cycle = 0; cycle < 14; cycle += 1) {
    W.stepSamples(4);
    W.glitchSample(600);
    W.stepSamples(2);
  }
  const lines = [];
  for (let s = 0; s < 400; s += 7) lines.push(s);
  const ly = lyricTrace(W.readings, lines);
  const last = W.readings[W.readings.length - 1];
  return {
    mode,
    flipsBack: ly.flipsBack,
    offsetError: Math.abs(last.stable - last.truth),
    maxJump: maxReadDelta(W.readings),
    resets: W.resets(),
  };
}
test('T16 歌词同步: TSP 明显优于旧 v4 平滑器', () => {
  const tsp = runLyricScenario('tsp');
  const legacy = runLyricScenario('legacy');
  assert.strictEqual(tsp.flipsBack, 0, 'TSP: 正常播放期间歌词行绝不回跳');
  assert.ok(tsp.offsetError < 200, 'TSP: 累积偏移必须很小, got ' + tsp.offsetError.toFixed(0) + 'ms');
  assert.ok(legacy.offsetError > tsp.offsetError + 200,
    'legacy 应被异常样本拖出明显累积偏移: legacy=' + legacy.offsetError.toFixed(0) +
    'ms vs tsp=' + tsp.offsetError.toFixed(0) + 'ms');
  assert.ok(tsp.maxJump < 80, 'TSP: 无可见跳变 (' + tsp.maxJump.toFixed(1) + 'ms)');
  assert.ok(legacy.maxJump > tsp.maxJump + 10, 'legacy 存在可见跳变: ' + legacy.maxJump.toFixed(1) + 'ms');
  assert.strictEqual(tsp.resets, 1, 'TSP: 单次异常不得触发 anchor 重建');
});

// ------------------------------------------------------------
// SMTC 长时间无样本（bridge 卡死 / watchdog 重启窗口）
// ------------------------------------------------------------
test('T18 桥失联: 外推被预算冻结, 样本恢复后重建 anchor', () => {
  const W = world({ positionMs: 60000, durationMs: 300000, quantize: false });
  W.sample();
  W.stepSamples(2);
  const beforeStall = W.read();
  // 12s 完全没有 SMTC 样本（超过 8s 外推预算）
  W.stepTo(W.clock + 12000);
  const stalled = W.read();
  const stalledAdvance = stalled - beforeStall;
  assert.ok(stalledAdvance > 7000, '预算内必须继续本地推进: ' + stalledAdvance);
  assert.ok(stalledAdvance < 8600, '超过外推预算后必须冻结, 不得无限漂移: ' + stalledAdvance);

  // 样本恢复: 真值已前进, SMTC 报真实位置 -> 失联恢复第一拍直接重锚
  W.stepSamples(1);
  const snap = W.sb.smtcTspSnapshot();
  assert.strictEqual(snap.lastAction, 'stall-resync', '失联恢复第一拍必须直接重锚');
  assert.strictEqual(W.sb.smtcConsumeSeekFlag(), true, '失联恢复必须允许歌词跳到新位置');
  const recovered = W.read();
  assert.ok(Math.abs(recovered - W.rawNow()) < 700, '恢复后必须回到真实播放头: ' + recovered);
  W.stepSamples(2);
  const later = W.read();
  assert.ok(Math.abs(later - W.rawNow()) < 700, '重建后按 1x 跟随真实播放头: ' + later);
  assert.strictEqual(backwardCount(W.readings, W.readings.length - 30), 0, '恢复过程不得倒退');
});

// ------------------------------------------------------------
// 无高精度单调时钟时自动让位给 v4 legacy
// ------------------------------------------------------------
test('T19 无 performance.now(): 自动退回 legacy 平滑器', () => {
  const sb = makeSandbox();
  // 删掉高精度时钟后再加载模块（模拟异常宿主环境）
  const realPerformance = sb.performance;
  let threw = false;
  try {
    sb.performance = undefined;
    vm.runInContext(TSP_SRC.replace('(function tspInit() {', '(function tspInitDisabled() { return; })(); (function tspInit() {'), vm.createContext(sb), { filename: 'no-clock.js' });
  } catch (e) { threw = true; }
  assert.strictEqual(threw, false, '缺少 performance.now 时不得抛异常');
  sb.performance = realPerformance;
});
// ------------------------------------------------------------
// 调试日志开关
// ------------------------------------------------------------
test('T17 调试日志默认可关闭', () => {
  const W = world({ positionMs: 10000, quantize: false });
  W.sb.smtcTspSetDebug(false);
  W.sample();
  W.stepSamples(3);
  const sampleLogs = W.sb.__logs.filter((l) => l.indexOf('[TSP] SMTC=') === 0);
  assert.strictEqual(sampleLogs.length, 0, '调试关闭时不得输出 [TSP] 诊断行');
  W.sb.smtcTspSetDebug(true);
  W.stepSamples(1);
  assert.ok(W.sb.__logs.some((l) => l.indexOf('[TSP] SMTC=') === 0), '开启后应输出诊断行');
  const dump = W.sb.smtcTspDump();
  assert.ok(dump.split('\n').length > 5, '环形缓冲始终记录: ' + dump.split('\n').length);
  assert.ok(dump.indexOf('SMTC=') >= 0);
  assert.ok(dump.indexOf('track="') >= 0, '诊断必须包含歌曲身份');
});
