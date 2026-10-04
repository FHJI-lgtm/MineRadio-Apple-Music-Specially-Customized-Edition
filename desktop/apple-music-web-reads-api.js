// ============================================================
const {
  createAppleMusicLibraryCacheService,
  reconstructAlbumTracks,
  enrichAlbumNotes,
} = require('./apple-music-library-cache');

// 资料库索引服务（本地缓存 + 增量同步）。本文件只做「读取 Apple + 校验归属」的薄适配，
// 缓存与增量逻辑都在 apple-music-library-cache.js 里，可被资料库页 / 专辑详情 / 统计共用。
const libraryCache = createAppleMusicLibraryCacheService({});
// Apple Music WEB read handlers (library reads only)
//
// Boundary (deliberate): this module is the ONLY place that consumes the Apple Music WEB credential.
// apple-music-api.js stays the Developer-API world and must not touch the media-user-token; the lyrics
// world (apple-music-lyrics-api.js -> apple-music-web-lyrics.js) owns its own credential usage.
// What is shared across the three worlds is the credential DATA SOURCE, never another module's internals.
//
// Credential source: the SAME store file and format the main process uses
// (.../.apple-music-lyrics-credential.json via createAppleMusicLyricsCredentialStore), built here inside
// the server's own require graph. No second token file, no second format, no global cache (a decrypt per
// call is the accepted cost of this step).
//
// The media-user-token is a product-level web credential; the lyrics feature is merely its earliest
// consumer. One credential source, two header contracts: Music-User-Token (library reads) and
// media-user-token (lyrics/web).
//
// Transport stays in apple-music-web-api.js: no safeStorage or decryption logic leaks into these handlers.
// ============================================================

const path = require('path');
const webApi = require('./apple-music-web-api');
const lyricsCredential = require('./apple-music-lyrics-credential');
const devApi = require('../apple-music-api');
const APPLE_LIKED_PLAYLIST_ID = devApi.APPLE_LIKED_PLAYLIST_ID;
// Pure mappers/helpers reused from the Developer module (no credential access on that side).
const { mapAppleTrack, mapAppleLibraryPlaylist, appleErrorDetails } = devApi._test;

// Mirrors of the Developer module's own page caps / storefront default (values, not credentials).
const APPLE_LIBRARY_PAGE_LIMIT = 100;
const APPLE_PLAYLIST_PAGE_LIMIT = 100;
const DEFAULT_APPLE_STOREFRONT = 'us';
function normalizeText(value) { return String(value == null ? '' : value).trim(); }

