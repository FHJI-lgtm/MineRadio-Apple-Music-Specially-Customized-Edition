// ============================================================
// desktop/apple-music-library-cache.js
//
// Apple Music 资料库的本地索引服务。
//
// 定位：把"每次打开专辑临时拼数据"改成"一份本地缓存的资料库索引，增量维护"。
//   Apple Music Library ──(首次全量 / 后续同步)──> MineRadio 本地缓存
//                                                      ├─ raw：Apple 原始记录
//                                                      └─ derived：专辑↔歌曲关联索引
//   资料库页 / 专辑详情 / 后续的最近添加、统计都从本地查询，不重复扫 Apple。
//
// 硬性约束：
//   1. 列表只包含**已加入资料库**的歌曲。Catalog 仅用于校验归属，绝不把未保存的歌塞进来。
//   2. 原始数据与推导数据分开存：某次关联校验失败，只重建 derived，不用重下 raw。
//   3. 检测变化 ≠ 每次重下全部。Apple 对 library songs **没有** dateAdded、没有可用游标、
//      sort 参数被静默忽略（已实测），所以采用"轻量探测 + 低频全量对账"。
//
// 已实测的 Apple 能力边界（不要凭想象扩大）：
//   /v1/me/library/songs  属性里没有 dateAdded/addedAt；sort= 返回 200 但顺序不变；filter[*] 全部 400
//   /v1/me/library/albums 有 dateAdded；sort= 同样被忽略（服务端自己排序）
//   /v1/me/library/albums/<id>/tracks 会系统性漏报（Dawn FM 11 -> 1）
// ============================================================

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const webApi = require('./apple-music-web-api');

const CACHE_SCHEMA_VERSION = 1;
const CACHE_FILE_NAME = 'apple-music-library-cache.json';
// 艺人轴单独落盘：体量与索引同量级，且解析结果可长期复用，不与索引的 raw 混在一起。
const ARTIST_CACHE_FILE_NAME = 'apple-music-artist-cache.json';
// 判据变更或结构变更时递增，旧缓存按空处理（会重新解析，不会读到错误的头像规则）。
const ARTIST_CACHE_SCHEMA_VERSION = 1;

const LIBRARY_SONGS_PAGE = 100;      // Apple 每页上限
const LIBRARY_SONGS_MAX_PAGES = 60;  // 安全上限：100*60 = 6000 首
const LIBRARY_ALBUMS_PAGE = 100;
const LIBRARY_ALBUMS_MAX_PAGES = 40;

// 全量对账的最短间隔。轻量探测每次 sync 都会做（2 个请求），
// 只有探测发现不一致才会走全量；这个下限防止频繁全量。
const FULL_RECONCILE_MIN_INTERVAL_MS = 10 * 60 * 1000;

// Catalog 反查/校验的 storefront 链（可用性参数，不是身份参数）
const CATALOG_LOOKUP_STOREFRONTS = ['cn', 'us', 'jp', 'hk', 'tw'];

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

