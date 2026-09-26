// ============================================================
// Apple Music lyrics backend (moved out of apple-music-api.js)
//
//   web first   : apple-music-web-lyrics.js (AMPWeb bearer + media-user-token)
//   local second: Apple Music package / INetCache TTML parse + LRC build
//   never throws: a web failure only console.warn()s and falls back to the local path
//
// No Developer-credential dependency of any kind: zero hits for appleGet / appleSend /
// appleApiHeaders / getAppleDeveloperToken / getAppleCredentials / signAppleDeveloperJwt /
// readStoredAppleToken / appleDevTokenCache / appleProfileCache.
//
// Two deliberate couplings, both injected by the caller so this file stays cycle-free:
//   - setTextNormalizer(fn) : reuses apple-music-api.js's existing normalizeText (no copy)
//   - webLyrics             : the same singleton instance apple-music-api.js uses (single require path)
//
// Invariants preserved verbatim by the move: source vocabulary (apple-web / apple-ttml-local / none),
// matchedBy vocabulary, AP_<songId> prefix handling, 3 min freshness, +/-2 s duration tolerance,
// <=80 files, <=48 MB scan cap, the bg: contract, schema version 3, capabilities.lyric stays false.
// ============================================================

const fs = require('fs');
const path = require('path');
const webLyrics = require('../apple-music-web-lyrics');

let textNormalizer = null;
function setTextNormalizer(fn) {
  textNormalizer = typeof fn === 'function' ? fn : null;
}
// Only reachable if the caller forgot to register one (apple-music-api.js registers at require time).
function lyricsNormalizeText(value) {
  if (textNormalizer) return textNormalizer(value);
  return String(value == null ? '' : value).trim();
}
// ============================================================
// Apple Music 歌词 (本地官方 TTML 缓存 -> LRC)
//   Apple Music Windows 播放时会把官方 TTML 歌词写入
//     %LOCALAPPDATA%\Packages\AppleInc.AppleMusicWin_*\AC\INetCache\*\ttmlLyrics*.json
//   结构: { lyricsId: 'AP_<catalogSongId>', ttml: '<tt ...>...</tt>', status: 'success' }
//   本路径只读取本地缓存: 不联网、不登录、不修改 Apple Music 任何文件。
//   用途: 作为 QQ/酷狗/网易云 全部失败后的最后一级歌词兜底。
// ============================================================
const APPLE_TTML_FRESH_MS = 3 * 60 * 1000;   // 无 id 时的兜底新鲜度窗口
const APPLE_TTML_MAX_FILES = 80;
const APPLE_TTML_SONGID_SCAN_MAX_BYTES = 48 * 1024 * 1024;   // 元数据 JSON 扫描字节预算

function appleLyricNormText(text) {
  const raw = String(text || '');
  const normalized = raw.normalize ? raw.normalize('NFKC') : raw;
  return normalized.replace(/\s+/g, ' ').trim().toLowerCase();
}

// SMTC 的 Artist 常带专辑后缀 ("A, B — Album - Single"), 取主体部分参与匹配
function appleLyricBaseArtist(artist) {
  return String(artist || '').split(/\s+[\u2014\u2013]\s+|\s+-\s+/)[0].trim();
}

function appleMusicPackageRoots() {
  const roots = [];
  const localAppData = process.env.LOCALAPPDATA || '';
  if (!localAppData) return roots;
  const packagesDir = path.join(localAppData, 'Packages');
  let entries = [];
  try { entries = fs.readdirSync(packagesDir, { withFileTypes: true }); } catch (_) { return roots; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 不硬编码包版本号: 只按包名前缀匹配
    if (!/^AppleInc\.AppleMusicWin_/i.test(entry.name)) continue;
    const root = path.join(packagesDir, entry.name);
    if (fs.existsSync(path.join(root, 'AC', 'INetCache')) || fs.existsSync(path.join(root, 'LocalCache'))) {
      roots.push(root);
    }
  }
  return roots;
}

