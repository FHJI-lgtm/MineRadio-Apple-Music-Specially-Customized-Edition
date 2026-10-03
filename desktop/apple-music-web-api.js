// ============================================================
// Apple Music Web API (unofficial / implementation-dependent)
//
//   authentication : AMPWeb bearer  +  media-user-token
//   bearer source  : the Apple Music web player bundle (music.apple.com), iss = AMPWebPlay
//   user token     : injected through setCredentialSource(), exactly like apple-music-web-lyrics.js
//
// This channel is NOT a stable public API contract owned by this project: the bearer is scraped
// from Apple's web player bundle and may change with any Apple Music web release. Keep that in mind
// before building on it. Empirically verified (2026-09-26, read-only):
//   GET /v1/me/library/playlists  -> 200 with bearer + media-user-token
//   same call with bearer only    -> 403
//   same call with media-user-token only -> 401
//
// This module deliberately knows NOTHING about Apple Developer credentials (Team ID / Key ID / P8).
// It does not import safeStorage and does not implement any credential store.
// ============================================================

const https = require('https');

const AMP_API = 'https://amp-api.music.apple.com';
const WEB_ORIGIN = 'https://music.apple.com';

const ERRORS = {
  NO_BEARER: 'APPLE_WEB_NO_BEARER',
  NO_USER_TOKEN: 'APPLE_WEB_NO_USER_TOKEN',
  AUTH_BEARER: 'APPLE_WEB_AUTH_BEARER',          // 401: Authorization / AMPWeb bearer problem
  AUTH_USER_TOKEN: 'APPLE_WEB_AUTH_USER_TOKEN',  // 403: media-user-token / permission problem
  HTTP: 'APPLE_WEB_HTTP_ERROR',                  // anything else: status + Apple payload preserved
  NETWORK: 'APPLE_WEB_NETWORK_ERROR',
};

let credentialSource = null;
// Phase guard: when enabled, any non-GET request throws inside the module itself (so internal
// helpers cannot slip a write through either).
let readOnly = false;
function setReadOnly(flag) { readOnly = flag !== false; }

// Mirrors apple-music-web-lyrics.js#setCredentialSource: the producer (main process) injects a
// function returning the current media-user-token. This module never reads a store itself.
function setCredentialSource(fn) {
  credentialSource = typeof fn === 'function' ? fn : null;
}

function getMediaUserToken() {
  try {
    const value = credentialSource ? credentialSource() : '';
    return String(value == null ? '' : value).trim();
  } catch (_) {
    return '';
  }
}

// Bearer acquisition is delegated to the existing web-lyrics implementation on purpose:
// there must be exactly one AMPWebPlay scraper in this project.
async function getBearer(forceRefresh) {
  try {
    const webLyrics = require('../apple-music-web-lyrics');
    if (!webLyrics || typeof webLyrics.getWebPlayerBearer !== 'function') return '';
    // getWebPlayerBearer returns the bearer CACHE object ({ token, exp, storefront, bundleRef }).
    const res = await webLyrics.getWebPlayerBearer(!!forceRefresh);
    const token = res && typeof res === 'object' ? res.token : res;
    return String(token == null ? '' : token).trim();
  } catch (_) {
    return '';
  }
}

function requestText(url, headers, method, bodyText, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let req = null;
    try {
      req = https.request(url, { method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
          done({ status: res.statusCode || 0, headers: res.headers || {}, text, json });
        });
      });
    } catch (err) {
      return done({ status: 0, error: err });
    }
    req.setTimeout(Math.max(1000, Number(timeoutMs) || 15000), () => {
      try { req.destroy(new Error('timeout')); } catch (_) { }
    });
    req.on('error', (err) => done({ status: 0, error: err }));
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