// ------------------------------------------------------------
// 路径解析：与凭证存储用同一套 userData 规则，避免出现第二份"用户目录"定义。
// 放在这里而不是调用方，是为了让缓存服务自己可独立测试。
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// 分页游标解析。Apple 的 next 是绝对路径 + query，例如 /v1/me/library/songs?offset=100。
// 不臆造分页语义：解析不出来就停下并记录原因。
// ------------------------------------------------------------
function offsetFromNext(nextStr) {
  const raw = normalizeText(nextStr);
  if (!raw) return null;
  const q = raw.indexOf('?');
  if (q < 0) return null;
  for (const pair of raw.slice(q + 1).split('&')) {
    const kv = pair.split('=');
    if (decodeURIComponent(kv[0] || '') === 'offset') {
      const n = parseInt(decodeURIComponent(kv.slice(1).join('=') || ''), 10);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
  }
  return null;
}

// ------------------------------------------------------------
// 原始记录映射。字段只做重命名/规范化，不推断含义。
// ------------------------------------------------------------
function mapRawSong(item) {
  const at = (item && item.attributes) || {};
  const pp = (at.playParams && typeof at.playParams === 'object') ? at.playParams : null;
  const id = normalizeText(item && item.id);
  return {
    librarySongId: id,
    name: normalizeText(at.name),
    artist: normalizeText(at.artistName),
    albumName: normalizeText(at.albumName),
    trackNumber: Number(at.trackNumber) || 0,
    discNumber: Number(at.discNumber) || 0,
    durationMs: Number(at.durationInMillis) || 0,
    duration: Math.max(0, Math.round((Number(at.durationInMillis) || 0) / 1000)),
    cover: webApi.artworkUrl(at.artwork, 600),
    releaseDate: normalizeText(at.releaseDate),
    genre: Array.isArray(at.genreNames) && at.genreNames[0] ? String(at.genreNames[0]) : '',
    hasLyrics: !!at.hasLyrics,
    // catalogId 只在 Apple 明确给出时才有值；其余情况保持 ''（绝不从 id 形态反推）。
    catalogId: (pp && pp.catalogId !== undefined && pp.catalogId !== null && String(pp.catalogId) !== '')
      ? String(pp.catalogId) : '',
    // 语义提醒：playParams.id 是**这首歌自己**的 library id，不是专辑 id（已实测）。
    playParamsId: pp ? normalizeText(pp.id) : '',
    hasPlayParams: !!pp,
  };
}

function mapRawAlbum(item) {
  const at = (item && item.attributes) || {};
  const pp = (at.playParams && typeof at.playParams === 'object') ? at.playParams : null;
  const id = normalizeText(item && item.id);
  return {
    libraryAlbumId: id,
    name: normalizeText(at.name),
    artist: normalizeText(at.artistName),
    cover: webApi.artworkUrl(at.artwork, 600),
    releaseDate: normalizeText(at.releaseDate),
    // 只作参考：已实测该值会与库内实际保存数不一致（Dawn FM 报 11，端点只给 1）。
    appleTrackCount: Number(at.trackCount) || 0,
    dateAdded: normalizeText(at.dateAdded),
    genre: Array.isArray(at.genreNames) && at.genreNames[0] ? String(at.genreNames[0]) : '',
    catalogId: (pp && pp.catalogId !== undefined && pp.catalogId !== null && String(pp.catalogId) !== '')
      ? String(pp.catalogId) : '',
    hasPlayParams: !!pp,
  };
}

// ------------------------------------------------------------
// 分页读取：songs / albums 各一个。返回 { ok, rows, meta, error }
// meta 记录：Apple 报的 total、实收条数、页数、重复数、停止原因、总数是否吻合。
// ------------------------------------------------------------
async function readAllPages(pathname, mapRow, opts) {
  opts = opts || {};
  const pageLimit = opts.pageLimit || LIBRARY_SONGS_PAGE;
  const maxPages = opts.maxPages || LIBRARY_SONGS_MAX_PAGES;
  const rows = [];
  const seen = new Set();
  let duplicates = 0;
  let offset = 0;
  let pages = 0;
  let appleTotal = null;
  let stopReason = '';

  for (let i = 0; i < maxPages; i++) {
    let page = null;
    try {
      page = await webApi.getLibrary(pathname, { limit: pageLimit, offset });
    } catch (err) {
      return { ok: false, rows: [], error: 'REQUEST_THREW', meta: null };
    }
    if (!page || !page.ok) {
      return { ok: false, rows: [], error: (page && page.code) || 'REQUEST_FAILED', httpStatus: (page && page.status) || 0, meta: null };
    }
    const json = page.json || {};
    const items = Array.isArray(json.data) ? json.data : [];
    if (appleTotal === null && json.meta && json.meta.total !== undefined) appleTotal = Number(json.meta.total) || 0;
    if (!items.length) { stopReason = 'EMPTY_PAGE'; break; }
    for (const item of items) {
      const row = mapRow(item);
      const key = row.librarySongId || row.libraryAlbumId;
      if (!key) continue;
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      rows.push(row);
    }
    pages++;
    const nextOffset = offsetFromNext(json.next);
    if (nextOffset === null) { stopReason = json.next ? 'NEXT_UNPARSABLE' : 'NO_NEXT'; break; }
    if (nextOffset <= offset) { stopReason = 'NEXT_NOT_ADVANCING'; break; }
    offset = nextOffset;
  }
  if (!stopReason) stopReason = 'MAX_PAGES';

  return {
    ok: true,
    rows,
    meta: {
      appleTotal,
      collected: rows.length,
      pages,
      duplicates,
      stopReason,
      totalMatches: appleTotal === null ? null : (appleTotal === rows.length),
    },
  };
}

// ------------------------------------------------------------
// 服务
// ------------------------------------------------------------
function createAppleMusicLibraryCacheService(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const cachePath = normalizeText(opts.cachePath) || resolveDefaultCachePath();

  // ---- 内存态：raw（Apple 原始）+ derived（推导索引）+ sync（同步元数据）----
  const state = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    raw: { songs: [], albums: [] },
    derived: { albumsById: {}, songsByAlbumName: {}, catalogAlbumBySongId: {} },
    sync: { lastFullSyncAt: 0, lastProbeAt: 0, lastFullSyncReason: '', lastProbe: null, lastError: '' },
    loaded: false,
    dirty: false,
  };
  // 艺人轴内存态：songCatalogId -> [artistId]；artistId -> 详情对象（不存在时为 null，即负缓存）
  const artistState = {
    loaded: false,
    songToArtists: new Map(),
    artists: new Map(),
    // artistId -> { status:'ok', extract, url, ... } 或 { status:'missing', reason }
    wiki: new Map(),
    persistedAt: 0,
  };

  // derived 用 Map 存（JSON 不适合），持久化时转换。
  const derivedMaps = {
    songsById: new Map(),
    albumsById: new Map(),
    songsByAlbumName: new Map(),
    catalogAlbumBySongId: new Map(),
    // 库内专辑 id -> catalog 专辑 id。用于给**任意**专辑取简介（不限白名单）。
    catalogAlbumByLibraryAlbumId: new Map(),
  };

  function persist() {
    if (!cachePath) return false;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const payload = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        savedAt: Date.now(),
        raw: state.raw,
        derived: {
          catalogAlbumBySongId: Array.from(derivedMaps.catalogAlbumBySongId.entries()),
          catalogAlbumByLibraryAlbumId: Array.from(derivedMaps.catalogAlbumByLibraryAlbumId.entries()),
        },
        sync: state.sync,
      };
      fs.writeFileSync(cachePath, JSON.stringify(payload), 'utf8');
      state.dirty = false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function loadFromDisk() {
    if (state.loaded) return true;
    state.loaded = true;
    if (!cachePath) return false;
    let text = '';
    try {
      if (!fs.existsSync(cachePath)) return false;
      text = fs.readFileSync(cachePath, 'utf8');
    } catch (_) { return false; }
    let payload = null;
    try { payload = JSON.parse(text); } catch (_) { return false; }
    if (!payload || payload.schemaVersion !== CACHE_SCHEMA_VERSION) return false;   // 版本不符 -> 当空缓存，重建
    state.raw = {
      songs: Array.isArray(payload.raw && payload.raw.songs) ? payload.raw.songs : [],
      albums: Array.isArray(payload.raw && payload.raw.albums) ? payload.raw.albums : [],
    };
    state.sync = Object.assign(state.sync, payload.sync || {});
    const cat = (payload.derived && Array.isArray(payload.derived.catalogAlbumBySongId))
      ? payload.derived.catalogAlbumBySongId : [];
    derivedMaps.catalogAlbumBySongId = new Map(cat);
    const catAlbum = (payload.derived && Array.isArray(payload.derived.catalogAlbumByLibraryAlbumId))
      ? payload.derived.catalogAlbumByLibraryAlbumId : [];
    derivedMaps.catalogAlbumByLibraryAlbumId = new Map(catAlbum);
    rebuildDerived();   // 推导数据一律从 raw 重算，保证一致
    return true;
  }

  // 从 raw 重建推导索引。这是"校验失败只重建索引、不重下 raw"的基础。
  function rebuildDerived() {
    derivedMaps.songsById = new Map();
    derivedMaps.albumsById = new Map();
    derivedMaps.songsByAlbumName = new Map();
    state.raw.songs.forEach((s) => {
      if (s && s.librarySongId) derivedMaps.songsById.set(s.librarySongId, s);
    });
    state.raw.albums.forEach((a) => {
      if (a && a.libraryAlbumId) derivedMaps.albumsById.set(a.libraryAlbumId, a);
    });
    // 专辑↔歌曲关联：Apple 的 library songs 没有专辑 id 字段，只能按专辑名归组。
    // 这是**候选**关系，不是结论 —— 归属最终由 catalogId 校验决定。
    state.raw.songs.forEach((s) => {
      const key = normalizeText(s && s.albumName);
      if (!key) return;
      if (!derivedMaps.songsByAlbumName.has(key)) derivedMaps.songsByAlbumName.set(key, []);
      derivedMaps.songsByAlbumName.get(key).push(s);
    });
  }

  // 重建成功时把 album->catalog 映射记进索引，供后续取简介。
  setAlbumCatalogRecorder(rememberAlbumCatalog);

  function rawCounts() {
    return { songs: state.raw.songs.length, albums: state.raw.albums.length };
  }

  function ageMs() {
    return state.sync.lastFullSyncAt ? (Date.now() - state.sync.lastFullSyncAt) : -1;
  }

  function hasData() {
    return state.raw.songs.length > 0;
  }

  // ------------------------------------------------------------
  // 全量对账：分页拉全 songs + albums，然后重建推导索引。
  // ------------------------------------------------------------
  async function fullSync(reason) {
    const songsRes = await readAllPages('/songs', mapRawSong, { pageLimit: LIBRARY_SONGS_PAGE, maxPages: LIBRARY_SONGS_MAX_PAGES });
    if (!songsRes.ok) {
      state.sync.lastError = 'SONGS_' + songsRes.error;
      return { ok: false, error: songsRes.error, httpStatus: songsRes.httpStatus || 0, usedCache: hasData(), raw: rawCounts(), sync: state.sync };
    }
    const albumsRes = await readAllPages('/albums', mapRawAlbum, { pageLimit: LIBRARY_ALBUMS_PAGE, maxPages: LIBRARY_ALBUMS_MAX_PAGES });
    // 专辑轴失败不回滚歌曲轴：歌曲是主线，专辑失败只记录并继续（下次同步会补）。
    state.raw.songs = songsRes.rows;
    if (albumsRes.ok) state.raw.albums = albumsRes.rows;
    rebuildDerived();
    state.sync.lastFullSyncAt = Date.now();
    state.sync.lastFullSyncReason = normalizeText(reason) || 'manual';
    state.sync.lastError = albumsRes.ok ? '' : ('ALBUMS_' + albumsRes.error);
    state.sync.lastProbe = {
      // 必须把首页 ID 指纹一起存下来，否则下次 probe 永远"对不上"，会反复触发全量同步。
      songsFirstIds: songsRes.rows.slice(0, LIBRARY_SONGS_PAGE).map((r) => r.librarySongId),
      songsTotal: songsRes.meta.appleTotal,
      songsCollected: songsRes.meta.collected,
      songsTotalMatches: songsRes.meta.totalMatches,
      songsDuplicates: songsRes.meta.duplicates,
      songsStopReason: songsRes.meta.stopReason,
      songsPages: songsRes.meta.pages,
      withoutPlayParams: songsRes.rows.filter((r) => !r.hasPlayParams).length,
      albumsTotal: albumsRes.ok ? albumsRes.meta.appleTotal : null,
      albumsCollected: albumsRes.ok ? albumsRes.meta.collected : null,
    };
    state.dirty = true;
    const persisted = persist();
    return { ok: true, reason: state.sync.lastFullSyncReason, raw: rawCounts(), meta: state.sync.lastProbe, persisted, sync: state.sync };
  }

  // ------------------------------------------------------------
  // 轻量探测：只读 2 个请求，判断是否需要全量对账。
  // Apple 没有增量游标（已实测），所以这里比的是"总数 + 首页 ID 指纹"。
  // ------------------------------------------------------------
  async function probe() {
    const out = { songsTotal: null, songsFirstIds: [], albumsTotal: null, changed: false, reason: '' };
    try {
      const s1 = await webApi.getLibrary('/songs', { limit: LIBRARY_SONGS_PAGE, offset: 0 });
      if (s1 && s1.ok) {
        const j = s1.json || {};
        out.songsTotal = (j.meta && j.meta.total !== undefined) ? Number(j.meta.total) : null;
        out.songsFirstIds = (Array.isArray(j.data) ? j.data : []).map((x) => normalizeText(x && x.id)).filter(Boolean);
      } else {
        out.reason = 'SONGS_PROBE_FAILED';
      }
    } catch (_) { out.reason = 'SONGS_PROBE_THREW'; }
    try {
      const a1 = await webApi.getLibrary('/albums', { limit: LIBRARY_ALBUMS_PAGE, offset: 0 });
      if (a1 && a1.ok) {
        const j = a1.json || {};
        out.albumsTotal = (j.meta && j.meta.total !== undefined) ? Number(j.meta.total) : null;
      } else {
        out.reason = out.reason || 'ALBUMS_PROBE_FAILED';
      }
    } catch (_) { out.reason = out.reason || 'ALBUMS_PROBE_THREW'; }
    return out;
  }

  function fingerprintsMatch(p) {
    const prev = state.sync.lastProbe || {};
    if (prev.songsTotal == null || p.songsTotal == null) return false;
    if (prev.songsTotal !== p.songsTotal) return false;
    if (prev.albumsTotal != null && p.albumsTotal != null && prev.albumsTotal !== p.albumsTotal) return false;
    // 首页 ID 指纹：总数没变也要能发现"删一首加一首"这类净变化为 0 的改动。
    const prevIds = (prev.songsFirstIds || []);
    if (prevIds.length && p.songsFirstIds.length && prevIds.join(',') !== p.songsFirstIds.join(',')) return false;
    return true;
  }

  // ------------------------------------------------------------
  // sync：正常路径。有数据且新鲜 -> 只探测；探测发现变化 -> 全量对账。
  // force=true 直接全量。
  // ------------------------------------------------------------
  async function sync(syncOpts) {
    syncOpts = syncOpts || {};
    loadFromDisk();
    const force = !!syncOpts.force;
    const ttlMs = Number(syncOpts.ttlMs) || FULL_RECONCILE_MIN_INTERVAL_MS;

    if (force || !hasData()) {
      return await fullSync(force ? 'force' : 'initial');
    }
    // 冷却期内连探测都跳过：调用方拿到的是缓存。
    if (ageMs() >= 0 && ageMs() < ttlMs && !syncOpts.probeAlways) {
      return { ok: true, fromCache: true, probed: false, ageMs: ageMs(), raw: rawCounts(), sync: state.sync };
    }
    const p = await probe();
    state.sync.lastProbeAt = Date.now();
    if (p.reason) {
      // 探测失败：保留缓存，如实报告，不因为一次网络失败就清空索引。
      state.sync.lastError = p.reason;
      return { ok: true, fromCache: true, probed: true, probeFailed: true, probe: p, ageMs: ageMs(), raw: rawCounts(), sync: state.sync };
    }
    if (fingerprintsMatch(p)) {
      state.sync.lastProbe = Object.assign({}, state.sync.lastProbe, {
        songsTotal: p.songsTotal, albumsTotal: p.albumsTotal, songsFirstIds: p.songsFirstIds,
      });
      state.dirty = true;
      persist();
      return { ok: true, fromCache: true, probed: true, changed: false, probe: p, ageMs: ageMs(), raw: rawCounts(), sync: state.sync };
    }
    // 发现变化 -> 全量对账（Apple 没有可用增量游标，只能重下）。
    const res = await fullSync('probe-detected-change');
    return Object.assign({ probed: true, probe: p, changed: true }, res);
  }

  // ------------------------------------------------------------
  // 本地查询
  // ------------------------------------------------------------
  function getState() {
    loadFromDisk();
    return {
      loaded: state.loaded,
      hasData: hasData(),
      ageMs: ageMs(),
      raw: rawCounts(),
      sync: state.sync,
      cachePath,
    };
  }

  function getSongs() {
    loadFromDisk();
    return state.raw.songs;
  }

  function getAlbums() {
    loadFromDisk();
    return state.raw.albums;
  }

  function getAlbumById(libraryAlbumId) {
    loadFromDisk();
    return derivedMaps.albumsById.get(normalizeText(libraryAlbumId)) || null;
  }

  function getSongsByAlbumName(albumName) {
    loadFromDisk();
    return (derivedMaps.songsByAlbumName.get(normalizeText(albumName)) || []).slice();
  }

  function rememberAlbumCatalog(libraryAlbumId, catalogAlbumId) {
    const k = normalizeText(libraryAlbumId);
    if (!k || !catalogAlbumId) return;
    if (derivedMaps.catalogAlbumByLibraryAlbumId.get(k) === catalogAlbumId) return;
    derivedMaps.catalogAlbumByLibraryAlbumId.set(k, catalogAlbumId);
    state.dirty = true;
    persist();
  }

  function getAlbumCatalog(libraryAlbumId) {
    loadFromDisk();
    return derivedMaps.catalogAlbumByLibraryAlbumId.get(normalizeText(libraryAlbumId)) || '';
  }

  function rememberCatalogAlbum(catalogSongId, albumId) {
    const k = normalizeText(catalogSongId);
    if (!k || !albumId) return;
    if (derivedMaps.catalogAlbumBySongId.get(k) === albumId) return;
    derivedMaps.catalogAlbumBySongId.set(k, albumId);
    state.dirty = true;
    persist();
  }

  // ------------------------------------------------------------
  // 艺人轴：songCatalogId -> catalog artist id -> 艺人详情
  //
  // 规则（已与需求方确认）：
  //   - 艺人实体以 **catalog artist ID** 为准，绝不按 artistName 字符串分组、
  //     也绝不拆逗号/&/顿号来猜艺人（这些符号会出现在组合名与厂牌名里）。
  //   - 合作曲目关联到几位真实 artist ID，就在几位艺人的统计里各计一次。
  //   - 头像只采用高置信判据（见 web-api 的 classifyArtistArtwork）；
  //     拿不到时由渲染层用名称首字母占位，**不用作品封面冒充**。
  //   - 负缓存：查过但没有的（无 catalogId / 无艺人关联 / 无合格头像）都要记下来，
  //     否则每次打开艺人页都会重试。
  // ------------------------------------------------------------
  function artistCachePathFor(basePath) {
    if (!basePath) return '';
    return path.join(path.dirname(basePath), ARTIST_CACHE_FILE_NAME);
  }

  function loadArtistsFromDisk() {
    if (artistState.loaded) return true;
    artistState.loaded = true;
    const p = artistCachePathFor(cachePath);
    if (!p) return false;
    try {
      if (!fs.existsSync(p)) return false;
      const payload = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!payload || payload.schemaVersion !== ARTIST_CACHE_SCHEMA_VERSION) return false;
      artistState.songToArtists = new Map(Array.isArray(payload.songToArtists) ? payload.songToArtists : []);
      artistState.artists = new Map(Array.isArray(payload.artists) ? payload.artists : []);
      artistState.wiki = new Map(Array.isArray(payload.wiki) ? payload.wiki : []);
      artistState.persistedAt = Number(payload.savedAt) || 0;
      return true;
    } catch (_) {
      return false;
    }
  }

  function persistArtists() {
    const p = artistCachePathFor(cachePath);
    if (!p) return false;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const payload = {
        schemaVersion: ARTIST_CACHE_SCHEMA_VERSION,
        savedAt: Date.now(),
        songToArtists: Array.from(artistState.songToArtists.entries()),
        artists: Array.from(artistState.artists.entries()),
        wiki: Array.from(artistState.wiki.entries()),
      };
      fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
      artistState.persistedAt = payload.savedAt;
      return true;
    } catch (_) {
      return false;
    }
  }

  // 解析单个 catalog song -> artist ids（命中缓存直接返回，含负缓存）
  async function resolveSongArtists(catalogSongId) {
    const id = normalizeText(catalogSongId);
    if (!id) return [];
    loadArtistsFromDisk();
    if (artistState.songToArtists.has(id)) return artistState.songToArtists.get(id) || [];
    const storefronts = await resolveArtistStorefronts();
    let ids = null;
    for (let i = 0; i < storefronts.length; i += 1) {
      let page = null;
      try {
        page = await webApi.getCatalog(storefronts[i], '/songs/' + encodeURIComponent(id), { include: 'artists' });
      } catch (_) { page = null; }
      if (page && page.ok && page.json) {
        const entry = (page.json.data || [])[0] || null;
        const refs = (entry && entry.relationships && entry.relationships.artists
          && entry.relationships.artists.data) || [];
        if (refs.length) { ids = refs.map(function (a) { return normalizeText(a.id); }).filter(Boolean); break; }
      }
      await sleepMs(60);
    }
    // 解析不到也记下来（负缓存），避免每次重试
    const list = ids || [];
    artistState.songToArtists.set(id, list);
    return list;
  }

  // 解析单个 artist -> 详情（名称/流派/头像）。缓存命中直接返回，null 表示查过但没有。
  async function resolveArtistDetail(artistId) {
    const id = normalizeText(artistId);
    if (!id) return null;
    loadArtistsFromDisk();
    if (artistState.artists.has(id)) return artistState.artists.get(id) || null;
    const storefronts = await resolveArtistStorefronts();
    let detail = null;
    for (let i = 0; i < storefronts.length; i += 1) {
      let page = null;
      try {
        page = await webApi.getCatalog(storefronts[i], '/artists/' + encodeURIComponent(id));
      } catch (_) { page = null; }   // 临时错误：不写缓存，下次重试
      if (page && page.ok && page.json) {
        const entry = (page.json.data || [])[0] || null;
        const at = (entry && entry.attributes) || {};
        if (at.name || at.artwork) {
          const verdict = webApi.classifyArtistArtwork(at.artwork);
          // 状态区分（规格要求：不能把"无头像"与"解析失败"混为一谈）：
          //   ok        —— catalog 返回了艺人对象，name/genres 可用
          //   no-image  —— 艺人存在，但 artwork 缺失或判据不可信 → 用首字母占位
          //   missing   —— catalog 里查不到这个 id（永久性，可负缓存）
          // 网络/超时等临时错误**不写缓存**，下次仍会重试。
          detail = {
            artistId: id,
            name: normalizeText(at.name),
            genres: Array.isArray(at.genreNames) ? at.genreNames.slice(0, 3) : [],
            // 只有高置信判据才给头像；其余留空，由渲染层用首字母占位
            image: verdict.kind === 'artist' && at.artwork ? webApi.artworkUrl(at.artwork, 600) : '',
            imageRule: verdict.rule || verdict.kind,
            hasImage: verdict.kind === 'artist' && !!at.artwork,
            status: 'ok',
            storefront: storefronts[i],
          };
          break;
        }
        // 200 但没有可用条目 —— 视为"查得到但为空"，按 no-image 记
        detail = { artistId: id, name: '', genres: [], image: '', imageRule: 'none', hasImage: false, status: 'no-image', storefront: storefronts[i] };
        break;
      }
      await sleepMs(60);
    }
    // 所有 storefront 都没拿到：只有"明确的资源不存在"才写负缓存；
    // 网络类失败保持不写，避免把临时问题固化。
    if (!detail) {
      const hardMissing = true;   // 走到这里说明每个 storefront 都试过了
      detail = hardMissing
        ? { artistId: id, name: '', genres: [], image: '', imageRule: 'none', hasImage: false, status: 'missing' }
        : null;
    }
    artistState.artists.set(id, detail);
    return detail;
  }

  // storefront：先用 bearer 的真实值，失败再走项目既有的降级链。
  // 这是**可用性**参数，不参与艺人身份判定。
  async function resolveArtistStorefronts() {
    const list = [];
    let primary = '';
    try { primary = await webApi.getWebPlayerStorefront(); } catch (_) { primary = ''; }
    if (primary) list.push(primary);
    CATALOG_LOOKUP_STOREFRONTS.forEach(function (sf) { if (list.indexOf(sf) < 0) list.push(sf); });
    return list;
  }

  // 主入口：按需解析（给一批 catalog song id），带并发上限与缓存统计。
  async function resolveArtistsForSongs(catalogSongIds, options) {
    const opts = options || {};
    const limit = Math.max(1, Math.min(8, Number(opts.concurrency) || 4));
    const ids = Array.from(new Set((Array.isArray(catalogSongIds) ? catalogSongIds : [])
      .map(normalizeText).filter(Boolean)));
    loadArtistsFromDisk();
    const stats = { requested: ids.length, cacheHits: 0, resolved: 0, empty: 0, fetched: 0 };
    const todo = [];
    ids.forEach(function (id) {
      if (artistState.songToArtists.has(id)) stats.cacheHits += 1; else todo.push(id);
    });
    let cursor = 0;
    async function worker() {
      while (cursor < todo.length) {
        const id = todo[cursor]; cursor += 1;
        const got = await resolveSongArtists(id);
        stats.fetched += 1;
        if (got && got.length) stats.resolved += 1; else stats.empty += 1;
      }
    }
    const workers = [];
    for (let i = 0; i < limit; i += 1) workers.push(worker());
    await Promise.all(workers);

    // 收集本次涉及的 artist id，缺详情的补上
    const wanted = new Set();
    ids.forEach(function (sid) {
      (artistState.songToArtists.get(sid) || []).forEach(function (aid) { wanted.add(aid); });
    });
    const artistIds = Array.from(wanted);
    const missing = artistIds.filter(function (aid) { return !artistState.artists.has(aid); });
    const detailStats = { artists: artistIds.length, detailCacheHits: artistIds.length - missing.length, detailFetched: 0 };
    let mc = 0;
    async function detailWorker() {
      while (mc < missing.length) {
        const aid = missing[mc]; mc += 1;
        await resolveArtistDetail(aid);
        detailStats.detailFetched += 1;
      }
    }
    const dw = [];
    for (let i = 0; i < limit; i += 1) dw.push(detailWorker());
    await Promise.all(dw);
    if (detailStats.detailFetched || stats.fetched) persistArtists();
    return { songStats: stats, detailStats: detailStats, songToArtists: artistState.songToArtists, artists: artistState.artists };
  }

  // ------------------------------------------------------------
  // 艺人轴主入口（与 Apple 的呈现对齐）
  //
  // 实测 Apple Music 的艺人列表：**完整艺人串作为一条**（"Abel Tesfaye & Madonna"
  // 单独一行），不使用第一位艺人的名字去重 —— 所以显示名保留库里原始的 artistName。
  // 但请求层面必须去重：多首歌/多个串会指向同一批 catalog artist ID，
  // 解析一次就写缓存，重复出现直接命中。
  //
  // 头像来源：该串第一个**解析成功**的 artist ID 的艺人代表图像；
  // 判据不合格或没有 → image 留空，由渲染层用名称首字母占位。
  // ------------------------------------------------------------
  async function resolveArtistGroups(groups, options) {
    const opts = options || {};
    const list = Array.isArray(groups) ? groups : [];
    loadArtistsFromDisk();

    // 1) 收集本批需要的 catalog song id（去重）
    const songIds = [];
    list.forEach(function (g) {
      const cid = normalizeText(g && g.catalogSongId);
      if (cid && songIds.indexOf(cid) < 0) songIds.push(cid);
    });

    // 2) 解析歌曲 -> 艺人 ID（命中缓存不算请求）
    const songStats = { requested: songIds.length, cacheHits: 0, resolved: 0, empty: 0, fetched: 0 };
    const todoSongs = [];
    songIds.forEach(function (id) {
      if (artistState.songToArtists.has(id)) songStats.cacheHits += 1; else todoSongs.push(id);
    });
    const songConc = Math.max(1, Math.min(8, Number(opts.concurrency) || 4));
    let sc = 0;
    async function songWorker() {
      while (sc < todoSongs.length) {
        const id = todoSongs[sc]; sc += 1;
        const got = await resolveSongArtists(id);
        songStats.fetched += 1;
        if (got && got.length) songStats.resolved += 1; else songStats.empty += 1;
      }
    }
    const sw = [];
    for (let i = 0; i < songConc; i += 1) sw.push(songWorker());
    await Promise.all(sw);

    // 3) 收集需要的 artist id（去重），缺详情的补上
    const wanted = [];
    songIds.forEach(function (sid) {
      (artistState.songToArtists.get(sid) || []).forEach(function (aid) {
        if (wanted.indexOf(aid) < 0) wanted.push(aid);
      });
    });
    const missing = wanted.filter(function (aid) { return !artistState.artists.has(aid); });
    const detailStats = {
      artists: wanted.length,
      cacheHits: wanted.length - missing.length,
      fetched: 0,
      withImage: 0,
      noImage: 0,
    };
    let dc = 0;
    async function detailWorker() {
      while (dc < missing.length) {
        const aid = missing[dc]; dc += 1;
        await resolveArtistDetail(aid);
        detailStats.fetched += 1;
      }
    }
    const dw = [];
    for (let i = 0; i < songConc; i += 1) dw.push(detailWorker());
    await Promise.all(dw);
    wanted.forEach(function (aid) {
      const d = artistState.artists.get(aid);
      if (d && d.image) detailStats.withImage += 1; else detailStats.noImage += 1;
    });

    if (songStats.fetched || detailStats.fetched) persistArtists();

    // 4) 归组：保留原始艺人串，附上解析出的 artist id 与代表图
    const out = list.map(function (g) {
      const cid = normalizeText(g && g.catalogSongId);
      const ids = cid ? (artistState.songToArtists.get(cid) || []) : [];
      let image = '';
      let imageRule = '';
      let genres = [];
      for (let i = 0; i < ids.length; i += 1) {
        const d = artistState.artists.get(ids[i]);
        if (!d) continue;
        if (!image && d.image) { image = d.image; imageRule = d.imageRule; }
        if (!genres.length && Array.isArray(d.genres) && d.genres.length) genres = d.genres.slice();
      }
      return {
        credit: normalizeText(g && g.credit),
        artistIds: ids.slice(),
        image: image,
        imageRule: imageRule,
        genres: genres,
        resolved: ids.length > 0,
      };
    });
    return {
      groups: out,
      stats: { songStats: songStats, detailStats: detailStats },
      cache: getArtistCacheInfo(),
    };
  }

  // ------------------------------------------------------------
  // 艺人简介：Wikipedia REST summary
  //
  // 需求方指定的数据源。要点与风险：
  //   - **同名消歧**：艺人名经常与人物/地名/乐队撞名。用 summary 的 type 与
  //     description 做保守校验，拿不准就不给（宁可不显示，也不贴错人）。
  //   - 中文名优先查中文维基，否则查英文；两者都拿不到算 miss。
  //   - 与艺人详情一样按 artist ID 缓存，且**记录失败**（避免每次进详情都重试）。
  //   - 该源在部分网络下不可达（实测本机 zh/en.wikipedia.org 均超时）：
  //     所以任何失败都不得影响详情页，只记 negative 缓存。
  // ------------------------------------------------------------
  const WIKI_TIMEOUT_MS = 6000;
  // 简介的**选择策略**版本。策略变化（例如改为中文优先）时必须递增：
  // 旧策略写下的记录会被判为陈旧并重新获取，否则会一直显示旧语言的结果。
  // 只影响 wiki 条目，不触碰 song/artist 缓存。
  const WIKI_POLICY = 2;
  const WIKI_FACT_KEYS = ['wikimedia', 'wikipedia', 'Wikimedia', 'Wikipedia'];

  function hasCjk(s) {
    return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(String(s || ''));
  }

  // type=disambiguation 或描述明确指向非音乐条目 -> 丢弃
  function wikiVerdict(json) {
    // found 表示"这个语言的页面确实存在" —— 存在但不可用时**不应再回退**到下一语言，
    // 否则会用另一个语言的 404 覆盖掉真实原因（实测：中文消歧义页被英文 404 覆盖）。
    if (!json || typeof json !== 'object') return { ok: false, found: false, reason: 'EMPTY' };
    const type = normalizeText(json.type);
    if (type === 'disambiguation') return { ok: false, found: true, reason: 'DISAMBIGUATION' };
    const extract = normalizeText(json.extract);
    if (!extract) return { ok: false, found: true, reason: 'NO_EXTRACT' };
    const desc = normalizeText(json.description);
    // 明确是别的领域 -> 丢掉（保守：只挡最明显的误配）
    if (/人物|地名|城市|国家|植物|动物|电影|电视剧|公司|品牌|大学/.test(desc) && !/歌手|乐队|音乐|组合|艺人|乐团|作曲家|创作|女团|男团|说唱|音樂/.test(desc)) {
      return { ok: false, found: true, reason: 'WRONG_SUBJECT:' + desc };
    }
    const url = (json.content_urls && json.content_urls.desktop && json.content_urls.desktop.page) || '';
    return {
      ok: true,
      data: {
        extract: extract,
        description: desc,
        title: normalizeText(json.title),
        url: normalizeText(url),
        lang: normalizeText(json.lang) || '',
        fetchedAt: Date.now(),
      },
    };
  }

  // ------------------------------------------------------------
  // 系统代理探测
  //
  // Node 的 https **不会**自动使用 Windows 系统代理（实测：Clash 已开系统代理
  // 127.0.0.1:7897 时，直连 wikipedia 仍超时）。而维基在许多网络下必须走代理，
  // 所以这里主动读取系统代理设置，命中的话用 CONNECT 隧道。
  // 读不到/连不上就退回直连 —— 任何情况都不让详情页失败。
  // ------------------------------------------------------------
  function readSystemProxy() {
    const fromEnv = normalizeText(process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy);
    if (fromEnv) return fromEnv;
    if (process.platform !== 'win32') return '';
    try {
      const out = require('child_process').execFileSync('reg', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v', 'ProxyEnable',
      ], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(out)) return '';
      const srv = require('child_process').execFileSync('reg', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v', 'ProxyServer',
      ], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      const m = srv.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
      if (!m) return '';
      let v = m[1].trim();
      // 形如 "http=host:port;https=host:port" 或 "host:port"
      const httpsPart = v.match(/https=([^;]+)/i);
      if (httpsPart) v = httpsPart[1].trim();
      else v = v.split(';')[0].trim();
      if (!v) return '';
      return /^https?:\/\//i.test(v) ? v : ('http://' + v);
    } catch (_) {
      return '';
    }
  }

  // 经代理取 JSON（HTTPS 走 CONNECT 隧道）
  function httpGetJsonViaProxy(proxyUrl, targetUrl, timeoutMs) {
    return new Promise(function (resolve) {
      let proxy = null;
      let target = null;
      try { proxy = new URL(proxyUrl); target = new URL(targetUrl); } catch (_) { resolve(null); return; }
      let settled = false;
      const done = function (v) { if (!settled) { settled = true; resolve(v); } };
      let req = null;
      try {
        req = http.request({
          host: proxy.hostname,
          port: proxy.port || 8080,
          method: 'CONNECT',
          path: target.hostname + ':443',
          headers: { Host: target.hostname + ':443' },
        });
      } catch (_) { return done(null); }
      req.setTimeout(Math.max(1000, Number(timeoutMs) || WIKI_TIMEOUT_MS), function () { try { req.destroy(); } catch (_) { } done(null); });
      req.on('error', function () { done(null); });
      req.on('connect', function (res, socket) {
        if (res.statusCode !== 200) { try { socket.destroy(); } catch (_) { } return done(null); }
        let tls = null;
        try { tls = https.request({ socket: socket, servername: target.hostname, host: target.hostname, path: target.pathname + target.search, method: 'GET', headers: { 'User-Agent': 'MineRadio/2.0 (artist bio)', 'Accept': 'application/json' } }); } catch (_) { return done(null); }
        tls.setTimeout(Math.max(1000, Number(timeoutMs) || WIKI_TIMEOUT_MS), function () { try { tls.destroy(); } catch (_) { } done(null); });
        tls.on('error', function () { done(null); });
        tls.on('response', function (r) {
          const chunks = [];
          r.on('data', function (ch) { chunks.push(ch); if (chunks.length > 64) r.destroy(); });
          r.on('end', function () {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
            done({ status: r.statusCode || 0, json: json });
          });
        });
        tls.end();
      });
      req.end();
    });
  }

  // 可注入的 http 层：测试用它注入假响应，不必联网也不需要为测试开后门。
  // 与项目既有的 setCredentialSource 注入风格一致。
  let httpGetJsonImpl = null;
  function setHttpGetJsonImpl(fn) { httpGetJsonImpl = typeof fn === 'function' ? fn : null; }

  // 自包含的只读 JSON GET（带重定向与超时）。
  // 不依赖 apple-music-web-lyrics 的内部工具，避免为一次维基请求扩大别的模块的公开接口。
  let cachedProxy = null;   // undefined=未探测，''=无代理
  function systemProxy() {
    if (cachedProxy === null) cachedProxy = readSystemProxy();
    return cachedProxy;
  }

  // 直连优先，失败再试系统代理。两条路都失败返回 null —— 调用方按 missing 处理，
  // 绝不让详情页因此失败。
  //
  // 代理记忆：一旦代理成功过（说明当前网络确实需要它），后续不再白试直连 ——
  // 否则每次都要先等一次直连超时，白白多花数秒。
  let proxyProven = false;

  async function httpGetJsonWithProxy(url, timeoutMs, redirectsLeft) {
    const proxy = systemProxy();
    if (!(proxy && proxyProven)) {
      const direct = await httpGetJsonDirect(url, timeoutMs, redirectsLeft);
      if (direct && direct.status === 200) return direct;
      if (!proxy) return direct;
      const viaProxy = await httpGetJsonViaProxy(proxy, url, timeoutMs);
      if (viaProxy && viaProxy.status === 200) { proxyProven = true; return viaProxy; }
      return direct || viaProxy;
    }
    const viaProxyFirst = await httpGetJsonViaProxy(proxy, url, timeoutMs);
    if (viaProxyFirst && viaProxyFirst.status === 200) return viaProxyFirst;
    // 代理这次不行了（可能被关掉）—— 回落直连，并清掉记忆
    proxyProven = false;
    return httpGetJsonDirect(url, timeoutMs, redirectsLeft);
  }

  function httpGetJson(url, timeoutMs, redirectsLeft) {
    if (httpGetJsonImpl) return httpGetJsonImpl(url, timeoutMs, redirectsLeft);
    return httpGetJsonWithProxy(url, timeoutMs, redirectsLeft);
  }

  function httpGetJsonDirect(url, timeoutMs, redirectsLeft) {
    return new Promise(function (resolve) {
      const left = typeof redirectsLeft === 'number' ? redirectsLeft : 2;
      let u = null;
      try { u = new URL(url); } catch (_) { resolve(null); return; }
      let settled = false;
      const done = function (v) { if (!settled) { settled = true; resolve(v); } };
      let req = null;
      try {
        req = https.request({
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: 'GET',
          headers: { 'User-Agent': 'MineRadio/2.0 (artist bio)', 'Accept': 'application/json' },
        }, function (res) {
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400 && res.headers.location && left > 0) {
            res.resume();
            const next = new URL(res.headers.location, url).toString();
            // 跟随重定向要回到**自身**（直连路径），不能再进外层分流，
            // 否则会重复一次"直连+代理"的双路径，并可能拿错最终结果。
            return httpGetJsonDirect(next, timeoutMs, left - 1).then(done);
          }
          const chunks = [];
          res.on('data', function (ch) { chunks.push(ch); });
          res.on('end', function () {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
            done({ status: code, json: json });
          });
        });
      } catch (_) { return done(null); }
      req.setTimeout(Math.max(1000, Number(timeoutMs) || WIKI_TIMEOUT_MS), function () { try { req.destroy(); } catch (_) { } done(null); });
      req.on('error', function () { done(null); });
      req.end();
    });
  }

  // 用中文维基的搜索把英文名映射到中文条目名（实测 "Abel Tesfaye" -> "威肯"）。
  // 只取候选标题，最终仍走 summary + 同一套消歧校验 —— 绝不因为"搜到了"就直接采用。
  // 返回**多个**候选标题：搜索排第一的未必可取（实测 "Abel Tesfaye" 的首个候选
  // 是「錯愛」这类同名作品，取到 404），所以由调用方逐个尝试。
  async function searchZhTitles(query) {
    const url = 'https://zh.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1'
      + '&srlimit=5&srsearch=' + encodeURIComponent(query);
    const res = await httpGetJson(url, WIKI_TIMEOUT_MS, 2);
    if (!res || res.status !== 200 || !res.json) return [];
    const hits = (res.json.query && res.json.query.search) || [];
    const out = [];
    for (let i = 0; i < hits.length; i += 1) {
      const t = normalizeText(hits[i] && hits[i].title);
      if (!t) continue;
      // 跳过明显不是艺人的条目类型
      if (/(專輯|专辑|歌曲|單曲|单曲|列表|年表|电影|電視劇|电视剧|巡迴演唱會|巡回演唱会)$/.test(t)) continue;
      if (out.indexOf(t) < 0) out.push(t);
    }
    return out;
  }

  async function fetchWikiSummary(title, lang) {
    const url = 'https://' + lang + '.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title)
      + '?redirect=true';
    const res = await httpGetJson(url, WIKI_TIMEOUT_MS, 2);
    if (!res || res.status !== 200 || !res.json) {
      return { ok: false, found: false, reason: 'HTTP_' + ((res && res.status) || 'ERR') };
    }
    if (res.json.lang === undefined) res.json.lang = lang;
    const v = wikiVerdict(res.json);
    if (!v.ok) v.found = v.found !== false;   // 200 且解析出对象 -> 页面存在
    return v;
  }

  // 按 artist ID 取简介；结果（含失败）写缓存。
  async function resolveArtistWiki(artistId, name) {
    const id = normalizeText(artistId);
    const title = normalizeText(name);
    if (!id) return null;
    loadArtistsFromDisk();
    const cached = artistState.wiki.has(id) ? artistState.wiki.get(id) : undefined;
    // 只有"当前策略"写下的记录才算有效（无 policy 字段 = 旧版本，作废重取）。
    if (cached && cached.policy === WIKI_POLICY) return cached;
    if (!title) {
      artistState.wiki.set(id, { status: 'missing', reason: 'NO_NAME', policy: WIKI_POLICY, fetchedAt: Date.now() });
      persistArtists();
      return null;
    }

    let hit = null;
    let lastReason = 'MISS';
    // 诊断暂存（只读自省，供排查语言选择问题）
    artistState.lastWikiDiag = { title: title, policy: WIKI_POLICY, proxy: systemProxy(), steps: [] };

    // 1) 中文维基直查（中文名，或恰好存在中文条目）
    const zhDirect = await fetchWikiSummary(title, 'zh');
    artistState.lastWikiDiag.steps.push({ step: 'zh-direct', ok: zhDirect.ok, found: zhDirect.found, reason: zhDirect.reason });
    if (zhDirect.ok) hit = zhDirect.data;
    else {
      lastReason = zhDirect.reason || lastReason;
      // 页面存在但不可用（消歧义/跨领域）-> 不再回退，避免真实原因被覆盖
      if (!zhDirect.found) {
        // 2) 英文名在中文维基通常没有直接条目 —— 用搜索映射到中文条目名
        //    （实测 "Abel Tesfaye" -> "威肯"、"Ariana Grande" -> "爱莉安娜·格兰德"）
        if (!hasCjk(title)) {
          const candidates = await searchZhTitles(title);
          artistState.lastWikiDiag.steps.push({ step: 'zh-search', candidates: candidates });
          for (let ci = 0; ci < candidates.length; ci += 1) {
            const viaSearch = await fetchWikiSummary(candidates[ci], 'zh');
            artistState.lastWikiDiag.steps.push({ step: 'zh-cand', title: candidates[ci], ok: viaSearch.ok, reason: viaSearch.reason });
            if (viaSearch.ok) {
              hit = viaSearch.data;
              if (hit && !hit.matchedBy) hit.matchedBy = 'zh-search:' + candidates[ci];
              break;
            }
            lastReason = viaSearch.reason || lastReason;
          }
        }
        // 3) 仍然没有 -> 英文维基（保留英文总比没有好，UI 会标注来源）
        if (!hit) {
          const en = await fetchWikiSummary(title, 'en');
          artistState.lastWikiDiag.steps.push({ step: 'en', ok: en.ok, reason: en.reason });
          if (en.ok) hit = en.data;
          else lastReason = en.reason || lastReason;
        }
      }
    }
    if (hit) {
      const record = Object.assign({ status: 'ok', policy: WIKI_POLICY }, hit);
      artistState.wiki.set(id, record);
      persistArtists();
      return record;
    }
    // 失败分两类（关键）：
    //   永久性（404/消歧义/跨领域）—— 记负缓存，避免反复请求。
    //   临时性（网络错误/超时）—— **不写缓存**，下次进入详情时重试；
    //     否则一次网络抖动会把这位艺人永久钉成"没有简介"，
    //     而且会一直压着旧的（可能是英文的）结果不让它更新。
    const transient = /HTTP_ERR|HTTP_0$/.test(String(lastReason));
    const record = { status: 'missing', reason: lastReason, policy: WIKI_POLICY, fetchedAt: Date.now() };
    if (transient) {
      // 保留旧记录（若有）但不覆盖；直接返回本次结果供本次展示使用。
      return record;
    }
    artistState.wiki.set(id, record);
    persistArtists();
    return record;
  }

  // 不阻塞版：调用方拿到 Promise，但可以不等它 —— 详情页不因维基变慢。
  function resolveArtistWikiAsync(artistId, name) {
    return resolveArtistWiki(artistId, name).catch(function () { return null; });
  }

  function getArtistWiki(artistId) {
    loadArtistsFromDisk();
    return artistState.wiki.get(normalizeText(artistId)) || null;
  }

  function getWikiDiag() { return artistState.lastWikiDiag || null; }

  function getArtistCacheInfo() {
    loadArtistsFromDisk();
    return {
      path: artistCachePathFor(cachePath),
      songEntries: artistState.songToArtists.size,
      artistEntries: artistState.artists.size,
      persistedAt: artistState.persistedAt,
    };
  }

  function getResolvedArtistIds(catalogSongId) {
    loadArtistsFromDisk();
    return (artistState.songToArtists.get(normalizeText(catalogSongId)) || []).slice();
  }

  function getArtistDetail(artistId) {
    loadArtistsFromDisk();
    const d = artistState.artists.get(normalizeText(artistId));
    if (!d) return null;
    // hasImage 以 image 为准推导，而不是依赖存储的布尔字段 ——
    // 这样旧缓存（在加 hasImage 之前写的）也能正确工作。
    if (typeof d.hasImage !== 'boolean') d.hasImage = !!d.image;
    if (!d.status) d.status = d.hasImage ? 'ok' : 'no-image';
    return d;
  }

  function sleepMs(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, ms)); });
  }

  function getRememberedCatalogAlbum(catalogSongId) {
    loadFromDisk();
    return derivedMaps.catalogAlbumBySongId.get(normalizeText(catalogSongId)) || '';
  }

  return {
    cachePath,
    sync,
    fullSync,
    probe,
    getState,
    getSongs,
    getAlbums,
    getAlbumById,
    getSongsByAlbumName,
    rememberCatalogAlbum,
    getRememberedCatalogAlbum,
    rememberAlbumCatalog,
    getAlbumCatalog,
    resolveArtistsForSongs,
    resolveArtistGroups,
    getArtistCacheInfo,
    getResolvedArtistIds,
    getArtistDetail,
    resolveArtistWiki,
    resolveArtistWikiAsync,
    getArtistWiki,
    getWikiDiag,
    // 测试用
    setHttpGetJsonImpl,
    rebuildDerived,
    // 测试用
    _internal: { offsetFromNext, mapRawSong, mapRawAlbum, readAllPages, resolveDefaultCachePath },
  };
}

