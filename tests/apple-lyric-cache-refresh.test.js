'use strict';
// ============================================================
// P0: Apple Music 歌词缓存刷新策略测试
//   凭证已配置时, 旧的 apple-ttml-local 缓存不得直接命中 -> 重新请求 /api/apple/lyric
//   凭证未配置时, 行为完全不变
//   Web 成功 -> apple-web (含 bg) 并写入新缓存; Web 失败 -> 保留本地结果 (不清空)
//
// 用 vm 加载**真实的** 05-smtc-lyric-sources.js, 只为外部依赖提供桩。
// 运行: node tests/apple-lyric-cache-refresh.test.js
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const SMTC_SOURCES = path.join(appRoot, 'public', 'js', 'modules', '12-smtc', '05-smtc-lyric-sources.js');

const LOCAL_RESPONSE = { provider: 'apple', source: 'apple-ttml-local', lyric: '[00:01.00]local line (bg)', tlyric: '', yrc: '', ytlrc: '' };
// v2 = 已带官方翻译解析能力的响应 (schemaVersion=2)
const WEB_RESPONSE = {
  provider: 'apple', source: 'apple-web', lyric: '[00:01.00]main line', tlyric: '', yrc: '[1000,2000]main line', ytlrc: '',
  schemaVersion: 3,
  bg: [{ t: 1.2, duration: 0.5, text: '(bg)', words: [{ text: '(bg)', t: 1.2, d: 0.5 }], standalone: false, parentT: 1 }],
};
// v2 + 官方中文翻译
const WEB_RESPONSE_WITH_TRANSLATION = Object.assign({}, WEB_RESPONSE, {
  tlyric: '[00:01.00]官方译文', localizationLanguage: 'zh-Hans', lyricsLanguage: 'en',
});
// v1 = 旧解析器产物: 没有 schemaVersion, 且 tlyric 恒为空
const WEB_RESPONSE_V1 = {
  provider: 'apple', source: 'apple-web', lyric: '[00:01.00]main line', tlyric: '', yrc: '[1000,2000]main line', ytlrc: '',
  bg: [{ t: 1.2, duration: 0.5, text: '(bg)', words: [{ text: '(bg)', t: 1.2, d: 0.5 }], standalone: false, parentT: 1 }],
};

function makeHarness(options) {
  const opts = options || {};
  const calls = { apiJson: [], writeCache: [], readCache: [] };
  const persisted = {};
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, Array, Object, String, Number, Boolean, Date, RegExp, Error, Promise,
    isFinite, parseInt, parseFloat, encodeURIComponent, setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  // ---- 外部依赖桩 ----
  sandbox.smtcStore = { title: 'Hurt You', artist: 'The Weeknd', album: '' };
  sandbox.smtcNormalizedSearchTerm = (v) => String(v == null ? '' : v).trim();
  sandbox.smtcDurationSeconds = () => 230;
  sandbox.smtcLyricNormKey = (t, a) => String(t) + '|' + String(a);
  sandbox.smtcLyricSourceName = (id) => id;
  sandbox.smtcLyricState = { seq: 1 };
  sandbox.smtcLyricSourceMemoryCache = {};
  sandbox.SMTC_LYRIC_SOURCE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  sandbox.smtcEnabledLyricSourceList = () => (opts.sources || [{ id: 'apple', name: 'Apple Music' }]);
  sandbox.smtcLyricQueries = (t) => [t];
  sandbox.smtcLyricSyntheticForSourceId = (id, title, artist) => ({ title, artist, source: id });
  sandbox.smtcLyricSyntheticForCandidate = (id, cand, title, artist) => ({ title, artist, source: id });
  sandbox.mergeInlineLyricResponseForSong = (song, r) => r;
  sandbox.parseLyricResponseToOriginalState = (synthetic, response) => ({
    usableLyric: !!(response && response.lyric), lines: [{ t: 0, text: (response || {}).lyric || '' }],
    translationLines: [], hasNativeKaraoke: false, timingSource: 'lrc-line',
  });
  sandbox.writePersistentLyricCache = () => {};
  sandbox.apiJson = (url) => {
    calls.apiJson.push(url);
    const r = typeof opts.apiResponse === 'function' ? opts.apiResponse(url, calls.apiJson.length) : opts.apiResponse;
    return r ? Promise.resolve(r) : Promise.reject(new Error('no response'));
  };
  sandbox.smtcLyricSourceImpls = {
    qq: { search: () => Promise.resolve(null), getLyrics: () => Promise.resolve(null) },
  };
  const bridge = {
    readLyricCache: (key) => {
      calls.readCache.push(key);
      return Promise.resolve(persisted[key] ? { ok: true, hit: true, payload: persisted[key] } : { ok: true, hit: false });
    },
    writeLyricCache: (key, payload) => {
      calls.writeCache.push({ key, payload });
      persisted[key] = payload;
      return Promise.resolve({ ok: true });
    },
    getAppleLyricsCredentialStatus: () => Promise.resolve({ ok: true, configured: !!opts.configured }),
  };
  sandbox.desktopWindow = bridge;   // 主窗口桥接 (window.desktopWindow)

  vm.runInContext(fs.readFileSync(SMTC_SOURCES, 'utf8'), vm.createContext(sandbox), { filename: '05-smtc-lyric-sources.js' });
  // 用模块自己的归一化键 (真实实现会小写并去空格), 避免测试与实现不一致
  const cacheKey = sandbox.smtcLyricPersistentKey(sandbox.smtcLyricNormKey('Hurt You', 'The Weeknd'));
  if (opts.entry) persisted[cacheKey] = opts.entry;
  return { sandbox, calls, persisted, bridge, key: cacheKey };
}

