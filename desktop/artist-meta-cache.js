'use strict';
// ====================================================================
// 艺人元数据缓存（头像 / 名称 / 简介）—— 磁盘 + 进程内双层
//
// 起因：QQ / 酷狗的艺人列表要为**每一个**艺人单独发一次详情请求补头像
// （QQ 269 个、酷狗 474 个，8 并发），实测 QQ 7.9s、酷狗 2.2s ——
// 而且每次打开都重来一遍，因为没有缓存。
//
// 设计（与 desktop/spotify-library-cache.js 同一套原则）：
//   - 进程内 Map 命中零开销；未命中则查磁盘；磁盘也没有才走网络。
//   - 落盘到 userData/artist-meta-cache.json，原子写（.tmpdir 再改名）。
//   - schemaVersion 不符就当空缓存重建。
//   - 带 TTL：艺人头像/简介变化很慢，默认 14 天。
//   - 允许缓存「确认没有头像」的空值（value.image === ''），
//     避免对没有头像的艺人每次重试；TTL 到期后会重新取。
// ====================================================================

const fs = require('fs');
const path = require('path');

const ARTIST_META_SCHEMA_VERSION = 1;
const CACHE_FILE_NAME = 'artist-meta-cache.json';
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 6000;

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

function createArtistMetaCache(options) {
  options = options || {};
  const cachePath = options.cachePath !== undefined ? options.cachePath : resolveDefaultCachePath();
  const defaultTtlMs = Number(options.ttlMs) || DEFAULT_TTL_MS;
  const store = new Map();
  let loaded = false;
  let diskLoadedOk = false;
  let dirty = false;

  function keyOf(source, id) {
    const s = String(source || '').trim();
    const i = String(id || '').trim();
    if (!s || !i) return '';
    return s + ':' + i;
  }

  function loadFromDisk() {
    if (diskLoadedOk) return true;
    loaded = true;
    if (!cachePath) return false;
    let text = '';
    try {
      if (!fs.existsSync(cachePath)) return false;
      text = fs.readFileSync(cachePath, 'utf8');
    } catch (_) { return false; }
    let payload = null;
    try { payload = JSON.parse(text); } catch (_) { return false; }
    if (!payload || payload.schemaVersion !== ARTIST_META_SCHEMA_VERSION) return false;
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    entries.forEach(function (e) {
      if (Array.isArray(e) && e[0] && e[1] && typeof e[1] === 'object') store.set(String(e[0]), e[1]);
    });
    diskLoadedOk = true;
    return true;
  }

  function get(source, id, ttlMs) {
    const key = keyOf(source, id);
    if (!key) return null;
    loadFromDisk();
    const hit = store.get(key);
    if (!hit) return null;
    const ttl = Number(ttlMs) || defaultTtlMs;
    if (Date.now() - Number(hit.at || 0) > ttl) return null;
    return hit.value || null;
  }

  function set(source, id, value) {
    const key = keyOf(source, id);
    if (!key) return false;
    loadFromDisk();
    store.set(key, { at: Date.now(), value: value || {} });
    dirty = true;
    if (store.size > MAX_ENTRIES) {
      // 超上限时按时间淘汰最旧的一批
      const sorted = Array.from(store.entries()).sort(function (a, b) { return Number((a[1] || {}).at || 0) - Number((b[1] || {}).at || 0); });
      sorted.slice(0, store.size - MAX_ENTRIES).forEach(function (e) { store.delete(e[0]); });
    }
    return true;
  }

  function flush() {
    if (!cachePath || !dirty) return false;
    try {
      const dir = path.dirname(cachePath);
      fs.mkdirSync(dir, { recursive: true });
      const payload = {
        schemaVersion: ARTIST_META_SCHEMA_VERSION,
        savedAt: Date.now(),
        entries: Array.from(store.entries()),
      };
      const tmp = cachePath + '.tmpdir';
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, cachePath);
      dirty = false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function stats() {
    loadFromDisk();
    return {
      cachePath: cachePath,
      loaded: loaded,
      diskLoadedOk: diskLoadedOk,
      entries: store.size,
      dirty: dirty,
      defaultTtlMs: defaultTtlMs,
    };
  }

  return { get: get, set: set, flush: flush, stats: stats, loadFromDisk: loadFromDisk, keyOf: keyOf, _store: store };
}

module.exports = {
  createArtistMetaCache,
  resolveDefaultCachePath,
  ARTIST_META_SCHEMA_VERSION,
  CACHE_FILE_NAME,
  DEFAULT_TTL_MS,
};