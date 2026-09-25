'use strict';
// ============================================================
// scripts/apple-music-web-lyrics-poc.js
//
// 第二阶段「只读 PoC」: 验证 MineRadio 已保存的 media-user-token
// 能否配合 Apple Music Web Player 的 Bearer Token, 读取官方 syllable lyrics。
//
// 本文件是一个**独立脚本**, 不属于 MineRadio 运行时的一部分:
//   - 不注册 IPC, 不改 server.js, 不改任何歌词 provider / 搜索链 / UI。
//   - 不修改凭证: token 只从第一阶段提供的 credential API 读取 (Electron 模式),
//     或由 --media-user-token 显式传入 (临时 QA 用)。
//   - 绝不打印 token; 绝不打印完整歌词; 不回写任何 MineRadio 配置。
//
// 两种运行方式 (同一个文件):
//   node     scripts/apple-music-web-lyrics-poc.js [options]   # 纯 node: 无凭证访问能力
//   electron scripts/apple-music-web-lyrics-poc.js [options]   # 经 credential API 取 token
//
// 端点来源: 实测 Apple Music Web 主 bundle 的请求构造 (非猜测):
//   GET /v1/catalog/{storefront}/songs/{id}
//       ?include=albums,artists,credits,lyrics,music-videos
//       &extend=lyricsExcerpt,offers
//   TTML 位于 resources.lyrics[0].attributes.ttml
// 对照保留旧公开路径 (可能已下线):
//   GET /v1/catalog/{storefront}/songs/{id}/lyrics
//   GET /v1/catalog/{storefront}/songs/{id}/syllable-lyrics
//
// 已知门控 (来自同一 bundle):
//   capabilities 中的 "catalogLyricsViewing" 仅当
//   hasMediaUserToken && userStorefront === 请求 storefront 时才授予。
// ============================================================

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const WEB_ORIGIN = 'https://music.apple.com';
const AMP_API = 'https://amp-api.music.apple.com';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// 默认测试曲目: HUMBLE. (us) — 实测 attributes.hasTimeSyncedLyrics=true
const DEFAULT_SONG_ID = '1440882165';
const BEARER_EXP_SKEW_SEC = 300;
const REQUEST_TIMEOUT_MS = 30000;

const isElectron = !!process.versions.electron;

// ------------------------------------------------------------
// 输出安全: 任何打印都先过 redact, 保证 token 永不落日志
// ------------------------------------------------------------
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g;
function redact(value) {
  return String(value == null ? '' : value).replace(JWT_RE, '[REDACTED-JWT]');
}
const out = (line) => process.stdout.write(redact(line) + '\n');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------
// HTTP
// ------------------------------------------------------------
function httpGet(url, headers, redirectsLeft) {
  const left = typeof redirectsLeft === 'number' ? redirectsLeft : 5;
  return new Promise((resolve, reject) => {
    let u = null;
    try { u = new URL(url); } catch (e) { reject(new Error('BAD_URL')); return; }
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: Object.assign({ 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' }, headers || {}),
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        resolve(httpGet(next, headers, left - 1));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '');
        try {
          if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
          else if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
          else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
        } catch (_) { /* 保持原始字节 */ }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: buf.toString('utf8'),
          finalUrl: url,
        });
      });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('TIMEOUT')));
    req.end();
  });
}

// ------------------------------------------------------------
// Bearer (Apple Music Web Player developer token)
// 自动获取 / 内存缓存 / 按 JWT exp 过期 / 401 时刷新一次
// 不持久化, 不写日志
// ------------------------------------------------------------
const bearerCache = { token: '', exp: 0, bundleRef: '', fetchedAt: 0 };

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const dec = (s) => {
    try {
      const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
      return JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8'));
    } catch (_) { return null; }
  };
  const header = dec(parts[0]);
  const payload = dec(parts[1]);
  if (!header || !payload) return null;
  return { header, payload };
}

