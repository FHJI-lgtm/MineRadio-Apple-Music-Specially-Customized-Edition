'use strict';
// ============================================================
// 收尾改动测试: BG 逐字高亮 + BG 显示去括号 + Token 页面排版
//
//   TEST 18: 背景人声 (role === 'bg') 复用主行逐字/进度高亮机制, 且
//            - 主歌词/译文的着色与高亮路径完全不变 (uFillBand 恒为 0);
//            - 只有"父行 = 当前行"的 bg 行才进入高亮;
//            - 同一 mask 里的 bg 官方译文被竖向填充带排除, 保持静态。
//   TEST 19: BG 主歌词与 BG 译文的显示文本去掉最外层成对括号, 原始数据保持原样。
//   TEST 20: Apple Music 凭证页面排版 (固定标题/可滚动内容/固定 footer, 说明文字整行宽,
//            重新导入 + 删除凭证 同行), 凭证功能与 DOM id 不变。
//
// 说明: 渲染层是浏览器模块, 这里用 vm 提供最小全局环境后加载**真实源码**,
//       不做"复制实现"式的断言; 只在无法实例化 THREE 资源的地方做源码结构守卫。
// 运行: node tests/lyric-bg-highlight-display-ui.test.js
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const visualDir = path.join(appRoot, 'public', 'js', 'modules', '02-visual');
const shellDir = path.join(appRoot, 'public', 'js', 'modules', '10-shell');
const parseFile = path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js');

function readFileIn(...parts) {
  return fs.readFileSync(path.join(appRoot, ...parts), 'utf8');
}