let credentialSourceBound = false;
// Builds the credential source lazily and only inside a real Electron process: in plain node we must not
// pretend the main-process credential is readable.
function ensureCredentialSource() {
  if (credentialSourceBound) return true;
  if (!(process.versions && process.versions.electron)) return false;
  const electron = require('electron');
  const app = electron.app;
  const safeStorage = electron.safeStorage;
  if (!app || !safeStorage) return false;
  const pkg = require('../package.json');
  const appName = process.env.MINERADIO_RUNTIME_NAME
    || (pkg.mineradio && pkg.mineradio.runtimeName)
    || pkg.productName
    || 'Mineradio';
  const qaDir = String(process.env.MINERADIO_STARTUP_QA_USER_DATA || '').trim();
  const useQa = process.env.MINERADIO_STARTUP_QA_HIDDEN === '1' && qaDir && path.isAbsolute(qaDir);
  const userData = useQa ? qaDir : path.join(app.getPath('appData'), appName);
  const store = lyricsCredential.createAppleMusicLyricsCredentialStore({
    filePath: path.join(userData, lyricsCredential.CREDENTIAL_FILE_NAME),
    safeStorage,
  });
  webApi.setCredentialSource(() => store.readTokenForMainProcess());
  webApi.setReadOnly(true);   // step 3 migrates reads only
  credentialSourceBound = true;
  return true;
}
// ---- Apple Music WEB path for user playlists (step 3A) -------------------------------------------------
// Same response contract as handleAppleUserPlaylists above, but the data comes from the Web API
// (AMPWeb bearer + media-user-token) instead of the Developer JWT. The Developer handler is kept
// untouched and still exported; this route simply no longer uses it.
// identity note: the web credential store carries no nickname/userId, so userId is '' on this path.
async function handleAppleUserPlaylistsWeb(options) {
  options = options || {};
  
  const userToken = webApi.getMediaUserToken();
  if (!userToken) {
    return { provider: 'apple', loggedIn: false, playlists: [], message: '需要先登录 Apple Music 网页账号（media-user-token 未配置）。', error: '' };
  }
  const maxTotal = Math.max(1, Math.min(500, Number(options.limit) || 300));
  const startOffset = Math.max(0, Number(options.offset) || 0);
  const playlists = [];
  let offset = startOffset;
  let playlistError = null;
  let lastJson = null;
  try {
    while (playlists.length < maxTotal) {
      const pageLimit = Math.min(APPLE_LIBRARY_PAGE_LIMIT, maxTotal - playlists.length);
      // GET only: the web layer is in read-only mode for this phase.
      const page = await webApi.getLibrary('/playlists', { limit: pageLimit, offset });
      if (!page.ok) { playlistError = { error: page.code, message: 'Apple Music Web 返回 HTTP ' + page.status }; break; }
      const json = page.json || {};
      const items = Array.isArray(json.data) ? json.data : [];
      items.forEach((item) => { const mapped = mapAppleLibraryPlaylist(item); if (mapped) playlists.push(mapped); });
      if (!items.length || !json.next) break;
      offset += items.length;
    }
  } catch (err) {
    playlistError = appleErrorDetails(err);
  }
  const likedCard = {
    provider: 'apple',
    source: 'apple',
    id: APPLE_LIKED_PLAYLIST_ID,
    virtual: true,
    name: 'Apple Music 资料库',
    cover: '',
    creator: 'Apple Music',
    trackCount: 0,
    playCount: 0,
    subscribed: false,
    shelfPane: 'fav',
  };
  const total = Math.max(playlists.length + startOffset, Number(lastJson && lastJson.meta && lastJson.meta.total) || (playlists.length + startOffset));
  const nextOffset = startOffset + playlists.length;
  return {
    provider: 'apple',
    loggedIn: true,
    userId: '',
    playlists: (startOffset === 0 ? [likedCard] : []).concat(playlists),
    total,
    offset: startOffset,
    limit: maxTotal,
    nextOffset,
    hasMore: !!(lastJson && lastJson.next) && nextOffset < total,
    partial: true,
    source: 'web',
    error: playlistError && playlistError.error || '',
    message: playlistError && playlistError.message || '',
  };
}
// ---- Apple Music WEB path for playlist tracks (step 3B) ----------------------------------------------
// Same mapper and same response contract as handleApplePlaylistTracks below, but reading the Web API.
// ID RULE (hard): a playlist track keeps the `a.<catalogId>` id the payload carries. It is NEVER
// re-wrapped into `i.*` (that namespace belongs to /v1/me/library/songs only), and a catalog id is only
// ever taken from attributes.playParams.catalogId - never parsed out of an id or a URL.
// PAGINATION (honest): the Web payload's next-page link has not been observed for this endpoint, so
// hasMore is derived from what is actually present (json.next) and never fabricated.
async function handleApplePlaylistTracksWeb(playlistId, opts) {
  opts = opts || {};
  
  const id = normalizeText(playlistId);
  const limit = Math.max(1, Math.min(APPLE_PLAYLIST_PAGE_LIMIT, Number(opts.limit) || 48));
  const startOffset = Math.max(0, Number(opts.offset) || 0);
  if (!id) return { provider: 'apple', playlistId: '', tracks: [], total: 0, offset: 0, limit, nextOffset: 0, hasMore: false, error: 'MISSING_PLAYLIST_ID', message: '' };
  const userToken = webApi.getMediaUserToken();
  if (!userToken) {
    return { provider: 'apple', playlistId: id, tracks: [], total: 0, offset: startOffset, limit, nextOffset: startOffset, hasMore: false, error: '', message: '需要先登录 Apple Music 网页账号（media-user-token 未配置）。' };
  }
  const storefront = DEFAULT_APPLE_STOREFRONT;
  let json = null;
  try {
    // The virtual "Apple Music 资料库" card (APPLE_LIKED_PLAYLIST_ID) has no library playlist id:
    // its content is the library SONGS collection, whose ids are the i.* namespace. Real playlists
    // keep reading /v1/me/library/playlists/<id>/tracks (a.* namespace) - the two are never merged.
    const page = (id === APPLE_LIKED_PLAYLIST_ID)
      ? await webApi.getLibrary('/songs', { limit, offset: startOffset })
      : await webApi.getLibrary('/playlists/' + encodeURIComponent(id) + '/tracks', { limit, offset: startOffset });
    if (!page.ok) {
      return { provider: 'apple', playlistId: id, tracks: [], total: 0, offset: startOffset, limit, nextOffset: startOffset, hasMore: false, source: 'web', error: page.code, message: 'Apple Music Web 返回 HTTP ' + page.status };
    }
    json = page.json || {};
  } catch (err) {
    const detail = appleErrorDetails(err);
    return Object.assign({ provider: 'apple', playlistId: id, tracks: [], total: 0, offset: startOffset, limit, nextOffset: startOffset, hasMore: false }, detail);
  }
  const items = Array.isArray(json.data) ? json.data : [];
  // F6: carry the EXPLICIT catalog identity from attributes.playParams.catalogId onto each mapped track, so
  // the renderer can hand this track to Apple Music without ever decoding the `a.<...>` id form. No inference.
  const tracks = items.map((item, index) => {
    const mapped = mapAppleTrack(item, startOffset + index, id, { storefront });
    if (mapped) {
      const pp = (item && item.attributes && item.attributes.playParams) || {};
      if (pp.catalogId !== undefined && pp.catalogId !== null && String(pp.catalogId) !== '') mapped.catalogId = String(pp.catalogId);
    }
    return mapped;
  }).filter(Boolean);
  const total = Math.max(tracks.length + startOffset, Number(json.meta && json.meta.total) || (tracks.length + startOffset));
  const nextOffset = startOffset + tracks.length;
  return {
    provider: 'apple',
    playlistId: id,
    tracks,
    total,
    offset: startOffset,
    limit,
    nextOffset,
    hasMore: !!json.next && nextOffset < total,
    source: 'web',
    error: '',
    message: '',
  };
}
// 取**整个歌单**的曲目：按 nextOffset 逐页拉取，直到 hasMore 为假。
//
// 为什么需要它：单页上限是 100（Apple 侧的分页上限），只取一页会让 370 首的歌单
// 显示成 100 首。既有 handler 只负责一页，分页收敛放在这里，保持单页语义不变。
const APPLE_PLAYLIST_ALL_MAX = 2000;   // 安全上限，避免异常 next 导致无界循环
const APPLE_PLAYLIST_ALL_MAX_PAGES = 40;

