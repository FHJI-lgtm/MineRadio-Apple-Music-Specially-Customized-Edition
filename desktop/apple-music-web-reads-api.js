// ============================================================
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
      lastJson = json;
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
  const tracks = items.map((item, index) => mapAppleTrack(item, startOffset + index, id, { storefront })).filter(Boolean);
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
module.exports = {
  ensureCredentialSource,
  handleAppleUserPlaylistsWeb,
  handleApplePlaylistTracksWeb,
};