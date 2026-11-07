'use strict';
// ============================================================
// tools/lib/lyricify-log-parser.js
// Lyricify Fusion 日志 -> 结构化观测（只读、纯函数、无副作用）
//
// 设计红线（对应任务书第四阶段）：
//   * 不猜测：缺失的时间戳 / 会话 ID / 播放状态一律为 null，不补默认值。
//   * 不抬精度：日志里是什么精度就标注什么精度。
//     - 秒级显示值（如 00:00:47）-> precision:'second', resolutionMs:1000, isRawSmtcPosition:false
//     - scrobble 的 playedMs    -> precision:'millisecond'，但语义是
//       "scrobbler 累计播放时长"，不是 SMTC 原始 position。
//   * 不伪造：duration / playbackState 在 Lyricify Fusion 日志里不存在 -> 恒为 null。
//   * 保留原文：任何解析失败都返回带 parseWarnings 的观测，原文进 rawMessage。
//
// 实测日志事实（2026-10-06 侦察，见 docs/LYRICIFY_FUSION_TIMELINE_RECON.md）：
//   文件：%APPDATA%\Lyricify\Lyricify Lite\Logs\{Log.txt,Log.Lyrics.txt,Log.LastFM.txt}
//   编码：UTF-8 无 BOM，CRLF，行首 ISO-8601 带 7 位小数（100ns），本地时区
//   只有 Log.LastFM.txt 的 "Scrobble trigger" 行含毫秒数值（playedMs/targetMs）
// ============================================================

const SOURCE_KIND = 'lyricify-fusion-log';

// 行首时间戳：2026-10-06T17:01:51.0317442+08:00
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})(?=\s|$)/;
// 带级别标签的整行：<ts> [Level] body
const RECORD_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+\[(\w+)\]\s?(.*)$/;
// 异常首行：System.Foo.BarException: message
const EXCEPTION_RE = /^([A-Za-z_][\w.]*(?:Exception|Error))\b\s*:?\s*(.*)$/;

const SEARCH_TRACK_PREFIX = '[Search Track]';

function timestampPrecision(fractionDigits) {
  if (fractionDigits == null) return 'second';
  if (fractionDigits >= 7) return '100ns';
  if (fractionDigits >= 4) return 'microsecond';
  return 'millisecond';
}

/**
 * 解析行首 ISO-8601 时间戳。失败返回 null（绝不猜测）。
 * 亚毫秒部分以字符串 fraction 原样保留，不做浮点补零。
 */
function parseTimestamp(line) {
  const m = TIMESTAMP_RE.exec(String(line || ''));
  if (!m) return null;
  const base = m[1];              // 2026-10-06T17:01:51
  const fraction = m[2] || '';
  const zone = m[3];              // +08:00 / Z
  const iso = base + (fraction ? '.' + fraction : '') + zone;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return {
    iso: iso,
    epochMs: ms,
    fraction: fraction,
    fractionDigits: fraction.length,
    precision: timestampPrecision(fraction.length ? fraction.length : null),
    timezone: zone,
  };
}

/** 秒级显示位置（例如 00:00:47）：只标注，不升精度 */
function positionFromSecondDisplay(seconds, rawText) {
  if (!Number.isFinite(seconds)) return null;
  return {
    valueMs: seconds * 1000,
    raw: String(rawText),
    semantics: 'player-display-position',
    precision: 'second',
    resolutionMs: 1000,
    isRawSmtcPosition: false,
    isDisplayValueOnly: true,
    notes: '显示值只精确到秒，不得当作原始 SMTC position（禁止补成 47.000000 秒）',
  };
}

/** scrobble 累计播放时长（毫秒）：真实精度、但不是 SMTC 原始 position */
function positionFromScrobble(playedMs, targetMs, rawText) {
  if (!Number.isFinite(playedMs)) return null;
  const p = {
    valueMs: playedMs,
    raw: String(rawText),
    semantics: 'scrobbler-accumulated-played-ms',
    precision: 'millisecond',
    resolutionMs: 1,
    isRawSmtcPosition: false,
    isDisplayValueOnly: false,
    notes: 'Lyricify scrobbler 自己累计的播放时长，不等于 SMTC TimeSpan.Position',
  };
  if (Number.isFinite(targetMs)) p.targetMs = targetMs;
  return p;
}

