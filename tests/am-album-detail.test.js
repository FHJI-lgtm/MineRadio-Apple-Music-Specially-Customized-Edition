'use strict';
// ============================================================
// 资料库专辑详情页 · 契约测试（静态）
// 运行时行为由 scripts/check-am-album-detail-live.js 覆盖（真实数据 17 项）。
// 这里钉住几条后续重构最容易破坏的不变量。
// 运行: node tests/am-album-detail.test.js
// ============================================================
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MOD = read('public/js/modules/10-shell/07-album-detail.js');
const SHELL = read('public/js/modules/10-shell/06-music-library.js');
const HTML = read('public/index.html');
const CSS = read('public/css/index.css');
const LOADER = read('public/js/index-loader.js');
const READS_API = read('desktop/apple-music-web-reads-api.js');
const CACHE_SVC = read('desktop/apple-music-library-cache.js');
const SERVER = read('server.js');

test('album detail: data axis and identity rules', async (t) => {
  await t.test('tracks come from the library album id, never from a name search', () => {
    assert.match(READS_API, /function handleAppleLibraryAlbumTracksWeb/, 'library album tracks handler must exist');
    assert.match(READS_API, /getLibrary\('\/albums\/' \+ encodeURIComponent\(id\) \+ '\/tracks'/, 'must read /albums/<id>/tracks');
    assert.match(SERVER, /pn === '\/api\/apple\/library\/album\/tracks'/, 'route must be registered');
    // 详情页的取数只能用 library id
    assert.match(MOD, /\/api\/apple\/library\/album\/tracks\?id=' \+ encodeURIComponent\(albumId\)/);
    assert.match(MOD, /function albumIdOf\(album\)/, 'selection identity must be explicit');
    assert.match(MOD, /album\.libraryId \|\| album\.id/, 'libraryId is the primary id');
    // 绝不能用专辑名去搜索/推断曲目
    assert.ok(!/searchTracks|itunes\.apple\.com|\.query=.*album\.name/.test(MOD), 'no name-search fallback');
    assert.ok(!/album\.name[^\n]*encodeURIComponent/.test(MOD), 'album name must never become a query');
  });

  await t.test('track identity keeps the payload ids; no id decoding', () => {
    // 播放统一交给 AMC 的专辑链（amc:play-album）：专辑名 + 曲目名 + 强制「你的资料库」范围 + 分区标签。
    // 不再由渲染层自己拼 trackId/catalogId 交给一条 URL 路线。
    assert.match(MOD, /amc\.playAlbum/, 'playback must go through the album-level IPC');
    assert.match(MOD, /track: trackName/, 'single-track play must pass the track name');
    assert.match(MOD, /scopeLabel: '你的资料库'/, 'the library scope label must be forced');
    // 不得把 library song id 的 i.* 形态解码成 catalog id
    assert.ok(!/replace\(\/\^i\\\.\//.test(MOD), 'must not decode the i.* form into a catalog id');
    assert.ok(!/parseInt\([^)]*catalogId[^)]*\)/.test(MOD), 'catalogId must not be re-derived numerically');
  });

  await t.test('no A-Z sorting: order follows the payload', () => {
    assert.ok(!/localeCompare/.test(MOD), 'no name sorting anywhere');
    assert.ok(!/\.sort\(/.test(MOD), 'the library list must keep the API order (no re-sorting)');
  });
});

test('album detail: states, description and safe rendering', async (t) => {
  await t.test('states are distinguished and retryable', () => {
    assert.match(MOD, /state\.status = 'loading'/, 'loading state must be set explicitly');
    assert.match(MOD, /status: 'idle'/, 'initial state must be idle');
    assert.match(MOD, /state\.status = songs\.length \? 'ready' : 'empty'/);
    assert.match(MOD, /renderTracksError/);
    assert.match(MOD, /onclick=.*retryAmAlbumDetail\(\)/, 'error state must offer a retry');
    assert.match(MOD, /没有可显示的曲目/, 'empty state must be explicit');
  });

  await t.test('description hides entirely when absent, toggles when present', () => {
    assert.match(MOD, /if \(!state\.descFull\)/, 'empty description must take its own branch');
    assert.match(MOD, /desc\.hidden = true/, 'empty description must hide the element');
    assert.match(MOD, /toggle\.hidden = true/, 'toggle must be hidden when there is no description');
    // 展开只切 class，不触碰播放状态
    const toggle = MOD.slice(MOD.indexOf('window.toggleAmAlbumDescription'), MOD.indexOf('window.retryAmAlbumDetail'));
    assert.ok(!/playSongAt|playBusy|catalogId/.test(toggle), 'toggling must never touch playback state');
  });

  await t.test('metadata never renders undefined/NaN and formats conditionally', () => {
    assert.match(MOD, /function fmtDuration\(sec\)/);
    assert.match(MOD, /if \(!isFinite\(s\) \|\| s <= 0\) return ''/, 'invalid duration must yield empty, not NaN');
    assert.match(MOD, /function fmtYear\(dateStr\)/);
    assert.match(MOD, /return \/\^\\d\{4\}\$\/\.test\(y\) \? y : ''/, 'invalid year must yield empty');
    assert.match(MOD, /function fmtTotalDuration\(songs\)/);
    // 展示前统一转义
    assert.match(MOD, /function esc\(s\)/);
  });
});

test('library songs cache and album track rebuild (prototype)', async (t) => {
  await t.test('分页正确：认 next 的 offset、有上限、去重、校验总数与停止原因', () => {
    assert.match(CACHE_SVC, /function offsetFromNext/, 'next must be parsed, not assumed');
    assert.match(CACHE_SVC, /LIBRARY_SONGS_MAX_PAGES/, 'pagination needs a hard cap');
    assert.match(CACHE_SVC, /seen\.has\(key\)/, 'rows must be de-duplicated by library id');
    assert.match(CACHE_SVC, /totalMatches/, 'the collected count must be checked against meta.total');
    assert.match(CACHE_SVC, /stopReason/, 'why pagination stopped must be recorded');
    assert.match(CACHE_SVC, /NEXT_NOT_ADVANCING/, 'a non-advancing cursor must stop the loop');
    assert.match(CACHE_SVC, /NEXT_UNPARSABLE/, 'an unparsable next must stop and be reported');
  });

  await t.test('本地索引：原始与推导分离、可落盘、可从 raw 重建索引', () => {
    assert.match(CACHE_SVC, /raw: \{ songs: \[\], albums: \[\] \}/, 'raw and derived data must be separate stores');
    assert.match(CACHE_SVC, /function rebuildDerived/, 'derived index must be rebuildable from raw alone');
    assert.match(CACHE_SVC, /CACHE_FILE_NAME/, 'the index must persist to disk');
    assert.match(CACHE_SVC, /schemaVersion/, 'the cache file needs a schema version');
    assert.match(CACHE_SVC, /apple-music-library-cache\.js/, 'documented module identity');
  });

  await t.test('增量：轻量探测 + 低频全量对账（Apple 无可用游标，已实测）', () => {
    assert.match(CACHE_SVC, /async function probe/, 'a cheap probe must exist');
    assert.match(CACHE_SVC, /fingerprintsMatch/, 'the probe must compare fingerprints');
    assert.match(CACHE_SVC, /FULL_RECONCILE_MIN_INTERVAL_MS/, 'full reconciles must be rate limited');
    assert.match(CACHE_SVC, /probe-detected-change/, 'a changed probe must trigger a full reconcile');
    assert.match(CACHE_SVC, /fromCache: true, probed: false/, 'the cooldown window must not probe');
  });

  await t.test('重建的校验规则逐条存在（不唯一即拒绝，无法确认不并入）', () => {
    const fn = CACHE_SVC.slice(CACHE_SVC.indexOf('async function reconstructAlbumTracks'), CACHE_SVC.indexOf('module.exports = {'));
    // 规则：名称只用于产生候选
    assert.match(fn, /normalizeText\(r && r\.albumName\) === wantName/, 'album name only produces candidates');
    // 规则：必须有 catalogId
    assert.match(fn, /NO_CATALOG_ID|NO_PLAY_PARAMS/, 'songs without catalogId must not be merged');
    // 规则：反查必须唯一
    assert.match(fn, /AMBIGUOUS_CATALOG_ALBUM/, 'an ambiguous reverse lookup must be refused');
    // 规则：必须真的属于该 catalog 专辑
    assert.match(fn, /NOT_IN_CATALOG_ALBUM/, 'membership in the catalog album must be checked');
    // 规则：整组必须同一 catalog 专辑
    assert.match(fn, /CANDIDATES_SPLIT_ACROSS_ALBUMS/, 'a split group must be refused entirely');
    // 规则：序号合理性只做诊断
    assert.match(fn, /TRACK_NUMBER_MISMATCH|TRACK_NUMBER_OUT_OF_RANGE/, 'track number sanity must be recorded');
    // 名称不一致要降级
    // 名称差异只记录诊断，不拒绝（实测 6/6 是命名约定差异，非身份差异）
    assert.match(fn, /CATALOG_ALBUM_NAME_DIFFERS/, 'a differing album name must be recorded as a diagnostic');
    assert.ok(fn.indexOf("confidence = 'name-mismatch'") < 0, 'a differing album name alone must not reject');
    // 绝不并入未保存曲目
    assert.ok(fn.indexOf('catalogSongs') < 0, 'the rebuild must never add unsaved catalog tracks');
  });

  await t.test('专辑简介：来自 catalog 专辑对象，且绝不夹带 catalog 曲目', () => {
    // 服务层必须把已查到的 catalog 专辑文案回传
    assert.match(CACHE_SVC, /albumNotes/, 'the service must return catalog album meta');
    assert.match(CACHE_SVC, /editorialNotes: catTracks\.attrs\.editorialNotes \|\| null/, 'editorialNotes must be carried through');
    // meta 只含文案字段，不含任何曲目数组
    const meta = CACHE_SVC.slice(CACHE_SVC.indexOf('albumNotes: catTracks.attrs'), CACHE_SVC.indexOf('reasons: [],'));
    assert.match(meta, /copyright/, 'copyright should be available');
    assert.ok(meta.indexOf('tracks') < 0, 'the meta block must never carry catalog tracks');
    // 渲染层读取嵌套结构
    assert.ok(MOD.indexOf('rebuilt.albumNotes') >= 0, 'the renderer must read the album notes payload');
    assert.ok(MOD.indexOf('editorialNotes') >= 0, 'the renderer must map editorialNotes into the description');
    // 简介为空 -> 整块隐藏（不留空白）
    assert.match(MOD, /if \(!state\.descFull\)/, 'an empty description must hide the whole block');
  });

  await t.test('重建已对全部专辑启用（抽样验证后撤除白名单）', () => {
    assert.match(CACHE_SVC, /endpoint-library-song-ids/, 'a localized-name fallback must exist');
    assert.match(CACHE_SVC, /fetchEndpointCandidateIds/, 'the fallback uses endpoint library song ids, not names');
    assert.match(SERVER, /albumNotesFor/, 'album notes must be served independently of the track list');
    assert.ok(SERVER.indexOf('MINERADIO_ALBUM_REBUILD_ALLOWLIST') < 0, 'the allowlist must be gone');
    assert.ok(SERVER.indexOf('NOT_IN_ALLOWLIST') < 0, 'no album should be refused by a list');
    assert.match(SERVER, /await rebuildAlbumTracks\(\{ id: id, name: name, artist: artist \}\)/, 'every album goes through the validated rebuild');
    // 名称差异只作诊断，不得再作为拒绝理由
    assert.ok(CACHE_SVC.indexOf("confidence = 'name-mismatch'") < 0, 'a differing album name must not downgrade by itself');
  });

  await t.test('渲染层：重建结果优先，失败退回原端点，且只显示已保存歌曲', () => {
    const load = MOD.slice(MOD.indexOf('async function loadAlbum'), MOD.indexOf('function modelFor'));
    assert.match(load, /\/api\/apple\/library\/album\/rebuilt/, 'must try the rebuild first');
    assert.match(load, /\/api\/apple\/library\/album\/tracks/, 'must fall back to the original endpoint');
    assert.match(load, /rebuilt\.verified\.length/, 'a rebuild with verified songs must be used');
    assert.match(load, /rebuilt\.albumNotes/, 'album notes must be carried from the rebuild');
    assert.ok(load.indexOf('catalogSongs') < 0, 'no catalog rows may be merged');
  });
});

test('album detail: window lifecycle and isolation', async (t) => {
  await t.test('reuses the existing modal lifecycle', () => {
    assert.match(MOD, /openGsapModal\(mask\)/, 'must reuse openGsapModal');
    assert.match(MOD, /closeGsapModal\(mask, function/, 'must reuse closeGsapModal');
    assert.match(HTML, /id=\"am-album-detail-modal\" class=\"modal-mask\"/, 'must use the modal-mask convention');
    assert.match(MOD, /if \(event\.target === mask\) window\.closeAmAlbumDetail\(\)/, 'backdrop click closes');
  });

  await t.test('theme color is scoped to the window and cleared on close', () => {
    assert.match(MOD, /modal\.style\.setProperty\('--am-theme-a'/);
    // 清理走变量名数组（主题变量不止一个：亮/暗/glow 都由主色派生）
    assert.match(MOD, /--am-theme-light/, 'derived theme vars must exist');
    assert.match(MOD, /--am-theme-dark/);
    assert.match(MOD, /--am-theme-glow/);
    const clearFn = MOD.slice(MOD.indexOf('function clearTheme'), MOD.indexOf('function applyThemeVars'));
    assert.match(clearFn, /removeProperty/, 'theme vars must be cleaned up');
    // 主题只写在窗口上，不能写 body/:root
    assert.ok(!/documentElement\.style\.setProperty\('--am-theme/.test(MOD), 'must not theme the whole app');
    assert.ok(!/document\.body\.style\.setProperty\('--am-theme/.test(MOD), 'must not theme the library page');
  });

  await t.test('曲目数与总时长都来自实际渲染的库内曲目，不用 trackCount 冒充', () => {
    assert.match(MOD, /state\.libraryCount = songs\.length/, 'the count must come from the rendered library songs');
    assert.ok(!/Number\(album\.trackCount\)/.test(MOD), 'must not display the full-release trackCount as the library count');
    assert.match(MOD, /分 ' \+ \(r < 10 \? '0' : ''\) \+ r \+ ' 秒'/, 'total duration must be precise');
    assert.match(MOD, /var totalDur = fmtTotalDuration\(songs\)/, 'total duration must be computed from the rendered songs');
  });

  await t.test('只展示资料库实际保存的曲目：不做 Catalog 补全，也不混入 Catalog 曲目', () => {
    // 渲染层只调用库内曲目接口
    assert.match(MOD, /\/api\/apple\/library\/album\/tracks\?id=' \+ encodeURIComponent\(albumId\)/);
    assert.ok(MOD.indexOf('/album/detail') < 0, 'the renderer must not call the merged (catalog) endpoint');
    // 不存在任何 Catalog 混入的痕迹
    ['catalogSongs', 'catalogMatched', 'mergeTrackRows', 'catalogAlbum'].forEach((k) => {
      assert.ok(MOD.indexOf(k) < 0, 'renderer must not reference ' + k);
    });
    assert.ok(MOD.indexOf("source: 'catalog'") < 0, 'no catalog-sourced rows');
    // 服务端也不再有 Catalog 补全实现
    assert.ok(READS_API.indexOf('resolveCatalogAlbumIdFromLibrarySongs') < 0, 'no catalog resolver');
    assert.ok(READS_API.indexOf('catalogSongs') < 0, 'no catalog merge in the server');
    // 库内曲目 handler 仍在，且只读库内接口
    assert.match(READS_API, /function handleAppleLibraryAlbumTracksWeb/);
    assert.match(READS_API, /getLibrary\('\/albums\/' \+ encodeURIComponent\(id\) \+ '\/tracks'/);
    // 每行都可播（列表里不存在"未保存"的行）
    assert.ok(MOD.indexOf('尚未保存到资料库') < 0, 'no catalog-only playback refusal should remain');
    assert.ok(MOD.indexOf('am-album-src') < 0, 'no library/catalog source badges should remain');
  });

  await t.test('分页诚实：hasMore 时如实提示，不静默丢歌', () => {
    const load = MOD.slice(MOD.indexOf('async function loadAlbum'), MOD.indexOf('function modelFor'));
    assert.match(load, /data\.hasMore/, 'must surface hasMore instead of silently dropping tracks');
  });

  await t.test('Apple Music 式主题色平铺：窗口本体就是主题色，不是黑色容器', () => {
    const modalBlock = CSS.slice(CSS.indexOf('#am-album-detail-modal .am-album-modal {'), CSS.indexOf('.am-album-modal::before'));
    assert.match(modalBlock, /background: linear-gradient/, 'window must carry the themed gradient');
    assert.match(modalBlock, /--am-theme-light/, 'gradient must use the derived light end');
    assert.match(modalBlock, /--am-theme-dark/, 'gradient must use the derived dark end');
    assert.ok(!/background:\s*linear-gradient\(180deg, rgba\(24, 23, 26/.test(modalBlock), 'must not fall back to the base black panel');
    // 深色降级默认值必须存在（封面失败时仍是一块合理背景）
    assert.match(CSS, /#am-album-detail-modal \{[\s\S]{0,220}--am-theme-dark: 16, 23, 29/, 'dark fallback vars must be declared');
  });

  await t.test('歌曲行是连续行 + 细分隔线，不是独立卡片', () => {
    assert.match(CSS, /\.am-album-track \+ \.am-album-track::after/, 'rows must be separated by a hairline');
    const rowBlock = CSS.slice(CSS.indexOf('.am-album-track {'), CSS.indexOf('.am-album-track:hover'));
    assert.ok(!/border:\s*1px/.test(rowBlock), 'rows must not be bordered cards');
    assert.ok(!/background:\s*rgba\(255, 255, 255, \.0[3-9]/.test(rowBlock), 'rows must not have a card background');
    // 页脚不再用深色底条
    const footBlock = CSS.slice(CSS.indexOf('.am-album-foot {'), CSS.indexOf('#am-album-detail-modal .modal-btn'));
    assert.match(footBlock, /background: transparent/, 'footer must not paint a dark bar');
  });

  await t.test('late responses cannot overwrite a newer album', () => {
    assert.match(MOD, /var seq = \+\+reqSeq/, 'every load must take a sequence number');
    const guards = MOD.match(/if \(seq !== reqSeq\) return;/g) || [];
    assert.ok(guards.length >= 2, 'both success and failure paths must check the sequence, got ' + guards.length);
  });

  await t.test('listeners bind once', () => {
    assert.match(MOD, /wrap\.dataset\.amAlbumBound === '1'/, 'track delegation must be idempotent');
  });

  await t.test('more actions never trigger row playback', () => {
    const bind = MOD.slice(MOD.indexOf('function bindTracks'), MOD.indexOf('function init()'));
    assert.match(bind, /var more = t\.closest\('\[data-am-track-more\]'\)/);
    assert.match(bind, /event\.stopPropagation\(\)/, 'more-button click must stop propagation');
    assert.match(bind, /return;\n      \}\n      var row = t\.closest\('\.am-album-track'\)/, 'row branch must come after the more branch');
  });
});

test('album detail: integration with the library page', async (t) => {
  await t.test('module is loaded and card click opens the detail', () => {
    assert.match(LOADER, /'js\/modules\/10-shell\/07-album-detail\.js'/, 'module must be registered');
    assert.match(SHELL, /window\.openAmAlbumDetail\(album\)/, 'card click must open the detail');
    // 播放按钮分支必须先 return，两者互斥
    const handler = SHELL.slice(SHELL.indexOf('function bindAlbumPlayDelegation'), SHELL.indexOf('function applyMlibInputMode'));
    const playIdx = handler.indexOf('playLibraryAlbum(album);');
    const openIdx = handler.indexOf('window.openAmAlbumDetail(album)');
    assert.ok(playIdx > 0 && openIdx > playIdx, 'the play-button branch must come first and return');
  });

  await t.test('keyboard access and touch fallback exist', () => {
    assert.match(SHELL, /grid\.addEventListener\('keydown'/, 'cards must be keyboard reachable');
    assert.match(CSS, /@media \(hover: none\) \{[\s\S]{0,220}\.am-album-track-more/, 'hover-less devices need the more button visible');
    // 更多操作靠 opacity 而非 display，避免行跳动
    const moreBlock = CSS.slice(CSS.indexOf('.am-album-track-more {'), CSS.indexOf('.am-album-track-more:hover'));
    assert.match(moreBlock, /opacity: 0/);
    assert.ok(!/display:\s*none/.test(moreBlock), 'must not use display toggling (would shift the row)');
  });

  await t.test('single scroll container; controls stay put', () => {
    assert.match(CSS, /\.am-album-scroll \{[\s\S]{0,200}overflow-y: auto/);
    assert.ok(!/am-album-tracks \{[\s\S]{0,120}overflow/.test(CSS), 'the track list must not create its own scroller');
    assert.match(CSS, /\.am-album-foot \{[\s\S]{0,120}flex: 0 0 auto/, 'the footer must not scroll away');
  });

  await t.test('existing entry points are untouched', () => {
    assert.match(HTML, /onclick=\"openHomeDashboardLibrary\(\)\"/, 'home 音乐库 card unchanged');
    assert.match(HTML, /onclick=\"goHome\(\)\"/, 'home button unchanged');
    const navClose = HTML.indexOf('</nav>', HTML.indexOf('<nav id="mlib-nav"'));
    const trOpen = HTML.indexOf('<div id="top-right"');
    assert.ok(navClose > 0 && trOpen > navClose, 'nav must close before #top-right opens (sibling, not child)');
  });
});