function queueSong(song, opts) {
  opts = opts || {};
  if (!song) return -1;
  var cloned = cloneSong(song);
  var insertAt = playQueue.length;
  if (opts.position === 'next') {
    var key = queueItemKey(cloned);
    var existing = -1;
    if (key) {
      for (var i = 0; i < playQueue.length; i++) {
        if (queueItemKey(playQueue[i]) === key) { existing = i; break; }
      }
    }
    if (existing === currentIdx) return currentIdx;
    if (existing >= 0) {
      cloned = playQueue.splice(existing, 1)[0];
      if (currentIdx >= 0 && existing < currentIdx) currentIdx -= 1;
    }
    var hasCurrent = currentIdx >= 0 && currentIdx < playQueue.length;
    insertAt = hasCurrent ? Math.min(playQueue.length, currentIdx + 1) : playQueue.length;
    playQueue.splice(insertAt, 0, cloned);
  } else {
    playQueue.push(cloned);
    insertAt = playQueue.length - 1;
  }
  safeRenderQueuePanel('queue-song');
  safeShelfRebuild('queue-song');
  return insertAt;
}
function queueSongNext(song) {
  return queueSong(song, { position: 'next' });
}
function queueSearchResult(i) {
  var song = playlist[i]; if (!song) return;
  queueSongNext(song);
  showToast('已设为下一首: ' + song.name);
}
function queueDetailSongNext(song) {
  if (!song || song.type === 'podcast-radio') return;
  queueSongNext(song);
  showToast('已设为下一首: ' + (song.name || ''));
}
function queueIndexNext(i) {
  i = Number(i);
  if (!isFinite(i) || i < 0 || i >= playQueue.length) return;
  var song = playQueue[i];
  queueSongNext(song);
  showToast('已设为下一首: ' + (song && song.name ? song.name : ''));
}
function openQueueArtist(i) {
  var song = playQueue && playQueue[i];
  if (song) openArtistDetailForSong(song);
}
function moveQueueIndexToTop(idx) {
  idx = Number(idx);
  if (!isFinite(idx) || idx < 0 || idx >= playQueue.length) return -1;
  if (idx === 0) return 0;
  var item = playQueue.splice(idx, 1)[0];
  playQueue.unshift(item);
  if (currentIdx === idx) currentIdx = 0;
  else if (currentIdx >= 0 && currentIdx < idx) currentIdx += 1;
  return 0;
}
function moveQueueIndex(fromIdx, toIdx, opts) {
  opts = opts || {};
  fromIdx = Math.round(Number(fromIdx));
  toIdx = Math.round(Number(toIdx));
  if (!playQueue.length) return false;
  if (!isFinite(fromIdx) || !isFinite(toIdx)) return false;
  if (fromIdx < 0 || fromIdx >= playQueue.length) return false;
  toIdx = Math.max(0, Math.min(playQueue.length - 1, toIdx));
  if (fromIdx === toIdx) return false;
  var currentSong = currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null;
  var item = playQueue.splice(fromIdx, 1)[0];
  playQueue.splice(toIdx, 0, item);
  if (currentSong) {
    var nextCurrentIdx = playQueue.indexOf(currentSong);
    currentIdx = nextCurrentIdx >= 0 ? nextCurrentIdx : Math.min(currentIdx, playQueue.length - 1);
  } else {
    currentIdx = -1;
  }
  if (opts.renderPanel !== false) safeRenderQueuePanel('queue-reorder', { animate: false, scrollCurrent: false, deferWhenHidden: false });
  if (opts.rebuildShelf !== false) safeShelfRebuild('queue-reorder', true);
  if (opts.persistSnapshot !== false && typeof saveLastPlaybackSnapshot === 'function') saveLastPlaybackSnapshot(true, 'queue-reorder');
  return true;
}
// ------------------------------------------------------------
// 公共播放入口：把一个**带稳定身份的歌曲对象**安全交给现有播放链
// ------------------------------------------------------------
// 只做三件事: 队列管理(复用 queueSong: clone + 按 queueItemKey 去重 + 插入)、
// 切到它、调 playQueueAt。**不做来源选择** —— 换源由 playQueueAt 内部
// -> 11-provider-fallback 那条既有链路负责, 这里一行都不碰。
//
// 安全校验: 没有稳定身份键(只有歌名/艺人的裸数据)一律拒绝, 且不改队列。
// 返回 Promise<boolean>, false = 没播成(调用方如实提示, 不谎报)。
function playSongEntry(song, opts) {
  opts = opts || {};
  if (!song || typeof song !== 'object') return Promise.resolve(false);
  if (typeof queueSong !== 'function' || typeof playQueueAt !== 'function') return Promise.resolve(false);
  if (typeof queueItemKey !== 'function') return Promise.resolve(false);
  var key = '';
  try { key = queueItemKey(song) || ''; } catch (e) { key = ''; }
  if (!key) return Promise.resolve(false);

  var idx = -1;
  try {
    idx = queueSong(song, { position: 'next' });
  } catch (e) {
    idx = -1;
  }
  if (typeof idx !== 'number' || idx < 0 || idx >= playQueue.length) return Promise.resolve(false);
  currentIdx = idx;
  try {
    return Promise.resolve(playQueueAt(currentIdx, { manual: true, context: opts.context || null }))
      .then(function (ok) { return ok !== false; })
      .catch(function () { return false; });
  } catch (e) {
    return Promise.resolve(false);
  }
}
try { window.playSongEntry = playSongEntry; } catch (e) { }

function playSearchResult(i) {
  var song = playlist[i]; if (!song) return;
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  if (!playQueue.length) { playQueue.unshift(cloneSong(song)); currentIdx = 0; }
  else {
    var matchIdx = -1;
    var targetKey = queueItemKey(song);
    for (var j = 0; j < playQueue.length; j++) if (queueItemKey(playQueue[j]) === targetKey) { matchIdx = j; break; }
    if (matchIdx >= 0) currentIdx = moveQueueIndexToTop(matchIdx);
    else { playQueue.unshift(cloneSong(song)); currentIdx = 0; }
  }
  $results.classList.remove('show');
  $input.value = ''; $input.blur();
  playQueueAt(currentIdx);
}
