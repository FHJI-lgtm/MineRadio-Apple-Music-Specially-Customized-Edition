'use strict';
// ============================================================
// Apple Music Web 歌词 provider 单元测试 (纯 parser, 不联网)
//
// 所有 TTML 均为**合成 fixture** (结构真实、文本为占位符), 不包含任何真实歌词。
// 覆盖任务书要求的 TEST 1-4 与渲染层 YRC 契约。
// 运行: node --test tests/apple-music-web-lyrics.test.js
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const webLyrics = require(path.join(appRoot, 'apple-music-web-lyrics.js'));

// ------------------------------------------------------------
// 合成 fixture: 与实测结构一致 (72 p / 720 span / 685 timed / 35 x-bg / 9 div)
// ------------------------------------------------------------
function buildStandardTtml() {
  const head = '<head><metadata><ttm:agent type="person" xml:id="v1"/>'
    + '<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><translations/><songwriters>'
    + '<songwriter>A</songwriter><songwriter>B</songwriter></songwriters></iTunesMetadata></metadata></head>';
  const parts = ['<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal"'
    + ' xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word" xml:lang="en">', head, '<body>'];
  let t = 1;
  // 9 个 div 分摊 72 行
  for (let d = 0; d < 9; d += 1) parts.push('<div>');
  for (let i = 0; i < 72; i += 1) {
    const withBg = i < 35;                 // 35 行含 x-bg -> 刚好 35 个 x-bg span
    const wordCount = withBg ? 9 : 10;     // 35*10 + 37*10 = 720 span; 35*9+37*10 = 685 timed
    const lineStart = t;
    let inner = '';
    for (let w = 0; w < wordCount; w += 1) {
      const b = t;
      const e = Number((t + 0.4).toFixed(3));
      t = e;
      inner += '<span begin="' + b.toFixed(3) + '" end="' + e.toFixed(3) + '">w' + w + '</span> ';
    }
    if (withBg) inner += '<span ttm:role="x-bg">bg</span>';
    parts.push('<p begin="' + lineStart.toFixed(3) + '" end="' + t.toFixed(3) + '" itunes:key="L' + (i + 1) + '" ttm:agent="v1">' + inner + '</p>');
    t = Number((t + 0.2).toFixed(3));
  }
  for (let d = 0; d < 9; d += 1) parts.push('</div>');
  parts.push('</body></tt>');
  return parts.join('');
}

// 渲染层 parseYrcText 的等价实现 (只用于断言契约兼容性)
function rendererParseYrc(text) {
  const lines = [];
  String(text || '').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!m) return;
    const lineStartMs = parseInt(m[1], 10) || 0;
    const body = m[3] || '';
    let fullText = '';
    const words = [];
    const reg = /\((\d+),(\d+),(\d+)\)([^()]*)/g;
    let wm = null;
    while ((wm = reg.exec(body))) {
      const txt = (wm[4] || '').replace(/\s+/g, ' ');
      if (!txt) continue;
      const c0 = fullText.length;
      fullText += txt;
      words.push({ text: txt, t: (parseInt(wm[1], 10) || 0) / 1000, d: (parseInt(wm[2], 10) || 0) / 1000, c0, c1: fullText.length });
    }
    if (!fullText) fullText = body.replace(/\(\d+,\d+,\d+\)/g, '').replace(/\s+/g, ' ');
    lines.push({ t: lineStartMs / 1000, text: fullText.replace(/\s+/g, ' ').trim(), words });
  });
  return lines;
}

// ------------------------------------------------------------
// TEST 1: 标准 TTML (72 p / 720 span / 685 timed / 35 x-bg)
// ------------------------------------------------------------
test('TEST 1: 72 p / 720 span 标准 TTML 全部解析且时间轴不丢失', () => {
  const ir = webLyrics.parseAppleTtml(buildStandardTtml());
  assert.strictEqual(ir.stats.p, 72, 'p 数量');
  assert.strictEqual(ir.stats.spans, 720, 'span 总数');
  assert.strictEqual(ir.stats.timedSpans, 685, '带 begin+end 的 span 数');
  assert.strictEqual(ir.stats.untimedSpans, 35, '无时间 span 数');
  assert.strictEqual(ir.stats.backgroundSpans, 35, 'x-bg span 数');
  assert.strictEqual(ir.stats.timedSpansOutsideP, 0, '本 fixture 没有 p 外 timed span');
  assert.strictEqual(ir.lines.length, 72, '行数');
  assert.strictEqual(ir.words.length, 685, '词级时间轴条目数 (一个都不能少)');
  assert.strictEqual(ir.background.length, 35, '背景人声条目数');
  assert.strictEqual(ir.language, 'en', 'xml:lang');
  // 每行词数: 含 x-bg 的行 9 个词, 其余 10 个
  assert.strictEqual(ir.lines[0].words.length, 9);
  assert.strictEqual(ir.lines[71].words.length, 10);
  // 时间单调递增且都在行区间内
  ir.lines.forEach((line) => {
    line.words.forEach((w) => {
      assert.ok(w.begin >= line.begin - 0.001 && w.end <= line.end + 0.001, '词时间必须落在行区间内');
      assert.ok(w.end > w.begin, '词结束必须晚于开始');
    });
  });
});

