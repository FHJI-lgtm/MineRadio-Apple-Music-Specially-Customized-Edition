// ============================================================
// 12-smtc/08-timeline-stabilizer-plus.js
// Timeline Stabilizer Plus (TSP) —— QPC 主时钟 + SMTC 周期校准
//
// 数据流（唯一时间源）：
//
//        SMTC state ──► tspHandleBridgeState() ──► Anchor
//                                                  {basePositionMs, baseQpcMs, correctionRate}
//        QPC ────────► tspStableMsAt(now) ───────► stablePosition
//        stablePosition ──► smtcPositionSecondsNow() ──► 歌词 / 进度条 / 主循环 / 节拍相机
//
// 关键设计
//   1. 时钟源：Chromium 渲染进程的 performance.now() 在 Windows 上就是
//      base::TimeTicks::Now() -> QueryPerformanceCounter（单调、亚微秒）。
//      本模块以它作为唯一主时钟；绝不使用 Date.now()/墙钟推进时间轴
//      （Date.now() 仅用于 PCM 新鲜度这类"墙钟比较"，不参与外推）。
//   2. SMTC 只做校准：正常播放期间不每帧读 SMTC；只有 state 到达时校准一次。
//   3. 采样不确定窗口（quantum window）：实测 Apple Music SMTC Position 只按整秒
//      上报（83000/84000/95000...），LastUpdatedTime 每次读取基本都是"刚刚"。
//      也就是说 raw = floor(真实位置)，本身带 0~1000ms 的向下量化误差，采样还会
//      5s 才来一次。若直接拿 raw 与本地时钟做差，正常播放就会不断出现
//      300~800ms 级别的"误差"，旧 v4 平滑器因此每次采样都在追这些量化噪声
//      （这正是歌词/进度条错位的来源）。
//      TSP 把"量化 + IPC 延迟"视为测量不确定度窗口：窗口内的差值 = 噪声 = 零误差；
//      只有超出窗口的偏差才进入 150ms / 500ms 判定。
//      对毫秒级连续上报的播放器窗口自动退化为 0，即需求文档里的原始阈值语义。
//   4. 校准：|err| < 150ms 忽略；150~500ms 用极低幅度 rate correction 慢速消除
//      （不重基、不跳变、不回退）；>= 500ms 记为可疑样本，连续 2~3 次方向与目标
//      一致才确认为真实 seek。
//   5. 切歌：identity（title/artist/album/aumid）变化立即丢弃旧 anchor，从 0 重新
//      起跳，并用"旧时间轴此刻应该在的位置"排除 SMTC 仍在上报上一首 position 的
//      陈旧样本（Apple 切歌后短时间内仍返回 183.4s 的经典问题）。
//   6. PCM（04-smtc-audio）：只做"播放状态置信度"校验（3s 滑窗），
//      绝不作为时间轴开关。SMTC=Playing + PCM 无能量 -> 只降低置信度并缩短外推
//      预算，不冻结时间轴；SMTC=Paused + PCM 连续有能量 -> 标记可疑暂停状态。
//
// 旧 v4 平滑器保留为 legacy 回退 / A-B 对比：
//   window.smtcTspSetMode('legacy' | 'tsp')
//   window.smtcTspSetDebug(true | false)    // 默认关闭，不污染正常用户日志
//   window.smtcTspDump()                    // 最近 240 条 TSP 诊断（环形缓冲）
//   window.smtcTspSnapshot()                // 当前 anchor / 置信度快照
// ============================================================

// ---- 开关 / 持久化 ----
var TSP_DEBUG_STORAGE_KEY = 'mineradio.smtc.tspDebug';
var TSP_MODE_STORAGE_KEY = 'mineradio.smtc.timelineMode';
var tspTimelineEnabled = true;        // 总开关（false = 完全走 v4 legacy）
var tspTimelineMode = 'tsp';          // 'tsp' | 'legacy'（A/B 回退）
var tspDebugOn = false;               // 默认关闭：正常用户日志里不出现 [TSP]

// ---- 校准阈值（全部可调，不含"未经验证的大修正速度"）----
var TSP_SMALL_ERROR_MS = 150;         // < 150ms：忽略，不修改 anchor
var TSP_LARGE_ERROR_MS = 500;         // >= 500ms：可疑样本，需要连续确认
var TSP_CONFIRM_SAMPLES = 3;          // 连续 3 次一致 -> 确认真实 seek
var TSP_CONFIRM_SAMPLES_WRAP = 2;     // 曲末回卷（repeat/重播）只需 2 次
var TSP_SUSPICIOUS_TOLERANCE_MS = 400; // 相邻可疑样本的目标一致性容差（目标以 1x 前进）
var TSP_SUSPICIOUS_DRIFT_TOLERANCE_MS = 200; // 相邻可疑样本的偏差漂移容差
                                           // 真实 seek: 偏差恒定(|Δd|≈0); 采样抖动/量化:
                                           // 偏差每采样会跳 500~1000ms -> 不满足"持续一致"