// Read-only by contract for the current phase; the shape accepts a body for future write phases,
// but callers under scripts/ are expected to forbid non-GET explicitly.
async function request(pathname, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const method = String(opts.method || 'GET').toUpperCase();
  if (readOnly && method !== 'GET') throw new Error('APPLE_WEB_READ_ONLY: ' + method + ' blocked');
  const url = new URL(AMP_API + (pathname.charAt(0) === '/' ? pathname : '/' + pathname));
  const query = opts.query && typeof opts.query === 'object' ? opts.query : null;
  if (query) {
    Object.keys(query).forEach((key) => {
      const value = query[key];
      if (value == null || value === '') return;
      url.searchParams.set(key, String(value));
    });
  }

  const bearer = await getBearer();
  const userToken = opts.userToken != null ? String(opts.userToken).trim() : getMediaUserToken();
  const headers = {
    Accept: 'application/json',
    Origin: WEB_ORIGIN,
    Referer: WEB_ORIGIN + '/',
  };
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  if (userToken && opts.withUserToken !== false) headers['Music-User-Token'] = userToken;

  let bodyText = '';
  if (opts.body != null) {
    try { bodyText = JSON.stringify(opts.body); headers['Content-Type'] = 'application/json'; } catch (_) { bodyText = ''; }
  }

  const res = await requestText(url.toString(), headers, method, bodyText, opts.timeoutMs);
  const base = { status: res.status || 0, method, path: url.pathname + (url.search || ''), hasBearer: !!bearer, hasUserToken: !!userToken };
  if (!res.status) return { ok: false, ...base, code: ERRORS.NETWORK, message: (res.error && res.error.message) || 'network error' };
  if (res.status >= 200 && res.status < 300) return { ok: true, ...base, json: res.json, body: res.text };
  if (res.status === 401) return { ok: false, ...base, code: ERRORS.AUTH_BEARER, errors: (res.json && res.json.errors) || null, body: res.text };
  if (res.status === 403) return { ok: false, ...base, code: ERRORS.AUTH_USER_TOKEN, errors: (res.json && res.json.errors) || null, body: res.text };
  return { ok: false, ...base, code: ERRORS.HTTP, errors: (res.json && res.json.errors) || null, body: res.text };
}

function getCatalog(storefront, pathname, query, options) {
  const sf = String(storefront || 'us').toLowerCase();
  const p = pathname.charAt(0) === '/' ? pathname : '/' + pathname;
  return request('/v1/catalog/' + sf + p, Object.assign({}, options || {}, { query, withUserToken: false }));
}

function getLibrary(pathname, query, options) {
  const p = pathname.charAt(0) === '/' ? pathname : '/' + pathname;
  return request('/v1/me/library' + p, Object.assign({}, options || {}, { query, withUserToken: true }));
}

// ------------------------------------------------------------
// P0 - Web capability completion: library album mapper.
//
// This is NOT a Developer-retirement step: it only consumes the /v1/me/library/albums payload and
// has no relationship to Developer credentials or the developer JWT.
//
// canonical shape mirrors the album object built by the legacy handleAppleAlbumDetail
// (provider/id/name/artist/artists/cover/releaseDate/trackCount/upc/appleUrl), plus the
// library-only facts (libraryId, dateAdded, genreNames, playParams).
//
// HARD CONSTRAINT: library ID != catalog ID. catalogId is copied verbatim from
// attributes.playParams.catalogId and is NEVER inferred; when the payload has none it stays
// undefined. `id`/`albumId` are the LIBRARY id, so both identities remain distinguishable.
// ------------------------------------------------------------
// Web player bearer 里带着**实际生效的 storefront**（来自 music.apple.com 的 geo 重定向）。
// 这是唯一权威来源：既不要写死，也不要把"用来查数据的 storefront"当成艺人身份的一部分。
// 取不到时返回空串，由调用方决定降级（项目已有 CATALOG_LOOKUP_STOREFRONTS 链）。
async function getWebPlayerStorefront(forceRefresh) {
  try {
    const webLyrics = require('../apple-music-web-lyrics');
    if (!webLyrics || typeof webLyrics.getWebPlayerBearer !== 'function') return '';
    const res = await webLyrics.getWebPlayerBearer(!!forceRefresh);
    const sf = res && typeof res === 'object' ? res.storefront : '';
    return String(sf == null ? '' : sf).trim().toLowerCase();
  } catch (_) {
    return '';
  }
}