test('TEST 1b: 词文本按序拼接 === 行文本 (渲染层 YRC 契约)', () => {
  const ir = webLyrics.parseAppleTtml(buildStandardTtml());
  ir.lines.forEach((line) => {
    const joined = line.words.map((w) => w.text).join('');
    assert.strictEqual(joined, line.text, '行 ' + line.index + ' 的词拼接必须等于行文本');
  });
  // 通过渲染层等价 parser 往返验证
  const yrc = webLyrics.irToYrc(ir);
  const parsed = rendererParseYrc(yrc);
  assert.strictEqual(parsed.length, ir.lines.length, 'YRC 行数必须等于 LRC 行数 (否则会丢行)');
  parsed.forEach((p, i) => {
    assert.strictEqual(p.text, ir.lines[i].text, 'YRC 重建文本必须与行文本一致 (行 ' + i + ')');
    assert.strictEqual(p.words.length, ir.lines[i].words.length, 'YRC 词数一致 (行 ' + i + ')');
    assert.ok(p.words.length > 0, '每行都应有词级时间');
  });
  const lrc = webLyrics.irToLrc(ir);
  assert.strictEqual(lrc.split('\n').length, 72, 'LRC 行数');
});

// ------------------------------------------------------------
// TEST 2: <p> 之外的 timed span 必须保留
// ------------------------------------------------------------
test('TEST 2: p 外 timed span 不丢弃 (包含关系归属 / 就近归属 / 合成行)', () => {
  const ttml = '<tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="en"><body><div>'
    + '<p begin="1.0" end="2.0"><span begin="1.0" end="1.5">a</span> <span begin="1.5" end="2.0">b</span></p>'
    + '<span begin="1.2" end="1.4">inside</span>'      // 时间落在 p[0] 内 -> 归属 p[0]
    + '<span begin="2.2" end="2.6">after</span>'       // 不在任何 p 内 -> 就近归属 p[0]
    + '</div></body></tt>';
  const ir = webLyrics.parseAppleTtml(ttml);
  assert.strictEqual(ir.stats.timedSpans, 4);
  assert.strictEqual(ir.stats.timedSpansOutsideP, 2, '两个 p 外 span 必须被识别');
  assert.strictEqual(ir.stats.attachedOrphans, 2, '两个都必须被归属, 不能丢');
  assert.strictEqual(ir.words.length, 4, '全文档词级时间轴一个都不能少');
  // 词文本可能带前导分隔空格 (空格归属后一个词), 这里比较去空白后的内容
  const texts = ir.words.map((w) => w.text.trim()).sort();
  assert.deepStrictEqual(texts, ['a', 'after', 'b', 'inside']);
  // 行内不变式: <p> 自身的词拼接必须等于行文本 (孤儿词不参与该不变式)
  const own = ir.lines[0].words.filter((w) => !w.orphan).map((w) => w.text).join('');
  assert.strictEqual(own, ir.lines[0].text, 'p 自身词的拼接必须等于行文本');
  const orphans = ir.lines[0].words.filter((w) => w.orphan);
  assert.strictEqual(orphans.length, 2, '两个 p 外 timed span 都归属到第 0 行');
  assert.deepStrictEqual(orphans.map((w) => w.text.trim()).sort(), ['after', 'inside']);
  assert.strictEqual(ir.stats.syntheticLines, 0);
});

test('TEST 2b: 完全没有 <p> 时, p 外 timed span 生成合成行', () => {
  const ttml = '<tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div>'
    + '<span begin="3.0" end="3.5">lonely</span>'
    + '</div></body></tt>';
  const ir = webLyrics.parseAppleTtml(ttml);
  assert.strictEqual(ir.stats.syntheticLines, 1, '必须合成一行而不是丢弃');
  assert.strictEqual(ir.stats.attachedOrphans, 1);
  assert.strictEqual(ir.words.length, 1);
  assert.match(webLyrics.irToLrc(ir), /lonely/);
  assert.match(webLyrics.irToYrc(ir), /\(3000,500,0\)lonely/);
});