var TSP_CORRECTION_TIME_MS = 10000;   // 中等误差目标消除时间（决定 rate 幅度）
var TSP_MAX_RATE_DELTA = 0.05;        // 速率修正上限 ±5%（极低幅度）
var TSP_MIN_RATE = 0.90;
var TSP_MAX_RATE = 1.10;
var TSP_MAX_PREDICT_MS = 8000;        // SMTC 完全失联时的最大外推预算
// 低置信度（SMTC=Playing 但 PCM 长时间无能量）时的外推预算。
// 必须 > SMTC 采样间隔(实测 5s)，否则安静段落会每 5s 冻结一次再跳。
var TSP_LOW_CONFIDENCE_PREDICT_MS = 6000;
var TSP_LATENCY_SLACK_MS = 120;       // IPC / 读取延迟补偿（窗口余量）
var TSP_QUANTUM_DEFAULT_MS = 1000;    // 整秒上报时的量化步长
var TSP_QUANTUM_DETECT_HITS = 4;      // 连续 N 个整秒样本 -> 判定量化
var TSP_QUANTUM_DETECT_MISS = 2;      // 连续 N 个非整秒样本 -> 取消量化判定
var TSP_TRACK_STALE_GUARD_MS = 1500;  // 切歌后"疑似上一首 position"的判定上界（可略微领先）
var TSP_TRACK_STALE_LAG_MS = 15000;   // 下界：旧 session 最后一次上报最多滞后旧时间轴这么久
var TSP_TRACK_STALE_MIN_MS = 2000;    // 新歌 position > 0 时才可能判定为陈旧
var TSP_TRACK_PENDING_SAMPLES = 3;    // 切歌后最多容忍几个陈旧样本
var TSP_WRAP_NEAR_END_RATIO = 0.75;   // 曲末回卷判定：稳定位置已进入曲末 25%
var TSP_WRAP_MIN_BACKWARD_RATIO = 0.5; // 且一次回退超过整曲的 50%（repeat / 重播）
var TSP_PCM_TICK_MS = 250;
var TSP_PCM_WINDOW_TICKS = 12;        // 3s 滑窗
var TSP_PCM_ACTIVE_RMS = 0.008;       // 极低门限：安静段落不算"无能量"
var TSP_PCM_ACTIVE_TICKS = 5;         // 窗口内 >= 5 帧有能量 -> active
var TSP_PCM_SILENT_TICKS = 1;         // 窗口内 <= 1 帧有能量 -> silent
var TSP_PCM_FRESH_MS = 2500;          // 采集指标过期 -> unknown（不算静音）
var TSP_DEBUG_RING = 240;

// ---- 置信度权重 ----
var TSP_CONF_PLAY_PCM_ACTIVE = 1.00;
var TSP_CONF_PLAY_PCM_MIXED = 0.85;
var TSP_CONF_PLAY_PCM_UNKNOWN = 0.75;
var TSP_CONF_PLAY_PCM_SILENT = 0.45;
var TSP_CONF_PAUSE_PCM_SILENT = 0.95;
var TSP_CONF_PAUSE_PCM_ACTIVE = 0.35;

