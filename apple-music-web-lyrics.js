'use strict';

// ============================================================
// apple-music-web-lyrics.js
//
// Apple Music **Web 私有歌词** provider (只读)。
// 由 PoC (scripts/apple-music-web-lyrics-poc.js) 实测成功后转正。
//
// 认证链 (两级, 都不需要 Developer Token / Team ID / Key ID / .p8):
//   1) Web Player Bearer  : 自动从 music.apple.com 主 bundle 提取 iss=AMPWebPlay 的 JWT,
//                           内存缓存, 按 JWT exp 过期, 401 时刷新一次。
//   2) media-user-token   : 由主进程注入的 credential source 提供 (第一阶段凭证存储),
//                           本模块不落盘、不打印、不返回给 renderer。
//
// 端点:
//   GET /v1/catalog/{storefront}/songs/{songId}/syllable-lyrics
//       -> attributes.ttml             (词级 TTML; itunes:timing="Word")
//   GET .../syllable-lyrics?extend=ttmlLocalizations
//       -> attributes.ttmlLocalizations (注意: 该模式下 ttml 为空, 本地化是一整段 TTML 字符串,
//                                        不是 language->text 字典, 必须再次按 TTML 解析)
//
// 实测门控: Apple 仅在 hasMediaUserToken && 账号 storefront == 请求 storefront 时
//           授予 catalogLyricsViewing; 不匹配时歌词资源会**静默缺失**(404 / 无关联)。
//
// 输出: 直接产出 MineRadio 现有歌词契约 { lyric, tlyric, yrc, ytlrc }
//       - yrc  = [行起始ms,行长ms](词起始ms,词长ms,0)词文本...  (渲染层 parseYrcText 消费)
//       - tlyric/ytlrc = 本地化 TTML 独立解析后的翻译 (渲染层按时间匹配并自动滤除与原文相同的行)
//
// 本模块不注册 IPC、不改 UI、不碰 SMTC/音频/播放器。
// ============================================================

const https = require('https');
const zlib = require('zlib');

const WEB_ORIGIN = 'https://music.apple.com';
const AMP_API = 'https://amp-api.music.apple.com';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BEARER_EXP_SKEW_SEC = 300;
const WEB_TIMEOUT_MS = 12000;
const API_TIMEOUT_MS = 8000;
const LOCALIZATION_TIMEOUT_MS = 6000;
// 默认 storefront: 页面 geo 重定向优先 (与账号 home storefront 一致的概率最高), 否则用这个。
const DEFAULT_STOREFRONT = 'cn';

// ------------------------------------------------------------
// 官方翻译 (localization) 契约
//
// 实测 (song 1499378607 / storefront cn):
//   - 根 <tt xml:lang> **永远是原歌词语言** (本歌 = en); 翻译语言只能看
//     <translation xml:lang="…">, 不能看根语言。
//   - 不带 l= 参数时 <translations/> 是空的; 带 &l=zh-Hans 才会返回 35 条
//     <text for="Lxx"> 的简体中文翻译 (zh-CN / zh / zh-Hans-* 一律归一到 zh-Hans)。
//   - 翻译表在 <head>/<metadata>/<iTunesMetadata>/<translations> 里, 与原歌词 <body>
//     (含 x-bg 背景人声) 完全分离, 两者独立解析, 互不污染。
//
// schema 版本: v1 = 只解析 body (翻译恒为空); v2 = 解析 head/translations 官方翻译;
//            v3 = 官方翻译里的 x-bg 译文与主译文分离 (bg 条目新增 translation 字段)。
// 缓存层 (05-smtc-lyric-sources.js) 用它让旧版 apple-web 缓存失效一次;
// 修改解析产物结构时必须递增, 并同步 SMTC 侧常量。
// ------------------------------------------------------------
const APPLE_WEB_LYRICS_SCHEMA_VERSION = 3;
const TRANSLATION_TARGET_LANGUAGE = 'zh-Hans';
const TRANSLATION_LANGUAGE_ALIASES = {
  zh: 'zh-Hans',
  'zh-cn': 'zh-Hans',
  'zh-hans': 'zh-Hans',
  'zh-sg': 'zh-Hans',
  'zh-hans-cn': 'zh-Hans',
  'zh-hans-sg': 'zh-Hans',
  'zh-hant': 'zh-Hant',
  'zh-tw': 'zh-Hant',
  'zh-hk': 'zh-Hant',
  'zh-mo': 'zh-Hant',
  'zh-hant-tw': 'zh-Hant',
  'zh-hant-hk': 'zh-Hant',
};
// Apple 返回的语言标签 -> 项目内使用的规范标签 (只做等价归并, 不引入全局语言系统)
function normalizeTranslationLanguage(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase().replace(/_/g, '-');
  if (!raw) return '';
  if (TRANSLATION_LANGUAGE_ALIASES[raw]) return TRANSLATION_LANGUAGE_ALIASES[raw];
  const base = raw.split('-')[0];
  if (base === 'zh') return TRANSLATION_LANGUAGE_ALIASES[raw] || (raw.indexOf('hant') >= 0 || raw.indexOf('tw') >= 0 || raw.indexOf('hk') >= 0 ? 'zh-Hant' : 'zh-Hans');
  return raw;
}
function isTargetTranslationLanguage(value) {
  return normalizeTranslationLanguage(value) === normalizeTranslationLanguage(TRANSLATION_TARGET_LANGUAGE);
}
// 本地化请求 URL (单独函数便于单测: 必须带目标语言参数, 否则 Apple 不返回翻译表)
function buildLocalizationUrl(baseLyricsUrl, targetLanguage) {
  const lang = String(targetLanguage || TRANSLATION_TARGET_LANGUAGE).trim() || TRANSLATION_TARGET_LANGUAGE;
  return String(baseLyricsUrl || '') + '?extend=ttmlLocalizations&l=' + encodeURIComponent(lang);
}

// 错误分类 (renderer 只会看到 code, 永远看不到 token)
const ERRORS = {
  CREDENTIAL_MISSING: 'CREDENTIAL_MISSING',
  BEARER_AUTH_FAILED: 'BEARER_AUTH_FAILED',
  MEDIA_USER_TOKEN_REJECTED: 'MEDIA_USER_TOKEN_REJECTED',
  LYRICS_NOT_FOUND: 'LYRICS_NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  APPLE_API_UNAVAILABLE: 'APPLE_API_UNAVAILABLE',
  TTML_PARSE_ERROR: 'TTML_PARSE_ERROR',
  SONG_ID_NOT_FOUND: 'SONG_ID_NOT_FOUND',
  NETWORK_ERROR: 'NETWORK_ERROR',
};

// ------------------------------------------------------------
// 依赖注入 (由主进程 / apple-music-api.js 提供, 便于纯 node 单测)
// ------------------------------------------------------------
let credentialSource = null;      // () => media-user-token | ''
let localSongIdResolver = null;   // ({title, artist, album}) => songId | ''
let bearerPrefetched = false;

