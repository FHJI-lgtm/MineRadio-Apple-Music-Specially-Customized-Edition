'use strict';
// ============================================================
// 背景人声 (Apple Music ttm:role="x-bg") 测试
//
// 覆盖任务书 TEST 1-12:
//   - 解析/标准化层 (00-lyrics-fetch-parse.js): bg 挂到主行 / 独立行 / 不污染 translation
//   - 3D 舞台 payload 层 (08 + 09): entry 注入、视觉权重、行槽位、边界
//   - 桌面歌词窗口: payload 字段 + DOM/CSS (静态检查)
//
// 说明: 渲染层是浏览器模块, 这里用 vm 提供最小全局环境后加载**真实源码**,
//       不复制实现、不做源码字符串断言(除桌面歌词这类 DOM 文件)。
// 运行: node tests/lyric-background-vocal.test.js
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const visualDir = path.join(appRoot, 'public', 'js', 'modules', '02-visual');
const parseFile = path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js');

// ------------------------------------------------------------
// vm harness: 最小全局环境 + 真实模块源码
// ------------------------------------------------------------
function makeSandbox() {
  const sandbox = {
    console,
    Math, JSON, Array, Object, String, Number, Boolean, Date, RegExp, Error,
    isFinite, parseInt, parseFloat,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // ---- 依赖桩 (真实环境由其它模块提供) ----
  sandbox.clampRange = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
  sandbox.normalizeLyricTranslationText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  sandbox.normalizeStageLyricText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  sandbox.normalizeLyricDisplayMode = (v) => v || 'single';
  sandbox.normalizeLyricTranslationMode = (v) => v || 'off';
  sandbox.lyricFontWeightValue = () => 900;
  sandbox.lyricContextOpacityValue = () => 0.42;
  sandbox.lyricTranslationScaleValue = () => 0.78;
  sandbox.lyricTranslationVisualGapValue = () => 1.2;
  sandbox.lyricContextSpreadValue = () => 1;
  sandbox.lyricLineTranslationTextAt = (i) => {
    const line = sandbox.lyricsLines && sandbox.lyricsLines[i];
    return line && line.translation ? line.translation : '';
  };
  sandbox.fx = { lyricDisplayMode: 'single', lyricTranslationMode: 'off' };
  sandbox.fxDefaults = { lyricTranslationScale: 0.78 };
  sandbox.lyricsLines = [];
  sandbox.lyricsTranslationLines = [];
  sandbox.THREE = {};
  return vm.createContext(sandbox);
}

function loadVisual(ctx) {
  ['08-lyrics-display-modes.js', '09-lyrics-payloads.js'].forEach((name) => {
    vm.runInContext(fs.readFileSync(path.join(visualDir, name), 'utf8'), ctx, { filename: name });
  });
}

function loadParse(ctx) {
  vm.runInContext(fs.readFileSync(parseFile, 'utf8'), ctx, { filename: '00-lyrics-fetch-parse.js' });
}

// ------------------------------------------------------------
// TEST 1: 旧 provider (无 bg) 行为完全不变
// ------------------------------------------------------------
test('TEST 1: 无 bg 字段时解析层/渲染层行为完全不变 (QQ/Kugou/NetEase 回归)', () => {
  const ctx = makeSandbox();
  loadParse(ctx);
  const lines = [
    { t: 1, duration: 2, text: 'hello', words: [{ text: 'hello', t: 1, d: 0.5, c0: 0, c1: 5 }], charCount: 5 },
    { t: 3, duration: 2, text: 'world', words: [], charCount: 5 },
  ];
  const before = JSON.parse(JSON.stringify(lines));
  // 无 bg -> normalize 返回空数组, 不改变 lines
  // 跨 vm realm 的数组原型不同, 用长度断言
  assert.strictEqual(ctx.normalizeLyricBackgroundEntries(undefined).length, 0);
  assert.strictEqual(ctx.normalizeLyricBackgroundEntries(null).length, 0);
  assert.strictEqual(ctx.normalizeLyricBackgroundEntries('not-an-array').length, 0);
  const out = ctx.attachLyricBackgrounds(lines, []);
  // 跨 vm realm: 用 JSON 往返比较内容 (原型不同, deepStrictEqual 会误报)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), before, '无背景人声时 lines 必须逐字段不变');
  lines.forEach((l) => {
    assert.strictEqual(l.background, undefined, '不得凭空写入 background 字段');
    assert.strictEqual(l.role, undefined, '旧歌词不得被写入 role');
  });

  // 渲染层: 未注入背景人声时 entries 不变
  const ctx2 = makeSandbox();
  loadVisual(ctx2);
  ctx2.lyricsLines = [{ t: 1, duration: 2, text: 'hello' }];
  const entries = [{ text: 'hello', role: 'current', alpha: 1, scale: 1, lineIndex: 0 }];
  const applied = ctx2.applyLyricBackgroundEntriesToTrackEntries(entries, 0, 24);
  assert.strictEqual(applied.entries.length, 1, '无 background 时不得新增 entry');
  assert.strictEqual(applied.entries[0].text, 'hello');
  assert.strictEqual(applied.activeLine, 0);
});

// ------------------------------------------------------------
// TEST 2: Apple 普通 TTML (无 x-bg) 正常
// ------------------------------------------------------------
test('TEST 2: Apple 普通歌词 (无 x-bg) 解析与注入均正常', () => {
  const ctx = makeSandbox();
  loadParse(ctx);
  const lines = [{ t: 1, duration: 2, text: 'plain lyric', words: [{ text: 'plain lyric', t: 1, d: 0.8, c0: 0, c1: 11 }], charCount: 11 }];
  const out = ctx.attachLyricBackgrounds(lines, ctx.normalizeLyricBackgroundEntries([]));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].text, 'plain lyric');
  assert.ok(!out[0].background);
  // 渲染层槽位: 无 bg 时虚索引保持既有行为 (整数行号)
  const ctx2 = makeSandbox();
  loadVisual(ctx2);
  ctx2.lyricsLines = [{ t: 1, text: 'a' }, { t: 3, text: 'b' }];
  assert.strictEqual(ctx2.lyricPrimaryVirtualIndex(0), 0);
  assert.strictEqual(ctx2.lyricPrimaryVirtualIndex(1), 1);
  assert.strictEqual(ctx2.lyricPrimaryVirtualIndex(2), 2);
});

