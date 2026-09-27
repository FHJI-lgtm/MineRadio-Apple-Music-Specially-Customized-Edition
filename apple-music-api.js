'use strict';

// ============================================================
// Apple Music API bridge for Mineradio (Apple Music edition).
//
// Mirrors the Spotify integration contract so the renderer can
// treat Apple Music like any other provider:
//   - developer token  : ES256 JWT signed with the user's MusicKit
//                        private key (Team ID + Key ID + P8 private key)
//   - music user token : obtained from the Apple Music web app after the
//                        user signs in (media-user-token), or pasted
//                        manually by the user
//   - catalog search / album / playlist  : developer token only
//   - user library / playlists / likes   : developer token + user token
//
// Apple Music does not expose DRM-free full-track streaming URLs to
// third-party apps, so like Spotify this provider is metadata-first:
// playback falls back to automatically matched sources from other
// platforms (playbackMode: 'recommend-match').
// ============================================================

const fs = require('fs');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
// 第三阶段: Apple Music Web 私有歌词 provider (Bearer + media-user-token)。
// 只读、不落盘; 未配置凭证或调用失败时, 下面的本地 TTML 缓存路径完全不变。
const webLyrics = require('./apple-music-web-lyrics');
const appleMusicLyricsApi = require('./desktop/apple-music-lyrics-api');
appleMusicLyricsApi.setTextNormalizer(normalizeText);   // reuse, never copy, the existing normalizer

const APPLE_API_BASE = (process.env.MINERADIO_APPLE_API_BASE || 'https://api.music.apple.com').replace(/\/+$/, '');
// amp-api.music.apple.com accepts the same developer + media-user tokens
// and is the host used by the Apple Music web player; advanced users can
// switch to it if the official host rejects their token.
const DEFAULT_APPLE_CONFIG_FILE = path.join(__dirname, '.apple-music-credentials.json');
const DEFAULT_APPLE_TOKEN_FILE = path.join(__dirname, '.apple-music-token.json');
const DEFAULT_APPLE_STOREFRONT = 'us';
const DEFAULT_APPLE_REDIRECT_URI = 'http://127.0.0.1:3000/apple-music-callback.html';
// Apple recommends short-lived developer tokens (5 minutes is a safe window).
const APPLE_DEV_TOKEN_TTL_MS = 4.5 * 60 * 1000;
const APPLE_SEARCH_LIMIT_MAX = 25;
const APPLE_USER_AGENT = 'Mineradio/2.1.0 (Apple Music API bridge)';
const APPLE_LIKED_PLAYLIST_ID = 'apple-liked';
const APPLE_TRANSIENT_RETRY_DELAYS_MS = [320, 900];

let appleDevTokenCache = { token: '', expiresAt: 0 };
const appleSearchCache = new Map();
const appleSearchInflight = new Map();

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function firstEnv(keys) {
  for (const key of keys) {
    const value = normalizeText(process.env[key]);
    if (value) return value;
  }
  return '';
}

function uniqueList(items) {
  const out = [];
  const seen = new Set();
  (Array.isArray(items) ? items : []).forEach((item) => {
    item = normalizeText(item);
    if (!item || seen.has(item)) return;
    seen.add(item);
    out.push(item);
  });
  return out;
}

// ------------------------------------------------------------
// Credentials file (.apple-music-credentials.json)
// ------------------------------------------------------------
function appleConfigFileCandidates() {
  const candidates = [];
  function add(value) {
    value = normalizeText(value);
    if (!value) return;
    const resolved = path.resolve(value);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  }
  add(firstEnv(['APPLE_MUSIC_CONFIG_FILE', 'MINERADIO_APPLE_CONFIG_FILE']));
  add(DEFAULT_APPLE_CONFIG_FILE);
  add(path.join(__dirname, 'apple-music-credentials.json'));
  return candidates;
}

