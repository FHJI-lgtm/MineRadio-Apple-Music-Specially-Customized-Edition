'use strict';
// ============================================================
// 长前奏等待态测试 (第一句 t=34.7s 的歌曲, 在 0~34.7s 就应显示第 0 行)
//
//   TEST 21: 3D 舞台 tickLyricsParticles() ——
//            前奏阶段建立并显示第 0 行 (payload, 不是 title 字符串), progress 恒为 0,
//            到 lines[0].t 时复用同一 payload 进入 current 并开始高亮;
//            纯 title 兜底 / 歌词未到 的旧行为不变; 拖动到第一句之前仍显示等待态。
//   TEST 22: 桌面歌词浮窗 currentDesktopLyricSnapshot() 同一原则。
//   TEST 23: 等待态 progress=0 确实落到 mesh (updateLyricMeshProgress 真实实现)。
//   TEST 24: 边界守卫 —— findStageLyricIndexAtTime 未被改动, 新代码不写任何时间戳。
//
// 说明: 渲染模块用 vm + 最小全局环境加载**真实源码**, 只把 GPU/异步边界
//       (showStageLine / 预热调度 / mesh 进度写入) 换成记录器, 断言分支行为本身。
// 运行: node tests/lyric-intro-waiting-state.test.js
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const visualDir = path.join(appRoot, 'public', 'js', 'modules', '02-visual');
const parseFile = path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js');
const shellFile = path.join(appRoot, 'public', 'js', 'modules', '10-shell', '04-desktop-overlay-fullscreen.js');
const meshFile = path.join(visualDir, '13-lyrics-mesh-build.js');

const FIRST_T = 34.7;

function read(...parts) {
  return fs.readFileSync(path.join(appRoot, ...parts), 'utf8');
}

// 从源码里按大括号配对取出一整个函数 (用真实源码, 不做副本)
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '缺少函数 ' + name);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('无法配对函数 ' + name);
}

