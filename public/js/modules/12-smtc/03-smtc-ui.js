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
    else if (smtcLyricState.hasLyrics) parts.push('歌词已同步' + (function () {
      // 复用统一来源展示: 原文/翻译来自不同源时显示 "原文：X · 翻译：Y"
      var credit = (typeof lyricSourceCreditText === 'function') ? String(lyricSourceCreditText() || '') : '';
      if (!credit && smtcLyricState.source && typeof smtcLyricSourceName === 'function') credit = '来源：' + smtcLyricSourceName(smtcLyricState.source);
      return credit ? ' · ' + credit : '';
    })());
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

// ============================================================
// 同步设置的隐藏宿主（原右上角浮动簇删除后留下的唯一职责）
// 三个设置节点由既有模块按 id 查找，因此在这里创建、由「词 → 同步设置」打开时搬出到面板中：
//   #smtc-session-row        会话状态 + 刷新会话（03）
//   #smtc-hover-delay-slot   会话延迟块挂载点（05 渲染）与内置计时器块（06 插在它前面）
// 宿主本身 display:none，搬出隐藏子树后即正常显示。
// ============================================================
function smtcEnsureSettingsHost() {
  var host = document.getElementById('smtc-settings-host');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'smtc-settings-host';
  host.style.cssText = 'display:none';
  var row = document.createElement('div');
  row.id = 'smtc-session-row';
  row.style.cssText = 'display:flex;align-items:center;gap:6px';
  var status = document.createElement('span');
  status.id = 'smtc-session-status';
  status.style.cssText = 'flex:1;opacity:0.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  var refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.id = 'smtc-session-refresh-btn';
  refreshBtn.textContent = '🔄 刷新会话';
  refreshBtn.title = '重新同步当前 SMTC 会话（播放信息/进度/歌曲状态）';
  refreshBtn.style.cssText = [
    'padding:4px 8px', 'border-radius:6px', 'font-size:10px',
    'color:rgba(255,255,255,0.8)', 'background:rgba(255,255,255,0.08)',
    'border:1px solid rgba(255,255,255,0.14)', 'cursor:pointer', 'user-select:none',
    'flex-shrink:0',
  ].join(';');
  refreshBtn.addEventListener('click', function () { smtcRefreshSmtcSession(); });
  row.appendChild(status);
  row.appendChild(refreshBtn);
  var delaySlot = document.createElement('div');
  delaySlot.id = 'smtc-hover-delay-slot';   // 沿用既有 id: 05/06 与同步设置面板都按它查找
  host.appendChild(row);
  host.appendChild(delaySlot);
  document.body.appendChild(host);
  return host;
}

