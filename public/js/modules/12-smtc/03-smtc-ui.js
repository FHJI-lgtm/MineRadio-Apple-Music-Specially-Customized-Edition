// ============================================================
// 12-smtc/03-smtc-ui.js
// 系统媒体（SMTC）状态胶囊：歌名/歌手/进度/播放状态/歌词状态 + 开关
// 点击胶囊切换外部歌词模式；内部播放时显示让位状态。
// ============================================================
function smtcFormatTime(seconds) {
  seconds = Math.max(0, Math.round(Number(seconds) || 0));
  var m = Math.floor(seconds / 60);
  var s = seconds % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function smtcChipText() {
  var parts = [];
  var internal = internalAudioPlayingNow();
  var debugTail = smtcStore.debug ? (' [' + smtcStore.debug + ']') : '';
  if (smtcStore.error) {
    parts.push('SMTC: ERROR - ' + smtcStore.error.slice(0, 120));
  } else if (!smtcStore.bridgeReady) {
    parts.push('SMTC: CONNECTING' + debugTail);
  } else if (!smtcStore.active) {
    parts.push('SMTC: NO SESSION（播放 Apple Music 后自动同步）' + debugTail);
  } else if (internal) {
    parts.push('SMTC: RECEIVING · 内部播放中，外部歌词已让位');
  } else {
    parts.push('SMTC: RECEIVING');
    var title = smtcStore.title || '未知歌曲';
    var artist = smtcStore.artist || '';
    var pos = smtcPositionSecondsNow();
    var dur = smtcDurationSeconds();
    var progressText = pos >= 0 ? (smtcFormatTime(pos) + (dur > 0 ? '/' + smtcFormatTime(dur) : '')) : '';
    var statusIcon = smtcStore.isPlaying ? '●' : '⏸';
    parts.push(statusIcon + ' ' + title + (artist ? ' - ' + artist : ''));
    if (progressText) parts.push(progressText);
    if (smtcLyricState.loading) parts.push('匹配歌词中…');
    else if (smtcLyricState.error === 'no-lyrics' || (!smtcLyricState.hasLyrics && smtcLyricState.loaded)) parts.push('未找到歌词');
    else if (smtcLyricState.error === 'lyric-fetch-failed') parts.push('歌词获取失败');
    else if (smtcLyricState.error === 'no-title') parts.push('缺少歌曲信息');
    else if (smtcLyricState.hasLyrics) parts.push('歌词已同步' + (smtcLyricState.source && typeof smtcLyricSourceName === 'function' ? ' · 歌词来源：' + smtcLyricSourceName(smtcLyricState.source) : ''));
    if (smtcPlayerCfg.enabled === false) parts.push('外部歌词已关闭');
  }
  // Audio（外部音频捕获）状态 — 经 AudioAdapter
  var audioLine = 'Audio: NOT CONNECTED';
  var audioStatus = smtcAudioStatus();
  if (audioStatus === 'fake') {
    audioLine = 'Audio: FAKE TEST (Phase 1)';
  } else if (audioStatus === 'disabled') {
    audioLine = 'Audio: DISABLED (flag off)';
  } else if (smtcAudioState.error) {
    audioLine = 'Audio: FAILED (' + smtcAudioState.error.slice(0, 60) + (smtcAudioState.hr ? ' ' + smtcAudioState.hr : '') + ')';
  } else if (smtcAudioState.active) {
    if (smtcAudioState.mode === 'system-mix-fallback') audioLine = 'Audio: SYSTEM MIX (fallback)';
    else audioLine = 'Audio: EXTERNAL · APPLE MUSIC' + (smtcAudioState.sourceName ? ' (' + smtcAudioState.sourceName + ')' : '');
  }
  parts.push(audioLine);
  return parts.filter(Boolean).join(' · ');
}

function smtcEnsureChip() {
  var chip = document.getElementById('smtc-chip');
  if (chip) return chip;
  chip = document.createElement('div');
  chip.id = 'smtc-chip';
  chip.setAttribute('role', 'status');
  chip.title = '系统媒体歌词同步（点击切换）';
  chip.style.cssText = [
    'position:fixed',
    'top:64px',
    'right:16px',
    'z-index:4800',
    'max-width:60vw',
    'padding:6px 10px',
    'border-radius:10px',
    'font-size:11px',
    'line-height:1.45',
    'color:rgba(255,255,255,0.78)',
    'background:rgba(14,16,18,0.82)',
    'border:1px solid rgba(255,255,255,0.10)',
    'cursor:pointer',
    'user-select:none',
    'white-space:normal',
    'pointer-events:auto',
  ].join(';');
  chip.addEventListener('click', function (e) {
    e.stopPropagation();
    smtcToggleEnabled();
  });
  document.body.appendChild(chip);
  return chip;
}

// ---- Phase 4A: SMTC 专辑封面 ----
function smtcEnsureCover() {
  var img = document.getElementById('smtc-cover');
  if (img) return img;
  img = document.createElement('img');
  img.id = 'smtc-cover';
  img.style.cssText = [
    'position:fixed',
    'top:120px',
    'right:16px',
    'z-index:4799',
    'width:64px',
    'height:64px',
    'border-radius:8px',
    'object-fit:cover',
    'display:none',
    'border:1px solid rgba(255,255,255,0.14)',
    'background:rgba(14,16,18,0.6)',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(img);
  // Phase 4A.2: 图片解码/加载失败 -> 隐藏封面并清 store (不清 Main cache, 仅 UI 侧隐藏)
  img.addEventListener('error', function () {
    console.log('[Renderer][' + Date.now() + '] SMTC thumbnail image load failed');
    try {
      if (smtcStore) smtcStore.thumbnail = null;
      img.removeAttribute('src');
      img.style.display = 'none';
      if (typeof onSmtcThumbnailChanged === 'function') onSmtcThumbnailChanged(null);
    } catch (_) {}
  });
  return img;
}

function smtcUpdateCover() {
  var img = smtcEnsureCover();
  var src = smtcStore.thumbnail || '';
  if (src) {
    if (img.src !== src) img.src = src;
    img.style.display = 'block';
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
  }
}

// ---- Phase 4A.3: SMTC thumbnail -> Visualizer 背景粒子封面 ----
// 复用内部播放器同一视觉入口, 不新建纹理系统:
//   内部切歌: trackSwitchToken++ -> applyCoverDataUrl/loadCoverFromUrl -> applyCoverCanvas (WebGL 纹理唯一上传点)
//   外部 SMTC: 歌曲 identity 变化 -> 本适配器 -> 同一个 applyCoverCanvas
// 防串台:
//   - smtcVisualCoverSeq: SMTC 调用时点令牌, 旧请求(晚返回)直接丢弃
//   - coverApplyStillCurrent({trackToken: trackSwitchToken}): 期间内部切歌则失效
//   - applyCoverCanvas 内部 coverProcessToken: 新旧封面异步重活互斥
var smtcVisualCoverSeq = 0;
function smtcApplyVisualizerCover(thumb) {
  // 内部播放器正在播放时让位 (视觉所有权归内部播放器)
  if (typeof internalAudioPlayingNow === 'function' && internalAudioPlayingNow()) return;
  if (thumb && typeof thumb === 'string') {
    if (typeof applyCoverCanvas !== 'function' || !smtcStore || !smtcStore.active) return;
    var seq = ++smtcVisualCoverSeq;
    // 与内部播放器一致: 请求时点捕获 trackToken (而非 onload 时点), 期间内部切歌则失效
    var requestToken = trackSwitchToken;
    var img = new Image();
    img.decoding = 'async';
    img.onload = function () {
      if (seq !== smtcVisualCoverSeq) return;   // 旧歌曲请求晚返回: 丢弃
      if (typeof internalAudioPlayingNow === 'function' && internalAudioPlayingNow()) return; // 解码期间内部开始播放: 让位
      if (typeof coverApplyStillCurrent !== 'function' || !coverApplyStillCurrent({ trackToken: requestToken })) return;
      if (typeof makeSquareCoverCanvas !== 'function' || typeof coverTextureSizeForResolution !== 'function') return;
      var cv = makeSquareCoverCanvas(img, coverTextureSizeForResolution(fx.coverResolution));
      applyCoverCanvas(cv, thumb, {
        trackToken: requestToken,
        coverSourceKind: 'data',
        coverSource: thumb,
        coverKey: thumb,
        deferHeavy: true,
        delay: 80,
        timeout: 900,
      });
      console.log('[Renderer][' + Date.now() + '] SMTC visualizer cover applied (' + thumb.length + ' chars)');
    };
    img.onerror = function () {}; // 解码失败: 保持当前视觉 (与内部失败路径一致静默)
    img.src = thumb;
    return;
  }
  // thumbnail 为 null (Apple Music 关闭/会话结束): 回到 MineRadio 默认 fallback (idle 视觉)
  if (typeof loadCoverFromUrl === 'function') {
    loadCoverFromUrl('');
    console.log('[Renderer][' + Date.now() + '] SMTC visualizer cover cleared (inactive)');
  }
}

// ---- Phase 4B: SMTC 播放控制 (上一首 / 播放暂停 / 下一首) ----
// 数据流: Renderer -> preload smtcControl -> Main smtcControl -> bridge stdin
//        -> GlobalSystemMediaTransportControlsSession TryXXXAsync -> Apple Music
// 按钮状态只由 SMTC 事件驱动 (smtcStore.active / smtcStore.isPlaying), 点击后
// 不本地改状态, 等 PlaybackInfoChanged 回推 -> UI 自动更新。
var smtcControlDefs = [
  { cmd: 'previous', icon: '⏮', title: '上一首' },
  { cmd: 'toggle', icon: '▶', title: '播放 / 暂停' },
  { cmd: 'next', icon: '⏭', title: '下一首' },
];
function smtcEnsureControls() {
  var bar = document.getElementById('smtc-controls');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'smtc-controls';
  bar.style.cssText = [
    'position:fixed',
    'top:192px',
    'right:16px',
    'z-index:4798',
    'display:flex',
    'gap:6px',
    'align-items:center',
    'pointer-events:auto',
  ].join(';');
  for (var i = 0; i < smtcControlDefs.length; i++) {
    (function (def) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = def.icon;
      btn.title = def.title;
      btn.style.cssText = [
        'width:30px',
        'height:30px',
        'border-radius:8px',
        'border:1px solid rgba(255,255,255,0.14)',
        'background:rgba(14,16,18,0.82)',
        'color:rgba(255,255,255,0.85)',
        'font-size:14px',
        'line-height:1',
        'cursor:pointer',
        'user-select:none',
        'opacity:0.35',
      ].join(';');
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        smtcControlCommand(def.cmd);
      });
      bar.appendChild(btn);
    })(smtcControlDefs[i]);
  }
  document.body.appendChild(bar);
  return bar;
}

