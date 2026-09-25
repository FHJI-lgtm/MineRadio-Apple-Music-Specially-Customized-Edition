'use strict';
// ============================================================
// Apple 官方翻译 -> MineRadio translation 契约测试
//
// 覆盖任务书 TEST 7/8/9/10:
//   7. Apple 有中文翻译 -> translationSource = apple-web
//   8. Apple 有中文翻译 -> 不触发 netease-supplement
//   9. Apple 无中文翻译 -> 仍允许其它源按用户顺序补 translation
//  10. 非 Apple 源的翻译记账 (tlyric) 完全不变
//
// 用 vm 加载**真实源码**: 06-lyrics/00-lyrics-fetch-parse.js + 12-smtc/05-smtc-lyric-sources.js,
// 只为外部依赖提供桩。不复制实现。
// 运行: node tests/apple-web-translation-chain.test.js
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const PARSE_FILE = path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js');
const SMTC_FILE = path.join(appRoot, 'public', 'js', 'modules', '12-smtc', '05-smtc-lyric-sources.js');

// 一首 Apple 官方带中文翻译的合成响应 (结构真实, 文本为占位)
function appleWebResponse(options) {
  const opts = typeof options === 'boolean' ? { translation: options } : (options || {});
  const response = {
    provider: 'apple', id: '1499378607', source: 'apple-web', schemaVersion: 2,
    lyric: '[00:01.00]line one\n[00:03.00]line two\n[00:05.00]line three',
    yrc: '[1000,2000](1000,1000,0)line one\n[3000,2000](3000,1000,0)line two\n[5000,2000](5000,1000,0)line three',
    tlyric: '', ytlrc: '',
    language: 'en', lyricsLanguage: 'en',
    localizationLanguage: (opts.translation || opts.backgroundTranslation) ? 'zh-Hans' : '',
    bg: [{ t: 1.2, duration: 0.5, text: '(Ah)', words: [{ text: '(Ah)', t: 1.2, d: 0.5 }], standalone: false, parentT: 1 }],
  };
  if (opts.translation) response.tlyric = '[00:01.00]第一行译文\n[00:03.00]第二行译文\n[00:05.00]第三行译文';
  // 背景人声的官方译文 (x-bg): 只属于 bg, 不进入主歌词 translationLines
  if (opts.backgroundTranslation) response.bg[0].translation = '(啊)';
  if (opts.backgroundTranslationOnly) {
    response.tlyric = '';
    response.bg[0].translation = '(啊)';
  }
  return response;
}

