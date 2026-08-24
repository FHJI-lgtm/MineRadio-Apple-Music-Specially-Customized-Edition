// ============================================================
// 12-smtc/00-smtc-store.js
// 统一媒体状态存储 + 本地时间轴平滑器（v3：校准-修正模型）
//
// 只接收主进程转发的 SMTC 快照（mineradio-smtc-state），对外提供：
//   smtcStore                —— 当前 MediaState（播放器无关）
//   smtcPositionSecondsNow() —— 本地平滑后的播放进度（秒）
//   smtcIsPlayingExternal()  —— 外部媒体是否正在播放
//   smtcSessionActive()      —— 是否有 SMTC 会话
//   smtcConsumeSeekFlag()    —— 消费"发生跳变"标记（供歌词行选择重置）
//
// 时间轴策略（Apple Music SMTC position 只作为校准参考）：
//   - 本地单调钟推进：base + elapsedMonotonicTime
//   - SMTC 新 position 到达时：error = smtc - localExpected
//     * error > 0（SMTC 超前，通常因 Apple Music 时间线更新滞后）
//       → 400ms 窗口内平滑追平（正向插值，不跳变）
//     * error < 0（SMTC 落后）→ 保持本地钟，不回退
//     * |error| >= 1.5s（明确 seek / 切歌 / 播放结束重开）→ 直接校准
// UI / 歌词模块一律通过这些接口读取，不直接接触 SMTC。
// ============================================================
var smtcStore = {
  active: false,
  title: '',
  artist: '',
  album: '',
  status: '',
  isPlaying: false,
  durationMs: 0,
  positionMs: 0,
  lastUpdatedMs: 0,
  source: 'smtc',
  updatedAt: 0,
  bridgeReady: false,
  error: '',
  debug: '',
  thumbnail: null,   // Phase 4A: 专辑封面 data URL 或 null (仅 identity 变化时更新)
};
var smtcStoreSubscribed = false;
var smtcStoreFallbackTimer = 0;
// 本地钟基准：smtcLocalBaseMs + (now - smtcLocalBaseAt) 即原始单调钟（ms）
var smtcLocalBaseMs = 0;
var smtcLocalBaseAt = 0;
// 平滑修正（正向追平）：在窗口内从 from 插值到 to，收敛后重基到目标轨迹
var smtcCorrectionActive = false;
var smtcCorrectionStartAt = 0;
var smtcCorrectionFrom = 0;
var smtcCorrectionTo = 0;
// 跳变标记：歌词行选择据此允许立即回退/跳转（真实 seek）
var smtcSeekedFlag = false;
var SMTC_CORRECTION_WINDOW_MS = 400;
var SMTC_SNAP_ERROR_MS = 1500;
var SMTC_MAX_CLOCK_SKEW_MS = 90000;

function smtcDurationSeconds() {
  return smtcStore.durationMs > 0 ? smtcStore.durationMs / 1000 : 0;
}

function smtcRawClockMs() {
  if (!(smtcStore.active && smtcStore.isPlaying && smtcLocalBaseAt > 0)) return smtcStore.positionMs;
  var elapsed = Date.now() - smtcLocalBaseAt;
  if (!isFinite(elapsed) || elapsed < 0) elapsed = 0;
  if (elapsed > SMTC_MAX_CLOCK_SKEW_MS) elapsed = SMTC_MAX_CLOCK_SKEW_MS;
  return smtcLocalBaseMs + elapsed;
}

function smtcLocalEstimateMs() {
  if (!smtcCorrectionActive) return smtcRawClockMs();
  var k = (Date.now() - smtcCorrectionStartAt) / SMTC_CORRECTION_WINDOW_MS;
  if (k >= 1) {
    smtcCorrectionActive = false;
    // 收敛完成：把本地钟重基到目标轨迹，后续按该轨迹连续推进
    smtcLocalBaseMs = smtcCorrectionTo;
    smtcLocalBaseAt = Date.now();
    return smtcCorrectionTo;
  }
  if (k < 0) k = 0;
  return smtcCorrectionFrom + (smtcCorrectionTo - smtcCorrectionFrom) * k;
}

function smtcPositionSecondsNow() {
  if (!smtcStore.active) return -1;
  var pos = smtcLocalEstimateMs() / 1000;
  var duration = smtcDurationSeconds();
  if (duration > 0 && pos > duration + 2) pos = duration;
  return Math.max(0, pos);
}

function smtcSessionActive() {
  return smtcStore.active === true;
}

function smtcIsPlayingExternal() {
  return smtcStore.active === true && smtcStore.isPlaying === true;
}

function smtcConsumeSeekFlag() {
  var seeked = smtcSeekedFlag === true;
  smtcSeekedFlag = false;
  return seeked;
}

