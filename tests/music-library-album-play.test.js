'use strict';
// ============================================================
// 音乐资料库 · 封面播放按钮契约
//
// 运行时行为由 scripts/check-music-library-shell-live.js 覆盖（含 spy 验证数据绑定）。
// 这里钉住几条容易被后续重构破坏的不变量：
//   1. 按钮在封面容器内、绝对定位（不参与网格）
//   2. 卡片自带 data-album，事件委托按卡片取数据（不用全局/别的卡片）
//   3. 播放按钮点击阻止冒泡（不同时触发封面点击）
//   4. 复用既有 AMC 入口，不新增搜索/兜底逻辑
//   5. 状态只在点击时读取，不据点击结果切换图标
//   6. 样式作用域不越界（只影响资料库，不动首页）
// 运行: node tests/music-library-album-play.test.js
// ============================================================
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MODULE = fs.readFileSync(path.join(ROOT, 'public/js/modules/10-shell/06-music-library.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public/css/index.css'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'desktop/preload.js'), 'utf8');

test('album play button: structure, data binding and event isolation', async (t) => {
  await t.test('button lives inside the cover and is absolutely positioned', () => {
    // 模板：按钮在 .mlib-art 容器内
    const cardFn = MODULE.slice(MODULE.indexOf('function albumCardHtml'), MODULE.indexOf('function bindCover'));
    assert.ok(cardFn.length > 0, 'albumCardHtml must exist');
    const artIdx = cardFn.indexOf("class=\"mlib-art");
    const btnIdx = cardFn.indexOf('mlib-play-btn');
    assert.ok(artIdx > 0 && btnIdx > artIdx, 'play button must be rendered after the .mlib-art opening');
    assert.match(cardFn, /data-mlib-play=/, 'button must carry the delegation marker');
    // CSS：绝对定位 + 相对封面容器
    const cssBlock = CSS.slice(CSS.indexOf('.mlib-play-btn {'), CSS.indexOf('.mlib-play-btn svg'));
    assert.match(cssBlock, /position:\s*absolute/, 'play button must be absolutely positioned');
    assert.match(cssBlock, /left:\s*10px/, 'play button sits at the cover bottom-left');
    assert.match(cssBlock, /bottom:\s*10px/);
    assert.match(cssBlock, /width:\s*44px/, 'button size should reuse the 44px icon-button size');
  });

  await t.test('each card carries its own album payload', () => {
    // 数据存在模块内 Map（键 = data-album-id），不塞进 HTML 属性：
    // 塞属性需要 JSON+HTML 双层转义，实测会把属性截断在第一个引号处。
    assert.match(MODULE, /albumPayloads\[String\(album\.id\)\] = album/, 'card must register its own album by id');
    assert.match(MODULE, /data-album-id=/, 'card must carry its own id');
    assert.ok(!/data-album="/.test(MODULE), 'album JSON must NOT be inlined into an HTML attribute');
    assert.match(MODULE, /function readCardAlbum\(card\)/, 'there must be a per-card reader');
    assert.match(MODULE, /card\.getAttribute\('data-album-id'\)/, 'reader must read the id from the card it was given');
    assert.match(MODULE, /return albumPayloads\[id\]/, 'reader must resolve through the per-card id');
    // 不得从某个全局游标/索引取专辑（那会张冠李戴）
    const reader = MODULE.slice(MODULE.indexOf('function readCardAlbum'), MODULE.indexOf('function playLibraryAlbum'));
    assert.ok(!/albumIndex|cards\[|currentAlbum\b/.test(reader),
      'the reader must not pull album data from a shared cursor');
  });

  await t.test('play-button click stops propagation; cover click is the touch entry', () => {
    const bind = MODULE.slice(MODULE.indexOf('function bindAlbumPlayDelegation'), MODULE.indexOf('function syncEmptyHomeForLibrary'));
    assert.ok(bind.length > 0, 'delegation binder must exist');
    assert.match(bind, /target\.closest\('\[data-mlib-play\]'\)/, 'must branch on the play button');
    assert.match(bind, /event\.stopPropagation\(\)/, 'play-button click must stop propagation');
    assert.match(bind, /target\.closest\('\.mlib-art'\)/, 'cover must be a play entry for hover-less devices');
    // 委托挂在网格上（卡片会重渲染，逐个绑定会失效）
    // 「最近添加」区块已按审计结论移除（它与专辑墙完全重复），现在只有专辑墙一个网格。
    assert.match(bind, /mlib-albums-grid/);
    assert.ok(bind.indexOf('mlib-recent-grid') < 0, 'the removed Recently Added grid must not be referenced');
  });

  await t.test('plays through the album-level AMC entry with the measured scope label', () => {
    // 专辑级入口由 amc:play-album 提供（preload 暴露 playAlbum）；它带专辑名 + 曲目名 + 自定义范围/分区标签。
    assert.match(MODULE, /amc\.playAlbum/, 'album play must use the album-level IPC');
    assert.match(PRELOAD, /playAlbum:/, 'preload must expose the album-level entry');
    assert.match(MODULE, /scopeLabel: AMC_ALBUM_SCOPE_LABEL/, 'must pass the measured library scope label');
    assert.match(MODULE, /AMC_ALBUM_SCOPE_LABEL = '你的资料库'/);
    // 本模块不得新增搜索兜底
    const playFn = MODULE.slice(MODULE.indexOf('function playLibraryAlbum'), MODULE.indexOf('function readCardAlbum'));
    assert.ok(!/searchTracks|\/api\/apple\/album\/detail|fetch\(/.test(playFn),
      'album play must not add catalog/global search fallbacks');
  });

  await t.test('icon state is not switched by our own click', () => {
    // 只在真实状态可读时才允许切图标；本次不可读 → 不得有切换逻辑
    assert.ok(!/pauseGlyph|setPlayIconState|isPlaying.*mlib-play-btn/.test(MODULE),
      'must not toggle the icon from the click itself');
    assert.ok(!/classList\.add\('is-playing'\)/.test(MODULE),
      'must not hold a second playing state');
  });

  await t.test('hover-only visibility is gated, with a hover-less entry', () => {
    assert.match(CSS, /html\.mlib-has-hover \.mlib-album-card:hover \.mlib-play-btn/,
      'hover reveal must be scoped to the card AND gated by the detected hover capability');
    // 无 hover 设备：整张封面是入口，按钮不显示（避免 40 个角标压住封面）
    assert.match(CSS, /html:not\(\.mlib-has-hover\) \.mlib-play-btn \{[^}]*display: none/,
      'hover-less devices must hide the chip and rely on the tappable cover');
    assert.match(MODULE, /target\.closest\('\.mlib-art'\)/, 'the cover must be the hover-less play entry');
    // 显隐必须基于卡片 :hover，而不是全局鼠标状态
    assert.ok(!/document\.body\.matches\(':hover'\)/.test(MODULE), 'must not use global hover state');
  });

  await t.test('styles stay in the mlib namespace (home page untouched)', () => {
    const cssBlock = CSS.slice(CSS.indexOf('/* 封面悬停播放按钮'), CSS.indexOf('/* 文字区：无底色、水平居中 */'));
    // 该段里出现的每条选择器都必须带 .mlib- 前缀
    const selectors = cssBlock
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}')
      .map((chunk) => chunk.split('{')[0].trim())
      .filter((sel) => sel && !sel.startsWith('@') && sel.indexOf('{') < 0);
    assert.ok(selectors.length > 0, 'expected selectors in the play-button block');
    selectors.forEach((sel) => {
      sel.split(',').forEach((one) => {
        const s = one.trim();
        if (!s) return;
        assert.ok(s.indexOf('.mlib-') >= 0,
          'play-button styles must not leak outside the mlib namespace: ' + s);
      });
    });
    // 不得改写 .icon-btn 本身
    assert.ok(cssBlock.indexOf('.icon-btn') < 0, 'must not restyle the shared .icon-btn class');
  });
});