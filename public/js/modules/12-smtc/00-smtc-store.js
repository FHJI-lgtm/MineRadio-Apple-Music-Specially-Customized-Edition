// ============================================================
// 12-smtc/00-smtc-store.js
// 统一媒体状态存储 + 本地时间轴平滑器（v4：锚点外推模型）
//
// 只接收主进程转发的 SMTC 快照（mineradio-smtc-state），对外提供：
//   smtcStore                —— 当前 MediaState（播放器无关）
//   smtcPositionSecondsNow() —— 本地平滑后的播放进度（秒）
//   smtcIsPlayingExternal()  —— 外部媒体是否正在播放
//   smtcSessionActive()      —— 是否有 SMTC 会话
//   smtcConsumeSeekFlag()    —— 消费"发生跳变"标记（供歌词行选择重置）
//
// 时间轴策略（v4：锚点外推模型。Apple Music SMTC position 只作为"校准锚点"，
// 不作为连续播放时钟）：
//   - predicted（未钳制 1x 外推）= anchorPositionMs + (performance.now() - anchorAt)
//   - stable（输出）= min(predicted, frozenAt)，frozenAt 单调不下降（绝不把时钟往回拉）
//   - SMTC 新 position 到达时：error = rawAdjusted - predicted（用未钳制的 predicted）
//     * error < 0（SMTC 陈旧 / 回拖）→ hold：不回退、不 snap、不 absorb，仅推进 frozenAt
//     * 0 <= error < 4s → EMA 慢速吸收（anchor += error * 0.15），不重基不跳变
//     * error >= 4s → 连续 2 个仍为大正误差的样本确认 → snap + seek flag（真实前向 seek）
//     * 切歌（title/artist/album/AUMID 变化）→ 立即重置锚点 + seek flag
//   - 最大预测窗口 8s：SMTC 长时间不更新时，稳定时间最多领先"最近样本位置"8s 后冻结
//   - Session Delay（用户设置）只作用于稳定器【最终输出】，绝不进入稳定器 / seek 判定：
//       outputPosition = stablePosition + sessionDelayMs   （负值 = 提前，正值 = 延后）
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
// ---- 时间轴稳定器（v4：锚点外推模型）----
var smtcAnchorPositionMs = 0;   // 锚点：SMTC 校准位置（ms）
var smtcAnchorAt = 0;           // 锚点时刻：performance.now()（ms）
var smtcFrozenAt = 0;           // 冻结点：最近一次有效样本位置 + SMTC_MAX_PREDICT_MS（ms）
var smtcLastSampleAt = 0;       // 最近一次样本到达时刻（performance.now()）
// 跳变标记：歌词行选择据此允许立即回退/跳转（切歌 / 确认 seek）
var smtcSeekedFlag = false;
// ---- 稳定器常量 ----
// 判定为真实 seek / 切歌的误差阈值（需连续确认；Apple Music 正常 2~4s 采样间隔不会被误判）
var SMTC_SNAP_ERROR_MS = 4000;
// 大跳变连续确认次数：连续 N 个方向一致的大误差样本才 snap（Apple Music 偶发大跳不算 seek）
var SMTC_SEEK_CONFIRM_SAMPLES = 2;
// 正误差慢速吸收比例（EMA）：anchor += error * ratio，不重基、不跳变、不回退
var SMTC_DRIFT_ABSORB_RATIO = 0.15;
// 最大预测窗口：SMTC 完全失联时稳定时间最多超前"最近样本位置"8s 后冻结
var SMTC_MAX_PREDICT_MS = 8000;
// ---- 会话延迟（用户设置）----
// 只作用于稳定器【最终输出】：outputPosition = stablePosition + smtcUserSessionDelayMs。
// 绝不进入 rawAdjusted / error / seek 判定 / track reset / pause-resume / anchor。
// 语义：负值 = 时间轴提前（如 -400ms 歌词提前 400ms）；正值 = 延后。
// 范围 -1000~+1000ms，步进 50ms，localStorage 持久化（启动读取，非法/超范围恢复 0）。
var smtcUserSessionDelayMs = 0;
var SMTC_SESSION_DELAY_MIN_MS = -1000;
var SMTC_SESSION_DELAY_MAX_MS = 1000;
var SMTC_SESSION_DELAY_STEP_MS = 50;
var SMTC_SESSION_DELAY_STORAGE_KEY = 'mineradio.smtc.sessionDelayMs';
// 大跳变确认状态：{ count }（连续大正误差样本计数；达到 SMTC_SEEK_CONFIRM_SAMPLES 即 snap）
var smtcSeekConfirm = null;