/** 从 key=<aumid>|metadata|<title>|<artist>|<album>|... 提取身份 */
function parseMetadataKey(keyText) {
  const parts = String(keyText || '').split('|');
  const out = { sessionIdentity: null, trackIdentity: null, raw: String(keyText || '') };
  if (!parts.length || !parts[0]) return out;
  out.sessionIdentity = parts[0] || null;
  const metaIdx = parts.indexOf('metadata');
  if (metaIdx >= 0) {
    const title = parts[metaIdx + 1];
    const artist = parts[metaIdx + 2];
    const album = parts[metaIdx + 3];
    if (title || artist || album) {
      out.trackIdentity = {
        title: title || null,
        artist: artist || null,
        album: album || null,
        source: 'metadata-key',
      };
    }
  }
  return out;
}

/** [Search Track] 行 -> 身份 + 检索元数据 */
function parseSearchTrack(body) {
  let rest = body.slice(SEARCH_TRACK_PREFIX.length).trim();
  let provider = null;
  const pm = /^\[([^\]]+)\]\s*(.*)$/.exec(rest);
  if (pm) { provider = pm[1]; rest = pm[2]; }
  const parts = rest.split(' • ').map((s) => s.trim());
  const title = parts[0] || null;
  const artist = parts[1] || null;
  const album = parts[2] || null;
  const matchFlag = parts[3] || null;
  const quality = parts[4] || null;
  const sourceId = parts[5] || null;
  return {
    provider,
    matchFlag,
    quality,
    sourceId,
    trackIdentity: (title || artist || album)
      ? { title, artist, album, source: 'search-track' }
      : null,
  };
}

/** 取异常类型（来自续行堆栈的第一行） */
function classifyException(continuations) {
  for (const line of continuations) {
    const t = String(line || '').trim();
    if (!t) continue;
    const m = EXCEPTION_RE.exec(t);
    if (m) return { exceptionType: m[1], exceptionMessage: m[2] || '' };
    if (t.startsWith('   at ') || t.startsWith('at ')) return { exceptionType: null, exceptionMessage: '' };
  }
  return { exceptionType: null, exceptionMessage: '' };
}

/**
 * 解析单条记录（首行 + 续行）。返回观测对象；绝不抛异常。
 * @param {{firstLine:string, continuations?:string[], sourceFile:string, sourceLine?:number, byteOffset?:number, collectorTimestampMs:number, collectorTimestamp:string}} input
 */