// ------------------------------------------------------------
// 艺人代表图像判据（只读，纯函数）
//
// 要区分的是「艺人代表图像」与「作品封面」，不是「真人照片」与「非真人照片」——
// 所以官方插画（例如企划形象的二次元立绘）**允许**作为代表图像。
//
// 实测依据（docs/assets/artist-image-sample/contact-sheet.png，15 张抽样）：
//   Features*/mzl.*                     -> 5/5 真人肖像
//   AMCArtistImages* + ami-identity     -> 官方形象（含插画），合格
//   cover.jpg / *_cover.*               -> 作品封面
//   Music*/pr_source.png                -> 纯文字 Logo（**不是**肖像）
//   Music*/<编号>.jpg (COCX-37647 等)    -> 作品封面
//   Music*/cover.jpg                    -> 作品封面
// 所以 Music* 一律不作为头像（首版），宁可降级到首字母占位。
// ------------------------------------------------------------
const ARTIST_IMAGE_RULES = {
  // 高置信：Features 资源下的 mzl.* 命名
  FEATURES_MZL: 'features-mzl',
  // 高置信：AMCArtistImages 且带 ami-identity 指纹
  AMC_IDENTITY: 'amc-identity',
};

function classifyArtistArtwork(artwork) {
  const url = String((artwork && artwork.url) || '');
  if (!url) return { kind: 'none', reason: 'no-artwork' };
  // 只看资源路径与文件名，不解析 id
  const tail = url.replace(/^https?:\/\/[^/]+\/image\/thumb\//, '');
  const parts = tail.split('/');
  const bucket = parts[0] || '';
  const file = parts[parts.length - 2] || '';
  if (/^Features\d+$/i.test(bucket) && /^mzl\./i.test(file)) {
    return { kind: 'artist', rule: ARTIST_IMAGE_RULES.FEATURES_MZL, bucket: bucket };
  }
  if (/^AMCArtistImages\d+$/i.test(bucket) && /ami-identity/i.test(file)) {
    return { kind: 'artist', rule: ARTIST_IMAGE_RULES.AMC_IDENTITY, bucket: bucket };
  }
  if (/^AMCArtistImages\d+$/i.test(bucket)) {
    // 是艺人图库资源但缺 ami-identity 指纹 —— 首版保守不采用
    return { kind: 'unsure', rule: 'amc-no-identity', bucket: bucket };
  }
  if (/^Features\d+$/i.test(bucket)) {
    // Features 下但不是 mzl.* —— 首版保守不采用
    return { kind: 'unsure', rule: 'features-not-mzl', bucket: bucket };
  }
  if (/^Music\d+$/i.test(bucket)) {
    // 实测这里混着作品封面与纯文字 Logo，一律降级
    return { kind: 'release-artwork', rule: 'music-bucket', bucket: bucket };
  }
  return { kind: 'unsure', rule: 'unknown-bucket', bucket: bucket };
}

function artworkUrl(artwork, size) {
  if (!artwork || typeof artwork !== 'object') return '';
  const url = String(artwork.url || '').trim();
  if (!url) return '';
  const px = String(Math.max(1, parseInt(size, 10) || 600));
  return url.replace(/\{w\}/g, px).replace(/\{h\}/g, px);
}

function mapLibraryAlbum(item) {
  const attributes = (item && item.attributes) || {};
  const playParams = (attributes.playParams && typeof attributes.playParams === 'object') ? attributes.playParams : {};
  const libraryId = String((item && item.id) || '').trim();
  const artist = String(attributes.artistName == null ? '' : attributes.artistName).trim();
  return {
    provider: 'apple',
    id: libraryId,
    libraryId,
    catalogId: playParams.catalogId,
    albumId: libraryId,
    name: String(attributes.name == null ? '' : attributes.name).trim(),
    artist,
    artists: artist ? [{ id: '', name: artist, uri: '' }] : [],
    cover: artworkUrl(attributes.artwork, 600),
    releaseDate: String(attributes.releaseDate == null ? '' : attributes.releaseDate).trim(),
    trackCount: Number(attributes.trackCount) || 0,
    dateAdded: String(attributes.dateAdded == null ? '' : attributes.dateAdded).trim(),
    genreNames: Array.isArray(attributes.genreNames) ? attributes.genreNames.slice() : [],
    playParams,
    upc: '',
    appleUrl: '',
  };
}
module.exports = {
  AMP_API,
  ERRORS,
  setCredentialSource,
  setReadOnly,
  getMediaUserToken,
  getBearer,
  getWebPlayerStorefront,
  classifyArtistArtwork,
  ARTIST_IMAGE_RULES,
  request,
  getCatalog,
  getLibrary,
  mapLibraryAlbum,
  artworkUrl,
};
