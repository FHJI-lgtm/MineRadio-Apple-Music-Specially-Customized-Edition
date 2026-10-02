'use strict';

/*
 * 音乐资料库 Phase 1（P1-Nav）契约测试
 * 设计依据：docs/MUSIC_LIBRARY_PAGE_DESIGN.md 0.2 节
 *
 * 这里只断言"结构关系"和"唯一真相源"，不测视觉。
 * 重点守住三件事：
 *   1. #mlib-nav 是 #top-right 的兄弟节点，不是子元素；
 *   2. #home-btn 仍在 #top-right 内（原样保留）；
 *   3. active 态由 body class 驱动，不由 JS 切 class。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('public/index.html');
const css = read('public/css/index.css');
const loader = read('public/js/index-loader.js');
const moduleSrc = read('public/js/modules/10-shell/06-music-library.js');
const wallpaper = read('public/js/modules/05-playback/04-home-empty-wallpaper.js');
const prefs = read('public/js/modules/00-state/02-preferences-ui-modes.js');

// ---------- 1. 结构与嵌套关系 ----------
const topRightOpen = html.indexOf('<div id="top-right"');
assert(topRightOpen >= 0, '#top-right must exist');

// 取 #top-right 的完整块（到其闭合 div 为止，用注释锚点界定更稳）
const navOpen = html.indexOf('<nav id="mlib-nav"');
const navClose = html.indexOf('</nav>', navOpen);
assert(navOpen >= 0 && navClose > navOpen, '#mlib-nav must exist as a <nav>');

// #mlib-nav 必须出现在 #top-right 之前（兄弟节点，前面插入）
assert(
  navClose < topRightOpen,
  '#mlib-nav must be a SIBLING of #top-right (placed before it), never a child'
);

// #home-btn 必须仍在 #top-right 内部
const topRightClose = html.indexOf('id="fx-fab"');
const homeBtnPos = html.indexOf('id="home-btn"');
assert(homeBtnPos > topRightOpen && homeBtnPos < topRightClose,
  '#home-btn must stay inside #top-right (unchanged)');

// ---------- 2. 入口是纯图标按钮，复用 .icon-btn ----------
assert(/id="music-library-btn"[^>]*class="icon-btn"|class="icon-btn"[^>]*id="music-library-btn"/.test(html),
  '#music-library-btn must reuse the existing .icon-btn class');
const navBlockHtml = html.slice(navOpen, html.indexOf('</nav>', navOpen));
assert(!/mlib-nav-label/.test(navBlockHtml), 'entry must not render a text label');
// 作用域限定在 #mlib-nav 块内：资料库页内的纵向导航菜单**需要**文字标签，
// 但顶部导航入口本身必须是纯图标（文字只放在 aria-label / title 里）。
assert(/aria-label="音乐资料库"/.test(navBlockHtml),
  'entry must carry an aria-label (text lives in a11y attrs, not UI)');
assert(/title="音乐资料库"/.test(navBlockHtml),
  'entry must carry a title for the tooltip');

// ---------- 3. #mlib-nav 只有定位，没有自己的视觉身份 ----------
const navBlock = css.slice(css.indexOf('#mlib-nav {'), css.indexOf('}', css.indexOf('#mlib-nav {')));
assert(/position:\s*fixed/.test(navBlock), '#mlib-nav must be position:fixed');
assert(/z-index:\s*10/.test(navBlock), '#mlib-nav must be z-index:10 (peer of #search-area / #top-right)');
assert(/left:\s*var\(--mlib-nav-left\)/.test(navBlock),
  '#mlib-nav must anchor to the LEFT of the viewport (entry sits beside the search box, not lost on the right)');
assert(!/right:/.test(navBlock),
  '#mlib-nav must not be anchored on the right (the right side is fully occupied by upload + account capsule)');
assert(/-webkit-app-region:\s*no-drag/.test(navBlock),
  '#mlib-nav must opt out of the titlebar drag region (0-44px) or clicks get eaten by window dragging');
for (const banned of ['backdrop-filter', 'border-radius', 'font-size', 'padding']) {
  assert(!navBlock.includes(banned),
    '#mlib-nav must NOT own visual identity (found: ' + banned + ')');
}

// 入口必须与搜索框左侧留出空隙（几何在运行时验证，这里守住契约）
assert(/--mlib-nav-left:/.test(css), 'left offset must be a token, not a magic number');

// ---------- 4. active 态由 body class 驱动，不由 JS 切 class ----------
assert(/body\.music-library-active #music-library-btn/.test(css),
  'active state must be expressed by body class in CSS');
assert(!/\.classList\.(add|remove|toggle)\(\s*['"]active['"]/.test(moduleSrc),
  'module must not toggle an "active" class (body class is the single source of truth)');
assert(/body\.classList\.add\('music-library-active'\)/.test(moduleSrc),
  'module must drive state through body.music-library-active');
assert(/body\.classList\.contains\('music-library-active'\)/.test(wallpaper),
  'shouldShowEmptyHomeCore must yield while the library is open (24 callers funnel through it)');
// 入口在左侧后，不再依赖 #top-right 的宽度，因此也不需要胶囊状态的钩子。
// 这里守住"没有被重新引入耦合"这条不变量。
assert(!/refreshMlibNavAnchor|--mlib-topright-w|--mlib-nav-anchor-right/.test(prefs),
  'capsule auto-hide must NOT need a nav hook anymore (entry is on the left, independent of #top-right)');
assert(!/refreshMlibNavAnchor|--mlib-topright-w|--mlib-nav-anchor-right/.test(moduleSrc),
  'module must not measure #top-right width anymore (left anchor is a constant)');

// ---------- 5. 空壳滚动容器与安全区 ----------
assert(/id="music-library-scroll"/.test(html), 'scroll container must exist');
const scrollIdx = css.indexOf('#music-library-scroll {');
const scrollBlock = css.slice(scrollIdx, css.indexOf('\n}', scrollIdx));
assert(/padding:\s*var\(--mlib-safe-top\)/.test(scrollBlock), 'scroll container needs top safe area');
assert(/var\(--mlib-safe-bottom\)/.test(scrollBlock), 'scroll container needs bottom safe area');
assert(/mask-image/.test(scrollBlock), 'edge fade must use mask-image, not a covering layer');
assert(/overflow-y:\s*auto/.test(scrollBlock), 'scroll container must own the vertical scroll');
assert(!/overflow[^;]*scroll/.test(css.slice(css.indexOf('#music-library {'), css.indexOf('}', css.indexOf('#music-library {')))),
  '#music-library wrapper must not create a nested scroll box');

// ---------- 6. 模块注册与 Phase 1 护栏 ----------
assert(loader.includes("'js/modules/10-shell/06-music-library.js'"),
  'module must be registered in index-loader.js');
assert(/window\.openMusicLibrary\s*=/.test(moduleSrc), 'openMusicLibrary must reach inline onclick');
assert(/window\.closeMusicLibrary\s*=/.test(moduleSrc), 'closeMusicLibrary must be exposed');
for (const banned of ['LibraryProvider', 'registerProvider', 'capabilities', 'createProvider']) {
  assert(!moduleSrc.includes(banned),
    'Phase 1 guardrail (design doc 0.3): module must not build provider abstraction (found: ' + banned + ')');
}

// ---------- 7. 既有语义完全不动 ----------
assert(/onclick="openHomeDashboardLibrary\(\)"/.test(html),
  'existing 音乐库 card must keep openHomeDashboardLibrary() untouched');
assert(/onclick="goHome\(\)"/.test(html), '#home-btn must keep goHome() untouched');
assert(!/openHomeDashboardLibrary[sS]{0,80}openMusicLibrary/.test(html),
  'the two library entries must not be merged');

console.log('music-library-shell: all contract assertions passed');