//   外部 SMTC: 歌曲 identity 变化 -> 本适配器 -> 同一个 applyCoverCanvas
// 防串台:
//   - smtcVisualCoverSeq: SMTC 调用时点令牌, 旧请求(晚返回)直接丢弃
//   - coverApplyStillCurrent({trackToken: trackSwitchToken}): 期间内部切歌则失效
//   - applyCoverCanvas 内部 coverProcessToken: 新旧封面异步重活互斥
var smtcVisualCoverSeq = 0;
// [FIX 1] watchdog 重启后 thumbnail 事件先于 active state 到达 (inactive 状态) 时的挂起位:
// 只缓存一次尚未应用的 thumbnail, active 恢复后由 00-smtc-store.js 冲刷。不引入任何定时器/轮询/新 IPC。
var smtcVisualCoverPending = null;
function smtcApplyVisualizerCover(thumb) {
  // 内部播放器正在播放时让位 (视觉所有权归内部播放器)
  if (typeof internalAudioPlayingNow === 'function' && internalAudioPlayingNow()) return;
  if (thumb && typeof thumb === 'string') {
    if (typeof applyCoverCanvas !== 'function' || !smtcStore) return;
    // [FIX 1] inactive 时封面事件被"消费掉"后无法重放 (watchdog 重启竞态):
    // 不丢弃, 挂起等待 active 恢复后冲刷。
    if (!smtcStore.active) {
      smtcVisualCoverPending = thumb;
      return;
    }
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
      smtcVisualCoverPending = null;   // [FIX 1] 正常应用后清挂起位
    };
    img.onerror = function () {}; // 解码失败: 保持当前视觉 (与内部失败路径一致静默)
    img.src = thumb;
    return;
  }
  // [M1] thumbnail=null 必须区分两种语义:
  //   (A) SMTC 会话仍 active (切歌过渡 / watchdog 恢复中): main 的 null 只是"新封面尚未 ready",
  //       绝不能解释为"没有封面" — 保持当前舞台封面完全不变 (uHasCover/coverTex/currentCoverSource
  //       /album background 一律不动), 等真正 dataURL 到达后走现有 applyCoverCanvas crossfade。
  //   (B) SMTC 会话真正结束: 由 00-smtc-store.js 的 state 事件 (active true->false + bridgeReady=true)
  //       负责真清空; 此处 inactive 分支仅作兜底。
  smtcVisualCoverPending = null;   // [FIX 1] null = 无封面: 挂起值不再有意义, 清掉避免 active 恢复后补放过期封面
  if (typeof smtcStore !== 'undefined' && smtcStore.active === true) {
    console.log('[Renderer][' + Date.now() + '] SMTC visualizer cover HELD (thumbnail=null while active, await next cover)');
    return;
  }
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
// 底栏镜像的节流键 + 「谁在拥有底栏」的意图锁（两者都由下面的判据维护）
var smtcBarMirrorKey = '';
var smtcBarLatchKey = '';
function smtcExternalOwnsUi() {
  if (typeof smtcStore !== 'object' || !smtcStore || smtcStore.active !== true) { smtcBarLatchKey = ''; return false; }
  if (typeof internalAudioPlayingNow === 'function' && internalAudioPlayingNow()) { smtcBarLatchKey = ''; return false; }
  // A published context IS an Apple play started from MineRadio itself - nothing to defend here.
  if (typeof currentPlaybackContext === 'object' && currentPlaybackContext) { smtcBarLatchKey = ''; return true; }
  if (typeof currentQueueSong !== 'function') return true;
  var song = currentQueueSong();
  var provider = (song && typeof songProviderKey === 'function') ? songProviderKey(song) : '';
  var key = song ? [provider, song.id != null ? song.id : '', song.name || '', song.artist || ''].join('|') : '';
  // nothing loaded, or an Apple track loaded -> the session owns the bar
  if (!song || provider === 'apple') { smtcBarLatchKey = key; return true; }
  if (smtcBarLatchKey === key) return true;        // same selection as when the session took the bar
  if (smtcStore.isPlaying === true) { smtcBarLatchKey = key; return true; }   // Apple Music is playing
  return false;
}
function smtcMirrorControlBarIdentity() {
  // The identity is built ONCE, in externalLiveSong() (05-playback/06-track-detail-lyrics-actions.js):
  // title, the artist/album split of SMTC's "Artist <em dash> Album", artwork and provider all come from
  // there, so the bar and the unified accessor can never show two different artists.
  var live = (typeof externalLiveSong === 'function') ? externalLiveSong() : null;
  if (!live) {
    // Just yielded (the user chose a MineRadio source): repaint the bar from the queue NOW, otherwise it
    // would keep showing the Apple Music track until some unrelated queue render happens.
    if (smtcBarMirrorKey) {
      smtcBarMirrorKey = '';
      if (typeof applyControlTrackInfo === 'function' && typeof currentQueueSong === 'function') {
        try { applyControlTrackInfo(currentQueueSong()); } catch (_) { }
      }
    }
    return false;
  }
  var key = live.name + '|' + live.artist;
  // identity unchanged -> do not repaint: the painter rebuilds the badge innerHTML (and its source
  // switcher), and the SMTC bridge pushes position updates far more often than identity changes.
  if (key === smtcBarMirrorKey) return false;
  if (typeof applyControlTrackInfo !== 'function') return false;
  smtcBarMirrorKey = key;
  applyControlTrackInfo(live);
  return true;
}