// ------------------------------------------------------------
// vm harness: 与既有 bg 测试同一套最小全局环境
// ------------------------------------------------------------
function makeSandbox() {
  const sandbox = {
    console,
    Math, JSON, Array, Object, String, Number, Boolean, Date, RegExp, Error, Promise,
    isFinite, parseInt, parseFloat,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.clampRange = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
  sandbox.normalizeLyricTranslationText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  sandbox.normalizeStageLyricText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  sandbox.normalizeLyricDisplayMode = (v) => v || 'single';
  sandbox.normalizeLyricTranslationMode = (v) => v || 'off';
  sandbox.lyricFontWeightValue = () => 900;
  sandbox.lyricContextOpacityValue = () => 0.42;
  sandbox.lyricTranslationScaleValue = () => 0.78;
  sandbox.lyricTranslationVisualGapValue = () => 1.2;
  sandbox.lyricTranslationOpacityValue = () => 0.9;
  sandbox.lyricContextSpreadValue = () => 1;
  sandbox.lyricLineTranslationTextAt = (i) => {
    const line = sandbox.lyricsLines && sandbox.lyricsLines[i];
    return line && line.translation ? line.translation : '';
  };
  sandbox.fx = { lyricDisplayMode: 'single', lyricTranslationMode: 'off' };
  sandbox.fxDefaults = { lyricTranslationScale: 0.78 };
  sandbox.lyricsLines = [];
  sandbox.lyricsTranslationLines = [];
  sandbox.THREE = {};
  return vm.createContext(sandbox);
}

function loadVisual(ctx) {
  ['08-lyrics-display-modes.js', '09-lyrics-payloads.js'].forEach((name) => {
    vm.runInContext(fs.readFileSync(path.join(visualDir, name), 'utf8'), ctx, { filename: name });
  });
}

function loadRowLayers(ctx) {
  ctx.lyricTextureClarityScale = ctx.lyricTextureClarityScale || (() => 1);
  ctx.lyricVerticalFloatEnabled = ctx.lyricVerticalFloatEnabled || (() => false);
  ctx.lyricQualityPoolBudgetBytes = ctx.lyricQualityPoolBudgetBytes || (() => 32 * 1024 * 1024);
  loadVisual(ctx);
  vm.runInContext(fs.readFileSync(path.join(visualDir, '12-lyrics-row-layers.js'), 'utf8'), ctx, { filename: '12-lyrics-row-layers.js' });
}

function loadParse(ctx) {
  vm.runInContext(fs.readFileSync(parseFile, 'utf8'), ctx, { filename: '00-lyrics-fetch-parse.js' });
}

// 真实 11-lyrics-shaders.js 需要的最小 THREE / uniforms 环境
function makeShaderSandbox() {
  const ctx = makeSandbox();
  ctx.uniforms = { uTime: { value: 0 } };
  ctx.lyricsHasNativeKaraoke = false;
  ctx.lyricMotionProfile = () => ({
    sweep: 0.5, shimmer: 0.25, glitch: 0.7, glitchSlice: 0.4, glitchChroma: 0.3, glitchRate: 1.4, edgeBoost: 1.2,
  });
  ctx.lyricThreeColor = (css, fallback, minLum) => ({ isColor: true, css: css || fallback, minLum });
  ctx.lyricStageGlowThreeColor = () => ({ isColor: true, css: 'stage-glow' });
  ctx.lyricBeatGlowThreeColor = () => ({ isColor: true, css: 'beat-glow' });
  ctx.THREE = {
    DoubleSide: 2,
    ShaderMaterial: function ShaderMaterial(options) { Object.assign(this, options); },
  };
  vm.runInContext(fs.readFileSync(path.join(visualDir, '11-lyrics-shaders.js'), 'utf8'), ctx, { filename: '11-lyrics-shaders.js' });
  return ctx;
}

const FAKE_MASK = { texture: { id: 'tex' }, textMin: 0.42, textMax: 0.58 };
const FAKE_PAL = { primary: '#d6f8ff', secondary: '#9cffdf', highlight: '#fff0b8' };

// ------------------------------------------------------------
// TEST 18-A: shader 层的"可选竖向填充带"必须默认完全关闭 (主歌词路径逐像素不变)
// ------------------------------------------------------------
test('TEST 18-A: makeLyricShaderMaterial 默认不启用填充带, 所有默认 uniform 与改动前一致', () => {
  const ctx = makeShaderSandbox();
  const mat = ctx.makeLyricShaderMaterial(FAKE_MASK, FAKE_PAL, null);
  const u = mat.uniforms;
  // 逐字高亮的既有公式仍然存在 (复用, 不是重写)
  assert.match(mat.fragmentShader, /float filled = \(1\.0 - smoothstep\(uProgress, uProgress \+ uFeather, p\)\) \* activeMix;/);
  assert.match(mat.fragmentShader, /float activeMix = clamp\(uActiveMix, 0\.0, 1\.0\);/);
  // 主歌词/译文: 填充带整段关闭 => 该 GPU 分支被跳过
  assert.strictEqual(u.uFillBand.value, 0, '默认 uFillBand 必须为 0 (不进入新分支)');
  assert.strictEqual(u.uFillBandMin.value, 0);
  assert.strictEqual(u.uFillBandMax.value, 1);
  // 其余 uniform 必须等于改动前的硬编码取值
  assert.strictEqual(u.uSweep.value, 0.5);
  assert.strictEqual(u.uShimmer.value, 0.25);
  assert.strictEqual(u.uGlitch.value, 0.7);
  assert.strictEqual(u.uGlitchSlice.value, 0.4);
  assert.strictEqual(u.uGlitchChroma.value, 0.3);
  assert.strictEqual(u.uGlitchRate.value, 1.4);
  assert.strictEqual(u.uEdgeBoost.value, 1.2);
  assert.strictEqual(u.uFeather.value, 0.055, 'lyricsHasNativeKaraoke=false 时 feather 仍是 0.055');
  assert.strictEqual(u.uBaseColor.value.css, FAKE_PAL.primary);
  assert.strictEqual(u.uHiColor.value.css, FAKE_PAL.highlight);
  assert.strictEqual(u.uGlowColor.value.css, 'stage-glow');
  assert.strictEqual(u.uSolarColor.value.css, 'beat-glow');
  assert.strictEqual(mat.transparent, true);
  assert.strictEqual(mat.depthTest, false);
  assert.strictEqual(mat.depthWrite, false);
  // 竖向限制只在显式传入合法 fillBand 时才生效
  assert.strictEqual(ctx.makeLyricShaderMaterial(FAKE_MASK, FAKE_PAL, null, { fillBand: null }).uniforms.uFillBand.value, 0);
  assert.strictEqual(ctx.makeLyricShaderMaterial(FAKE_MASK, FAKE_PAL, null, { fillBand: { min: 0.3 } }).uniforms.uFillBand.value, 0);
});

// ------------------------------------------------------------
// TEST 18-B: bg 材质使用弱化参数 + 填充带, 且主歌词分支未被改动
// ------------------------------------------------------------
test('TEST 18-B: bg 行材质复用主行 shader, 参数弱化并只让第一行高亮', () => {
  const ctx = makeShaderSandbox();
  const base = { isColor: true, css: 'bg-base' };
  const hi = { isColor: true, css: 'bg-hi' };
  const band = { min: 0.34, max: 1, feather: 0.0104 };
  const mat = ctx.makeLyricShaderMaterial(FAKE_MASK, FAKE_PAL, null, {
    baseColor: base, hiColor: hi, glowColor: { isColor: true, css: 'bg-glow' }, solarColor: { isColor: true, css: 'bg-solar' },
    edgeBoost: 0.42, sweep: 0, shimmer: 0, glitch: 0, glitchChroma: 0, fillBand: band,
  });
  const u = mat.uniforms;
  assert.strictEqual(u.uFillBand.value, 1);
  assert.strictEqual(u.uFillBandMin.value, band.min);
  assert.strictEqual(u.uFillBandMax.value, band.max);
  assert.strictEqual(u.uFillBandFeather.value, band.feather);
  assert.strictEqual(u.uBaseColor.value, base);
  assert.strictEqual(u.uHiColor.value, hi);
  assert.strictEqual(u.uEdgeBoost.value, 0.42);
  assert.strictEqual(u.uSweep.value, 0);
  assert.strictEqual(u.uShimmer.value, 0);
  assert.strictEqual(u.uGlitch.value, 0);
  assert.strictEqual(u.uGlitchChroma.value, 0);
  assert.strictEqual(u.uGlitchSlice.value, 0.4, '未覆盖的动画参数沿用 motionProfile');
  // 填充带只用 activeMix 缩放 (即只影响 filled/edge/sweep 等高亮项, 不影响基色/alpha)
  assert.match(mat.fragmentShader, /if \(uFillBand > 0\.5\) \{/);
  assert.match(mat.fragmentShader, /activeMix \*= smoothstep\(uFillBandMin/);
  assert.match(mat.fragmentShader, /gl_FragColor = vec4\(color, alpha \* uOpacity\);/);
  // 12 侧: bg 分支必须走真实的 makeLyricShaderMaterial + 弱化参数 + fillBand, 且只改 bg 分支
  const rowSrc = readFileIn('public', 'js', 'modules', '02-visual', '12-lyrics-row-layers.js');
  assert.match(rowSrc, /function lyricRowFillBandForMaskLine\(mask, lineIndex\)/);
  assert.match(rowSrc, /makeLyricShaderMaterial\(lineMask, state\.pal, state\.motionProfile, \{/, 'bg 行必须复用主行 shader 材质函数');
  assert.match(rowSrc, /fillBand: lyricRowFillBandForMaskLine\(lineMask, 0\)/, 'bg 行必须只让第 0 行 (bg 原文) 参与高亮');
  assert.match(rowSrc, /\.lerp\(bgBaseColor, 0\.42\)/, 'bg 高亮色必须是弱化色 (向基色回混)');
  assert.match(rowSrc, /edgeBoost: 0\.42/);
  assert.match(rowSrc, /sweep: 0,\n\s*shimmer: 0,\n\s*glitch: 0,/, 'bg 行必须关闭 sweep/shimmer/glitch');
  // 主歌词分支保持不变 (仍然是三参数调用, 不带 opts)
  assert.match(rowSrc, /if \(!entry\.translationLine && !entry\.backgroundLine\) \{\n\s*material = makeLyricShaderMaterial\(lineMask, state\.pal, state\.motionProfile\);/);
  // 译文分支颜色公式不变
  assert.match(rowSrc, /color: lyricThreeColor\(state\.pal\.highlight \|\| state\.pal\.primary, '#eaf6ff', 0\.42\)/);
});

// ------------------------------------------------------------
// TEST 18-C: 填充带的几何: 完整包含 bg 原文, 完整排除同 mask 的 bg 译文
// ------------------------------------------------------------
test('TEST 18-C: fillBand 落在 bg 原文与 bg 译文墨迹之间的空档 (两侧都不裁)', () => {
  const ctx = makeSandbox();
  loadRowLayers(ctx);
  const H = 512, fontSize = 128, lineY0 = 302, lineHeight = 133, scale = 0.74;
  const mask = {
    height: H, fontSize, lineY0, lineHeight, lineCount: 2,
    entries: [{ scale }, { scale }],
  };
  const band = ctx.lyricRowFillBandForMaskLine(mask, 0);
  assert.ok(band, '两行 mask 必须给出填充带');
  assert.ok(band.min > 0 && band.min < 1);
  assert.strictEqual(band.max, 1, '第 0 行之上没有内容, 上界可取满');
  assert.ok(band.feather > 0 && band.feather <= 0.02);

  // 独立字体度量 (不引用实现里的 0.92/0.26 系数): CJK 墨迹约 [-0.88fs, +0.22fs]
  const fs0 = fontSize * scale;
  const baseline0 = lineY0, baseline1 = lineY0 + lineHeight;
  const inkBottom0 = baseline0 + 0.22 * fs0;
  const inkTop1 = baseline1 - 0.88 * fs0;
  const toUv = (y) => 1 - y / H;
  const activeMin = band.min - band.feather;   // 填充带真正开始生效的位置
  assert.ok(toUv(inkBottom0) >= activeMin, 'bg 原文最低墨迹必须落在填充带内 (不能被裁): ' + toUv(inkBottom0) + ' vs ' + activeMin);
  assert.ok(toUv(inkTop1) <= activeMin, 'bg 译文最高墨迹必须落在填充带外 (不能跟着高亮): ' + toUv(inkTop1) + ' vs ' + activeMin);
  assert.ok(activeMin - toUv(inkTop1) > 0.005, '分界与下一行墨迹之间必须留有余量');

  // 单行 mask (bg 无译文) / 后面没有更多行 -> 不需要填充带
  assert.strictEqual(ctx.lyricRowFillBandForMaskLine({ ...mask, lineCount: 1, entries: [{ scale }] }, 0), null);
  assert.strictEqual(ctx.lyricRowFillBandForMaskLine(mask, 1), null);
  assert.strictEqual(ctx.lyricRowFillBandForMaskLine({ height: 512, fontSize: 128, lineY0: 302, lineHeight: 133, lineCount: 2 }, 0) === null, false, '缺少 entries 时按默认 scale 计算, 仍应给出带宽');
});

// ------------------------------------------------------------
// TEST 18-D: 逐帧驱动 —— 只有"父行是当前行"的 bg 行高亮; 主歌词/译文行为不变
// ------------------------------------------------------------
test('TEST 18-D: bg 行逐字高亮只跟随父行; 主歌词高亮与译文静态行为完全不变', () => {
  const ctx = makeSandbox();
  ctx.lyricTextureClarityScale = () => 1;
  ctx.lyricVerticalFloatEnabled = () => false;
  ctx.lyricQualityPoolBudgetBytes = () => 32 * 1024 * 1024;
  loadRowLayers(ctx);
  ctx.fx = { lyricDisplayMode: 'cinema', lyricTranslationMode: 'current' };
  ctx.lyricsLines = [
    { t: 0, duration: 4, text: 'A', translation: '甲' },
    { t: 4, duration: 4, text: 'B', translation: '乙', background: 'bgB' },
    { t: 8, duration: 4, text: 'C', translation: '丙', background: 'bgC' },
    { t: 12, duration: 4, text: 'D' },
  ];
  const mkMesh = () => ({ position: { x: 0, y: 0, z: 0 }, scale: { x: 1, setScalar(v) { this.x = v; } }, renderOrder: 0, visible: true, material: { transparent: true, blending: 1 } });
  const mkMat = () => ({ uniforms: { uOpacity: { value: 0 }, uProgress: { value: 0 }, uActiveMix: { value: 0 }, uFillBand: { value: 0 } } });
  const mkRow = (o) => Object.assign({
    mesh: mkMesh(), mat: mkMat(), targetAlpha: 1, baseY: 0, baseZ: 0, baseScale: 1, fontScale: 1,
    renderLineUploaded: true, renderWindowActive: false, renderRevealAt: 0,
    readability: null, readabilityMat: null, glow: null, glowMat: null,
    isPrimary: true, isTranslation: false, isBackground: false, parentRole: '', delta: 0,
  }, o);

  const p1 = ctx.lyricPrimaryVirtualIndex(1);
  const p2 = ctx.lyricPrimaryVirtualIndex(2);
  const bgGap = ctx.lyricBackgroundGapValue();
  const mainRow = mkRow({ text: 'B', lineIndex: 1, virtualIndex: p1 });
  const bgCurrent = mkRow({ text: 'bgB', lineIndex: null, parentIndex: 1, isBackground: true, parentRole: 'current', virtualIndex: p1 + bgGap });
  const bgOther = mkRow({ text: 'bgC', lineIndex: null, parentIndex: 2, isBackground: true, parentRole: 'context', virtualIndex: p2 + bgGap });
  const translationRow = mkRow({ text: '乙', lineIndex: null, parentIndex: 1, isTranslation: true, isPrimary: false, parentRole: 'current', virtualIndex: p1 + ctx.lyricTranslationVisualGapValue() });
  const data = {
    rowLayers: [mainRow, translationRow, bgCurrent, bgOther], usesTrack: true, displayMode: 'cinema',
    rowLayerGroup: { renderOrder: 0 }, contextGroup: { renderOrder: 0 }, readabilityGroup: { renderOrder: 0 },
    lineWorldStep: 0.5, translationLineStepWorld: 0.4, trackVisibleRadius: 3,
    trackTargetLineIndex: 1, trackTargetVirtualIndex: p1, trackScrollOffset: p1,
    trackPersistent: true, trackScrollPrimed: true, renderInitialTextReady: true,
  };
  const frame = (progress, lineIndex, virtualIndex) => ctx.updateLyricRowLayers(data, {
    opacity: 1, renderBase: 43, time: 1, targetLineIndex: lineIndex, targetVirtualIndex: virtualIndex,
    shownProgress: progress, deltaTime: 1 / 60,
  });

  frame(0.42, 1, p1);
  // 主歌词: 完全不变 (uProgress = 当前进度, uActiveMix 以 0.34 缓动)
  assert.strictEqual(mainRow.mat.uniforms.uProgress.value, 0.42, '主歌词逐字进度不得改变');
  assert.ok(Math.abs(mainRow.mat.uniforms.uActiveMix.value - 0.34) < 1e-9, '主歌词 activeMix 缓动系数不得改变');
  // bg 行 (父行 = 当前行): 跟随同一份进度; activeMix 缓动到 1 => 真正高亮
  assert.strictEqual(bgCurrent.mat.uniforms.uProgress.value, 0.42, 'bg 行复用当前行的逐字进度');
  assert.ok(Math.abs(bgCurrent.mat.uniforms.uActiveMix.value - 0.62) < 1e-9, 'bg 行高亮必须被打开');
  // bg 行 (父行不是当前行): 进度存在但不进入高亮 (activeMix = 0)
  assert.strictEqual(bgOther.mat.uniforms.uProgress.value, 0.42);
  assert.strictEqual(bgOther.mat.uniforms.uActiveMix.value, 0, '父行不是当前行时 bg 行不得高亮');
  // 译文行: 仍然是静态 (不高亮)
  assert.strictEqual(translationRow.mat.uniforms.uProgress.value, 0, '译文行不得参与逐字高亮');
  assert.strictEqual(translationRow.mat.uniforms.uActiveMix.value, 0);
  // bg 行自身仍然不是"当前主行": 位移/层序口径不变
  assert.strictEqual(bgCurrent.isActive, false, 'bg 行不得被当作当前主行');
  assert.ok(Math.abs(bgCurrent.mesh.renderOrder - 42.395) < 1e-9, 'bg 行层序必须仍是 renderBase - 0.605');

  for (let k = 0; k < 90; k += 1) frame(0.42, 1, p1);
  assert.ok(bgCurrent.mat.uniforms.uActiveMix.value > 0.99, 'bg 高亮必须收敛到 1');
  assert.strictEqual(bgOther.mat.uniforms.uActiveMix.value, 0, '其它 bg 行始终不高亮');
  assert.ok(mainRow.mat.uniforms.uActiveMix.value > 0.99);

  // 切到下一行: bg 行高亮淡出; 进度仍跟随当前行 (不会因为归零而整行闪亮)
  for (let k = 0; k < 90; k += 1) frame(0.05, 2, p2);
  assert.ok(bgCurrent.mat.uniforms.uActiveMix.value < 0.015, '父行不再是当前行时 bg 高亮必须关闭: ' + bgCurrent.mat.uniforms.uActiveMix.value);
  assert.strictEqual(bgCurrent.mat.uniforms.uProgress.value, 0.05);
  assert.ok(bgOther.mat.uniforms.uActiveMix.value > 0.99, '新的当前行 bg 必须高亮');

  // 静态守卫: 高亮开关只作用于材质 uniforms, 且主歌词/译文公式逐字未变
  const src = readFileIn('public', 'js', 'modules', '02-visual', '12-lyrics-row-layers.js');
  assert.match(src, /var bgHighlightActive = !!row\.isBackground && \(/);
  assert.match(src, /row\.mat\.uniforms\.uActiveMix\.value \+= \(activeMixTarget - row\.mat\.uniforms\.uActiveMix\.value\) \* \(isActive \? 0\.34 : 0\.62\);/);
  assert.match(src, /var activeMixTarget = \(isActive \|\| bgHighlightActive\) \? 1 : 0;/);
  assert.match(src, /if \(activeMixTarget < 0\.5 && row\.mat\.uniforms\.uActiveMix\.value < 0\.015\)/);
  assert.match(src, /row\.mat\.uniforms\.uProgress\.value = \(isActive \|\| row\.isBackground\) \? shownProgress : 0;/);
  assert.ok(!/row\.isActive = isActive \|\| bgHighlightActive/.test(src), 'bg 高亮不得改变 row.isActive');
});

// ------------------------------------------------------------
// TEST 19-A: 显示层去括号的规则 (保守: 只去最外层成对括号)
// ------------------------------------------------------------
test('TEST 19-A: BG 显示文本去括号规则', () => {
  const ctx = makeSandbox();
  loadVisual(ctx);
  const strip = ctx.stripLyricBackgroundWrapperText;
  assert.strictEqual(typeof strip, 'function');
  // 去掉最外层一对 (半角 / 全角)
  assert.strictEqual(strip("('Cause of me, baby)"), "'Cause of me, baby");
  assert.strictEqual(strip('(Don\'t you waste)'), "Don't you waste");
  assert.strictEqual(strip('（打回来告诉你）'), '打回来告诉你');
  assert.strictEqual(strip('(打回来告诉你)'), '打回来告诉你');
  // 只去最外层一层, 内层括号属于正文
  assert.strictEqual(strip('((a))'), '(a)');
  assert.strictEqual(strip('(Hold on (hold on))'), 'Hold on (hold on)');
  // 同一行多个 x-bg 被上游合并成 "(A) (B)": 每段各自成对时才逐段去掉
  assert.strictEqual(strip('(a) (b)'), 'a b');
  assert.strictEqual(strip('(a) (b) (c)'), 'a b c');
  assert.strictEqual(strip('(Oh) baby'), '(Oh) baby', '只有部分片段带括号时必须原样保留');
  assert.strictEqual(strip('Hello (world)'), 'Hello (world)', '正文内部的括号不得删除');
  assert.strictEqual(strip('a (b'), 'a (b', '不成对时不得猜测');
  assert.strictEqual(strip('(a))'), '(a))', '括号不配平必须原样保留');
  assert.strictEqual(strip('()'), '()', '空括号不得变成空文本');
  assert.strictEqual(strip('（a)'), '（a)', '半角/全角混用不得处理');
  assert.strictEqual(strip('' ), '');
  assert.strictEqual(strip(null), '');
  // 不是 BG 的文本不经过这里: 主歌词 entry 文本保持原样
  const applied = ctx.applyLyricBackgroundEntriesToTrackEntries([
    { text: '(not bg, main lyric)', role: 'current', alpha: 1, scale: 1, lineIndex: 0, background: '(Ah)' },
  ], 0, 24);
  assert.strictEqual(applied.entries[0].text, '(not bg, main lyric)', '主歌词文本不得被去括号');
  assert.strictEqual(applied.entries[1].text, 'Ah', 'bg 附属行显示文本必须去括号');
});

// ------------------------------------------------------------
// TEST 19-B: payload 层去括号, 但原始歌词数据 (parser/cache/lyricsLines) 保持带括号
// ------------------------------------------------------------
test('TEST 19-B: 只改显示文本, 原始 bg 数据与主歌词数据保持原样', () => {
  const ctx = makeSandbox();
  loadVisual(ctx);
  const parent = {
    text: 'I wanna fuck you slow with the lights on', role: 'current', lineIndex: 12,
    background: "('Cause of me, baby)", backgroundTranslation: '（因为我，宝贝）',
  };
  const snapshot = JSON.parse(JSON.stringify(parent));
  const bgEntry = ctx.makeStageLyricBackgroundEntry(parent);
  assert.strictEqual(bgEntry.text, "'Cause of me, baby");
  assert.strictEqual(bgEntry.translation, '因为我，宝贝');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(parent)), snapshot, '父行 entry 不得被修改');
  // bg 身份仍只由数据字段决定: 没有 background 就不会生成 bg 行 (括号不参与判断)
  assert.strictEqual(ctx.makeStageLyricBackgroundEntry({ text: '(looks like bg)', role: 'current', lineIndex: 1 }), null);
  assert.strictEqual(ctx.makeStageLyricBackgroundEntry({ text: 'no parens', role: 'current', lineIndex: 1, background: 'no parens' }).text, 'no parens');

  // parser / 原始行数据: 括号必须保留
  const ctx2 = makeSandbox();
  loadParse(ctx2);
  const lines = [{ t: 1, duration: 3, text: 'lead', words: [], charCount: 4 }];
  const backgrounds = ctx2.normalizeLyricBackgroundEntries([
    { t: 1.2, duration: 0.5, text: "('Cause of me, baby)", words: [], standalone: false, parentT: 1, translation: '（因为我）' },
  ]);
  const out = ctx2.attachLyricBackgrounds(lines, backgrounds);
  assert.strictEqual(out[0].background, "('Cause of me, baby)", '原始 bg 原文必须保留括号');
  assert.strictEqual(out[0].backgroundTranslation, '（因为我）', '原始 bg 译文必须保留括号');
  assert.strictEqual(out[0].text, 'lead', '主歌词不得被动');
  // 独立成行的 bg (role=x-bg) 原始文本同样保留括号
  const alone = ctx2.attachLyricBackgrounds([{ t: 5, duration: 2, text: 'tail', words: [], charCount: 4 }], ctx2.normalizeLyricBackgroundEntries([
    { t: 9, duration: 1, text: '(lonely bg)', words: [], standalone: true, parentT: 9 },
  ]));
  const standalone = alone.find((l) => l.role === 'x-bg');
  assert.strictEqual(standalone.text, '(lonely bg)', '独立 bg 行的原始文本必须保留括号');

  // 显示层: 独立 bg 行在渲染 entry 里才去括号, 且必须只在 isBackgroundLine 分支
  const stageSrc = readFileIn('public', 'js', 'modules', '02-visual', '14-stage-lyrics-rendering.js');
  assert.match(stageSrc, /if \(isBackgroundLine\) text = stripLyricBackgroundWrapperText\(text\);/);
  assert.match(stageSrc, /var isBackgroundLine = !!\(line && line\.role === 'x-bg'\);/);
  // 解析/provider/cache 侧不得包含显示层函数 (数据不变)
  ['apple-music-web-lyrics.js', 'apple-music-api.js', path.join('public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js')].forEach((rel) => {
    const src = readFileIn(...rel.split(/[\\/]/));
    assert.ok(!src.includes('stripLyricBackgroundWrapperText'), rel + ' 不得包含显示层去括号函数 (数据层必须保持原样)');
  });
  // 桌面歌词窗口: bg 原文/译文都走同一个显示层函数
  const shellSrc = readFileIn('public', 'js', 'modules', '10-shell', '04-desktop-overlay-fullscreen.js');
  assert.match(shellSrc, /textBg: stripLyricBackgroundWrapperText\(curLine\.background \|\| ''\)/);
  assert.match(shellSrc, /textBgTranslation: stripLyricBackgroundWrapperText\(curLine\.backgroundTranslation \|\| ''\)/);
});

// ------------------------------------------------------------
// TEST 20: Apple Music 凭证页面排版 (固定标题 / 可滚动内容 / 固定 footer / 按钮同行)
// ------------------------------------------------------------
test('TEST 20: 凭证页面排版固定, 说明文字整行宽, 两个凭证按钮同行, footer 不被挤出', () => {
  const html = readFileIn('desktop', 'lyrics-source-window.html');
  const js = readFileIn('desktop', 'lyrics-source-window.js');

  function cssBlock(selector) {
    const start = html.indexOf(selector + ' {');
    assert.ok(start >= 0, '缺少 CSS 规则: ' + selector);
    const end = html.indexOf('}', start);
    return html.slice(start, end + 1);
  }
  // 1) 三段式布局: 固定标题 + 唯一可滚动内容 + 固定 footer
  const bodyCss = cssBlock('.body');
  assert.match(bodyCss, /flex: 1 1 auto/);
  assert.match(bodyCss, /min-height: 0/, '内容区必须允许收缩 (否则会把 footer 挤出可视区)');
  assert.match(bodyCss, /overflow-y: auto/, '内容区必须自己滚动');
  const footCss = cssBlock('.foot');
  assert.match(footCss, /flex: 0 0 auto/, 'footer 必须固定高度、不被压缩');
  const titleCss = cssBlock('.titlebar');
  assert.match(titleCss, /flex: 0 0 auto/);
  assert.match(html, /body \{ display: flex; flex-direction: column; height: 100vh; \}/);

  // 2) 说明文字整行宽: .way 不再用 flex 行把文字压窄
  const wayCss = cssBlock('.way');
  assert.ok(!/display:\s*flex/.test(wayCss), '.way 不得再用 flex 行布局 (否则说明文字被压成窄列)');
  assert.ok(!/justify-content/.test(wayCss));
  assert.match(html, /<div class="way-head">/, '名称/标签单独一行');
  const descCss = cssBlock('.way-desc');
  assert.ok(!/width:\s*\d+px/.test(descCss), '说明文字不得被固定成窄列');

  // 3) 自动获取按钮独立一行; 手动导入 Token + 删除凭证 仍必须同行
  const actionsCss = cssBlock('.way-actions');
  assert.match(actionsCss, /display: flex/);
  assert.match(actionsCss, /justify-content: flex-end/);
  assert.match(actionsCss, /flex-wrap: wrap/);
  const actionBlocks = html.match(/<div class="way-actions"[^>]*>[\s\S]*?<\/div>/g) || [];
  assert.ok(actionBlocks.length >= 2, '登录按钮与手动导入/删除按钮必须各自独立成行');
  const loginBlock = actionBlocks.filter((b) => b.indexOf('id="cred-login"') >= 0)[0];
  const manualBlock = actionBlocks.filter((b) => b.indexOf('id="cred-import"') >= 0)[0];
  assert.ok(loginBlock, '必须存在"登录 Apple Music 获取 Token"操作行');
  assert.match(loginBlock, /id="cred-login"/);
  assert.ok(manualBlock, '必须存在手动导入操作行');
  assert.match(manualBlock, /id="cred-import"/);
  assert.ok(manualBlock.indexOf('id="cred-clear"') > manualBlock.indexOf('id="cred-import"'), '手动导入 Token 与 删除凭证 必须同处一行');
  assert.ok(loginBlock.indexOf('id="cred-import"') < 0, '登录按钮不得与手动导入混排 (窄窗口会拆行)');

  // 4) 凭证功能与 DOM 契约不变 (JS 无需改动即可工作)
  ['close', 'list', 'research', 'done', 'cred-state', 'cred-login-row', 'cred-login', 'cred-login-modal', 'cred-import', 'cred-clear', 'cred-modal', 'cred-modal-title', 'cred-input', 'cred-tip', 'cred-save', 'cred-cancel'].forEach((id) => {
    const count = (html.match(new RegExp('id="' + id + '"', 'g')) || []).length;
    assert.strictEqual(count, 1, 'id=' + id + ' 必须恰好出现一次, 实际 ' + count);
  });
  assert.match(html, /id="cred-input" type="password"/, 'token 输入框必须仍是 password 且只在弹窗里');
  assert.match(html, /<div class="modal-mask" id="cred-modal" hidden>/, '凭证弹窗结构不变');
  // JS: 仍然是"只显示是否已配置"; 不新增凭证字段 / 不直接碰 IPC 与存储
  assert.match(js, /window\.appleMusicLyricsCredential/);
  assert.match(js, /api\.getStatus/);
  assert.match(js, /api\.set\(token\)/);
  assert.match(js, /api\.clear\(\)/);
  assert.match(js, /importBtn\.textContent = configured \? '重新获取 Token' : '手动导入 Token';/);
  assert.match(js, /api\.loginWithAppleMusic/, '必须调用主进程登录获取 Token 入口');
  // 已获取 token 时内联不再显示"登录获取"入口 (改到"重新获取"弹窗内)
  assert.match(html, /<div class="way-actions" id="cred-login-row">/);
  assert.match(js, /if \(loginRow\) loginRow\.hidden = configured;/, '已配置时必须隐藏内联登录入口');
  assert.match(html, /\.way-actions\[hidden\] \{ display: none; \}/, '[hidden] 必须真正隐藏操作行 (否则 display:flex 会覆盖它)');
  assert.match(js, /if \(loginBtn\) loginBtn\.addEventListener\('click', function \(\) \{ loginWithAppleMusic\(false\); \}\);/, '内联登录按钮必须接线');
  // "重新获取"弹窗: 标题随状态切换 + 内含自动获取入口
  assert.match(html, /<div class="modal-title" id="cred-modal-title">/);
  assert.match(html, /<button class="mini-btn" id="cred-login-modal">登录 Apple Music 获取 Token<\/button>/);
  assert.match(js, /modalTitleEl\.textContent = credentialConfigured \? '重新获取 Apple Music 歌词凭证' : '导入 Apple Music 歌词凭证';/);
  assert.match(js, /if \(loginModalBtn\) loginModalBtn\.addEventListener\('click', function \(\) \{ loginWithAppleMusic\(true\); \}\);/, '弹窗登录按钮必须接线');
  assert.match(js, /clearBtn\.hidden = !configured;/);
  assert.ok(!/ipcRenderer|safeStorage|require\(/.test(js), '凭证逻辑不得直接触达 IPC/存储');
  assert.ok(!/tokenPlain|rawToken|mediaUserToken/.test(js), '不得新增凭证字段/明文');
  // 结构完整性
  const open = (html.match(/<div/g) || []).length;
  const close = (html.match(/<\/div>/g) || []).length;
  assert.strictEqual(open, close, 'div 标签必须配对');
  assert.ok(!/x-bg|backgroundTranslation/.test(html + js), '凭证页面不得引用 bg 渲染概念');
});