// ------------------------------------------------------------
// TEST 3: x-bg 背景人声
// ------------------------------------------------------------
test('TEST 3: x-bg 不被当成普通歌词词 (无时间与有时间两种)', () => {
  const ttml = '<tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="en"><body><div>'
    + '<p begin="1.0" end="3.0">'
    + '<span begin="1.0" end="1.4">main</span> '
    + '<span ttm:role="x-bg">(ooh)</span>'
    + '<span begin="1.4" end="1.8">word</span> '
    + '<span begin="2.0" end="2.4" ttm:role="x-bg">(bg timed)</span>'
    + '</p></div></body></tt>';
  const ir = webLyrics.parseAppleTtml(ttml);
  assert.strictEqual(ir.stats.backgroundSpans, 2, '两个 x-bg 都要识别');
  assert.strictEqual(ir.background.length, 2);
  assert.strictEqual(ir.lines[0].words.length, 2, 'x-bg 不能进入普通词时间轴');
  assert.strictEqual(ir.words.length, 2, '全文档词轴也不含 x-bg');
  assert.strictEqual(ir.lines[0].text, 'main word', 'x-bg 文本不能进入行文本');
  ir.lines[0].words.forEach((w) => assert.ok(!/ooh|bg timed/.test(w.text)));
  const yrc = webLyrics.irToYrc(ir);
  assert.ok(!/ooh|bg timed/.test(yrc), 'YRC 中不能出现 x-bg 文本');
  assert.ok(!/x-bg/.test(yrc));
  // x-bg 信息仍保留在 IR 中 (可区分 role)
  assert.strictEqual(ir.background[0].role, 'x-bg');
  assert.ok(ir.lines[0].backgroundTexts.length === 2, '行内 IR 也保留背景人声');
  // 只有一个纯 x-bg 的 p: 不能崩, 也不能产生垃圾词
  const onlyBg = webLyrics.parseAppleTtml('<tt><body><p begin="1" end="2"><span ttm:role="x-bg">(hey)</span></p></body></tt>');
  assert.strictEqual(onlyBg.lines[0].words.length, 0);
  assert.strictEqual(onlyBg.words.length, 0);
  assert.strictEqual(onlyBg.background.length, 1);
});

test('TEST 3c: x-bg 内部的词级时间单独保留 (实测 180 个), 不混入普通词轴', () => {
  // 实测结构: 35 个 x-bg 内含 180 个带 begin/end 的 span
  const ttml = '<tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="en"><body><div>'
    + '<p begin="1.0" end="4.0">'
    // 真实结构: 词 span 之间由空白文本节点分隔
    + '<span begin="1.0" end="1.4">lead</span> '
    + '<span ttm:role="x-bg"><span begin="1.4" end="1.7">bg1</span> <span begin="1.7" end="2.0">bg2</span></span>'
    + ' <span begin="2.0" end="2.4">tail</span>'
    + '</p></div></body></tt>';
  const ir = webLyrics.parseAppleTtml(ttml);
  assert.strictEqual(ir.stats.backgroundSpans, 1, 'x-bg 计数');
  assert.strictEqual(ir.stats.backgroundWords, 2, 'x-bg 内部词级时间必须保留');
  assert.strictEqual(ir.backgroundWords.length, 2);
  assert.strictEqual(ir.background[0].words.length, 2);
  assert.strictEqual(ir.lines[0].words.length, 2, '普通词轴只含 lead/tail');
  assert.deepStrictEqual(ir.lines[0].words.map((w) => w.text.trim()), ['lead', 'tail']);
  assert.strictEqual(ir.lines[0].text, 'lead tail', '背景人声文本不进入行文本');
  assert.strictEqual(ir.words.length, 2, '全文档普通词轴不含背景词');
  // 一个都不能少: 普通词 + 背景词 = 文档内全部 timed span
  assert.strictEqual(ir.words.length + ir.backgroundWords.length, ir.stats.timedSpans);
  const yrc = webLyrics.irToYrc(ir);
  assert.ok(!/bg1|bg2/.test(yrc), 'YRC 不得包含背景人声');
  assert.strictEqual((yrc.match(/\(\d+,\d+,\d+\)/g) || []).length, 2, 'YRC 词数 = 普通词数');
});