function cacheEntry(source, response, extra) {
  return Object.assign({
    version: 1, source, matchedTitle: 'Hurt You', matchedArtist: 'The Weeknd',
    timestamp: Date.now(), response, synthetic: { title: 'Hurt You', artist: 'The Weeknd', source },
  }, extra || {});
}

// ------------------------------------------------------------
// TEST 1: 旧 apple-ttml-local 缓存 + token configured=true -> 不直接命中, 改走请求
// ------------------------------------------------------------
test('TEST 1: 已配置凭证时 apple-ttml-local 缓存视为可刷新 (不直接命中)', async () => {
  const h = makeHarness({ configured: true, entry: cacheEntry('apple', LOCAL_RESPONSE), apiResponse: WEB_RESPONSE });
  const result = await h.sandbox.smtcResolveLyricViaSources('Hurt You', 'The Weeknd', 1, false);
  assert.strictEqual(h.calls.apiJson.length, 1, '必须重新请求 /api/apple/lyric');
  assert.ok(/\/api\/apple\/lyric/.test(h.calls.apiJson[0]), '请求的应是 apple 歌词端点');
  assert.strictEqual(result.fromCache, false, '不得标记为缓存命中');
  assert.strictEqual(result.response.source, 'apple-web');
});

// ------------------------------------------------------------
// TEST 2: web 成功 -> apple-web + bg + 写入新缓存
// ------------------------------------------------------------
test('TEST 2: 刷新拿到 apple-web 时使用它 (含 bg) 并写入新缓存', async () => {
  const h = makeHarness({ configured: true, entry: cacheEntry('apple', LOCAL_RESPONSE), apiResponse: WEB_RESPONSE });
  const result = await h.sandbox.smtcResolveLyricViaSources('Hurt You', 'The Weeknd', 1, false);
  assert.strictEqual(result.response.source, 'apple-web');
  assert.ok(Array.isArray(result.response.bg) && result.response.bg.length === 1, 'bg 必须存在');
  assert.strictEqual(result.response.bg[0].text, '(bg)');
  const written = h.calls.writeCache[h.calls.writeCache.length - 1];
  assert.ok(written, '必须写入持久缓存');
  assert.strictEqual(written.payload.response.source, 'apple-web', '新缓存必须是 apple-web');
  assert.strictEqual(written.payload.appleLocalFallbackAt, undefined, 'apple-web 不写冷却标记');
  // 下次命中应为 apple-web (不再触发刷新)
  const again = makeHarness({ configured: true, entry: h.persisted[h.key], apiResponse: WEB_RESPONSE });
  const second = await again.sandbox.smtcResolveLyricViaSources('Hurt You', 'The Weeknd', 1, false);
  assert.strictEqual(again.calls.apiJson.length, 0, 'apple-web 缓存应直接命中, 不再请求');
  assert.strictEqual(second.fromCache, true);
  assert.strictEqual(second.response.source, 'apple-web');
});