function smtcUpdateControls() {
  var bar = document.getElementById('smtc-controls');
  if (!bar) return;
  var internal = typeof internalAudioPlayingNow === 'function' && internalAudioPlayingNow();
  var enabled = smtcStore.active === true && !internal;   // 无 session 或内部播放时 disabled
  var buttons = bar.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].disabled = !enabled;
    buttons[i].style.opacity = enabled ? '1' : '0.35';
  }
  var toggleBtn = buttons[1];
  if (toggleBtn) {
    // 只读 smtcStore.isPlaying (由 SMTC PlaybackInfoChanged 回推)
    toggleBtn.textContent = smtcStore.isPlaying ? '⏸' : '▶';
  }
}

function smtcControlCommand(cmd) {
  var api = window.desktopWindow;
  if (!api || typeof api.smtcControl !== 'function') {
    console.log('[Renderer][' + Date.now() + '] SMTC control unavailable (preload missing)');
    return;
  }
  api.smtcControl(cmd).then(function (result) {
    console.log('[Renderer][' + Date.now() + '] SMTC control ' + cmd + ' -> success=' + !!(result && result.success) +
      (result && result.error ? ' error=' + result.error : ''));
    if (!result || result.success !== true) {
      if (typeof showToast === 'function') showToast('SMTC 控制失败: ' + ((result && result.error) || cmd));
    }
  }).catch(function () {
    console.log('[Renderer][' + Date.now() + '] SMTC control ' + cmd + ' promise rejected');
  });
}

