function normalizeStageLyricText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}
function normalizeStageLyricEntry(entry, fallbackRole) {
  if (typeof entry === 'string') entry = { text: entry };
  entry = entry || {};
  var text = normalizeStageLyricText(entry.text);
  if (!text) return null;
  var rawRole = String(entry.role || '');
  if (rawRole === 'x-bg') rawRole = 'bg';
  var role = /^(current|prev|next|context|translation|bg)$/.test(rawRole) ? rawRole : (fallbackRole || 'context');
  var alpha = entry.alpha == null ? (role === 'current' ? 1 : 0.42) : clampRange(Number(entry.alpha), 0, 1);
  var scale = entry.scale == null ? (role === 'current' ? 1 : (role === 'translation' ? 0.48 : 0.86)) : clampRange(Number(entry.scale), 0.30, 1.08);
  var out = { text: text, role: role, alpha: alpha, scale: scale };
  var weightValue = Number(entry.weight);
  var lineOffsetValue = Number(entry.lineOffset);
  if (entry.weight != null && isFinite(weightValue)) out.weight = clampRange(weightValue, 500, 900);
  if (entry.lineOffset != null && isFinite(lineOffsetValue)) out.lineOffset = clampRange(lineOffsetValue, -0.58, 0.20);
  if (entry.translation) out.translation = normalizeLyricTranslationText(entry.translation);
  if (entry.translationLine) out.translationLine = true;
  if (entry.parentRole) out.parentRole = entry.parentRole;
  if (entry.background) out.background = normalizeStageLyricText(entry.background);
  if (Array.isArray(entry.backgroundWords) && entry.backgroundWords.length) out.backgroundWords = entry.backgroundWords;
  if (entry.backgroundLine) out.backgroundLine = true;
  if (entry.parentIndex != null && isFinite(Number(entry.parentIndex))) out.parentIndex = Number(entry.parentIndex);
  if (entry.lineIndex != null && isFinite(Number(entry.lineIndex))) out.lineIndex = Number(entry.lineIndex);
  if (entry.virtualIndex != null && isFinite(Number(entry.virtualIndex))) out.virtualIndex = Number(entry.virtualIndex);
  return out;
}
function lyricEntryWeight(entry) {
  var weight = entry && entry.weight != null ? Number(entry.weight) : NaN;
  if (isFinite(weight)) return clampRange(weight, 500, 900);
  return lyricFontWeightValue();
}
function lyricEntryLineOffset(entry) {
  if (!entry || entry.lineOffset == null) return 0;
  return clampRange(Number(entry.lineOffset) || 0, -0.58, 0.20);
}
function normalizeStageLyricPayload(input) {
  var entries = [];
  var mode = normalizeLyricDisplayMode(fx && fx.lyricDisplayMode);
  var activeLine = 0;
  var key = '';
  var contextLayer = false;
  var activeLayer = false;
  var trackIndex = null;
  var trackKey = '';
  var trackEntries = null;
  var trackStart = null;
  var trackEnd = null;
  var trackLightweight = false;
  var trackTextOnly = false;
  if (input && typeof input === 'object' && Array.isArray(input.entries)) {
    mode = normalizeLyricDisplayMode(input.mode || mode);
    activeLine = Math.max(0, Number(input.activeLine) || 0);
    contextLayer = input.contextLayer === true;
    activeLayer = input.activeLayer === true;
    trackLightweight = input.trackLightweight === true;
    trackTextOnly = input.trackTextOnly === true;
    if (input.trackIndex != null && isFinite(Number(input.trackIndex))) trackIndex = Number(input.trackIndex);
    trackKey = input.trackKey || '';
    if (input.trackStart != null && isFinite(Number(input.trackStart))) trackStart = Number(input.trackStart);
    if (input.trackEnd != null && isFinite(Number(input.trackEnd))) trackEnd = Number(input.trackEnd);
    for (var i = 0; i < input.entries.length; i++) {
      var entry = normalizeStageLyricEntry(input.entries[i], i === activeLine ? 'current' : 'context');
      if (entry) entries.push(entry);
    }
    if (Array.isArray(input.trackEntries) && input.trackEntries.length) {
      trackEntries = [];
      for (var ti = 0; ti < input.trackEntries.length; ti++) {
        var trackEntry = normalizeStageLyricEntry(input.trackEntries[ti], 'context');
        if (trackEntry) trackEntries.push(trackEntry);
      }
      if (!trackEntries.length) trackEntries = null;
    }
    activeLine = Math.max(0, Math.min(entries.length - 1, activeLine));
    key = input.key || '';
  } else {
    var text = normalizeStageLyricText(input);
    if (text) entries.push({ text: text, role: 'current', alpha: 1, scale: 1 });
  }
  if (!entries.length) return null;
  var active = entries[activeLine] || entries[0];
  if (!key) key = mode + '|' + activeLine + '|' + entries.map(function (entry) { return entry.role + ':' + entry.text; }).join('\n');
  return {
    mode: mode,
    key: key,
    entries: entries,
    activeLine: activeLine,
    contextLayer: contextLayer,
    activeLayer: activeLayer,
    trackIndex: trackIndex,
    trackKey: trackKey,
    trackEntries: trackEntries,
    trackStart: trackStart,
    trackEnd: trackEnd,
    trackLightweight: trackLightweight,
    trackTextOnly: trackTextOnly,
    text: active && active.text || entries[0].text,
    combinedText: entries.map(function (entry) { return entry.text; }).join(' / ')
  };
}

