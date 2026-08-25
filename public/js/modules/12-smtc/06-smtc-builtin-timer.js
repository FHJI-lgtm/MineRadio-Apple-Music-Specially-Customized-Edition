// ============================================================
// 12-smtc/06-smtc-builtin-timer.js
// 可选的歌词时间轴来源: Built-in Timer (最小侵入, 非第二套播放器)
//
// SMTC 仍负责: 歌曲识别 / 播放状态 / 封面 / 播放控制 / MediaState。
// 本模块只切换"歌词渲染的 currentTime 来源":
//   SMTC 模式  : 完全使用 Timeline Stabilizer v4 (00/02 零修改)
//   BUILT_IN 模式: performance.now() 锚点计时器驱动歌词时间
//
// 模型 (用户指定, 不改变):
//   playing : currentTime = anchorPositionMs + (performance.now() - anchorTimestamp)
//   paused  : currentTime = 冻结的 position
//   切歌    : reset(0)  (title/artist/aumid 变化, 绝不继承上一首时间)
//   seek    : 不消费 SMTC Position (无可靠 seek 事件, 本次不处理)
//
// 注入点: 覆盖 smtcPositionSecondsNow() (赋值式, 保存原函数, 零递归);
// 歌词渲染层 (02/03) 调用时按全局函数名解析, 自动生效。
// BUILT_IN 模式不叠加 Session Delay (本地时钟, 避免重复补偿)。
// 不修改: 00 v4 / 02 / SMTC bridge / artwork / particle / WASAPI / FFT /
//         歌词源 / 翻译 / 搜索 / 排序 / 独立窗口。
// ============================================================
var lyricTimelineMode = 'SMTC';               // 'SMTC' | 'BUILT_IN'
var SMTC_TIMELINE_MODE_KEY = 'mineradio.lyricTimelineMode';

// ---- Built-in 计时器 (performance.now() 锚点) ----
var BuiltInLyricTimer = {
  positionMs: 0,
  anchorPositionMs: 0,
  anchorTimestamp: 0,
  isPlaying: false,
  reset: function (positionMs) {
    this.positionMs = positionMs || 0;
    this.anchorPositionMs = this.positionMs;
    this.anchorTimestamp = performance.now();
  },
  play: function () {
    this.anchorPositionMs = this.getPosition();
    this.anchorTimestamp = performance.now();
    this.isPlaying = true;
  },
  pause: function () {
    this.positionMs = this.getPosition();
    this.anchorPositionMs = this.positionMs;
    this.anchorTimestamp = performance.now();
    this.isPlaying = false;
  },
  getPosition: function () {
    if (!this.isPlaying) return this.positionMs;
    return this.anchorPositionMs + (performance.now() - this.anchorTimestamp);
  },
};

// ---- 模式状态 / 持久化 ----
function smtcLyricTimelineMode() {
  return lyricTimelineMode;
}

// 切换歌词时间轴来源。不触碰 SMTC / MediaState / 封面 / 播放器 / 歌词。
function smtcSetLyricTimelineMode(mode) {
  if (mode !== 'BUILT_IN' && mode !== 'SMTC') return lyricTimelineMode;
  if (mode === lyricTimelineMode) return mode;
  if (mode === 'BUILT_IN') {
    // 从当前可获取的歌词时间开始 (v4 输出; 拿不到则从 0)
    var cur = 0;
    try {
      var v = smtcPositionSecondsNow();
      if (isFinite(v) && v > 0) cur = v * 1000;
    } catch (e) { cur = 0; }
    BuiltInLyricTimer.reset(cur);
    // 同步当前歌曲身份, 避免首次 tick 把当前歌误判为"切歌"而 reset(0)
    smtcBuiltinTimerTrackKey = smtcBuiltinTrackKeyOf();
    if (smtcStore && smtcStore.active === true && smtcStore.isPlaying === true) BuiltInLyricTimer.play();
  }
  lyricTimelineMode = mode;
  try { localStorage.setItem(SMTC_TIMELINE_MODE_KEY, mode); } catch (e) { }
  smtcUpdateSessionDelayEnabledState();
  smtcRenderBuiltinTimerUi();
  console.log('[Renderer][' + Date.now() + '] lyric timeline mode set: ' + mode);
  return mode;
}

// ---- 状态机驱动 (由 300ms ticker 调用; SMTC 仍是播放器状态唯一来源) ----
var smtcBuiltinTimerTicker = 0;
var smtcBuiltinTimerTrackKey = '';   // 注意: 变量名不能与函数重名 (var 赋值会覆盖函数声明)

function smtcBuiltinTrackKeyOf() {
  if (!smtcStore || smtcStore.active !== true) return '';
  return String(smtcStore.title || '') + '|' + String(smtcStore.artist || '') + '|' + String(smtcStore.aumid || '');
}

