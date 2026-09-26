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

module.exports = {
  AMP_API,
  ERRORS,
  setCredentialSource,
  setReadOnly,
  getMediaUserToken,
  getBearer,
  request,
  getCatalog,
  getLibrary,
};