// ------------------------------------------------------------
// TEST 3d: bg 结构化契约 (可选字段, 不改既有语义)
// ------------------------------------------------------------
test('TEST 3d: bg 契约 —— 附属行 / 独立行 / 无时间 三种情形', () => {
  const ttml = '<tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="en"><body><div>'
    + '<p begin="1.0" end="4.0" itunes:key="L1">'
    + '<span begin="1.0" end="1.4">lead</span> '
    + '<span ttm:role="x-bg"><span begin="1.4" end="1.7">ooh</span> <span begin="1.7" end="2.0">yeah</span></span>'
    + '<span begin="2.0" end="2.4">tail</span>'
    + '</p>'
    + '<p begin="5.0" end="7.0" itunes:key="L2"><span ttm:role="x-bg">onlybg</span></p>'
    + '<p begin="8.0" end="9.0" itunes:key="L3"><span begin="8.0" end="8.4">next</span> '
    + '<span ttm:role="x-bg">notime</span></p>'
    + '</div></body></tt>';
  const ir = webLyrics.parseAppleTtml(ttml);
  const bg = webLyrics.buildBackgroundEntries(ir);
  assert.strictEqual(bg.length, 3, '三处背景人声都要出现');
  // 1) 附属行: 有时间, standalone=false, parentT 指回主行
  assert.strictEqual(bg[0].standalone, false, '主歌词内联的 x-bg 不是独立行');
  assert.strictEqual(bg[0].parentT, 1);
  assert.strictEqual(bg[0].t, 1.4);
  assert.ok(Math.abs(bg[0].duration - 0.6) < 0.001, String(bg[0].duration));
  assert.strictEqual(bg[0].text, 'ooh yeah');
  assert.strictEqual(bg[0].words.length, 2);
  assert.strictEqual(bg[0].words[0].text, 'ooh');
  // 2) 独立行: 该 <p> 没有主歌词 -> standalone=true; 无 begin/end -> t 必须为 null
  assert.strictEqual(bg[1].standalone, true, '只有 x-bg 的 <p> 才是独立行');
  assert.strictEqual(bg[1].t, null, '没有 begin/end 时绝不伪造时间');
  assert.strictEqual(bg[1].duration, null);
  assert.strictEqual(bg[1].text, 'onlybg');
  assert.strictEqual(bg[1].parentT, 5);
  // 3) 附属但无时间: t=null, 靠 parentT 归属
  assert.strictEqual(bg[2].standalone, false);
  assert.strictEqual(bg[2].t, null);
  assert.strictEqual(bg[2].text, 'notime');
  assert.strictEqual(bg[2].parentT, 8);
  // 既有语义不变: 非独立 bg 文本不得进入 lyric/yrc
  const lrc = webLyrics.irToLrc(ir);
  const yrc = webLyrics.irToYrc(ir);
  assert.ok(!/ooh|yeah|notime/.test(lrc), '附属背景人声不得混进主歌词 LRC');
  assert.ok(!/ooh|yeah|notime/.test(yrc), '附属背景人声不得混进主歌词 YRC');
  assert.match(lrc, /lead tail/, '主歌词仍在');
  assert.match(lrc, /onlybg/, '只有背景人声的行允许单独出现 (§8)');
  assert.strictEqual(lrc.split('\n').length, 3, 'LRC 行数 = 3 (含独立 bg 行)');
  // 逐词时间: 只有 bg 词的行使用 bg 词
  assert.match(yrc, /onlybg/, '独立 bg 行进入时间轴');
});

// ------------------------------------------------------------
// TEST 4: localization TTML 独立解析
// ------------------------------------------------------------
test('TEST 4: localization TTML 独立解析 + xml:lang', () => {
  const original = '<tt xml:lang="en" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div>'
    + '<p begin="1.0" end="2.0"><span begin="1.0" end="1.5">hello</span> <span begin="1.5" end="2.0">world</span></p>'
    + '</div></body></tt>';
  const localization = '<tt xml:lang="zh-Hans" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div>'
    + '<p begin="1.0" end="2.0"><span begin="1.0" end="1.5">你好</span> <span begin="1.5" end="2.0">世界</span></p>'
    + '</div></body></tt>';
  const a = webLyrics.parseAppleTtml(original);
  const b = webLyrics.parseAppleTtml(localization);
  assert.strictEqual(a.language, 'en');
  assert.strictEqual(b.language, 'zh-Hans', 'localization 语言必须从 xml:lang 解析');
  assert.strictEqual(b.lines.length, 1);
  assert.strictEqual(b.words.length, 2);
  assert.strictEqual(b.lines[0].words.map((w) => w.text).join(''), b.lines[0].text);
  // 两个 TTML 完全独立解析, 互不影响
  assert.strictEqual(a.lines[0].text, 'hello world');
  assert.strictEqual(b.lines[0].text, '你好 世界');
  // 翻译 YRC 同样可往返
  const parsed = rendererParseYrc(webLyrics.irToYrc(b));
  assert.strictEqual(parsed[0].text, '你好 世界');
  // 空/坏 TTML 必须安全降级, 不抛错
  assert.strictEqual(webLyrics.parseAppleTtml('').lines.length, 0);
  assert.strictEqual(webLyrics.parseAppleTtml('<tt><body><p begin="1" end="2">').lines.length, 1);
  assert.strictEqual(webLyrics.parseAppleTtml('not xml at all').lines.length, 0);
});