// ------------------------------------------------------------
// TEST 3/4/5: bg 归属、有时间/无时间、p 外
// ------------------------------------------------------------
test('TEST 3+4+5: bg 无时间不伪造 / 有时间进时间轴 / 无法归属时独立成行', () => {
  const ctx = makeSandbox();
  loadParse(ctx);
  const lines = [
    { t: 1, duration: 3, text: 'lead', words: [{ text: 'lead', t: 1, d: 1, c0: 0, c1: 4 }], charCount: 4 },
    { t: 5, duration: 2, text: 'tail', words: [], charCount: 4 },
  ];
  const bg = ctx.normalizeLyricBackgroundEntries([
    { t: 1.4, duration: 0.6, text: 'ooh', words: [{ text: 'ooh', t: 1.4, d: 0.6 }], standalone: false, parentT: 1 },
    { t: null, duration: null, text: 'notime', words: [], standalone: false, parentT: 5 },
    { t: 9, duration: 1.5, text: 'lonely bg', words: [], standalone: true, parentT: 9 },
  ]);
  assert.strictEqual(bg.length, 3);
  assert.strictEqual(bg[1].t, null, '无 begin/end 时必须保持 null (不伪造时间)');
  const out = ctx.attachLyricBackgrounds(lines, bg);
  // 1) 有时间 -> 挂到包含它的主行
  assert.strictEqual(out.find((l) => l.text === 'lead').background, 'ooh');
  assert.strictEqual(out.find((l) => l.text === 'lead').backgroundWords.length, 1);
  // 2) 无时间 -> 靠 parentT 归属, 且不产生时间
  assert.strictEqual(out.find((l) => l.text === 'tail').background, 'notime');
  // 3) 无法归属 -> 独立时间轴行, role=x-bg
  const standalone = out.filter((l) => l.role === 'x-bg');
  assert.strictEqual(standalone.length, 1, 'standalone 且无法归属时才独立成行');
  assert.strictEqual(standalone[0].text, 'lonely bg');
  assert.strictEqual(standalone[0].t, 9);
  // 时间轴必须保持升序 (查找用二分)
  for (let i = 1; i < out.length; i += 1) assert.ok((out[i].t || 0) >= (out[i - 1].t || 0), '时间轴必须升序');
});

// ------------------------------------------------------------
// TEST 6: 主歌词 + x-bg 同时出现 (注入为附属行)
// ------------------------------------------------------------
test('TEST 6+12: 主歌词与背景人声同时存在, 且背景人声视觉权重更弱', () => {
  const ctx = makeSandbox();
  loadVisual(ctx);
  ctx.lyricsLines = [
    { t: 1, duration: 3, text: 'I know that you want me', background: 'yeah yeah' },
    { t: 5, duration: 2, text: 'next line' },
  ];
  const entries = [{ text: 'I know that you want me', role: 'current', alpha: 1, scale: 1, lineIndex: 0, background: 'yeah yeah' }];
  const applied = ctx.applyLyricBackgroundEntriesToTrackEntries(entries, 0, 24);
  assert.strictEqual(applied.entries.length, 2, '主行 + 附属背景行 = 2 行');
  assert.strictEqual(applied.entries[0].text, 'I know that you want me', '主歌词文本不得被替换');
  assert.strictEqual(applied.entries[0].role, 'current');
  const bgEntry = applied.entries[1];
  assert.strictEqual(bgEntry.role, 'bg');
  assert.strictEqual(bgEntry.text, 'yeah yeah');
  assert.ok(bgEntry.alpha < entries[0].alpha, '背景人声 alpha 必须低于主歌词');
  assert.ok(bgEntry.scale < 1, '背景人声字号必须小于主歌词');
  assert.ok(bgEntry.scale >= 0.70 && bgEntry.scale <= 0.80, '字号应在主歌词 70%~80%: ' + bgEntry.scale);
  assert.ok(bgEntry.alpha >= 0.50 && bgEntry.alpha <= 0.70, '不透明度应在 50%~70%: ' + bgEntry.alpha);
  // 附属行不得占用主行槽位 (必须早于 lineIndex 判定)
  const ctx2 = makeSandbox();
  loadVisual(ctx2);
  ctx2.lyricsLines = [{ t: 1, text: 'a', background: 'bg' }, { t: 3, text: 'b' }];
  const rowIndex = ctx2.lyricRowVirtualIndex ? null : null; // 行层模块未加载, 用虚索引函数断言
  assert.strictEqual(ctx2.lyricBackgroundVirtualIndex(0) > ctx2.lyricPrimaryVirtualIndex(0), true);
  assert.strictEqual(ctx2.lyricBackgroundVirtualIndex(0) < ctx2.lyricPrimaryVirtualIndex(1), true,
    '背景行必须落在主行与下一主行之间 (不顶掉下一行)');
});

// ------------------------------------------------------------
// TEST 7: 只有背景人声
// ------------------------------------------------------------
test('TEST 7: 只有背景人声的行 (role=x-bg) 以弱样式成为当前行', () => {
  const ctx = makeSandbox();
  loadVisual(ctx);
  ctx.lyricsLines = [{ t: 5, duration: 2, text: 'only bg', role: 'x-bg', source: 'apple-bg' }];
  // 独立 bg 行: 若带 background 字段则走注入; 否则原样保留为 bg entry
  const entries = [{ text: 'only bg', role: 'bg', alpha: 0.58, scale: 0.74, lineIndex: 0 }];
  const applied = ctx.applyLyricBackgroundEntriesToTrackEntries(entries, 0, 24);
  assert.strictEqual(applied.entries.length, 1, '独立 bg 行不得被再注入一次');
  assert.strictEqual(applied.entries[0].role, 'bg');
  assert.strictEqual(applied.activeLine, 0, '独立 bg 行成为当前行也不能丢 activeLine');
});

// ------------------------------------------------------------
// TEST 8: 多个 x-bg -> 上游合并, 行数不爆炸
// ------------------------------------------------------------
test('TEST 8: 同一行多个背景人声合并为一个附属行 (行数有界)', () => {
  const ctx = makeSandbox();
  loadParse(ctx);
  const lines = [{ t: 1, duration: 4, text: 'main', words: [], charCount: 4 }];
  const bg = ctx.normalizeLyricBackgroundEntries([
    { t: 1.2, duration: 0.4, text: 'oh', words: [], standalone: false, parentT: 1 },
    { t: 1.8, duration: 0.4, text: 'yeah', words: [], standalone: false, parentT: 1 },
    { t: 2.4, duration: 0.4, text: 'come on', words: [], standalone: false, parentT: 1 },
  ]);
  const out = ctx.attachLyricBackgrounds(lines, bg);
  assert.strictEqual(out.length, 1, '多个 x-bg 不得产生多行主歌词');
  assert.strictEqual(out[0].background, 'oh yeah come on', '文本必须全部保留');
  // 渲染层: 同一父行只注入一个 bg entry
  const ctx2 = makeSandbox();
  loadVisual(ctx2);
  ctx2.lyricsLines = out;
  const entries = [{ text: 'main', role: 'current', alpha: 1, scale: 1, lineIndex: 0, background: out[0].background }];
  const applied = ctx2.applyLyricBackgroundEntriesToTrackEntries(entries, 0, 24);
  assert.strictEqual(applied.entries.length, 2, '每行最多注入一个背景行');
});

