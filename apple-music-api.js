'use strict';

// ============================================================
// Apple Music API bridge for Mineradio (Apple Music edition) — 收窄后的剩余部分。
//
// Developer 账号轴 (Team ID / Key ID / P8 -> ES256 JWT -> /v1/me/*) 已整体退休:
// 这个模块不再有任何请求实现, 只剩三件事 ——
//   - mapping helpers : mapAppleTrack / mapAppleLibraryPlaylist / appleErrorDetails (web 读取复用);
//   - handleAppleSongUrl : 纯 stub (Apple 不提供无 DRM 直链, 播放自动换源);
//   - handleAppleLyric   : 转发给 desktop/apple-music-lyrics-api.js (web 歌词)。
// 另保留 clearAppleToken(): 只删不读, 供 /api/apple/logout 清掉历史遗留的 .apple-music-token.json。
// 账号与 web 凭证一律走 media-user-token (desktop/apple-music-lyrics-credential.js)。
// ============================================================

const fs = require('fs');
const path = require('path');
// 第三阶段: Apple Music Web 私有歌词 provider (Bearer + media-user-token)。
// 只读、不落盘; 未配置凭证或调用失败时, 下面的本地 TTML 缓存路径完全不变。
const appleMusicLyricsApi = require('./desktop/apple-music-lyrics-api');
appleMusicLyricsApi.setTextNormalizer(normalizeText);   // reuse, never copy, the existing normalizer

// 历史遗留的 Developer user token 文件 (只删不读, 见 clearAppleToken)。
const DEFAULT_APPLE_TOKEN_FILE = path.join(__dirname, '.apple-music-token.json');
// 虚拟「Apple Music 资料库」卡片的 id (web 读取使用)。
const APPLE_LIKED_PLAYLIST_ID = 'apple-liked';


function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------------------
// 历史遗留文件: music user token (.apple-music-token.json)
// ------------------------------------------------------------
function getAppleTokenFile() {
  return process.env.APPLE_MUSIC_TOKEN_FILE || process.env.MINERADIO_APPLE_TOKEN_FILE || DEFAULT_APPLE_TOKEN_FILE;
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
// Mapping helpers
// ------------------------------------------------------------
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
    message = 'Apple Music 登录态已失效，请重新连接 Apple Music。';
  } else if (statusCode === 403) {
    message = 'Apple Music 授权权限不足，请重新连接 Apple Music。';
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
// Handlers (mirror the Spotify provider contract) — stub + 歌词转发
// ------------------------------------------------------------
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

module.exports = {
  clearAppleToken,
  handleAppleSongUrl,
  handleAppleLyric,
  APPLE_LIKED_PLAYLIST_ID,
  _test: {
    appleErrorDetails,
    mapAppleTrack,
    mapAppleLibraryPlaylist,
  },
};