async function handleApplePlaylistTracksAllWeb(playlistId, options) {
  const opts = options || {};
  const maxTotal = Math.max(1, Math.min(APPLE_PLAYLIST_ALL_MAX, Number(opts.maxTotal) || APPLE_PLAYLIST_ALL_MAX));
  // 允许注入单页读取实现：分页收敛逻辑因此可以脱离网络被测试
  const fetchPage = (typeof opts.fetchPage === 'function') ? opts.fetchPage : handleApplePlaylistTracksWeb;
  const all = [];
  let offset = 0;
  let total = 0;
  let pages = 0;
  let error = '';
  let message = '';
  while (all.length < maxTotal && pages < APPLE_PLAYLIST_ALL_MAX_PAGES) {
    let page = null;
    try {
      page = await fetchPage(playlistId, { limit: APPLE_PLAYLIST_PAGE_LIMIT, offset });
    } catch (err) {
      page = null;
      error = 'PLAYLIST_PAGE_THREW';
      message = String((err && err.message) || err);
      break;
    }
    pages += 1;
    if (!page) { error = 'PLAYLIST_PAGE_NULL'; break; }
    if (page.error) { error = page.error; message = page.message || ''; break; }
    const got = Array.isArray(page.tracks) ? page.tracks : [];
    total = Number(page.total) || total;
    if (!got.length) break;                       // 没有更多了
    got.forEach(function (t) { all.push(t); });
    if (!page.hasMore) break;
    if (Number(page.nextOffset) <= offset) break;  // 游标没前进 -> 防死循环
    offset = Number(page.nextOffset);
    await new Promise(function (res) { setTimeout(res, 80); });
  }
  return {
    provider: 'apple',
    playlistId: String(playlistId || ''),
    tracks: all.slice(0, maxTotal),
    total: Math.max(total, all.length),
    offset: 0,
    limit: all.length,
    nextOffset: all.length,
    truncated: all.length >= maxTotal,
    pages: pages,
    source: 'web',
    error: error,
    message: message,
  };
}