function smtcDurationSeconds() {
  return smtcStore.durationMs > 0 ? smtcStore.durationMs / 1000 : 0;
}

// 未钳制的 1x 外推（真实本地时钟；误差计算与 [TL] 日志的 predicted 都基于它）
function smtcPredictedMs() {
  if (smtcAnchorAt <= 0) return smtcAnchorPositionMs;
  var predicted = smtcAnchorPositionMs + (performance.now() - smtcAnchorAt);
  if (!isFinite(predicted)) predicted = smtcAnchorPositionMs;
  return Math.max(0, predicted);
}

function smtcStableMs(active, isPlaying) {
  var act = active == null ? smtcStore.active === true : active === true;
  var play = isPlaying == null ? smtcStore.isPlaying === true : isPlaying === true;
  // 暂停 / 未锚定：冻结在锚点位置，不外推
  if (!(act && play && smtcAnchorAt > 0)) return smtcAnchorPositionMs;
  var stable = smtcPredictedMs();
  // 最大预测窗口：不超过冻结点（最近一次有效样本位置 + SMTC_MAX_PREDICT_MS）
  var maxStable = smtcFrozenAt > smtcAnchorPositionMs ? smtcFrozenAt : smtcAnchorPositionMs;
  if (stable > maxStable) stable = maxStable;
  return Math.max(0, stable);
}