// 由 00-smtc-store.js 的 thumbnail 事件回调调用 (函数提升, 跨 bundle 可用)
function onSmtcThumbnailChanged(thumb) {
  smtcUpdateCover();
  smtcApplyVisualizerCover(thumb);
}

function smtcRenderChip() {
  var chip = document.getElementById('smtc-chip');
  if (!chip) return;
  smtcUpdateCover();    // Phase 4A: 封面随 ticker 同步 (事件即时 + 此处兜底)
  smtcUpdateControls(); // Phase 4B: 控制按钮状态/图标随 ticker 同步 (事件即时 + 此处兜底)
  var text = smtcChipText();
  if (text === smtcPlayerCfg.lastChipText) return;
  smtcPlayerCfg.lastChipText = text;
  chip.textContent = text;
  chip.style.opacity = smtcStore.active || !smtcStore.bridgeReady ? '1' : '0.55';
  console.log('[UI][' + Date.now() + '] chip updated (T10): ' + text.slice(0, 120));
}

function smtcToggleEnabled() {
  smtcPlayerCfg.enabled = smtcPlayerCfg.enabled === false;
  smtcPlayerCfg.lastChipText = '';
  if (!smtcPlayerCfg.enabled) {
    smtcLyricState.seq += 1;
    smtcLyricState.loaded = false;
    smtcLyricState.hasLyrics = false;
    smtcClearLyrics();
  } else if (smtcStore.active) {
    smtcLyricState.identity = '';
    onSmtcStateChanged(false, false);
  }
  smtcRenderChip();
  showToast(smtcPlayerCfg.enabled ? '系统媒体歌词同步已开启' : '系统媒体歌词同步已关闭');
}

function smtcInit() {
  smtcEnsureChip();
  smtcEnsureControls(); // Phase 4B: 播放控制按钮
  initSmtcStore();
  initSmtcAudio();
  smtcStartTicker();
  smtcRenderChip();
}

smtcInit();
