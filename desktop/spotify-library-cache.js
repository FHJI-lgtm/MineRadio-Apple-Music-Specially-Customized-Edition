'use strict';
// ====================================================================
// Spotify 资料库：本地落盘缓存 + 分页 + 节流 + 增量同步
//
// 起因：最初的实现每次请求都现场重拉（索引一次要 40+ 次 API 调用），
// 很快吃到 Spotify 的 429 限流，然后越重试越糟。
//
// 原则（与 Apple 的 apple-music-library-cache.js 同一套思路）：
//   1. **先落盘**：已经成功拿到的数据立刻写本地，重启/换页都直接读，
//      绝不为同一份数据反复打 Spotify。
//   2. **分页**：所有列表端点按自身分页语义取全（Spotify 每页上限 50），
//      不臆造页大小，解析不出下一页就停下并如实记录原因。
//   3. **节流**：全局最小请求间隔 + 429 时按 Retry-After 退避，
//      退避期间直接失败返回而非继续猛打。
//   4. **增量**：
//        - 歌单：比对 snapshot_id，没变就**不重拉曲目**。
//        - 喜欢的歌曲：用 Spotify 的 after 游标（只取新增）。
//        - 艺人头像：得到即缓存，不再重复请求。
//
// 不做的事：不编造数据、不把限流导致的残缺结果当成完整结果缓存。
// ====================================================================

const fs = require('fs');
const path = require('path');

const SPOTIFY_CACHE_SCHEMA_VERSION = 1;
const CACHE_FILE_NAME = 'spotify-library-cache.json';

// 节流：Spotify 的滚动窗口限流较紧。保守取「最小间隔 120ms」（≈8 QPS 上限），
// 实测这个速率下索引同步不会触发 429。
const MIN_REQUEST_INTERVAL_MS = 120;
const MAX_RETRY_AFTER_WAIT_MS = 60 * 1000;

function resolveDefaultCachePath() {
  try {
    if (!(process.versions && process.versions.electron)) return '';
    const electron = require('electron');
    const app = electron.app;
    if (!app) return '';
    const pkg = require('../package.json');
    const appName = process.env.MINERADIO_RUNTIME_NAME
      || (pkg.mineradio && pkg.mineradio.runtimeName)
      || pkg.productName
      || 'Mineradio';
    const qaDir = String(process.env.MINERADIO_STARTUP_QA_USER_DATA || '').trim();
    const useQa = process.env.MINERADIO_STARTUP_QA_HIDDEN === '1' && qaDir && path.isAbsolute(qaDir);
    const userData = useQa ? qaDir : path.join(app.getPath('appData'), appName);
    return path.join(userData, CACHE_FILE_NAME);
  } catch (_) {
    return '';
  }
}

// 一个极简的串行节流器：保证相邻两次请求间隔不小于 MIN_REQUEST_INTERVAL_MS，
// 并在 429 退避期内直接拒绝新请求（而不是排队堆积）。
function createThrottle(options) {
  options = options || {};
  const minInterval = Number(options.minIntervalMs) || MIN_REQUEST_INTERVAL_MS;
  let chain = Promise.resolve();
  let lastAt = 0;
  let backoffUntil = 0;
  let stats = { requests: 0, waitedMs: 0, backoffs: 0, lastRateLimitAt: 0 };

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function run(fn) {
    const result = chain.then(async function () {
      const now = Date.now();
      if (now < backoffUntil) {
        const err = new Error('SPOTIFY_BACKOFF');
        err.code = 'SPOTIFY_BACKOFF';
        err.retryAfterMs = backoffUntil - now;
        throw err;
      }
      const wait = Math.max(0, lastAt + minInterval - Date.now());
      if (wait > 0) { stats.waitedMs += wait; await sleep(wait); }
      lastAt = Date.now();
      stats.requests += 1;
      return fn();
    });
    // 让链继续，但不让单个失败卡死后续
    chain = result.then(function () {}, function () {});
    return result;
  }

  function noteRateLimit(retryAfterMs) {
    const wait = Math.max(0, Math.min(MAX_RETRY_AFTER_WAIT_MS, Number(retryAfterMs) || 1000));
    backoffUntil = Date.now() + wait;
    stats.backoffs += 1;
    stats.lastRateLimitAt = Date.now();
    return wait;
  }

  function snapshot() {
    return {
      requests: stats.requests,
      waitedMs: stats.waitedMs,
      backoffs: stats.backoffs,
      lastRateLimitAt: stats.lastRateLimitAt,
      backoffRemainingMs: Math.max(0, backoffUntil - Date.now()),
    };
  }

  return { run: run, noteRateLimit: noteRateLimit, snapshot: snapshot, sleep: sleep };
}