function smtcApplyBridgeState(state) {
  state = state && typeof state === 'object' ? state : {};
  var prevActive = smtcStore.active === true;
  var prevPlaying = smtcStore.isPlaying === true;
  var wasPlaying = smtcStore.active === true && smtcStore.isPlaying === true;
  var newBase = Math.max(0, Number(state.positionMs) || 0);
  var expected = smtcLocalEstimateMs();
  var error = newBase - expected;
  var action = 'hold';

  if (state.active !== true) {
    smtcCorrectionActive = false;
    action = 'inactive';
  } else if (!wasPlaying || state.isPlaying !== true) {
    // 暂停 / 非播放态：不推进，直接采用快照位置
    smtcCorrectionActive = false;
    smtcLocalBaseMs = newBase;
    smtcLocalBaseAt = Date.now();
    action = state.isPlaying === true ? 'snap' : 'paused';
  } else if (Math.abs(error) >= SMTC_SNAP_ERROR_MS) {
    // 明确跳变（用户拖动 / 切歌 / 播放结束重开）：直接校准
    smtcCorrectionActive = false;
    smtcLocalBaseMs = newBase;
    smtcLocalBaseAt = Date.now();
    smtcSeekedFlag = true;
    action = 'snap';
  } else if (error > 0) {
    // SMTC 超前：400ms 内平滑追平（正向，不回退）
    smtcCorrectionActive = true;
    smtcCorrectionStartAt = Date.now();
    smtcCorrectionFrom = expected;
    smtcCorrectionTo = newBase;
    action = 'smooth+';
  } else {
    // SMTC 落后或相等：保持本地钟，不回退
    smtcCorrectionActive = false;
    action = 'hold';
  }

  smtcStore = Object.assign({}, smtcStore, {
    active: state.active === true,
    title: String(state.title || ''),
    artist: String(state.artist || ''),
    album: String(state.album || ''),
    status: String(state.status || ''),
    isPlaying: state.isPlaying === true,
    durationMs: Math.max(0, Number(state.durationMs) || 0),
    positionMs: smtcLocalEstimateMs(),
    lastUpdatedMs: Math.max(0, Number(state.lastUpdatedMs) || 0),
    source: 'smtc',
    bridgeReady: state.bridgeReady === true,
    error: String(state.error || ''),
    debug: String(state.debug || smtcStore.debug || ''),
    updatedAt: Date.now(),
  });
  console.log('[CLOCK][' + Date.now() + '] smtc=' + Math.round(newBase) + ' local=' + Math.round(expected) +
    ' error=' + Math.round(error) + 'ms action=' + action);
  console.log('[STORE][' + Date.now() + '] state updated (T5/T6): active=' + smtcStore.active +
    ' title=' + (smtcStore.title || '') +
    ' artist=' + (smtcStore.artist || '') +
    ' isPlaying=' + smtcStore.isPlaying +
    ' position=' + Math.round(smtcStore.positionMs) +
    ' duration=' + smtcStore.durationMs +
    ' debug=' + (smtcStore.debug || ''));
  if (typeof onSmtcStateChanged === 'function') {
    onSmtcStateChanged(prevActive, prevPlaying);
  }
}

function initSmtcStore() {
  if (smtcStoreSubscribed) return;
  smtcStoreSubscribed = true;
  var api = window.desktopWindow;
  if (!api || typeof api.onSmtcState !== 'function') {
    console.log('[Renderer][' + Date.now() + '] SMTC unavailable: desktopWindow.onSmtcState missing');
    return;
  }
  console.log('[Renderer][' + Date.now() + '] SMTC listener registered');
  api.onSmtcState(function (state) {
    console.log('[Renderer][' + Date.now() + '] SMTC state received (T5): title=' + String(state && state.title || '') + ' artist=' + String(state && state.artist || ''));
    smtcApplyBridgeState(state);
  });
  // Phase 4A: 专辑封面 (专用低带宽事件, 仅 identity 变化时到达)
  if (typeof api.onSmtcThumbnail === 'function') {
    api.onSmtcThumbnail(function (thumb) {
      smtcStore.thumbnail = thumb ? String(thumb) : null;
      console.log('[Renderer][' + Date.now() + '] SMTC thumbnail ' + (smtcStore.thumbnail ? 'received (' + smtcStore.thumbnail.length + ' chars)' : 'cleared'));
      if (typeof onSmtcThumbnailChanged === 'function') onSmtcThumbnailChanged(smtcStore.thumbnail);
    });
  }
  if (typeof api.startSmtc === 'function') {
    api.startSmtc().catch(function () {});
  }
  // 低频 fallback：事件丢失时兜底轮询主进程（无网络请求）。
  if (typeof api.getSmtcState === 'function' && !smtcStoreFallbackTimer) {
    smtcStoreFallbackTimer = setInterval(function () {
      api.getSmtcState().then(function (state) {
        if (state && typeof state === 'object') smtcApplyBridgeState(state);
      }).catch(function () {});
    }, 15000);
  }
}
