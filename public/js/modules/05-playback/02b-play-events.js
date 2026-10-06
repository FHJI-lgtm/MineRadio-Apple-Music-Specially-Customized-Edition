// ============================================================
// 05-playback/02b-play-events.js
// P0 黑匣子 —— append-only 播放事件表。
//
// 设计原则:
//   1. 只追加, 绝不按 key 去重。现有 mineradio-listen-stats-v1 的 history 是按 key 去重的
//      (02-listen-stats.js:261), 它回答"最近听过哪些不同的歌", 回答不了"最近 20 次播放".
//      事件表回答后者, 两者并存, 互不替代。
//   2. 无门槛。现有 finalizeListenSession 会丢掉 <45s 且 <50% 的会话 (02-listen-stats.js:233),
//      而短跳过正是推荐系统最需要的负反馈 —— 事件表必须在那个 return 之前就被写入。
//   3. 绝不抛异常。录音机坏了不能让播放链路跟着坏; 所有入口 try/catch, 失败只 warn。
//   4. 有 IndexedDB 就用 IndexedDB; 没有(单测/vm)就退回内存数组, 接口完全一致。
//
// 事件类型:
//   play         播放会话结束(含短跳过)     —— 主事件
//   seek         用户拖动进度
//   error        播放失败 / 换源失败
//   mode         播放模式变化
//   shuffle-shadow  Smart Shuffle 影子推演
// ============================================================

var PLAY_EVENTS_DB_NAME = 'mineradio-play-events';
var PLAY_EVENTS_DB_VERSION = 1;
var PLAY_EVENTS_STORE = 'events';
var PLAY_EVENTS_MEMORY_LIMIT = 8000;
var PLAY_EVENTS_KEEP_DAYS = 90;

var playEventsMemory = [];        // 内存真源(无 IDB 时)/ IDB 不可用期间的缓冲
var playEventsDb = null;
var playEventsDbPromise = null;
var playEventsPendingWrites = [];
var playEventsSerial = 0;
var playEventsCurrentSession = null;
// 聚合结果缓存: 供 02c 评分层同步读取 earlySkipRate
var playEventsSongStats = {};
var playEventsArtistStats = {};
// 外部(SMTC/Apple Music)收听没有真实曲目 ID, 只能按跨源签名单独聚合。
// 与四源统计物理分开: 评分层按不同键查找, 两者不会互相污染。
var playEventsSignatureStats = {};
// 宽松桶: 只用于"艺人改名/标题带 (feat.)(Clean) 标注"导致的跨源归因回退
var playEventsLooseStats = {};
var playEventsAggregatedAt = 0;

function playEventsHasIndexedDb() {
  try { return typeof indexedDB !== 'undefined' && !!indexedDB; } catch (e) { return false; }
}

function openPlayEventsDb() {
  if (playEventsDbPromise) return playEventsDbPromise;
  if (!playEventsHasIndexedDb()) { playEventsDbPromise = Promise.resolve(null); return playEventsDbPromise; }
  playEventsDbPromise = new Promise(function (resolve) {
    var settled = false;
    var finish = function (db) { if (!settled) { settled = true; playEventsDb = db; resolve(db); } };
    try {
      var request = indexedDB.open(PLAY_EVENTS_DB_NAME, PLAY_EVENTS_DB_VERSION);
      request.onupgradeneeded = function (event) {
        try {
          var db = event.target.result;
          if (!db.objectStoreNames.contains(PLAY_EVENTS_STORE)) {
            var store = db.createObjectStore(PLAY_EVENTS_STORE, { keyPath: 'id', autoIncrement: true });
            store.createIndex('startedAt', 'startedAt', { unique: false });
            store.createIndex('type', 'type', { unique: false });
          }
        } catch (e) { }
      };
      request.onsuccess = function () { finish(request.result); };
      request.onerror = function () { finish(null); };
      request.onblocked = function () { finish(null); };
      // 某些环境 open 可能永远不回调: 兜底超时, 退回内存
      setTimeout(function () { finish(null); }, 1500);
    } catch (e) { finish(null); }
  });
  return playEventsDbPromise;
}

function playEventsFlushPending(db) {
  if (!db || !playEventsPendingWrites.length) return;
  var batch = playEventsPendingWrites.slice();
  playEventsPendingWrites = [];
  batch.forEach(function (evt) { playEventsWriteOne(db, evt); });
}