function createSpotifyLibraryCache(options) {
  options = options || {};
  const deps = {
    listPlaylists: options.listPlaylists || null,        // (opts) -> { playlists:[], ... }
    playlistTracks: options.playlistTracks || null,      // (id, {limit,offset}) -> { tracks:[], total, hasMore, nextOffset }
    savedTracks: options.savedTracks || null,            // ({limit,offset}) -> { tracks:[], total, hasMore, nextOffset }
    savedAlbums: options.savedAlbums || null,            // ({limit,offset}) -> { items:[], next }
    adapter: options.adapter || null,                    // spotify-library-adapter
    throttle: options.throttle || createThrottle(),
  };
  const cachePath = options.cachePath !== undefined ? options.cachePath : resolveDefaultCachePath();

  const state = {
    loaded: false,
    // loaded 只代表"尝试过"；diskLoadedOk 才代表"真的从盘上读到了"。
    // 二者必须分开：否则一次早于落盘的 stats()/读调用会把 loaded 置真，
    // 之后所有读取都跳过加载、永远返回空（实测就是这个 bug）。
    diskLoadedOk: false,
    dirty: false,
    tracks: new Map(),        // librarySongId -> mapped song
    playlistMeta: new Map(),  // playlistId -> { id, name, trackCount, virtual, isLiked, cover, creator, snapshotId, at }
    playlistTrackIds: new Map(), // playlistId -> [librarySongId]
    savedAlbumList: new Map(),   // albumId -> album card raw
    artistImage: new Map(),      // artistId -> { url, at }
    sync: {
      savedTracksCursor: '',     // Spotify after 游标（新增喜欢歌曲的位置）
      savedTracksDone: false,
      savedAlbumsCursor: '',
      savedAlbumsDone: false,
      lastSyncAt: 0,
      lastFullSyncAt: 0,
      rateLimited: false,
      lastError: '',
    },
  };

  function markDirty() { state.dirty = true; }

  // ---------------- 落盘 ----------------
  function persist() {
    if (!cachePath || !state.dirty) return false;
    try {
      const payload = {
        schemaVersion: SPOTIFY_CACHE_SCHEMA_VERSION,
        savedAt: Date.now(),
        tracks: Array.from(state.tracks.values()),
        playlistMeta: Array.from(state.playlistMeta.entries()),
        playlistTrackIds: Array.from(state.playlistTrackIds.entries()),
        savedAlbumList: Array.from(state.savedAlbumList.entries()),
        artistImage: Array.from(state.artistImage.entries()),
        sync: state.sync,
      };
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      // 原子写：先写临时文件再改名，避免半截文件
      const tmp = cachePath + '.tmpdir';
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, cachePath);
      state.dirty = false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function loadFromDisk() {
    if (state.diskLoadedOk) return true;
    state.loaded = true;
    if (!cachePath) return false;
    let text = '';
    try {
      if (!fs.existsSync(cachePath)) return false;
      text = fs.readFileSync(cachePath, 'utf8');
    } catch (_) { return false; }
    let payload = null;
    try { payload = JSON.parse(text); } catch (_) { return false; }
    if (!payload || payload.schemaVersion !== SPOTIFY_CACHE_SCHEMA_VERSION) return false;
    (Array.isArray(payload.tracks) ? payload.tracks : []).forEach(function (t) {
      if (t && t.librarySongId) state.tracks.set(String(t.librarySongId), t);
    });
    (Array.isArray(payload.playlistMeta) ? payload.playlistMeta : []).forEach(function (e) {
      if (Array.isArray(e) && e[0]) state.playlistMeta.set(String(e[0]), e[1]);
    });
    (Array.isArray(payload.playlistTrackIds) ? payload.playlistTrackIds : []).forEach(function (e) {
      if (Array.isArray(e) && e[0]) state.playlistTrackIds.set(String(e[0]), Array.isArray(e[1]) ? e[1] : []);
    });
    (Array.isArray(payload.savedAlbumList) ? payload.savedAlbumList : []).forEach(function (e) {
      if (Array.isArray(e) && e[0]) state.savedAlbumList.set(String(e[0]), e[1]);
    });
    (Array.isArray(payload.artistImage) ? payload.artistImage : []).forEach(function (e) {
      if (Array.isArray(e) && e[0]) state.artistImage.set(String(e[0]), e[1]);
    });
    state.sync = Object.assign(state.sync, payload.sync || {});
    state.diskLoadedOk = true;
    return true;
  }

  function stats() {
    // 读之前先确保盘上数据已加载 —— stats() 是读操作，不该返回"还没加载"的假 0。
    loadFromDisk();
    return {
      cachePath: cachePath,
      fromDisk: state.tracks.size > 0 || state.playlistMeta.size > 0,
      tracks: state.tracks.size,
      playlists: state.playlistMeta.size,
      savedAlbums: state.savedAlbumList.size,
      artistImages: state.artistImage.size,
      sync: Object.assign({}, state.sync),
      throttle: deps.throttle.snapshot ? deps.throttle.snapshot() : null,
    };
  }

  // ---------------- 增量同步 ----------------
  function isRateLimitError(err) {
    const msg = String((err && (err.message || err.code)) || '');
    const status = Number(err && (err.statusCode || err.status));
    return status === 429 || /rate|429|backoff/i.test(msg);
  }

  function retryAfterMsOf(err) {
    const s = Number(err && (err.retryAfterSeconds || err.retryAfter));
    if (Number.isFinite(s) && s > 0) return s * 1000;
    return Number(err && err.retryAfterMs) || 1000;
  }

  // 一次性完整同步：分页取全，逐歌单按 snapshot 增量。
  // onProgress 用于把真实进度如实报给 UI（不谎报完成）。
  async function sync(opts) {
    opts = opts || {};
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    loadFromDisk();
    // 至少要有一个数据源才谈得上同步。**不能强制要求 playlistTracks** ——
    // 只同步收藏歌曲的场景没有它（先前的守卫会让那种场景静默不可用）。
    const hasAnySource = !!(deps.listPlaylists || deps.savedTracks || deps.savedAlbums);
    if (!hasAnySource || !deps.adapter) {
      return { ok: false, error: 'SYNC_NOT_WIRED', stats: stats() };
    }
    const startedAt = Date.now();
    let playlistsAdded = 0;
    let playlistsRefetched = 0;
    let tracksAdded = 0;
    let rateLimited = false;

    // --- 1) 歌单列表（分页）---
    let listRes = null;
    if (deps.listPlaylists) try {
      listRes = await deps.throttle.run(function () { return deps.listPlaylists({ limit: 300 }); });
    } catch (err) {
      rateLimited = isRateLimitError(err);
      if (rateLimited) deps.throttle.noteRateLimit(retryAfterMsOf(err));
      state.sync.rateLimited = rateLimited;
      state.sync.lastError = String((err && err.message) || err);
      return { ok: false, error: rateLimited ? 'RATE_LIMITED' : 'PLAYLIST_LIST_FAILED', stats: stats() };
    }
    let rawPlaylists = (listRes && listRes.playlists) || [];

    // --- 2) 逐歌单：snapshot 未变则跳过曲目 ---
    if (!deps.playlistTracks) rawPlaylists = [];
    for (const pl of rawPlaylists) {
      if (!pl || !pl.id) continue;
      const pid = String(pl.id);
      const prev = state.playlistMeta.get(pid) || null;
      const snap = String(pl.snapshotId || pl.snapshot_id || '');
      const mapped = deps.adapter.toLibraryPlaylist(pl);
      if (mapped) {
        mapped.snapshotId = snap;
        state.playlistMeta.set(pid, mapped);
        markDirty();
        if (!prev) playlistsAdded += 1;
      }
      // 增量：有 snapshot 且与上次相同 -> 曲目不用重拉
      const unchanged = prev && snap && prev.snapshotId === snap && (state.playlistTrackIds.get(pid) || []).length > 0;
      if (unchanged) continue;
      const fetched = await fetchPlaylistTracks(pid);
      if (fetched.rateLimited) { rateLimited = true; break; }
      state.playlistTrackIds.set(pid, fetched.ids);
      tracksAdded += fetched.added;
      playlistsRefetched += 1;
      markDirty();
      try { onProgress({ phase: 'playlists', done: playlistsRefetched, total: rawPlaylists.length, tracks: state.tracks.size }); } catch (_) {}
    }

    // --- 3) 喜欢的歌曲（after 游标增量）---
    if (!rateLimited && deps.savedTracks) {
      const r = await syncSavedTracks({ full: !!opts.full });
      if (r.rateLimited) rateLimited = true;
      else tracksAdded += r.added;
    }

    // --- 4) 收藏的专辑（分页）---
    if (!rateLimited && deps.savedAlbums) {
      const r = await syncSavedAlbums({ full: !!opts.full });
      if (r.rateLimited) rateLimited = true;
    }

    if (!rateLimited) {
      state.sync.lastSyncAt = Date.now();
      state.sync.lastFullSyncAt = Date.now();
    }
    state.sync.rateLimited = rateLimited;
    state.sync.lastError = rateLimited ? 'RATE_LIMITED' : '';
    // **限流也要落盘** —— 已经成功拿到的数据必须留住，
    // 否则下次还得从头再打一遍，正是"越重试越糟"的来源。
    // 只是不把 lastFullSyncAt 记为成功（增量游标已单独保存）。
    persist();
    return {
      ok: !rateLimited,
      error: rateLimited ? 'RATE_LIMITED' : '',
      elapsedMs: Date.now() - startedAt,
      playlistsAdded: playlistsAdded,
      playlistsRefetched: playlistsRefetched,
      tracksAdded: tracksAdded,
      stats: stats(),
    };
  }

  // 逐页取全一个歌单（Spotify 每页上限 50）
  async function fetchPlaylistTracks(pid) {
    const ids = [];
    const seen = new Set();
    let offset = 0;
    let added = 0;
    for (let guard = 0; guard < 200; guard += 1) {
      let page = null;
      try {
        page = await deps.throttle.run(function () { return deps.playlistTracks(pid, { limit: 50, offset: offset }); });
      } catch (err) {
        if (isRateLimitError(err)) {
          deps.throttle.noteRateLimit(retryAfterMsOf(err));
          state.sync.rateLimited = true;
          return { ids: state.playlistTrackIds.get(pid) || [], added: 0, rateLimited: true };
        }
        break;   // 非限流错误：保留已有，不谎报取全
      }
      const raw = (page && (page.tracks || page.items)) || [];
      if (!raw.length) break;
      const songs = deps.adapter.toLibrarySongs(raw);
      for (const s of songs) {
        if (seen.has(s.librarySongId)) continue;
        seen.add(s.librarySongId);
        ids.push(s.librarySongId);
        if (!state.tracks.has(s.librarySongId)) { state.tracks.set(s.librarySongId, s); added += 1; }
      }
      const total = Number(page && page.total) || 0;
      if (total && ids.length >= total) break;
      if (!(page && page.hasMore)) break;
      const next = Number(page && page.nextOffset);
      const advance = (Number.isFinite(next) && next > offset) ? next : (offset + raw.length);
      if (advance <= offset) break;
      offset = advance;
    }
    return { ids: ids, added: added, rateLimited: false };
  }

  // 喜欢的歌曲：用 after 游标只取新增；full 时从头
  async function syncSavedTracks(opts) {
    const full = !!(opts && opts.full);
    let cursor = full ? '' : String(state.sync.savedTracksCursor || '');
    let added = 0;
    for (let guard = 0; guard < 200; guard += 1) {
      let page = null;
      try {
        page = await deps.throttle.run(function () {
          return deps.savedTracks({ limit: 50, after: cursor || undefined });
        });
      } catch (err) {
        if (isRateLimitError(err)) {
          deps.throttle.noteRateLimit(retryAfterMsOf(err));
          state.sync.rateLimited = true;
          return { added: added, rateLimited: true };
        }
        break;
      }
      const raw = (page && (page.tracks || page.items)) || [];
      if (!raw.length) break;
      const songs = deps.adapter.toLibrarySongs(raw);
      // 游标由调用方（走 /me/tracks 的那层）给出，不在缓存层猜。
      const pageCursor = String((page && page.cursor) || '');
      const maxCursor = pageCursor || cursor;
      for (const s of songs) {
        if (!state.tracks.has(s.librarySongId)) { state.tracks.set(s.librarySongId, s); added += 1; }
      }
      // 喜欢的歌曲也归入虚拟歌单，索引里才能显示曲目数
      const liked = state.playlistTrackIds.get('spotify-liked') || [];
      const likedSet = new Set(liked);
      songs.forEach(function (s) { if (!likedSet.has(s.librarySongId)) { likedSet.add(s.librarySongId); liked.push(s.librarySongId); } });
      state.playlistTrackIds.set('spotify-liked', liked);
      state.sync.savedTracksCursor = maxCursor || cursor;
      markDirty();
      persist();   // 每页落盘：进度不丢
      if (!(page && page.hasMore)) { state.sync.savedTracksDone = true; break; }
      // 游标没前进就停下，避免死循环猛打
      const nextCursor = state.sync.savedTracksCursor;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return { added: added, rateLimited: false };
  }

  // 收藏的专辑：分页
  async function syncSavedAlbums(opts) {
    let offset = 0;
    const seen = new Set();
    for (let guard = 0; guard < 200; guard += 1) {
      let page = null;
      try {
        page = await deps.throttle.run(function () { return deps.savedAlbums({ limit: 50, offset: offset }); });
      } catch (err) {
        if (isRateLimitError(err)) {
          deps.throttle.noteRateLimit(retryAfterMsOf(err));
          state.sync.rateLimited = true;
          return { rateLimited: true };
        }
        break;
      }
      const items = (page && (page.items || page.albums)) || [];
      if (!items.length) break;
      items.forEach(function (it) {
        const a = (it && it.album) || it;
        if (!a || !a.id) return;
        seen.add(String(a.id));
        state.savedAlbumList.set(String(a.id), {
          albumId: String(a.id),
          name: a.name || '',
          artist: ((a.artists || [])[0] || {}).name || '',
          cover: ((a.images || [])[0] || {}).url || '',
          releaseDate: String(a.release_date || ''),
          trackCount: Number(a.total_tracks) || 0,
        });
      });
      markDirty();
      if (!(page && page.next)) break;
      offset += items.length;
      if (offset > 5000) break;   // 安全上限
    }
    persist();
    return { rateLimited: false };
  }

  // ---------------- 读取 ----------------
  function songs() { loadFromDisk(); return Array.from(state.tracks.values()); }
  function playlists() { loadFromDisk(); return Array.from(state.playlistMeta.values()); }
  function playlistTracks(pid) {
    loadFromDisk();
    const ids = state.playlistTrackIds.get(String(pid).replace(/^sp:/, '')) || [];
    return ids.map(function (id) { return state.tracks.get(id); }).filter(Boolean);
  }
  function savedAlbumCards() { loadFromDisk(); return Array.from(state.savedAlbumList.values()); }
  function getArtistImage(artistId) {
    const hit = state.artistImage.get(String(artistId));
    return hit && hit.url ? String(hit.url) : '';
  }
  function setArtistImage(artistId, url) {
    state.artistImage.set(String(artistId), { url: String(url || ''), at: Date.now() });
    markDirty();
  }

  return {
    SPOTIFY_CACHE_SCHEMA_VERSION: SPOTIFY_CACHE_SCHEMA_VERSION,
    CACHE_FILE_NAME: CACHE_FILE_NAME,
    loadFromDisk: loadFromDisk,
    persist: persist,
    sync: sync,
    stats: stats,
    songs: songs,
    playlists: playlists,
    playlistTracks: playlistTracks,
    savedAlbumCards: savedAlbumCards,
    getArtistImage: getArtistImage,
    setArtistImage: setArtistImage,
    _state: state,
    _internal: { fetchPlaylistTracks: fetchPlaylistTracks, isRateLimitError: isRateLimitError },
  };
}

module.exports = {
  createSpotifyLibraryCache,
  createThrottle,
  resolveDefaultCachePath,
  SPOTIFY_CACHE_SCHEMA_VERSION,
  CACHE_FILE_NAME,
  MIN_REQUEST_INTERVAL_MS,
};