// ------------------------------------------------------------
// TEST 3: web 失败 -> 回落到本地结果, 不清空歌词, 并记录冷却
// ------------------------------------------------------------
test('TEST 3: Web 失败时保留本地结果 (不清空) 且进入刷新冷却', async () => {
  const h = makeHarness({ configured: true, entry: cacheEntry('apple', LOCAL_RESPONSE), apiResponse: LOCAL_RESPONSE });
  const result = await h.sandbox.smtcResolveLyricViaSources('Hurt You', 'The Weeknd', 1, false);
  assert.ok(result, '必须有结果 (不能返回 null)');
  assert.strictEqual(result.response.source, 'apple-ttml-local', 'Web 失败 -> 继续用本地结果');
  assert.ok(String(result.response.lyric).length > 0, '旧歌词不得被清空');
  const written = h.calls.writeCache[h.calls.writeCache.length - 1];
  assert.ok(written.payload.appleLocalFallbackAt > 0, '必须记录本地兜底时间 (用于冷却)');
  // 冷却期内: 直接命中本地结果, 不再重复请求
  const again = makeHarness({ configured: true, entry: h.persisted[h.key], apiResponse: LOCAL_RESPONSE });
  const second = await again.sandbox.smtcResolveLyricViaSources('Hurt You', 'The Weeknd', 1, false);
  assert.strictEqual(again.calls.apiJson.length, 0, '冷却期内不得重复请求');
  assert.strictEqual(second.fromCache, true);
  assert.strictEqual(second.response.source, 'apple-ttml-local');
});

// ------------------------------------------------------------
// TEST 4: 未配置凭证 -> 现有本地缓存行为不变
// ------------------------------------------------------------
test('TEST 4: 未配置凭证时 apple-ttml-local 缓存照常直接命中 (行为不变)', async () => {
  const h = makeHarness({ configured: false, entry: cacheEntry('apple', LOCAL_RESPONSE), apiResponse: WEB_RESPONSE });
  const result = await h.sandbox.smtcResolveLyricViaSources('Hurt You', 'The Weeknd', 1, false);
  assert.strictEqual(h.calls.apiJson.length, 0, '未配置凭证不得触发请求');
  assert.strictEqual(result.fromCache, true, '应直接命中缓存');
  assert.strictEqual(result.response.source, 'apple-ttml-local');
});

// ------------------------------------------------------------
// TEST 5: apple-web 缓存 schema 迁移
//   v1 (旧解析器, tlyric 恒空) -> 视为 stale, 重新请求一次
//   v2 (新解析器, 带官方翻译能力) -> 正常命中 (7 天 TTL), 不重复请求
//   未配置凭证 -> 行为完全不变 (不得把带 bg 的 web 缓存降级成 local)
// ------------------------------------------------------------
test('TEST 5a: 旧 schema (v1) apple-web 缓存视为 stale -> 重新请求并写入 v2', async () => {
  const h = makeHarness({ configured: true, entry: cacheEntry('apple', WEB_RESPONSE_V1), apiResponse: WEB_RESPONSE_WITH_TRANSLATION });
  const result = await h.sandbox.smtcResolveLyricViaSources('Hurt You', 'The Weeknd', 1, false);
  assert.strictEqual(h.calls.apiJson.length, 1, 'v1 缓存必须重新请求一次');
  assert.strictEqual(result.fromCache, false);
  assert.strictEqual(result.response.source, 'apple-web');
  assert.strictEqual(result.response.schemaVersion, 3, '刷新后应是当前 schema 响应');
  assert.ok(String(result.response.tlyric || '').length > 0, '刷新后必须带上官方翻译');
  const written = h.calls.writeCache[h.calls.writeCache.length - 1];
  assert.strictEqual(written.payload.response.schemaVersion, 3, '新缓存必须记录当前 schema');
  assert.ok(Array.isArray(written.payload.response.bg), 'bg 不得丢失');
});