function parseRecord(input) {
  const firstLine = String((input && input.firstLine) || '');
  const continuations = Array.isArray(input && input.continuations) ? input.continuations.slice() : [];
  const parseWarnings = [];

  const obs = {
    source: SOURCE_KIND,
    sourceFile: (input && input.sourceFile) || null,
    sourceLine: (input && input.sourceLine) != null ? input.sourceLine : null,
    byteOffset: (input && input.byteOffset) != null ? input.byteOffset : null,
    sourceTimestamp: null,
    sourceTimestampMs: null,
    sourceTimestampPrecision: null,
    sourceTimestampFraction: null,
    collectorTimestamp: (input && input.collectorTimestamp) || null,
    collectorTimestampMs: (input && input.collectorTimestampMs) != null ? input.collectorTimestampMs : null,
    level: null,
    eventType: 'unclassified',
    sessionIdentity: null,
    trackIdentity: null,
    rawPosition: null,
    durationMs: null,
    durationPresent: false,
    playbackState: null,
    playbackStatePresent: false,
    rawMessage: firstLine,
    continuations: continuations,
    parseWarnings: parseWarnings,
    extras: {},
  };

  const ts = parseTimestamp(firstLine);
  if (!ts) {
    parseWarnings.push('missing-or-invalid-timestamp');
  } else {
    obs.sourceTimestamp = ts.iso;
    obs.sourceTimestampMs = ts.epochMs;
    obs.sourceTimestampPrecision = ts.precision;
    obs.sourceTimestampFraction = ts.fraction;
  }

  const rec = RECORD_RE.exec(firstLine);
  if (!rec) {
    parseWarnings.push('no-level-tag');
    const tail = continuations.length ? (' [continuations=' + continuations.length + ']') : '';
    obs.extras.note = '该行不是带时间戳的日志记录（可能是堆栈续行或格式变化）' + tail;
    return obs;
  }
  const body = rec[3] || '';
  obs.level = rec[2] || null;

  // ---- 1. 时间轴回调异常 ----
  let m = /^\[([^\]]+)\]\s+Error in OnAnyTimelinePropertyChanged Invoke$/.exec(body);
  if (m) {
    const ex = classifyException(continuations);
    obs.eventType = 'timeline-property-error';
    obs.sessionIdentity = m[1];
    obs.extras.exceptionType = ex.exceptionType;
    obs.extras.exceptionMessage = ex.exceptionMessage;
    obs.extras.continuationLines = continuations.length;
    return obs;
  }

  // ---- 2. PlaybackInfo 读取失败 ----
  m = /^\[([^\]]+)\]\s+Error when getting PlaybackInfo$/.exec(body);
  if (m) {
    const ex = classifyException(continuations);
    obs.eventType = 'playback-info-error';
    obs.sessionIdentity = m[1];
    obs.extras.exceptionType = ex.exceptionType;
    obs.extras.exceptionMessage = ex.exceptionMessage;
    return obs;
  }

  // ---- 3. scrobble 阈值事件（唯一带毫秒数值的位置样本）----
  m = /^Scrobble trigger: session=([^,]+), title=(.*?), artist=(.*?), playedMs=(-?\d+), targetMs=(-?\d+)\s*$/.exec(body);
  if (m) {
    const playedMs = Number(m[4]);
    const targetMs = Number(m[5]);
    obs.eventType = 'scrobble-trigger';
    obs.sessionIdentity = m[1];
    obs.trackIdentity = { title: m[2] || null, artist: m[3] || null, album: null, source: 'scrobble-trigger' };
    obs.rawPosition = positionFromScrobble(playedMs, targetMs, 'playedMs=' + m[4] + ', targetMs=' + m[5]);
    return obs;
  }

  // ---- 4. scrobble 状态重置（切歌 / 会话切换事件）----
  m = /^Reset scrobble state: reason=([^,]+), key=(.*)$/.exec(body);
  if (m) {
    const meta = parseMetadataKey(m[2]);
    obs.eventType = 'scrobble-reset';
    obs.extras.reason = m[1];
    obs.sessionIdentity = meta.sessionIdentity;
    obs.trackIdentity = meta.trackIdentity;
    obs.extras.metadataKey = meta.raw;
    return obs;
  }

  // ---- 5. scrobble 失败 ----
  m = /^Scrobble failed: key=(.*?), title=(.*?), artist=(.*)$/.exec(body);
  if (m) {
    const meta = parseMetadataKey(m[1]);
    obs.eventType = 'scrobble-failed';
    obs.sessionIdentity = meta.sessionIdentity;
    obs.trackIdentity = meta.trackIdentity || { title: m[2] || null, artist: m[3] || null, album: null, source: 'scrobble-failed' };
    return obs;
  }

  // ---- 6. 歌词检索 ----
  if (body.indexOf(SEARCH_TRACK_PREFIX) === 0) {
    const st = parseSearchTrack(body);
    obs.eventType = 'track-search';
    obs.trackIdentity = st.trackIdentity;
    obs.extras.provider = st.provider;
    obs.extras.matchFlag = st.matchFlag;
    obs.extras.quality = st.quality;
    obs.extras.sourceId = st.sourceId;
    return obs;
  }

  // ---- 7. 应用生命周期事件 ----
  m = /^App (starting|exiting), version (\S+)$/.exec(body);
  if (m) {
    obs.eventType = m[1] === 'starting' ? 'app-start' : 'app-exit';
    obs.extras.version = m[2];
    return obs;
  }
  if (body === 'Finished App loading') { obs.eventType = 'app-loaded'; return obs; }

  // ---- 8. 其它已知信息行（保留类型化，便于统计；不解析数值）----
  if (/^Loaded stored token/.test(body)) { obs.eventType = 'token-loaded'; return obs; }
  if (/^Apple Music cache stored/.test(body)) { obs.eventType = 'apple-music-cache-stored'; return obs; }
  if (/^TaskbarHelper:/.test(body)) { obs.eventType = 'taskbar-helper'; return obs; }
  if (/^Taskbar Lyrics /.test(body)) { obs.eventType = 'taskbar-lyrics'; return obs; }

  obs.eventType = 'other';
  return obs;
}

module.exports = {
  SOURCE_KIND,
  parseTimestamp,
  parseRecord,
  parseMetadataKey,
  parseSearchTrack,
  positionFromSecondDisplay,
  positionFromScrobble,
  classifyException,
};
