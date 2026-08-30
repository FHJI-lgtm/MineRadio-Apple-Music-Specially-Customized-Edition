// ============================================================
// 12-smtc/04-smtc-audio.js
// AudioAdapter — 外部音频进入视觉管线的唯一入口 (Phase 1)
//
// 输入 AudioMetrics {rms, bass, mid, treble}:
//   来源 A (Phase 1 测试): 内部假生成器, 正弦缓变 — 无 WASAPI / 无 IPC
//   来源 B (Phase 3, 默认休眠): WASAPI Process Loopback -> IPC
// 输出: 现有全局 frequencyData(Uint8Array 1024) / timeDomainData(Uint8Array 2048)
//
// 硬性规则:
//   * 所有数值必须通过 audioAdapterSanitize(): Number.isFinite() + 0..1 钳制
//   * 禁止 NaN / Infinity / undefined / null 进入视觉管线
//   * 只允许 frequencyData.set() / timeDomainData.set() — 绝不替换对象
//   * 每帧不创建新 TypedArray / Array (复用模块级 scratch buffer)
//   * 出错自动 disableExternalAudio() 并回退原有视觉 (SMTC/歌词/Stage 不受影响)
// ============================================================
var EXTERNAL_AUDIO_ENABLED = true;      // Phase 3: 真实外部音频 (native helper) 开启
var FAKE_AUDIO_METRICS_ENABLED = false; // Phase 1 假指标关闭 (外部真实数据已接入)
// 版本标记: 若 DevTools 里看不到这行, 说明渲染器没有在跑本文件 (旧打包 exe / 旧缓存)
console.log('[Audio] adapter build=PHASE3 EXTERNAL=' + EXTERNAL_AUDIO_ENABLED + ' FAKE=' + FAKE_AUDIO_METRICS_ENABLED);

var smtcAudioState = {
  active: false,
  mode: 'none',       // 'fake' | 'process-loopback' | 'system-mix-fallback'
  pid: 0,
  sourceName: '',
  rms: 0,
  bass: 0,
  mid: 0,
  treble: 0,
  spectrum: null,
  error: '',
  hr: '',
  updatedAt: 0,
};
var smtcAudioSubscribed = false;
var smtcAudioFallbackTimer = 0;
// scratch buffer: 与全局 frequencyData / timeDomainData 同尺寸, 只创建一次
var smtcAudioFreq = new Uint8Array(1024);
var smtcAudioTime = new Uint8Array(2048);
var smtcAudioSpectrum = new Array(64);
for (var smtcAudioSpectrumI = 0; smtcAudioSpectrumI < 64; smtcAudioSpectrumI++) smtcAudioSpectrum[smtcAudioSpectrumI] = 0;
var SMTC_AUDIO_FRESH_MS = 2500;

