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
// UI 重构: 封面常驻于 hover 容器右端 (容器由 smtcEnsureHoverContainer 创建)
// 封面同时是唯一拖拽手柄: pointerdown 开始, 移动 >=5px 视为拖拽 (拖整个播放器),
// <5px 视为点击 (不移动)。按钮/输入不在封面上, 不会触发拖拽。
function smtcEnsureCover() {
  var img = document.getElementById('smtc-cover');
  if (img) return img;
  img = document.createElement('img');
  img.id = 'smtc-cover';
  img.draggable = false;   // 禁止图片原生拖拽, 避免干扰自绘拖拽
  img.style.cssText = [
    'width:64px',
    'height:64px',
    'border-radius:8px',
    'object-fit:cover',
    'display:none',
    'border:1px solid rgba(255,255,255,0.14)',
    'background:rgba(14,16,18,0.6)',
    'pointer-events:auto',      // hover 触发区域包含封面
    'flex-shrink:0',
    'cursor:grab',
    '-webkit-user-drag:none',
  ].join(';');
  smtcEnsureHoverContainer().appendChild(img);
  img.addEventListener('pointerdown', smtcPlayerDragStart);
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
    'display:flex',
    'gap:6px',
    'align-items:center',
    'justify-content:center',
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
  // UI 重构: 播放控制移入 hover 展开面板第二层挂载点
  var slot = document.getElementById('smtc-hover-controls-slot');
  if (slot) slot.appendChild(bar); else document.body.appendChild(bar);
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
  smtcRenderHoverPanelInfo(); // UI 重构: hover 面板歌名/歌手/歌词源随 ticker 同步
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

// ============================================================
// UI 重构: 右上角 Hover 展开式控制面板
// 默认只显示专辑封面; hover 封面/面板区域 -> 面板从封面左侧展开;
// mouseleave 整个区域 300ms 后自动收回。纯显示层, 不触碰任何功能逻辑。
// ============================================================
var smtcHoverCollapseTimer = 0;
var smtcHoverSessionDelayRendered = false;

function smtcEnsureHoverContainer() {
  var c = document.getElementById('smtc-hover-container');
  if (c) return c;
  c = document.createElement('div');
  c.id = 'smtc-hover-container';
  c.style.cssText = [
    'position:fixed', 'top:120px', 'right:12px', 'z-index:4799',
    'display:flex', 'align-items:flex-start', 'justify-content:flex-start',
    'pointer-events:none',   // 容器不拦截, 子元素各自 auto
    'will-change:left, top',
  ].join(';');

  // ---- 展开面板 (封面左侧, 默认 collapsed) ----
  var panel = document.createElement('div');
  panel.id = 'smtc-hover-panel';
  panel.style.cssText = [
    'position:relative',
    'margin-right:10px',
    'width:236px',
    'padding:10px 12px',
    'border-radius:12px',
    'font-size:11px',
    'line-height:1.5',
    'color:rgba(255,255,255,0.85)',
    'background:rgba(14,16,18,0.86)',
    'border:1px solid rgba(255,255,255,0.12)',
    'user-select:none',
    'opacity:0',
    'transform:translateX(12px)',
    'transition:opacity 180ms ease-out, transform 180ms ease-out',
    'pointer-events:none',
    'box-shadow:0 6px 18px rgba(0,0,0,0.35)',
  ].join(';');

  // 第一层: 歌名 / 歌手
  var t = document.createElement('div');
  t.id = 'smtc-hover-title';
  t.style.cssText = 'font-weight:700;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  var a = document.createElement('div');
  a.id = 'smtc-hover-artist';
  a.style.cssText = 'opacity:0.6;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  var sep1 = document.createElement('div');
  sep1.style.cssText = 'height:1px;background:rgba(255,255,255,0.12);margin:8px 0 6px;';
  // 第二层: 播放控制挂载点 (smtcEnsureControls 挂入)
  var controlsSlot = document.createElement('div');
  controlsSlot.id = 'smtc-hover-controls-slot';
  controlsSlot.style.cssText = 'display:flex;justify-content:center;';
  // 第三层: 歌词源搜索顺序入口 (点击打开独立窗口; 不在播放器内展开详细选择)
  var srcRow = document.createElement('div');
  srcRow.id = 'smtc-hover-srcrow';
  srcRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:8px;';
  var srcText = document.createElement('span');
  srcText.id = 'smtc-hover-src';
  srcText.textContent = '歌词源';
  srcText.title = '打开歌词源搜索顺序窗口';
  srcText.style.cssText = [
    'flex:1', 'opacity:0.9', 'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
    'padding:4px 8px', 'border-radius:6px', 'cursor:pointer',
    'background:rgba(255,255,255,0.06)', 'border:1px solid rgba(255,255,255,0.12)',
  ].join(';');
  srcText.addEventListener('click', function (e) {
    e.stopPropagation();
    var api = window.desktopWindow;
    if (!api || typeof api.openLyricsSourceWindow !== 'function') return;
    // 携带当前搜索顺序 (真实状态 = smtcLyricSourceSettings().order)
    var order = typeof smtcLyricSourceSettings === 'function'
      ? (smtcLyricSourceSettings().order || []) : [];
    api.openLyricsSourceWindow({ order: order });
  });
  srcRow.appendChild(srcText);
  var sep2 = document.createElement('div');
  sep2.style.cssText = 'height:1px;background:rgba(255,255,255,0.12);margin:8px 0 6px;';
  // SMTC 会话刷新行 (状态 + 刷新按钮)
  var smtcRow = document.createElement('div');
  smtcRow.id = 'smtc-session-row';
  smtcRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:0 0 2px;';
  var smtcStatus = document.createElement('span');
  smtcStatus.id = 'smtc-session-status';
  smtcStatus.style.cssText = 'flex:1;opacity:0.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
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
  smtcRow.appendChild(smtcStatus);
  smtcRow.appendChild(refreshBtn);
  // 第四层: Session Delay 挂载点 (首次展开时由现有 smtcRenderSessionDelayBlock 填充)
  var delaySlot = document.createElement('div');
  delaySlot.id = 'smtc-hover-delay-slot';
  // 第五层: 恢复默认位置 (轻量, 不重建任何功能)
  var resetPos = document.createElement('button');
  resetPos.type = 'button';
  resetPos.id = 'smtc-player-reset-pos';
  resetPos.textContent = '恢复默认位置';
  resetPos.title = '回到右上角默认位置';
  resetPos.style.cssText = [
    'width:100%', 'margin-top:8px', 'padding:4px 0', 'border-radius:6px', 'font-size:10px',
    'color:rgba(255,255,255,0.55)', 'background:transparent',
    'border:1px dashed rgba(255,255,255,0.16)', 'cursor:pointer', 'user-select:none',
  ].join(';');
  resetPos.addEventListener('click', function () {
    smtcResetPlayerPosition();
    if (typeof smtcRenderHoverPanelInfo === 'function') smtcRenderHoverPanelInfo();
  });

  panel.appendChild(t);
  panel.appendChild(a);
  panel.appendChild(sep1);
  panel.appendChild(controlsSlot);
  panel.appendChild(srcRow);
  panel.appendChild(sep2);
  panel.appendChild(smtcRow);
  panel.appendChild(delaySlot);
  panel.appendChild(resetPos);
  c.appendChild(panel);
  document.body.appendChild(c);

  // ---- hover 事件: 封面 + 展开面板 + 词源面板 = 同一 hover container ----
  c.addEventListener('mouseenter', function () { smtcHoverExpand(); });
  // mouseout (冒泡) + relatedTarget 判断: 覆盖所有"指针离开组件 hit 区域"的情况,
  // 包括子元素被隐藏导致 hit 区域收缩 (如关闭词源面板时鼠标停在原位置, mouseleave 不会触发)。
  c.addEventListener('mouseout', function (e) {
    var to = e.relatedTarget;
    var inside = false;
    while (to && to !== document.body && to !== document.documentElement) {
      if (to === c) { inside = true; break; }
      to = to.parentElement;
    }
    if (!inside) smtcHoverScheduleCollapse();
  });
  return c;
}

// ---- 展开方向: 四向自适应 (左/右/上/下), 基于"收缩状态专辑封面"实际屏幕位置 ----
// 判断依据 = 专辑封面 (唯一可见触发器) 的 getBoundingClientRect(),
// 不是整个控制区容器 (容器含隐藏面板, 不能代表收缩态视觉位置)。
// 拖拽定位 (容器 left/top) 与展开方向完全独立, 方向切换绝不移动封面。
var smtcExpandDirection = 'left';   // 'left' | 'right' | 'top' | 'bottom'
var SMTC_EDGE_SAFE_MARGIN = 8;      // 屏幕边缘安全边距 (px)
var smtcPanelSize = { width: 236, height: 300 };   // fallback; 运行时实测

function smtcPanelDimensions() {
  var panel = document.getElementById('smtc-hover-panel');
  if (!panel) return smtcPanelSize;
  var r = panel.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return smtcPanelSize;
  return { width: r.width, height: r.height };
}

// 四向空间判断; 优先级: 保持当前方向 -> 默认 left -> 其他可容纳 -> 空间最大
// 面板在某方向的"实际目标 rect" (顶/左对齐于封面, margin 10)
function smtcPanelRectFor(dir, cr, ps) {
  var m = 10;
  if (dir === 'left') {
    return { l: cr.left - ps.width - m, t: cr.top, r: cr.left - m, b: cr.top + ps.height };
  }
  if (dir === 'right') {
    return { l: cr.right + m, t: cr.top, r: cr.right + m + ps.width, b: cr.top + ps.height };
  }
  if (dir === 'top') {
    return { l: cr.left, t: cr.top - ps.height - m, r: cr.left + ps.width, b: cr.top - m };
  }
  return { l: cr.left, t: cr.bottom + m, r: cr.left + ps.width, b: cr.bottom + m + ps.height }; // bottom
}

// 四向展开方向: 基于"收缩状态专辑封面"rect + 面板实际尺寸,
// 候选方向以"面板完整落在窗口内"为准 (fits), 其次空间最大, 空间相同保持当前方向 (防抖动)。
function smtcComputeExpandDirection() {
  var cover = document.getElementById('smtc-cover');
  if (!cover) return 'left';
  var cr = cover.getBoundingClientRect();
  var ps = smtcPanelDimensions();
  var spaces = {
    left: cr.left,
    right: window.innerWidth - cr.right,
    top: cr.top,
    bottom: window.innerHeight - cr.bottom,
  };
  var dirs = ['left', 'right', 'top', 'bottom'];
  var candidates = dirs.map(function (dir) {
    var rect = smtcPanelRectFor(dir, cr, ps);
    return {
      direction: dir,
      space: spaces[dir],
      fits: rect.l >= 0 && rect.t >= 0 && rect.r <= window.innerWidth && rect.b <= window.innerHeight,
    };
  });
  var best = candidates[0];
  for (var i = 1; i < candidates.length; i++) {
    var cand = candidates[i];
    var better = false;
    if (cand.fits !== best.fits) {
      better = cand.fits;                       // fit (面板完整) 优先
    } else if (cand.space !== best.space) {
      better = cand.space > best.space;         // 空间最大
    } else if (cand.direction === smtcExpandDirection) {
      better = true;                            // 空间相同: 保持当前方向
    }
    if (better) best = cand;
  }
  return best.direction;
}

// 应用展开方向: 切换容器 flex 方向 + 对齐 + 面板 margin, 并二维补偿容器位置
// (封面是视觉锚点, 方向切换时封面屏幕位置绝不允许跳动)。
function smtcApplyExpandDirection() {
  var c = smtcPlayerContainer();
  var panel = document.getElementById('smtc-hover-panel');
  if (!c || !panel) return;
  var dir = smtcComputeExpandDirection();
  if (dir === smtcExpandDirection) return;   // 方向不变, 无需处理
  var before = smtcCoverGeometry();
  // 顶/左对齐: 面板与封面左上角对齐 (flex-start), 保证面板完整贴近封面
  c.style.alignItems = 'flex-start';
  c.style.justifyContent = 'flex-start';
  switch (dir) {
    case 'right':
      // 封面左, 面板右 (row-reverse)
      c.style.flexDirection = 'row-reverse';
      panel.style.marginLeft = '10px'; panel.style.marginRight = '0';
      panel.style.marginTop = '0'; panel.style.marginBottom = '0';
      break;
    case 'top':
      // 面板上, 封面下 (column)
      c.style.flexDirection = 'column';
      panel.style.marginBottom = '10px'; panel.style.marginLeft = '0';
      panel.style.marginRight = '0'; panel.style.marginTop = '0';
      break;
    case 'bottom':
      // 封面上, 面板下 (column-reverse)
      c.style.flexDirection = 'column-reverse';
      panel.style.marginTop = '10px'; panel.style.marginLeft = '0';
      panel.style.marginRight = '0'; panel.style.marginBottom = '0';
      break;
    default: // 'left'
      // 面板左, 封面右 (row)
      c.style.flexDirection = 'row';
      panel.style.marginRight = '10px'; panel.style.marginLeft = '0';
      panel.style.marginTop = '0'; panel.style.marginBottom = '0';
      break;
  }
  smtcExpandDirection = dir;
  var after = smtcCoverGeometry();
  var dx = after.offsetX - before.offsetX;
  var dy = after.offsetY - before.offsetY;
  if (dx !== 0 || dy !== 0) {
    var rect = c.getBoundingClientRect();
    // 封面保持原位: 容器反移 offset 变化量
    smtcApplyPlayerPosition(rect.left - dx, rect.top - dy);
  }
}

// 按方向的收起动画基准 (面板从对应方向滑入/滑出)
function smtcExpandCollapsedTransform() {
  switch (smtcExpandDirection) {
    case 'right':  return 'translateX(-12px)';
    case 'top':    return 'translateY(12px)';
    case 'bottom': return 'translateY(-12px)';
    default:       return 'translateX(12px)';   // left
  }
}

function smtcHoverExpand() {
  if (smtcHoverCollapseTimer) {
    clearTimeout(smtcHoverCollapseTimer);
    smtcHoverCollapseTimer = 0;
  }
  var panel = document.getElementById('smtc-hover-panel');
  if (!panel) return;
  smtcApplyExpandDirection();   // 每次展开按封面当前实际位置重新判断方向
  panel.style.opacity = '1';
  panel.style.transform = 'translateX(0)';
  panel.style.pointerEvents = 'auto';
  smtcEnsureHoverSessionDelay();   // 05 加载后首次展开时填充 Session Delay 控件
}

function smtcHoverScheduleCollapse() {
  // 拖拽进行中禁止收回 (拖拽本身会让鼠标一直在组件上)
  if (smtcPlayerDragging) return;
  if (smtcHoverCollapseTimer) clearTimeout(smtcHoverCollapseTimer);
  smtcHoverCollapseTimer = setTimeout(function () {
    smtcHoverCollapseTimer = 0;
    if (smtcPlayerDragging) return;
    var panel = document.getElementById('smtc-hover-panel');
    if (!panel) return;
    panel.style.opacity = '0';
    panel.style.transform = smtcExpandCollapsedTransform();   // 按方向折叠
    panel.style.pointerEvents = 'none';
    // 词源优先级面板跟着收回 (仅视觉, 不触碰其 toggle 逻辑)
    var sp = document.getElementById('smtc-lyric-source-panel');
    if (sp) sp.style.display = 'none';
  }, 300);
}

// 首次展开时把现有 Session Delay UI 渲染进面板第四层 (函数来自 05, 加载晚于 03)
function smtcEnsureHoverSessionDelay() {
  if (smtcHoverSessionDelayRendered) return;
  var slot = document.getElementById('smtc-hover-delay-slot');
  if (!slot) return;
  if (typeof smtcRenderSessionDelayBlock !== 'function') return; // 05 尚未加载, 下次展开再试
  smtcRenderSessionDelayBlock(slot);
  smtcHoverSessionDelayRendered = true;
}

// hover 面板信息同步 (由 300ms ticker 调用): 歌名 / 歌手
// 歌词源入口固定显示"歌词源" (不显示当前歌词源: 当前源由搜索结果决定)
function smtcRenderHoverPanelInfo() {
  var t = document.getElementById('smtc-hover-title');
  if (!t) return;
  t.textContent = smtcStore.title || (smtcStore.active ? '未知歌曲' : '未在播放');
  var a = document.getElementById('smtc-hover-artist');
  if (a) a.textContent = smtcStore.artist || '';
  var src = document.getElementById('smtc-hover-src');
  if (src && src.textContent !== '歌词源') src.textContent = '歌词源';
  smtcRenderSmtcSessionRow();
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

// ============================================================
// 浮动播放器: 拖拽移动 + 位置持久化 + 恢复默认位置
// 仅封面为拖拽手柄; 移动 >=5px 视为拖拽, <5px 视为点击 (不移动)。
// 位置存 localStorage['mineradio.player.position'] = {x, y};
// 启动读取并 clamp 到窗口内; 窗口 resize 时重新 clamp。
// ============================================================
var smtcPlayerDragging = false;
var smtcPlayerDragMoved = false;
var smtcPlayerDragStartX = 0, smtcPlayerDragStartY = 0;
var smtcPlayerDragStartLeft = 0, smtcPlayerDragStartTop = 0;

function smtcPlayerContainer() {
  return document.getElementById('smtc-hover-container');
}

// 收缩态 row 布局下封面距容器左缘的偏移 (面板 236 + margin 10 = 246)。
// 保存/恢复统一用该 row 基准, 保证封面视觉位置跨方向/重启一致。
var SMTC_ROW_COVER_OFFSET = 246;

// 封面在容器内的实时偏移 (offsetX/offsetY) + 封面宽高
// (随展开方向变化: row=246/垂直居中, row-reverse=0, column 等各不相同)
function smtcCoverGeometry() {
  var cover = document.getElementById('smtc-cover');
  var c = smtcPlayerContainer();
  if (!cover || !c) return { offsetX: SMTC_ROW_COVER_OFFSET, offsetY: 0, width: 64, height: 64 };
  var cr = cover.getBoundingClientRect();
  var ctr = c.getBoundingClientRect();
  return { offsetX: cr.left - ctr.left, offsetY: cr.top - ctr.top, width: cr.width, height: cr.height };
}

// 把坐标 clamp 到当前窗口内; 边界基准 = "收缩态专辑封面" (唯一可见触发器),
// 不是整个容器 (容器含隐藏面板, 不能作为封面贴边依据)。
// 封面四缘均不允许超出窗口: minX/minY 允许为负 (容器 left/top 可负,
// 负多少 = 封面在容器内的偏移), 保证封面可贴任意边缘。
function smtcClampPlayerPosition(x, y) {
  var c = smtcPlayerContainer();
  if (!c) return { x: x, y: y };
  var g = smtcCoverGeometry();
  var minX = -g.offsetX;
  var maxX = Math.max(minX, window.innerWidth - g.width - g.offsetX);
  var minY = -g.offsetY;
  var maxY = Math.max(minY, window.innerHeight - g.height - g.offsetY);
  return {
    x: Math.max(minX, Math.min(maxX, Math.round(x))),
    y: Math.max(minY, Math.min(maxY, Math.round(y))),
  };
}

function smtcApplyPlayerPosition(x, y) {
  var c = smtcPlayerContainer();
  if (!c) return;
  var p = smtcClampPlayerPosition(x, y);
  // 纯 left/top 定位: 显式清除 right (容器初始 CSS 含 right:12px,
  // 若未及时 right:'auto' 会导致 fixed 元素 left+right 双定位 -> 宽度被拉伸 ->
  // clamp 的 maxX 失真, 左边界被卡在 ~12px 处)。
  c.style.left = p.x + 'px';
  c.style.top = p.y + 'px';
  c.style.right = 'auto';
  return p;
}

// 启动读取持久化位置; 不存在/损坏/NaN/超范围 -> 自动 clamp
function smtcLoadPlayerPosition() {
  var c = smtcPlayerContainer();
  if (!c) return;
  c.style.right = 'auto';   // 切换为 left/top 定位
  var r = c.getBoundingClientRect();
  // 默认右上角 (等价原 right:12px / top:120px)
  var x = Math.max(0, window.innerWidth - r.width - 12);
  var y = 120;
  try {
    var raw = localStorage.getItem('mineradio.player.position');
    if (raw) {
      var p = JSON.parse(raw);
      if (p && typeof p.x === 'number' && typeof p.y === 'number' && isFinite(p.x) && isFinite(p.y)) {
        x = p.x; y = p.y;
      }
    }
  } catch (e) {}
  smtcApplyPlayerPosition(x, y);   // 内部 clamp (含超范围恢复)
}

// 恢复默认位置: 删除存储 -> 立即回右上角 (无需重启)
function smtcResetPlayerPosition() {
  try { localStorage.removeItem('mineradio.player.position'); } catch (e) {}
  var c = smtcPlayerContainer();
  if (!c) return;
  var r = c.getBoundingClientRect();
  smtcApplyPlayerPosition(Math.max(0, window.innerWidth - r.width - 12), 120);
  console.log('[Renderer][' + Date.now() + '] player position reset to default (top-right)');
  if (typeof showToast === 'function') showToast('播放器已恢复默认位置');
}

// 指针是否位于播放器组件 (含所有展开内容) 内
function smtcPointerInPlayer(x, y) {
  var c = smtcPlayerContainer();
  if (!c) return false;
  var el = document.elementFromPoint(x, y);
  while (el && el !== c && el !== document.body && el !== document.documentElement) el = el.parentElement;
  return el === c;
}

// 封面 pointerdown -> 开始潜在拖拽
function smtcPlayerDragStart(e) {
  if (e.button !== 0) return;
  var c = smtcPlayerContainer();
  if (!c) return;
  smtcPlayerDragging = true;
  smtcPlayerDragMoved = false;
  var r = c.getBoundingClientRect();
  smtcPlayerDragStartX = e.clientX;
  smtcPlayerDragStartY = e.clientY;
  smtcPlayerDragStartLeft = r.left;
  smtcPlayerDragStartTop = r.top;
  // 拖拽中保持展开, 禁止 collapse
  if (smtcHoverCollapseTimer) { clearTimeout(smtcHoverCollapseTimer); smtcHoverCollapseTimer = 0; }
  smtcHoverExpand();
  c.style.cursor = 'grabbing';
  c.style.opacity = '0.9';   // 拖动时轻微降低透明度
  var onMove = function (ev) {
    if (!smtcPlayerDragging) return;
    var dx = ev.clientX - smtcPlayerDragStartX;
    var dy = ev.clientY - smtcPlayerDragStartY;
    if (Math.abs(dx) >= 5 || Math.abs(dy) >= 5) smtcPlayerDragMoved = true;
    if (smtcPlayerDragMoved) {
      smtcApplyPlayerPosition(smtcPlayerDragStartLeft + dx, smtcPlayerDragStartTop + dy);
    }
  };
  var onUp = function (ev) {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    var moved = smtcPlayerDragMoved;
    smtcPlayerDragging = false;
    c.style.cursor = '';
    c.style.opacity = '';
    if (moved) {
      // 拖拽结束: 保存位置 (已 clamp)。
      // 统一按 row 基准保存: x = 封面屏幕 left - 246 (row 偏移),
      // y = 封面屏幕 top - row 方向垂直居中偏移 ((面板高-封面高)/2)。
      // 保证重启恢复时封面视觉位置一致, 不受保存时展开方向影响。
      try {
        var cr = document.getElementById('smtc-cover').getBoundingClientRect();
        var panel = document.getElementById('smtc-hover-panel');
        var pr = panel ? panel.getBoundingClientRect() : null;
        var rowOffsetY = pr ? Math.max(0, (pr.height - cr.height) / 2) : 0;
        var savedX = Math.round(cr.left - SMTC_ROW_COVER_OFFSET);
        var savedY = Math.round(cr.top - rowOffsetY);
        localStorage.setItem('mineradio.player.position', JSON.stringify({ x: savedX, y: savedY }));
        console.log('[Renderer][' + Date.now() + '] player position saved: ' + savedX + ',' + savedY);
      } catch (err) {}
    }
    // 拖拽结束: 按 hover 状态决定 (鼠标已离开组件则 300ms 收回)
    if (!smtcPointerInPlayer(ev.clientX, ev.clientY)) smtcHoverScheduleCollapse();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  e.preventDefault();
}

function smtcInit() {
  smtcEnsureChip();
  smtcEnsureHoverContainer(); // UI 重构: 容器先建 (cover/controls/词源面板挂入)
  smtcEnsureCover();
  smtcEnsureControls(); // Phase 4B: 播放控制按钮 (移入 hover 面板第二层)
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
  // 浮动位置: 等窗口可见(innerHeight>0)后加载默认位置。
  // 启动早期窗口可能尚未显示(innerHeight=0), 过早 clamp 会把位置压到 0;
  // resize 事件兜底再 clamp 一次。
  setTimeout(function () {
    (function waitWindowReady() {
      if (window.innerHeight > 0 && window.innerWidth > 0) {
        smtcLoadPlayerPosition();
      } else {
        setTimeout(waitWindowReady, 150);
      }
    })();
  }, 400);
  window.addEventListener('resize', function () {
    // 窗口尺寸变化: 重新 clamp, 保证播放器仍在窗口内
    var c = smtcPlayerContainer();
    if (!c) return;
    var r = c.getBoundingClientRect();
    if (r.left < 0 || r.top < 0 ||
        r.left + r.width > window.innerWidth ||
        r.top + r.height > window.innerHeight) {
      smtcApplyPlayerPosition(r.left, r.top);
    }
  });
}

smtcInit();