// ------------------------------------------------------------
// TEST 9: original + translation + x-bg 三者互不污染
// ------------------------------------------------------------
test('TEST 9: original / translation / background vocal 三个概念独立', () => {
  const ctx = makeSandbox();
  loadParse(ctx);
  const lines = [{
    t: 1, duration: 4, text: 'I know that you want me',
    words: [{ text: 'I know that you want me', t: 1, d: 2, c0: 0, c1: 23 }], charCount: 23,
    translation: '我知道你想要我', translationTime: 1,
  }];
  const bg = ctx.normalizeLyricBackgroundEntries([
    { t: 1.2, duration: 0.5, text: 'yeah yeah', words: [], standalone: false, parentT: 1 },
  ]);
  const out = ctx.attachLyricBackgrounds(lines, bg);
  assert.strictEqual(out[0].text, 'I know that you want me', '主歌词不得被拼接背景人声');
  assert.strictEqual(out[0].translation, '我知道你想要我', '翻译不得被覆盖');
  assert.strictEqual(out[0].background, 'yeah yeah', '背景人声独立存放');
  assert.strictEqual(out[0].backgroundRole, 'x-bg');
  // 渲染层: 翻译 entry 与背景 entry 是两个不同角色, 且互不覆盖
  const ctx2 = makeSandbox();
  loadVisual(ctx2);
  const entries = [
    { text: 'I know that you want me', role: 'current', alpha: 1, scale: 1, lineIndex: 0, background: 'yeah yeah' },
    { text: '我知道你想要我', role: 'translation', alpha: 0.6, scale: 0.78, translationLine: true, parentIndex: 0 },
  ];
  const applied = ctx2.applyLyricBackgroundEntriesToTrackEntries(entries, 0, 24);
  const roles = applied.entries.map((e) => e.role);
  assert.ok(roles.indexOf('bg') >= 0, '存在背景行');
  assert.ok(roles.indexOf('translation') >= 0, '翻译行仍在');
  const bgEntry = applied.entries.find((e) => e.role === 'bg');
  assert.ok(!bgEntry.translationLine, '背景人声不得被标记成 translationLine');
  assert.strictEqual(applied.entries.find((e) => e.role === 'translation').text, '我知道你想要我');
});

// ------------------------------------------------------------
// TEST 10: 背景人声不影响主歌词逐词时间轴
// ------------------------------------------------------------
test('TEST 10: 注入背景行不改变主行 words/activeLine (逐词动画不受影响)', () => {
  const ctx = makeSandbox();
  loadVisual(ctx);
  const words = [{ text: 'main', t: 1, d: 0.5, c0: 0, c1: 4 }];
  ctx.lyricsLines = [{ t: 1, duration: 3, text: 'main', words: words, background: 'bg' }];
  const entries = [{ text: 'main', role: 'current', alpha: 1, scale: 1, lineIndex: 0, background: 'bg' }];
  const applied = ctx.applyLyricBackgroundEntriesToTrackEntries(entries, 0, 24);
  assert.strictEqual(applied.activeLine, 0, 'activeLine 必须仍指向主行');
  assert.strictEqual(applied.entries[0].words, undefined, 'entry 层不承载 words (主行逐词来自 lyricsLines)');
  assert.strictEqual(ctx.lyricsLines[0].words, words, '主行 words 引用不得被替换');
  assert.strictEqual(words[0].t, 1, '主行逐词时间不得被改写');
});

// ------------------------------------------------------------
// TEST 11: 配色 / 其他源文件未被新增配色体系
// ------------------------------------------------------------
test('TEST 11: 只复用现有配色/材质, 不新增独立配色系统', () => {
  const files = ['08-lyrics-display-modes.js', '09-lyrics-payloads.js', '12-lyrics-row-layers.js', '10-lyrics-mask-textures.js', '14-stage-lyrics-rendering.js'];
  files.forEach((name) => {
    const src = fs.readFileSync(path.join(visualDir, name), 'utf8');
    // 背景人声不得引入新的调色常量/十六进制配色
    const bgLines = src.split('\n').filter((l) => /background/i.test(l) && /#[0-9a-fA-F]{3,6}/.test(l));
    assert.strictEqual(bgLines.length, 0, name + ' 背景人声分支不得硬编码配色: ' + bgLines.join(' | '));
  });
  // 12-lyrics-row-layers.js 的背景行材质必须复用现有 palette
  const rowSrc = fs.readFileSync(path.join(visualDir, '12-lyrics-row-layers.js'), 'utf8');
  assert.match(rowSrc, /entry\.backgroundLine[\s\S]{0,160}state\.pal\.secondary/, '背景行颜色必须取自现有 palette.secondary');
});

// ------------------------------------------------------------
// 桌面歌词窗口 (与 3D 舞台共享同一份 bg 数据)
// ------------------------------------------------------------
test('TEST desktop: 桌面歌词显示背景人声 (payload + DOM + 弱样式)', () => {
  const shell = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '04-desktop-overlay-fullscreen.js'), 'utf8');
  // 数据来源: 与 3D 舞台相同的 line.background
  assert.match(shell, /textBg:\s*stripLyricBackgroundWrapperText\(curLine\.background \|\| ''\)/, '必须从 line.background 取数据 (显示层去括号)');
  assert.match(shell, /textBg:\s*lyric\.textBg \|\| ''/, 'payload 必须带上 textBg');
  assert.match(shell, /payload\.textBg \|\| ''\)\s*\+\s*'\|'/, 'push key 必须纳入 textBg (否则不会推送)');

  const html = fs.readFileSync(path.join(appRoot, 'public', 'desktop-lyrics.html'), 'utf8');
  assert.match(html, /id="lineBg" class="line-bg"/, '#lineBg 必须存在');
  assert.match(html, /var lineBg = document\.getElementById\('lineBg'\)/);
  assert.match(html, /\.line-bg\{[\s\S]{0,900}font-size:calc\(var\(--lyric-size\) \* \.74\)/, '字号约为主歌词 74%');
  assert.match(html, /\.line-bg\{[\s\S]{0,900}opacity:\.58/, '不透明度约 58%');
  assert.match(html, /\.line-bg\{[\s\S]{0,900}text-align:center/, '必须保持居中');
  assert.match(html, /lineBg\.className = bgFullText \? 'line-bg show' : 'line-bg'/, '空背景(含译文)时必须隐藏');
  assert.match(html, /lineBg \? \(lineBg\.textContent \|\| ''\) : ''/, '布局测量必须计入背景行');
  // 背景行不得参与主行进度/滚动状态
  const bgBlock = html.split('var bgText =')[1] || '';
  assert.ok(!/scrollState|state\.progress\s*=/.test(bgBlock.slice(0, 400)), '背景行不得改写主行进度/滚动');
  // bg 官方译文: 与 bg 原文同一附属行, 绝不混入主歌词 translation
  assert.match(shell, /textBgTranslation:\s*stripLyricBackgroundWrapperText\(curLine\.backgroundTranslation \|\| ''\)/, '必须从 line.backgroundTranslation 取数据 (显示层去括号)');
  assert.match(shell, /textBgTranslation:\s*lyric\.textBgTranslation \|\| ''/, 'payload 必须带上 textBgTranslation');
  assert.match(shell, /payload\.textBgTranslation \|\| ''\)\s*\+\s*'\|'/, 'push key 必须纳入 textBgTranslation');
  assert.match(html, /var bgTranslation = typeof next\.textBgTranslation === 'string'/, '桌面歌词必须读取 textBgTranslation');
  assert.match(html, /bgText \+ ' ' \+ bgTranslation/, 'bg 译文必须与 bg 原文同处一个附属行');
  // div 标签配对 (新 DOM 不破坏结构)
  const open = (html.match(/<div/g) || []).length;
  const close = (html.match(/<\/div>/g) || []).length;
  assert.strictEqual(open, close, 'div 标签必须配对');
});