function makeHarness(options) {
  const opts = options || {};
  const calls = { neteaseSearch: 0, neteaseGetLyrics: 0, appleGetLyrics: 0, setStates: [] };
  const sandbox = {
    console,
    Math, JSON, Array, Object, String, Number, Boolean, Date, RegExp, Error, Promise,
    isFinite, parseInt, parseFloat, encodeURIComponent, setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  // ---- 渲染层/状态层桩 ----
  sandbox.clampRange = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
  sandbox.normalizeLyricTranslationText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  sandbox.normalizeStageLyricText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  sandbox.normalizeLyricDisplayMode = (v) => v || 'single';
  sandbox.normalizeLyricTranslationMode = (v) => v || 'off';
  sandbox.lyricContextOpacityValue = () => 0.42;
  sandbox.lyricTranslationScaleValue = () => 0.78;
  sandbox.lyricTranslationVisualGapValue = () => 1.2;
  sandbox.lyricContextSpreadValue = () => 1;
  sandbox.lyricLineTranslationTextAt = () => '';
  sandbox.fx = { lyricDisplayMode: 'cinema', lyricTranslationMode: 'current' };
  sandbox.fxDefaults = { lyricTranslationScale: 0.78 };
  sandbox.lyricsLines = [];
  sandbox.lyricsTranslationLines = [];
  sandbox.THREE = {};
  sandbox.originalLyricsState = { lines: [], translationLines: [], translationSource: 'none' };
  sandbox.setOriginalLyricsState = function (lines, native, timing, translationLines, translationSource) {
    sandbox.originalLyricsState = {
      lines: lines || [], hasNativeKaraoke: !!native, timingSource: timing,
      translationLines: translationLines || [], translationSource: translationSource || 'none',
    };
    calls.setStates.push({ translationSource: translationSource || 'none', translationLines: (translationLines || []).length });
  };
  sandbox.applyOriginalLyricsState = function () { };
  sandbox.cloneLyricLines = (lines) => (lines || []).map((l) => Object.assign({}, l));
  sandbox.hasUsableLyricLines = (lines) => Array.isArray(lines) && lines.some((l) => l && String(l.text || '').trim());
  sandbox.songProviderKey = () => 'apple';
  sandbox.isLyricCreditLineText = () => false;

  // ---- SMTC 层桩 ----
  sandbox.smtcStore = { active: true, title: 'Blinding Lights', artist: 'The Weeknd', album: '' };
  sandbox.smtcNormalizedSearchTerm = (v) => String(v == null ? '' : v).trim();
  sandbox.smtcDurationSeconds = () => 200;
  sandbox.smtcLyricNormKey = (t, a) => String(t).toLowerCase() + '|' + String(a).toLowerCase();
  sandbox.smtcLyricSourceName = (id) => id;
  sandbox.smtcLyricState = { seq: 1, loading: false };
  sandbox.smtcLyricSourceMemoryCache = {};
  sandbox.smtcLyricQueries = (t) => [t];
  sandbox.smtcLyricSyntheticForSourceId = (id, title, artist) => ({ title, artist, source: id });
  sandbox.smtcLyricSyntheticForCandidate = (id, cand, title, artist) => ({ title, artist, source: id });
  sandbox.smtcEnabledLyricSourceList = () => (opts.sources || [{ id: 'apple', name: 'Apple Music' }, { id: 'netease', name: '网易云音乐' }]);
  sandbox.mergeInlineLyricResponseForSong = (song, r) => r;
  sandbox.desktopWindow = {
    readLyricCache: () => Promise.resolve({ ok: true, hit: false }),
    writeLyricCache: () => Promise.resolve({ ok: true }),
    getAppleLyricsCredentialStatus: () => Promise.resolve({ ok: true, configured: true }),
  };
  sandbox.smtcLyricSourceImpls = {
    apple: {
      search: () => Promise.resolve({ id: '1499378607', name: 'Blinding Lights' }),
      getLyrics: () => { calls.appleGetLyrics += 1; return Promise.resolve(opts.appleResponse || appleWebResponse(false)); },
    },
    netease: {
      search: () => { calls.neteaseSearch += 1; return Promise.resolve(opts.neteaseCandidate === null ? null : { id: 'n1', name: 'Blinding Lights' }); },
      getLyrics: () => {
        calls.neteaseGetLyrics += 1;
        return Promise.resolve({
          provider: 'netease', source: 'netease',
          lyric: '[00:01.00]line one\n[00:03.00]line two\n[00:05.00]line three',
          tlyric: '[00:01.00]网易云译文一\n[00:03.00]网易云译文二\n[00:05.00]网易云译文三',
          yrc: '', ytlrc: '',
        });
      },
    },
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PARSE_FILE, 'utf8'), ctx, { filename: '00-lyrics-fetch-parse.js' });
  vm.runInContext(fs.readFileSync(SMTC_FILE, 'utf8'), ctx, { filename: '05-smtc-lyric-sources.js' });
  // 重要: 05-smtc 模块自身定义了 smtcEnabledLyricSourceList / smtcLyricSourceImpls /
  // smtcLyricQueries 等 (模块定义会覆盖同名桩), 必须在**加载之后**再覆盖一次才能确定性驱动。
  sandbox.smtcEnabledLyricSourceList = () => (opts.sources || [{ id: 'apple', name: 'Apple Music' }, { id: 'netease', name: '网易云音乐' }]);
  sandbox.smtcLyricQueries = (t) => [t];
  sandbox.smtcLyricSyntheticForCandidate = (id, cand, title, artist) => ({ title, artist, source: id });
  sandbox.smtcLyricSourceImpls = {
    apple: {
      search: () => Promise.resolve({ id: '1499378607', name: 'Blinding Lights' }),
      getLyrics: () => { calls.appleGetLyrics += 1; return Promise.resolve(opts.appleResponse || appleWebResponse(false)); },
    },
    netease: {
      search: () => { calls.neteaseSearch += 1; return Promise.resolve(opts.neteaseCandidate === null ? null : { id: 'n1', name: 'Blinding Lights' }); },
      getLyrics: () => {
        calls.neteaseGetLyrics += 1;
        return Promise.resolve({
          provider: 'netease', source: 'netease',
          lyric: '[00:01.00]line one\n[00:03.00]line two\n[00:05.00]line three',
          tlyric: '[00:01.00]网易云译文一\n[00:03.00]网易云译文二\n[00:05.00]网易云译文三',
          yrc: '', ytlrc: '',
        });
      },
    },
  };
  sandbox.apiJson = () => Promise.reject(new Error('tests must not hit the network'));
  return { sandbox, calls };
}