test('TEST 5b: 新 schema (v2) apple-web 缓存正常命中, 不再请求', async () => {
  const h = makeHarness({ configured: true, entry: cacheEntry('apple', WEB_RESPONSE_WITH_TRANSLATION), apiResponse: LOCAL_RESPONSE });
  const result = await h.sandbox.smtcResolveLyricViaSources('Hurt You', 'The Weeknd', 1, false);
  assert.strictEqual(h.calls.apiJson.length, 0, 'v2 缓存不得被刷新 (不会每次播放都请求 API)');
  assert.strictEqual(result.fromCache, true);
  assert.strictEqual(result.response.source, 'apple-web');
  assert.strictEqual(result.response.tlyric, '[00:01.00]官方译文');
  assert.ok(Array.isArray(result.response.bg), 'bg 必须保留');
});

test('TEST 5c: 未配置凭证时 v1 apple-web 缓存照常命中 (行为完全不变)', async () => {
  const h = makeHarness({ configured: false, entry: cacheEntry('apple', WEB_RESPONSE_V1), apiResponse: WEB_RESPONSE });
  const result = await h.sandbox.smtcResolveLyricViaSources('Hurt You', 'The Weeknd', 1, false);
  assert.strictEqual(h.calls.apiJson.length, 0, '未配置凭证不得触发 schema 迁移请求');
  assert.strictEqual(result.fromCache, true);
  assert.strictEqual(result.response.source, 'apple-web');
  assert.ok(Array.isArray(result.response.bg), 'bg 必须保留');
});

test('TEST 5d: schema 迁移常量必须与 provider 一致', () => {
  const providerSrc = fs.readFileSync(path.join(appRoot, 'apple-music-web-lyrics.js'), 'utf8');
  const smtcSrc = fs.readFileSync(SMTC_SOURCES, 'utf8');
  const providerVersion = Number((providerSrc.match(/APPLE_WEB_LYRICS_SCHEMA_VERSION\s*=\s*(\d+)/) || [])[1]);
  const smtcVersion = Number((smtcSrc.match(/SMTC_APPLE_WEB_LYRICS_SCHEMA_VERSION\s*=\s*(\d+)/) || [])[1]);
  assert.ok(providerVersion >= 3, 'provider schema 版本必须 >= 3 (v3 = bg 译文分离)');
  assert.strictEqual(smtcVersion, providerVersion, 'SMTC 侧常量必须与 provider 同步');
});

// ------------------------------------------------------------
// TEST 6: 其它歌词源缓存行为完全不变
// ------------------------------------------------------------
test('TEST 6: QQ/Kugou/NetEase 缓存行为完全不变 (凭证状态不影响)', async () => {
  const qqResponse = { provider: 'qq', lyric: '[00:01.00]qq line', tlyric: '', yrc: '', ytlrc: '', source: 'qq-musicu' };
  const qqEntry = cacheEntry('qq', qqResponse);
  const h = makeHarness({ configured: true, entry: qqEntry, apiResponse: WEB_RESPONSE });
  const result = await h.sandbox.smtcResolveLyricViaSources('Hurt You', 'The Weeknd', 1, false);
  assert.strictEqual(h.calls.apiJson.length, 0, '非 Apple 源不得触发刷新');
  assert.strictEqual(result.fromCache, true);
  assert.strictEqual(result.source, 'qq');
  assert.strictEqual(result.response.lyric, '[00:01.00]qq line');
});

// ------------------------------------------------------------
// 桥接缺失时的降级 (老 preload) -> 行为与改动前一致
// ------------------------------------------------------------
test('桥接不可用时按"未配置"处理 (旧 preload 安全降级)', async () => {
  const h = makeHarness({ configured: true, entry: cacheEntry('apple', LOCAL_RESPONSE), apiResponse: WEB_RESPONSE });
  h.sandbox.desktopWindow.getAppleLyricsCredentialStatus = undefined;   // 模拟旧 preload
  const result = await h.sandbox.smtcResolveLyricViaSources('Hurt You', 'The Weeknd', 1, false);
  assert.strictEqual(result.fromCache, true, '桥接缺失 -> 维持旧行为 (直接命中)');
  assert.strictEqual(h.calls.apiJson.length, 0);
});