// ============================================================
// 官方翻译 (head/translations) 契约
//
// 实测结构: 根 <tt xml:lang> 恒为原歌词语言 (en), 翻译语言只在
// <translation xml:lang>, 且 <text for="Lxx"> 按 <p itunes:key> 对应。
// ============================================================
function buildTranslatedTtml(options) {
  const opts = options || {};
  const translations = opts.translations === undefined
    ? '<translations><translation type="subtitle" xml:lang="' + (opts.translationLang || 'zh-Hans') + '">'
      + '<text for="L3">第三行译文</text>'
      + '<text for="L1">第一行译文</text>'
      + '<text for="L2">第二行译文</text>'
      + '</translation></translations>'
    : opts.translations;
  const head = '<head><metadata><ttm:agent type="person" xml:id="v1"/>'
    + '<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal">' + translations
    + '</iTunesMetadata></metadata></head>';
  const parts = ['<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal"'
    + ' xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word" xml:lang="en">', head, '<body><div>'];
  const lines = [
    { key: 'L1', begin: 1.0, end: 2.0, text: 'hello world', bg: opts.withBg ? 'bg one' : '' },
    { key: 'L2', begin: 3.0, end: 4.0, text: 'second line', bg: '' },
    { key: 'L3', begin: 5.0, end: 6.5, text: 'third line', bg: '' },
  ];
  lines.forEach((l) => {
    const half = ((l.end - l.begin) / 2).toFixed(3);
    const mid = (l.begin + (l.end - l.begin) / 2).toFixed(3);
    let inner = '<span begin="' + l.begin.toFixed(3) + '" end="' + mid + '">' + l.text.split(' ')[0] + '</span> '
      + '<span begin="' + mid + '" end="' + l.end.toFixed(3) + '">' + (l.text.split(' ').slice(1).join(' ') || '') + '</span>';
    if (l.bg) inner += '<span ttm:role="x-bg">' + l.bg + '</span>';
    parts.push('<p begin="' + l.begin.toFixed(3) + '" end="' + l.end.toFixed(3) + '" itunes:key="' + l.key + '" ttm:agent="v1">' + inner + '</p>');
    void half;
  });
  parts.push('</div></body></tt>');
  return parts.join('');
}

test('翻译 1: 无 l= 的响应 (空 <translations/>) 不生成任何翻译', () => {
  const ttml = buildTranslatedTtml({ translations: '<translations/>' });
  const table = webLyrics.parseTranslationTable(ttml, 'zh-Hans');
  assert.strictEqual(table.tableFound, false, '空 <translations/> 里没有任何 <translation> 节点');
  assert.strictEqual(table.matched, false, '没有目标语言 -> 不匹配');
  assert.strictEqual(table.entryCount, 0);
  const ir = webLyrics.parseAppleTtml(ttml);
  assert.strictEqual(webLyrics.buildTranslationLrc(ir, table), '', '不得凭空生成翻译');
});

test('翻译 2+6: root xml:lang=en 时, 翻译语言仍取 <translation xml:lang> = zh-Hans', () => {
  const ttml = buildTranslatedTtml({});
  const table = webLyrics.parseTranslationTable(ttml, 'zh-Hans');
  assert.strictEqual(table.matched, true);
  assert.strictEqual(table.language, 'zh-Hans', '必须来自 <translation xml:lang>');
  assert.strictEqual(table.rawLanguage, 'zh-Hans');
  const ir = webLyrics.parseAppleTtml(ttml);
  assert.strictEqual(ir.language, 'en', '根语言仍是原歌词语言');
  // 语言别名归一: zh-CN / zh / zh-Hans-* 全部等价于 zh-Hans
  ['zh-CN', 'zh', 'zh-Hans-CN', 'zh-Hans-US'].forEach((alias) => {
    assert.strictEqual(webLyrics.isTargetTranslationLanguage(alias), true, alias + ' 必须等价于 zh-Hans');
    const t = buildTranslatedTtml({ translationLang: alias });
    assert.strictEqual(webLyrics.parseTranslationTable(t, 'zh-Hans').matched, true, alias + ' 的表必须被认作简体中文');
  });
  // 非目标语言 -> 不匹配 (繁体/英文等)
  ['zh-Hant', 'en', 'ja-JP'].forEach((other) => {
    const t = buildTranslatedTtml({ translationLang: other });
    assert.strictEqual(webLyrics.parseTranslationTable(t, 'zh-Hans').matched, false, other + ' 不得当作简体中文翻译');
  });
});