function makeSandbox() {
  const sandbox = {
    console,
    Math, JSON, Array, Object, String, Number, Boolean, Date, RegExp, Error, Promise,
    isFinite, parseInt, parseFloat, setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.clampRange = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
  sandbox.normalizeStageLyricText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  sandbox.normalizeLyricTranslationText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  sandbox.normalizeLyricDisplayMode = (v) => (v === 'cinema' || v === 'dual' || v === 'multi' || v === 'custom' ? v : 'single');
  sandbox.normalizeLyricTranslationMode = (v) => v || 'off';
  sandbox.lyricFontWeightValue = () => 900;
  sandbox.lyricContextOpacityValue = () => 0.42;
  sandbox.lyricTranslationScaleValue = () => 0.78;
  sandbox.lyricTranslationVisualGapValue = () => 1.2;
  sandbox.lyricTranslationOpacityValue = () => 0.9;
  sandbox.lyricContextSpreadValue = () => 1;
  sandbox.lyricLineTranslationTextAt = () => '';
  sandbox.lyricLineHasNativeKaraoke = () => false;
  sandbox.lyricTextureClarityScale = () => 1;
  sandbox.lyricVerticalFloatEnabled = () => false;
  sandbox.lyricQualityPoolBudgetBytes = () => 32 * 1024 * 1024;
  sandbox.lyricsHasNativeKaraoke = false;
  sandbox.lyricsTimingSource = 'yrc-word';
  sandbox.trackSwitchToken = 0;
  sandbox.playQueue = [];
  sandbox.currentIdx = -1;
  sandbox.songProviderKey = () => 'diag-song';
  sandbox.fx = { particleLyrics: true, lyricDisplayMode: 'cinema', lyricTranslationMode: 'current' };
  sandbox.fxDefaults = { lyricTranslationScale: 0.78 };
  sandbox.lyricsLines = [];
  sandbox.lyricsTranslationLines = [];
  sandbox.THREE = (function () {
    function Vec3() { this.x = 0; this.y = 0; this.z = 0; }
    Vec3.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
    Vec3.prototype.copy = function () { return this; };
    Vec3.prototype.normalize = function () { return this; };
    Vec3.prototype.addScaledVector = function () { return this; };
    Vec3.prototype.applyQuaternion = function () { return this; };
    Vec3.prototype.setFromQuaternion = function () { return this; };
    function Quat() {}
    Quat.prototype.set = function () { return this; };
    Quat.prototype.copy = function () { return this; };
    Quat.prototype.multiply = function () { return this; };
    Quat.prototype.setFromEuler = function () { return this; };
    function Euler() {}
    Euler.prototype.set = function () { return this; };
    function Color() {}
    Color.prototype.set = function (v) { this.hex = v; return this; };
    Color.prototype.setHex = function (v) { this.hex = v; return this; };
    return { Vector3: Vec3, Quaternion: Quat, Euler: Euler, Color: Color };
  })();
  sandbox.audio = { src: 'stub', currentTime: 0, duration: 240, paused: false, ended: false };
  // 真实 karaoke 逐词进度路径 (getLyricLineProgress) 只用 canvas 度量文字宽度, 与 GPU 无关
  sandbox.document = {
    createElement: () => ({ width: 1, height: 1, getContext: () => ({ measureText: (t) => ({ width: String(t == null ? '' : t).length }) }) }),
    getElementById: () => null,
  };
  sandbox.normalizeLyricFontKey = () => 'stub-font';
  sandbox.lyricMeasureTextAtSize = (ctx, text) => String(text == null ? '' : text).length;
  return vm.createContext(sandbox);
}

function loadStageModules(ctx) {
  // 02-lyrics-state-layout.js 定义真实的 stageLyrics 状态对象 (等待态要写 currentIdx/progress)
  vm.runInContext(fs.readFileSync(path.join(visualDir, '02-lyrics-state-layout.js'), 'utf8'), ctx, { filename: '02-lyrics-state-layout.js' });
  ['08-lyrics-display-modes.js', '09-lyrics-payloads.js'].forEach((name) => {
    vm.runInContext(fs.readFileSync(path.join(visualDir, name), 'utf8'), ctx, { filename: name });
  });
  vm.runInContext(fs.readFileSync(parseFile, 'utf8'), ctx, { filename: '00-lyrics-fetch-parse.js' });
  vm.runInContext(fs.readFileSync(path.join(visualDir, '14-stage-lyrics-rendering.js'), 'utf8'), ctx, { filename: '14-stage-lyrics-rendering.js' });
}

// GPU/异步边界记录器 (必须在加载真实模块之后安装, 否则会被模块内的声明覆盖)
function installBoundaryRecorders(ctx) {
  ctx.__calls = { show: [], warmup: [], prewarm: [], fullTrack: [], progress: [] };
  ctx.__clock = 0;
  ctx.playing = true;
  ctx.getProgressDragPreviewSeconds = () => ctx.__clock;
  ctx.isProgressDragPreviewActive = () => ctx.__dragging === true;
  ctx.externalStageLyricSeconds = () => null;
  ctx.getAdjustedLyricPlaybackTime = (t) => t;
  ctx.disposeLyricMesh = () => {};
  ctx.updateLyricMeshProgress = function (mesh, progress, opts) {
    ctx.__calls.progress.push({ progress: progress, nativeKaraoke: !!(opts && opts.nativeKaraoke), mesh: mesh });
    if (mesh && mesh.userData) mesh.userData.lastLyricProgress = progress;
  };
  ctx.requestStageLyricWarmup = (reason, ms) => { ctx.__calls.warmup.push({ reason: reason, ms: ms }); };
  ctx.scheduleStageLyricPrewarmForIndex = (index, reason, delay) => { ctx.__calls.prewarm.push({ index: index, reason: reason, delay: delay }); };
  ctx.scheduleStageLyricFullTrackWarmup = (reason, delay) => { ctx.__calls.fullTrack.push({ reason: reason, delay: delay }); };
  ctx.scheduleStageLyricSingleLineCachePrewarm = () => {};
  // showStageLine: 模拟真实成功路径的状态写入 (不建任何 mesh)
  ctx.showStageLine = function (payload, redrawOnly, options) {
    const isString = typeof payload === 'string';
    ctx.__calls.show.push({ isString: isString, text: isString ? payload : String(payload && payload.text || ''), payload: isString ? null : payload, options: options || null });
    if (isString) return true;
    ctx.stageLyrics.currentText = payload.text || '';
    ctx.stageLyrics.currentDisplayKey = payload.key || '';
    ctx.stageLyrics.currentPayload = payload;
    ctx.stageLyrics.current = { userData: { lyric: {}, payload: payload }, position: { x: 0, y: 0, z: 0 }, scale: { x: 1 } };
    return true;
  };
}

function makeRealLyrics() {
  return [
    { t: FIRST_T, duration: 3.2, text: 'I said, baby, I got you', charCount: 24, words: [{ text: 'I said, baby', t: FIRST_T, d: 1.2, c0: 0, c1: 11 }], translation: '我说, 宝贝, 我懂你' },
    { t: FIRST_T + 3.4, duration: 3.0, text: 'second line', charCount: 11, words: [], translation: '第二行' },
    { t: FIRST_T + 6.5, duration: 3.0, text: 'third line', charCount: 10, words: [], translation: '第三行' },
  ];
}

// ------------------------------------------------------------
// TEST 21: 前奏阶段就建立/显示第 0 行, 且不进入高亮; 到点后无缝进入 current
// ------------------------------------------------------------
test('TEST 21: 长前奏 (第一句 t=34.7s) 在 0~34.7s 显示第 0 行, 到点后开始高亮', () => {
  const ctx = makeSandbox();
  loadStageModules(ctx);
  installBoundaryRecorders(ctx);
  ctx.lyricsLines = makeRealLyrics();
  ctx.lyricsEnglishFallback = null;

  // --- 1) 前奏 t=0.5s: 必须显示第 0 行的 payload (不是 title 字符串) ---
  ctx.__clock = 0.5;
  ctx.tickLyricsParticles();
  assert.strictEqual(ctx.__calls.show.length, 1, '前奏阶段必须调用一次 showStageLine');
  const first = ctx.__calls.show[0];
  assert.strictEqual(first.isString, false, '前奏阶段不得再显示 title 字符串');
  assert.strictEqual(first.payload.trackIndex, 0, '等待态必须是第 0 行 (trackIndex=0)');
  const texts = (first.payload.entries || []).map((e) => e.text);
  assert.ok(texts.indexOf('I said, baby, I got you') >= 0, '等待态必须包含第 0 行歌词文本, 实际: ' + JSON.stringify(texts));
  assert.strictEqual(ctx.stageLyrics.currentIdx, 0, '等待态 currentIdx 必须为 0');
  assert.strictEqual(ctx.__calls.progress.length, 1);
  assert.strictEqual(ctx.__calls.progress[0].progress, 0, '等待态进度必须为 0 (无逐字高亮)');
  assert.ok(ctx.__calls.warmup.some((c) => c.reason === 'intro-first-line'), '必须请求 intro-first-line 预热');
  assert.ok(ctx.__calls.prewarm.some((c) => c.index === 0 && c.reason === 'intro-first-line'), '必须预热第 0 行');
  assert.ok(ctx.__calls.fullTrack.length >= 1, '必须请求整轨预热 (避免到点时才开始构建)');

  // --- 2) 前奏继续 (t=20s): 不重复建 mesh, 进度仍为 0 ---
  const showBefore = ctx.__calls.show.length;
  ctx.__clock = 20;
  ctx.tickLyricsParticles();
  assert.strictEqual(ctx.__calls.show.length, showBefore, '等待态不得每帧重建 mesh');
  assert.strictEqual(ctx.__calls.progress[ctx.__calls.progress.length - 1].progress, 0, '前奏期间进度必须恒为 0');
  assert.strictEqual(ctx.stageLyrics.currentIdx, 0);

  // --- 3) 到第一句时刻 t=34.9s: 复用同一 payload, 不重建, 进度开始增长 ---
  const showAtIntro = ctx.__calls.show.length;
  const progressBefore = ctx.__calls.progress.length;
  ctx.__clock = FIRST_T + 0.2;
  ctx.tickLyricsParticles();
  assert.strictEqual(ctx.stageLyrics.currentIdx, 0, '到点后仍应是第 0 行 (current)');
  assert.strictEqual(ctx.__calls.show.length, showAtIntro, '到点必须复用等待态 payload, 不得重建 mesh');
  const lastProgress = ctx.__calls.progress[ctx.__calls.progress.length - 1];
  assert.ok(ctx.__calls.progress.length > progressBefore, '到点后必须继续写入进度');
  assert.ok(lastProgress.progress > 0, '到第一句后必须开始逐字/进度高亮, 实际: ' + lastProgress.progress);
  assert.ok(lastProgress.progress < 1);

  // --- 4) 再往后: 进度继续增长 (正常进入 current) ---
  ctx.__clock = FIRST_T + 2.0;
  ctx.tickLyricsParticles();
  const later = ctx.__calls.progress[ctx.__calls.progress.length - 1];
  assert.ok(later.progress > lastProgress.progress, '进度必须继续推进: ' + lastProgress.progress + ' -> ' + later.progress);

  // --- 5) 拖动到第一句之前: 仍是等待态 (第 0 行), 且视觉就绪判定接受等待态 ---
  ctx.__dragging = true;
  ctx.__clock = 5;
  ctx.stageLyrics.currentIdx = 0;
  assert.strictEqual(ctx.stageLyricProgressSeekVisualReady(5), true, '拖动到前奏区间时必须认为等待态视觉就绪');
  ctx.__calls.show.length = 0;
  ctx.tickLyricsParticles();
  assert.ok(ctx.__calls.show.every((c) => c.isString === false), '拖动到前奏区间不得显示 title 字符串');
  ctx.__dragging = false;

  // --- 6a) 完全没有歌词 (lyricsLines 为空): tick 仍然直接早退, 不显示任何东西 ---
  const ctx2 = makeSandbox();
  loadStageModules(ctx2);
  installBoundaryRecorders(ctx2);
  ctx2.currentLyricSong = () => ({ name: 'Song', artist: 'Artist' });
  ctx2.lyricsLines = [];
  ctx2.__clock = 0.5;
  ctx2.stageLyrics.current = { userData: { lyric: {} } };
  ctx2.tickLyricsParticles();
  assert.strictEqual(ctx2.__calls.show.length, 0, '没有歌词时不得显示任何歌词');
  assert.strictEqual(ctx2.stageLyrics.current, null, '没有歌词时必须收回当前行 (既有行为)');
  assert.strictEqual(ctx2.stageLyrics.outgoing.length, 1, '收回的行进入 outgoing (既有行为)');

  // --- 6b) 纯 title 兜底行 (t=0): 既有 normal 分支行为不变, 不伪造歌词 ---
  const ctx3 = makeSandbox();
  loadStageModules(ctx3);
  installBoundaryRecorders(ctx3);
  ctx3.currentLyricSong = () => ({ name: 'Song', artist: 'Artist' });
  ctx3.lyricsLines = [{ t: 0, text: 'Song - Artist', charCount: 13, fallback: true }];
  ctx3.__clock = 0.5;
  ctx3.tickLyricsParticles();
  assert.strictEqual(ctx3.__calls.show.length, 1, '纯 title 兜底仍必须显示');
  const fallbackShown = ctx3.__calls.show[0];
  const fallbackTexts = fallbackShown.isString ? [fallbackShown.text] : (fallbackShown.payload.entries || []).map((e) => e.text);
  assert.ok(fallbackTexts.indexOf('Song - Artist') >= 0, '纯 title 兜底必须显示 title: ' + JSON.stringify(fallbackTexts));
  assert.strictEqual(ctx3.stageLyrics.currentIdx, 0, '兜底行 t=0 属于当前行 (既有行为)');

  // --- 6c) 没有真实歌词 + 第一句 t>0: 旧 intro title 卡片分支必须保持不变 (哨兵 -2) ---
  const ctx4 = makeSandbox();
  loadStageModules(ctx4);
  installBoundaryRecorders(ctx4);
  ctx4.currentLyricSong = () => ({ name: 'Song', artist: 'Artist' });
  ctx4.lyricsLines = [{ t: 30, text: 'Song - Artist', charCount: 13, fallback: true }];
  ctx4.__clock = 0.5;
  ctx4.tickLyricsParticles();
  assert.strictEqual(ctx4.__calls.show.length, 1, '没有真实歌词时仍必须显示 title 卡片');
  assert.strictEqual(ctx4.__calls.show[0].isString, true, '没有真实歌词时必须仍是 title 字符串');
  assert.strictEqual(ctx4.__calls.show[0].text, 'Song - Artist');
  assert.strictEqual(ctx4.stageLyrics.currentIdx, -2, 'title 卡片哨兵语义不得改变');

  // --- 6d) 没有真实歌词且无歌名: 仍然清空舞台 (旧行为) ---
  const ctx5 = makeSandbox();
  loadStageModules(ctx5);
  installBoundaryRecorders(ctx5);
  ctx5.currentLyricSong = () => null;
  ctx5.lyricsLines = [{ t: 30, text: 'x', charCount: 1, fallback: true }];
  ctx5.__clock = 0.5;
  ctx5.stageLyrics.current = { userData: { lyric: {} } };
  ctx5.stageLyrics.currentIdx = -1;
  ctx5.tickLyricsParticles();
  assert.strictEqual(ctx5.__calls.show.length, 0, '无歌词无歌名时不得凭空显示任何歌词');
  assert.strictEqual(ctx5.stageLyrics.current, null, '无歌词无歌名时必须清空舞台 (旧行为)');
});

// ------------------------------------------------------------
// TEST 22: 桌面歌词浮窗同一原则 (真实函数体, 从 04 里按大括号取出执行)
// ------------------------------------------------------------
test('TEST 22: 桌面歌词浮窗在前奏阶段显示第 0 行 (progress=0), 无歌词时仍是 title', () => {
  const ctx = makeSandbox();
  loadStageModules(ctx);
  const shellSrc = fs.readFileSync(shellFile, 'utf8');
  const fnSrc = extractFunction(shellSrc, 'currentDesktopLyricSnapshot');
  ctx.normalizeDesktopLyricText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  ctx.currentDesktopSongMeta = () => ({ title: 'I Was Never There', artist: 'Abel Tesfaye' });
  ctx.stageLyrics.currentText = '';
  ctx.playing = true;
  ctx.lyricsLines = makeRealLyrics();
  ctx.lyricsLines[0].background = "(Cry, cry, cry, cry)";
  ctx.lyricsLines[0].backgroundTranslation = '（哭泣）';
  const snapshot = vm.runInNewContext(fnSrc + '\n; currentDesktopLyricSnapshot', ctx);

  // 前奏 t=1s
  ctx.audio.currentTime = 1;
  const waiting = snapshot();
  assert.strictEqual(waiting.text, 'I said, baby, I got you', '前奏必须显示第 0 行歌词, 而不是 title');
  assert.strictEqual(waiting.progress, 0, '前奏等待态进度必须为 0 (无逐字高亮)');
  assert.strictEqual(waiting.textBg, 'Cry, cry, cry, cry', 'bg 原文必须带出且去括号');
  assert.strictEqual(waiting.textBgTranslation, '哭泣', 'bg 译文必须带出且去括号');
  assert.ok(waiting.progressSpan > 0);

  // 到第一句之后: 正常进入 current (进度 > 0)
  ctx.audio.currentTime = FIRST_T + 1.0;
  const current = snapshot();
  assert.strictEqual(current.text, 'I said, baby, I got you');
  assert.ok(current.progress > 0, '到点后必须开始高亮: ' + current.progress);

  // 无真实歌词 (纯 title 兜底): 仍是 title 卡片, 不受影响
  ctx.lyricsLines = [{ t: 0, text: 'Song - Artist', charCount: 13, fallback: true }];
  ctx.audio.currentTime = 1;
  const fallback = snapshot();
  assert.strictEqual(fallback.text, 'Song - Artist', '无真实歌词时必须是 title 卡片');
});

// ------------------------------------------------------------
// TEST 23: 等待态 progress=0 确实写入 mesh (13 的真实实现)
// ------------------------------------------------------------
test('TEST 23: updateLyricMeshProgress(真实实现) 把等待态 progress=0 写入 mesh', () => {
  const meshSrc = fs.readFileSync(meshFile, 'utf8');
  const fnSrc = extractFunction(meshSrc, 'updateLyricMeshProgress');
  const fn = vm.runInNewContext(fnSrc + '\n; updateLyricMeshProgress', { Math: Math, isFinite: isFinite });
  const mesh = { userData: { lyric: {} } };
  fn(mesh, 0);
  assert.strictEqual(mesh.userData.targetLyricProgress, 0, '等待态必须把目标进度写成 0');
  fn(mesh, 0.5);
  assert.strictEqual(mesh.userData.targetLyricProgress, 0.5, '到点后必须能正常推进进度');
  // 持久轨道的 pending 分支同样保持 0
  const pendingMesh = { userData: { lyric: { trackPersistent: true, trackPendingPayload: { trackIndex: 0 } } } };
  fn(pendingMesh, 0);
  assert.strictEqual(pendingMesh.userData.lyric.trackPendingProgress.value, 0);
});

// ------------------------------------------------------------
// TEST 24: 边界守卫 —— 二分查找与时间戳均未被触碰
// ------------------------------------------------------------
test('TEST 24: findStageLyricIndexAtTime 与所有歌词时间戳保持不变', () => {
  const src = read('public', 'js', 'modules', '02-visual', '14-stage-lyrics-rendering.js');
  const fn = extractFunction(src, 'findStageLyricIndexAtTime');
  assert.match(fn, /return -1;/, '没有当前行时仍必须返回 -1 (不得就地夹成 0)');
  assert.match(fn, /var target = \(Number\(t\) \|\| 0\) \+ 0\.05;/, '时间比较必须保持原样');
  assert.ok(!/return 0/.test(fn), 'findStageLyricIndexAtTime 不得被改成返回 0');

  const branch = src.slice(src.indexOf('if (newIdx < 0) {'), src.indexOf('var introText = currentLyricFallbackText();'));
  assert.ok(branch.length > 0, '必须能定位新的前奏等待态分支');
  assert.match(branch, /lyricsAreFallbackTitleOnly\(lyricsLines\)/, '必须只对"有真实歌词"的情况生效');
  assert.match(branch, /buildStageLyricPlaybackPayload\(0\)/, '等待态必须建立第 0 行的 payload');
  assert.match(branch, /stageLyrics\.currentIdx = 0;/, '等待态必须把 currentIdx 设为 0');
  assert.match(branch, /updateLyricMeshProgress\(stageLyrics\.current, 0\);/, '等待态必须把进度固定为 0');
  // 不写任何时间戳 / 不碰数据层
  assert.ok(!/\.t\s*=[^=]/.test(branch), '不得写歌词 t');
  assert.ok(!/\.duration\s*=[^=]/.test(branch), '不得写歌词 duration');
  assert.ok(!/lyricsLines\s*=/.test(branch), '不得替换 lyricsLines');
  assert.ok(!/background\s*=|translation\s*=/.test(branch), '不得改写歌词数据');
  assert.ok(!/findStageLyricIndexAtTime\s*=/.test(src), '不得替换二分查找函数');

  // 桌面歌词浮窗: 同样的守卫
  const shell = read('public', 'js', 'modules', '10-shell', '04-desktop-overlay-fullscreen.js');
  const shellFn = extractFunction(shell, 'currentDesktopLyricSnapshot');
  assert.match(shellFn, /!lyricsAreFallbackTitleOnly\(lines\)/, '浮窗等待态必须只对"有真实歌词"生效');
  assert.match(shellFn, /progress: 0,/, '浮窗等待态进度必须为 0');
  assert.ok(!/\.t\s*=[^=]/.test(shellFn), '浮窗不得写歌词时间戳');
  // 未触碰禁止区域
  ['apple-music-web-lyrics.js', 'apple-music-api.js'].forEach((rel) => {
    assert.ok(!read(rel).includes('waitingLine'), rel + ' 不得包含渲染层等待态改动');
  });
  assert.ok(!read('desktop', 'smtc-bridge.ps1').includes('waitingLine'), 'SMTC 边界脚本不得被触碰');
});