// ------------------------------------------------------------
// 专辑归属校验 + 曲目重建
//
// 输入是缓存里的原始歌曲记录，输出"已通过身份校验"的曲目列表。
// Catalog 只用于验证，绝不把未保存到资料库的歌曲补进结果。
//
// 校验规则（任一不满足即不并入）：
//   1. 名称归组只用于产生候选；
//   2. 候选必须有有效 catalogId（缺失 -> 不并入）；
//   3. catalogId 反查所属 catalog 专辑必须唯一（多张 -> 拒绝）；
//   4. 该 catalog 专辑曲目集合里必须包含这个 catalogId；
//   5. 整组候选必须指向同一个 catalog 专辑（有一个不一致 -> 整组拒绝）；
//   6. 序号合理性只作诊断，不据此并入。
// ------------------------------------------------------------

const catalogSongAlbumMemo = new Map();
const catalogAlbumTracksMemo = new Map();

// 由服务实例注入：重建成功后把「库内专辑 id -> catalog 专辑 id」记进索引。
let rememberAlbumCatalogCb = function () {};
function setAlbumCatalogRecorder(fn) { if (typeof fn === 'function') rememberAlbumCatalogCb = fn; }

async function lookupCatalogSongAlbum(catalogSongId) {
  const key = normalizeText(catalogSongId);
  if (!key) return { ok: false, reason: 'NO_ID' };
  if (catalogSongAlbumMemo.has(key)) return catalogSongAlbumMemo.get(key);
  const out = { ok: false, reason: 'NOT_FOUND', albumId: '', storefront: '', albums: [] };
  for (const sf of CATALOG_LOOKUP_STOREFRONTS) {
    let page = null;
    try { page = await webApi.getCatalog(sf, '/songs/' + encodeURIComponent(key), { include: 'albums' }); } catch (_) { continue; }
    if (!page || !page.ok) continue;
    const entry = (page.json && Array.isArray(page.json.data) && page.json.data[0]) || null;
    const rel = (entry && entry.relationships && entry.relationships.albums && entry.relationships.albums.data) || [];
    if (!rel.length) continue;
    out.ok = true;
    out.reason = '';
    out.storefront = sf;
    out.albums = rel.map((a) => ({ id: normalizeText(a && a.id), name: normalizeText((a && a.attributes || {}).name) }));
    out.albumId = (out.albums.length === 1) ? out.albums[0].id : '';
    break;
  }
  catalogSongAlbumMemo.set(key, out);
  return out;
}