// ---- 数值卫生: 一切外部输入的必经之门 ----
function audioAdapterSanitize(v, fallback) {
  var n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---- 熔断: 出错时关闭 External Audio, 恢复原视觉 ----
function disableExternalAudio(reason) {
  var why = String(reason || 'external-audio-error').slice(0, 120);
  var wasOn = EXTERNAL_AUDIO_ENABLED || FAKE_AUDIO_METRICS_ENABLED || smtcAudioState.active;
  EXTERNAL_AUDIO_ENABLED = false;
  FAKE_AUDIO_METRICS_ENABLED = false;
  smtcAudioState.active = false;
  smtcAudioState.mode = 'none';
  smtcAudioState.error = 'disabled:' + why;
  smtcAudioState.updatedAt = Date.now();
  // 静默数据, 让粒子自然衰减 (不残留任何无效值)
  if (frequencyData && frequencyData.length) frequencyData.fill(0);
  if (timeDomainData && timeDomainData.length) timeDomainData.fill(128);
  if (wasOn) console.warn('[Audio][' + Date.now() + '] EXTERNAL AUDIO DISABLED (' + why + ')');
  // 尽力通知主进程停止捕获 (Phase 3 用; 当前开关下主进程不会 spawn)
  try {
    var api = window.desktopWindow;
    if (api && typeof api.stopSmtcAudio === 'function') api.stopSmtcAudio();
  } catch (_) {}
}

// ---- 是否在本帧提供外部音频帧 ----
function externalAudioActive() {
  // Phase 1: 假指标源 — 独立于 SMTC 会话; 内部播放器播放时让位
  if (FAKE_AUDIO_METRICS_ENABLED) return !internalAudioPlayingNow();
  // Phase 3: 真实外部音频 — 需要 SMTC 会话播放中且指标新鲜
  return smtcPlayerCfg.enabled !== false &&
    smtcStore.active === true &&
    smtcStore.isPlaying === true &&
    smtcAudioState.active === true &&
    !internalAudioPlayingNow() &&
    (Date.now() - smtcAudioState.updatedAt) < SMTC_AUDIO_FRESH_MS;
}

function smtcAudioActive() {
  return externalAudioActive();
}

function smtcAudioStatus() {
  if (FAKE_AUDIO_METRICS_ENABLED) return 'fake';
  if (!EXTERNAL_AUDIO_ENABLED) return 'disabled';
  if (smtcAudioState.error) return 'failed';
  if (!smtcAudioState.active) return 'none';
  return smtcAudioState.mode;
}

// ---- Phase 1 假指标生成器: 用户指定公式, 全部有限且在 [0,1] ----
function audioAdapterFakeMetrics(now) {
  var t = (Number(now) || Date.now()) / 1000;
  return {
    rms: 0.2 + 0.2 * Math.sin(t),
    bass: 0.4 + 0.4 * Math.sin(t * 2),
    mid: 0.3 + 0.3 * Math.sin(t * 3),
    treble: 0.2 + 0.2 * Math.sin(t * 5)
  };
}

// ---- 一次性诊断: 状态首次激活时打印 3 个采样 (t0 / +600ms / +1200ms),
//      证明假指标在变化、adapter 确实写入了全局数组 (不每帧打印) ----
var smtcDiagBurstDone = false;
var smtcDiagBurstTimers = [];
function smtcDiagBurst() {
  if (smtcDiagBurstDone) return;
  smtcDiagBurstDone = true;
  function sample(tag) {
    var m = audioAdapterFakeMetrics(Date.now());
    console.log('[FAKE AUDIO] ' + tag + ' active=true rms=' + m.rms.toFixed(3) +
      ' bass=' + m.bass.toFixed(3) + ' mid=' + m.mid.toFixed(3) + ' treble=' + m.treble.toFixed(3));
    console.log('[EXTERNAL AUDIO ADAPTER] ' + tag + ' active=true' +
      ' frequencyData[0]=' + (frequencyData ? frequencyData[0] : 'n/a') +
      ' frequencyData[100]=' + (frequencyData ? frequencyData[100] : 'n/a') +
      ' frequencyData[500]=' + (frequencyData ? frequencyData[500] : 'n/a') +
      ' timeDomainData[0]=' + (timeDomainData ? timeDomainData[0] : 'n/a'));
  }
  sample('t0');
  smtcDiagBurstTimers.push(setTimeout(function () { sample('t+600ms'); }, 600));
  smtcDiagBurstTimers.push(setTimeout(function () { sample('t+1200ms'); }, 1200));
}

// ---- 合成渲染: metrics -> frequencyData / timeDomainData (仅 .set()) ----
// [AUDIO-EXP] C/D 实验: 历史能量参考 + dB 压缩映射 (恢复被 native 瞬时峰值 AGC 抹掉的响度动态,
//   并让外部频谱刻度接近内部 Web Audio dB 字节) — 实验后可整体回滚本段
var smtcAudioRmsRef = 0.20;   // 历史 rms 峰值参考 (attack 快, release 慢, floor 防噪声放大)
function audioAdapterRenderFrame(metrics) {
  metrics = (metrics && typeof metrics === 'object') ? metrics : {};
  var rms = audioAdapterSanitize(metrics.rms, 0);
  var bass = audioAdapterSanitize(metrics.bass, 0);
  var mid = audioAdapterSanitize(metrics.mid, 0);
  var treble = audioAdapterSanitize(metrics.treble, 0);
  // [AUDIO-EXP-C] 历史能量参考: 不每帧瞬时归一化, 保留音乐动态范围
  //   attack 快 (立即跟踪上升), release 慢 (60fps ~4s 半衰期), floor 0.02
  if (rms > smtcAudioRmsRef) smtcAudioRmsRef = rms;
  else smtcAudioRmsRef *= 0.9971;
  if (smtcAudioRmsRef < 0.02) smtcAudioRmsRef = 0.02;
  // 响度因子: rms 接近历史峰值 → ~1; 安静段 → 小 (不无限放大噪声, 不破坏动态)
  var loudFactor = Math.min(1, rms / Math.max(0.015, smtcAudioRmsRef * 0.65));
  loudFactor = Math.pow(loudFactor, 0.7);
  var specScale = 0.22 + 0.78 * loudFactor;
  // 目标数组必须存在且同尺寸 — 不符即熔断, 绝不让异常进入视觉
  if (!frequencyData || frequencyData.length !== smtcAudioFreq.length ||
      !timeDomainData || timeDomainData.length !== smtcAudioTime.length) {
    disableExternalAudio('buffer-mismatch');
    return false;
  }
  // 64 段频谱: 优先使用外部真实 spectrum (helper FFT); 否则按频段合成
  var phase = (Date.now() % 10000) / 10000 * Math.PI * 2;
  var realSpec = Array.isArray(metrics.spectrum) && metrics.spectrum.length >= 16 ? metrics.spectrum : null;
  for (var b = 0; b < 64; b++) {
    var env;
    if (realSpec) {
      env = audioAdapterSanitize(realSpec[b], 0);
    } else {
      if (b < 15) env = bass;
      else if (b < 36) { var f1 = (b - 15) / 21; env = bass * (1 - f1) + mid * f1; }
      else { var f2 = (b - 36) / 28; env = mid * (1 - f2) + treble * f2; }
      env *= 0.78 + 0.22 * Math.sin(b * 0.9 + phase);
    }
    smtcAudioSpectrum[b] = env < 0 ? 0 : (env > 1 ? 1 : env);
  }
  // log 频段映射: 20Hz..20kHz -> 1024 bin (bin ≈ 21.5Hz @ 44.1k/2048)
  var half = smtcAudioFreq.length;   // 1024
  var sr = 44100, fftSize = 2048;
  var logMin = Math.log10(20), logMax = Math.log10(20000);
  for (var i = 0; i < half; i++) {
    var freq = i * sr / fftSize;
    if (freq < 20) { smtcAudioFreq[i] = 0; continue; }
    var pos = (Math.log10(Math.min(freq, 20000)) - logMin) / (logMax - logMin);
    var idx = pos * 63;
    var i0 = Math.floor(idx);
    var i1 = i0 + 1 < 64 ? i0 + 1 : 63;
    var frac = idx - i0;
    var v = smtcAudioSpectrum[i0] * (1 - frac) + smtcAudioSpectrum[i1] * frac;
    // 合成频谱才加轻微起伏; 真实频谱不加
    if (!realSpec) v *= 0.82 + 0.18 * Math.sin(i * 0.35 + phase * 1.7);
    // [AUDIO-EXP-D] dB 压缩映射 (与内部 Web Audio dB 字节同构, 参考 minDecibels/maxDecibels):
    //   相对峰值 -70dB..0dB → 0..255; 中高频由线性近零抬底到内部同量级
    var vAbs = v * specScale;
    var byte;
    if (freq < 420) {
      // [BEAT-DYNAMIC] 低频(kick/sub/body)动态保留: C+D dB 映射使 kick/sub 恒饱和 249-255
      //   -> beatBandRms 的 kick/sub/low 恒高位(≈1.0) -> beat 引擎 rise/flux 消失 -> external beatPulse 稀疏.
      //   低频改用幂压缩: 不硬饱和(峰值仍达 255), 保留帧间瞬态. 音域地形有自适应归一化(stats.floor/peakFloor
      //   基于 mean), 绝对量级被吸收 -> 视觉强度保持; beat 引擎的 rise/flux 恢复.
      var dyn = Math.min(1, Math.pow(vAbs, 0.55) * 1.06);
      byte = Math.round(dyn * 255);
    } else {
      var db = 20 * Math.log10(Math.max(1e-6, vAbs));
      byte = Math.round(Math.max(0, Math.min(1, (db + 70) / 70)) * 255);
    }
    smtcAudioFreq[i] = byte < 0 ? 0 : (byte > 255 ? 255 : byte);
  }
  // 合成时域: 主循环 RMS/能量依赖它
  var amp = rms * 0.85 + 0.06;
  for (var j = 0; j < smtcAudioTime.length; j++) {
    var tt = j / smtcAudioTime.length;
    var w = bass * Math.sin(2 * Math.PI * 1.3 * tt + phase) +
      mid * 0.6 * Math.sin(2 * Math.PI * 3.7 * tt + phase * 1.6) +
      treble * 0.4 * Math.sin(2 * Math.PI * 8.9 * tt + phase * 2.2);
    var val = 128 + w * amp * 127;
    smtcAudioTime[j] = val < 0 ? 0 : (val > 255 ? 255 : Math.round(val));
  }
  frequencyData.set(smtcAudioFreq);
  timeDomainData.set(smtcAudioTime);
  return true;
}

// ---- 每帧入口 (主循环调用) ----
function smtcAudioFillFrame() {
  if (!externalAudioActive()) {
    // 暂停/会话丢失: 静默注入, 让粒子自然衰减
    if (frequencyData && frequencyData.length) frequencyData.fill(0);
    if (timeDomainData && timeDomainData.length) timeDomainData.fill(128);
    return false;
  }
  var metrics;
  if (FAKE_AUDIO_METRICS_ENABLED) {
    metrics = audioAdapterFakeMetrics(Date.now());
    smtcAudioState.active = true;
    smtcAudioState.mode = 'fake';
    smtcAudioState.rms = audioAdapterSanitize(metrics.rms, 0);
    smtcAudioState.bass = audioAdapterSanitize(metrics.bass, 0);
    smtcAudioState.mid = audioAdapterSanitize(metrics.mid, 0);
    smtcAudioState.treble = audioAdapterSanitize(metrics.treble, 0);
    smtcAudioState.error = '';
    smtcAudioState.updatedAt = Date.now();
  } else {
    // Phase 3 IPC 源: 指标过期(helper 断开/暂停) -> 静默衰减, 不永久熔断。
    // main 进程会按退避策略重启 helper, 指标恢复后自动重新驱动。
    if (Date.now() - smtcAudioState.updatedAt > SMTC_AUDIO_FRESH_MS) {
      if (frequencyData && frequencyData.length) frequencyData.fill(0);
      if (timeDomainData && timeDomainData.length) timeDomainData.fill(128);
      return false;
    }
    metrics = smtcAudioState;
  }
  var renderOk = audioAdapterRenderFrame(metrics);
  // Phase 3 排查 debug: 500ms 限流, 确认 visualizer 输入帧被调用
  if (Date.now() - smtcVisualizerDbgAt >= 500) {
    smtcVisualizerDbgAt = Date.now();
    console.log('[VISUALIZER] update called bass=' + audioAdapterSanitize(metrics.bass, 0).toFixed(3) +
      ' mid=' + audioAdapterSanitize(metrics.mid, 0).toFixed(3) +
      ' treble=' + audioAdapterSanitize(metrics.treble, 0).toFixed(3) +
      ' rms=' + audioAdapterSanitize(metrics.rms, 0).toFixed(3) +
      ' renderOk=' + renderOk);
  }
  if (FAKE_AUDIO_METRICS_ENABLED) smtcDiagBurst();
  return renderOk;
}

var smtcVisualizerDbgAt = 0;

// ---- Phase 3: WASAPI IPC 指标接收 (当前休眠) ----
var smtcAdapterDbgAt = 0;
function smtcAudioApplyMetrics(state) {
  state = (state && typeof state === 'object') ? state : {};
  if (state.error) {
    disableExternalAudio('capture:' + String(state.error).slice(0, 80));
    return;
  }
  var rms = audioAdapterSanitize(state.rms, NaN);
  var bass = audioAdapterSanitize(state.bass, NaN);
  var mid = audioAdapterSanitize(state.mid, NaN);
  var treble = audioAdapterSanitize(state.treble, NaN);
  if (!Number.isFinite(rms) || !Number.isFinite(bass) || !Number.isFinite(mid) || !Number.isFinite(treble)) {
    disableExternalAudio('invalid-metrics');
    return;
  }
  // Phase 3 排查 debug: 500ms 限流, 确认 native metrics 真正进入 renderer
  if (Date.now() - smtcAdapterDbgAt >= 500) {
    smtcAdapterDbgAt = Date.now();
    var sp8 = Array.isArray(state.spectrum) ? audioAdapterSanitize(state.spectrum[8], -1) : -1;
    var sp32 = Array.isArray(state.spectrum) ? audioAdapterSanitize(state.spectrum[32], -1) : -1;
    console.log('[RENDERER] audio metrics received rms=' + rms.toFixed(3) +
      ' bass=' + bass.toFixed(3) + ' mid=' + mid.toFixed(3) + ' treble=' + treble.toFixed(3) +
      ' spectrum[8]=' + (sp8 >= 0 ? sp8.toFixed(3) : 'n/a') +
      ' spectrum[32]=' + (sp32 >= 0 ? sp32.toFixed(3) : 'n/a'));
    console.log('[TRACE AUDIO IPC] rms=' + rms + ' bass=' + bass + ' mid=' + mid + ' treble=' + treble +
      ' spectrumLen=' + (Array.isArray(state.spectrum) ? state.spectrum.length : 0));
  }
  smtcAudioState.active = state.active === true;
  smtcAudioState.mode = String(state.mode || 'none');
  smtcAudioState.pid = Math.max(0, Number(state.pid) || 0);
  smtcAudioState.sourceName = String(state.sourceName || '');
  smtcAudioState.rms = rms;
  smtcAudioState.bass = bass;
  smtcAudioState.mid = mid;
  smtcAudioState.treble = treble;
  // 真实 64 段频谱: 复用 smtcAudioSpectrum 缓冲, 不产生新数组
  if (Array.isArray(state.spectrum)) {
    for (var si = 0; si < 64; si++) {
      smtcAudioSpectrum[si] = si < state.spectrum.length ? audioAdapterSanitize(state.spectrum[si], 0) : 0;
    }
    smtcAudioState.spectrum = smtcAudioSpectrum;
  } else {
    smtcAudioState.spectrum = null;
  }
  smtcAudioState.error = '';
  smtcAudioState.hr = String(state.hr || '');
  smtcAudioState.updatedAt = Date.now();
  // TRACE: 前端 audio state 已写入 (500ms 限流, 与 IPC trace 同源)
  if (Date.now() - smtcAdapterDbgAt2 >= 500) {
    smtcAdapterDbgAt2 = Date.now();
    console.log('[TRACE AUDIO STATE] active=' + smtcAudioState.active +
      ' rms=' + smtcAudioState.rms.toFixed(3) +
      ' bass=' + smtcAudioState.bass.toFixed(3) +
      ' mid=' + smtcAudioState.mid.toFixed(3) +
      ' treble=' + smtcAudioState.treble.toFixed(3) +
      ' spectrum=' + (smtcAudioState.spectrum ? '64' : 'null') +
      ' updatedAt=' + smtcAudioState.updatedAt);
  }
}

var smtcAdapterDbgAt2 = 0;

function initSmtcAudio() {
  if (FAKE_AUDIO_METRICS_ENABLED) {
    console.log('[Audio][' + Date.now() + '] Phase 1: FAKE metrics enabled (no WASAPI/IPC)');
  }
  if (!EXTERNAL_AUDIO_ENABLED) {
    // 03 的 smtcInit() 在本模块顶层 var 赋值前调用(加载顺序 03<04) → 静默返回,
    // 本模块末尾的 initSmtcAudio() 会在变量就绪后真正订阅。
    if (typeof EXTERNAL_AUDIO_ENABLED === 'undefined') return;
    console.log('[Audio][' + Date.now() + '] external audio disabled (EXTERNAL_AUDIO_ENABLED=false)');
    return;
  }
  if (smtcAudioSubscribed) return;
  smtcAudioSubscribed = true;
  var api = window.desktopWindow;
  if (!api || typeof api.onSmtcAudioMetrics !== 'function') {
    console.log('[Audio][' + Date.now() + '] external audio unavailable: onSmtcAudioMetrics missing');
    return;
  }
  console.log('[Audio][' + Date.now() + '] external audio listener registered');
  api.onSmtcAudioMetrics(function (state) {
    smtcAudioApplyMetrics(state);
  });
  if (typeof api.getSmtcAudioState === 'function' && !smtcAudioFallbackTimer) {
    smtcAudioFallbackTimer = setInterval(function () {
      api.getSmtcAudioState().then(function (state) {
        if (state && typeof state === 'object') smtcAudioApplyMetrics(state);
      }).catch(function () {});
    }, 5000);
  }
}

// 自初始化(关键修复): 03 的 smtcInit() 在 04 的顶层变量赋值前执行导致订阅丢失,
// 这里在本模块变量就绪后自行订阅, 外部真实音频 metrics 才能进入 AudioAdapter。
initSmtcAudio();