// ------------------------------------------------------------
// bg 官方译文 (backgroundTranslation): 只属于 bg, 不进主歌词 translation
// ------------------------------------------------------------
test('bg 译文: 标准化层挂到 backgroundTranslation, 不动 translation/words/时间轴', () => {
  const ctx = makeSandbox();
  loadParse(ctx);
  const lines = [
    { t: 1, duration: 3, text: 'line one', words: [{ text: 'line one', t: 1, d: 1, c0: 0, c1: 8 }], charCount: 8 },
    { t: 5, duration: 3, text: 'line two', words: [], charCount: 8 },
  ];
  const backgrounds = ctx.normalizeLyricBackgroundEntries([
    { t: 1.2, duration: 0.5, text: '(Ah)', words: [{ text: '(Ah)', t: 1.2, d: 0.5 }], standalone: false, parentT: 1, translation: '(啊)' },
  ]);
  assert.strictEqual(backgrounds.length, 1);
  assert.strictEqual(backgrounds[0].translation, '(啊)', 'normalize 必须保留 bg 译文');
  const out = ctx.attachLyricBackgrounds(lines, backgrounds);
  assert.strictEqual(out[0].background, '(Ah)', 'bg 原文必须照旧');
  assert.strictEqual(out[0].backgroundTranslation, '(啊)', 'bg 译文必须单独存放');
  assert.strictEqual(out[0].translation, undefined, 'bg 译文绝不能写成主行 translation');
  assert.strictEqual(out[0].text, 'line one', '原文文本不得改变');
  assert.strictEqual(out[0].t, 1, '主行时间不得改变');
  assert.strictEqual(out[0].duration, 3, '主行时长不得改变');
  assert.ok(Array.isArray(out[0].words) && out[0].words.length === 1, '逐词不得改变');
  const plain = ctx.attachLyricBackgrounds([{ t: 1, duration: 3, text: 'x' }], ctx.normalizeLyricBackgroundEntries([
    { t: 1.2, text: '(Ah)', standalone: false, parentT: 1 },
  ]));
  assert.strictEqual(plain[0].backgroundTranslation, undefined, '无 bg 译文时不得写入字段');
});

test('bg 译文: payload 层带进 bg entry (translation), 主行 entry 不变', () => {
  const ctx = makeSandbox();
  loadVisual(ctx);
  const parentEntry = { text: 'line one', role: 'current', lineIndex: 0, background: '(Ah)', backgroundTranslation: '(啊)' };
  const bgEntry = ctx.makeStageLyricBackgroundEntry(parentEntry);
  assert.strictEqual(bgEntry.role, 'bg');
  // 显示层: bg 主歌词/译文去掉最外层包裹括号 (原始 line.background* 数据必须原样保留)
  assert.strictEqual(bgEntry.text, 'Ah', 'bg 显示文本必须去掉包裹括号');
  assert.strictEqual(bgEntry.translation, '啊', 'bg 译文同样去掉包裹括号');
  assert.strictEqual(parentEntry.background, '(Ah)', '原始 bg 数据不得被修改');
  assert.strictEqual(parentEntry.backgroundTranslation, '(啊)', '原始 bg 译文数据不得被修改');
  assert.strictEqual(bgEntry.parentIndex, 0, 'bg parentIndex 不变');
  assert.strictEqual(bgEntry.backgroundLine, true);
  const plain = ctx.makeStageLyricBackgroundEntry({ text: 'line one', role: 'current', lineIndex: 0, background: '(Ah)' });
  assert.strictEqual(plain.translation, '');
});

test('bg 译文: 3D 渲染层在同一 bg 行内绘制原文 + 译文 (不动槽位/层序/深度)', () => {
  const src = fs.readFileSync(path.join(visualDir, '12-lyrics-row-layers.js'), 'utf8');
  assert.match(src, /var backgroundTranslation = backgroundLine \? normalizeStageLyricText\(entry\.translation \|\| ''\) : ''/, 'bg 译文只能在 bg 行内处理');
  assert.match(src, /text: backgroundTranslation/, 'bg 译文作为同一 mask 的第二行 entry');
  assert.match(src, /maskEntries\.push/, '必须追加 mask 行, 而不是新建行/改槽位');
  const anchor = src.match(/function lyricBackgroundAnchoredY[\s\S]*?\n}/);
  assert.ok(anchor, 'lyricBackgroundAnchoredY 必须仍然存在');
  assert.ok(!/backgroundTranslation|entry\.translation/.test(anchor[0]), 'bg 槽位锚定函数不得因 bg 译文而改动');
});

// ------------------------------------------------------------
// 边界: 禁止区域未被触碰
// ------------------------------------------------------------
test('管道: bg 契约必须穿过 handleAppleLyric 响应 (否则真实应用拿不到 bg)', () => {
  const api = fs.readFileSync(path.join(appRoot, 'apple-music-api.js'), 'utf8');
  assert.match(api, /bg:\s*Array\.isArray\(web\.bg\)/, 'handleAppleLyric 必须透传 web.bg');
  assert.match(api, /web\.bg\.length \? web\.bg : undefined/, '无 bg 时必须省略字段 (兼容旧行为)');
});

test('边界: 背景人声实现未触碰 SMTC/音频/Beat/播放器/凭证/API/其他三源', () => {
  const forbidden = [
    'desktop/smtc-bridge.ps1',
    'apple-music-api.js',
    'server.js',
    'desktop/preload.js',
  ];
  // 这些文件在本任务中不得出现 x-bg 相关改动
  forbidden.forEach((rel) => {
    const src = fs.readFileSync(path.join(appRoot, rel), 'utf8');
    assert.ok(!/x-bg/.test(src), rel + ' 不应包含 x-bg 改动');
  });
  // 其他三源实现文件不得含 x-bg
  const sources = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '12-smtc', '05-smtc-lyric-sources.js'), 'utf8');
  assert.ok(!/x-bg/.test(sources), '歌词源注册表不应包含 x-bg 逻辑 (bg 由解析层统一处理)');
});