function tick(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 4); i += 1) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

// ------------------------------------------------------------
// A. 标准化层契约 (真实 00-lyrics-fetch-parse.js)
// ------------------------------------------------------------
test('A1: apple-web + 官方翻译 -> translationSource = apple-web (含逐行记账)', () => {
  const h = makeHarness();
  const response = appleWebResponse(true);
  const synthetic = { title: 'Blinding Lights', artist: 'The Weeknd', source: 'apple' };
  const state = h.sandbox.parseLyricResponseToOriginalState(synthetic, response);
  assert.strictEqual(state.translationSource, 'apple-web', '翻译来源必须是 apple-web');
  assert.strictEqual(state.translationLines.length, 3, '翻译行必须全部进入 translationLines');
  const translated = state.lines.filter((l) => l && l.translation);
  assert.strictEqual(translated.length, 3, '原文行必须挂上翻译');
  assert.strictEqual(translated[0].translation, '第一行译文');
  assert.strictEqual(translated[0].translationSource, 'apple-web', '逐行来源也必须是 apple-web');
  // 原文不得被翻译覆盖
  assert.strictEqual(state.lines[0].text, 'line one', '原文必须保持原样');
  assert.match(response.lyric, /line one/, 'response.lyric 必须是原文');
  // bg 仍然存在
  assert.ok((state.lines[0].background || '').includes('(Ah)'), 'bg 必须仍然挂在主行上');
});

test('A1b: bg 译文必须落在 backgroundTranslation, 不得进入主 translation / translationLines', () => {
  const h = makeHarness();
  const response = appleWebResponse({ translation: true, backgroundTranslation: true });
  const state = h.sandbox.parseLyricResponseToOriginalState({ title: 'x', artist: 'y', source: 'apple' }, response);
  assert.strictEqual(state.translationLines.length, 3, 'bg 译文不得计入 translationLines');
  assert.strictEqual(state.translationSource, 'apple-web');
  const first = state.lines[0];
  assert.strictEqual(first.translation, '第一行译文', '主行 translation 必须只含主歌词译文');
  assert.ok(first.translation.indexOf('啊') < 0, '主行 translation 不得混入 bg 译文');
  assert.strictEqual(first.backgroundTranslation, '(啊)', 'bg 译文必须挂在 backgroundTranslation');
  assert.strictEqual(first.background, '(Ah)', 'bg 原文不受影响');
  assert.strictEqual(state.lines.filter((l) => l && l.translation && l.translation.indexOf('(啊)') >= 0).length, 0);
});

test('A2b: 只有 bg 译文 (无主歌词译文) -> 不算已有翻译, 仍允许 fallback', () => {
  const h = makeHarness();
  const state = h.sandbox.parseLyricResponseToOriginalState({ title: 'x', artist: 'y', source: 'apple' }, appleWebResponse({ backgroundTranslationOnly: true }));
  assert.strictEqual(state.translationLines.length, 0, 'bg 译文不得让系统以为主歌词已有翻译');
  assert.strictEqual(state.translationSource, 'none', '没有主歌词翻译 -> 来源为 none');
  assert.strictEqual(state.lines[0].backgroundTranslation, '(啊)', 'bg 译文本身仍然保留');
});

test('A2: apple-web 无官方翻译 -> translationLines 为空 (允许其它源补翻译)', () => {
  const h = makeHarness();
  const state = h.sandbox.parseLyricResponseToOriginalState({ title: 'x', artist: 'y', source: 'apple' }, appleWebResponse(false));
  assert.strictEqual(state.translationSource, 'none', '没有翻译时来源必须是 none');
  assert.strictEqual(state.translationLines.length, 0);
  assert.strictEqual(state.lines.filter((l) => l && l.translation).length, 0);
});

