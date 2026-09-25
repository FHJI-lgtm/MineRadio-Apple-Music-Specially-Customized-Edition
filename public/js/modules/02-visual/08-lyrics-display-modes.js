var STAGE_LYRIC_MAX_LINES = 1;
var STAGE_LYRIC_DISPLAY_MODES = { single: 1, dual: 1, triple: 1, cinema: 1, custom: 1 };
var STAGE_LYRIC_TRANSLATION_MODES = { off: 1, current: 1, dual: 1, multi: 1 };
var STAGE_LYRIC_MOTION_STYLES = { glass: 1, smooth: 1, float: 1, quick: 1, shine: 1, glitch: 1 };

function normalizeLyricDisplayMode(mode) {
  mode = String(mode || 'single');
  return STAGE_LYRIC_DISPLAY_MODES[mode] ? mode : 'single';
}
function normalizeLyricTranslationMode(mode) {
  mode = String(mode || 'off');
  return STAGE_LYRIC_TRANSLATION_MODES[mode] ? mode : 'off';
}
function lyricCustomLineCountValue() {
  var raw = fx && fx.lyricCustomLineCount != null ? Number(fx.lyricCustomLineCount) : fxDefaults.lyricCustomLineCount;
  if (!isFinite(raw)) raw = fxDefaults.lyricCustomLineCount;
  return clampRange(Math.round(raw), 1, 10);
}
function lyricDisplayLineCountForMode(mode) {
  mode = normalizeLyricDisplayMode(mode);
  if (mode === 'single') return 1;
  if (mode === 'dual') return 2;
  if (mode === 'triple') return 3;
  if (mode === 'cinema') return 5;
  return lyricCustomLineCountValue();
}
function lyricDisplayOffsetsForMode(mode) {
  mode = normalizeLyricDisplayMode(mode);
  if (mode === 'single') return [0];
  if (mode === 'dual') return [0, 1];
  var count = lyricDisplayLineCountForMode(mode);
  var activeSlot = Math.floor(count / 2);
  var offsets = [];
  for (var i = 0; i < count; i++) offsets.push(i - activeSlot);
  return offsets;
}
function normalizeLyricMotionStyle(style) {
  style = String(style || 'float');
  return STAGE_LYRIC_MOTION_STYLES[style] ? style : 'float';
}
function lyricContextOpacityValue() {
  return clampRange(fx && fx.lyricContextOpacity == null ? fxDefaults.lyricContextOpacity : Number(fx && fx.lyricContextOpacity), 0.25, 1);
}
function lyricContextSpreadValue() {
  return clampRange(fx && fx.lyricContextSpread == null ? fxDefaults.lyricContextSpread : Number(fx && fx.lyricContextSpread), 0.60, 2.40);
}
function lyricTranslationGapValue() {
  return clampRange(fx && fx.lyricTranslationGap == null ? fxDefaults.lyricTranslationGap : Number(fx && fx.lyricTranslationGap), 0.28, 2.20);
}
function lyricTranslationVisualGapValue() {
  var gap = lyricTranslationGapValue();
  var scale = lyricTranslationScaleValue();
  return clampRange(0.98 + (gap - 0.28) * 0.36 + Math.max(0, scale - 0.66) * 0.12, 0.92, 2.20);
}
function lyricTranslationLayoutActive() {
  return normalizeLyricTranslationMode(fx && fx.lyricTranslationMode) !== 'off';
}
function lyricPrimarySlotStepValue() {
  if (!lyricTranslationLayoutActive()) return 1;
  return clampRange(lyricTranslationVisualGapValue() + 0.82 + lyricTranslationScaleValue() * 0.14, 1.78, 2.88);
}
function lyricLineHasTranslationAt(index) {
  if (!lyricTranslationLayoutActive()) return false;
  var n = Math.max(0, Math.round(Number(index) || 0));
  return !!lyricLineTranslationTextAt(n);
}
// 背景人声额外"容器"间距 (仅当上一主行自身带 bg 时, 加到该 pair 上)。
// 单位与槽位步进一致 (1 = 一个 lineWorldStep), 因此世界间距 = 该值 * lineWorldStep。
//
// 真机实测 (lineWorldStep=0.3675, baseSlotStep=2.1214, bgGap=0.7504, 61.2px/世界单位):
//   第一轮 0.50 -> A→B 由 1.062 增到 1.239 世界, bg 每侧净空仅 +0.092 世界 (≈5.6px),
//   用户真机截图仍见 bg 译文与下一主行重叠 (残差 ≈0.15 世界 ≈9px)。
//   bg 行是"原文+译文"两行 (plane 1.14 世界高), 要让它与下一主行完全分开,
//   每侧需要 ≈0.195 世界 -> extra ≈ 2*0.195/0.3675 ≈ 1.05; 为留余量本轮取 1.15
//   (每侧净空 +0.211 世界 ≈13px, A→B ≈1.49 世界)。
// 这是**逐 pair** 的局部间距: 连续多个 bg 行只会在各自 pair 上增加, 不会全局累加。
function lyricBackgroundExtraGapValue() { return 1.15; }
function lyricLineSlotStepValue(index) {
  var n = Math.round(Number(index) || 0);
  // 该行(或下一行)带背景人声时, 需要为其附属行留出空隙, 避免压到下一行主歌词
  var needsBackgroundSlot = lyricLineHasBackgroundAt(n) || (n >= 0 && lyricLineHasBackgroundAt(n + 1));
  var step = 1;
  if (lyricTranslationLayoutActive()) {
    var needsTranslationSlot = lyricLineHasTranslationAt(n) || (n >= 0 && lyricLineHasTranslationAt(n + 1));
    step = needsTranslationSlot ? lyricPrimarySlotStepValue() : clampRange(1.04 + (lyricContextSpreadValue() - 1) * 0.10, 0.96, 1.24);
  }
  var total = needsBackgroundSlot ? step + lyricBackgroundGapValue() : step;
  // 仅当**本行自身**带 bg 时, 为本行与其下一主行之间的 pair 再扩大容器 (pair-wise, 不累积)
  if (lyricLineHasBackgroundAt(n)) total += lyricBackgroundExtraGapValue();
  return total;
}
var lyricPrimaryVirtualPrefixCache = { key: '', values: [0] };
function lyricPrimaryVirtualPrefixKey() {
  var first = lyricsLines && lyricsLines[0];
  var last = lyricsLines && lyricsLines.length ? lyricsLines[lyricsLines.length - 1] : null;
  return [
    lyricTranslationLayoutActive() ? 1 : 0,
    Math.round(lyricBackgroundGapValue() * 1000),
    Math.round(lyricBackgroundExtraGapValue() * 1000),
    lyricBackgroundSignature(),
    Math.round(lyricTranslationGapValue() * 1000),
    Math.round(lyricTranslationScaleValue() * 1000),
    Math.round(lyricContextSpreadValue() * 1000),
    lyricsLines ? lyricsLines.length : 0,
    lyricsTranslationLines ? lyricsTranslationLines.length : 0,
    first ? normalizeLyricTranslationText(first.translation).slice(0, 12) : '',
    last ? normalizeLyricTranslationText(last.translation).slice(0, 12) : ''
  ].join('|');
}
function lyricPrimaryVirtualIndex(index) {
  var n = Math.round(Number(index) || 0);
  if (!isFinite(n) || n === 0) return 0;
  // 无翻译布局且整首没有背景人声: 完全保持既有行为 (旧 provider 零影响)
  if (!lyricTranslationLayoutActive() && !lyricLyricsHaveBackground()) return n;
  if (n < 0) return n * lyricPrimarySlotStepValue();
  var key = lyricPrimaryVirtualPrefixKey();
  if (!lyricPrimaryVirtualPrefixCache || lyricPrimaryVirtualPrefixCache.key !== key) {
    lyricPrimaryVirtualPrefixCache = { key: key, values: [0] };
  }
  var values = lyricPrimaryVirtualPrefixCache.values;
  for (var i = values.length; i <= n; i++) values[i] = values[i - 1] + lyricLineSlotStepValue(i - 1);
  return values[n] || 0;
}
function lyricTranslationVirtualIndex(parentIndex) {
  return lyricPrimaryVirtualIndex(parentIndex) + lyricTranslationVisualGapValue();
}
// ---- 背景人声 (ttm:role="x-bg"): 主行下方的附属视觉行 ----
// 视觉: 字号约主歌词 74%, 不透明度约 58%, 明显弱于主歌词但可辨识
function lyricBackgroundOpacityValue() { return 0.58; }
function lyricBackgroundScaleValue() { return 0.74; }
function lyricBackgroundGapValue() { return clampRange(lyricTranslationVisualGapValue() * 0.62, 0.32, 0.86); }
function lyricLineHasBackgroundAt(index) {
  var line = lyricsLines && lyricsLines[index];
  return !!(line && line.background);
}
// 整首是否有背景人声 (缓存: lyricsLines 换新数组才重算), 用于让无 bg 的歌曲完全走旧路径
var lyricBackgroundSignatureCache = { arr: null, value: '' };
function lyricBackgroundSignature() {
  if (lyricBackgroundSignatureCache.arr === lyricsLines) return lyricBackgroundSignatureCache.value;
  var lines = lyricsLines || [];
  var bits = '';
  for (var i = 0; i < lines.length; i++) bits += (lines[i] && lines[i].background) ? '1' : '0';
  lyricBackgroundSignatureCache = { arr: lyricsLines, value: bits };
  return bits;
}
function lyricLyricsHaveBackground() {
  var bits = lyricBackgroundSignature();
  return bits.indexOf('1') >= 0;
}
function lyricBackgroundVirtualIndex(parentIndex) {
  return lyricPrimaryVirtualIndex(parentIndex) + lyricBackgroundGapValue();
}
function lyricTranslationScaleValue() {
  return clampRange(fx && fx.lyricTranslationScale == null ? fxDefaults.lyricTranslationScale : Number(fx && fx.lyricTranslationScale), 0.46, 1.12);
}
function lyricTranslationOpacityValue() {
  return clampRange(fx && fx.lyricTranslationOpacity == null ? fxDefaults.lyricTranslationOpacity : Number(fx && fx.lyricTranslationOpacity), 0.20, 1);
}
function lyricEdgeFadeValue() {
  return clampRange(fx && fx.lyricEdgeFade == null ? fxDefaults.lyricEdgeFade : Number(fx && fx.lyricEdgeFade), 0, 1);
}
function lyricMotionSoftnessValue() {
  return clampRange(fx && fx.lyricMotionSoftness == null ? fxDefaults.lyricMotionSoftness : Number(fx && fx.lyricMotionSoftness), 0.15, 1.2);
}
function lyricGlitchIntensityValue() {
  return clampRange(fx && fx.lyricGlitchIntensity == null ? fxDefaults.lyricGlitchIntensity : Number(fx && fx.lyricGlitchIntensity), 0, 1.5);
}
function lyricGlitchSliceValue() {
  return clampRange(fx && fx.lyricGlitchSlice == null ? fxDefaults.lyricGlitchSlice : Number(fx && fx.lyricGlitchSlice), 0, 1.4);
}
function lyricGlitchChromaValue() {
  return clampRange(fx && fx.lyricGlitchChroma == null ? fxDefaults.lyricGlitchChroma : Number(fx && fx.lyricGlitchChroma), 0, 1.6);
}
function lyricGlitchRateValue() {
  return clampRange(fx && fx.lyricGlitchRate == null ? fxDefaults.lyricGlitchRate : Number(fx && fx.lyricGlitchRate), 0.45, 2.2);
}
function lyricGlitchJitterValue() {
  return clampRange(fx && fx.lyricGlitchJitter == null ? fxDefaults.lyricGlitchJitter : Number(fx && fx.lyricGlitchJitter), 0, 1.8);
}
function lyricMotionProfile() {
  var style = normalizeLyricMotionStyle(fx && fx.lyricMotionStyle);
  var soft = lyricMotionSoftnessValue();
  var profile = {
    style: style,
    enter: 0.54,
    exit: 0.46,
    slide: 0.34,
    progressEase: lyricsHasNativeKaraoke ? 0.34 : 0.18,
    contextDrift: 0.060,
    edgeBoost: 1.0,
    sweep: 0.62,
    shimmer: 0.24,
    glitch: 0.0,
    glitchSlice: 0.0,
    glitchChroma: 0.0,
    glitchRate: 1.0,
    glitchJitter: 0.0,
    glitchCameraBind: false,
    glowLift: 1.0,
    floatAmp: 1.0
  };
  if (style === 'smooth') {
    profile.enter = 0.72; profile.exit = 0.62; profile.slide = 0.24; profile.progressEase *= 0.72; profile.contextDrift = 0.030; profile.edgeBoost = 0.62; profile.sweep = 0.18; profile.shimmer = 0.05; profile.glowLift = 0.74; profile.floatAmp = 0.55;
  } else if (style === 'float') {
    profile.enter = 0.86; profile.exit = 0.76; profile.slide = 0.54; profile.progressEase *= 0.66; profile.contextDrift = 0.120; profile.edgeBoost = 1.04; profile.sweep = 0.36; profile.shimmer = 0.14; profile.glowLift = 1.16; profile.floatAmp = 1.45;
  } else if (style === 'shine') {
    profile.enter = 0.50; profile.exit = 0.44; profile.slide = 0.34; profile.progressEase *= 1.02; profile.contextDrift = 0.052; profile.edgeBoost = 1.42; profile.sweep = 1.22; profile.shimmer = 0.34; profile.glowLift = 1.30; profile.floatAmp = 0.82;
  } else if (style === 'glitch') {
    profile.enter = 0.40; profile.exit = 0.36; profile.slide = 0.30; profile.progressEase *= 1.24; profile.contextDrift = 0.035; profile.edgeBoost = 1.18; profile.sweep = 0.54; profile.shimmer = 0.28; profile.glitch = lyricGlitchIntensityValue(); profile.glitchSlice = lyricGlitchSliceValue(); profile.glitchChroma = lyricGlitchChromaValue(); profile.glitchRate = lyricGlitchRateValue(); profile.glitchJitter = lyricGlitchJitterValue(); profile.glitchCameraBind = !!(fx && fx.lyricGlitchCameraBind); profile.glowLift = 1.08 + profile.glitch * 0.10; profile.floatAmp = 0.70;
  } else if (style === 'quick') {
    profile.enter = 0.36; profile.exit = 0.32; profile.slide = 0.22; profile.progressEase *= 1.34; profile.contextDrift = 0.034; profile.edgeBoost = 0.70; profile.sweep = 0.28; profile.shimmer = 0.10; profile.glowLift = 0.86; profile.floatAmp = 0.62;
  } else {
    profile.enter = 0.62; profile.exit = 0.52; profile.slide = 0.38; profile.progressEase *= 0.90; profile.contextDrift = 0.066; profile.edgeBoost = 1.18; profile.sweep = 0.72; profile.shimmer = 0.22; profile.glowLift = 1.0; profile.floatAmp = 1.0;
  }
  profile.enter *= soft;
  profile.exit *= soft;
  profile.slide *= clampRange(0.80 + soft * 0.35, 0.75, 1.28);
  profile.progressEase = clampRange(profile.progressEase / clampRange(soft, 0.35, 1.2), 0.08, 0.72);
  return profile;
}