function cloneStageLyricEntryForLayer(entry, overrides) {
  entry = entry || {};
  var copy = {
    text: entry.text,
    role: entry.role,
    alpha: entry.alpha,
    scale: entry.scale,
    weight: entry.weight,
    lineOffset: entry.lineOffset,
    translation: entry.translation,
    translationLine: entry.translationLine,
    parentRole: entry.parentRole,
    parentIndex: entry.parentIndex,
    background: entry.background,
    backgroundWords: entry.backgroundWords,
    backgroundLine: entry.backgroundLine,
    lineIndex: entry.lineIndex,
    virtualIndex: entry.virtualIndex
  };
  overrides = overrides || {};
  for (var key in overrides) copy[key] = overrides[key];
  return copy;
}

// 背景人声**显示层**专用: 去掉最外层成对的半角 (...) / 全角（...）包裹符。
//
// Apple 的 x-bg 原文本身常带包裹性括号 (例如 "('Cause of me, baby)"), 同一条线的官方译文
// 也沿用同一对括号。这里只处理"已经由解析层判定为背景人声"的显示文本副本:
//   - Apple 原始 TTML / provider / parser / cache / lyricsLines 一律保持原样;
//   - 绝不使用"文本是否带括号"判断 bg 身份 (bg 身份只来自 ttm:role="x-bg");
//   - 只去掉**最外层**一对, 正文内部的括号原样保留。
// 保守规则:
//   1) 整串被同一对括号包裹且内部括号配平 -> 去掉这一对;
//   2) 整串是多个空格分隔的片段, 且每段各自被同一对括号包裹 -> 每段各去掉一对
//      (同一行多个 x-bg 会被上游合并成 "(A) (B)" 这样的字符串);
//   3) 其余情况 (只有一侧括号 / 内部括号不配平 / 只有部分片段带括号) 一律原样返回。
function stripLyricBackgroundWrapperText(text) {
  var WRAPPERS = [['(', ')'], ['（', '）']];
  var value = normalizeStageLyricText(text);
  if (value.length < 2) return value;
  function unwrapOnce(candidate, open, close) {
    if (candidate.length < 2) return null;
    if (candidate.charAt(0) !== open || candidate.charAt(candidate.length - 1) !== close) return null;
    var inner = candidate.slice(1, -1).trim();
    if (!inner) return null;
    var depth = 0;
    for (var i = 0; i < inner.length; i++) {
      var ch = inner.charAt(i);
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth < 0) return null;   // 内部出现未配对的反括号: 整串不是"一对包裹"
      }
    }
    return depth === 0 ? inner : null; // 内部括号不配平则不动
  }
  for (var w = 0; w < WRAPPERS.length; w++) {
    var open = WRAPPERS[w][0];
    var close = WRAPPERS[w][1];
    var whole = unwrapOnce(value, open, close);
    if (whole != null) return whole;
    var parts = value.split(/\s+/);
    if (parts.length < 2) continue;
    var unwrapped = [];
    var allWrapped = true;
    for (var p = 0; p < parts.length; p++) {
      var part = unwrapOnce(parts[p], open, close);
      if (part == null) { allWrapped = false; break; }
      unwrapped.push(part);
    }
    if (allWrapped) return unwrapped.join(' ');
  }
  return value;
}