// ---- Apple account status (WEB axis only) ------------------------------------------------------------
// The Developer account axis (Team ID / Key ID / P8 -> JWT -> /v1/me/*) is retired: the Apple account IS
// the web account (media-user-token). This reports that state and nothing else - no credential file, no JWT,
// no Developer request. It lives here (not in apple-music-api.js) because that module's boundary forbids it
// from touching the media-user-token.
function appleWebCredentialSnapshot() {
  let token = '';
  let storefront = '';
  let authorizedAt = 0;
  try { token = normalizeText(webApi.getMediaUserToken && webApi.getMediaUserToken()); } catch (_) { }
  try {
    const store = lyricsCredential.createAppleMusicLyricsCredentialStore({});
    const snap = (typeof store.read === 'function' ? store.read() : (typeof store.get === 'function' ? store.get() : null)) || {};
    if (!token) token = normalizeText(snap.mediaUserToken || snap.token);
    storefront = normalizeText(snap.storefront);
    authorizedAt = Number(snap.authorizedAt) || 0;
  } catch (_) { }
  return { token: token, storefront: storefront, authorizedAt: authorizedAt };
}
async function handleAppleAccountStatusWeb() {
  const snap = appleWebCredentialSnapshot();
  const loggedIn = !!snap.token;
  return {
    provider: 'apple',
    accountAxis: 'web',

    loggedIn: loggedIn,
    configured: loggedIn,
    profileReady: loggedIn,
    nickname: '',
    storefront: snap.storefront,
    tokenConfigured: loggedIn,
    tokenReady: loggedIn,
    authorizedAt: snap.authorizedAt,
    stale: false,
    reauthRequired: false,
    capabilities: {
      search: false,
      playlists: loggedIn,
      library: false,
      play: false,
      lyrics: loggedIn,
      profile: loggedIn,
    },
    error: '',
    errorMessage: '',
    message: loggedIn
      ? 'Apple Music 已连接（Web 账户）：播放走 Windows 应用，歌单/专辑/歌词走 Web 读取。'
      : 'Apple Music 未连接：点击连接后在官方窗口登录 Apple ID。',
  };
}