function playEventsWriteOne(db, evt) {
  try {
    var tx = db.transaction(PLAY_EVENTS_STORE, 'readwrite');
    tx.objectStore(PLAY_EVENTS_STORE).add(evt);
    tx.oncomplete = function () { };
    tx.onerror = function () { };
  } catch (e) { }
}

// 唯一写入入口。永远不抛。
function playEventRecord(evt) {
  var record = null;
  try {
    evt = evt && typeof evt === 'object' ? evt : {};
    playEventsSerial += 1;
    record = Object.assign({
      v: 1,
      id: 'pe-' + Date.now().toString(36) + '-' + playEventsSerial.toString(36),
      type: evt.type || 'play',
      startedAt: Number(evt.startedAt) || Date.now(),
      recordedAt: Date.now()
    }, evt);
    if (!record.type) record.type = 'play';
  } catch (e) { return null; }

  try {
    playEventsMemory.push(record);
    playEventsTotalCount += 1;
    if (playEventsMemory.length > PLAY_EVENTS_MEMORY_LIMIT) {
      playEventsMemory.splice(0, playEventsMemory.length - PLAY_EVENTS_MEMORY_LIMIT);
    }
  } catch (e) { }

  try {
    if (playEventsDb) playEventsWriteOne(playEventsDb, record);
    else if (playEventsHasIndexedDb()) {
      playEventsPendingWrites.push(record);
      openPlayEventsDb().then(function (db) { playEventsFlushPending(db); }, function () { });
    }
    // 记录即更新内存聚合缓存(轻量增量), 评分层可立刻读到
    playEventsAccumulate(record);
    playEventsDailyAccumulate(record);
  } catch (e) { }

  return record;
}

// ------------------------------------------------------------
// 会话生命周期: begin 记在内存, finalize 落事件(无论是否"有效收听")
// ------------------------------------------------------------
function playEventBeginSession(session, context) {
  try {
    if (!session || !session.key) return null;
    playEventsCurrentSession = {
      sessionId: session.sessionId || '',
      key: session.key,
      startedAt: Number(session.startedAt) || Date.now(),
      context: context || session.context || null
    };
  } catch (e) { }
  return playEventsCurrentSession;
}

function playEventFinalizeSession(session, info) {
  try {
    session = session || playEventsCurrentSession || {};
    info = info && typeof info === 'object' ? info : {};
    var snap = session.song || {};
    var listenMs = Math.max(0, Math.round(Number(info.listenMs != null ? info.listenMs : session.listenMs) || 0));
    var durationMs = Math.max(0, Math.round(Number(info.durationMs) || 0));
    if (!durationMs) durationMs = shuffleMsAnySafe(snap.duration);
    var maxProgress = Math.max(0, Number(info.maxProgress != null ? info.maxProgress : session.maxProgress) || 0);
    var completed = !!info.completed;
    var endReason = String(info.endReason || (completed ? 'ended' : 'track-switch'));

    // 早跳判定: 非自然结束 且 没听过 30% —— 这是 P0 最想拿到的负反馈
    var earlySkip = !completed && maxProgress < 0.3;

    return playEventRecord({
      type: 'play',
      sessionId: session.sessionId || '',
      key: session.key || '',
      provider: snap.provider || snap.source || '',
      sourceKey: snap.sourceKey || '',
      resolvedPlaybackProvider: snap.resolvedPlaybackProvider || '',
      name: snap.name || '',
      artist: snap.artist || '',
      album: snap.album || '',
      albumId: snap.albumId || '',
      durationMs: durationMs,
      startedAt: Number(session.startedAt) || Date.now(),
      endedAt: Date.now(),
      listenMs: listenMs,
      maxProgress: maxProgress,
      listenRatio: durationMs > 0 ? Math.min(1, listenMs / durationMs) : 0,
      endReason: endReason,
      userInitiated: !!info.userInitiated,
      earlySkip: earlySkip,
      completed: completed,
      effective: !!info.effective,
      playMode: info.playMode || (typeof playMode !== 'undefined' ? playMode : ''),
      insertedBy: info.insertedBy || snap.insertedBy || 'user',
      context: session.context || null
    });
  } catch (e) {
    try { console.warn('[PlayEvents] finalize failed:', e && e.message); } catch (e2) { }
    return null;
  }
}

function shuffleMsAnySafe(v) {
  var n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return n > 10000 ? n : Math.round(n * 1000);
}

