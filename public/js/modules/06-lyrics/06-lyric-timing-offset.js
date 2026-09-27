var LYRIC_TIMING_OFFSET_STORE_KEY = 'mineradio-lyric-timing-offsets-v1';
var LYRIC_TIMING_OFFSET_LIMIT = 500;
var lyricTimingOffsetMap = readLyricTimingOffsetMap();
var lyricTimingPopoverCloseTimer = null;

function normalizeLyricTimingOffsetSeconds(value) {
  var raw = Number(value);
  if (!isFinite(raw)) raw = 0;
  return Math.round(clampRange(raw, -5, 5) * 10) / 10;
}

function lyricTimingOffsetEntryValue(entry) {
  if (entry && typeof entry === 'object') return normalizeLyricTimingOffsetSeconds(entry.offset);
  return normalizeLyricTimingOffsetSeconds(entry);
}

function readLyricTimingOffsetMap() {
  try {
    var raw = JSON.parse(localStorage.getItem(LYRIC_TIMING_OFFSET_STORE_KEY) || '{}');
    var items = raw && raw.version === 1 && raw.items ? raw.items : raw;
    var out = {};
    Object.keys(items || {}).forEach(function (key) {
      var entry = items[key];
      var offset = lyricTimingOffsetEntryValue(entry);
      if (offset) {
        out[key] = {
          offset: offset,
          updatedAt: Number(entry && entry.updatedAt) || 0,
          title: String(entry && entry.title || '').slice(0, 80),
          artist: String(entry && entry.artist || '').slice(0, 80)
        };
      }
    });
    return out;
  } catch (e) {
    return {};
  }
}

function writeLyricTimingOffsetMap() {
  try {
    var keys = Object.keys(lyricTimingOffsetMap || {}).sort(function (a, b) {
      return (Number(lyricTimingOffsetMap[b] && lyricTimingOffsetMap[b].updatedAt) || 0) - (Number(lyricTimingOffsetMap[a] && lyricTimingOffsetMap[a].updatedAt) || 0);
    }).slice(0, LYRIC_TIMING_OFFSET_LIMIT);
    var items = {};
    keys.forEach(function (key) { items[key] = lyricTimingOffsetMap[key]; });
    lyricTimingOffsetMap = items;
    if (!keys.length) {
      localStorage.removeItem(LYRIC_TIMING_OFFSET_STORE_KEY);
      return;
    }
    localStorage.setItem(LYRIC_TIMING_OFFSET_STORE_KEY, JSON.stringify({ version: 1, savedAt: Date.now(), items: items }));
  } catch (e) { }
}

function lyricTimingCurrentSong() {
  if (typeof currentCoverSong === 'function') return currentCoverSong();
  if (currentIdx >= 0 && playQueue && playQueue[currentIdx]) return playQueue[currentIdx];
  return currentLocalSong || null;
}