test('翻译 3+4: <text for> 与 <p itunes:key> 精确映射, 行数正确, 时间取该行 begin', () => {
  const ttml = buildTranslatedTtml({});
  const ir = webLyrics.parseAppleTtml(ttml);
  const table = webLyrics.parseTranslationTable(ttml, 'zh-Hans');
  assert.strictEqual(table.entryCount, 3, '3 条 text');
  const lrc = webLyrics.buildTranslationLrc(ir, table);
  const lines = lrc.split('\n');
  assert.strictEqual(lines.length, 3, '翻译行数 = 3 (与原文行一一对应)');
  assert.strictEqual(lines[0], '[00:01.00]第一行译文', '按 key 精确映射 (即使表里顺序错乱)');
  assert.strictEqual(lines[1], '[00:03.00]第二行译文');
  assert.strictEqual(lines[2], '[00:05.00]第三行译文');
  // 顺序错乱的表也必须按 key 归位 (实测 Apple 的 <text> 顺序是乱的)
  const reordered = buildTranslatedTtml({
    translations: '<translations><translation xml:lang="zh-Hans">'
      + '<text for="L2">B2</text><text for="L1">B1</text><text for="L3">B3</text>'
      + '</translation></translations>',
  });
  const lrc2 = webLyrics.buildTranslationLrc(webLyrics.parseAppleTtml(reordered), webLyrics.parseTranslationTable(reordered, 'zh-Hans'));
  assert.strictEqual(lrc2.split('\n')[0], '[00:01.00]B1');
});

test('翻译 5: 翻译不得覆盖原文 (lyric / yrc / bg 均不变)', () => {
  const ttml = buildTranslatedTtml({ withBg: true });
  const ir = webLyrics.parseAppleTtml(ttml);
  const lyric = webLyrics.irToLrc(ir);
  const yrc = webLyrics.irToYrc(ir);
  const bg = webLyrics.buildBackgroundEntries(ir);
  const table = webLyrics.parseTranslationTable(ttml, 'zh-Hans');
  const tlyric = webLyrics.buildTranslationLrc(ir, table);
  assert.match(lyric, /hello world/, '原文必须保持英文');
  assert.ok(!/译文/.test(lyric), '原文不得混入翻译');
  assert.ok(!/译文/.test(yrc), 'yrc 不得混入翻译');
  assert.strictEqual(bg.length, 1, 'bg 仍然存在');
  assert.strictEqual(bg[0].text, 'bg one', 'bg 文本不受翻译影响');
  assert.match(tlyric, /第一行译文/);
  assert.ok(!/hello world/.test(tlyric), '翻译里不得混入原文');
});

test('翻译 12+13: bg 与翻译并存互不污染; 无 bg 歌曲不受影响', () => {
  const withBg = buildTranslatedTtml({ withBg: true });
  const irBg = webLyrics.parseAppleTtml(withBg);
  assert.strictEqual(webLyrics.buildBackgroundEntries(irBg).length, 1, 'bg 正常');
  assert.strictEqual(webLyrics.buildTranslationLrc(irBg, webLyrics.parseTranslationTable(withBg, 'zh-Hans')).split('\n').length, 3, '翻译正常');
  const withoutBg = buildTranslatedTtml({ withBg: false });
  const irNoBg = webLyrics.parseAppleTtml(withoutBg);
  assert.strictEqual(webLyrics.buildBackgroundEntries(irNoBg).length, 0, '无 bg 歌曲不得凭空产生 bg');
  assert.strictEqual(webLyrics.buildTranslationLrc(irNoBg, webLyrics.parseTranslationTable(withoutBg, 'zh-Hans')).split('\n').length, 3);
});

test('翻译 7(单元): 请求 URL 必须带目标语言参数 (否则 Apple 不返回翻译表)', () => {
  const url = webLyrics.buildLocalizationUrl('https://amp-api.music.apple.com/v1/catalog/cn/songs/1/syllable-lyrics');
  assert.match(url, /extend=ttmlLocalizations/);
  assert.match(url, /[?&]l=zh-Hans/, '必须显式指定目标语言: ' + url);
  assert.strictEqual(webLyrics.APPLE_WEB_LYRICS_SCHEMA_VERSION, 3, 'schema 版本必须为 3 (v3 = bg 译文分离)');
  const src = fs.readFileSync(path.join(appRoot, 'apple-music-web-lyrics.js'), 'utf8');
  assert.match(src, /buildLocalizationUrl\(baseUrl\)/, 'fetchWebLyrics 必须用带语言的 URL 请求本地化');
});

// ============================================================
// 背景人声 (x-bg) 的官方译文
//
// 实测: x-bg span 是主歌词 <p> 的内联子节点 (无独立 itunes:key), Apple 把 bg 译文
// **合并进同一串主译文** ("主译文 (bg译文)")。语义判据只能是 ttm:role="x-bg",
// 包裹字符只用于在合并串里定位边界 (绝不用于判断某行是不是 bg)。
// ============================================================
function fakeIrLine(key, begin, mainText, bgTexts) {
  return {
    key, begin, end: begin + 2,
    text: mainText,
    backgroundTexts: (bgTexts || []).map((t) => ({ text: t, words: [{ text: t, begin, end: begin + 1 }] })),
    words: [{ text: mainText, begin, end: begin + 2 }],
  };
}
function fakeTable(entries) {
  return { matched: true, entryCount: Object.keys(entries).length, language: 'zh-Hans', entries };
}