function smtcSyncBarPlayIcon() {
  if (smtcExternalOwnsUi()) {
    if (typeof setPlayIcon === 'function') setPlayIcon(smtcStore.isPlaying === true);
    return true;
  }
  if (typeof setPlayIcon === 'function') setPlayIcon(typeof playing !== 'undefined' && !!playing);
  return false;
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
  smtcSyncBarPlayIcon(); // Step 4: 底栏播放键图标 = 拥有底栏的那个 session 的状态 (不依赖 hover 控件是否存在)
  smtcRenderSmtcSessionRow(); // 同步设置面板里的会话状态随 ticker 同步
  smtcSyncBarPlayIcon();      // Step 4: 底栏播放键图标 = 拥有底栏的那个 session
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
var smtcHoverSessionDelayRendered = false;
// 首次展开时把现有 Session Delay UI 渲染进面板第四层 (函数来自 05, 加载晚于 03)
function smtcEnsureHoverSessionDelay() {
  if (smtcHoverSessionDelayRendered) return;
  var slot = document.getElementById('smtc-hover-delay-slot');
  if (!slot) return;
  if (typeof smtcRenderSessionDelayBlock !== 'function') return; // 05 尚未加载, 下次展开再试
  smtcRenderSessionDelayBlock(slot);
  smtcHoverSessionDelayRendered = true;
}
// ---- SMTC 会话刷新 (状态显示 + 按钮) ----
var smtcRefreshingSession = false;

function smtcRenderSmtcSessionRow() {
  var st = document.getElementById('smtc-session-status');
  if (!st) return;
  st.textContent = 'SMTC 会话 · ' + (smtcStore && smtcStore.active === true ? '已连接' : '未连接');
}

// 点击刷新: bridge 重新同步 CurrentSession 并立即推送最新状态;
// 不重启播放器/不重新加载歌曲/不改变播放位置; 防止重复点击。
function smtcRefreshSmtcSession() {
  var api = window.desktopWindow;
  if (!api || typeof api.refreshSmtcSession !== 'function') return;
  if (smtcRefreshingSession) return;
  smtcRefreshingSession = true;
  var btn = document.getElementById('smtc-session-refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = '正在刷新…'; }
  api.refreshSmtcSession().then(function (result) {
    var ok = result && result.success === true;
    if (typeof showToast === 'function') {
      showToast(ok ? '✓ 会话已刷新' : '⚠ 未找到可用的 SMTC 会话');
    }
    smtcRefreshingSession = false;
    if (btn) { btn.disabled = false; btn.textContent = '🔄 刷新会话'; }
    smtcRenderSmtcSessionRow();
  }).catch(function () {
    smtcRefreshingSession = false;
    if (btn) { btn.disabled = false; btn.textContent = '🔄 刷新会话'; }
    if (typeof showToast === 'function') showToast('⚠ 刷新 SMTC 会话失败');
  });
}
function smtcInit() {
  smtcEnsureChip();
  smtcEnsureSettingsHost(); // 隐藏宿主: 同步设置面板的三个节点在此创建, 打开时被搬入面板
  initSmtcStore();
  initSmtcAudio();
  smtcStartTicker();
  smtcRenderChip();
  // 独立歌词源窗口: 拖拽排序后的新顺序 -> 现有排序状态 (05) 保存 + 按新顺序重载
  var api = window.desktopWindow;
  if (api && typeof api.onLyricsSourceOrderChanged === 'function') {
    api.onLyricsSourceOrderChanged(function (payload) {
      var order = payload && Array.isArray(payload.order) ? payload.order : null;
      if (order && typeof smtcSetLyricSourceOrder === 'function') {
        smtcSetLyricSourceOrder(order);   // 现有逻辑: 更新顺序 + 保存 + 重载歌词
      }
    });
  }
  // 独立歌词源窗口: [重新搜索] -> 现有重搜 (skipCache, 读取最新排序, 失败保留旧歌词)
  if (api && typeof api.onLyricsSourceReSearch === 'function') {
    api.onLyricsSourceReSearch(function () {
      function notifyDone() {
        if (typeof api.lyricsSourceReSearchDone === 'function') api.lyricsSourceReSearchDone();
      }
      if (typeof smtcReSearchLyrics === 'function') {
        var p = smtcReSearchLyrics();
        if (p && typeof p.then === 'function') p.then(notifyDone, notifyDone);
        else notifyDone();
      } else {
        notifyDone();
      }
    });
  }
  // UI 重构: 默认状态隐藏 SMTC 状态胶囊 (ticker 逻辑保留, 仅视觉 collapsed)
  var chip = document.getElementById('smtc-chip');
  if (chip) {
    chip.style.visibility = 'hidden';
    chip.style.pointerEvents = 'none';
  }
  }
smtcInit();