function setCredentialSource(fn) {
  // 只做注入, 不做任何网络副作用; 预热由调用方显式 warmUpWebPlayerBearer()。
  credentialSource = typeof fn === 'function' ? fn : null;
}

function setLocalSongIdResolver(fn) {
  localSongIdResolver = typeof fn === 'function' ? fn : null;
}

// 只在主进程内部调用; 绝不放进任何 IPC 返回值。
function getCredential() {
  if (!credentialSource) return '';
  try {
    const token = credentialSource();
    return typeof token === 'string' ? token.trim() : '';
  } catch (_) {
    return '';
  }
}

function isConfigured() {
  return !!getCredential();
}

function resetForTests() {
  bearerCache.token = '';
  bearerCache.exp = 0;
  bearerCache.storefront = '';
  bearerCache.bundleRef = '';
  bearerCache.inflight = null;
  bearerPrefetched = false;
}

// ------------------------------------------------------------
// HTTP (只连 Apple 官方域名, 不走任何代理)
// ------------------------------------------------------------
function httpGet(url, headers, redirectsLeft, timeoutMs) {
  const left = typeof redirectsLeft === 'number' ? redirectsLeft : 5;
  const timeout = Number(timeoutMs) || API_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let u = null;
    try { u = new URL(url); } catch (_) { reject(new Error('BAD_URL')); return; }
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
        resolve(httpGet(next, headers, left - 1, timeout));
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
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString('utf8'), finalUrl: url });
      });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(timeout, () => req.destroy(new Error('TIMEOUT')));
    req.end();
  });
}

// ------------------------------------------------------------
// Web Player Bearer
// ------------------------------------------------------------
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g;
const bearerCache = { token: '', exp: 0, storefront: '', bundleRef: '', inflight: null };

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const pad = parts[1].length % 4 === 0 ? '' : '='.repeat(4 - (parts[1].length % 4));
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function bearerValid() {
  const now = Math.floor(Date.now() / 1000);
  return !!bearerCache.token && bearerCache.exp - now > BEARER_EXP_SKEW_SEC;
}

async function fetchWebPlayerBearer(preferredStorefront) {
  const sf = String(preferredStorefront || '').trim() || DEFAULT_STOREFRONT;
  const page = await httpGet(WEB_ORIGIN + '/' + sf + '/browse', {}, 5, WEB_TIMEOUT_MS);
  if (page.status !== 200) throw new Error('WEB_PAGE_HTTP_' + page.status);
  // 页面 geo 重定向后的 storefront 最接近账号 home storefront
  const geo = String(page.finalUrl || '').match(/music\.apple\.com\/([a-z]{2})(?:\/|$)/i);
  const m = String(page.body || '').match(/<script[^>]+type="module"[^>]+src="(\/assets\/index[^"]+\.js)"/);
  if (!m) throw new Error('MAIN_BUNDLE_REF_NOT_FOUND');
  const bundle = await httpGet(WEB_ORIGIN + m[1], {}, 5, WEB_TIMEOUT_MS);
  if (bundle.status !== 200) throw new Error('BUNDLE_HTTP_' + bundle.status);
  let hit = null;
  JWT_RE.lastIndex = 0;
  let x = null;
  while ((x = JWT_RE.exec(bundle.body))) {
    const payload = decodeJwtPayload(x[0]);
    if (payload && payload.iss === 'AMPWebPlay') { hit = { token: x[0], exp: payload.exp || 0 }; break; }
  }
  if (!hit) throw new Error('AMPWEBPLAY_JWT_NOT_FOUND');
  bearerCache.token = hit.token;
  bearerCache.exp = hit.exp;
  bearerCache.bundleRef = m[1];
  bearerCache.storefront = geo ? geo[1].toLowerCase() : sf;
  return bearerCache;
}

async function getWebPlayerBearer(forceRefresh, preferredStorefront) {
  if (bearerValid() && !forceRefresh) return bearerCache;
  if (bearerCache.inflight && !forceRefresh) return bearerCache.inflight;
  const p = fetchWebPlayerBearer(preferredStorefront || bearerCache.storefront)
    .finally(() => { if (bearerCache.inflight === p) bearerCache.inflight = null; });
  bearerCache.inflight = p;
  return p;
}

function warmUpWebPlayerBearer() {
  if (bearerPrefetched || bearerValid()) return Promise.resolve(bearerCache);
  bearerPrefetched = true;
  return getWebPlayerBearer(false).catch(() => null);
}

// ------------------------------------------------------------
// TTML: 容错 tokenizer + 树构建 (不依赖任何第三方 XML 库)
// 必须遍历**整个文档**的 span: 实测存在 p 内的词 span 与 x-bg span,
// 也必须是"任意层级"的 span 都能进词级时间轴。
// ------------------------------------------------------------
const TAG_OR_TEXT_RE = /<[^>]*>|[^<]+/g;