function bearerSummary() {
  const d = decodeJwtPayload(bearerCache.token);
  if (!d) return { available: false };
  const now = Math.floor(Date.now() / 1000);
  return {
    available: !!bearerCache.token,
    iss: d.payload.iss,
    alg: d.header.alg,
    kid: d.header.kid ? String(d.header.kid).slice(0, 4) + '***' : undefined,
    exp: d.payload.exp,
    validDays: d.payload.exp ? Math.round((d.payload.exp - now) / 86400) : null,
    expired: d.payload.exp ? d.payload.exp < now : null,
    bundleRef: bearerCache.bundleRef,
  };
}

async function fetchWebPlayerBearer(storefront) {
  const pageUrl = WEB_ORIGIN + '/' + storefront + '/browse';
  const page = await httpGet(pageUrl);
  if (page.status !== 200) throw new Error('WEB_PAGE_HTTP_' + page.status);
  const m = page.body.match(/<script[^>]+type="module"[^>]+src="(\/assets\/index[^"]+\.js)"/);
  if (!m) throw new Error('MAIN_BUNDLE_REF_NOT_FOUND');
  const bundle = await httpGet(WEB_ORIGIN + m[1]);
  if (bundle.status !== 200) throw new Error('BUNDLE_HTTP_' + bundle.status);
  const candidates = new Set();
  let hit = null;
  let x = null;
  JWT_RE.lastIndex = 0;
  while ((x = JWT_RE.exec(bundle.body))) candidates.add(x[0]);
  for (const c of candidates) {
    const d = decodeJwtPayload(c);
    if (d && d.payload && d.payload.iss === 'AMPWebPlay') { hit = { token: c, exp: d.payload.exp || 0 }; break; }
  }
  if (!hit) throw new Error('AMPWEBPLAY_JWT_NOT_FOUND');
  bearerCache.token = hit.token;
  bearerCache.exp = hit.exp;
  bearerCache.bundleRef = m[1];
  bearerCache.fetchedAt = Date.now();
  return bearerCache;
}

async function getBearer(storefront, forceRefresh) {
  const now = Math.floor(Date.now() / 1000);
  const fresh = bearerCache.token && bearerCache.exp - now > BEARER_EXP_SKEW_SEC;
  if (fresh && !forceRefresh) return bearerCache;
  return fetchWebPlayerBearer(storefront);
}

// ------------------------------------------------------------
// 凭证: 只经第一阶段的 credential API (Electron 模式)
// ------------------------------------------------------------
async function resolveCredential(cliToken, skip, cliTokenFile) {
  if (skip) return { configured: false, source: 'skipped(--no-user-token)', token: '' };
  if (cliToken) return { configured: true, source: 'cli-flag(QA fallback)', token: cliToken };
  if (cliTokenFile) {
    // 从文件读取, 避免 token 出现在命令行 / 进程列表里。只读取, 不复制、不打印。
    try {
      const fromFile = fs.readFileSync(cliTokenFile, 'utf8').trim();
      if (!fromFile) return { configured: false, source: 'token-file-empty', token: '' };
      return { configured: true, source: 'token-file(QA fallback)', token: fromFile };
    } catch (e) {
      return { configured: false, source: 'token-file-unreadable(' + String((e && e.code) || 'error') + ')', token: '' };
    }
  }
  if (!isElectron) {
    return { configured: false, source: 'unavailable-in-plain-node', token: '' };
  }
  const electron = require('electron');
  const app = electron.app;
  const safeStorage = electron.safeStorage;
  await app.whenReady();
  const pkg = require('../package.json');
  const appName = process.env.MINERADIO_RUNTIME_NAME
    || (pkg.mineradio && pkg.mineradio.runtimeName)
    || pkg.productName
    || 'Mineradio';
  const qaDir = String(process.env.MINERADIO_STARTUP_QA_USER_DATA || '').trim();
  const useQa = process.env.MINERADIO_STARTUP_QA_HIDDEN === '1' && qaDir && path.isAbsolute(qaDir);
  const userData = useQa ? qaDir : path.join(app.getPath('appData'), appName);
  const mod = require('../desktop/apple-music-lyrics-credential');
  const store = mod.createAppleMusicLyricsCredentialStore({
    filePath: path.join(userData, mod.CREDENTIAL_FILE_NAME),
    safeStorage,
  });
  const status = store.getStatus();
  const token = store.readTokenForMainProcess();
  return { configured: !!status.configured, updatedAt: status.updatedAt || '', source: 'credential-api', token };
}