test('bg 译文 1: 合并串拆分为主译文 + bg 译文 (主译文不含 bg)', () => {
  const line = fakeIrLine('L1', 10, 'So call out my name', ['(Call out my name)']);
  const built = webLyrics.buildLocalizationTranslation({ lines: [line] }, { lines: [line] }, fakeTable({ L1: '请呼唤我的名字 (请呼唤我的名字)' }));
  assert.strictEqual(built.tlyric, '[00:10.00]请呼唤我的名字', '主译文必须只含主歌词译文');
  assert.strictEqual(built.bgTranslations.length, 1, 'bg 译文必须单独归集');
  assert.strictEqual(built.bgTranslations[0].parentBegin, 10);
  assert.deepStrictEqual(built.bgTranslations[0].texts, ['(请呼唤我的名字)']);
  assert.ok(built.tlyric.indexOf('(') < 0 && built.tlyric.indexOf('（') < 0, '主译文里不得残留 bg 片段');
});

test('bg 译文 2: 同一行多个 bg 全部拆出, 都不进主译文', () => {
  const line = fakeIrLine('L2', 20, 'Main line', ['(Ah)', '(Oh)']);
  const built = webLyrics.buildLocalizationTranslation({ lines: [line] }, { lines: [line] }, fakeTable({ L2: '主译文 (啊) (哦)' }));
  assert.strictEqual(built.tlyric, '[00:20.00]主译文');
  const texts = built.bgTranslations[0].texts;
  assert.strictEqual(texts.length, 2, '两个 bg 都要拆出: ' + JSON.stringify(texts));
  assert.ok(texts.indexOf('(啊)') >= 0 && texts.indexOf('(哦)') >= 0);
});

test('bg 译文 3: 没有 x-bg 的普通括号歌词绝不拆分 (不用括号判断)', () => {
  const line = fakeIrLine('L3', 30, 'Hello (world)', []);
  const built = webLyrics.buildLocalizationTranslation({ lines: [line] }, { lines: [line] }, fakeTable({ L3: '你好 (世界)' }));
  assert.strictEqual(built.tlyric, '[00:30.00]你好 (世界)', '无 ttm:role=x-bg 时不得拆分');
  assert.strictEqual(built.bgTranslations.length, 0);
});

test('bg 译文 4: localization body 的 bg 已翻译时用精确 needle', () => {
  const original = fakeIrLine('L4', 40, 'Main', ['(Back to let you know)']);
  const localized = fakeIrLine('L4', 40, 'Main', ['(打回来告诉你)']);
  const built = webLyrics.buildLocalizationTranslation({ lines: [original] }, { lines: [localized] }, fakeTable({ L4: '我只是打回来告诉你 (打回来告诉你)' }));
  assert.strictEqual(built.tlyric, '[00:40.00]我只是打回来告诉你');
  assert.deepStrictEqual(built.bgTranslations[0].texts, ['(打回来告诉你)']);
});

test('bg 译文 5: 定位不到 bg 边界时保留整串 (不丢数据, 不猜)', () => {
  const line = fakeIrLine('L5', 50, 'Main', ['bg without wrapper']);
  const built = webLyrics.buildLocalizationTranslation({ lines: [line] }, { lines: [line] }, fakeTable({ L5: '主译文 bg without wrapper' }));
  assert.strictEqual(built.tlyric, '[00:50.00]主译文 bg without wrapper', '拆不了就整串保留');
  assert.strictEqual(built.bgTranslations.length, 0);
});

test('bg 译文 6: 只有 bg 译文的行不得算作主歌词翻译', () => {
  const line = fakeIrLine('L6', 60, 'Main', ['(Ah)']);
  const built = webLyrics.buildLocalizationTranslation({ lines: [line] }, { lines: [line] }, fakeTable({ L6: '(啊)' }));
  assert.strictEqual(built.tlyric, '', '主译文为空 -> 不产出 tlyric (留给其它源 fallback)');
  assert.strictEqual(built.bgTranslations.length, 1, 'bg 译文仍然保留');
  assert.deepStrictEqual(built.bgTranslations[0].texts, ['(啊)']);
});

test('bg 译文 7: 半/全角括号形式都认 (Apple 两种宽度都用)', () => {
  const line = fakeIrLine('L7', 70, 'Main', ['(Ah)']);
  const built = webLyrics.buildLocalizationTranslation({ lines: [line] }, { lines: [line] }, fakeTable({ L7: '主译文（啊）' }));
  assert.strictEqual(built.tlyric, '[01:10.00]主译文');
  assert.deepStrictEqual(built.bgTranslations[0].texts, ['（啊）']);
});

