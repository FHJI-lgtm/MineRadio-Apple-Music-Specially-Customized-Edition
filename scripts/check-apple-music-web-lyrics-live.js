'use strict';

// ============================================================
// scripts/check-apple-music-web-lyrics-live.js
//
// Apple Music Web 私有歌词的**联网集成测试** (只读)。
//
// 用法:
//   node scripts/check-apple-music-web-lyrics-live.js --token-file <path> [--song <id>] [--storefront cn]
//   或设置环境变量 MINERADIO_APPLE_LYRICS_TOKEN_FILE
//
// 说明:
//   - token 只从文件读取, 不出现在命令行/日志; 本脚本只打印长度与布尔值。
//   - 覆盖任务书 TEST 6/7/8/9/10 (真实 HTTP) 以及 TEST 5 (未配置回落)。
//   - 不写任何文件; 不修改用户配置。
// ============================================================

const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const webLyrics = require(path.join(appRoot, 'apple-music-web-lyrics.js'));
const appleApi = require(path.join(appRoot, 'apple-music-api.js'));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

function parseArgs(argv) {
  const args = { tokenFile: '', song: '1440882165', storefront: 'cn' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--token-file') args.tokenFile = String(argv[++i] || '');
    else if (argv[i] === '--song') args.song = String(argv[++i] || '');
    else if (argv[i] === '--storefront') args.storefront = String(argv[++i] || '');
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const tokenFile = args.tokenFile || process.env.MINERADIO_APPLE_LYRICS_TOKEN_FILE || '';
  console.log('=== Apple Music Web 歌词 · 联网集成测试 ===');
  console.log('song=' + args.song + ' storefront=' + args.storefront);

  // ---------- TEST 5: 未配置凭证 -> 不联网, 直接 CREDENTIAL_MISSING ----------
  console.log('');
  console.log('[TEST 5] media-user-token 未配置');
  webLyrics.resetForTests();
  webLyrics.setCredentialSource(null);
  const noCred = await webLyrics.fetchWebLyrics({ title: 'x', artist: 'y', songId: args.song });
  check('未配置 -> ok=false', noCred.ok === false);
  check('未配置 -> CREDENTIAL_MISSING', noCred.error === 'CREDENTIAL_MISSING', noCred.error);
  check('未配置 -> 不返回任何歌词', !noCred.lyric && !noCred.yrc);

  // 未配置时, 生产路径必须继续走本地缓存而不是失败
  const localOnly = await appleApi.handleAppleLyric('', { title: 'definitely-not-a-real-song-xyz', artist: 'nobody' });
  check('未配置 -> handleAppleLyric 仍可用 (不抛错, 走本地缓存)', typeof localOnly.lyric === 'string' && localOnly.provider === 'apple', Object.keys(localOnly));

  if (!tokenFile) {
    console.log('');
    console.log('未提供 --token-file: 跳过联网部分 (TEST 6/7/8/9/10)');
    console.log('\n结果: pass=' + pass + ' fail=' + fail);
    process.exit(fail === 0 ? 0 : 1);
  }
  if (!fs.existsSync(tokenFile)) {
    console.log('token 文件不存在: ' + tokenFile);
    process.exit(2);
  }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  console.log('token: length=' + token.length + ' (内容不打印)');

  // ---------- TEST 6: 已配置 -> isConfigured + getStatus 不含 token ----------
  console.log('');
  console.log('[TEST 6] media-user-token 已配置');
  webLyrics.setCredentialSource(() => token);
  check('isConfigured=true', webLyrics.isConfigured() === true);
  const status = webLyrics.getStatus();
  check('getStatus 不含 token', !JSON.stringify(status).includes(token), Object.keys(status));

  // ---------- TEST 7: API 200 -> original + word timing ----------
  console.log('');
  console.log('[TEST 7] 官方逐词歌词 (syllable-lyrics)');
  const res = await webLyrics.fetchWebLyrics({
    songId: args.song,
    storefront: args.storefront,
    title: 'HUMBLE.',
    artist: 'Kendrick Lamar',
  });
  check('ok=true', res.ok === true, res.error + ' ' + (res.detail || ''));
  check('source=apple-web', res.source === 'apple-web', res.source);
  check('storefront 正确', res.storefront === args.storefront, res.storefront);
  check('songId 命中', res.songId === args.song, { songId: res.songId, via: res.songIdVia });
  const stats = res.stats || {};
  console.log('    stats=' + JSON.stringify(stats));
  check('72 行', stats.lines === 72, stats.lines);
  check('720 个 span', (stats.timedSpans || 0) + (stats.untimedSpans || 0) === 720, stats);
  check('685 个带时间 span 全部被归类 (无遗漏)', stats.timedSpans === 685, stats);
  check('普通歌词词轴 = 505 (p 的直接子词 span)', stats.words === 505, stats.words);
  check('背景人声词级时间 = 180 (在 x-bg 内部, 单独保留)', stats.backgroundWords === 180, stats.backgroundWords);
  check('505 + 180 = 685 (一个都不丢)', stats.words + stats.backgroundWords === stats.timedSpans, stats);
  check('35 个 x-bg 未进入普通词轴', stats.untimedSpans === 35 && stats.backgroundSpans === 35, stats);
  check('p 外 timed span = 0 (与实测一致)', stats.timedSpansOutsideP === 0, stats);
  const yrcWordCount = (res.yrc.match(/\(\d+,\d+,\d+\)/g) || []).length;
  check('YRC 只含普通词 (505), 不含背景人声', yrcWordCount === 505, yrcWordCount);
  check('有逐词时间轴', res.hasWordTiming === true);
  check('lyric (LRC) 非空', !!res.lyric);
  check('yrc (词级) 非空', !!res.yrc);
  check('LRC 行数 = 72', res.lyric.split('\n').length === 72, res.lyric.split('\n').length);
  check('YRC 行数 = 72 (不丢行)', res.yrc.split('\n').length === 72, res.yrc.split('\n').length);
  check('返回值不含 token', !JSON.stringify(res).includes(token));
  check('错误字段为空', !res.error, res.error);

  // ---- bg 契约 (背景人声) ----
  check('bg 是可选字段且为数组', res.bg === undefined || Array.isArray(res.bg), typeof res.bg);
  const bgEntries = Array.isArray(res.bg) ? res.bg : [];
  const bgWordTotal = bgEntries.reduce((n, e) => n + ((e.words && e.words.length) || 0), 0);
  console.log('    bg entries=' + bgEntries.length + ' bgWords=' + bgWordTotal
    + ' standalone=' + bgEntries.filter((e) => e.standalone).length);
  check('每个 x-bg 行都产出 bg 条目 (35)', bgEntries.length === 35, bgEntries.length);
  check('bg 内部词级时间全部保留 (180)', bgWordTotal === 180, bgWordTotal);
  check('bg 文本非空', bgEntries.every((e) => typeof e.text === 'string' && e.text.length > 0));
  check('bg 不伪造时间 (无自身的 t 时保持 null)', bgEntries.every((e) => e.t == null || isFinite(Number(e.t))));
  check('bg 与主歌词互不污染 (bg 文本不在 lyric 中)', bgEntries.every((e) => !res.lyric.includes(e.text)), 'bg text leaked into lyric');
  check('bg 不是翻译 (tlyric 不含 bg 文本)', !res.tlyric || bgEntries.every((e) => !res.tlyric.includes(e.text)));
  check('主歌词行数不受 bg 影响 (72)', res.lyric.split('\n').length === 72, res.lyric.split('\n').length);

  // ---------- TEST 8: localization / 官方翻译 ----------
  // 注意语义 (v2): localizationLanguage 是 <translation xml:lang> (目标语言);
  //   localizationSameAsOriginal 只描述 body 是否等于原文 (官方翻译在 head/translations 里,
  //   因此 body 相同**不代表**没有翻译)。翻译是否能产出, 由 translationEntries/tlyric 判定。
  console.log('');
  console.log('[TEST 8] localization / 官方翻译 (独立解析)');
  console.log('    lyricsLanguage=' + (res.lyricsLanguage || res.language || 'n/a')
    + ' localizationLanguage=' + (res.localizationLanguage || 'n/a')
    + ' schemaVersion=' + (res.schemaVersion || '-')
    + ' tableFound=' + (stats.localizationTableFound === true)
    + ' entries=' + (stats.translationEntries || 0)
    + ' tlyricLines=' + (stats.translationLines || 0));
  check('localization body 已被独立解析 (72 行)', stats.localizationLines === 72, stats.localizationLines);
  check('原歌词语言为 en', (res.lyricsLanguage || res.language) === 'en', res.lyricsLanguage || res.language);
  check('本地化请求带目标语言参数 (l=zh-Hans)',
    /[?&]l=zh-Hans/.test(webLyrics.buildLocalizationUrl('https://amp-api.music.apple.com/v1/catalog/cn/songs/1/syllable-lyrics')));
  check('schema 版本为 3 (v3 = bg 译文分离)', res.schemaVersion === 3, res.schemaVersion);
  check('bg 译文与主译文分离 (bg 条目的 translation 不含于 tlyric)',
    (res.bg || []).every((e) => !e.translation || !String(res.tlyric || '').includes(e.translation)));
  if (stats.localizationLanguageMatched) {
    // Apple 这首歌确实有目标中文翻译 -> 必须产出 tlyric, 且语言来自 <translation xml:lang>
    check('命中目标语言 -> localizationLanguage=zh-Hans', res.localizationLanguage === 'zh-Hans', res.localizationLanguage);
    check('命中目标语言 -> 产出翻译 (tlyric)', !!res.tlyric);
    check('翻译条数与原文行数一致', String(res.tlyric || '').split('\n').filter((l) => l.trim()).length === 72,
      String(res.tlyric || '').split('\n').filter((l) => l.trim()).length);
    check('翻译不含 bg 背景人声文本', bgEntries.every((e) => !String(res.tlyric || '').includes(e.text)));
    check('原文不被翻译覆盖 (lyric 仍为英文原文)', !String(res.tlyric || '').split('\n').every((l) => res.lyric.includes(l)));
  } else {
    check('未命中目标语言 -> 不得产出翻译 (留待其它源补)', !res.tlyric && !stats.translationLanguageMatched);
  }
  check('原文不依赖翻译 (translation 失败也有 original)', !!res.lyric && !!res.yrc);

  // ---------- 生产路径: handleAppleLyric 走 Web provider ----------
  console.log('');
  console.log('[集成] handleAppleLyric (生产路径, 已注入凭证)');
  const viaApi = await appleApi.handleAppleLyric('', {
    title: 'HUMBLE.',
    artist: 'Kendrick Lamar',
    album: 'DAMN.',
    durationSec: 177,
  });
  console.log('    source=' + viaApi.source + ' matchedBy=' + (viaApi.matchedBy || '-') + ' lines=' + (viaApi.lineCount || '-'));
  check('handleAppleLyric -> source=apple-web', viaApi.source === 'apple-web', viaApi.source);
  check('handleAppleLyric 返回 yrc (词级)', !!viaApi.yrc);
  check('handleAppleLyric 返回 lyric', !!viaApi.lyric);
  check('handleAppleLyric 不含 token', !JSON.stringify(viaApi).includes(token));

  // ---------- TEST 9: 403 (无效 media-user-token) 不得清空/不得抛错 ----------
  console.log('');
  console.log('[TEST 9] 无效凭证 (期望 403 分类, 且不返回歌词)');
  webLyrics.resetForTests();
  webLyrics.setCredentialSource(() => 'invalid-token-for-integration-check');
  const bad = await webLyrics.fetchWebLyrics({ songId: args.song, storefront: args.storefront, title: 'HUMBLE.', artist: 'Kendrick Lamar' });
  console.log('    code=' + bad.error + ' detail=' + (bad.detail || ''));
  check('ok=false', bad.ok === false);
  check('错误已分类 (403/404/无权限)', ['MEDIA_USER_TOKEN_REJECTED', 'LYRICS_NOT_FOUND', 'BEARER_AUTH_FAILED', 'CREDENTIAL_MISSING'].indexOf(bad.error) >= 0, bad.error);
  check('无效凭证不返回任何歌词 (不会清空已有歌词)', !bad.lyric && !bad.yrc);

  // ---------- TEST 10: 404 / song id 找不到 ----------
  console.log('');
  console.log('[TEST 10] 不存在的 songId -> LYRICS_NOT_FOUND, 不抛错');
  webLyrics.setCredentialSource(() => token);
  webLyrics.resetForTests();
  const missing = await webLyrics.fetchWebLyrics({ songId: '999999999999', storefront: args.storefront, title: 'x', artist: 'y' });
  console.log('    code=' + missing.error + ' detail=' + (missing.detail || ''));
  check('ok=false', missing.ok === false);
  check('分类为 LYRICS_NOT_FOUND 或 SONG_ID_NOT_FOUND', ['LYRICS_NOT_FOUND', 'SONG_ID_NOT_FOUND'].indexOf(missing.error) >= 0, missing.error);
  check('不返回任何歌词', !missing.lyric && !missing.yrc);

  // 生产路径不能因为 Web provider 失败而报错 (必须回落到本地缓存语义)
  const fallback = await appleApi.handleAppleLyric('999999999999', { title: 'x', artist: 'y' });
  check('handleAppleLyric 失败时仍返回合法结构 (回落本地缓存)', fallback && typeof fallback.lyric === 'string' && fallback.provider === 'apple', fallback && fallback.source);

  // ---------- token 泄漏检查 ----------
  console.log('');
  console.log('[TEST 11] token 泄漏检查');
  const collected = [noCred, status, res, viaApi, bad, missing, fallback];
  const leaked = collected.some((o) => JSON.stringify(o || {}).includes(token));
  check('所有返回值均不含 token', leaked === false);

  webLyrics.setCredentialSource(null);
  webLyrics.resetForTests();
  console.log('\n结果: pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('集成测试异常: ' + (e && e.message));
  process.exit(2);
});