// ------------------------------------------------------------
// HTTP 错误分类 (按要求逐类区分, 不做"统一失败")
// ------------------------------------------------------------
function classifyStatus(status) {
  if (status === 401) return 'BEARER_AUTH_FAILED';
  if (status === 403) return 'MEDIA_USER_TOKEN_REJECTED';
  if (status === 404) return 'LYRICS_NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'APPLE_API_UNAVAILABLE';
  if (status !== 200) return 'HTTP_' + status;
  return 'OK';
}

// 带 401 刷新一次 / 429 延迟一次重试的 GET
async function apiGet(url, ctx, allowRetry) {
  const retry = allowRetry !== false;
  const headers = {
    Authorization: 'Bearer ' + bearerCache.token,
    Origin: WEB_ORIGIN,
    Referer: WEB_ORIGIN + '/',
    Accept: 'application/json',
  };
  if (ctx.credential && ctx.credential.token) headers['media-user-token'] = ctx.credential.token;

  let res = null;
  try {
    res = await httpGet(url, headers);
  } catch (e) {
    return { status: 0, code: 'APPLE_API_UNAVAILABLE', detail: String(e && e.message || e), body: '', retried: false };
  }
  if (res.status === 401 && retry) {
    out('    [401] Bearer 被拒 -> 刷新一次 Bearer 后重试');
    try { await getBearer(ctx.storefront, true); } catch (e) {
      return { status: res.status, code: 'BEARER_AUTH_FAILED', detail: 'refresh failed: ' + String(e && e.message || e), body: res.body, retried: true };
    }
    const again = await apiGet(url, ctx, false);
    again.retried = true;
    if (again.status === 401) again.code = 'BEARER_AUTH_FAILED';
    return again;
  }
  if (res.status === 429 && retry) {
    out('    [429] 限流 -> 延迟 2s 重试一次');
    await sleep(2000);
    const again = await apiGet(url, ctx, false);
    again.retried = true;
    return again;
  }
  return { status: res.status, code: classifyStatus(res.status), body: res.body, headers: res.headers, retried: false };
}