function normalizeApplePrivateKey(value) {
  value = String(value == null ? '' : value);
  if (!value.trim()) return '';
  // Users often paste the .p8 file content through a text input, which may
  // escape newlines as literal \n sequences. Never collapse whitespace here:
  // the PEM newlines are significant.
  value = value.replace(/\\n/g, '\n').replace(/\\r/g, '');
  const trimmed = value.trim();
  if (/^-----BEGIN/.test(trimmed)) return trimmed;
  // Accept a path to the .p8 file as an alternative.
  try {
    if (fs.existsSync(trimmed)) {
      const raw = fs.readFileSync(trimmed, 'utf8');
      const normalized = raw.replace(/\\n/g, '\n').trim();
      if (/^-----BEGIN/.test(normalized)) return normalized;
    }
  } catch (_) { }
  return trimmed;
}

function normalizeAppleFileConfig(raw, file) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const apple = raw.apple && typeof raw.apple === 'object' ? raw.apple : raw;
  const music = apple.appleMusic && typeof apple.appleMusic === 'object' ? apple.appleMusic : apple;
  return {
    teamId: normalizeText(music.teamId || music.team_id || music.iss || music.appleTeamId || music.apple_team_id),
    keyId: normalizeText(music.keyId || music.key_id || music.kid || music.appleKeyId || music.apple_key_id),
    privateKey: normalizeApplePrivateKey(music.privateKey || music.private_key || music.p8 || music.key || music.applePrivateKey || music.apple_private_key),
    musicId: normalizeText(music.musicId || music.music_id || music.clientId || music.client_id || music.musickitId || music.musickit_id),
    storefront: normalizeText(music.storefront || music.country || music.market || ''),
    redirectUri: normalizeText(music.redirectUri || music.redirect_uri || music.callbackUrl || music.callback_url || ''),
    file,
    source: file ? 'file' : '',
  };
}

function readAppleFileConfig() {
  const candidates = appleConfigFileCandidates();
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const config = normalizeAppleFileConfig(parsed, file);
      if (config.teamId || config.keyId || config.privateKey || config.musicId || config.storefront || config.redirectUri) return config;
    } catch (err) {
      console.warn('[AppleMusicConfig] ignored invalid config file:', file, err.message);
    }
  }
  return normalizeAppleFileConfig(null, '');
}

function getAppleCredentials() {
  const fileConfig = readAppleFileConfig();
  const envTeamId = firstEnv(['APPLE_MUSIC_TEAM_ID', 'MINERADIO_APPLE_TEAM_ID']);
  const envKeyId = firstEnv(['APPLE_MUSIC_KEY_ID', 'MINERADIO_APPLE_KEY_ID']);
  // The private key must NOT go through normalizeText/firstEnv: collapsing
  // whitespace would destroy the PEM newlines. Read the raw env value and
  // let normalizeApplePrivateKey handle \n escapes and trimming.
  const envPrivateKey = (function () {
    for (const key of ['APPLE_MUSIC_PRIVATE_KEY', 'MINERADIO_APPLE_PRIVATE_KEY', 'APPLE_MUSIC_P8', 'MINERADIO_APPLE_P8']) {
      const value = process.env[key];
      if (value != null && String(value).trim()) return String(value);
    }
    return '';
  })();
  const envMusicId = firstEnv(['APPLE_MUSIC_ID', 'MINERADIO_APPLE_MUSIC_ID', 'APPLE_MUSIC_CLIENT_ID', 'MINERADIO_APPLE_CLIENT_ID']);
  const envStorefront = firstEnv(['APPLE_MUSIC_STOREFRONT', 'MINERADIO_APPLE_STOREFRONT', 'APPLE_STOREFRONT']);
  const envRedirectUri = firstEnv(['APPLE_MUSIC_REDIRECT_URI', 'MINERADIO_APPLE_REDIRECT_URI']);
  const teamId = envTeamId || fileConfig.teamId;
  const keyId = envKeyId || fileConfig.keyId;
  const privateKey = envPrivateKey ? normalizeApplePrivateKey(envPrivateKey) : fileConfig.privateKey;
  const musicId = envMusicId || fileConfig.musicId;
  const storefront = (envStorefront || fileConfig.storefront || DEFAULT_APPLE_STOREFRONT).toLowerCase();
  const redirectUri = envRedirectUri || fileConfig.redirectUri || DEFAULT_APPLE_REDIRECT_URI;
  const missing = [];
  if (!teamId) missing.push('APPLE_MUSIC_TEAM_ID');
  if (!keyId) missing.push('APPLE_MUSIC_KEY_ID');
  if (!privateKey) missing.push('APPLE_MUSIC_PRIVATE_KEY');
  return {
    provider: 'apple',
    configured: missing.length === 0,
    teamId,
    keyId,
    privateKey,
    musicId,
    storefront,
    redirectUri,
    credentialsFile: fileConfig.file,
    configSource: envTeamId || envKeyId || envPrivateKey || envMusicId || envStorefront ? 'env' : (fileConfig.source || ''),
    missing,
  };
}