// ------------------------------------------------------------
// TEST 13: bg 附属行的绘制层序 —— 必须高于"同父行译文", 低于"当前行主文本"
//
// 现场实测 (cinema + translation=current, 真实歌曲 line 20 同时带译文与 bg):
//   当前行主文本 renderOrder = renderBase + 0.40 = 260.40
//   同父行译文   renderOrder = renderBase + 0.39 = 260.39  <- 把 bg 行整行盖住
//   bg 附属行    renderOrder = renderBase - 0.40 - ... = 259.59 (旧公式, 被译文覆盖)
// 修复: 只有 bg 行改为 renderBase + 0.395。
// ------------------------------------------------------------
test('TEST 13: bg 行永远画在最底层 (位于主歌词/译文/上下文行之前) + 竖向让开译文行', () => {
  const ctx = makeSandbox();
  ctx.lyricTextureClarityScale = () => 1;
  ctx.lyricVerticalFloatEnabled = () => false;
  ctx.lyricQualityPoolBudgetBytes = () => 32 * 1024 * 1024;
  loadVisual(ctx); // 08 + 09
  vm.runInContext(fs.readFileSync(path.join(visualDir, '12-lyrics-row-layers.js'), 'utf8'), ctx, { filename: '12-lyrics-row-layers.js' });

  ctx.fx = { lyricDisplayMode: 'cinema', lyricTranslationMode: 'current' };
  ctx.lyricsLines = [
    { t: 0, duration: 4, text: 'A', translation: '甲' },
    { t: 4, duration: 4, text: 'B', translation: '乙', background: 'bgB' },
    { t: 8, duration: 4, text: 'C' },
    { t: 12, duration: 4, text: 'D' },
  ];
  const p1 = ctx.lyricPrimaryVirtualIndex(1);
  const bgGap = ctx.lyricBackgroundGapValue();
  const translationGap = ctx.lyricTranslationVisualGapValue();
  const mkMesh = () => ({ position: { x: 0, y: 0, z: 0 }, scale: { x: 1, setScalar(v) { this.x = v; } }, renderOrder: 0, visible: true, material: { transparent: true, blending: 1 } });
  const mkMat = () => ({ uniforms: { uOpacity: { value: 0 }, uProgress: { value: 0 }, uActiveMix: { value: 0 } } });
  const mkRow = (o) => Object.assign({
    mesh: mkMesh(), mat: mkMat(), targetAlpha: 1, baseY: 0, baseZ: 0, baseScale: 1, fontScale: 1,
    renderLineUploaded: true, renderWindowActive: false, renderRevealAt: 0,
    readability: null, readabilityMat: null, glow: null, glowMat: null,
    isPrimary: true, isTranslation: false, isBackground: false, parentRole: '', delta: 0,
  }, o);
  const active = mkRow({ text: 'B', lineIndex: 1, virtualIndex: p1 });
  const translation = mkRow({ text: '乙', lineIndex: null, parentIndex: 1, isTranslation: true, isPrimary: false, parentRole: 'current', virtualIndex: p1 + translationGap });
  const bg = mkRow({
    text: 'bgB', lineIndex: null, parentIndex: 1, isBackground: true, parentRole: 'current', virtualIndex: p1 + bgGap,
    readability: { position: { x: 0, y: 0, z: 0 }, scale: { x: 1, setScalar(v) { this.x = v; } }, renderOrder: 0, visible: true },
    readabilityMat: mkMat(),
  });
  const contextRow = mkRow({ text: 'C', lineIndex: 2, virtualIndex: ctx.lyricPrimaryVirtualIndex(2) });
  const data = {
    rowLayers: [active, translation, bg, contextRow], usesTrack: true, displayMode: 'cinema',
    rowLayerGroup: { renderOrder: 0 }, contextGroup: { renderOrder: 0 }, readabilityGroup: { renderOrder: 0 },
    lineWorldStep: 0.5, translationLineStepWorld: 0.4, trackVisibleRadius: 3,
    trackTargetLineIndex: 1, trackTargetVirtualIndex: p1, trackScrollOffset: p1,
    trackPersistent: true, trackScrollPrimed: true, renderInitialTextReady: true,
  };
  ctx.updateLyricRowLayers(data, { opacity: 1, renderBase: 43, time: 1, targetLineIndex: 1, targetVirtualIndex: p1 });
  // 行位置是逐帧缓动的: 迭代到收敛后再断言位置 (renderOrder 是直接赋值, 单次即可)
  for (let k = 0; k < 150; k++) ctx.updateLyricRowLayers(data, { opacity: 1, renderBase: 43, time: 1, targetLineIndex: 1, targetVirtualIndex: p1 });

  assert.strictEqual(active.mesh.renderOrder, 43.4, '当前行主文本仍必须是 renderBase + 0.40');
  assert.ok(Math.abs(translation.mesh.renderOrder - 43.39) < 1e-9, '译文行公式不得改动 (renderBase + 0.05 + 0.34), 实际 ' + translation.mesh.renderOrder);
  assert.ok(Math.abs(bg.mesh.renderOrder - 42.395) < 1e-9, 'bg 行必须是 renderBase - 0.605, 实际 ' + bg.mesh.renderOrder);
  // bg 在最底层: 位于同父行译文、当前行主文本、以及普通上下文主行之前 (否则会压住相邻行)
  assert.ok(bg.mesh.renderOrder < translation.mesh.renderOrder, 'bg 行必须绘制在同父行译文之前 (bg 在最底层)');
  assert.ok(bg.mesh.renderOrder < active.mesh.renderOrder, 'bg 行必须绘制在当前行主文本之前');
  assert.ok(bg.mesh.renderOrder < contextRow.mesh.renderOrder, 'bg 行必须绘制在普通上下文主行之前 (不得压住后续歌词)');
  assert.strictEqual(bg.readability.renderOrder, bg.mesh.renderOrder - 0.04, 'bg 行 readability 必须紧随其主 mesh (自动派生)');
  // 非 bg 的普通上下文行公式完全不变
  const scrollAfter = data.trackScrollOffset;
  const expectedContext = 43 - 0.40 - Math.min(5.5, Math.abs(ctx.lyricPrimaryVirtualIndex(2) - scrollAfter)) * 0.015;
  assert.ok(Math.abs(contextRow.mesh.renderOrder - expectedContext) < 1e-9, '非 bg 上下文行层序不得改变, 实际 ' + contextRow.mesh.renderOrder + ' 期望 ' + expectedContext);

  // 静态守卫: 只有 bg 走新分支, 普通歌词/译文公式逐字未变
  const rowSrc = fs.readFileSync(path.join(visualDir, '12-lyrics-row-layers.js'), 'utf8');
  assert.match(rowSrc, /row\.isBackground \? \(renderBase - 0\.605\)/, 'bg 层序分支必须是最底层');
  assert.match(rowSrc, /isBackground:\s*!!entry\.backgroundLine/, 'isBackground 只能来自 entry.backgroundLine');
  assert.match(rowSrc, /isActive \? \(renderBase \+ 0\.40\)/, '当前行主文本公式不得改动');
  assert.match(rowSrc, /renderBase \+ 0\.05 \+ \(currentTranslation \? 0\.34/, '译文行公式不得改动');
  assert.match(rowSrc, /renderBase - 0\.40 - Math\.min\(5\.5, abs\) \* 0\.015/, '普通上下文行公式不得改动');
  assert.ok(!/row\.isBackground \? \(renderBase \+/.test(rowSrc), 'bg 不得再使用 renderBase + 的层序');

  // 竖向避让: 同父行译文行存在时, bg 行必须落在"译文行"与"下一主行"的正中 (否则叠字, 实测曾只差 0.08)
  const trY = translation.mesh.position.y;
  const bgY = bg.mesh.position.y;
  const nextY = -(ctx.lyricPrimaryVirtualIndex(2) - data.trackScrollOffset) * 0.5;
  assert.ok(bgY < trY, 'bg 行必须排在译文行下方, 实际 bgY=' + bgY + ' transY=' + trY);
  assert.ok(bgY > nextY, 'bg 行不得压到下一主行, 实际 bgY=' + bgY + ' nextY=' + nextY);
  assert.ok(Math.abs(bgY - (trY + nextY) / 2) < 1e-9, 'bg 行必须居中于译文行与下一主行之间, 实际 ' + bgY + ' 期望 ' + (trY + nextY) / 2);
  // 无同父行译文行时, bg 行位置不得改变 (走原有通用公式)
  const ctx2 = makeSandbox();
  ctx2.lyricTextureClarityScale = () => 1;
  ctx2.lyricVerticalFloatEnabled = () => false;
  ctx2.lyricQualityPoolBudgetBytes = () => 32 * 1024 * 1024;
  loadVisual(ctx2);
  vm.runInContext(fs.readFileSync(path.join(visualDir, '12-lyrics-row-layers.js'), 'utf8'), ctx2, { filename: '12-lyrics-row-layers.js' });
  ctx2.fx = { lyricDisplayMode: 'cinema', lyricTranslationMode: 'off' };
  ctx2.lyricsLines = [{ t: 0, text: 'A' }, { t: 4, text: 'B', background: 'bgB' }, { t: 8, text: 'C' }];
  const q1 = ctx2.lyricPrimaryVirtualIndex(1);
  const onlyBg = mkRow({ text: 'bgB', lineIndex: null, parentIndex: 1, isBackground: true, virtualIndex: q1 + ctx2.lyricBackgroundGapValue() });
  const onlyMain = mkRow({ text: 'B', lineIndex: 1, virtualIndex: q1 });
  const data2 = {
    rowLayers: [onlyMain, onlyBg], usesTrack: true, displayMode: 'cinema',
    rowLayerGroup: { renderOrder: 0 }, contextGroup: { renderOrder: 0 }, readabilityGroup: { renderOrder: 0 },
    lineWorldStep: 0.5, translationLineStepWorld: 0.4, trackVisibleRadius: 3,
    trackTargetLineIndex: 1, trackTargetVirtualIndex: q1, trackScrollOffset: q1,
    trackPersistent: true, trackScrollPrimed: true, renderInitialTextReady: true,
  };
  ctx2.updateLyricRowLayers(data2, { opacity: 1, renderBase: 43, time: 1, targetLineIndex: 1, targetVirtualIndex: q1 });
  for (let k = 0; k < 150; k++) ctx2.updateLyricRowLayers(data2, { opacity: 1, renderBase: 43, time: 1, targetLineIndex: 1, targetVirtualIndex: q1 });
  const expectedLegacyY = -(q1 + ctx2.lyricBackgroundGapValue() - data2.trackScrollOffset) * 0.5;
  assert.ok(Math.abs(onlyBg.mesh.position.y - expectedLegacyY) < 1e-9, '没有同父行译文时 bg 位置必须保持原样, 实际 ' + onlyBg.mesh.position.y + ' 期望 ' + expectedLegacyY);
});

// ------------------------------------------------------------
// TEST 14: 译文行不得吃掉 bg 附属行的行数预算 (实测: 43 行歌 + 42 译文行 -> bgRows = 0)
// ------------------------------------------------------------
test('TEST 14: 整首歌都有译文时, bg 附属行仍必须全部注入', () => {
  const ctx = makeSandbox();
  loadVisual(ctx);
  ctx.fx = { lyricDisplayMode: 'cinema', lyricTranslationMode: 'current' };
  // 模拟 applyLyricTranslationModeToTrackEntries 的产物: 每行后面跟一条译文附属行
  const rows = [];
  ctx.lyricsLines = [];
  for (let i = 0; i < 43; i++) {
    const hasBg = i % 5 === 0; // 9 行带背景人声 (与实测歌曲一致)
    ctx.lyricsLines.push({ t: i * 4, duration: 4, text: 'line ' + i, background: hasBg ? 'bg ' + i : '' });
    rows.push({ text: 'line ' + i, role: i === 10 ? 'current' : 'context', alpha: 1, scale: 1, lineIndex: i, background: hasBg ? 'bg ' + i : undefined });
    rows.push({ text: '译文 ' + i, role: 'translation', alpha: 0.6, scale: 0.78, translationLine: true, parentIndex: i, parentRole: i === 10 ? 'current' : 'context' });
  }
  const maxRows = rows.length + 2; // 与真实调用一致: entries.length * 2 + 2
  const applied = ctx.applyLyricBackgroundEntriesToTrackEntries(rows, 20, maxRows);
  const bgRows = applied.entries.filter((e) => e.role === 'bg');
  const expected = ctx.lyricsLines.filter((l) => l.background).length;
  assert.strictEqual(bgRows.length, expected, '译文行不得挤掉 bg 行, 期望 ' + expected + ' 条, 实际 ' + bgRows.length);
  // 主行 + 译文行必须一条不少
  assert.strictEqual(applied.entries.filter((e) => e.translationLine).length, rows.filter((r) => r.translationLine).length, '译文行不得被 bg 注入挤掉');
  assert.strictEqual(applied.entries.filter((e) => !e.translationLine && e.role !== 'bg').length, 43, '主行不得被挤掉');
  // activeLine 仍必须指向主行
  assert.strictEqual(applied.entries[applied.activeLine].role, 'current', 'activeLine 必须仍指向当前主行');
  // 每条 bg 必须紧跟其父行
  applied.entries.forEach((e, i) => {
    if (e.role !== 'bg') return;
    assert.ok(i > 0, 'bg 行不得出现在首位');
    assert.strictEqual(applied.entries[i - 1].lineIndex, e.parentIndex, 'bg 行必须紧跟其父行');
  });
  const payloadSrc = fs.readFileSync(path.join(visualDir, '09-lyrics-payloads.js'), 'utf8');
  assert.match(payloadSrc, /Math\.round\(Number\(maxRowsOverride\) \|\| 24\)\) \+ entries\.length/, 'bg 注入预算必须加上已占用的行数');
});

// ------------------------------------------------------------
// TEST 15: 局部 bg 容器间距 (pair-wise, 不累积, 自动恢复)
//
// 有 bg 的父行 A 与其下一主行 B 之间需要更大的 Y 容器, 供 A 的 bg 原文/译文使用;
// 没有 bg 的 pair 必须保持原间距。这是逐 pair 的槽位步进, 不是全局 lineWorldStep。
// ------------------------------------------------------------
test('TEST 15: bg 行的 pair 间距局部扩大, 无 bg 完全不变, 且不累积', () => {
  const ctx = makeSandbox();
  loadVisual(ctx);
  ctx.fx = { lyricDisplayMode: 'cinema', lyricTranslationMode: 'current' };

  function setup(lines) {
    ctx.lyricsLines = lines;
    ctx.lyricsTranslationLines = lines.map((l) => l.translation || '');
  }
  // A) 整首无 bg: 每个 pair 必须与改动前的基准步进完全一致
  setup([
    { t: 0, duration: 4, text: 'A', translation: '甲' },
    { t: 4, duration: 4, text: 'B', translation: '乙' },
    { t: 8, duration: 4, text: 'C', translation: '丙' },
  ]);
  const baseStep = ctx.lyricPrimarySlotStepValue();
  for (let i = 0; i < 3; i += 1) {
    assert.strictEqual(ctx.lyricLineSlotStepValue(i), baseStep, '无 bg 歌曲第 ' + i + ' 个 pair 必须保持原间距');
  }
  const basePairWorld = Number((ctx.lyricPrimaryVirtualIndex(1) - ctx.lyricPrimaryVirtualIndex(0)).toFixed(6));
  assert.ok(Math.abs(basePairWorld - baseStep) < 1e-9, '无 bg 时 A→B 槽位差 = 基准步进');

  // B) 交错 bg: line1 与 line3 有 bg
  setup([
    { t: 0, duration: 4, text: 'A0', translation: 't0' },
    { t: 4, duration: 4, text: 'A1', translation: 't1', background: 'bg1' },
    { t: 8, duration: 4, text: 'A2', translation: 't2' },
    { t: 12, duration: 4, text: 'A3', translation: 't3', background: 'bg3' },
    { t: 16, duration: 4, text: 'A4', translation: 't4' },
    { t: 20, duration: 4, text: 'A5', translation: 't5' },
  ]);
  const bgGap = ctx.lyricBackgroundGapValue();
  const extra = ctx.lyricBackgroundExtraGapValue();
  assert.ok(extra > 0, 'extra gap 必须为正');
  const step0 = ctx.lyricLineSlotStepValue(0);   // 0 无 bg, 1 有 bg -> 仅有 bgGap
  const step1 = ctx.lyricLineSlotStepValue(1);   // 1 自身有 bg -> + extra
  const step2 = ctx.lyricLineSlotStepValue(2);   // 2 无 bg, 3 有 bg -> 仅有 bgGap
  const step3 = ctx.lyricLineSlotStepValue(3);   // 3 自身有 bg -> + extra
  const step4 = ctx.lyricLineSlotStepValue(4);   // 4/5 都无 bg -> 基准
  assert.ok(Math.abs(step0 - (baseStep + bgGap)) < 1e-9, 'pair(0→1) 仅有 bg 槽位: ' + step0);
  assert.ok(Math.abs(step1 - (baseStep + bgGap + extra)) < 1e-9, 'pair(1→2) 必须扩大 extra: ' + step1);
  assert.ok(Math.abs(step2 - (baseStep + bgGap)) < 1e-9, 'pair(2→3) 不得带上上一行的 extra: ' + step2);
  assert.ok(Math.abs(step3 - (baseStep + bgGap + extra)) < 1e-9, 'pair(3→4) 自身有 bg 才扩大: ' + step3);
  assert.strictEqual(step4, baseStep, 'bg 之后的普通 pair 必须恢复原间距 (不累积)');
  // 累积检查: 整首步进总和 = 各 pair 之和 (无全局变量累加)
  let sum = 0;
  for (let i = 0; i < 6; i += 1) sum += ctx.lyricLineSlotStepValue(i);
  const expectedSum = (baseStep + bgGap) + (baseStep + bgGap + extra) + (baseStep + bgGap) + (baseStep + bgGap + extra) + baseStep + baseStep;
  assert.ok(Math.abs(sum - expectedSum) < 1e-9, '总步进必须等于逐 pair 之和');
  const bgPairCount = 2;
  assert.ok(Math.abs(sum - (baseStep * 6 + bgGap * 4 + extra * bgPairCount)) < 1e-9, 'extra 只出现 bg 行数那么多次');

  // C) 真实世界间距 (取实测歌曲参数 lineWorldStep = 0.3675)
  const lineWorldStep = 0.3675;
  const pairWithoutBg = baseStep * lineWorldStep;
  const pairWithBgBeforeChange = (baseStep + bgGap) * lineWorldStep;   // 改动前: 只有 bg 槽位
  const pairWithBg = (baseStep + bgGap + extra) * lineWorldStep;       // 改动后: bg 槽位 + extra
  assert.ok(Math.abs((pairWithBg - pairWithBgBeforeChange) - extra * lineWorldStep) < 1e-9, 'A→B 增量 = extra * lineWorldStep');
  assert.ok(extra * lineWorldStep > 0.15, '实际增量应大于 0.15 世界单位: ' + (extra * lineWorldStep).toFixed(4));
  // 第二轮: 第一轮 0.50(≈0.18 世界) 真机仍重叠, 按实测残差提到 1.00 (≈0.37 世界);
  // 上限只用于防"把舞台永久拉稀", 超过 0.45 世界 (≈1.2 槽位) 视为夸张。
  assert.ok(extra * lineWorldStep < 0.45, '实际增量不得夸张 (< 0.45 世界单位): ' + (extra * lineWorldStep).toFixed(4));
  assert.ok(extra <= 1.2, 'extra 槽位值必须 <= 1.2: ' + extra);
  assert.ok(pairWithBg > pairWithoutBg, '有 bg 的 pair 必须更长');

  // D) 静态守卫: extra 必须只在"本行自身有 bg"时加入, 且进入前缀缓存键
  const src = fs.readFileSync(path.join(visualDir, '08-lyrics-display-modes.js'), 'utf8');
  assert.match(src, /if \(lyricLineHasBackgroundAt\(n\)\) total \+= lyricBackgroundExtraGapValue\(\);/, 'extra 必须按本行 bg 逐 pair 添加');
  assert.match(src, /Math\.round\(lyricBackgroundExtraGapValue\(\) \* 1000\)/, '前缀缓存键必须包含 extra (否则虚索引不会失效)');
  assert.ok(!/globalLineStep|lineStepAccum|\+= extraGap/.test(src), '不得引入全局累加变量');
});

// ------------------------------------------------------------
// TEST 16: track bundle 必须随 bg 数据变化而重建
//   (1) stageLyricTrackKeyForMode() 必须包含 bg 签名 (复用已有的 lyricBackgroundSignature)
//   (2) 缓存命中时必须做 bg 签名一致性校验, 不一致则重新构建 (不复用旧 entries)
// ------------------------------------------------------------
test('TEST 16: bg 签名参与 trackKey + 缓存命中做 bg 一致性校验', () => {
  const src = fs.readFileSync(path.join(visualDir, '14-stage-lyrics-rendering.js'), 'utf8');
  const keyFn = src.match(/function stageLyricTrackKeyForMode\(mode\)[\s\S]*?\n\}/);
  assert.ok(keyFn, 'stageLyricTrackKeyForMode 必须存在');
  assert.match(keyFn[0], /lyricBackgroundSignature\(\)/, 'trackKey 必须包含已有的 lyricBackgroundSignature()');
  assert.match(keyFn[0], /typeof lyricBackgroundSignature === 'function'/, 'bg 签名必须做可用性保护 (旧环境安全)');
  const joinIdx = keyFn[0].indexOf(".join('|')");
  const sigIdx = keyFn[0].indexOf('lyricBackgroundSignature()');
  assert.ok(sigIdx > 0 && joinIdx > sigIdx, 'bg 签名必须在 .join 之前追加到键数组');

  const builder = src.match(/function buildStageLyricTrackEntries\(index, mode\)[\s\S]*?\n\}/);
  assert.ok(builder, 'buildStageLyricTrackEntries 必须存在');
  assert.match(builder[0], /currentBgSignature/, '构建时必须计算当前 bg 签名');
  assert.match(builder[0], /cacheBgSignatureMatches/, '缓存命中必须校验 bg 签名一致性');
  assert.match(builder[0], /bgSignature: currentBgSignature/, '写缓存时必须记录 bg 签名');
  assert.match(builder[0], /cacheBgSignatureMatches\)\s*\{/, '签名一致才允许复用缓存');
  assert.ok(!/background\s*=\s*(null|undefined|'')/.test(builder[0]), '不得因 mismatch 修改 payload 的 background');
  assert.ok(!/delete\s+tlyric|backgroundTranslation\s*=\s*''/.test(builder[0]), '不得删除 bg/翻译数据');

  // (3) display payload key 也必须带 bg 签名 (否则 mesh 不会重建), single + multi 两处
  const displayFn = src.match(/function buildStageLyricDisplayPayload\(index, options\)[\s\S]*?\n\}/);
  assert.ok(displayFn, 'buildStageLyricDisplayPayload 必须存在');
  const displayBgKeyCount = (displayFn[0].match(/\|bg=' \+ bgSignature/g) || []).length;
  assert.strictEqual(displayBgKeyCount, 2, 'single 与 multi 两条 display key 都必须带 bg 签名, 实际 ' + displayBgKeyCount);
  assert.match(displayFn[0], /bgSignature: bgSignature/, 'display payload 必须记录 bgSignature 供复用校验');
  assert.match(displayFn[0], /typeof lyricBackgroundSignature === 'function'/, 'display 侧签名同样要有可用性保护');

  // (4) 同一行复用 currentPayload 之前必须校验 bg 签名
  const reuseBlock = src.match(/var currentPayloadBgMatches[\s\S]{0,700}?buildStageLyricPlaybackPayload\(newIdx\);/);
  assert.ok(reuseBlock, '必须存在 currentPayload bg 一致性复用校验');
  assert.match(reuseBlock[0], /currentPayloadBgSignature === null \|\| currentPayloadBgSignature === currentBgSignature/, '签名不一致时不得复用');
  assert.match(reuseBlock[0], /buildStageLyricPlaybackPayload\(newIdx\)/, '不一致时必须重新构建 playback payload');
  // 不得在复用校验里改动数据
  assert.ok(!/background\s*=\s*(null|undefined|'')/.test(reuseBlock[0]), '复用校验不得修改 bg 数据');
});