test('A3: 非 Apple 源的翻译记账完全不变 (仍是 tlyric)', () => {
  const h = makeHarness();
  const response = {
    provider: 'qq', source: 'qq-musicu', lyric: '[00:01.00]line one\n[00:03.00]line two',
    tlyric: '[00:01.00]QQ译文一\n[00:03.00]QQ译文二', yrc: '', ytlrc: '',
  };
  const state = h.sandbox.parseLyricResponseToOriginalState({ title: 'x', artist: 'y', source: 'qq' }, response);
  assert.strictEqual(state.translationSource, 'tlyric', 'QQ/Kugou/NetEase 必须保持 tlyric 记账');
  assert.strictEqual(state.translationLines.length, 2);
  assert.strictEqual(state.lines[0].translationSource, 'tlyric');
});

// ------------------------------------------------------------
// B. supplement 门 (真实 05-smtc-lyric-sources.js 驱动 smtcReSearchLyrics)
// ------------------------------------------------------------
test('B1: Apple 有官方中文翻译时必须禁止 netease-supplement', async () => {
  const h = makeHarness({ appleResponse: appleWebResponse(true) });
  const result = await h.sandbox.smtcReSearchLyrics();
  await tick(6);
  assert.strictEqual(result.ok, true, 're-search 必须成功');
  assert.strictEqual(result.trans, true, '必须带翻译');
  assert.strictEqual(h.calls.neteaseSearch, 0, '不得请求网易云 (Apple 已有官方翻译)');
  assert.strictEqual(h.calls.neteaseGetLyrics, 0, '不得调用网易云 getLyrics');
  const last = h.calls.setStates[h.calls.setStates.length - 1];
  assert.strictEqual(last.translationSource, 'apple-web', '状态里的 translationSource 必须是 apple-web');
  assert.ok(last.translationLines > 0, 'translationLines 必须 > 0');
});

test('B2: Apple 无官方翻译时必须保持 fallback (按用户顺序补翻译)', async () => {
  const h = makeHarness({ appleResponse: appleWebResponse(false) });
  const result = await h.sandbox.smtcReSearchLyrics();
  await tick(8);
  assert.strictEqual(result.ok, true, 're-search 仍必须成功');
  assert.strictEqual(result.trans, false, '主源本身没有翻译');
  assert.ok(h.calls.neteaseSearch > 0, '必须尝试其它源补翻译');
  assert.strictEqual(h.calls.neteaseGetLyrics, 1, '必须从网易云取翻译');
  const supplement = h.calls.setStates.filter((s) => /-supplement$/.test(s.translationSource));
  assert.strictEqual(supplement.length, 1, '必须写入一次 supplement 状态');
  assert.strictEqual(supplement[0].translationSource, 'netease-supplement');
  assert.ok(supplement[0].translationLines > 0, '补充的翻译行必须写入');
  assert.strictEqual(h.calls.setStates[0].translationSource, 'none', '第一次写入仍是主源 (无翻译)');
});

test('B3: Apple 无翻译且其它源也没有翻译 -> 不写 supplement 状态, 原文不受影响', async () => {
  const h = makeHarness({ appleResponse: appleWebResponse(false) });
  h.sandbox.smtcLyricSourceImpls.netease.getLyrics = () => {
    h.calls.neteaseGetLyrics += 1;
    return Promise.resolve({ provider: 'netease', source: 'netease', lyric: '[00:01.00]line one', tlyric: '', yrc: '', ytlrc: '' });
  };
  const result = await h.sandbox.smtcReSearchLyrics();
  await tick(8);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(h.calls.neteaseGetLyrics, 1, '仍然会尝试');
  const supplement = h.calls.setStates.filter((s) => /-supplement$/.test(s.translationSource));
  assert.strictEqual(supplement.length, 0, '没有翻译时不得写入 supplement 状态');
  assert.strictEqual(h.sandbox.originalLyricsState.translationSource, 'none');
  assert.ok(h.sandbox.originalLyricsState.lines.length > 0, '原文必须保留');
});