// ------------------------------------------------------------
// 增量聚合 (内存): 供评分层同步读取
// ------------------------------------------------------------
function playEventsAccumulateInto(bucket, bucketKey, record) {
  var song = bucket[bucketKey] || {
    key: bucketKey, name: '', artist: '', album: '',
    plays: 0, completed: 0, earlySkips: 0, listenMs: 0, lastPlayedAt: 0
  };
  song.name = record.name || song.name;
  song.artist = record.artist || song.artist;
  song.album = record.album || song.album;
  song.plays += 1;
  song.completed += record.completed ? 1 : 0;
  song.earlySkips += record.earlySkip ? 1 : 0;
  song.listenMs += Math.max(0, Number(record.listenMs) || 0);
  song.lastPlayedAt = Math.max(song.lastPlayedAt, Number(record.endedAt) || Number(record.startedAt) || Date.now());
  song.earlySkipRate = song.plays > 0 ? song.earlySkips / song.plays : 0;
  song.completionRate = song.plays > 0 ? song.completed / song.plays : 0;
  bucket[bucketKey] = song;
}

function playEventsAccumulate(record) {
  if (!record || record.type !== 'play') return;
  var external = record.provider === 'smtc-external';
  var bucketKey = external ? (record.sig || '') : (record.key || '');
  if (bucketKey) {
    playEventsAccumulateInto(external ? playEventsSignatureStats : playEventsSongStats, bucketKey, record);
  }
  // 外部收听**额外**进一个宽松桶(不含艺人): Apple 用新名(Abel Tesfaye), 四源还是旧名(The Weeknd),
  // 严格签名匹配不上时靠它把 affinity 救回来。只影响统计, 不影响冷却/播放。
  if (external) {
    var looseKeys = (Array.isArray(record.sigLooseVariants) && record.sigLooseVariants.length)
      ? record.sigLooseVariants
      : (record.sigLoose ? [record.sigLoose] : []);
    for (var li = 0; li < looseKeys.length; li++) {
      playEventsAccumulateInto(playEventsLooseStats, looseKeys[li], record);
    }
  }
  if (!bucketKey && !(external && (record.sigLoose || (record.sigLooseVariants || []).length))) return;

  var names = String(record.artist || '').split(/\s*\/\s*|\s*,\s*|、|&/);
  names.forEach(function (raw) {
    var name = String(raw || '').trim();
    if (!name) return;
    var artist = playEventsArtistStats[name] || { name: name, plays: 0, listenMs: 0, lastPlayedAt: 0 };
    artist.plays += 1;
    artist.listenMs += Math.max(0, Number(record.listenMs) || 0);
    artist.lastPlayedAt = Math.max(artist.lastPlayedAt, Number(record.endedAt) || Date.now());
    playEventsArtistStats[name] = artist;
  });
  playEventsAggregatedAt = Date.now();
}

// ------------------------------------------------------------
// 每日聚合: 首页"今日聆听"改用这里, 与事件表**同一口径**
// ------------------------------------------------------------
// 旧实现只统计内部播放(listenStatsState), 导致用 Apple Music 听歌时首页一直是 0。
// 事件表同时覆盖内部播放与 SMTC 外部播放, 所以它才是"今天听了多少"的真源。
var playEventsDaily = {};
var PLAY_EVENTS_DAILY_KEEP_DAYS = 60;