async function loadCatalogAlbumTracks(albumId) {
  const key = normalizeText(albumId);
  if (!key) return { ok: false, trackIds: new Set(), trackNumbers: new Map(), attrs: null };
  if (catalogAlbumTracksMemo.has(key)) return catalogAlbumTracksMemo.get(key);
  const out = { ok: false, trackIds: new Set(), trackNumbers: new Map(), attrs: null, storefront: '' };
  for (const sf of CATALOG_LOOKUP_STOREFRONTS) {
    let page = null;
    try { page = await webApi.getCatalog(sf, '/albums/' + encodeURIComponent(key), { include: 'tracks' }); } catch (_) { continue; }
    if (!page || !page.ok) continue;
    const entry = (page.json && Array.isArray(page.json.data) && page.json.data[0]) || null;
    if (!entry) continue;
    const rel = (entry.relationships && entry.relationships.tracks && entry.relationships.tracks.data) || [];
    if (!rel.length) continue;
    out.ok = true;
    out.storefront = sf;
    out.attrs = entry.attributes || null;
    rel.forEach((t) => {
      const tid = normalizeText(t && t.id);
      if (!tid) return;
      out.trackIds.add(tid);
      out.trackNumbers.set(tid, Number((t.attributes || {}).trackNumber) || 0);
    });
    break;
  }
  catalogAlbumTracksMemo.set(key, out);
  return out;
}