// ------------------------------------------------------------
// 凭证/token 相关单元断言 (不联网)
// ------------------------------------------------------------
test('TEST 5(单元): 未配置凭证时 fetchWebLyrics 直接返回 CREDENTIAL_MISSING, 不发请求', async () => {
  webLyrics.resetForTests();
  webLyrics.setCredentialSource(null);
  assert.strictEqual(webLyrics.isConfigured(), false);
  const res = await webLyrics.fetchWebLyrics({ title: 'x', artist: 'y' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, webLyrics.ERRORS.CREDENTIAL_MISSING);
  assert.strictEqual(res.lyric, '');
  assert.strictEqual(res.yrc, '');
});

test('TEST 6(单元): 凭证来源被注入后 isConfigured=true, 且返回值中永远没有 token', async () => {
  webLyrics.resetForTests();
  const SECRET = '0.' + 'A'.repeat(240);
  webLyrics.setCredentialSource(() => SECRET);
  assert.strictEqual(webLyrics.isConfigured(), true);
  const status = webLyrics.getStatus();
  assert.ok(!JSON.stringify(status).includes(SECRET), 'getStatus 不能含 token');
  const res = await webLyrics.fetchWebLyrics({ title: 'x', artist: 'y', songId: 'not-an-id' });
  assert.ok(!JSON.stringify(res).includes(SECRET), 'fetchWebLyrics 返回值不能含 token');
  webLyrics.setCredentialSource(null);
  webLyrics.resetForTests();
});

// ------------------------------------------------------------
// song ID 匹配
// ------------------------------------------------------------
test('song ID: 识别 catalog id / 归一化 / 最佳匹配', () => {
  assert.strictEqual(webLyrics.looksLikeCatalogId('1440882165'), true);
  assert.strictEqual(webLyrics.looksLikeCatalogId('AP_1440882165'), false);
  assert.strictEqual(webLyrics.normalizeMatchText('HUMBLE. (Explicit)'), 'humble');
  assert.strictEqual(webLyrics.normalizeMatchText('Song feat. Someone'), 'song');
  const songs = [
    { id: '1', attributes: { name: 'Other Song', artistName: 'Nobody' } },
    { id: '2', attributes: { name: 'HUMBLE.', artistName: 'Kendrick Lamar' } },
  ];
  const best = webLyrics.pickBestSongMatch(songs, 'HUMBLE.', 'Kendrick Lamar');
  assert.strictEqual(best.id, '2');
  assert.strictEqual(webLyrics.pickBestSongMatch(songs, '完全不存在的歌', 'zzz'), null);
});

// ------------------------------------------------------------
// 渲染层 / UI 不变量 (静态检查, 保证四源同级且无 token 泄漏)
// ------------------------------------------------------------
test('TEST 11(静态): renderer 侧不出现任何 Apple token, 且 Apple 与其余三源同级', () => {
  const src = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '12-smtc', '05-smtc-lyric-sources.js'), 'utf8');
  assert.match(src, /SMTC_LYRIC_SOURCES_DEFAULT_ORDER\s*=\s*\['apple',\s*'qq',\s*'kugou',\s*'netease'\]/);
  assert.match(src, /apple:\s*\{\s*id:\s*'apple'/);
  assert.match(src, /qq:\s*\{\s*id:\s*'qq'/);
  assert.match(src, /kugou:\s*\{\s*id:\s*'kugou'/);
  assert.match(src, /netease:\s*\{\s*id:\s*'netease'/);
  // 不允许出现 token / Bearer 之类字样 (renderer 不该接触认证)
  assert.doesNotMatch(src, /media-user-token/i);
  assert.doesNotMatch(src, /Authorization/i);
  assert.doesNotMatch(src, /AMPWebPlay/);
  // apple-web 必须映射为 Apple Music 显示名
  assert.match(src, /indexOf\('apple'\)\s*===\s*0/);
});

test('TEST 11(静态): provider 模块不打印 token, 且不把 token 放进任何返回值字段', () => {
  const src = fs.readFileSync(path.join(appRoot, 'apple-music-web-lyrics.js'), 'utf8');
  assert.doesNotMatch(src, /console\.log\([^)]*token/i);
  assert.doesNotMatch(src, /mediaUserToken\s*:/);
  // 错误只以 code 形式外泄
  assert.match(src, /ERRORS\s*=\s*\{/);
  assert.match(src, /CREDENTIAL_MISSING/);
  assert.match(src, /BEARER_AUTH_FAILED/);
  assert.match(src, /MEDIA_USER_TOKEN_REJECTED/);
  assert.match(src, /LYRICS_NOT_FOUND/);
  assert.match(src, /RATE_LIMITED/);
  assert.match(src, /APPLE_API_UNAVAILABLE/);
  assert.match(src, /TTML_PARSE_ERROR/);
  assert.match(src, /SONG_ID_NOT_FOUND/);
});