// ------------------------------------------------------------
// Music user token file (.apple-music-token.json)
// ------------------------------------------------------------
function getAppleTokenFile() {
  return process.env.APPLE_MUSIC_TOKEN_FILE || process.env.MINERADIO_APPLE_TOKEN_FILE || DEFAULT_APPLE_TOKEN_FILE;
}

function readStoredAppleToken() {
  const file = getAppleTokenFile();
  try {
    if (!file || !fs.existsSync(file)) return { file, musicUserToken: '', storefront: '', authorizedAt: 0 };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return {
      file,
      musicUserToken: normalizeText(raw.musicUserToken || raw.music_user_token || raw.mediaUserToken || raw.media_user_token || raw.userToken || raw.user_token),
      storefront: normalizeText(raw.storefront || raw.country || ''),
      nickname: normalizeText(raw.nickname || raw.name || ''),
      userId: normalizeText(raw.userId || raw.user_id || ''),
      authorizedAt: Number(raw.authorizedAt || raw.authorized_at || 0) || 0,
    };
  } catch (err) {
    console.warn('[AppleMusicToken] ignored invalid token file:', file, err.message);
    return { file, musicUserToken: '', storefront: '', authorizedAt: 0, invalid: true };
  }
}

function clearAppleToken() {
  try {
    const file = getAppleTokenFile();
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err) {
    console.warn('[AppleMusicToken] clear skipped:', err.message);
  }
  return { ok: true, provider: 'apple', loggedIn: false };
}