function playEventsDayKey(timestamp) {
  var date = new Date(Number(timestamp) || Date.now());
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

function playEventsPruneDaily() {
  var keys = Object.keys(playEventsDaily).sort();
  while (keys.length > PLAY_EVENTS_DAILY_KEEP_DAYS) delete playEventsDaily[keys.shift()];
}

function playEventsDailyAccumulate(record) {
  if (!record) return;
  var dayKey = playEventsDayKey(record.endedAt || record.startedAt);
  var day = playEventsDaily[dayKey];
  if (!day) {
    day = { listenMs: 0, plays: 0, completed: 0, external: 0, errors: 0, keys: {} };
    playEventsDaily[dayKey] = day;
  }
  if (record.type === 'play') {
    day.plays += 1;
    day.listenMs += Math.max(0, Number(record.listenMs) || 0);
    if (record.completed) day.completed += 1;
    if (record.provider === 'smtc-external') day.external += 1;
    var key = record.key || record.sig || '';
    if (key) day.keys[key] = 1;
  } else if (record.type === 'error') {
    day.errors += 1;
  }
  playEventsPruneDaily();
}

function playEventsDailySummaryFor(dayKey) {
  var day = playEventsDaily[String(dayKey || '')];
  if (!day) return { has: false, listenMs: 0, plays: 0, songCount: 0, completed: 0, external: 0 };
  return {
    has: true,
    listenMs: Math.max(0, Number(day.listenMs) || 0),
    plays: Math.max(0, Number(day.plays) || 0),
    songCount: Object.keys(day.keys || {}).length,
    completed: Math.max(0, Number(day.completed) || 0),
    external: Math.max(0, Number(day.external) || 0)
  };
}

function playEventsDailyDayKeys() { return Object.keys(playEventsDaily); }

// 从持久层重建聚合(启动后调用一次; 失败保持内存增量结果)
function playEventsRebuildAggregate() {
  return playEventQueryAll().then(function (list) {
    playEventsSongStats = {};
    playEventsArtistStats = {};
    playEventsSignatureStats = {};
    playEventsLooseStats = {};
    playEventsDaily = {};
    playEventsTotalCount = (list || []).length;
    (list || []).forEach(function (record) {
      playEventsAccumulate(record);
      playEventsDailyAccumulate(record);
    });
    playEventsAggregatedAt = Date.now();
    // 重建完成后刷新首页(它是异步的, 首次渲染时事件表可能还没读回来)
    try { if (typeof renderHomeInsightDock === 'function') renderHomeInsightDock(); } catch (e) { }
    return { songs: playEventsSongStats, artists: playEventsArtistStats, count: (list || []).length };
  }, function () {
    return { songs: playEventsSongStats, artists: playEventsArtistStats, count: -1 };
  });
}

// 累计条数: 供 UI 一眼看出"到底有没有在采集"。启动时从 IDB 重建, 之后每条 +1。
var playEventsTotalCount = 0;
function playEventsTotalRecorded() { return playEventsTotalCount; }

function playEventsSongStatsMap() { return playEventsSongStats; }
function playEventsSignatureStatsMap() { return playEventsSignatureStats; }
function playEventsLooseStatsMap() { return playEventsLooseStats; }
function playEventsArtistStatsMap() { return playEventsArtistStats; }

// ------------------------------------------------------------
// 查询
// ------------------------------------------------------------
function playEventQueryAll(opts) {
  opts = opts || {};
  var limit = Math.max(1, Math.min(20000, Number(opts.limit) || 20000));
  var since = Number(opts.since) || 0;
  var type = opts.type ? String(opts.type) : '';
  var filter = function (list) {
    return list.filter(function (e) {
      if (since && (Number(e.startedAt) || 0) < since) return false;
      if (type && e.type !== type) return false;
      return true;
    }).slice(-limit);
  };
  return openPlayEventsDb().then(function (db) {
    if (!db) return filter(playEventsMemory.slice());
    return new Promise(function (resolve) {
      var out = [];
      try {
        var tx = db.transaction(PLAY_EVENTS_STORE, 'readonly');
        var req = tx.objectStore(PLAY_EVENTS_STORE).openCursor();
        req.onsuccess = function (event) {
          var cursor = event.target.result;
          if (cursor) { out.push(cursor.value); cursor.continue(); }
          else resolve(filter(out));
        };
        req.onerror = function () { resolve(filter(playEventsMemory.slice())); };
      } catch (e) { resolve(filter(playEventsMemory.slice())); }
    });
  });
}

function playEventCount() { return playEventsMemory.length; }

// 每天一行: 播放 / 完整 / 短跳 / 手动切歌 / 错误 —— 审计文档里那张"每天可看"的表
function playEventDailySummary(list) {
  var rows = {};
  (list || playEventsMemory).forEach(function (e) {
    var ts = Number(e.startedAt) || 0;
    if (!ts) return;
    var d = new Date(ts);
    var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    var row = rows[key] || { day: key, plays: 0, completed: 0, earlySkip: 0, manualNext: 0, errors: 0, listenMs: 0, external: 0 };
    if (e.type === 'play') {
      row.plays += 1;
      if (e.provider === 'smtc-external') row.external += 1;
      row.completed += e.completed ? 1 : 0;
      row.earlySkip += e.earlySkip ? 1 : 0;
      if (e.userInitiated && (e.endReason === 'next' || e.endReason === 'prev')) row.manualNext += 1;
      row.listenMs += Math.max(0, Number(e.listenMs) || 0);
    } else if (e.type === 'error') {
      row.errors += 1;
    }
    rows[key] = row;
  });
  return Object.keys(rows).sort().map(function (k) { return rows[k]; });
}

if (typeof window !== 'undefined' && window) {
  try {
    window.playEventRecord = playEventRecord;
    window.playEventQueryAll = playEventQueryAll;
    window.playEventDailySummary = playEventDailySummary;
  } catch (e) { }
}