function tspJsonSafe(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

var tspState = {
  active: false,
  phase: 'idle',              // idle | playing | paused
  basePositionMs: 0,          // anchor: 基准位置
  baseQpcMs: 0,               // anchor: 基准 QPC 时刻
  correctionRate: 1,          // anchor: 速率修正（1.0 = 原速）
  identity: '',
  durationMs: 0,
  sampleCount: 0,
  lastSampleQpcMs: 0,
  lastQpcMs: 0,
  lastRawMs: 0,
  lastStableMs: 0,
  errorMs: 0,
  rawErrorMs: 0,
  windowMs: 0,
  quantumMs: 0,
  quantumWholeHits: 0,
  quantumWholeMiss: 0,
  sampleStableMs: 0,          // 最近一次样本时刻的 stable（外推预算基准）
  floorMs: 0,                 // 单调地板：Stable Position 绝不回退（显式重锚才会移动）
  capHit: false,              // 上一拍之后本地时钟是否被外推预算冻结过（= SMTC 失联）
  lastAction: 'init',
  actionCount: 0,
  anchorResets: 0,
  anchorResetReason: '',
  suspiciousCount: 0,
  suspiciousSign: 0,
  suspiciousRefMs: 0,
  suspiciousAtQpcMs: 0,
  suspiciousDeviationMs: 0,
  suspiciousNeeded: TSP_CONFIRM_SAMPLES,
  postTrackChange: false,
  postTrackChangeSamples: 0,
  oldTimelineExpectedMs: 0,
  seekEvent: false,
  pcmState: 'unknown',
  pcmRing: [],
  pcmTickIndex: 0,
  pcmTicks: 0,
  confidence: TSP_CONF_PLAY_PCM_UNKNOWN,
  pauseSuspicious: false,
  pcmLastRms: -1,
  logRing: [],
  logRingIndex: 0,
  logRingCount: 0,
  clockSource: 'performance.now()/QPC'
};

// ------------------------------------------------------------
// QPC 时钟（唯一主时间源）
// ------------------------------------------------------------
function tspIsAvailable() {
  try {
    return typeof performance !== 'undefined' && performance &&
      typeof performance.now === 'function';
  } catch (e) { return false; }
}

function tspQpcNow() {
  var t = NaN;
  try { t = performance.now(); } catch (e) { t = NaN; }
  if (!isFinite(t)) t = tspState.lastQpcMs;
  // 单调保护：时钟绝不倒退（哪怕宿主环境异常也不会产生负 elapsed）
  if (t < tspState.lastQpcMs) t = tspState.lastQpcMs;
  tspState.lastQpcMs = t;
  return t;
}

// ------------------------------------------------------------
// 调试日志（默认关闭；始终写入环形缓冲，便于事后导出）
// ------------------------------------------------------------
function deviationOf(rawMs, stableMs) {
  return tspJsonSafe(rawMs) - tspJsonSafe(stableMs);
}
function tspSec(v) {
  return (tspJsonSafe(v) / 1000).toFixed(3);
}
function tspSigned(v) {
  var n = Math.round(tspJsonSafe(v));
  return (n > 0 ? '+' : '') + n;
}
function tspLogLine(text) {
  var s = tspState;
  s.logRing[s.logRingIndex] = text;
  s.logRingIndex = (s.logRingIndex + 1) % TSP_DEBUG_RING;
  if (s.logRingCount < TSP_DEBUG_RING) s.logRingCount += 1;
  if (tspDebugOn) {
    try { console.log('[TSP] ' + text); } catch (e) { }
  }
}
function tspLogSample(raw, stable, err, note) {
  var s = tspState;
  tspLogLine('SMTC=' + tspSec(raw) + ' Stable=' + tspSec(stable) +
    ' Error=' + tspSigned(err) + 'ms rate=' + (Math.round(s.correctionRate * 1000) / 1000).toFixed(3) +
    ' state=' + s.phase + ' susp=' + s.suspiciousCount + '/' + s.suspiciousNeeded +
    ' q=' + Math.round(s.quantumMs) + ' win=' + Math.round(s.windowMs) +
    ' conf=' + (Math.round(s.confidence * 100) / 100).toFixed(2) +
    ' track="' + s.identity + '"' + (note ? ' ' + note : ''));
}
function tspDebugDump() {
  var s = tspState;
  var out = [];
  var start = s.logRingCount < TSP_DEBUG_RING ? 0 : s.logRingIndex;
  for (var i = 0; i < s.logRingCount; i++) {
    out.push(s.logRing[(start + i) % TSP_DEBUG_RING]);
  }
  return out.join('\n');
}

// ------------------------------------------------------------
// Anchor / 稳定位置
// ------------------------------------------------------------
function tspResetAnchor(reason, raw) {
  var s = tspState;
  s.basePositionMs = Math.max(0, tspJsonSafe(raw));
  s.baseQpcMs = tspQpcNow();
  s.correctionRate = 1;
  s.anchorResets += 1;
  s.anchorResetReason = String(reason || '');
  s.sampleStableMs = s.basePositionMs;
  s.floorMs = s.basePositionMs;
  s.suspiciousCount = 0;
  s.suspiciousSign = 0;
  s.suspiciousRefMs = 0;
  s.suspiciousAtQpcMs = 0;
  s.suspiciousDeviationMs = 0;
}

// 稳定位置（ms）：播放中 = basePosition + elapsedQpc * correctionRate
function tspStableMsAt(qpcMs) {
  var s = tspState;
  if (s.phase !== 'playing') return Math.max(0, s.basePositionMs);
  var elapsed = qpcMs - s.baseQpcMs;
  if (!isFinite(elapsed) || elapsed < 0) elapsed = 0;
  var pos = s.basePositionMs + elapsed * s.correctionRate;
  // 外推预算：SMTC 彻底失联（bridge 卡死 / watchdog 重启窗口）时，本地时钟最多再走
  // budget 就冻结在"最近样本时刻的位置 + budget"。有样本时该上限恒大于当前外推值，
  // 因此它只在"没有样本"时生效，绝不参与校准（也不会把时间轴往回拉）。
  var budget = s.confidence < 0.6 ? TSP_LOW_CONFIDENCE_PREDICT_MS : TSP_MAX_PREDICT_MS;
  if (s.sampleStableMs > 0) {
    var cap = s.sampleStableMs + budget;
    if (pos > cap) { pos = cap; s.capHit = true; }
  }
  // 单调地板：正常播放期间 Stable Position 绝不回退；
  // 真实 seek / 切歌 / 恢复通过显式重锚同步移动地板。
  if (pos < s.floorMs) pos = s.floorMs;
  if (pos < 0) pos = 0;
  s.floorMs = pos;
  return pos;
}
function tspStableMsNow() {
  return tspStableMsAt(tspQpcNow());
}
function tspIsTimelineActive() {
  return tspTimelineEnabled === true && tspTimelineMode !== 'legacy';
}

// ------------------------------------------------------------
// Track identity
// ------------------------------------------------------------
function tspIdentityOf(state) {
  if (!state || state.active !== true) return '';
  var title = String(state.title || '');
  var aumid = String(state.aumid || '');
  if (!title && !aumid) return '';
  return aumid + '|' + title + '|' + String(state.artist || '') + '|' + String(state.album || '');
}

// ------------------------------------------------------------
// 量化步长检测：Apple Music 按整秒上报；毫秒级播放器 -> 0
// ------------------------------------------------------------
function tspObserveQuantum(rawMs) {
  var s = tspState;
  var whole = Math.abs(rawMs - Math.round(rawMs / 1000) * 1000) <= 1;
  if (whole) {
    s.quantumWholeHits += 1;
    s.quantumWholeMiss = 0;
    // 首个样本就是整秒 -> 立刻按整秒量化处理（真机 Apple Music 形态），
    // 避免开头几个样本被量化噪声误判；连续 2 个非整秒样本会取消该判定。
    if (s.sampleCount <= 1) s.quantumMs = TSP_QUANTUM_DEFAULT_MS;
  } else {
    s.quantumWholeMiss += 1;
    s.quantumWholeHits = 0;
  }
  if (s.quantumWholeMiss >= TSP_QUANTUM_DETECT_MISS) s.quantumMs = 0;
  else if (s.quantumWholeHits >= TSP_QUANTUM_DETECT_HITS) s.quantumMs = TSP_QUANTUM_DEFAULT_MS;
  return s.quantumMs;
}
// 采样不确定窗口：量化步长 + 读取/IPC 延迟余量
function tspWindowMs() {
  return (tspState.quantumMs > 0 ? tspState.quantumMs : 0) + TSP_LATENCY_SLACK_MS;
}
// 量化中心估计：整秒上报时 raw 是向下取整，取中点更接近真实播放头（毫秒级源 -> 无偏移）
function tspQuantizationCenterMs() {
  return tspState.quantumMs > 0 ? tspState.quantumMs / 2 : 0;
}

// ------------------------------------------------------------
// PCM 播放状态置信度（辅助校验，绝不是时间轴开关）
// ------------------------------------------------------------
function tspPcmSampleNow() {
  var st = null;
  try { if (typeof smtcAudioState !== 'undefined' && smtcAudioState) st = smtcAudioState; } catch (e) { st = null; }
  if (!st || st.active !== true) return -1;                    // 采集未运行 -> unknown
  var updatedAt = Number(st.updatedAt) || 0;
  if (!updatedAt) return -1;
  var age = Date.now() - updatedAt;                            // 仅墙钟比较，不参与外推
  if (!isFinite(age) || age < 0 || age > TSP_PCM_FRESH_MS) return -1;
  var rms = Number(st.rms);
  if (!isFinite(rms)) return -1;
  tspState.pcmLastRms = rms;
  return rms >= TSP_PCM_ACTIVE_RMS ? 1 : 0;
}
function tspSamplePcmWindow() {
  var s = tspState;
  var v = tspPcmSampleNow();
  s.pcmRing[s.pcmTickIndex] = v;
  s.pcmTickIndex = (s.pcmTickIndex + 1) % TSP_PCM_WINDOW_TICKS;
  if (s.pcmTicks < TSP_PCM_WINDOW_TICKS) s.pcmTicks += 1;
  var known = 0, active = 0;
  for (var i = 0; i < s.pcmTicks; i++) {
    var val = s.pcmRing[i];
    if (val === 1) { known += 1; active += 1; }
    else if (val === 0) { known += 1; }
  }
  if (known === 0) s.pcmState = 'unknown';
  else if (active >= TSP_PCM_ACTIVE_TICKS) s.pcmState = 'active';
  else if (active <= TSP_PCM_SILENT_TICKS) s.pcmState = 'silent';
  else s.pcmState = 'mixed';
}
function tspComputeConfidence() {
  var s = tspState;
  var pcm = s.pcmState;
  if (s.phase === 'playing') {
    if (pcm === 'active') return TSP_CONF_PLAY_PCM_ACTIVE;
    if (pcm === 'mixed') return TSP_CONF_PLAY_PCM_MIXED;
    if (pcm === 'silent') return TSP_CONF_PLAY_PCM_SILENT;
    return TSP_CONF_PLAY_PCM_UNKNOWN;
  }
  if (s.phase === 'paused') {
    return pcm === 'active' ? TSP_CONF_PAUSE_PCM_ACTIVE : TSP_CONF_PAUSE_PCM_SILENT;
  }
  return TSP_CONF_PLAY_PCM_UNKNOWN;
}
function tspTick() {
  try {
    if (!tspIsTimelineActive()) return;
    tspSamplePcmWindow();
    var s = tspState;
    s.confidence = tspComputeConfidence();
    var pcmActive = s.pcmState === 'active';
    if (s.active && s.phase === 'paused' && pcmActive) {
      if (!s.pauseSuspicious) {
        s.pauseSuspicious = true;
        tspLogLine('suspicious pause: SMTC=Paused but PCM has sustained energy (conf=' +
          s.confidence.toFixed(2) + ', rms=' + (s.pcmLastRms >= 0 ? s.pcmLastRms.toFixed(4) : 'n/a') + ')');
      }
    } else if (s.pauseSuspicious) {
      s.pauseSuspicious = false;
    }
    if (s.active && s.phase === 'playing' && s.pcmState === 'silent' &&
        s.confidence <= TSP_CONF_PLAY_PCM_SILENT) {
      // 只降低外推预算（由 confidence 生效），不冻结时间轴
    }
  } catch (e) { /* 诊断 tick 永不中断主流程 */ }
}

// ------------------------------------------------------------
// 校准主入口：每次 SMTC state 到达时调用一次
// 返回 null = 交给 v4 legacy 路径（关闭 / legacy 模式 / 无高精度时钟）
// ------------------------------------------------------------
function tspHandleBridgeState(state, nowQpc, ctx) {
  if (!tspIsTimelineActive()) return null;
  if (!tspIsAvailable()) {
    tspState.legacyFallbackReason = 'no-high-resolution-monotonic-clock';
    return null;
  }
  state = (state && typeof state === 'object') ? state : {};
  ctx = (ctx && typeof ctx === 'object') ? ctx : {};
  var s = tspState;
  var now = isFinite(nowQpc) ? nowQpc : tspQpcNow();

  var active = ctx.active != null ? ctx.active === true : state.active === true;
  var playing = ctx.playing != null ? ctx.playing === true : state.isPlaying === true;
  var raw = Math.max(0, tspJsonSafe(ctx.rawPositionMs != null ? ctx.rawPositionMs : state.positionMs));
  var durationMs = Math.max(0, tspJsonSafe(state.durationMs));
  var identity = tspIdentityOf(state);

  s.sampleCount += 1;
  s.lastSampleQpcMs = now;
  s.durationMs = durationMs;
  s.seekEvent = false;
  // 上一拍之后本地时钟被外推预算冻结过 -> SMTC 长时间没有样本（失联已"被确认"）
  var wasStalled = s.capHit === true;
  s.capHit = false;

  // ---- 会话结束 ----
  if (!active) {
    s.active = false;
    s.phase = 'idle';
    s.identity = '';
    s.basePositionMs = 0;
    s.baseQpcMs = now;
    s.correctionRate = 1;
    s.sampleStableMs = 0;
    s.floorMs = 0;
    s.suspiciousCount = 0;
    s.postTrackChange = false;
    s.confidence = TSP_CONF_PLAY_PCM_UNKNOWN;
    s.pauseSuspicious = false;
    s.lastAction = 'inactive';
    s.lastStableMs = 0;
    tspLogLine('session inactive -> anchor cleared');
    return { stableMs: 0, action: 'inactive', seekEvent: false };
  }

  s.active = true;
  tspObserveQuantum(raw);
  s.windowMs = tspWindowMs();
  s.lastRawMs = raw;

  // ---- Track change：identity 优先级高于 position ----
  var trackChanged = identity !== '' && identity !== s.identity;
  var justTrackChanged = trackChanged;
  if (trackChanged) {
    var oldExpected = s.phase === 'playing' ? tspStableMsAt(now) : s.basePositionMs;
    s.oldTimelineExpectedMs = oldExpected;
    s.identity = identity;
    s.postTrackChange = true;
    s.postTrackChangeSamples = 0;
    s.basePositionMs = 0;                 // 新歌从 0 起跳，绝不继承上一首时间轴
    s.baseQpcMs = now;
    s.correctionRate = 1;
    s.sampleStableMs = 0;
    s.floorMs = 0;
    s.phase = playing ? 'playing' : 'paused';
    s.confidence = tspComputeConfidence();
    s.pauseSuspicious = false;
    s.suspiciousCount = 0;
    s.anchorResetReason = 'track-change';
    s.anchorResets += 1;
    s.lastAction = 'track-reset';
    s.seekEvent = true;
    s.lastStableMs = 0;
    tspLogLine('TRACK_RESET oldExpected=' + tspSec(oldExpected) + ' raw=' + tspSec(raw) +
      ' track="' + identity + '"');
    // 刻意不 return: 当前这一拍就是新 anchor 的第一个候选 —— 立刻判定它是
    // "新歌的真实位置" 还是 "SMTC 还没换过来的上一首 position"。
    // 这样新歌第 1 拍就能定位，不需要先显示 0 等下一个 SMTC 样本(5s)。
  }

  // ---- 切歌后的陈旧样本排除 ----
  if (s.postTrackChange) {
    s.postTrackChangeSamples += 1;
    // 上一首的最后一次上报只会"落后于"旧时间轴，不会领先：
    // 位置落在 [旧时间轴 - 15s, 旧时间轴 + 1.5s] 内才可能是陈旧样本；
    // 落在窗口外 = 新歌的真实位置（例如上一首 30s -> 新歌中段 200s），直接采纳。
    var staleLow = s.oldTimelineExpectedMs - TSP_TRACK_STALE_LAG_MS;
    var staleHigh = s.oldTimelineExpectedMs + TSP_TRACK_STALE_GUARD_MS;
    var looksStale = raw > TSP_TRACK_STALE_MIN_MS && raw >= staleLow && raw <= staleHigh;
    if (!looksStale) {
      var anchorMs = raw + tspQuantizationCenterMs();
      s.basePositionMs = anchorMs;
      s.baseQpcMs = now;
      s.correctionRate = 1;
      s.sampleStableMs = anchorMs;
      s.floorMs = anchorMs;
      s.phase = playing ? 'playing' : 'paused';
      s.postTrackChange = false;
      s.confidence = tspComputeConfidence();
      s.lastAction = 'track-anchor';
      s.anchorResetReason = 'track-anchor';
      s.lastStableMs = s.basePositionMs;
      tspLogLine('track anchor accepted raw=' + tspSec(raw) + ' stable=' + tspSec(s.basePositionMs));
      return { stableMs: s.basePositionMs, action: 'track-anchor', seekEvent: justTrackChanged === true };
    }
    // 疑似上一首的 position：丢弃，保持新歌从 0 起跳
    if (s.postTrackChangeSamples < TSP_TRACK_PENDING_SAMPLES) {
      s.lastAction = justTrackChanged ? 'track-reset' : 'track-stale-skipped';
      var staleStable = tspStableMsAt(now);
      s.lastStableMs = staleStable;
      tspLogLine('stale post-track sample ignored raw=' + tspSec(raw) +
        ' (still ~ previous timeline ' + tspSec(s.oldTimelineExpectedMs) + ')');
      return { stableMs: staleStable, action: s.lastAction, seekEvent: true };
    }
    s.postTrackChange = false;   // 容忍结束: 交给常规校准(会以异常样本序列处理)
    tspLogLine('post-track guard exhausted, falling back to calibration');
  }

  // ---- Pause：确认暂停后停止推进本地时间轴 ----
  if (!playing) {
    var frozen = tspStableMsAt(now);
    s.basePositionMs = frozen;
    s.baseQpcMs = now;
    s.correctionRate = 1;
    s.phase = 'paused';
    s.sampleStableMs = frozen;
    s.floorMs = frozen;
    s.suspiciousCount = 0;
    s.confidence = tspComputeConfidence();
    s.lastAction = 'paused';
    s.lastStableMs = frozen;
    tspLogLine('paused: frozen at ' + tspSec(frozen) + ' (pcm=' + s.pcmState +
      ' conf=' + s.confidence.toFixed(2) + ')');
    return { stableMs: frozen, action: 'paused', seekEvent: false };
  }

  // ---- Resume / first play：重新读取一次 SMTC position 并重建 anchor ----
  if (s.phase !== 'playing') {
    var wasPaused = s.phase === 'paused';
    var resumeAnchor = raw + tspQuantizationCenterMs();
    s.basePositionMs = resumeAnchor;
    s.baseQpcMs = now;
    s.correctionRate = 1;
    s.sampleStableMs = resumeAnchor;
    s.floorMs = resumeAnchor;
    s.phase = 'playing';
    s.suspiciousCount = 0;
    s.confidence = tspComputeConfidence();
    s.lastAction = wasPaused ? 'resume' : 'first-play';
    s.anchorResets += 1;
    s.anchorResetReason = s.lastAction;
    s.seekEvent = true;
    s.lastStableMs = s.basePositionMs;
    tspLogLine((wasPaused ? 'resume' : 'first play') + ': re-anchored at raw=' + tspSec(raw) +
      ' stable=' + tspSec(s.basePositionMs));
    return { stableMs: s.basePositionMs, action: s.lastAction, seekEvent: true };
  }

  // ---- 常规校准 ----
  var stableAtSample = tspStableMsAt(now);
  var win = s.windowMs;
  var lower = raw - stableAtSample;                 // > 0 -> SMTC 下界领先我们（我们落后）
  var upper = raw + win - stableAtSample;           // < 0 -> SMTC 上界落后我们（我们领先）
  var err;
  if (lower > 0) err = lower;
  else if (upper < 0) err = upper;
  else err = 0;                                     // 落在不确定窗口内 = 噪声
  var absErr = Math.abs(err);
  s.errorMs = err;
  s.rawErrorMs = raw - stableAtSample;
  s.sampleStableMs = stableAtSample;                // 外推预算基准 = 本拍实际位置
  s.confidence = tspComputeConfidence();

  if (wasStalled && absErr >= TSP_SMALL_ERROR_MS) {
    // 失联恢复：本地时钟此前已被预算冻结（"长时间没有样本"本身就是持续确认），
    // 恢复后的第一个样本就是唯一可信的真值 -> 立即重建 anchor，不算"单次异常"。
    var resyncBase = raw + tspQuantizationCenterMs();
    s.basePositionMs = resyncBase;
    s.baseQpcMs = now;
    s.correctionRate = 1;
    s.sampleStableMs = resyncBase;
    s.floorMs = resyncBase;
    s.suspiciousCount = 0;
    s.suspiciousDeviationMs = 0;
    s.anchorResets += 1;
    s.anchorResetReason = 'stall-resync';
    s.seekEvent = true;
    s.lastAction = 'stall-resync';
    s.lastStableMs = resyncBase;
    tspLogLine('stalled timeline resync -> anchor reset raw=' + tspSec(raw) +
      ' stable=' + tspSec(resyncBase) + ' dev=' + tspSigned(deviationOf(raw, stableAtSample)) + 'ms');
    return { stableMs: resyncBase, action: 'stall-resync', seekEvent: true };
  }

  if (absErr < TSP_SMALL_ERROR_MS) {
    // A. 小误差：直接忽略（不为几十毫秒误差改 anchor）。
    //    但必须就地"结清"上一次的速率修正：先重基到当前稳定位置，再把速率恢复 1.0。
    //    只改 rate 不重基会在同一时刻产生一次可见跳变（rate*r人 elapsed 的差）。
    s.basePositionMs = stableAtSample;
    s.baseQpcMs = now;
    s.correctionRate = 1;
    s.suspiciousCount = 0;
    s.lastAction = err === 0 ? 'hold' : 'small-drift-ignored';
  } else if (absErr < TSP_LARGE_ERROR_MS) {
    // B. 中等误差：极低幅度 rate correction 慢慢消除（连续、不跳变、不回退）
    var k = err / TSP_CORRECTION_TIME_MS;
    if (k > TSP_MAX_RATE_DELTA) k = TSP_MAX_RATE_DELTA;
    if (k < -TSP_MAX_RATE_DELTA) k = -TSP_MAX_RATE_DELTA;
    var newRate = 1 + k;
    if (newRate > TSP_MAX_RATE) newRate = TSP_MAX_RATE;
    if (newRate < TSP_MIN_RATE) newRate = TSP_MIN_RATE;
    s.basePositionMs = stableAtSample;   // 连续性重基：此刻位置不变
    s.baseQpcMs = now;
    s.correctionRate = newRate;
    s.suspiciousCount = 0;
    s.lastAction = 'gradual-correction';
  } else {
    // C/D. 大误差：单次不可信，连续一致才可信
    var sign = err > 0 ? 1 : -1;
    var wrapLike = sign < 0 && s.durationMs > 0 &&
      stableAtSample > s.durationMs * TSP_WRAP_NEAR_END_RATIO &&
      (stableAtSample - raw) > s.durationMs * TSP_WRAP_MIN_BACKWARD_RATIO;
    var need = wrapLike ? TSP_CONFIRM_SAMPLES_WRAP : TSP_CONFIRM_SAMPLES;
    // "持续一致的异常"：目标位置以 1x 前进，且偏差本身基本不漂移。
    // 采样抖动/整秒量化会让偏差每次跳 500~1000ms -> 不满足一致性 -> 计数归零。
    var deviation = raw - stableAtSample;
    var consistent = false;
    if (s.suspiciousCount > 0 && s.suspiciousSign === sign) {
      var predictedTarget = s.suspiciousRefMs + (now - s.suspiciousAtQpcMs);
      var targetOk = Math.abs(raw - predictedTarget) <= TSP_SUSPICIOUS_TOLERANCE_MS;
      var driftOk = Math.abs(deviation - s.suspiciousDeviationMs) <= TSP_SUSPICIOUS_DRIFT_TOLERANCE_MS;
      if (targetOk && driftOk) consistent = true;
    }
    if (consistent) {
      s.suspiciousCount += 1;
    } else {
      s.suspiciousCount = 1;
      s.suspiciousSign = sign;
      s.suspiciousRefMs = raw;
      s.suspiciousAtQpcMs = now;
    }
    s.suspiciousDeviationMs = deviation;
    s.suspiciousNeeded = need;
    if (s.suspiciousCount < need) {
      s.lastAction = 'suspicious-' + s.suspiciousCount + '-' + need;
      tspLogLine('suspicious sample ' + s.suspiciousCount + '/' + need +
        ' (sign=' + (sign > 0 ? '+' : '-') + ')');
    } else {
      // 确认真实外部进度改变：重建 anchor（spec: basePosition = smtcPosition）
      var reason = wrapLike ? 'repeat-restart' : 'confirmed-seek';
      var newBase = raw + tspQuantizationCenterMs();
      s.basePositionMs = newBase;
      s.baseQpcMs = now;
      s.correctionRate = 1;
      s.sampleStableMs = newBase;
      s.floorMs = newBase;
      s.suspiciousCount = 0;
      s.suspiciousSign = 0;
      s.anchorResets += 1;
      s.anchorResetReason = reason;
      s.seekEvent = true;
      s.lastAction = reason;
      s.lastStableMs = newBase;
      tspLogLine('confirmed ' + (wrapLike ? 'repeat restart' : 'seek') + ' -> anchor reset raw=' +
        tspSec(raw) + ' stable=' + tspSec(newBase) + ' dev=' + tspSigned(raw - stableAtSample) + 'ms');
      return { stableMs: newBase, action: reason, seekEvent: true };
    }
  }

  s.lastStableMs = tspStableMsAt(now);
  tspLogSample(raw, s.lastStableMs, err, null);
  return {
    stableMs: s.lastStableMs,
    action: s.lastAction,
    seekEvent: s.seekEvent,
    errorMs: err,
    rate: s.correctionRate
  };
}

// ------------------------------------------------------------
// 配置 / 调试 API
// ------------------------------------------------------------
function tspSetDebug(on) {
  tspDebugOn = on === true;
  try { localStorage.setItem(TSP_DEBUG_STORAGE_KEY, tspDebugOn ? '1' : '0'); } catch (e) { }
  console.log('[TSP] debug logging ' + (tspDebugOn ? 'ENABLED' : 'DISABLED'));
  return tspDebugOn;
}
function tspSetMode(mode) {
  mode = String(mode || '');
  if (mode !== 'tsp' && mode !== 'legacy') return tspTimelineMode;
  if (mode === tspTimelineMode) return tspTimelineMode;
  // 交接点：先把当前 Plus 位置取出来，两个方向都做"就地接力"，A/B 切换不产生跳变。
  var handoffMs = tspStableMsNow();
  tspTimelineMode = mode;
  try { localStorage.setItem(TSP_MODE_STORAGE_KEY, mode); } catch (e) { }
  tspState.phase = 'idle';
  tspState.basePositionMs = 0;
  tspState.baseQpcMs = tspQpcNow();
  tspState.correctionRate = 1;
  tspState.sampleStableMs = 0;
  tspState.floorMs = 0;
  tspState.suspiciousCount = 0;
  tspState.postTrackChange = false;
  tspState.identity = '';
  tspState.lastAction = 'mode-' + mode;
  if (mode === 'legacy') {
    // 交给 v4：用当前位置锚定 legacy 平滑器（否则它会从 0 开始追）
    if (typeof smtcSeedLegacyAnchor === 'function') smtcSeedLegacyAnchor(handoffMs);
  } else {
    // 接管：用当前位置起跳，等下一个 SMTC 样本再校准（不继承 legacy 的 anchor 语义）
    var qpc = tspQpcNow();
    var playing = false;
    try { playing = typeof smtcStore === 'object' && smtcStore && smtcStore.active === true && smtcStore.isPlaying === true; } catch (e2) { playing = false; }
    tspState.phase = playing ? 'playing' : 'paused';
    tspState.basePositionMs = Math.max(0, handoffMs);
    tspState.baseQpcMs = qpc;
    tspState.correctionRate = 1;
    tspState.sampleStableMs = Math.max(0, handoffMs);
    tspState.floorMs = Math.max(0, handoffMs);
  }
  console.log('[TSP] timeline mode = ' + mode + ' (legacy = v4 fallback)');
  if (mode === 'tsp') {
    try {
      var api = window.desktopWindow;
      if (api && typeof api.refreshSmtcSession === 'function') api.refreshSmtcSession();
    } catch (e) { }
  }
  return tspTimelineMode;
}
function tspLoadConfig() {
  try {
    var d = localStorage.getItem(TSP_DEBUG_STORAGE_KEY);
    tspDebugOn = (d === '1');
  } catch (e) { tspDebugOn = false; }
  try {
    var m = localStorage.getItem(TSP_MODE_STORAGE_KEY);
    if (m === 'legacy') tspTimelineMode = 'legacy';
  } catch (e) { }
}
function tspSnapshot() {
  var s = tspState;
  return {
    mode: tspTimelineMode,
    enabled: tspTimelineEnabled,
    phase: s.phase,
    identity: s.identity,
    basePositionMs: s.basePositionMs,
    baseQpcMs: s.baseQpcMs,
    correctionRate: s.correctionRate,
    floorMs: s.floorMs,
    sampleStableMs: s.sampleStableMs,
    stableMs: tspStableMsNow(),
    errorMs: s.errorMs,
    windowMs: s.windowMs,
    quantumMs: s.quantumMs,
    suspiciousCount: s.suspiciousCount,
    suspiciousNeeded: s.suspiciousNeeded,
    anchorResets: s.anchorResets,
    anchorResetReason: s.anchorResetReason,
    lastAction: s.lastAction,
    sampleCount: s.sampleCount,
    confidence: s.confidence,
    pcmState: s.pcmState,
    pauseSuspicious: s.pauseSuspicious,
    clockSource: s.clockSource
  };
}

// ---- 初始化（12-smtc 末尾模块；任何异常不得中断后续模块）----
(function tspInit() {
  try {
    for (var i = 0; i < TSP_PCM_WINDOW_TICKS; i++) tspState.pcmRing[i] = -1;
    tspState.pcmTicks = 0;
    tspLoadConfig();
    if (!tspIsAvailable()) {
      tspTimelineEnabled = false;
      console.warn('[TSP] high-resolution monotonic clock unavailable -> v4 legacy smoother stays in charge');
    } else {
      tspState.baseQpcMs = tspQpcNow();
    }
    setInterval(tspTick, TSP_PCM_TICK_MS);
    console.log('[TSP] Timeline Stabilizer Plus ready (mode=' + tspTimelineMode +
      ', clock=' + tspState.clockSource + ', debug=' + (tspDebugOn ? 'on' : 'off') + ')');
  } catch (e) {
    tspTimelineEnabled = false;
    try { console.error('[TSP] init failed:', e && e.message || e); } catch (e2) { }
  }
})();

// ---- 调试入口（window 上；供 A/B 测试与现场诊断）----
if (typeof window !== 'undefined' && window) {
  try { window.smtcTspSnapshot = tspSnapshot; } catch (e) { }
  try { window.smtcTspDump = tspDebugDump; } catch (e) { }
  try { window.smtcTspSetDebug = tspSetDebug; } catch (e) { }
  try { window.smtcTspSetMode = tspSetMode; } catch (e) { }
  try { window.smtcTspStableSeconds = function () { return tspStableMsNow() / 1000; }; } catch (e) { }
  try { window.smtcTspReset = function () { tspResetAnchor('manual', tspState.lastRawMs); return tspSnapshot(); }; } catch (e) { }
}