function lyricTimingSongKey(song) {
  song = song || lyricTimingCurrentSong();
  if (!song) return '';
  if (typeof queueItemKey === 'function') return queueItemKey(song);
  if (typeof songCustomCoverKey === 'function') return songCustomCoverKey(song);
  if (song.provider === 'apple' || song.source === 'apple' || song.type === 'apple' || song.appleId || song.appleUrl || song.isrc) return 'apple:' + (song.appleId || song.id || song.isrc || (song.name + '|' + song.artist));
  if (song.provider === 'spotify' || song.source === 'spotify' || song.type === 'spotify' || song.spotifyId || song.spotifyUri) return 'spotify:' + (song.spotifyId || song.id || song.spotifyUri || song.uri || (song.name + '|' + song.artist));
  if (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq') return 'qq:' + (song.mid || song.songmid || song.id || (song.name + '|' + song.artist));
  if (song.type === 'podcast' && song.programId) return 'podcast:' + song.programId;
  if (song.localKey) return 'local:' + song.localKey;
  if (song.id != null && song.id !== '') return 'song:' + song.id;
  return String(song.name || '') + '|' + String(song.artist || '');
}

function getLyricTimingOffsetForSong(song) {
  var key = lyricTimingSongKey(song);
  return key && lyricTimingOffsetMap && lyricTimingOffsetMap[key] ? lyricTimingOffsetEntryValue(lyricTimingOffsetMap[key]) : 0;
}

function getActiveLyricTimingOffsetSeconds() {
  return getLyricTimingOffsetForSong(lyricTimingCurrentSong());
}

function getAdjustedLyricPlaybackTime(rawTime) {
  var t = Number(rawTime);
  if (!isFinite(t)) t = 0;
  return Math.max(0, t + getActiveLyricTimingOffsetSeconds());
}

function formatLyricTimingOffset(offset) {
  offset = normalizeLyricTimingOffsetSeconds(offset);
  if (!offset) return '0.0s';
  return (offset > 0 ? '+' : '-') + Math.abs(offset).toFixed(1) + 's';
}

function lyricTimingToastText(offset) {
  offset = normalizeLyricTimingOffsetSeconds(offset);
  if (!offset) return '歌词校准已重置';
  return offset > 0 ? ('歌词提前 ' + Math.abs(offset).toFixed(1) + 's') : ('歌词延后 ' + Math.abs(offset).toFixed(1) + 's');
}

function releaseLyricTimingPopoverFocus(root) {
  root = root || document.getElementById('lyric-timing-control');
  var active = document.activeElement;
  if (!root || !active || !root.contains(active) || typeof active.blur !== 'function') return;
  try { active.blur(); } catch (e) { }
}

function clearLyricTimingPopoverClose() {
  if (lyricTimingPopoverCloseTimer) {
    clearTimeout(lyricTimingPopoverCloseTimer);
    lyricTimingPopoverCloseTimer = null;
  }
  var root = document.getElementById('lyric-timing-control');
  if (root) root.classList.remove('closing');
}

function suppressLyricTimingSiblingPanels(suppressed) {
  if (typeof setVolumePanelSiblingSuppressed === 'function') setVolumePanelSiblingSuppressed(!!suppressed);
}

function lyricTimingControlIsActive(root) {
  root = root || document.getElementById('lyric-timing-control');
  if (!root) return false;
  var active = document.activeElement;
  return !!((root.matches && root.matches(':hover')) || (active && root.contains(active)));
}

function releaseLyricTimingSiblingPanelsSoon(root) {
  setTimeout(function () {
    if (!lyricTimingControlIsActive(root)) suppressLyricTimingSiblingPanels(false);
  }, 70);
}

function closeLyricTimingPopover(force) {
  var root = document.getElementById('lyric-timing-control');
  if (!root) return;
  if (lyricTimingPopoverCloseTimer) {
    clearTimeout(lyricTimingPopoverCloseTimer);
    lyricTimingPopoverCloseTimer = null;
  }
  releaseLyricTimingPopoverFocus(root);
  root.classList.add('closing');
  lyricTimingPopoverCloseTimer = setTimeout(function () {
    lyricTimingPopoverCloseTimer = null;
    root.classList.remove('closing');
  }, force ? 220 : 160);
  suppressLyricTimingSiblingPanels(false);
}

function updateLyricTimingOffsetUi(songOverride) {
  var song = songOverride || lyricTimingCurrentSong();
  var key = lyricTimingSongKey(song);
  var offset = getLyricTimingOffsetForSong(song);
  var root = document.getElementById('lyric-timing-control');
  var value = document.getElementById('lyric-timing-value');
  var songEl = document.getElementById('lyric-timing-song');
  if (root) root.classList.toggle('has-offset', !!offset);
  if (value) value.textContent = formatLyricTimingOffset(offset);
  if (songEl) songEl.textContent = song ? (song.name || song.title || '当前歌曲') : '未选择歌曲';
  document.querySelectorAll('[data-lyric-offset-step],[data-lyric-offset-reset]').forEach(function (btn) {
    btn.disabled = !key;
  });
}

function refreshLyricTimingAfterOffsetChange() {
  if (stageLyrics) {
    stageLyrics.currentIdx = -999;
    stageLyrics.currentDisplayKey = '';
  }
  if (typeof pushDesktopLyricsState === 'function') pushDesktopLyricsState(true);
}

function setCurrentLyricTimingOffset(offset, opts) {
  opts = opts || {};
  var song = lyricTimingCurrentSong();
  var key = lyricTimingSongKey(song);
  if (!key || !song) {
    updateLyricTimingOffsetUi(song);
    if (!opts.silent) showToast('请先播放歌曲');
    return 0;
  }
  offset = normalizeLyricTimingOffsetSeconds(offset);
  var previous = key && lyricTimingOffsetMap && lyricTimingOffsetMap[key] ? lyricTimingOffsetEntryValue(lyricTimingOffsetMap[key]) : 0;
  var hadEntry = !!(key && lyricTimingOffsetMap && lyricTimingOffsetMap[key]);
  if (!offset && !hadEntry) {
    updateLyricTimingOffsetUi(song);
    refreshLyricTimingAfterOffsetChange();
    if (!opts.silent) showToast(lyricTimingToastText(0));
    return 0;
  }
  if (offset && hadEntry && previous === offset) {
    updateLyricTimingOffsetUi(song);
    if (!opts.silent) showToast(lyricTimingToastText(offset));
    return offset;
  }
  if (offset) {
    lyricTimingOffsetMap[key] = {
      offset: offset,
      updatedAt: Date.now(),
      title: String(song.name || song.title || '').slice(0, 80),
      artist: String(song.artist || '').slice(0, 80)
    };
  } else if (lyricTimingOffsetMap && lyricTimingOffsetMap[key]) {
    delete lyricTimingOffsetMap[key];
  }
  writeLyricTimingOffsetMap();
  updateLyricTimingOffsetUi(song);
  refreshLyricTimingAfterOffsetChange();
  if (!opts.silent) showToast(lyricTimingToastText(offset));
  return offset;
}

function adjustCurrentLyricTimingOffset(delta) {
  var next = getActiveLyricTimingOffsetSeconds() + (Number(delta) || 0);
  return setCurrentLyricTimingOffset(next);
}

function handleLyricTimingOffsetClick(e) {
  if (e && e._mineradioLyricTimingHandled) return;
  var stepBtn = e && e.target && e.target.closest ? e.target.closest('[data-lyric-offset-step]') : null;
  var resetBtn = e && e.target && e.target.closest ? e.target.closest('[data-lyric-offset-reset]') : null;
  if (!stepBtn && !resetBtn) return;
  if (e) {
    e._mineradioLyricTimingHandled = true;
    e.preventDefault();
    e.stopPropagation();
  }
  if (resetBtn) setCurrentLyricTimingOffset(0);
  else adjustCurrentLyricTimingOffset(Number(stepBtn.getAttribute('data-lyric-offset-step')) || 0);
  releaseLyricTimingPopoverFocus(document.getElementById('lyric-timing-control'));
}

function bindLyricTimingOffsetControls() {
  var root = document.getElementById('lyric-timing-control');
  if (!root || root._mineradioLyricTimingBound) return;
  root._mineradioLyricTimingBound = true;
  root.addEventListener('mouseenter', function () {
    suppressLyricTimingSiblingPanels(true);
    clearLyricTimingPopoverClose();
    updateLyricTimingOffsetUi();
  });
  root.addEventListener('focusin', function () {
    suppressLyricTimingSiblingPanels(true);
    clearLyricTimingPopoverClose();
    updateLyricTimingOffsetUi();
  });
  root.addEventListener('mouseleave', function () { releaseLyricTimingSiblingPanelsSoon(root); });
  root.addEventListener('focusout', function () { releaseLyricTimingSiblingPanelsSoon(root); });
  root.addEventListener('click', handleLyricTimingOffsetClick);
  root.querySelectorAll('[data-lyric-offset-step],[data-lyric-offset-reset]').forEach(function (btn) {
    btn.addEventListener('click', handleLyricTimingOffsetClick);
  });
  document.addEventListener('pointerdown', function (e) {
    if (!root.contains(e.target)) closeLyricTimingPopover(false);
  }, true);
  updateLyricTimingOffsetUi();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindLyricTimingOffsetControls);
else bindLyricTimingOffsetControls();

// ============================================================
// MineRadio「词」体系：同步设置入口（方案 B）
//
// 这里**只做入口 + 单实例容器**，绝不渲染第二份设置控件。容器首次打开时，把现有 SMTC 设置节点
// 整体「搬入」本容器：
//   #smtc-session-row        SMTC 会话状态 + 刷新会话（03-smtc-ui.js）
//   #smtc-builtin-timer-block 时间轴来源（06-smtc-builtin-timer.js）
//   #smtc-hover-delay-slot   SMTC 会话延迟（05-smtc-lyric-sources.js 渲染）
// 既有实现全部按 id 查找，因此 smtcRenderSmtcSessionRow / smtcEnsureBuiltinTimerUi /
// smtcRenderSessionDelayBlock / smtcRenderSessionDelayValue / smtcUpdateSessionDelayEnabledState
// 一行都不用改，也不会出现重复 id。
//
// 不动：SMTC store / 时间轴稳定器 / 播放控制 / 进度条 / AM currentPlaybackContext。
// ============================================================
var syncSettingsOpen = false;
var syncSettingsAdopted = false;
var syncSettingsBound = false;

function syncSettingsPanelEl() { return document.getElementById('sync-settings-panel'); }
function syncSettingsControlRoot() { return document.getElementById('lyric-timing-control'); }

function syncSettingsAdoptExistingBlocks() {
  if (syncSettingsAdopted) return true;
  var panel = syncSettingsPanelEl();
  var sessionSlot = document.getElementById('sync-settings-session');
  var body = document.getElementById('sync-settings-body');
  if (!panel || !sessionSlot || !body) return false;
  // 先把隐藏宿主构建出来（三个设置节点在其中创建），否则搬无可搬
  if (typeof smtcEnsureSettingsHost === 'function') {
    try { smtcEnsureSettingsHost(); } catch (e) { }
  }
  var row = document.getElementById('smtc-session-row');
  if (row && row.parentNode !== sessionSlot) sessionSlot.appendChild(row);
  var slot = document.getElementById('smtc-hover-delay-slot');
  if (slot && slot.parentNode !== body) body.appendChild(slot);
  var timerBlock = document.getElementById('smtc-builtin-timer-block');
  if (timerBlock && timerBlock.parentNode !== body) body.insertBefore(timerBlock, slot || null);
  // 这两个块此前可能从未渲染（悬浮面板没展开过）→ 用既有幂等函数补建，落在搬入后的容器里
  if (typeof smtcEnsureHoverSessionDelay === 'function') { try { smtcEnsureHoverSessionDelay(); } catch (e) { } }
  if (typeof smtcEnsureBuiltinTimerUi === 'function') { try { smtcEnsureBuiltinTimerUi(); } catch (e) { } }
  syncSettingsAdopted = true;
  return true;
}

function syncSettingsRefreshValues() {
  if (typeof smtcRenderSmtcSessionRow === 'function') { try { smtcRenderSmtcSessionRow(); } catch (e) { } }
  if (typeof smtcRenderSessionDelayValue === 'function') { try { smtcRenderSessionDelayValue(); } catch (e) { } }
  if (typeof smtcRenderBuiltinTimerUi === 'function') { try { smtcRenderBuiltinTimerUi(); } catch (e) { } }
  if (typeof smtcUpdateSessionDelayEnabledState === 'function') { try { smtcUpdateSessionDelayEnabledState(); } catch (e) { } }
}

function syncSettingsBindOnce() {
  if (syncSettingsBound) return;
  var root = syncSettingsControlRoot();
  if (!root) return;
  syncSettingsBound = true;
  // 鼠标离开「词」控件即收起。加一个宽限期并在触发时复核：指针在两块面板之间穿行时可能瞬间被判为

  // leave（mouseleave 只看当前目标链，不看路径），立即关闭会让人以为「面板自己关了」。

  root.addEventListener('mouseleave', function () {

    if (!syncSettingsOpen) return;

    setTimeout(function () {

      if (!syncSettingsOpen) return;

      if (typeof lyricTimingControlIsActive === 'function' && lyricTimingControlIsActive(root)) return;

      closeSyncSettingsPanel();

    }, 140);

  });
  document.addEventListener('click', function (e) {
    if (!syncSettingsOpen) return;
    if (root.contains(e.target)) return;
    closeSyncSettingsPanel();
  });
  document.addEventListener('keydown', function (e) {
    if (syncSettingsOpen && e.key === 'Escape') closeSyncSettingsPanel();
  });
}

function openSyncSettingsPanel(event) {
  if (event && event.stopPropagation) event.stopPropagation();
  if (!syncSettingsAdoptExistingBlocks()) return false;
  var panel = syncSettingsPanelEl();
  var root = syncSettingsControlRoot();
  if (!panel) return false;
  panel.classList.add('open');
  if (root) root.classList.add('sync-open');
  syncSettingsOpen = true;
  syncSettingsBindOnce();
  syncSettingsRefreshValues();
  return true;
}

function closeSyncSettingsPanel(force) {
  var panel = syncSettingsPanelEl();
  var root = syncSettingsControlRoot();
  if (panel) panel.classList.remove('open');
  if (root) root.classList.remove('sync-open');
  syncSettingsOpen = false;
  return !force;
}

function toggleSyncSettingsPanel(event) {
  if (event && event.stopPropagation) event.stopPropagation();
  return syncSettingsOpen ? closeSyncSettingsPanel() : openSyncSettingsPanel();
}

// 「歌词源」入口：只调用既有窗口（音源优先级真正的排序 UI 仍在那个独立窗口里）。
function openLyricSourceSettingsFromBar(event) {
  if (event && event.stopPropagation) event.stopPropagation();
  var api = window.desktopWindow;
  if (!api || typeof api.openLyricsSourceWindow !== 'function') return false;
  var order = (typeof smtcLyricSourceSettings === 'function') ? (smtcLyricSourceSettings().order || []) : [];
  api.openLyricsSourceWindow({ order: order });
  return true;
}

// 恢复默认：只用既有 setter（会话延迟归零 + 时间轴来源回到 SMTC），不直接写 localStorage、
// 不碰 SMTC store / 稳定器 / 播放控制。
function resetSyncSettings() {
  var delay = null;
  var mode = null;
  if (typeof smtcSetSessionDelayMs === 'function') { try { delay = smtcSetSessionDelayMs(0); } catch (e) { } }
  if (typeof smtcSetLyricTimelineMode === 'function') { try { mode = smtcSetLyricTimelineMode('SMTC'); } catch (e) { } }
  syncSettingsRefreshValues();
  if (typeof showToast === 'function') {
    showToast('同步设置已恢复默认' + (delay === null ? '' : ('（延迟 ' + delay + 'ms')) + (mode ? '（时间轴 SMTC）' : ''));
  }
  return { delayMs: delay, timelineMode: mode };
}