// ------------------------------------------------------------
// TEST 17: bg 行必须参与"行是否已驻留"的判定, 否则缺 bg 的 bundle 永远不会被重建
//   (1) stageLyricResidentRowKey: bg 行用自己的 parentIndex 建键 (不能塌缩成 0|primary)
//   (2) stageLyricPersistentLineRowsResident: 有 bg 数据却没有 bg 行 -> 判为未驻留
// ------------------------------------------------------------
test('TEST 17: bg 行参与驻留判定 + bg 行键不与 primary 冲突', () => {
  const src = fs.readFileSync(path.join(visualDir, '14-stage-lyrics-rendering.js'), 'utf8');
  const keyFn = src.match(/function stageLyricResidentRowKey\(row\)[\s\S]*?\n\}/);
  assert.ok(keyFn, 'stageLyricResidentRowKey 必须存在');
  assert.match(keyFn[0], /if \(row\.isBackground\)/, 'bg 行必须单独建键');
  assert.match(keyFn[0], /\|bg'/, 'bg 行的键必须以 |bg 结尾 (不得与 primary 冲突)');
  assert.match(keyFn[0], /row\.parentIndex/, 'bg 行键必须来自 parentIndex');
  assert.match(keyFn[0], /Math\.round\(lineIndex\) \+ '\|' \+ \(row\.isTranslation \? 'translation' : 'primary'\)/, '非 bg 行的键规则必须保持原样');

  const resident = src.match(/function stageLyricPersistentLineRowsResident\(data, lineIndex, rowMap\)[\s\S]*?\n\}/);
  assert.ok(resident, 'stageLyricPersistentLineRowsResident 必须存在');
  assert.match(resident[0], /entry\.background && !rowMap\[lineIndex \+ '\|bg'\]\) return false/, '有 bg 数据却没有 bg 行时必须判为未驻留');
  assert.match(resident[0], /if \(!rowMap\[lineIndex \+ '\|primary'\]\) return false;/, 'primary 判定必须保持原样');
  // 不得在此处增删/过滤 bg 数据
  assert.ok(!/background\s*=\s*(null|undefined|'')/.test(resident[0]), '驻留判定不得修改 bg 数据');
});