// 背景人声附属行: 由主行的 background 派生, 挂在主行下方 (不占用新的主行槽位)
function makeStageLyricBackgroundEntry(parentEntry) {
  parentEntry = parentEntry || {};
  // 显示层去括号: 只改变这里给渲染用的文本, 父行(line) 上的 background/backgroundTranslation 不动
  var text = stripLyricBackgroundWrapperText(parentEntry.background);
  if (!text) return null;
  var isCurrent = parentEntry.role === 'current';
  var parentIndex = parentEntry.lineIndex != null && isFinite(Number(parentEntry.lineIndex))
    ? Number(parentEntry.lineIndex)
    : (parentEntry.parentIndex != null && isFinite(Number(parentEntry.parentIndex)) ? Number(parentEntry.parentIndex) : undefined);
  return {
    text: text,
    role: 'bg',
    alpha: clampRange(lyricBackgroundOpacityValue() * (isCurrent ? 1 : 0.72), 0.18, 0.92),
    scale: clampRange(lyricBackgroundScaleValue(), 0.30, 1.08),
    weight: 650,
    backgroundLine: true,
    // 背景人声的官方译文 (可选): 只属于 bg 行, 不影响主行 translation; 同样只在这里去括号
    translation: stripLyricBackgroundWrapperText(parentEntry.backgroundTranslation || ''),
    parentRole: parentEntry.role,
    parentIndex: parentIndex
  };
}
function applyLyricBackgroundEntriesToTrackEntries(entries, activeLine, maxRowsOverride) {
  entries = Array.isArray(entries) ? entries : [];
  if (!entries.length) return { entries: entries, activeLine: activeLine };
  // maxRowsOverride 是"本函数可额外增加的行数预算"。传入的 entries 已经占用的行数
  // (例如整首歌词的译文附属行, 一行一条) 不得吃掉 bg 附属行的预算, 否则当整首歌都有译文时
  // 预算被译文行占满, bg 行会被整体丢弃 (实测: 43 行歌 + 42 译文行 -> bgRows = 0)。
  var maxRows = Math.max(1, Math.round(Number(maxRowsOverride) || 24)) + entries.length;
  var out = [];
  var nextActiveLine = 0;
  var seenParents = {};
  for (var i = 0; i < entries.length && out.length < maxRows; i++) {
    var entry = entries[i];
    if (entry && entry.role === 'bg') { out.push(entry); continue; }   // 独立 bg 行原样保留
    if (i === activeLine) nextActiveLine = out.length;
    out.push(entry);
    if (!entry || !entry.background) continue;
    var parentKey = entry.lineIndex != null ? String(entry.lineIndex) : ('i' + i);
    if (seenParents[parentKey]) continue;   // 同一行多个 x-bg 已在上游合并, 避免行数爆炸
    seenParents[parentKey] = true;
    var bgEntry = makeStageLyricBackgroundEntry(entry);
    if (bgEntry && out.length < maxRows) out.push(bgEntry);
  }
  return { entries: out.length ? out : entries, activeLine: nextActiveLine };
}