function smtcPositionSecondsNow() {
  if (!smtcStore.active) return -1;
  // Session Delay 只作用于稳定器最终输出：outputPosition = stablePosition + sessionDelayMs
  // （负值提前 / 正值延后；稳定器内部 anchor/predicted/error/seek 完全不受影响）
  var pos = (smtcStableMs() + smtcUserSessionDelayMs) / 1000;
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

// ---- 会话延迟（用户设置，只作用于最终输出）----
// 语义：负值 = 时间轴提前（-400ms 即歌词提前 400ms）；正值 = 延后。
// 修改立即生效（不重取歌词 / 不重请求 SMTC / 不触发 seek / 不重置 anchor）。
// 保存强制 clamp [-1000, +1000] 并按 50ms 步进；localStorage 持久化。
function smtcSetSessionDelayMs(ms) {
  var v = Number(ms);
  if (!isFinite(v)) v = 0;
  v = Math.max(SMTC_SESSION_DELAY_MIN_MS, Math.min(SMTC_SESSION_DELAY_MAX_MS, v));
  v = Math.round(v / SMTC_SESSION_DELAY_STEP_MS) * SMTC_SESSION_DELAY_STEP_MS;
  smtcUserSessionDelayMs = v;
  try { localStorage.setItem(SMTC_SESSION_DELAY_STORAGE_KEY, String(v)); } catch (e) { }
  console.log('[Renderer][' + Date.now() + '] SMTC session delay set: ' + v + 'ms (output-only, stabilizer untouched)');
  return v;
}

// 读取当前会话延迟（ms）
function smtcSessionDelayMs() {
  return smtcUserSessionDelayMs;
}

// 启动时从 localStorage 读取；不存在 / 非法 / NaN / 超出范围 -> 恢复 0
function smtcLoadSessionDelayFromStorage() {
  var v = 0;
  try {
    var raw = localStorage.getItem(SMTC_SESSION_DELAY_STORAGE_KEY);
    if (raw !== null && raw !== undefined && raw !== '') {
      var n = Number(raw);
      if (isFinite(n) && n >= SMTC_SESSION_DELAY_MIN_MS && n <= SMTC_SESSION_DELAY_MAX_MS) {
        v = Math.round(n / SMTC_SESSION_DELAY_STEP_MS) * SMTC_SESSION_DELAY_STEP_MS;
      } else {
        v = 0; // 非法 / 超范围 -> 恢复 0，并清掉脏值
        try { localStorage.removeItem(SMTC_SESSION_DELAY_STORAGE_KEY); } catch (e2) { }
      }
    }
  } catch (e) { v = 0; }
  smtcUserSessionDelayMs = v;
  console.log('[Renderer][' + Date.now() + '] SMTC session delay loaded: ' + v + 'ms');
}

function smtcApplyBridgeState(state) {
  state = state && typeof state === 'object' ? state : {};
  var prevActive = smtcStore.active === true;
  var prevPlaying = smtcStore.isPlaying === true;
  var wasPlaying = smtcStore.active === true && smtcStore.isPlaying === true;
  var now = performance.now();
  smtcLastSampleAt = now;
  var newActive = state.active === true;
  var newPlaying = state.isPlaying === true;
  var newBase = Math.max(0, Number(state.positionMs) || 0);
  // Session Delay 绝不进入稳定器：rawAdjusted 就是 SMTC 原始 position（无任何偏移），
  // 保证 error / seek 判定 / track reset / pause-resume / anchor 与 v4 完全一致。
  var rawAdjusted = Math.max(0, newBase);
  // track identity：title / artist / album / AUMID
  var trackChanged = String(state.title || '') !== String(smtcStore.title || '') ||
    String(state.artist || '') !== String(smtcStore.artist || '') ||
    String(state.album || '') !== String(smtcStore.album || '') ||
    String(state.aumid || '') !== String(smtcStore.aumid || '');
  // predicted = 未钳制的 1x 外推（真实本地时钟）；stable 才受 frozenAt 钳制
  var predicted = smtcPredictedMs();
  var error = rawAdjusted - predicted;
  var action = 'hold';
  var seekThisSample = false;

  if (!newActive) {
    // 会话结束：清除稳定器状态，保持 inactive
    smtcAnchorPositionMs = 0;
    smtcAnchorAt = 0;
    smtcFrozenAt = 0;
    smtcSeekConfirm = null;
    action = 'inactive';
    // [M2] SMTC 封面清空由"会话状态真正结束"决定, 而非 thumbnail=null:
    //   prevActive(true->false) + state.bridgeReady===true → Apple Music 会话确实结束 → 清空 SMTC 封面。
    //   bridgeReady===false (watchdog 重启 / bridge 暂时死亡) → 保持旧封面, 等待新 bridge state + thumbnail 恢复,
    //   绝不制造 "旧封面 → 空封面"。
    //   内部播放器正在播放时不干预 (舞台封面归内部播放器, 避免误清内部封面)。
    if (prevActive && state.bridgeReady === true &&
        (!(typeof internalAudioPlayingNow === 'function') || !internalAudioPlayingNow())) {
      if (typeof smtcVisualCoverPending !== 'undefined') smtcVisualCoverPending = null;
      if (typeof loadCoverFromUrl === 'function') loadCoverFromUrl('');
      console.log('[Renderer][' + Date.now() + '] SMTC visualizer cover cleared (session truly ended: active true->false, bridgeReady=true)');
    } else if (prevActive) {
      console.log('[Renderer][' + Date.now() + '] SMTC visualizer cover HELD (inactive state, bridge not ready / internal playing)');
    }
  } else if (trackChanged) {
    // 切歌：立即重置锚点 + seek flag（不等 2 样本确认）
    smtcAnchorPositionMs = rawAdjusted;
    smtcAnchorAt = now;
    smtcFrozenAt = rawAdjusted + SMTC_MAX_PREDICT_MS;
    smtcSeekConfirm = null;
    smtcSeekedFlag = true;
    seekThisSample = true;
    action = 'track-reset';
    console.log('[TL] TRACK_RESET raw=' + Math.round(newBase));
  } else if (!newPlaying) {
    // 暂停：冻结到快照，不再外推
    smtcAnchorPositionMs = rawAdjusted;
    smtcAnchorAt = now;
    smtcFrozenAt = rawAdjusted + SMTC_MAX_PREDICT_MS;
    smtcSeekConfirm = null;
    action = 'paused';
  } else if (!wasPlaying) {
    // 首次收到有效播放状态 / 恢复：重新锚定
    smtcAnchorPositionMs = rawAdjusted;
    smtcAnchorAt = now;
    smtcFrozenAt = rawAdjusted + SMTC_MAX_PREDICT_MS;
    smtcSeekConfirm = null;
    action = 'first-play';
  } else if (error >= SMTC_SNAP_ERROR_MS) {
    // 真正前向 seek / 大正跳变：连续 SMTC_SEEK_CONFIRM_SAMPLES 个仍为大正误差的样本才确认 snap。
    // 负误差（陈旧 / 回拖）永不进入此分支 —— Apple Music 陈旧 Position 不算 seek。
    smtcSeekConfirm = smtcSeekConfirm || { count: 0 };
    smtcSeekConfirm.count += 1;
    if (smtcSeekConfirm.count >= SMTC_SEEK_CONFIRM_SAMPLES) {
      // 确认 seek：重置锚点 + seek flag（歌词允许立即跳转）
      smtcSeekConfirm = null;
      smtcAnchorPositionMs = rawAdjusted;
      smtcAnchorAt = now;
      smtcFrozenAt = rawAdjusted + SMTC_MAX_PREDICT_MS;
      smtcSeekedFlag = true;
      seekThisSample = true;
      action = 'snap';
      console.log('[TL] SNAP raw=' + Math.round(newBase) + ' predicted=' + Math.round(predicted) + ' error=' + Math.round(error));
    } else {
      // 等待确认：保持时钟，不跳变
      action = 'seek-pending';
    }
  } else if (error > 0) {
    // 小幅/中等正误差：慢速 EMA 吸收（不重基、不回退、不跳变）
    smtcSeekConfirm = null;
    smtcAnchorPositionMs = smtcAnchorPositionMs + error * SMTC_DRIFT_ABSORB_RATIO;
    smtcAnchorAt = now;
    // frozenAt 单调不下降：陈旧/回拖样本不能把预测上限往回拉
    smtcFrozenAt = Math.max(smtcFrozenAt, rawAdjusted + SMTC_MAX_PREDICT_MS);
    action = 'absorb';
  } else {
    // 负误差 / 零误差：SMTC 陈旧，不回退时间轴、不 snap、不 absorb；仅推进冻结点
    smtcSeekConfirm = null;
    smtcFrozenAt = Math.max(smtcFrozenAt, rawAdjusted + SMTC_MAX_PREDICT_MS);
    action = 'hold';
  }

  smtcStore = Object.assign({}, smtcStore, {
    active: newActive,
    title: String(state.title || ''),
    artist: String(state.artist || ''),
    album: String(state.album || ''),
    aumid: String(state.aumid || smtcStore.aumid || ''),
    status: String(state.status || ''),
    isPlaying: newPlaying,
    durationMs: Math.max(0, Number(state.durationMs) || 0),
    positionMs: smtcStableMs(newActive, newPlaying),
    lastUpdatedMs: Math.max(0, Number(state.lastUpdatedMs) || 0),
    source: 'smtc',
    bridgeReady: state.bridgeReady === true,
    error: String(state.error || ''),
    debug: String(state.debug || smtcStore.debug || ''),
    updatedAt: Date.now(),
  });
  // 紧凑时间轴日志（每次 SMTC state 更新打印一次）
  // raw/predicted/stable/error 保持 v4 原语义；delay/output 仅最终显示层信息
  console.log('[TL] raw=' + Math.round(newBase) + ' predicted=' + Math.round(predicted) +
    ' stable=' + Math.round(smtcStore.positionMs) + ' error=' + Math.round(error) +
    ' delay=' + smtcUserSessionDelayMs + ' output=' + Math.round(smtcStore.positionMs + smtcUserSessionDelayMs) +
    ' playing=' + newPlaying + ' trackChanged=' + trackChanged + ' seek=' + seekThisSample +
    ' action=' + action);
  console.log('[CLOCK][' + Date.now() + '] smtc=' + Math.round(newBase) + ' local=' + Math.round(predicted) +
    ' error=' + Math.round(error) + 'ms action=' + action);
  console.log('[STORE][' + Date.now() + '] state updated (T5/T6): active=' + smtcStore.active +
    ' title=' + (smtcStore.title || '') +
    ' artist=' + (smtcStore.artist || '') +
    ' isPlaying=' + smtcStore.isPlaying +
    ' position=' + Math.round(smtcStore.positionMs) +
    ' duration=' + smtcStore.durationMs +
    ' debug=' + (smtcStore.debug || ''));
  // [FIX 2] active 恢复后冲刷 pending cover:
  // watchdog 重启时 thumbnail 事件先于 active state 到达, 03-smtc-ui.js 已把封面挂起;
  // 此处等 state 把 smtcStore.active 置回 true 后再补放, 顺序为: state(active=true) -> flush -> applyCover。
  if (smtcStore.active && typeof smtcApplyVisualizerCover === 'function' && smtcVisualCoverPending) {
    var pendingCover = smtcVisualCoverPending;
    smtcVisualCoverPending = null;
    smtcApplyVisualizerCover(pendingCover);
  }
  if (typeof onSmtcStateChanged === 'function') {
    onSmtcStateChanged(prevActive, prevPlaying);
  }
}

function initSmtcStore() {
  smtcLoadSessionDelayFromStorage();   // 启动时读取会话延迟（localStorage 持久化）
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