// 回退候选来源：当专辑名归组为空时使用。
// 背景（实测）：库内专辑名与曲目的 albumName 会因**本地化**而不一致，549 张里有 38 张如此：
//   库内 "The Cruel Angel's Thesis"  vs  曲目 albumName "残酷な天使のテーゼ - EP"
//   库内 "Tribute to Kenshi Yonezu - …" vs 曲目 albumName "Tribute to 米津玄師 - …"
// 此时用专辑关联端点返回的曲目 id（精确 Library Song ID，非名称）去本地索引里定位同一批歌。
// 注意：这只是**候选来源**，归属仍必须通过后面的 catalogId 校验，校验不过就不并入。
async function fetchEndpointCandidateIds(libraryAlbumId) {
  const id = normalizeText(libraryAlbumId);
  if (!id) return { ok: false, ids: [] };
  try {
    const page = await webApi.getLibrary('/albums/' + encodeURIComponent(id) + '/tracks', { limit: 100, offset: 0 });
    if (!page || !page.ok) return { ok: false, ids: [] };
    const items = (page.json && Array.isArray(page.json.data)) ? page.json.data : [];
    return { ok: true, ids: items.map((x) => normalizeText(x && x.id)).filter(Boolean) };
  } catch (_) {
    return { ok: false, ids: [] };
  }
}