// ------------------------------------------------------------
// Developer token (ES256 JWT)
// ------------------------------------------------------------
function base64url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function signAppleDeveloperJwt(config) {
  const header = { alg: 'ES256', kid: config.keyId };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: config.teamId, iat: now, exp: now + 300 };
  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));
  const signature = crypto.sign(null, Buffer.from(signingInput, 'utf8'), {
    key: config.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return signingInput + '.' + base64url(signature);
}

async function getAppleDeveloperToken() {
  const now = Date.now();
  if (appleDevTokenCache.token && now < appleDevTokenCache.expiresAt) return appleDevTokenCache.token;
  const config = getAppleCredentials();
  if (!config.configured) {
    const err = new Error('APPLE_MUSIC_CREDENTIALS_REQUIRED');
    err.code = 'APPLE_MUSIC_CREDENTIALS_REQUIRED';
    err.missing = config.missing;
    throw err;
  }
  const token = signAppleDeveloperJwt(config);
  appleDevTokenCache = { token, expiresAt: now + APPLE_DEV_TOKEN_TTL_MS };
  return token;
}

// ------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------
function appleRequestText(targetUrl, opts, body) {
  opts = opts || {};
  const timeoutMs = Number(opts.timeoutMs) || 10000;
  const method = opts.method || (body == null ? 'GET' : 'POST');
  const headers = Object.assign({ 'User-Agent': APPLE_USER_AGENT }, opts.headers || {});
  return new Promise((resolve, reject) => {
    const req = https.request(targetUrl, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(text);
          return;
        }
        const err = new Error('APPLE_HTTP_' + res.statusCode);
        err.statusCode = res.statusCode;
        err.body = text;
        err.retryAfter = res.headers && res.headers['retry-after'];
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('APPLE_REQUEST_TIMEOUT')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function appleRequestJson(targetUrl, opts, body) {
  const text = await appleRequestText(targetUrl, opts, body);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    err.message = 'APPLE_JSON_PARSE_FAILED: ' + err.message;
    throw err;
  }
}

function appleErrorDetails(err) {
  err = err || {};
  let apiMessage = '';
  let apiStatus = '';
  try {
    const body = err.body ? JSON.parse(String(err.body)) : null;
    if (body && body.errors && Array.isArray(body.errors) && body.errors[0]) {
      apiMessage = body.errors[0].detail || body.errors[0].title || body.errors[0].code || '';
      apiStatus = body.errors[0].status || '';
    } else if (body && typeof body.error === 'string') {
      apiMessage = body.error_description || body.error;
    }
  } catch (parseErr) { }
  const statusCode = Number(err.statusCode || apiStatus || 0) || 0;
  const code = normalizeText(err.code || (statusCode ? ('APPLE_HTTP_' + statusCode) : err.message)) || 'APPLE_ERROR';
  let message = apiMessage || normalizeText(err.message) || 'Apple Music 请求失败';
  if (statusCode === 401) {
    message = 'Apple Music 登录态或开发者凭据已失效，请重新连接 Apple Music。';
  } else if (statusCode === 403) {
    message = 'Apple Music 授权权限不足，请检查开发者凭据后重新连接。';
  } else if (statusCode === 404) {
    message = 'Apple Music 没有找到这个项目，可能已下架、未公开或当前地区不可用。';
  } else if (statusCode === 429) {
    message = 'Apple Music 请求过于频繁，请稍后再试。';
  } else if (statusCode === 500 || statusCode === 502 || statusCode === 503) {
    message = 'Apple Music 服务暂时不可用，请稍后再试。';
  }
  return {
    error: code,
    message,
    statusCode,
    appleApiMessage: apiMessage,
    retryAfterSeconds: Math.max(0, Math.ceil(Number(err.retryAfterMs || 0) / 1000)),
    reauthRequired: statusCode === 401,
  };
}

function appleDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function appleTransientError(err) {
  const status = Number(err && err.statusCode || 0);
  return status === 500 || status === 502 || status === 503 ||
    /APPLE_REQUEST_TIMEOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ETIMEDOUT/i.test(String(err && (err.code || err.message) || ''));
}

function appleUrl(base, pathname, params) {
  const cleanPath = String(pathname || '').replace(/^\/+/, '');
  const url = new URL(cleanPath, String(base || APPLE_API_BASE) + '/');
  Object.keys(params || {}).forEach((key) => {
    const value = params[key];
    if (value == null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

async function appleApiHeaders(opts) {
  opts = opts || {};
  const devToken = await getAppleDeveloperToken();
  const headers = {
    Authorization: 'Bearer ' + devToken,
    Accept: 'application/json',
  };
  const userToken = normalizeText(opts.userToken);
  if (userToken) headers['Music-User-Token'] = userToken;
// Developer-only Origin override removed with the Developer axis.

  return headers;
}

async function appleGet(pathname, params, opts) {
  opts = opts || {};
  const base = opts.base || APPLE_API_BASE;
  let devRetried = false;
  let transientAttempt = 0;
  while (true) {
    try {
      return await appleRequestJson(appleUrl(base, pathname, params || {}), {
        timeoutMs: opts.timeoutMs || 9000,
        headers: await appleApiHeaders(opts),
      });
    } catch (err) {
      const status = Number(err && err.statusCode || 0);
      if (status === 401 && !devRetried) {
        // The developer token may have expired; regenerate it once.
        devRetried = true;
        appleDevTokenCache = { token: '', expiresAt: 0 };
        continue;
      }
      if (status === 429 && opts.noRetry) throw err;
      if (!opts.noRetry && transientAttempt < APPLE_TRANSIENT_RETRY_DELAYS_MS.length && (appleTransientError(err) || status === 429)) {
        const waitMs = APPLE_TRANSIENT_RETRY_DELAYS_MS[transientAttempt] + Math.floor(Math.random() * 120);
        transientAttempt += 1;
        await appleDelay(waitMs);
        continue;
      }
      throw err;
    }
  }
}

async function appleSend(method, pathname, params, payload, opts) {
  opts = opts || {};
  const base = opts.base || APPLE_API_BASE;
  const body = payload == null ? null : JSON.stringify(payload);
  let devRetried = false;
  let transientAttempt = 0;
  while (true) {
    try {
      return await appleRequestJson(appleUrl(base, pathname, params || {}), {
        method,
        timeoutMs: opts.timeoutMs || 9000,
        headers: Object.assign(await appleApiHeaders(opts), body == null ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        }),
      }, body);
    } catch (err) {
      const status = Number(err && err.statusCode || 0);
      if (status === 401 && !devRetried) {
        devRetried = true;
        appleDevTokenCache = { token: '', expiresAt: 0 };
        continue;
      }
      if (status === 429 && opts.noRetry) throw err;
      if (!opts.noRetry && transientAttempt < APPLE_TRANSIENT_RETRY_DELAYS_MS.length && (appleTransientError(err) || status === 429)) {
        const waitMs = APPLE_TRANSIENT_RETRY_DELAYS_MS[transientAttempt] + Math.floor(Math.random() * 120);
        transientAttempt += 1;
        await appleDelay(waitMs);
        continue;
      }
      throw err;
    }
  }
}

function requireAppleUserToken() {
  const token = readStoredAppleToken();
  if (!token.musicUserToken) {
    const err = new Error('APPLE_MUSIC_LOGIN_REQUIRED');
    err.code = 'APPLE_MUSIC_LOGIN_REQUIRED';
    err.statusCode = 401;
    err.reauthRequired = true;
    throw err;
  }
  return token;
}

// ------------------------------------------------------------
// Mapping helpers
// ------------------------------------------------------------
function appleArtworkUrl(artwork, size) {
  artwork = artwork || {};
  if (!artwork.url) return '';
  const s = Math.max(60, Number(size) || 600) || 600;
  return String(artwork.url).replace('{w}', String(s)).replace('{h}', String(s));
}

function appleArtistList(attributes) {
  attributes = attributes || {};
  const raw = Array.isArray(attributes.artistName) ? attributes.artistName : [];
  const names = [];
  raw.forEach((item) => {
    const name = normalizeText(item && (typeof item === 'string' ? item : item.attributes && item.attributes.name));
    if (name && !names.includes(name)) names.push(name);
  });
  if (!names.length && normalizeText(attributes.artistName)) names.push(normalizeText(attributes.artistName));
  return names;
}

function mapAppleTrack(data, index, query, context) {
  data = data || {};
  const id = normalizeText(data.id);
  const attributes = data.attributes || {};
  const name = normalizeText(attributes.name);
  if (!id || !name) return null;
  const artists = appleArtistList(attributes).map(name => ({ id: '', name, mid: '', uri: '' }));
  const artistText = artists.map(artist => artist.name).join(' / ');
  const previews = Array.isArray(attributes.previews) ? attributes.previews.filter(item => item && item.url) : [];
  const durationMs = Number(attributes.durationInMillis) || Number(attributes.duration_in_millis) || 0;
  const playParams = attributes.playParams && typeof attributes.playParams === 'object' ? attributes.playParams : {};
  const albumId = normalizeText(context && context.albumId) || normalizeText(playParams.id);
  const catalogUrl = normalizeText(attributes.url);
  return {
    provider: 'apple',
    source: 'apple',
    type: 'apple',
    id,
    providerSongId: id,
    appleId: id,
    appleUrl: catalogUrl,
    isrc: normalizeText(attributes.isrc),
    name,
    artist: artistText,
    artists,
    album: normalizeText(attributes.albumName) || normalizeText(context && context.albumName) || '',
    albumId,
    albumName: normalizeText(attributes.albumName) || normalizeText(context && context.albumName) || '',
    cover: appleArtworkUrl(attributes.artwork, 600),
    duration: Math.max(0, Math.round(durationMs / 1000)),
    durationMs,
    popularity: 0,
    explicit: normalizeText(attributes.contentRating) === 'explicit',
    trackNumber: Number(attributes.trackNumber) || 0,
    genre: Array.isArray(attributes.genreNames) && attributes.genreNames[0] ? String(attributes.genreNames[0]) : '',
    fee: 0,
    playable: false,
    playbackMode: 'recommend-match',
    recommendationSource: 'apple-music-api',
    storefront: normalizeText(context && context.storefront) || '',
    appleRank: index,
    appleQuery: query || '',
    previewUrl: previews.length ? previews[0].url : '',
    restriction: {
      category: 'provider_limited',
      reason: 'apple_metadata_only',
      message: 'Apple Music 官方 API 不提供可交给 Mineradio 播放的无 DRM 音频直链，播放会自动寻找其它可播版本。',
      action: 'switch_source',
    },
  };
}

// ------------------------------------------------------------
// Handlers (mirror the Spotify provider contract)
// ------------------------------------------------------------

function mapAppleLibraryPlaylist(item) {
  item = item || {};
  const id = normalizeText(item.id);
  if (!id) return null;
  const attributes = item.attributes || {};
  const playParams = attributes.playParams && typeof attributes.playParams === 'object' ? attributes.playParams : {};
  return {
    provider: 'apple',
    source: 'apple',
    id,
    name: normalizeText(attributes.name || 'Apple Music 歌单'),
    cover: appleArtworkUrl(attributes.artwork, 300),
    creator: 'Apple Music',
    trackCount: 0,
    playCount: 0,
    subscribed: false,
    shelfPane: 'mine',
    public: attributes.isPublic === true,
    appleUrl: normalizeText(attributes.url),
    applePlayParamsId: normalizeText(playParams.id),
  };
}

// ------------------------------------------------------------
// Library (liked songs / albums)
// ------------------------------------------------------------
function appleIsrcPattern() {
  // ISRC: 2 letters country + 3 alphanumeric registrant + 2 digit year + 5 alphanumeric
  return /^[A-Z]{2}[A-Z0-9]{3}\d{2}[A-Z0-9]{5}$/i;
}

function appleIdentityValues(value, type) {
  type = normalizeText(type || 'track').toLowerCase();
  if (typeof value === 'string') {
    const text = normalizeText(value);
    if (!text) return [];
    const out = [];
    if (type !== 'album' && appleIsrcPattern().test(text)) out.push(text);
    out.push(text);
    return out;
  }
  value = value && typeof value === 'object' ? value : {};
  const raw = [];
  if (type === 'album') {
    raw.push(value.upc, value.albumUPC, value.appleAlbumUPC);
  } else {
    raw.push(value.isrc, value.appleIsrc);
  }
  raw.push(value.appleId, value.providerSongId, value.albumId, value.id);
  const seen = Object.create(null);
  return raw.map(item => normalizeText(item)).filter(item => {
    if (!item || seen[item]) return false;
    seen[item] = true;
    return true;
  });
}

async function resolveAppleCatalogIdsToIsrc(ids, storefront) {
  const uniqueIds = uniqueList(ids).slice(0, 40);
  if (!uniqueIds.length) return {};
  const json = await appleGet('/v1/catalog/' + encodeURIComponent(storefront) + '/songs', {
    ids: uniqueIds.join(','),
  }, { timeoutMs: 9000 });
  const result = {};
  (Array.isArray(json && json.data) ? json.data : []).forEach((item) => {
    const attributes = item.attributes || {};
    result[normalizeText(item.id)] = normalizeText(attributes.isrc);
  });
  return result;
}

async function resolveAppleCatalogAlbumsToUpc(ids, storefront) {
  const uniqueIds = uniqueList(ids).slice(0, 20);
  if (!uniqueIds.length) return {};
  const json = await appleGet('/v1/catalog/' + encodeURIComponent(storefront) + '/albums', {
    ids: uniqueIds.join(','),
  }, { timeoutMs: 9000 });
  const result = {};
  (Array.isArray(json && json.data) ? json.data : []).forEach((item) => {
    const attributes = item.attributes || {};
    result[normalizeText(item.id)] = normalizeText(attributes.upc);
  });
  return result;
}

async function handleAppleLibraryCheck(type, values) {
  const token = requireAppleUserToken();
  const raw = Array.isArray(values) ? values : String(values == null ? '' : values).split(',');
  type = normalizeText(type || 'track').toLowerCase();
  const storefront = readStoredAppleToken().storefront || getAppleCredentials().storefront || DEFAULT_APPLE_STOREFRONT;

  const pairs = raw.map(value => {
    const object = value && typeof value === 'object' ? value : {};
    const identities = appleIdentityValues(object, type);
    const stringIsrc = typeof value === 'string' && type !== 'album' && appleIsrcPattern().test(normalizeText(value)) ? normalizeText(value) : '';
    return {
      key: normalizeText(object && (object.appleId || object.providerSongId || object.id)) || normalizeText(value && typeof value === 'object' ? value.id : value),
      isrc: stringIsrc || normalizeText(object && (object.isrc || object.appleIsrc)),
      upc: normalizeText(object && (object.upc || object.albumUPC || object.appleAlbumUPC)),
      ids: identities,
    };
  }).filter(item => item.key && item.ids.length).slice(0, 40);

  if (!pairs.length) return { provider: 'apple', ids: [], liked: {} };

  let lookupIsrc = {};
  let lookupUpc = {};
  if (type === 'album') {
    const catalogIds = pairs.map(item => item.ids[0]).filter(id => id);
    lookupUpc = await resolveAppleCatalogAlbumsToUpc(catalogIds, storefront).catch(() => ({}));
  } else {
    const catalogIds = pairs.map(item => item.ids[0]).filter(id => id);
    lookupIsrc = await resolveAppleCatalogIdsToIsrc(catalogIds, storefront).catch(() => ({}));
  }

  const isrcs = uniqueList(pairs.map(item => item.isrc || lookupIsrc[item.ids[0]]).filter(Boolean));
  const upcs = uniqueList(pairs.map(item => item.upc || lookupUpc[item.ids[0]]).filter(Boolean));

  const liked = {};
  pairs.forEach((item) => { liked[item.key] = false; });

  try {
    if (type === 'album') {
      if (upcs.length) {
        const json = await appleGet('/v1/me/library/albums', {
          'filter[upc]': upcs.join(','),
          limit: 100,
        }, { timeoutMs: 9000, userToken: token.musicUserToken });
        const found = new Set((Array.isArray(json && json.data) ? json.data : []).map(entry => normalizeText(entry.attributes && entry.attributes.upc)));
        pairs.forEach((item) => {
          const upc = item.upc || lookupUpc[item.ids[0]];
          if (upc && found.has(upc)) liked[item.key] = true;
        });
      }
    } else {
      if (isrcs.length) {
        const json = await appleGet('/v1/me/library/songs', {
          'filter[isrc]': isrcs.join(','),
          limit: 100,
        }, { timeoutMs: 9000, userToken: token.musicUserToken });
        const found = new Set((Array.isArray(json && json.data) ? json.data : []).map(entry => normalizeText(entry.attributes && entry.attributes.isrc)));
        pairs.forEach((item) => {
          const isrc = item.isrc || lookupIsrc[item.ids[0]];
          if (isrc && found.has(isrc)) liked[item.key] = true;
        });
      }
    }
  } catch (err) {
    const detail = appleErrorDetails(err);
    if (detail.statusCode === 401) throw err;
    return {
      provider: 'apple',
      ids: pairs.map(item => item.key),
      liked,
      error: detail.error,
      message: detail.message,
    };
  }

  return {
    provider: 'apple',
    loggedIn: true,
    ids: pairs.map(item => item.key),
    liked,
  };
}

async function findAppleLibrarySongIdByIsrc(isrc, userToken) {
  if (!isrc) return '';
  const json = await appleGet('/v1/me/library/songs', {
    'filter[isrc]': isrc,
    limit: 1,
  }, { timeoutMs: 9000, userToken });
  const items = Array.isArray(json && json.data) ? json.data : [];
  return items.length ? normalizeText(items[0].id) : '';
}

async function findAppleLibraryAlbumIdByUpc(upc, userToken) {
  if (!upc) return '';
  const json = await appleGet('/v1/me/library/albums', {
    'filter[upc]': upc,
    limit: 1,
  }, { timeoutMs: 9000, userToken });
  const items = Array.isArray(json && json.data) ? json.data : [];
  return items.length ? normalizeText(items[0].id) : '';
}

async function handleAppleLibrarySet(type, value, saved) {
  const token = requireAppleUserToken();
  type = normalizeText(type || 'track').toLowerCase();
  value = value && typeof value === 'object' ? value : {};
  const storefront = readStoredAppleToken().storefront || getAppleCredentials().storefront || DEFAULT_APPLE_STOREFRONT;
  const identities = appleIdentityValues(value, type);
  if (!identities.length) {
    const err = new Error('APPLE_MUSIC_ITEM_ID_REQUIRED');
    err.code = 'APPLE_MUSIC_ITEM_ID_REQUIRED';
    throw err;
  }
  // The catalog id (numeric Apple Music id) is what the library endpoints
  // accept for adding; the ISRC must never be used there.
  const isrcValue = normalizeText(value.isrc || value.appleIsrc);
  const isrc = isrcValue || identities.find(id => appleIsrcPattern().test(id)) || '';
  const catalogId = normalizeText(value.appleId || value.providerSongId || value.id) ||
    identities.find(id => /^\d{6,20}$/.test(id)) ||
    identities.find(id => !appleIsrcPattern().test(id)) ||
    identities[0];
  const wantSave = saved !== false;

  if (type === 'album') {
    const upc = normalizeText(value.upc || value.albumUPC || value.appleAlbumUPC) ||
      (await resolveAppleCatalogAlbumsToUpc([catalogId], storefront).catch(() => ({})))[catalogId] || '';
    if (wantSave) {
      await appleSend('POST', '/v1/me/library', { 'ids[albums]': catalogId }, null, {
        timeoutMs: 10000,
        userToken: token.musicUserToken,
      });
    } else if (upc) {
      const libraryId = await findAppleLibraryAlbumIdByUpc(upc, token.musicUserToken);
      if (libraryId) {
        await appleSend('DELETE', '/v1/me/library/albums/' + encodeURIComponent(libraryId), null, null, {
          timeoutMs: 10000,
          userToken: token.musicUserToken,
        });
      }
    }
    return {
      provider: 'apple',
      loggedIn: true,
      id: catalogId,
      type: 'album',
      liked: wantSave,
      saved: wantSave,
      success: true,
    };
  }

  const resolvedIsrc = isrc ||
    (await resolveAppleCatalogIdsToIsrc([catalogId], storefront).catch(() => ({})))[catalogId] || '';
  if (wantSave) {
    await appleSend('POST', '/v1/me/library', { 'ids[songs]': catalogId }, null, {
      timeoutMs: 10000,
      userToken: token.musicUserToken,
    });
  } else if (resolvedIsrc) {
    const libraryId = await findAppleLibrarySongIdByIsrc(resolvedIsrc, token.musicUserToken);
    if (libraryId) {
      await appleSend('DELETE', '/v1/me/library/songs/' + encodeURIComponent(libraryId), null, null, {
        timeoutMs: 10000,
        userToken: token.musicUserToken,
      });
    }
  }
  return {
    provider: 'apple',
    loggedIn: true,
    id: catalogId,
    isrc: resolvedIsrc,
    type: 'track',
    liked: wantSave,
    saved: wantSave,
    success: true,
  };
}

async function handleAppleSongUrl(track) {
  const id = normalizeText(track && (track.id || track.providerSongId || track.appleId));
  return {
    provider: 'apple',
    id,
    url: '',
    playable: false,
    playbackMode: 'recommend-match',
    reason: 'provider_limited',
    restriction: {
      category: 'provider_limited',
      reason: 'apple_metadata_only',
      message: 'Apple Music 官方 API 不提供可交给 Mineradio 播放的无 DRM 音频直链，正在自动换源。',
      action: 'switch_source',
    },
  };
}

// Moved to desktop/apple-music-lyrics-api.js (Apple lyrics backend). Thin delegate kept so
// server.js, /api/apple/lyric and the existing scripts keep working unchanged.
async function handleAppleLyric(id, opts) {
  return appleMusicLyricsApi.handleAppleLyric(id, opts);
}

function resetAppleRuntimeStateForTests() {
  appleDevTokenCache = { token: '', expiresAt: 0 };
  appleSearchCache.clear();
  appleSearchInflight.clear();
}

module.exports = {
  getAppleCredentials,
  getAppleDeveloperToken,
  clearAppleToken,
  handleAppleLibraryCheck,
  handleAppleLibrarySet,
  handleAppleSongUrl,
  handleAppleLyric,
  APPLE_LIKED_PLAYLIST_ID,
  APPLE_SEARCH_LIMIT_MAX,
  APPLE_API_BASE,
  _test: {
    getAppleCredentials,
    signAppleDeveloperJwt,
    readStoredAppleToken,
    appleErrorDetails,
    mapAppleTrack,
    mapAppleLibraryPlaylist,
    resetAppleRuntimeStateForTests,
  },
};