// ---- Apple Music WEB path for library albums (step A) ------------------------------------------------
// The album axis of the user's Apple Music 资料库. Everything here is a READ of /v1/me/library/albums.
//
// ORDERING — this handler owns the meaning of "最近添加", the UI does not:
//   * the sort key is attributes.dateAdded (when the user ADDED the item to the library), never
//     releaseDate (when the work was PUBLISHED elsewhere, a different fact about a different subject);
//   * every page is read BEFORE sorting, so the order is a property of the whole library and not of one
//     page — sorting per page would produce "each page is newest-first" while the library is not;
//   * an item whose dateAdded is missing or unparseable SINKS and keeps its original relative order.
//     It is never back-filled from releaseDate, Date.now() or position: a fabricated timestamp would make
//     the first screen depend on request order and would be indistinguishable from real data downstream.
//
// ID RULE (hard): a library album's id is the LIBRARY id (l.*); its catalogId is copied verbatim from
// playParams.catalogId and may legitimately be undefined. Nothing is ever inferred or synthesised.
//
// COST (honest): the complete library is materialised in order to sort it, so this axis has no
// page-level laziness. At the observed library size (549 albums -> 6 requests at limit=100) that is the
// accepted price of a correct global order; callers get a window of the already-sorted, complete list.
function appleAlbumAddedAt(album) {
  if (!album) return null;
  const raw = normalizeText(album.dateAdded);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
// Newest -> Oldest. Stable, so equal keys and missing keys both keep the library's own order.
function compareAppleAlbumsByAddedAt(a, b) {
  const ta = appleAlbumAddedAt(a);
  const tb = appleAlbumAddedAt(b);
  if (ta === null && tb === null) return 0;
  if (ta === null) return 1;
  if (tb === null) return -1;
  return tb - ta;
}
async function handleAppleLibraryAlbums(options) {
  options = options || {};
  // 上限 1000：这个轴要能一次铺满整个资料库（实测 549 张）。
  // 分页读取由 handler 自己完成，调用方只需要给一个足够大的窗口。
  const limit = Math.max(1, Math.min(1000, Number(options.limit) || 300));
  const startOffset = Math.max(0, Number(options.offset) || 0);
  const userToken = webApi.getMediaUserToken();
  if (!userToken) {
    return { provider: 'apple', albums: [], total: 0, offset: startOffset, limit, nextOffset: startOffset, hasMore: false, sortedBy: 'dateAdded', sortDirection: 'desc', source: 'web', loggedIn: false, error: '', message: '需要先登录 Apple Music 网页账号（media-user-token 未配置）。' };
  }
  const collected = [];
  let offset = 0;
  let albumError = null;
  try {
    // Read the WHOLE library first: the order below is only correct if it is computed over every page.
    while (true) {
      const pageLimit = APPLE_LIBRARY_PAGE_LIMIT;
      // GET only: the web layer is in read-only mode for this phase.
      const page = await webApi.getLibrary('/albums', { limit: pageLimit, offset });
      if (!page.ok) { albumError = { error: page.code, message: 'Apple Music Web 返回 HTTP ' + page.status }; break; }
      const json = page.json || {};
      const items = Array.isArray(json.data) ? json.data : [];
      items.forEach((item) => { const mapped = webApi.mapLibraryAlbum(item); if (mapped && mapped.libraryId) collected.push(mapped); });
      if (!items.length || !json.next) break;
      offset += items.length;
      // Defensive: never loop forever on a payload that keeps advertising `next` without progress.
      if (offset > 20000) break;
    }
  } catch (err) {
    albumError = appleErrorDetails(err);
  }
  let ordered = collected.slice();
  try {
    // Array#sort is stable by spec, so this also pins the two "no usable date" cases to their
    // original relative order instead of shuffling them.
    ordered.sort(compareAppleAlbumsByAddedAt);
  } catch (_) {
    ordered = collected.slice();   // a broken comparator must degrade to API order, never to a crash
  }
  const total = ordered.length;
  const albums = ordered.slice(startOffset, startOffset + limit);
  const nextOffset = startOffset + albums.length;
  return {
    provider: 'apple',
    albums,
    total,
    offset: startOffset,
    limit,
    nextOffset,
    hasMore: nextOffset < total,
    // Self-describing: the order is part of the data contract, not a presentation detail.
    sortedBy: 'dateAdded',
    sortDirection: 'desc',
    source: 'web',
    loggedIn: true,
    error: albumError && albumError.error || '',
    message: albumError && albumError.message || '',
  };
}

// ---- Apple Music WEB path for catalog album detail (step 3C) -----------------------------------------
// Scope: CATALOG albums only (the caller supplies a catalog album id). Library albums carry no catalog id
// (playParams.catalogId === undefined) and are deliberately NOT supported in this step - no id is ever
// inferred, guessed or synthesised. Same response contract as handleAppleAlbumDetail (Developer path).
async function handleAppleAlbumDetailWeb(albumId, opts) {
  opts = opts || {};
  const id = normalizeText(albumId);
  const limit = Math.max(1, Math.min(100, parseInt(opts.limit, 10) || 80));
  const storefront = normalizeText(opts.storefront) || DEFAULT_APPLE_STOREFRONT;
  if (!id) return { provider: 'apple', error: 'MISSING_ALBUM_ID', album: null, songs: [], total: 0 };
  const userToken = webApi.getMediaUserToken();
  let json = null;
  try {
    // Catalog reads work with the bearer alone; the user token is sent when present.
    // Apple rejects `limit` on this request (400 Invalid Parameter / code 40004: "Limit may not be supplied
    // on this request"), so the page size is applied locally below - exactly like the Developer handler.
    const page = await webApi.getCatalog(storefront, '/albums/' + encodeURIComponent(id), { include: 'tracks' });
    if (!page.ok) {
      return { provider: 'apple', album: null, songs: [], total: 0, source: 'web', error: page.code, message: 'Apple Music Web 返回 HTTP ' + page.status + (userToken ? '' : '（未配置 media-user-token）') };
    }
    json = page.json || {};
  } catch (err) {
    const detail = appleErrorDetails(err);
    return Object.assign({ provider: 'apple', album: null, songs: [], total: 0 }, detail);
  }
  const entry = (Array.isArray(json.data) && json.data[0]) ? json.data[0] : null;
  const attributes = (entry && entry.attributes) || {};
  const tracksRel = (entry && entry.relationships && entry.relationships.tracks) || {};
  const items = Array.isArray(tracksRel.data) ? tracksRel.data : [];
  const artistName = normalizeText(attributes.artistName);
  const albumInfo = {
    provider: 'apple',
    id,
    albumId: id,
    name: normalizeText(attributes.name),
    artist: artistName,
    artists: artistName ? [{ id: '', name: artistName, uri: '' }] : [],
    cover: webApi.artworkUrl(attributes.artwork, 600),
    releaseDate: normalizeText(attributes.releaseDate || attributes.release_date),
    trackCount: Number(attributes.trackCount) || items.length,
    upc: normalizeText(attributes.upc),
    appleUrl: normalizeText(attributes.url),
    source: 'web',
  };
  const songs = items.slice(0, limit).map(function (track, index) {
    if (track && track.type && track.type !== 'songs') return null;
    const mapped = mapAppleTrack(track, index, 'album:' + id, { storefront, albumId: id, albumName: albumInfo.name });
    // Carry the EXPLICIT catalog identity, exactly like the playlist axis does for library tracks: this
    // axis is CATALOG-only (the caller supplied a catalog album id), so a track's own id IS its catalog
    // song id, and playParams.catalogId wins whenever Apple sends one. Nothing is decoded from an id form,
    // and no id is invented - without this the renderer could not hand an album row to Apple Music.
    if (mapped) {
      const pp = (track && track.attributes && track.attributes.playParams) || {};
      const explicit = (pp.catalogId !== undefined && pp.catalogId !== null && String(pp.catalogId) !== '')
        ? String(pp.catalogId)
        : String((track && track.id) || '');
      if (explicit) mapped.catalogId = explicit;
    }
    return mapped;
  }).filter(Boolean);
  return {
    provider: 'apple',
    album: albumInfo,
    songs,
    total: albumInfo.trackCount || songs.length,
    hasMore: !!tracksRel.next,
  };
}
// ---- Apple Music WEB path for library ALBUM tracks (album detail page) ------------------------------
// Reads /v1/me/library/albums/<libraryId>/tracks. This axis did NOT exist before: the library-albums
// payload carries no catalog id (playParams.catalogId is undefined for library albums - measured), so
// the catalog-only handleAppleAlbumDetailWeb cannot be used as the track source. Reads only.
//
// ID RULE (hard, unchanged): tracks keep the id the payload carries. Library songs are `i.*`; a catalog
// id is copied verbatim from attributes.playParams.catalogId and is never inferred from the id form.
// The library album id is passed through verbatim - it is the caller's selection identity.
async function handleAppleLibraryAlbumTracksWeb(albumId, opts) {
  opts = opts || {};
  const id = normalizeText(albumId);
  const limit = Math.max(1, Math.min(APPLE_LIBRARY_PAGE_LIMIT, Number(opts.limit) || 100));
  const startOffset = Math.max(0, Number(opts.offset) || 0);
  if (!id) {
    return { provider: 'apple', libraryAlbumId: '', songs: [], total: 0, offset: 0, limit, nextOffset: 0, hasMore: false, error: 'MISSING_ALBUM_ID', message: '' };
  }
  const userToken = webApi.getMediaUserToken();
  if (!userToken) {
    return { provider: 'apple', libraryAlbumId: id, songs: [], total: 0, offset: startOffset, limit, nextOffset: startOffset, hasMore: false, error: '', message: '需要先登录 Apple Music 网页账号（media-user-token 未配置）。' };
  }
  const storefront = DEFAULT_APPLE_STOREFRONT;
  let json = null;
  try {
    const page = await webApi.getLibrary('/albums/' + encodeURIComponent(id) + '/tracks', { limit, offset: startOffset });
    if (!page.ok) {
      return { provider: 'apple', libraryAlbumId: id, songs: [], total: 0, offset: startOffset, limit, nextOffset: startOffset, hasMore: false, source: 'web', error: page.code, message: 'Apple Music Web 返回 HTTP ' + page.status };
    }
    json = page.json || {};
  } catch (err) {
    const detail = appleErrorDetails(err);
    return Object.assign({ provider: 'apple', libraryAlbumId: id, songs: [], total: 0, offset: startOffset, limit, nextOffset: startOffset, hasMore: false }, detail);
  }
  const items = Array.isArray(json.data) ? json.data : [];
  const songs = items.map((item, index) => {
    const mapped = mapAppleTrack(item, startOffset + index, 'library-album:' + id, { storefront });
    if (!mapped) return null;
    const pp = (item && item.attributes && item.attributes.playParams) || {};
    if (pp.catalogId !== undefined && pp.catalogId !== null && String(pp.catalogId) !== '') mapped.catalogId = String(pp.catalogId);
    return mapped;
  }).filter(Boolean);
  const total = Math.max(songs.length + startOffset, Number(json.meta && json.meta.total) || (songs.length + startOffset));
  const nextOffset = startOffset + songs.length;
  return {
    provider: 'apple',
    libraryAlbumId: id,
    songs: songs,
    total: total,
    offset: startOffset,
    limit: limit,
    nextOffset: nextOffset,
    // Honest pagination: derived from what the payload actually carries, never fabricated.
    hasMore: !!json.next && nextOffset < total,
    source: 'web',
    error: '',
    message: '',
  };
}

// ---- 资料库索引：对外的薄适配 -------------------------------------------------
// 缓存/增量/校验都在 apple-music-library-cache.js；这里只把服务结果转成接口形态，
// 让 server.js 不必感知服务内部结构。

// 同步资料库索引（探测 + 按需全量对账），并返回索引状态。
async function syncLibraryIndex(opts) {
  const res = await libraryCache.sync(opts || {});
  return Object.assign({}, res, { cachePath: libraryCache.cachePath });
}

// 本地读取（不碰网络）：全部歌曲 / 全部专辑 / 单张专辑 / 按专辑名取候选歌曲。
function readLibrarySongs() { return libraryCache.getSongs(); }
function readLibraryAlbums() { return libraryCache.getAlbums(); }
function readLibraryAlbum(libraryAlbumId) { return libraryCache.getAlbumById(libraryAlbumId); }
function readSongsByAlbumName(albumName) { return libraryCache.getSongsByAlbumName(albumName); }
function libraryIndexState() { return libraryCache.getState(); }

// 专辑文案（简介/版权）：用「库内专辑 id -> catalog 专辑 id」映射取，只回文案不发曲目。
// 映射由重建时的成功校验写入，因此首次打开该专辑后即可用；之后一直命中本地记忆。
async function albumNotesFor(libraryAlbumId) {
  return enrichAlbumNotes(libraryAlbumId, (id) => libraryCache.getAlbumCatalog(id));
}

// 专辑曲目重建：从本地索引取候选，再走 Catalog 校验归属。
// 只返回资料库中真实保存、且通过身份校验的曲目。
// 艺人轴：按库里原始的完整艺人串归组（与 Apple 的呈现一致），
// 头像与 artist id 由缓存服务按需解析（首次完整请求、之后命中缓存）。
async function resolveLibraryArtists(groups) {
  return libraryCache.resolveArtistGroups(groups);
}

// 单个艺人的缓存详情（名称/流派/可信头像/解析状态）。只读缓存，不发请求。
function getArtistDetail(artistId) {
  return libraryCache.getArtistDetail(artistId);
}

// 艺人简介（Wikipedia）。按 artist ID 缓存，含失败记录。
function resolveArtistWiki(artistId, name) { return libraryCache.resolveArtistWiki(artistId, name); }
function resolveArtistWikiAsync(artistId, name) { return libraryCache.resolveArtistWikiAsync(artistId, name); }
function getArtistWiki(artistId) { return libraryCache.getArtistWiki(artistId); }
function getWikiDiag() { return libraryCache.getWikiDiag(); }
function getNeteaseAvatar(artistId) { return libraryCache.getNeteaseAvatar(artistId); }
function fetchNeteaseBioById(artistId) { return libraryCache.fetchNeteaseBioById(artistId); }
function warmNetease(entries, options) { return libraryCache.warmNetease(entries, options); }

async function rebuildAlbumTracks(libraryAlbum) {
  const songs = libraryCache.getSongs();
  const res = await reconstructAlbumTracks(libraryAlbum, songs);
  return Object.assign({}, res, {
    fromCache: true,
    cacheAgeMs: libraryCache.getState().ageMs,
    librarySongCount: songs.length,
  });
}

module.exports = {
  albumNotesFor,
  syncLibraryIndex,
  readLibrarySongs,
  readLibraryAlbums,
  readLibraryAlbum,
  readSongsByAlbumName,
  libraryIndexState,
  resolveLibraryArtists,
  getArtistDetail,
  resolveArtistWiki,
  resolveArtistWikiAsync,
  getArtistWiki,
  getWikiDiag,
  getNeteaseAvatar,
  fetchNeteaseBioById,
  warmNetease,
  rebuildAlbumTracks,
  handleAppleLibraryAlbumTracksWeb,
  ensureCredentialSource,
  handleAppleLibraryAlbums,
  handleAppleAccountStatusWeb,
  handleAppleUserPlaylistsWeb,
  handleApplePlaylistTracksWeb,
  handleApplePlaylistTracksAllWeb,
  APPLE_PLAYLIST_PAGE_LIMIT,
  handleAppleAlbumDetailWeb,
};