function smtcBuiltinTimerTick() {
  try {
    if (!smtcStore || smtcStore.active !== true) {
      if (BuiltInLyricTimer.isPlaying || BuiltInLyricTimer.positionMs !== 0 || smtcBuiltinTimerTrackKey !== '') {
        BuiltInLyricTimer.reset(0);
        BuiltInLyricTimer.isPlaying = false;   // 完整重置, 避免残留 running
        smtcBuiltinTimerTrackKey = '';
      }
      return;
    }
    var key = smtcBuiltinTrackKeyOf();
    var playing = smtcStore.isPlaying === true;
    if (key !== smtcBuiltinTimerTrackKey) {
      // 切歌 (或首次): reset(0), 绝不继承上一首时间
      BuiltInLyricTimer.reset(0);
      smtcBuiltinTimerTrackKey = key;
      if (playing) BuiltInLyricTimer.play();
    } else if (playing && !BuiltInLyricTimer.isPlaying) {
      BuiltInLyricTimer.play();
    } else if (!playing && BuiltInLyricTimer.isPlaying) {
      BuiltInLyricTimer.pause();
    }
  } catch (e) { /* 永不中断主循环 */ }
}

// ---- 输出注入: 歌词渲染 currentTime 二选一 (赋值式覆盖, 无递归) ----
var smtcOrigPositionSecondsNow = typeof smtcPositionSecondsNow === 'function' ? smtcPositionSecondsNow : null;
smtcPositionSecondsNow = function () {
  if (lyricTimelineMode === 'BUILT_IN') {
    if (!smtcStore || smtcStore.active !== true) return -1;
    // BUILT_IN 不叠加 Session Delay (本地 performance.now() 时钟, 避免重复补偿)
    var p = BuiltInLyricTimer.getPosition() / 1000;
    var duration = smtcDurationSeconds();
    if (duration > 0 && p > duration + 2) p = duration;
    return Math.max(0, p);
  }
  // SMTC 模式: 完全走 v4 (含 Session Delay)
  return smtcOrigPositionSecondsNow ? smtcOrigPositionSecondsNow() : 0;
};

// ---- Session Delay 禁用联动 (BUILT_IN 时禁用/置灰) ----
function smtcUpdateSessionDelayEnabledState() {
  try {
    var disabled = lyricTimelineMode === 'BUILT_IN';
    var slot = document.getElementById('smtc-hover-delay-slot');
    if (!slot) return;
    var btns = slot.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = disabled;
      btns[i].style.opacity = disabled ? '0.4' : '';
      btns[i].style.cursor = disabled ? 'default' : '';
    }
    var val = document.getElementById('smtc-session-delay-val');
    if (val) val.style.opacity = disabled ? '0.4' : '';
  } catch (e) { }
}

// ---- UI: 【使用内置计时器】开关 (hover 面板, Session Delay 上方) ----
function smtcEnsureBuiltinTimerUi() {
  try {
    var slot = document.getElementById('smtc-hover-delay-slot');
    if (!slot || document.getElementById('smtc-builtin-timer-block')) return;
    var block = document.createElement('div');
    block.id = 'smtc-builtin-timer-block';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 8px;margin:2px 0;border-radius:6px;background:rgba(255,255,255,0.05);cursor:pointer;';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'smtc-builtin-timer-cb';
    cb.style.cssText = 'cursor:pointer;';
    cb.addEventListener('change', function () {
      smtcSetLyricTimelineMode(cb.checked ? 'BUILT_IN' : 'SMTC');
    });
    var label = document.createElement('span');
    label.textContent = '使用内置计时器';
    label.style.cssText = 'flex:1;';
    var desc = document.createElement('span');
    desc.textContent = '忽略播放器传入位置';
    desc.style.cssText = 'opacity:0.5;font-size:10px;';
    row.appendChild(cb);
    row.appendChild(label);
    row.appendChild(desc);
    block.appendChild(row);
    var hint = document.createElement('div');
    hint.textContent = '部分播放器传递的时间轴可能不稳定。开启后将忽略播放器传入的播放位置，使用内置高精度计时器驱动歌词。';
    hint.style.cssText = 'margin:0 2px 6px;opacity:0.5;font-size:10px;line-height:1.4;';
    block.appendChild(hint);
    slot.parentNode.insertBefore(block, slot);
    smtcRenderBuiltinTimerUi();
  } catch (e) { }
}

function smtcRenderBuiltinTimerUi() {
  try {
    var cb = document.getElementById('smtc-builtin-timer-cb');
    if (cb) cb.checked = lyricTimelineMode === 'BUILT_IN';
  } catch (e) { }
}

// ---- 初始化 (06 是 12-smtc 最后模块; 全部 try/catch, 任何异常不中断后续模块) ----
(function smtcBuiltinTimerInit() {
  try {
    var v = 'SMTC';
    try {
      var raw = localStorage.getItem(SMTC_TIMELINE_MODE_KEY);
      if (raw === 'BUILT_IN') v = 'BUILT_IN';
    } catch (e) { }
    lyricTimelineMode = v;
    smtcEnsureBuiltinTimerUi();
    smtcBuiltinTimerTicker = setInterval(smtcBuiltinTimerTick, 300);
    smtcUpdateSessionDelayEnabledState();
    console.log('[Renderer][' + Date.now() + '] built-in lyric timer initialized, mode=' + v);
  } catch (e) {
    console.error('[Renderer] built-in timer init failed:', e && e.message || e);
  }
})();