function decodeEntities(text) {
  return String(text == null ? '' : text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m = null;
  while ((m = re.exec(raw))) attrs[m[1].toLowerCase()] = decodeEntities(m[3] != null ? m[3] : m[4]);
  return attrs;
}

function buildTtmlTree(xml) {
  const root = { name: '#document', attrs: {}, children: [], parent: null };
  const stack = [root];
  const text = String(xml || '');
  TAG_OR_TEXT_RE.lastIndex = 0;
  let m = null;
  while ((m = TAG_OR_TEXT_RE.exec(text))) {
    const tok = m[0];
    if (!tok) continue;
    if (tok.charAt(0) !== '<') {
      stack[stack.length - 1].children.push({ name: '#text', text: decodeEntities(tok), children: [], parent: stack[stack.length - 1] });
      continue;
    }
    if (/^<\?/.test(tok) || /^<!/.test(tok)) continue;              // 声明 / 注释 / doctype
    const close = tok.match(/^<\s*\/\s*([A-Za-z_][\w:.-]*)/);
    if (close) {
      const name = close[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === name) { stack.length = i; break; }
      }
      continue;
    }
    const open = tok.match(/^<\s*([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/);
    if (!open) continue;
    const name = open[1].toLowerCase();
    const node = { name, attrs: parseAttrs(open[2] || ''), children: [], parent: stack[stack.length - 1] };
    stack[stack.length - 1].children.push(node);
    if (!open[3]) stack.push(node);
  }
  return root;
}

function ttmlTimeToSeconds(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return NaN;
  const m = s.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function roleOf(attrs) {
  const role = attrs && (attrs['ttm:role'] || attrs.role);
  return role ? String(role).toLowerCase() : '';
}

function spanHasTiming(attrs) {
  return Number.isFinite(ttmlTimeToSeconds(attrs.begin)) && Number.isFinite(ttmlTimeToSeconds(attrs.end));
}

function textOf(node) {
  let out = '';
  const walk = (n) => {
    if (!n) return;
    if (n.name === '#text') { out += n.text; return; }
    (n.children || []).forEach(walk);
  };
  (node.children || []).forEach(walk);
  return out;
}

// 把原始文本按"折叠空白 + 去首尾"归一化, 同时把 word 的原始区间映射到归一化后的区间,
// 保证 words 文本拼接后与行文本完全一致 (渲染层 line text = 各词文本拼接)。
// ------------------------------------------------------------
// TTML -> intermediate representation
//   lines[]: { begin, end, text, words[], backgroundTexts[], key, agent }
//   words[]: 全文档所有 begin+end 的 span  { text, begin, end, role, lineIndex }
//   background[]: 所有 ttm:role="x-bg" 的 span (保留, 不产普通时间词)
// ------------------------------------------------------------
// 逐字符折叠空白并追加 (与渲染层 parseYrcText 的空白处理保持一致)
function appendNormalized(state, value) {
  const s = String(value == null ? '' : value);
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charAt(i);
    if (/\s/.test(ch)) { state.pendingSpace = state.text.length > 0; continue; }
    if (state.pendingSpace) { state.text += ' '; state.pendingSpace = false; }
    state.text += ch;
  }
}

// 收集某个 x-bg 子树内部的词级时间 (实测 35 个 x-bg 内共 180 个 timed span)。
// 这些时间必须保留, 但按规范不能当作普通歌词词。
function gatherBackgroundWords(node) {
  const out = [];
  const walk = (n) => {
    (n.children || []).forEach((child) => {
      if (child.name !== 'span') return;
      const a = child.attrs || {};
      if (spanHasTiming(a)) {
        out.push({
          text: String(textOf(child) || '').replace(/\s+/g, ' ').trim(),
          begin: ttmlTimeToSeconds(a.begin),
          end: ttmlTimeToSeconds(a.end),
          role: 'x-bg',
        });
      }
      walk(child);
    });
  };
  walk(node);
  out.sort((x, y) => x.begin - y.begin);
  return out;
}

// 把 <p> 变成一行: 行文本增量构建, 每个词按 [c0,c1) 切片取文本。
// 关键不变式: 把 words[].text 依序拼接 === line.text
// (渲染层的行文本正是由各词文本拼接而来, 所以这个不变式决定了显示是否正确)。
function buildLineFromP(pNode) {
  const begin = ttmlTimeToSeconds(pNode.attrs.begin);
  const end = ttmlTimeToSeconds(pNode.attrs.end);
  const state = { text: '', pendingSpace: false };
  const words = [];
  const backgroundTexts = [];
  let untimedSpans = 0;

  // 标记自身与所有后代 span: 已被本行收录, 不再进入"孤儿 span"归属流程
  const markCollected = (node) => {
    (node.children || []).forEach((child) => {
      if (child.name !== 'span') return;
      child.__collected = true;
      markCollected(child);
    });
  };

  // 背景人声 (ttm:role="x-bg"): 整棵子树保留在 IR, 但不进入普通行文本与词级时间轴
  const collectBackground = (node, attrs) => {
    node.__bgCollected = true;
    markCollected(node);
    backgroundTexts.push({
      text: String(textOf(node) || '').replace(/\s+/g, ' ').trim(),
      begin: ttmlTimeToSeconds(attrs.begin),
      end: ttmlTimeToSeconds(attrs.end),
      role: roleOf(attrs) || 'x-bg',
      words: gatherBackgroundWords(node),
    });
  };

  // 递归遍历 <p> 的**所有层级**:
  // 实测 685 个词 span 中有 180 个位于 p 内的"无时间分组 span"里, 只遍历直接子节点会漏掉它们。
  // 无时间的普通 span 一律下钻 (它通常只是分组包装), 不能整体当成一段文本。
  const visit = (node) => {
    (node.children || []).forEach((child) => {
      if (child.name === '#text') { appendNormalized(state, child.text); return; }
      if (child.name === 'span') {
        const attrs = child.attrs || {};
        const role = roleOf(attrs);
        const timed = spanHasTiming(attrs);
        if (role === 'x-bg') { collectBackground(child, attrs); return; }
        if (timed) {
          child.__collected = true;
          markCollected(child);
          // 分隔空格必须算进本词的切片区间, 否则"各词拼接 === 行文本"不成立
          const c0 = state.text.length;
          if (state.pendingSpace && state.text.length) { state.text += ' '; state.pendingSpace = false; }
          appendNormalized(state, textOf(child));
          const c1 = state.text.length;
          words.push({
            text: state.text.slice(c0, c1),
            begin: ttmlTimeToSeconds(attrs.begin),
            end: ttmlTimeToSeconds(attrs.end),
            role: '',
            c0,
            c1,
          });
          return;
        }
        // 无时间的普通 span: 继续下钻 (不丢字, 也不制造假词)
        untimedSpans += 1;
        visit(child);
        return;
      }
      if (child.name === 'br') { appendNormalized(state, ' '); return; }
      visit(child);
    });
  };
  visit(pNode);
  return {
    begin,
    end,
    key: pNode.attrs['itunes:key'] || '',
    agent: pNode.attrs['ttm:agent'] || '',
    text: state.text,
    words,
    backgroundTexts,
    untimedSpans,
  };
}
function collectNodes(root, name, out, insideP) {
  (root.children || []).forEach((child) => {
    if (child.name === name) out.push({ node: child, insideP: !!insideP });
    collectNodes(child, name, out, insideP || child.name === 'p');
  });
  return out;
}

// 节点内的纯文本 (#text 子节点递归拼接)
function ttmlNodeText(node) {
  let out = '';
  (function walk(n) {
    (n.children || []).forEach((child) => {
      if (child.name === '#text') out += String(child.text == null ? '' : child.text);
      else walk(child);
    });
  })(node);
  return out;
}

// ------------------------------------------------------------
// 官方翻译表解析 (仅 <head>/<metadata>/<iTunesMetadata>/<translations>)
//
// 结构 (实测):
//   <translations>
//     <translation type="subtitle" xml:lang="zh-Hans">
//       <text for="L21">周围没有人评判我</text> ...
//
// 关键约定:
//   - 语言只看 <translation xml:lang>, **绝不看根 <tt xml:lang>** (根语言是原歌词语言)。
//   - 只有命中目标语言 (默认 zh-Hans) 才返回 entries, 否则 entries 为空。
//   - 本函数只读 head, 不触碰 body, 因此不会影响原歌词与 x-bg 背景人声。
// ------------------------------------------------------------
function parseTranslationTable(ttml, targetLanguage) {
  const result = {
    targetLanguage: normalizeTranslationLanguage(targetLanguage || TRANSLATION_TARGET_LANGUAGE),
    language: '',          // 实际命中的 <translation xml:lang> (规范标签)
    rawLanguage: '',       // Apple 原样返回值 (诊断用)
    matched: false,
    tableFound: false,
    entries: {},
    entryCount: 0,
  };
  const xml = String(ttml || '');
  if (!xml.trim()) return result;
  let tree = null;
  try { tree = buildTtmlTree(xml); } catch (_) { return result; }
  const nodes = collectNodes(tree, 'translation', [], false).map((x) => x.node);
  if (!nodes.length) return result;
  result.tableFound = true;
  let chosen = null;
  nodes.forEach((node) => {
    const raw = String((node.attrs || {})['xml:lang'] || '').trim();
    if (!raw) return;
    const normalized = normalizeTranslationLanguage(raw);
    if (!result.rawLanguage) result.rawLanguage = raw;
    if (!chosen && normalized === result.targetLanguage) { chosen = node; result.rawLanguage = raw; }
  });
  if (!chosen) return result;
  result.language = result.targetLanguage;
  result.matched = true;
  collectNodes(chosen, 'text', [], false).forEach((x) => {
    const node = x.node;
    const key = String((node.attrs || {}).for || '').trim();
    if (!key) return;
    const value = ttmlNodeText(node).replace(/\s+/g, ' ').trim();
    if (!value) return;
    result.entries[key] = result.entries[key] ? (result.entries[key] + ' ' + value) : value;
    result.entryCount += 1;
  });
  if (!result.entryCount) { result.matched = false; result.language = ''; }
  return result;
}

// 官方翻译 -> MineRadio tlyric (`[mm:ss.xx]翻译文本`)
// 用 <p itunes:key> 与 <text for="…"> 精确一一对应; 时间取该行 begin (翻译表本身没有时间轴)。
// 与原文相同的条目 (同语言歌词) 不作为翻译输出。
function buildTranslationLrc(ir, table) {
  if (!ir || !table || !table.matched || !table.entryCount) return '';
  const out = [];
  (ir.lines || []).forEach((line) => {
    if (!line || !Number.isFinite(line.begin)) return;
    const key = String(line.key || '').trim();
    if (!key) return;
    const translated = table.entries[key];
    if (!translated) return;
    const original = lineDisplayText(line).replace(/\s+/g, ' ').trim();
    if (original && original.toLowerCase() === translated.toLowerCase()) return;
    out.push(formatLrcTimestamp(line.begin) + translated);
  });
  return out.join('\n');
}

function parseAppleTtml(ttml) {
  const xml = String(ttml || '');
  const ir = {
    language: '',
    lines: [],
    words: [],                 // 普通歌词词级时间轴 (不含背景人声)
    background: [],            // ttm:role="x-bg" 条目
    backgroundWords: [],       // 背景人声内部的词级时间 (实测 180 个), 保留但不参与普通歌词
    stats: { p: 0, spans: 0, timedSpans: 0, untimedSpans: 0, backgroundSpans: 0, backgroundWords: 0, timedSpansOutsideP: 0, attachedOrphans: 0, syntheticLines: 0 },
    warnings: [],
  };
  if (!xml.trim()) { ir.warnings.push('EMPTY_TTML'); return ir; }

  const tree = buildTtmlTree(xml);
  // 根元素 xml:lang
  const ttNode = (tree.children || []).find((c) => c.name === 'tt') || tree;
  ir.language = String((ttNode.attrs || {})['xml:lang'] || '');

  // 1) 所有 <p> -> 行
  const pNodes = collectNodes(tree, 'p', [], false).map((x) => x.node);
  pNodes.forEach((p) => {
    const line = buildLineFromP(p);
    line.index = ir.lines.length;
    ir.lines.push(line);
  });
  ir.stats.p = ir.lines.length;

  // 2) 全文档所有 span (任意层级) -> 词级时间轴; x-bg 单独归类
  const spanNodes = collectNodes(tree, 'span', [], false);

  let orphanWords = [];
  spanNodes.forEach(({ node, insideP }) => {
    const attrs = node.attrs || {};
    const role = roleOf(attrs);
    const timed = spanHasTiming(attrs);
    const inner = textOf(node).replace(/\s+/g, ' ').trim();
    ir.stats.spans += 1;
    if (timed) ir.stats.timedSpans += 1; else ir.stats.untimedSpans += 1;
    if (role === 'x-bg') {
      // 文档级只遍历一次: 这里既计数也收集全局 IR (行内副本由 buildLineFromP 记录)
      ir.stats.backgroundSpans += 1;
      const bgWords = gatherBackgroundWords(node);
      bgWords.forEach((w) => ir.backgroundWords.push(w));
      ir.stats.backgroundWords += bgWords.length;
      ir.background.push({
        text: inner,
        begin: ttmlTimeToSeconds(attrs.begin),
        end: ttmlTimeToSeconds(attrs.end),
        timed,
        role,
        lineIndex: -1,
        words: bgWords,
      });
      return;
    }
    if (!timed) return;
    // 已由 <p> 收录的 span 直接跳过 (按节点标记判定, 不做时间猜测)
    if (node.__collected) return;
    // p 之外 (或 p 内但未被收录) 的 timed span -> 确定性归属, 绝不丢弃
    ir.stats.timedSpansOutsideP += 1;
    orphanWords.push({
      text: inner,
      begin: ttmlTimeToSeconds(attrs.begin),
      end: ttmlTimeToSeconds(attrs.end),
      role: '',
    });
  });

  // 3) 孤儿 timed span 的确定性归属 (只挂到行; 收集统一放在第 4 步, 避免重复计数)
  orphanWords.sort((a, b) => a.begin - b.begin || a.end - b.end);
  orphanWords.forEach((w) => {
    let target = ir.lines.find((l) => Number.isFinite(l.begin) && Number.isFinite(l.end) && w.begin >= l.begin - 0.001 && w.begin <= l.end + 0.001);
    if (!target) {
      // 最近的、起点在其之前的行
      const before = ir.lines.filter((l) => Number.isFinite(l.begin) && l.begin <= w.begin).sort((a, b) => b.begin - a.begin);
      target = before[0] || null;
    }
    if (target) {
      target.words.push({ text: w.text, begin: w.begin, end: w.end, role: '', c0: -1, c1: -1, orphan: true });
      target.words.sort((a, b) => a.begin - b.begin);
      target.orphanWords = (target.orphanWords || 0) + 1;
      ir.stats.attachedOrphans += 1;
      return;
    }
    // 完全没有可归属的行: 合成一行, 保证时间轴不丢
    ir.lines.push({
      begin: w.begin,
      end: w.end,
      key: '',
      agent: '',
      text: w.text,
      words: [{ text: w.text, begin: w.begin, end: w.end, role: '', c0: 0, c1: w.text.length, orphan: true }],
      backgroundTexts: [],
      untimedSpans: 0,
      synthetic: true,
    });
    ir.stats.syntheticLines += 1;
    ir.stats.attachedOrphans += 1;
  });

  // 4) 行排序 + 重建索引 + 收集"全文档词级时间轴" (含已归属的孤儿词, 685 个一个都不能少)
  ir.lines.sort((a, b) => (Number.isFinite(a.begin) ? a.begin : 0) - (Number.isFinite(b.begin) ? b.begin : 0));
  ir.lines.forEach((l, i) => { l.index = i; });
  ir.words = [];
  ir.lines.forEach((l) => {
    (l.words || []).forEach((w) => {
      ir.words.push({ text: w.text, begin: w.begin, end: w.end, role: w.role || '', lineIndex: l.index, orphan: !!w.orphan });
    });
  });
  ir.words.sort((a, b) => a.begin - b.begin || a.end - b.end);
  return ir;
}

// ------------------------------------------------------------
// IR -> MineRadio 歌词格式
// ------------------------------------------------------------
function formatLrcTimestamp(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const whole = Math.floor(s);
  const cs = Math.round((s - whole) * 100);
  const csText = cs >= 100 ? '99' : (cs < 10 ? '0' + cs : String(cs));
  return '[' + (m < 10 ? '0' + m : String(m)) + ':' + (whole < 10 ? '0' + whole : String(whole)) + '.' + csText + ']';
}

function toMillis(seconds, fallback) {
  const v = Number(seconds);
  if (!Number.isFinite(v)) return Number.isFinite(fallback) ? Math.max(0, Math.round(fallback * 1000)) : 0;
  return Math.max(0, Math.round(v * 1000));
}

function lineEndSeconds(line) {
  if (Number.isFinite(line.end) && line.end > line.begin) return line.end;
  const last = (line.words || []).filter((w) => Number.isFinite(w.end)).sort((a, b) => b.end - a.end)[0];
  if (last) return last.end;
  if (Number.isFinite(line.begin)) return line.begin + 2.5;
  return NaN;
}

// 背景人声 (ttm:role="x-bg") 的文本: 多个 x-bg 合并, 不丢文本
function lineBackgroundText(line) {
  const groups = Array.isArray(line && line.backgroundTexts) ? line.backgroundTexts : [];
  return groups.map((g) => String((g && g.text) || '').trim()).filter(Boolean).join(' ').trim();
}
// 行的显示文本: 有主歌词用主歌词; 只有背景人声时用背景人声 (§8 允许单独显示)
function lineDisplayText(line) {
  const main = String((line && line.text) || '').trim();
  if (main) return main;
  return lineBackgroundText(line);
}
function lineIsBackgroundOnly(line) {
  return !String((line && line.text) || '').trim()
    && !((line && line.words) || []).length
    && !!lineBackgroundText(line);
}
// 背景人声词级时间 (只有时间轴信息, 文本按原样)
function lineBackgroundWords(line) {
  const groups = Array.isArray(line && line.backgroundTexts) ? line.backgroundTexts : [];
  const out = [];
  groups.forEach((g) => {
    ((g && g.words) || []).forEach((w) => {
      if (!w || !Number.isFinite(w.begin) || !Number.isFinite(w.end)) return;
      out.push({ text: String(w.text == null ? '' : w.text), begin: w.begin, end: w.end });
    });
  });
  out.sort((a, b) => a.begin - b.begin);
  return out;
}

// bg 契约: 可选字段, 不影响 lyric/tlyric/yrc/ytlrc 的既有语义
//   t / duration : 自身 begin+end 派生; 无 begin/end 时为 null (绝不伪造)
//   parentT      : 所属 <p> 的起始时间 (仅作为"归属主行"的引用, 不是 bg 自己的时间)
//   standalone   : 该 <p> 没有主歌词 -> 只能作为独立时间轴行
function buildBackgroundEntries(ir) {
  const out = [];
  (ir.lines || []).forEach((line) => {
    const text = lineBackgroundText(line);
    const words = lineBackgroundWords(line);
    if (!text && !words.length) return;
    let t = null;
    let end = null;
    if (words.length) {
      t = words.reduce((min, w) => (min == null || w.begin < min ? w.begin : min), null);
      end = words.reduce((max, w) => (max == null || w.end > max ? w.end : max), null);
    }
    const duration = (t != null && end != null && end > t) ? Number((end - t).toFixed(3)) : (t != null ? 0.8 : null);
    out.push({
      t: t == null ? null : Number(t.toFixed(3)),
      duration,
      text: text || words.map((w) => w.text).join('').trim(),
      words: words.map((w) => ({
        text: w.text,
        t: Number(w.begin.toFixed(3)),
        d: Number(Math.max(0.06, w.end - w.begin).toFixed(3)),
      })),
      standalone: lineIsBackgroundOnly(line),
      parentT: Number.isFinite(line.begin) ? Number(line.begin.toFixed(3)) : null,
    });
  });
  return out;
}

function irToLrc(ir) {
  return (ir.lines || [])
    .filter((l) => Number.isFinite(l.begin) && lineDisplayText(l))
    .map((l) => formatLrcTimestamp(l.begin) + lineDisplayText(l))
    .join('\n');
}

// ------------------------------------------------------------
// 官方翻译里的背景人声 (x-bg) 译文
//
// 实测事实 (Call Out My Name / Blinding Lights):
//   - x-bg span 是主歌词 <p> 的**内联子节点**, 没有独立 itunes:key -> key 无法区分主/bg;
//   - Apple 的 <text for="Lxx"> **把 bg 译文合并进了主行译文串**:
//       "So call out my name" + "(Call out my name)"  ->  "请呼唤我的名字 (请呼唤我的名字)"
//     因为括号本来就属于 x-bg span 自己的文本 (原行里 bg 是 "(...)" 形式);
//   - localization body 里的 x-bg span 通常仍是原文语言 (未被翻译), 因此 bg 译文的唯一来源
//     就是这串合并文本。
//
// 拆分的语义判据 (绝不使用"文本里含括号"来判断一行是不是 bg):
//   1) 一行是否含 bg  -> 只看原始 TTML 的 ttm:role="x-bg" (line.backgroundTexts);
//   2) 若 localization body 的 bg 文本确实被翻译(N 与原文不同且出现在译文串里) -> 精确 needle 去除;
//   3) 否则用**原始 x-bg span 自身文本的包裹字符**在译文串里定位边界 (半/全角括号视为等价形式);
//   4) 定位不到 -> 不拆分 (主译文保留整串, bg 译文为空, 不丢数据)。
// ------------------------------------------------------------
// 只认已知的"包裹字符"对 (括号/引号)。首尾不是这类字符时不做任何拆分 (不猜)。
const BACKGROUND_WRAPPERS = {
  '(': ')', '（': '）', '[': ']', '【': '】', '{': '}', '｛': '｝',
  '「': '」', '『': '』', '“': '”', '‘': '’', '"': '"', "'": "'",
};
function backgroundWrapperOf(text) {
  const s = String(text == null ? '' : text).trim();
  if (s.length < 2) return null;
  const open = s.charAt(0);
  const close = s.charAt(s.length - 1);
  if (!BACKGROUND_WRAPPERS[open]) return null;
  if (open === close && s.length < 3) return null;
  return { open, close };
}
function wrapperVariants(ch) {
  if (ch === '(' || ch === '（') return ['(', '（'];
  if (ch === ')' || ch === '）') return [')', '）'];
  if (ch === '[' || ch === '【') return ['[', '【'];
  if (ch === ']' || ch === '】') return [']', '】'];
  return [ch];
}
function splitBackgroundTranslation(tableText, originalBgTexts, localizedBgTexts) {
  const result = { mainTranslation: String(tableText == null ? '' : tableText).trim(), backgroundTranslations: [] };
  let text = result.mainTranslation;
  if (!text) return result;
  // (2) localization body 里 bg 已被翻译 -> 用它做精确 needle
  (localizedBgTexts || []).forEach((candidate) => {
    const needle = String(candidate == null ? '' : candidate).trim();
    if (!needle || text.indexOf(needle) < 0) return;
    if ((originalBgTexts || []).indexOf(needle) >= 0) return;   // 与原文相同 = 没被翻译
    if (result.backgroundTranslations.indexOf(needle) >= 0) return;
    result.backgroundTranslations.push(needle);
    text = text.split(needle).join(' ');
  });
  if (result.backgroundTranslations.length) {
    result.mainTranslation = text.replace(/\s+/g, ' ').trim();
    return result;
  }
  // (3) 用原始 bg span 自身的包裹字符定位 (从尾部往前找成对片段)
  (originalBgTexts || []).forEach((bgText) => {
    const wrapper = backgroundWrapperOf(bgText);
    if (!wrapper) return;
    const opens = wrapperVariants(wrapper.open);
    const closes = wrapperVariants(wrapper.close);
    let closeIndex = -1;
    closes.forEach((c) => { const i = text.lastIndexOf(c); if (i > closeIndex) closeIndex = i; });
    if (closeIndex <= 0) return;
    let openIndex = -1;
    opens.forEach((o) => { const i = text.lastIndexOf(o, closeIndex - 1); if (i > openIndex) openIndex = i; });
    if (openIndex < 0 || closeIndex <= openIndex + 1) return;
    const segment = text.slice(openIndex, closeIndex + 1).trim();
    if (!segment) return;
    result.backgroundTranslations.push(segment);
    text = (text.slice(0, openIndex) + ' ' + text.slice(closeIndex + 1)).replace(/\s+/g, ' ').trim();
  });
  result.mainTranslation = text;
  return result;
}

// 官方翻译 -> { tlyric, bgTranslations } (主译文只含主歌词; bg 译文单独归集, 按父行 begin 对应)
function buildLocalizationTranslation(originalIr, localizationIr, table) {
  const out = { tlyric: '', bgTranslations: [] };
  if (!originalIr || !table || !table.matched || !table.entryCount) return out;
  const locByKey = {};
  ((localizationIr && localizationIr.lines) || []).forEach((line) => {
    if (line && line.key) locByKey[line.key] = line;
  });
  const lrcLines = [];
  (originalIr.lines || []).forEach((line) => {
    if (!line || !Number.isFinite(line.begin)) return;
    const key = String(line.key || '').trim();
    if (!key) return;
    const tableText = table.entries[key];
    if (!tableText) return;
    const originalBgTexts = (line.backgroundTexts || []).map((b) => String((b && b.text) || '').trim()).filter(Boolean);
    const locLine = locByKey[key];
    const localizedBgTexts = ((locLine && locLine.backgroundTexts) || []).map((b) => String((b && b.text) || '').trim()).filter(Boolean);
    const split = splitBackgroundTranslation(tableText, originalBgTexts, localizedBgTexts);
    if (split.backgroundTranslations.length && originalBgTexts.length) {
      out.bgTranslations.push({
        key,
        parentBegin: Number(line.begin.toFixed(3)),
        originalTexts: originalBgTexts,
        texts: split.backgroundTranslations,
      });
    }
    const mainTranslation = split.mainTranslation;
    if (!mainTranslation) return;   // 只剩 bg 译文的行不得算作主歌词翻译
    const original = lineDisplayText(line).replace(/\s+/g, ' ').trim();
    if (original && original.toLowerCase() === mainTranslation.toLowerCase()) return;
    lrcLines.push(formatLrcTimestamp(line.begin) + mainTranslation);
  });
  out.tlyric = lrcLines.join('\n');
  return out;
}

function irToYrc(ir) {
  const out = [];
  (ir.lines || []).forEach((line) => {
    if (!Number.isFinite(line.begin)) return;
    const text = lineDisplayText(line);
    let words = (line.words || []).filter((w) => Number.isFinite(w.begin) && Number.isFinite(w.end));
    if (!words.length && lineIsBackgroundOnly(line)) words = lineBackgroundWords(line);
    if (!text && !words.length) return;
    const endSec = lineEndSeconds(line);
    const lineStartMs = toMillis(line.begin, 0);
    const lineDurMs = Math.max(1, toMillis(endSec, line.begin + 2.5) - lineStartMs);
    let body = '';
    if (words.length) {
      words.forEach((w) => {
        const startMs = toMillis(w.begin, line.begin);
        const durMs = Math.max(1, toMillis(w.end, w.begin + 0.2) - startMs);
        // 词文本拼接后即为完整行文本 (词文本已按归一化行文本切片, 空白已包含在切片里)
        const raw = w.text == null ? '' : String(w.text);
        body += '(' + startMs + ',' + durMs + ',0)' + raw;
      });
      if (!body.replace(/\(\d+,\d+,\d+\)/g, '').trim()) body = '';
    }
    out.push('[' + lineStartMs + ',' + lineDurMs + ']' + (body || text));
  });
  return out.join('\n');
}

// 逐词文本之间需要空白时补齐 (Apple 的空白节点在 span 之外, 这里的词文本已按行文本切片,
// 因此行文本切片本身已包含必要的空格; 该函数只处理切片为空的极端情况)
function irHasWordTiming(ir) {
  return (ir.lines || []).some((l) => (l.words || []).some((w) => Number.isFinite(w.begin) && Number.isFinite(w.end)));
}

// ------------------------------------------------------------
// song ID 解析: 显式 id -> 本地 Apple 缓存元数据 -> Bearer catalog search
// ------------------------------------------------------------
function normalizeMatchText(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/feat\..*$|ft\..*$/i, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeCatalogId(value) {
  return /^\d{6,}$/.test(String(value == null ? '' : value).trim());
}

function pickBestSongMatch(songs, title, artist) {
  const wantTitle = normalizeMatchText(title);
  const wantArtist = normalizeMatchText(artist);
  if (!wantTitle) return null;
  let best = null;
  (songs || []).forEach((song) => {
    const attrs = song.attributes || {};
    const gotTitle = normalizeMatchText(attrs.name);
    const gotArtist = normalizeMatchText(attrs.artistName);
    let score = 0;
    if (gotTitle === wantTitle) score += 100;
    else if (gotTitle && (gotTitle.indexOf(wantTitle) === 0 || wantTitle.indexOf(gotTitle) === 0)) score += 60;
    else if (gotTitle && (gotTitle.indexOf(wantTitle) >= 0 || wantTitle.indexOf(gotTitle) >= 0)) score += 35;
    else score -= 40;
    if (wantArtist && gotArtist) {
      if (gotArtist === wantArtist) score += 40;
      else if (gotArtist.indexOf(wantArtist) >= 0 || wantArtist.indexOf(gotArtist) >= 0) score += 20;
    }
    if (!best || score > best.score) best = { score, song };
  });
  if (!best || best.score < 60) return null;
  return best.song;
}

async function searchCatalogSong(storefront, title, artist, bearerToken) {
  const term = [title, artist].filter(Boolean).join(' ').trim();
  if (!term) return null;
  const url = AMP_API + '/v1/catalog/' + storefront + '/search?term=' + encodeURIComponent(term) + '&types=songs&limit=10&l=en-US';
  const res = await httpGet(url, {
    Authorization: 'Bearer ' + bearerToken,
    Origin: WEB_ORIGIN,
    Referer: WEB_ORIGIN + '/',
    Accept: 'application/json',
  }, 5, API_TIMEOUT_MS);
  if (res.status !== 200) return { error: classifyStatus(res.status), songs: [] };
  let json = null;
  try { json = JSON.parse(res.body); } catch (_) { return { error: ERRORS.APPLE_API_UNAVAILABLE, songs: [] }; }
  const songs = (((json.results || {}).songs || {}).data) || [];
  return { songs };
}

async function resolveSongId(opts, storefront, bearerToken) {
  const explicit = String(opts.songId || '').trim();
  if (looksLikeCatalogId(explicit)) return { songId: explicit, via: 'explicit-id' };
  if (localSongIdResolver) {
    try {
      const local = String(localSongIdResolver({ title: opts.title, artist: opts.artist, album: opts.album }) || '').trim();
      if (looksLikeCatalogId(local)) return { songId: local, via: 'apple-local-metadata' };
    } catch (_) {}
  }
  if (!opts.title) return { songId: '', via: '', error: ERRORS.SONG_ID_NOT_FOUND };
  const found = await searchCatalogSong(storefront, opts.title, opts.artist, bearerToken);
  if (found && found.error) return { songId: '', via: '', error: found.error };
  const best = pickBestSongMatch(found && found.songs, opts.title, opts.artist);
  if (!best) return { songId: '', via: '', error: ERRORS.SONG_ID_NOT_FOUND };
  return { songId: String(best.id), via: 'catalog-search' };
}

// ------------------------------------------------------------
// API
// ------------------------------------------------------------
function classifyStatus(status) {
  if (status === 401) return ERRORS.BEARER_AUTH_FAILED;
  if (status === 403) return ERRORS.MEDIA_USER_TOKEN_REJECTED;
  if (status === 404) return ERRORS.LYRICS_NOT_FOUND;
  if (status === 429) return ERRORS.RATE_LIMITED;
  if (status >= 500) return ERRORS.APPLE_API_UNAVAILABLE;
  if (status !== 200) return 'HTTP_' + status;
  return '';
}

async function apiGet(url, bearerToken, userToken, timeoutMs, retry) {
  const headers = {
    Authorization: 'Bearer ' + bearerToken,
    Origin: WEB_ORIGIN,
    Referer: WEB_ORIGIN + '/',
    Accept: 'application/json',
  };
  if (userToken) headers['media-user-token'] = userToken;
  let res = null;
  try {
    res = await httpGet(url, headers, 5, timeoutMs);
  } catch (e) {
    return { status: 0, code: ERRORS.NETWORK_ERROR, body: '', detail: String(e && e.message || e) };
  }
  if (res.status === 401 && retry !== false) {
    // Bearer 失效: 刷新一次再试 (凭证本身不动)
    try { await getWebPlayerBearer(true); } catch (_) { return { status: 401, code: ERRORS.BEARER_AUTH_FAILED, body: res.body }; }
    return apiGet(url, bearerCache.token, userToken, timeoutMs, false);
  }
  if (res.status === 429 && retry !== false) {
    await new Promise((r) => setTimeout(r, 1500));
    return apiGet(url, bearerToken, userToken, timeoutMs, false);
  }
  return { status: res.status, code: classifyStatus(res.status), body: res.body };
}

function describeApiError(result) {
  const code = result && result.code ? result.code : ERRORS.APPLE_API_UNAVAILABLE;
  let detail = '';
  try {
    const j = JSON.parse((result && result.body) || '{}');
    const err = (j.errors || [])[0] || {};
    // 只保留 Apple 的标题/说明, 不含任何 token
    detail = [err.title, err.detail].filter(Boolean).join(' / ').slice(0, 200);
  } catch (_) {}
  return { error: code, detail };
}

function extractTtmlFromResponse(body, preferLocalizations) {
  let json = null;
  try { json = JSON.parse(body); } catch (_) { return { error: ERRORS.TTML_PARSE_ERROR }; }
  const attrs = (((json.data || [])[0] || {}).attributes) || {};
  if (preferLocalizations) {
    const loc = attrs.ttmlLocalizations;
    if (typeof loc === 'string' && loc.trim()) return { ttml: loc, language: (loc.match(/xml:lang="([^"]+)"/i) || [])[1] || '' };
    return { ttml: '', language: '' };
  }
  const ttml = attrs.ttml;
  if (typeof ttml === 'string' && ttml.trim()) return { ttml, language: (ttml.match(/xml:lang="([^"]+)"/i) || [])[1] || '' };
  return { ttml: '', language: '' };
}

// ------------------------------------------------------------
// 主入口
// ------------------------------------------------------------
async function fetchWebLyrics(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const result = {
    ok: false,
    provider: 'apple',
    source: 'apple-web',
    error: '',
    detail: '',
    songId: '',
    songIdVia: '',
    storefront: '',
    lyric: '',
    yrc: '',
    tlyric: '',
    ytlrc: '',
    language: '',
    lyricsLanguage: '',
    localizationLanguage: '',
    localizationRawLanguage: '',
    schemaVersion: APPLE_WEB_LYRICS_SCHEMA_VERSION,
    hasWordTiming: false,
    stats: null,
  };

  const userToken = getCredential();
  if (!userToken) { result.error = ERRORS.CREDENTIAL_MISSING; return result; }

  const requestedStorefront = String(opts.storefront || process.env.MINERADIO_APPLE_LYRICS_STOREFRONT || '').trim().toLowerCase();
  let bearer = null;
  try {
    bearer = await getWebPlayerBearer(false, requestedStorefront || undefined);
  } catch (e) {
    result.error = ERRORS.BEARER_AUTH_FAILED;
    result.detail = String(e && e.message || e).slice(0, 120);
    return result;
  }
  const storefront = requestedStorefront || bearer.storefront || DEFAULT_STOREFRONT;
  result.storefront = storefront;

  let resolved = null;
  try {
    resolved = await resolveSongId(opts, storefront, bearer.token);
  } catch (e) {
    result.error = ERRORS.NETWORK_ERROR;
    result.detail = String(e && e.message || e).slice(0, 120);
    return result;
  }
  if (!resolved || !resolved.songId) {
    result.error = (resolved && resolved.error) || ERRORS.SONG_ID_NOT_FOUND;
    return result;
  }
  result.songId = resolved.songId;
  result.songIdVia = resolved.via;

  const baseUrl = AMP_API + '/v1/catalog/' + storefront + '/songs/' + resolved.songId + '/syllable-lyrics';
  const primary = await apiGet(baseUrl, bearer.token, userToken, API_TIMEOUT_MS, true);
  if (primary.status !== 200) {
    const described = describeApiError(primary);
    result.error = described.error;
    result.detail = described.detail;
    return result;
  }
  const primaryTtml = extractTtmlFromResponse(primary.body, false);
  if (!primaryTtml.ttml) {
    // 200 但没有 ttml: 视为资源不存在 (不是解析失败)
    const anyTtml = extractTtmlFromResponse(primary.body, true);
    if (!anyTtml.ttml) { result.error = ERRORS.LYRICS_NOT_FOUND; return result; }
    primaryTtml.ttml = anyTtml.ttml;
  }

  let ir = null;
  try {
    ir = parseAppleTtml(primaryTtml.ttml);
  } catch (e) {
    result.error = ERRORS.TTML_PARSE_ERROR;
    result.detail = String(e && e.message || e).slice(0, 120);
    return result;
  }
  const lyric = irToLrc(ir);
  const yrc = irToYrc(ir);
  if (!String(lyric).trim() && !String(yrc).trim()) { result.error = ERRORS.LYRICS_NOT_FOUND; return result; }

  result.lyric = lyric;
  result.yrc = yrc;
  result.language = ir.language || primaryTtml.language || '';
  // 原歌词语言 (与 language 同义, 单独字段便于消费方区分"原歌词语言 / 翻译语言")
  result.lyricsLanguage = result.language;
  result.schemaVersion = APPLE_WEB_LYRICS_SCHEMA_VERSION;
  result.hasWordTiming = irHasWordTiming(ir);
  // 背景人声 (ttm:role="x-bg"): 作为可选字段输出, 保持 lyric/tlyric/yrc/ytlrc 语义不变
  const backgroundEntries = buildBackgroundEntries(ir);
  if (backgroundEntries.length) result.bg = backgroundEntries;
  result.stats = {
    lines: ir.lines.length,
    words: (ir.words || []).length,
    timedSpans: ir.stats.timedSpans,
    untimedSpans: ir.stats.untimedSpans,
    backgroundSpans: ir.stats.backgroundSpans,
    // 背景人声 (x-bg) 内部的词级时间: 单独保留, 不混入普通词轴
    backgroundWords: ir.stats.backgroundWords,
    backgroundEntries: backgroundEntries.length,
    timedSpansOutsideP: ir.stats.timedSpansOutsideP,
    attachedOrphans: ir.stats.attachedOrphans,
    syntheticLines: ir.stats.syntheticLines,
  };

  // 本地化 / 官方翻译 (独立解析): 失败绝不影响原文, 也绝不写入 bg
  // 注意: 必须带目标语言参数, 否则 Apple 的 <translations/> 是空的 (实测)。
  try {
    const locRes = await apiGet(buildLocalizationUrl(baseUrl), bearer.token, userToken, LOCALIZATION_TIMEOUT_MS, false);
    if (locRes.status === 200) {
      const locTtml = extractTtmlFromResponse(locRes.body, true);
      if (locTtml.ttml) {
        const locIr = parseAppleTtml(locTtml.ttml);
        // 翻译语言只能看 <translation xml:lang>, 根 <tt xml:lang> 是原歌词语言
        const table = parseTranslationTable(locTtml.ttml, TRANSLATION_TARGET_LANGUAGE);
        result.localizationLanguage = table.language || '';
        result.localizationRawLanguage = table.rawLanguage || '';
        if (table.matched) {
          // 主译文只保留主歌词; bg (x-bg) 译文从合并串里拆出单独归集, 绝不进入普通 tlyric
          const built = buildLocalizationTranslation(ir, locIr, table);
          if (built.tlyric) result.tlyric = built.tlyric;
          if (built.bgTranslations.length && Array.isArray(result.bg) && result.bg.length) {
            const byParentBegin = {};
            built.bgTranslations.forEach((item) => {
              if (item.parentBegin == null || !isFinite(Number(item.parentBegin))) return;
              byParentBegin[Number(item.parentBegin).toFixed(3)] = item.texts;
            });
            // 只给已有 bg 条目追加 translation 字段: bg 文本/时间/parentT/standalone 一律不动
            result.bg.forEach((entry) => {
              if (!entry || entry.parentT == null || !isFinite(Number(entry.parentT))) return;
              const texts = byParentBegin[Number(entry.parentT).toFixed(3)];
              if (texts && texts.length) entry.translation = texts.join(' ');
            });
          }
          result.stats.backgroundTranslations = built.bgTranslations.reduce((n, item) => n + item.texts.length, 0);
        }
        result.stats.localizationLines = locIr.lines.length;
        result.stats.localizationWords = (locIr.words || []).length;
        result.stats.localizationSameAsOriginal = !!(lyric && irToLrc(locIr) === lyric);
        result.stats.localizationTableFound = !!table.tableFound;
        result.stats.localizationLanguageMatched = !!table.matched;
        result.stats.translationEntries = table.entryCount;
        result.stats.translationLines = String(result.tlyric || '').split('\n').filter((l) => l.trim()).length;
      }
    }
  } catch (_) { /* 本地化失败不影响原文 */ }

  result.ok = true;
  return result;
}

// 诊断用 (不含任何 token)
function getStatus() {
  const now = Math.floor(Date.now() / 1000);
  return {
    configured: isConfigured(),
    bearerAvailable: !!bearerCache.token,
    bearerExpiresInSec: bearerCache.exp ? bearerCache.exp - now : 0,
    storefront: bearerCache.storefront || '',
    bundleRef: bearerCache.bundleRef || '',
    localSongIdResolver: !!localSongIdResolver,
  };
}

module.exports = {
  ERRORS,
  APPLE_WEB_LYRICS_SCHEMA_VERSION,
  TRANSLATION_TARGET_LANGUAGE,
  setCredentialSource,
  setLocalSongIdResolver,
  isConfigured,
  fetchWebLyrics,
  getStatus,
  // 供 unit test 直接使用
  parseAppleTtml,
  parseTranslationTable,
  buildTranslationLrc,
  buildLocalizationTranslation,
  splitBackgroundTranslation,
  buildLocalizationUrl,
  normalizeTranslationLanguage,
  isTargetTranslationLanguage,
  buildBackgroundEntries,
  lineDisplayText,
  lineBackgroundText,
  lineIsBackgroundOnly,
  irToLrc,
  irToYrc,
  buildTtmlTree,
  ttmlTimeToSeconds,
  normalizeMatchText,
  pickBestSongMatch,
  looksLikeCatalogId,
  getWebPlayerBearer,
  warmUpWebPlayerBearer,
  resetForTests,
};