function appleInetCacheJsonFiles(root, namePattern) {
  const out = [];
  const inet = path.join(root, 'AC', 'INetCache');
  let dirs = [];
  try { dirs = fs.readdirSync(inet, { withFileTypes: true }); } catch (_) { return out; }
  for (const dirEntry of dirs) {
    if (!dirEntry.isDirectory()) continue;
    const dir = path.join(inet, dirEntry.name);
    let files = [];
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of files) {
      if (!namePattern.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile()) out.push({ path: full, name, size: stat.size, mtime: stat.mtimeMs });
      } catch (_) { /* 缓存文件可能正被 Apple Music 重写 */ }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// TTML 时间: '41.066' | '1:02.395' | '1:02:03.500'
function appleTtmlTimeToSeconds(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const parts = text.split(':');
  let seconds = NaN;
  if (parts.length === 3) seconds = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  else if (parts.length === 2) seconds = Number(parts[0]) * 60 + Number(parts[1]);
  else seconds = Number(parts[0]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function appleTtmlDecodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function appleLrcTimestamp(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const mm = Math.floor(total / 60);
  const ss = total - mm * 60;
  const ssText = (ss < 10 ? '0' : '') + ss.toFixed(2);
  const mmText = (mm < 10 ? '0' : '') + mm;
  return '[' + mmText + ':' + ssText + ']';
}

// <tt ...><body dur="4:06.317"> -> 总时长(秒); 用于校验本地缓存是否属于当前曲目
function appleTtmlDurationSeconds(ttml) {
  const match = String(ttml || '').match(/<body[^>]*\bdur="([^"]+)"/i);
  return match ? appleTtmlTimeToSeconds(match[1]) : null;
}

// <p begin="41.066" end="43.165" itunes:key="L1" ttm:agent="v1">文本</p>
// 翻译可能来自 <span ttm:role="x-translation"> 或 <br/> 后的第二行
function appleTtmlToLines(ttml) {
  const lines = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = re.exec(String(ttml || ''))) !== null) {
    const attrs = match[1] || '';
    const inner = match[2] || '';
    const beginMatch = attrs.match(/begin="([^"]+)"/i);
    const begin = appleTtmlTimeToSeconds(beginMatch && beginMatch[1]);
    if (begin == null) continue;

    let translation = '';
    let body = inner;
    const transMatch = inner.match(/<span[^>]*ttm:role="x-translation"[^>]*>([\s\S]*?)<\/span>/i);
    if (transMatch) {
      translation = appleTtmlDecodeEntities(transMatch[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      body = inner.replace(transMatch[0], '');
    }
    const plain = appleTtmlDecodeEntities(body.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
    if (!plain && !translation) continue;
    const segments = plain.split('\n').map((s) => s.trim()).filter(Boolean);
    const main = segments.shift() || translation || '';
    const extra = segments.join(' ').trim();
    const trans = translation || extra || '';
    if (!main && !trans) continue;
    lines.push({ time: begin, text: main || trans, trans: trans && trans !== main ? trans : '' });
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

function collectAppleSongs(node, out, depth) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) {
    for (const item of node) collectAppleSongs(item, out, depth + 1);
    return;
  }
  const attrs = node.attributes;
  if (attrs && typeof attrs === 'object' && node.id && attrs.name) {
    out.push({
      id: String(node.id),
      name: String(attrs.name),
      artistName: String(attrs.artistName || ''),
      albumName: String(attrs.albumName || ''),
    });
  }
  for (const key of Object.keys(node)) {
    if (key === 'attributes') continue;
    collectAppleSongs(node[key], out, depth + 1);
  }
}

// 用 title(+artist) 在 Apple Music API 响应缓存中定位 catalog song id
function findAppleCachedSongId(roots, title, artist) {
  const wantTitle = appleLyricNormText(title);
  if (!wantTitle) return '';
  const wantArtist = appleLyricNormText(appleLyricBaseArtist(artist));
  const files = [];
  for (const root of roots) {
    const list = appleInetCacheJsonFiles(root, /\.json$/i);
    for (const file of list) {
      // ttmlLyrics*.json 是歌词本体, 不含歌曲元数据; 跳过可显著缩小扫描面
      if (/^ttml/i.test(file.name)) continue;
      files.push(file);
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  let scannedBytes = 0;
  for (const file of files) {
    if (scannedBytes >= APPLE_TTML_SONGID_SCAN_MAX_BYTES) break;
    if (!file.size || file.size > 2 * 1024 * 1024) continue;
    let text = '';
    try { text = fs.readFileSync(file.path, 'utf8'); } catch (_) { continue; }
    scannedBytes += file.size;
    if (text.indexOf(String(title)) < 0) continue;   // 快速预筛
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { continue; }
    const songs = [];
    collectAppleSongs(parsed, songs, 0);
    for (const song of songs) {
      if (appleLyricNormText(song.name) !== wantTitle) continue;
      if (wantArtist) {
        const candidateArtist = appleLyricNormText(song.artistName);
        if (candidateArtist && candidateArtist.indexOf(wantArtist) < 0 && wantArtist.indexOf(candidateArtist) < 0) continue;
      }
      return song.id;
    }
  }
  return '';
}

// Web provider 需要的 catalog song id: 直接复用上面已验证的本地 Apple 元数据解析。
webLyrics.setLocalSongIdResolver(({ title, artist }) => {
  try { return findAppleCachedSongId(appleMusicPackageRoots(), title, artist) || ''; } catch (_) { return ''; }
});

async function handleAppleLyric(id, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const wantId = lyricsNormalizeText(id);
  const wantTitle = String(options.title || '').trim();
  const wantArtist = String(options.artist || '').trim();
  const base = { provider: 'apple', id: wantId, lyric: '', tlyric: '', yrc: '', ytlrc: '' };

  // ---- 第三阶段: Apple Music Web 私有歌词 (需要 media-user-token) ----
  // 已配置凭证时优先走官方 Web 歌词 (带逐词时间轴与 localization);
  // 任何失败 (401/403/404/429/5xx/网络/TTML 解析/song id 找不到) 都不改变原有语义,
  // 继续执行下面的本地 TTML 缓存路径。这里只记录错误分类, 绝不记录 token。
  if (webLyrics.isConfigured()) {
    let web = null;
    try {
      web = await webLyrics.fetchWebLyrics({
        songId: wantId,
        title: wantTitle,
        artist: wantArtist,
        album: String(options.album || '').trim(),
        durationSec: Number(options.durationSec) || 0,
        storefront: String(options.storefront || '').trim(),
      });
    } catch (error) {
      web = { ok: false, error: 'NETWORK_ERROR', detail: (error && error.message) || '' };
    }
    if (web && web.ok && web.lyric) {
      return Object.assign(base, {
        id: web.songId || wantId,
        lyric: web.lyric,
        yrc: web.yrc || '',
        tlyric: web.tlyric || '',
        ytlrc: web.ytlrc || '',
        source: 'apple-web',
        songId: web.songId,
        storefront: web.storefront,
        language: web.language,
        // 原歌词语言 (与 language 同义) / 实际翻译语言 (<translation xml:lang>, 不是根 xml:lang)
        lyricsLanguage: web.lyricsLanguage || web.language || '',
        localizationLanguage: web.localizationLanguage || '',
        // Apple Web 歌词解析 schema 版本: 缓存层据此让旧版 (无官方翻译) 缓存失效一次
        schemaVersion: Number(web.schemaVersion) || 0,
        wordTiming: !!web.hasWordTiming,
        // 背景人声 (可选字段): 只做管道透传, 不影响既有字段; 无 bg 时为 undefined (JSON 自动省略)
        bg: Array.isArray(web.bg) && web.bg.length ? web.bg : undefined,
        matchedBy: 'apple-web:' + (web.songIdVia || 'unknown'),
        stats: web.stats || null,
      });
    }
    console.warn('[AppleMusicLyric] web provider unavailable, fallback to local cache:', (web && web.error) || 'UNKNOWN');
  }

  const roots = appleMusicPackageRoots();
  if (!roots.length) {
    return Object.assign(base, { source: 'none', message: '未找到 Apple Music 本地数据目录。' });
  }

  const files = [];
  for (const root of roots) {
    const list = appleInetCacheJsonFiles(root, /^ttml.*\.json$/i);
    for (const file of list) files.push(file);
  }
  files.sort((a, b) => b.mtime - a.mtime);
  if (!files.length) {
    return Object.assign(base, { source: 'none', message: 'Apple Music 本地暂无歌词缓存。' });
  }

  const entries = [];
  for (const file of files.slice(0, APPLE_TTML_MAX_FILES)) {
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(file.path, 'utf8')); } catch (_) { continue; }
    if (!parsed || typeof parsed.ttml !== 'string' || !parsed.ttml) continue;
    entries.push({ file, lyricsId: String(parsed.lyricsId || ''), ttml: parsed.ttml, status: String(parsed.status || '') });
  }
  if (!entries.length) {
    return Object.assign(base, { source: 'none', message: 'Apple Music 本地歌词缓存不可解析。' });
  }

  let chosen = null;
  let matchedBy = 'none';
  // lyricsId 形如 'AP_<songId>' 或带语言后缀 'AP_<songId>-en'
  const matchesLyricsId = (entry, songId) => {
    if (!entry || !songId) return false;
    const needle = 'AP_' + String(songId);
    return entry.lyricsId === needle || entry.lyricsId.indexOf(needle + '-') === 0;
  };
  // 1) catalog id 匹配
  if (wantId) {
    chosen = entries.find((e) => matchesLyricsId(e, wantId)) || null;
    if (chosen) matchedBy = 'id';
  }
  // 2) title/artist -> catalog id -> lyricsId 匹配
  if (!chosen && wantTitle) {
    const songId = findAppleCachedSongId(roots, wantTitle, wantArtist);
    if (songId) {
      chosen = entries.find((e) => matchesLyricsId(e, songId)) || null;
      if (chosen) matchedBy = 'title-artist';
    }
  }
  // 3) 兜底: 刚刚写入的 TTML (Apple Music 正在播放当前曲目)。
  //    必须用总时长二次校验, 否则切歌瞬间会拿到上一首的歌词 (宁可无歌词, 也不给错歌词)。
  if (!chosen) {
    const wantDuration = Number(options.durationSec) || 0;
    if (wantDuration > 0) {
      const fresh = entries.find((e) => {
        if (Date.now() - e.file.mtime > APPLE_TTML_FRESH_MS) return false;
        const ttmlDuration = appleTtmlDurationSeconds(e.ttml);
        if (!ttmlDuration) return false;
        return Math.abs(ttmlDuration - wantDuration) <= 2;
      }) || null;
      if (fresh) { chosen = fresh; matchedBy = 'cache-fresh-duration'; }
    }
  }
  if (!chosen) {
    return Object.assign(base, { source: 'none', message: 'Apple Music 本地未缓存该曲目的歌词。' });
  }

  const lines = appleTtmlToLines(chosen.ttml);
  if (!lines.length) {
    return Object.assign(base, { source: 'none', lyricsId: chosen.lyricsId, message: 'Apple Music TTML 歌词为空。' });
  }
  const lyric = lines.map((line) => appleLrcTimestamp(line.time) + line.text).join('\n');
  const transLines = lines.filter((line) => line.trans);
  const tlyric = transLines.length
    ? transLines.map((line) => appleLrcTimestamp(line.time) + line.trans).join('\n')
    : '';
  return Object.assign(base, {
    id: chosen.lyricsId.replace(/^AP_/, '') || wantId,
    lyric,
    tlyric,
    yrc: '',
    ytlrc: '',
    source: 'apple-ttml-local',
    lyricsId: chosen.lyricsId,
    lineCount: lines.length,
    matchedBy,
  });
}
module.exports = {
  handleAppleLyric,
  setTextNormalizer,
};