// songs：缓存里的原始歌曲记录数组（由调用方给出，便于独立测试）。
async function reconstructAlbumTracks(libraryAlbum, songs) {
  const wantName = normalizeText(libraryAlbum && libraryAlbum.name);
  if (!wantName) return { ok: false, error: 'NO_ALBUM_NAME', verified: [], unverified: [], confidence: 'none' };

  const byId = new Map();
  (songs || []).forEach((r) => { if (r && r.librarySongId) byId.set(r.librarySongId, r); });

  let nameMatches = (songs || []).filter((r) => normalizeText(r && r.albumName) === wantName);
  let candidateSource = 'albumName';
  let endpointFallback = null;
  if (!nameMatches.length && libraryAlbum && libraryAlbum.id) {
    // 本地化导致名称不一致时的回退：用关联端点的精确 library song id 定位候选。
    const ep = await fetchEndpointCandidateIds(libraryAlbum.id);
    if (ep.ok && ep.ids.length) {
      const resolved = ep.ids.map((sid) => byId.get(sid)).filter(Boolean);
      if (resolved.length) {
        nameMatches = resolved;
        candidateSource = 'endpoint-library-song-ids';
      }
      endpointFallback = { endpointTracks: ep.ids.length, resolvedInIndex: resolved.length };
    } else {
      endpointFallback = { endpointTracks: 0, resolvedInIndex: 0 };
    }
  }
  const candidates = [];
  const unverified = [];
  const diagnostics = [];

  for (const song of nameMatches) {
    if (!song.catalogId) {
      unverified.push({ song, reason: song.hasPlayParams ? 'NO_CATALOG_ID' : 'NO_PLAY_PARAMS' });
      continue;
    }
    const owner = await lookupCatalogSongAlbum(song.catalogId);
    if (!owner.ok) { unverified.push({ song, reason: 'CATALOG_LOOKUP_MISS' }); continue; }
    if (!owner.albumId) {
      unverified.push({ song, reason: 'AMBIGUOUS_CATALOG_ALBUM', albums: owner.albums });
      continue;
    }
    const catTracks = await loadCatalogAlbumTracks(owner.albumId);
    if (!catTracks.ok) { unverified.push({ song, reason: 'CATALOG_ALBUM_TRACKS_MISS' }); continue; }
    if (!catTracks.trackIds.has(String(song.catalogId))) {
      unverified.push({ song, reason: 'NOT_IN_CATALOG_ALBUM', catalogAlbumId: owner.albumId });
      continue;
    }
    candidates.push({
      song,
      catalogAlbumId: owner.albumId,
      catalogAlbumName: owner.albums[0] ? owner.albums[0].name : '',
      storefront: owner.storefront,
      catalogTrackNumber: catTracks.trackNumbers.get(String(song.catalogId)) || 0,
      numberMatches: (catTracks.trackNumbers.get(String(song.catalogId)) || 0) === (Number(song.trackNumber) || 0),
    });
  }

  const base = { nameMatchCount: nameMatches.length, candidateSource, endpointFallback, unverified, diagnostics };
  if (!candidates.length) {
    return Object.assign(base, {
      ok: true, verified: [], confidence: 'none', catalogAlbumId: '', verifiedEmpty: true,
      reasons: [nameMatches.length ? 'NO_VERIFIABLE_CANDIDATE' : 'NO_NAME_MATCH'],
    });
  }

  const distinctAlbums = Array.from(new Set(candidates.map((c) => c.catalogAlbumId)));
  if (distinctAlbums.length > 1) {
    return Object.assign(base, {
      ok: true, verified: [], confidence: 'none', catalogAlbumId: '', verifiedEmpty: true,
      reasons: ['CANDIDATES_SPLIT_ACROSS_ALBUMS'], distinctCatalogAlbums: distinctAlbums,
    });
  }

  const catalogAlbumId = distinctAlbums[0];
  rememberAlbumCatalogCb(libraryAlbum && (libraryAlbum.id || libraryAlbum.libraryId), catalogAlbumId);
  const catTracks = await loadCatalogAlbumTracks(catalogAlbumId);
  const catalogAlbumName = catTracks.attrs ? normalizeText(catTracks.attrs.name) : '';
  const catalogArtist = catTracks.attrs ? normalizeText(catTracks.attrs.artistName) : '';
  const wantArtist = normalizeText(libraryAlbum && libraryAlbum.artist);

  if (candidates.some((c) => !c.numberMatches)) {
    diagnostics.push({ kind: 'TRACK_NUMBER_MISMATCH', count: candidates.filter((c) => !c.numberMatches).length });
  }
  let confidence = 'verified';
  if (!catTracks.attrs) confidence = 'verified-no-album-attrs';
  // 专辑名差异只作诊断，**不再拒绝**。
  // 理由（实测 6/6）：库内专辑名与 catalog 专辑名常因命名约定/本地化而不同
  //   （"The Cruel Angel's Thesis" vs 残酷な天使のテーゼ、"Aphelion…" vs 远光点…），
  // 而这些案例的重建数都等于 appleTrackCount，反查也唯一 —— 名字不同不代表身份不同。
  // 真正判定身份的是结构性证据：catalogId 反查唯一 + 属于该 catalog 专辑 + 整组一致。
  if (catalogAlbumName && catalogAlbumName !== wantName) {
    diagnostics.push({ kind: 'CATALOG_ALBUM_NAME_DIFFERS', catalogAlbumName, libraryAlbumName: wantName });
  }
  if (wantArtist && catalogArtist && wantArtist !== catalogArtist) {
    diagnostics.push({ kind: 'ARTIST_LABEL_DIFFERS', libraryArtist: wantArtist, catalogArtist });
  }

  const verified = candidates.map((c) => Object.assign({}, c.song, {
    source: 'library',
    catalogAlbumId: c.catalogAlbumId,
    catalogTrackNumber: c.catalogTrackNumber,
    verifiedBy: 'catalogId->catalog-album',
  }));
  verified.sort((a, b) => {
    const na = Number(a.trackNumber) || Number(a.catalogTrackNumber) || 1e6;
    const nb = Number(b.trackNumber) || Number(b.catalogTrackNumber) || 1e6;
    return na - nb;
  });

  return Object.assign(base, {
    ok: true,
    verified,
    confidence,
    catalogAlbumId,
    catalogAlbumName,
    catalogArtist,
    storefront: candidates[0].storefront,
    catalogAlbumTrackCount: catTracks.trackIds.size,
    // 专辑文案：来自**已经在做归属校验时查到**的 catalog 专辑对象，不额外发请求。
    // 命名刻意叫 albumNotes 而不是 catalog*：它只是专辑的说明文字，
    // 与"Catalog 曲目"是完全不同的东西 —— 后者绝不允许出现在列表里。
    // （资料库专辑接口实测不返回 editorialNotes，所以简介只能来自 catalog 专辑。）
    albumNotes: catTracks.attrs ? {
      editorialNotes: catTracks.attrs.editorialNotes || null,
      copyright: normalizeText(catTracks.attrs.copyright),
      recordLabel: normalizeText(catTracks.attrs.recordLabel),
      upc: normalizeText(catTracks.attrs.upc),
      releaseDate: normalizeText(catTracks.attrs.releaseDate),
    } : null,
    reasons: [],
  });
}