// ------------------------------------------------------------
// TTML 解析 (验证 <p begin end> + <span begin end> 是否真的可取)
// ------------------------------------------------------------
function ttmlTimeToSeconds(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return NaN;
  const m = s.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function decodeEntities(text) {
  return String(text == null ? '' : text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function attrOf(attrs, name) {
  const m = String(attrs || '').match(new RegExp(name + '\\s*=\\s*"([^"]*)"'));
  return m ? m[1] : '';
}

function parseTtml(xml) {
  const lines = [];
  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let pm = null;
  while ((pm = pRe.exec(xml))) {
    const attrs = pm[1];
    const inner = pm[2];
    const begin = ttmlTimeToSeconds(attrOf(attrs, 'begin'));
    const end = ttmlTimeToSeconds(attrOf(attrs, 'end'));
    const segments = [];
    const sRe = /<span\b([^>]*)>([\s\S]*?)<\/span>/g;
    let sm = null;
    while ((sm = sRe.exec(inner))) {
      const segBegin = ttmlTimeToSeconds(attrOf(sm[1], 'begin'));
      const segEnd = ttmlTimeToSeconds(attrOf(sm[1], 'end'));
      segments.push({ text: stripTags(sm[2]), startTime: segBegin, endTime: segEnd });
    }
    lines.push({ begin, end, text: stripTags(inner), segments });
  }
  // 没有 <p> 时退化为按 <span> 统计, 便于判断是否只是结构不同
  const spanCount = (xml.match(/<span\b/g) || []).length;
  return { lines, spanCount };
}

function extractTtml(json) {
  const d0 = ((json || {}).data || [])[0] || {};
  const rel = (d0.relationships || {}).lyrics;
  const relData = rel && Array.isArray(rel.data) ? rel.data : null;
  if (relData && relData.length) {
    const at = relData[0].attributes || {};
    return { ttml: String(at.ttml || ''), from: 'relationships.lyrics[0].attributes.ttml', attrKeys: Object.keys(at) };
  }
  const at = d0.attributes || {};
  if (at.ttml) return { ttml: String(at.ttml), from: 'data[0].attributes.ttml', attrKeys: Object.keys(at) };
  return { ttml: '', from: '', attrKeys: Object.keys(at) };
}

function decodeMaybeBase64Ttml(raw) {
  const s = String(raw || '');
  if (!s) return { xml: '', b64: false };
  if (s.trim().startsWith('<')) return { xml: s, b64: false };
  try {
    const d = Buffer.from(s, 'base64').toString('utf8');
    if (d.trim().startsWith('<')) return { xml: d, b64: true };
  } catch (_) {}
  return { xml: s, b64: false };
}

function summarizeTtml(raw) {
  const dec = decodeMaybeBase64Ttml(raw);
  const parsed = parseTtml(dec.xml);
  let numericSegments = 0;
  let numericLines = 0;
  let segTextNonEmpty = 0;
  parsed.lines.forEach((l) => {
    if (Number.isFinite(l.begin) && Number.isFinite(l.end)) numericLines += 1;
    l.segments.forEach((s) => {
      if (Number.isFinite(s.startTime) && Number.isFinite(s.endTime)) numericSegments += 1;
      if (s.text) segTextNonEmpty += 1;
    });
  });
  return {
    base64: dec.b64,
    xmlLen: dec.xml.length,
    hasTtmlTag: dec.xml.includes('<tt'),
    lines: parsed.lines.length,
    segments: parsed.spanCount,
    numericLines,
    numericSegments,
    segmentsWithText: segTextNonEmpty,
    localizationTags: (dec.xml.match(/<text\b[^>]*xml:lang|<translation/gi) || []).length,
    firstLineText: parsed.lines[0] ? parsed.lines[0].text : '',
    sample: parsed.lines.slice(0, 2).map((l) => ({
      begin: l.begin,
      end: l.end,
      textLen: l.text.length,
      segments: l.segments.length,
      seg0: l.segments[0] ? { startTime: l.segments[0].startTime, endTime: l.segments[0].endTime, textLen: l.segments[0].text.length } : null,
    })),
  };
}

// ttmlLocalizations 实测是**一段独立 TTML 字符串** (不是语言->文本字典)。
// 这里解析它并读取 xml:lang, 用于判断"翻译/本地化歌词时间轴"是否真的可用。
function localizationInfo(raw) {
  const value = typeof raw === 'string' ? raw : '';
  if (!value) return { available: false, language: '', lines: 0, segments: 0, xmlLen: 0 };
  const dec = decodeMaybeBase64Ttml(value);
  const summary = summarizeTtml(value);
  const langMatch = dec.xml.match(/xml:lang="([^"]+)"/i);
  return {
    available: true,
    language: langMatch ? langMatch[1] : '',
    lines: summary.lines,
    segments: summary.segments,
    xmlLen: dec.xml.length,
  };
}

// ------------------------------------------------------------
// 主流程
// ------------------------------------------------------------
function parseArgs(argv) {
  const args = { song: DEFAULT_SONG_ID, storefront: 'auto', token: '', tokenFile: '', noUserToken: false, dump: '', json: false, showSample: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--song') args.song = String(argv[++i] || '');
    else if (a === '--storefront') args.storefront = String(argv[++i] || '');
    else if (a === '--media-user-token') args.token = String(argv[++i] || '');
    else if (a === '--media-user-token-file') args.tokenFile = String(argv[++i] || '');
    else if (a === '--no-user-token') args.noUserToken = true;
    else if (a === '--dump') args.dump = String(argv[++i] || '');
    else if (a === '--json') args.json = true;
    else if (a === '--show-sample') args.showSample = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function assertDumpPathSafe(dumpPath) {
  const resolved = path.resolve(dumpPath);
  if (/AppleInc\.AppleMusicWin/i.test(resolved)) throw new Error('拒绝写入 Apple Music 目录');
  const appData = process.env.APPDATA || '';
  if (appData && resolved.toLowerCase().startsWith(path.resolve(appData).toLowerCase())) {
    throw new Error('拒绝写入 MineRadio 正式 userData 目录');
  }
  return resolved;
}

// 账号 home storefront 优先: Apple 只在 账号 storefront == 请求 storefront 时授予
// catalogLyricsViewing; 不匹配时歌词资源会**静默缺失** (表现为 404 / 无 lyrics 关联)。
async function resolveStorefront(requested, userToken) {
  if (requested && requested !== 'auto') return { storefront: requested, source: 'cli-flag' };
  // 实测: /v1/me/account 只返回 avatarArtwork/restrictions, **不含 storefront**, 因此
  // 账号 home storefront 无法直接查询。用页面 geo 重定向作为近似值; 若不匹配, 必须用
  // --storefront 显式指定, 否则歌词资源会静默缺失 (400/404 / 无 lyrics 关联)。
  try {
    const page = await httpGet(WEB_ORIGIN + '/browse');
    const m = String(page.finalUrl || '').match(/music\.apple\.com\/([a-z]{2})(?:\/|$)/i);
    if (m) return { storefront: m[1].toLowerCase(), source: 'geo-redirect' };
  } catch (_) {}
  return { storefront: 'us', source: 'default' };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    out('用法: node|electron scripts/apple-music-web-lyrics-poc.js [--song <id>] [--storefront <sf|auto>]');
    out('      [--media-user-token <token>] [--media-user-token-file <file>] [--no-user-token]');
    out('      [--dump <file>] [--json] [--show-sample]');
    return;
  }

  const dumpPath = args.dump ? assertDumpPathSafe(args.dump) : '';
  const rawDump = {};

  out('=== Apple Music Web Lyrics PoC (只读验证) ===');
  out('runtime: ' + (isElectron ? 'electron (可访问 credential API)' : 'node (无法访问 credential API)'));

  // --- A) 凭证 ---
  let credential = { configured: false, source: 'unknown', token: '' };
  try {
    credential = await resolveCredential(args.token, args.noUserToken, args.tokenFile);
  } catch (e) {
    credential = { configured: false, source: 'error:' + String(e && e.message || e), token: '' };
  }
  out('[A] media-user-token: configured=' + credential.configured + ' source=' + credential.source);

  // --- B) Bearer (先取, 因为账号 storefront 查询也需要它) ---
  out('[B] 获取 Web Player Bearer ...');
  const seedStorefront = (args.storefront && args.storefront !== 'auto') ? args.storefront : 'us';
  try {
    await getBearer(seedStorefront, false);
  } catch (e) {
    out('    bearer: FAIL (' + String(e && e.message || e) + ')');
    out('    -> 结论: BEARER_AUTH_FAILED (无法自动获取 Web Player token)');
    return;
  }
  const bs = bearerSummary();
  out('    bearer: available=' + bs.available + ' iss=' + bs.iss + ' alg=' + bs.alg + ' validDays=' + bs.validDays + ' bundle=' + bs.bundleRef);

  // --- storefront (必须与账号 home storefront 一致, 否则歌词资源静默缺失) ---
  const sfResolved = await resolveStorefront(args.storefront, credential.token);
  const storefront = sfResolved.storefront;
  const songId = String(args.song || DEFAULT_SONG_ID);
  out('[sf] storefront=' + storefront + ' (source=' + sfResolved.source + ')');
  out('[song] id=' + songId);

  // --- 凭证接受度: 区分 "token 无效" 与 "该 storefront 没有歌词资源" ---
  if (credential.token) {
    const acc = await apiGet(AMP_API + '/v1/me/account', { credential, storefront, songId }, false);
    out('[cred] /v1/me/account -> HTTP ' + acc.status + ' (' + (acc.status === 200 ? 'media-user-token 被 Apple 接受' : acc.code) + ')');
  } else {
    out('[cred] 未配置 media-user-token -> 歌词资源很可能不返回 (Apple 仅在 hasMediaUserToken && 账号 storefront == 请求 storefront 时授予 catalogLyricsViewing)');
  }

  const ctx = { credential, storefront, songId };
  const userTokenNote = credential.token ? 'with media-user-token' : 'WITHOUT media-user-token';

  // --- C/D/E/F) 基础歌词实验 ---
  out('');
  out('[C/D/E/F] 基础歌词 (' + userTokenNote + ')');
  const experiments = [];

  const includeUrl = AMP_API + '/v1/catalog/' + storefront + '/songs/' + songId
    + '?include=albums,artists,credits,lyrics,music-videos&extend=lyricsExcerpt,offers'
    + '&fields[artists]=name,url&fields[albums]=artistName,artistUrl,artwork,name,url';
  {
    const r = await apiGet(includeUrl, ctx, true);
    let detail = 'code=' + r.code;
    let ttmlSummary = null;
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        const d0 = (j.data || [])[0] || {};
        const at = d0.attributes || {};
        const hasLyricsRel = !!((d0.relationships || {}).lyrics);
        const ext = extractTtml(j);
        detail = 'hasLyrics=' + at.hasLyrics + ' hasTimeSyncedLyrics=' + at.hasTimeSyncedLyrics
          + ' lyricsRelationship=' + hasLyricsRel + ' ttmlFrom=' + (ext.from || 'none');
        if (ext.ttml) ttmlSummary = summarizeTtml(ext.ttml);
      } catch (e) { detail += ' parse-error'; }
    }
    out('  [include=lyrics] HTTP ' + r.status + ' -> ' + detail);
    if (ttmlSummary) {
      out('      ttml: lines=' + ttmlSummary.lines + ' segments=' + ttmlSummary.segments
        + ' numericLines=' + ttmlSummary.numericLines + ' numericSegments=' + ttmlSummary.numericSegments
        + ' segmentsWithText=' + ttmlSummary.segmentsWithText + ' base64=' + ttmlSummary.base64);
    }
    experiments.push({ name: 'include=lyrics', status: r.status, code: r.code, ttml: ttmlSummary, detail });
    rawDump['include=lyrics'] = r.body;
  }

  for (const sub of ['lyrics', 'syllable-lyrics']) {
    const url = AMP_API + '/v1/catalog/' + storefront + '/songs/' + songId + '/' + sub;
    const r = await apiGet(url, ctx, true);
    let ttmlSummary = null;
    let detail = 'code=' + r.code;
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        const ext = extractTtml(j);
        detail = 'ttmlFrom=' + (ext.from || 'none') + ' attrKeys=' + JSON.stringify(ext.attrKeys);
        if (ext.ttml) ttmlSummary = summarizeTtml(ext.ttml);
      } catch (e) { detail += ' parse-error'; }
    } else {
      try {
        const j = JSON.parse(r.body);
        const err = ((j.errors || [])[0] || {});
        detail = 'code=' + r.code + ' title=' + JSON.stringify(err.title || '') + ' detail=' + JSON.stringify(err.detail || '');
      } catch (_) {}
    }
    out('  [/' + sub + '] HTTP ' + r.status + ' -> ' + detail);
    if (ttmlSummary) {
      out('      ttml: lines=' + ttmlSummary.lines + ' segments=' + ttmlSummary.segments
        + ' numericSegments=' + ttmlSummary.numericSegments + ' base64=' + ttmlSummary.base64);
    }
    experiments.push({ name: sub, status: r.status, code: r.code, ttml: ttmlSummary, detail });
    rawDump[sub] = r.body;
  }

  const baseOk = experiments.some((e) => e.status === 200 && e.ttml && e.ttml.lines > 0);
  out('  base syllable lyrics: ' + (baseOk ? 'PASS' : 'FAIL'));

  // --- G) Localization (独立实验) ---
  out('');
  out('[G] localization (独立实验, 与上面互不影响)');
  const locExperiments = [];
  const locUrl = AMP_API + '/v1/catalog/' + storefront + '/songs/' + songId
    + '?include=lyrics&extend=ttmlLocalizations,lyricsExcerpt&l=en-US';
  {
    const r = await apiGet(locUrl, ctx, true);
    let detail = 'code=' + r.code;
    let info = null;
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        const d0 = (j.data || [])[0] || {};
        const rel = (d0.relationships || {}).lyrics;
        const relData = rel && Array.isArray(rel.data) ? rel.data : [];
        const at = relData.length ? (relData[0].attributes || {}) : {};
        info = localizationInfo(at.ttmlLocalizations);
        detail = 'lyricsRelationship=' + !!rel + ' ttmlLocalizations=' + info.available
          + (info.available ? ' language=' + (info.language || 'unknown') + ' lines=' + info.lines + ' segments=' + info.segments : '');
      } catch (e) { detail += ' parse-error'; }
    }
    out('  [include=lyrics&extend=ttmlLocalizations] HTTP ' + r.status + ' -> ' + detail);
    locExperiments.push({ name: 'include+localizations', status: r.status, code: r.code, info });
    rawDump['localizations-include'] = r.body;
  }
  {
    const r = await apiGet(AMP_API + '/v1/catalog/' + storefront + '/songs/' + songId + '/syllable-lyrics?extend=ttmlLocalizations', ctx, true);
    let detail = 'code=' + r.code;
    let info = null;
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        const at = (((j.data || [])[0] || {}).attributes) || {};
        info = localizationInfo(at.ttmlLocalizations);
        detail = 'ttmlLocalizations=' + info.available
          + (info.available ? ' language=' + (info.language || 'unknown') + ' lines=' + info.lines + ' segments=' + info.segments : '');
      } catch (e) { detail += ' parse-error'; }
    }
    out('  [syllable-lyrics?extend=ttmlLocalizations] HTTP ' + r.status + ' -> ' + detail);
    locExperiments.push({ name: 'syllable-lyrics+localizations', status: r.status, code: r.code, info });
    rawDump['localizations-syllable'] = r.body;
  }
  const locOk = locExperiments.some((e) => e.status === 200 && e.info && e.info.available);
  const locDetail = locExperiments
    .filter((e) => e.info && e.info.available)
    .map((e) => (e.info.language || 'unknown') + ' (' + e.info.lines + ' lines / ' + e.info.segments + ' seg)')
    .join(', ');
  out('  localization: ' + (locOk ? 'PASS language=' + locDetail : 'FAIL'));

  // --- 解析抽样 (默认不打印歌词文本) ---
  // 优先抽样 segment 最多的实验 —— 那才是"逐词时间轴"本身 (纯歌词的 segments 为 0)。
  const parsed = experiments.filter((e) => e.ttml).sort((a, b) => b.ttml.segments - a.ttml.segments)[0];
  if (parsed) {
    out('');
    out('[解析抽样] (' + parsed.name + ')');
    parsed.ttml.sample.forEach((l, i) => {
      out('  line[' + i + '] begin=' + l.begin + ' end=' + l.end + ' textLen=' + l.textLen + ' segments=' + l.segments
        + (l.seg0 ? ' seg0.startTime=' + l.seg0.startTime + ' seg0.endTime=' + l.seg0.endTime + ' seg0.textLen=' + l.seg0.textLen : ''));
    });
    if (args.showSample) {
      // 默认不打印歌词文本; 只有显式 --show-sample 时才打印首行 (仍非完整歌词)
      out('  (--show-sample) 首行文本: ' + redact(parsed.ttml.firstLineText));
    }
  }

  if (dumpPath) {
    const payload = {
      generatedAt: new Date().toISOString(),
      songId,
      storefront,
      credential: { configured: credential.configured, source: credential.source },
      bearer: { iss: bs.iss, alg: bs.alg, validDays: bs.validDays },
      experiments: experiments.map((e) => ({ name: e.name, status: e.status, code: e.code, detail: e.detail })),
      localizations: locExperiments.map((e) => ({ name: e.name, status: e.status, code: e.code, info: e.info })),
      raw: rawDump,
    };
    fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
    fs.writeFileSync(dumpPath, JSON.stringify(payload, null, 2), 'utf8');
    out('');
    out('[dump] 原始响应已写入 QA 临时文件: ' + dumpPath);
  }

  // --- 结论 ---
  out('');
  out('=== 结论 ===');
  out('Bearer 获取:      ' + (bs.available ? 'PASS' : 'FAIL'));
  out('media-user-token: ' + (credential.configured ? 'configured' : 'missing') + ' (' + credential.source + ')');
  out('API:              HTTP ' + experiments.map((e) => e.name + '=' + e.status).join(', '));
  out('song:             ' + songId + ' / ' + storefront);
  out('syllable lyrics:  ' + (baseOk ? 'PASS' : 'FAIL'));
  out('localization:     ' + (locOk ? 'PASS (' + locDetail + ')' : 'FAIL'));
  if (!baseOk) {
    const unauthorized = experiments.some((e) => e.status === 401 || e.status === 403);
    const notFound = experiments.every((e) => e.status === 404 || e.status === 200);
    if (!credential.configured && notFound && !unauthorized) {
      out('失败原因: 未配置 media-user-token。Apple 的 capabilities 仅在');
      out('          hasMediaUserToken && 账号 storefront == 请求 storefront 时授予');
      out('          "catalogLyricsViewing", 否则歌词关联资源不返回 (404/缺失)。');
    } else if (unauthorized) {
      out('失败原因: 鉴权被拒 (见上方 401/403 分类)。未删除任何用户凭证。');
    } else {
      out('失败原因: 见上方逐条 HTTP 分类。');
    }
  }
  if (args.json) {
    out('');
    out('[json] ' + JSON.stringify({
      bearer: bs.available,
      credentialConfigured: credential.configured,
      baseSyllableLyrics: baseOk,
      localization: locOk,
      experiments: experiments.map((e) => ({ name: e.name, status: e.status, code: e.code, lines: e.ttml ? e.ttml.lines : 0, segments: e.ttml ? e.ttml.segments : 0 })),
    }));
  }
}

// ------------------------------------------------------------
// 启动: Electron 模式需要 app.whenReady() 由 resolveCredential 内部处理
// ------------------------------------------------------------
// 等 stdout 真正落盘再退出, 避免重定向/管道下输出被截断。
function finish(delayMs) {
  setTimeout(() => process.exit(0), typeof delayMs === 'number' ? delayMs : 200);
}
if (isElectron) {
  const { app } = require('electron');
  run()
    .catch((e) => { out('PoC 异常: ' + String(e && e.message || e)); })
    .then(() => { try { app.quit(); } catch (_) {} finish(400); });
} else {
  run()
    .catch((e) => { out('PoC 异常: ' + String(e && e.message || e)); })
    .then(() => finish(150));
}