function activeStageLyricPayload(payload) {
  payload = normalizeStageLyricPayload(payload);
  if (!payload) return null;
  var active = payload.entries[payload.activeLine] || payload.entries[0];
  if (!active) return null;
  var entries = [];
  if (payload.entries.length > 1) {
    for (var i = 0; i < payload.entries.length; i++) {
      var entry = payload.entries[i];
      entries.push(cloneStageLyricEntryForLayer(entry, {
        role: i === payload.activeLine ? 'current' : (entry.role || 'context'),
        alpha: i === payload.activeLine ? 1 : 0,
        scale: i === payload.activeLine ? 1 : (entry.scale || 0.86)
      }));
    }
  } else {
    entries = [cloneStageLyricEntryForLayer(active, { role: 'current', alpha: 1, scale: 1 })];
  }
  return {
    mode: payload.mode,
    key: payload.key + '|active',
    activeLine: payload.entries.length > 1 ? payload.activeLine : 0,
    activeLayer: true,
    entries: entries
  };
}

function rowBaseStageLyricPayload(payload) {
  payload = normalizeStageLyricPayload(payload);
  if (!payload || !payload.entries || !payload.entries.length) return null;
  var active = payload.entries[payload.activeLine] || payload.entries[0];
  if (active && active.translationLine) {
    for (var i = payload.activeLine - 1; i >= 0; i--) {
      if (payload.entries[i] && !payload.entries[i].translationLine) {
        active = payload.entries[i];
        break;
      }
    }
  }
  if (!active || active.translationLine) {
    for (var j = 0; j < payload.entries.length; j++) {
      if (payload.entries[j] && !payload.entries[j].translationLine) {
        active = payload.entries[j];
        break;
      }
    }
  }
  if (!active) return null;
  return {
    mode: 'single',
    key: (payload.key || '') + '|row-base',
    activeLine: 0,
    entries: [cloneStageLyricEntryForLayer(active, {
      role: 'current',
      alpha: 1,
      scale: 1,
      lineOffset: 0,
      translationLine: false,
      parentRole: '',
      parentIndex: undefined,
      virtualIndex: 0
    })]
  };
}

function contextStageLyricPayload(payload) {
  payload = normalizeStageLyricPayload(payload);
  if (!payload || !payload.entries || payload.entries.length < 2) return null;
  var entries = [];
  var hasContext = false;
  for (var i = 0; i < payload.entries.length; i++) {
    var entry = payload.entries[i];
    if (i === payload.activeLine) {
      entries.push(cloneStageLyricEntryForLayer(entry, { alpha: 0 }));
      continue;
    }
    hasContext = true;
    if (entry.translationLine) {
      entries.push(cloneStageLyricEntryForLayer(entry, {
        alpha: clampRange(entry.alpha == null ? lyricContextOpacityValue() * 0.58 : entry.alpha, 0, 0.72),
        scale: clampRange(entry.scale == null ? lyricTranslationScaleValue() * 0.88 : entry.scale, 0.42, 1.12),
        weight: entry.weight == null ? 650 : entry.weight,
        lineOffset: entry.lineOffset == null ? -0.20 : entry.lineOffset
      }));
      continue;
    }
    if (entry.role === 'bg') {
      // 背景人声保持自身更弱的 alpha/scale, 不被 context 默认值抬高
      entries.push(cloneStageLyricEntryForLayer(entry));
      continue;
    }
    entries.push(cloneStageLyricEntryForLayer(entry, {
      alpha: clampRange(entry.alpha == null ? lyricContextOpacityValue() : entry.alpha, 0, 1),
      scale: clampRange(entry.scale == null ? 0.86 : entry.scale, 0.72, 0.98)
    }));
  }
  if (!hasContext) return null;
  return {
    mode: payload.mode,
    key: payload.key + '|context',
    activeLine: payload.activeLine,
    contextLayer: true,
    entries: entries
  };
}