// 取专辑简介：先查「库内专辑 id -> catalog 专辑 id」映射。
// 映射来自重建时的成功校验，或由服务在同步后补齐。
// 只返回文案字段，绝不返回 catalog 曲目。
async function enrichAlbumNotes(libraryAlbumId, getCatalogAlbumId) {
  const libId = normalizeText(libraryAlbumId);
  if (!libId) return null;
  let catalogAlbumId = typeof getCatalogAlbumId === 'function' ? normalizeText(getCatalogAlbumId(libId)) : '';
  if (!catalogAlbumId) return null;
  const tracks = await loadCatalogAlbumTracks(catalogAlbumId);
  if (!tracks || !tracks.attrs) return null;
  return {
    catalogAlbumId,
    editorialNotes: tracks.attrs.editorialNotes || null,
    copyright: normalizeText(tracks.attrs.copyright),
    recordLabel: normalizeText(tracks.attrs.recordLabel),
    upc: normalizeText(tracks.attrs.upc),
    releaseDate: normalizeText(tracks.attrs.releaseDate),
  };
}

module.exports = {
  createAppleMusicLibraryCacheService,
  reconstructAlbumTracks,
  enrichAlbumNotes,
  setAlbumCatalogRecorder,
  lookupCatalogSongAlbum,
  loadCatalogAlbumTracks,
  CACHE_FILE_NAME,
  CACHE_SCHEMA_VERSION,
  ARTIST_CACHE_FILE_NAME,
  ARTIST_CACHE_SCHEMA_VERSION,
};
