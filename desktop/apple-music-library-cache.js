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
const webApi = require('./apple-music-web-api');

const CACHE_SCHEMA_VERSION = 1;
const CACHE_FILE_NAME = 'apple-music-library-cache.json';

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
};
