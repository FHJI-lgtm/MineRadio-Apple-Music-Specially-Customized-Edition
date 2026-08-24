// ============================================================
// 12-smtc/02-smtc-player.js
// 外部歌词播放器：把统一 MediaState.position 映射到歌词行
//
// 只读 smtcPositionSecondsNow()，通过两个 hook 驱动现有舞台：
//   externalStageLyricActive()  —— 舞台 tick 是否进入外部模式
//   externalStageLyricSeconds() —— 外部模式下的当前时间（秒）
//
// 歌词行 hysteresis（时间源级别）：
//   - 时间轴因 SMTC 修正出现几十~几百 ms 的小幅回退时，保持上一次
//     返回的时间，不把歌词行带回上一句
//   - 检测到真实 seek（store 的跳变标记）时立即放行，允许回退/跳转
// 内部播放器活跃时外部模式自动让位（不破坏现有播放/歌词功能）。
// ============================================================
var smtcPlayerCfg = { enabled: true, ticker: 0, lastChipText: '' };
var smtcHoldLastSec = -1;

function internalAudioPlayingNow() {
  return !!(playing && audio && audio.src && !audio.paused);
}

function smtcExternalLyricActive() {
  return smtcPlayerCfg.enabled !== false &&
    smtcStore.active === true &&
    smtcLyricState.loaded === true &&
    smtcLyricState.hasLyrics === true &&
    !internalAudioPlayingNow();
}

function externalStageLyricActive() {
  return smtcExternalLyricActive();
}

function externalStageLyricSeconds() {
  if (!smtcExternalLyricActive()) {
    smtcHoldLastSec = -1;
    return null;
  }
  var raw = smtcPositionSecondsNow();
  if (raw < 0) {
    smtcHoldLastSec = -1;
    return null;
  }
  // 真实 seek / 切歌：立即放行（允许歌词行回退/跳转）
  if (typeof smtcConsumeSeekFlag === 'function' && smtcConsumeSeekFlag()) {
    smtcHoldLastSec = raw;
    return raw;
  }
  // 小幅时间轴回退（<100ms）：保持上一次时间，防止歌词行来回切换
  if (smtcHoldLastSec >= 0 && raw < smtcHoldLastSec - 0.10) {
    return smtcHoldLastSec;
  }
  smtcHoldLastSec = raw;
  return raw;
}

function smtcStageIsPlayingExternal() {
  return smtcExternalLyricActive() && smtcStore.isPlaying === true;
}

function smtcTick() {
  if (typeof smtcRenderChip === 'function') smtcRenderChip();
}

function smtcStartTicker() {
  if (smtcPlayerCfg.ticker) return;
  smtcPlayerCfg.ticker = setInterval(smtcTick, 300);
}
