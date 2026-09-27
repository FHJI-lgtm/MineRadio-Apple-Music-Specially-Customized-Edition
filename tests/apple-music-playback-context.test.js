// E-A regression net: the external Apple Music single-play context must change the CURRENT UI CONTEXT
// only. It may never touch the queue, statistics, like state or the last-playback snapshot.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const MODULES = path.join(ROOT, 'public', 'js', 'modules');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function readAll() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(fs.readFileSync(p, 'utf8'));
    }
  })(MODULES);
  return out.join('\n');
}

const detailRel = 'public/js/modules/05-playback/06-track-detail-lyrics-actions.js';
const searchRel = 'public/js/modules/05-playback/07-search.js';
const detail = read(detailRel);
const search = read(searchRel);

function grab(name) {
  const m = detail.match(new RegExp('function ' + name + '\\(\\) \\{[\\s\\S]*?\\n\\}'));
  assert.ok(m, name + ' must exist in ' + detailRel);
  return m[0];
}

function sandbox() {
  const box = {
    currentPlaybackContext: null, currentIdx: -1, playQueue: [], currentLocalSong: null,
    // no external session by default -> the live branch of the unified accessor must stay inert
    smtcExternalOwnsUi: () => false,
  };
  vm.createContext(box);
  vm.runInContext([grab('currentQueueSong'), grab('externalLiveSong'), grab('currentCoverSong'), grab('currentLyricSong')].join('\n'), box);
  return box;
}

test('1. no external context -> behaviour is exactly the queue one (no regression)', () => {
  const box = sandbox();
  box.playQueue = [{ name: 'B' }];
  box.currentIdx = 0;
  assert.equal(box.currentCoverSong().name, 'B');
  assert.equal(box.currentLyricSong().name, 'B', 'the lyric accessor must be the same fact');
});

test('2. a published AM context becomes the current track for the unified accessor only', () => {
  const box = sandbox();
  box.playQueue = [{ name: 'B' }];
  box.currentIdx = 0;
  box.currentPlaybackContext = { provider: 'apple', identitySource: 'amc', name: 'A' };
  assert.equal(box.currentCoverSong().name, 'A');
  assert.equal(box.currentLyricSong().name, 'A');
});

test('3. currentQueueSong() ignores the external context (statistics / snapshot / like stay queue-only)', () => {
  const box = sandbox();
  box.playQueue = [{ name: 'B' }];
  box.currentIdx = 0;
  box.currentPlaybackContext = { provider: 'apple', identitySource: 'amc', name: 'A' };
  assert.equal(box.currentQueueSong().name, 'B');
  for (const rel of ['public/js/modules/05-playback/02-listen-stats.js', 'public/js/modules/05-playback/09-queue-snapshot-autoplay.js']) {
    const src = read(rel);
    assert.equal(/currentCoverSong\(\)/.test(src), false, rel + ' must not consume the unified accessor');
    assert.equal(/currentQueueSong\(\)/.test(src), true, rel + ' must use the queue-only accessor');
  }
});

test('4. the context is written by one owner only and never by the queue world', () => {
  const all = readAll();
  const writes = all.match(/currentPlaybackContext\s*=(?!=)/g) || [];
  assert.equal(writes.length, 2, 'expected the declaration plus the single writer');
  // Step 3 widened the chain: published context -> LIVE external session -> queue. The queue-only
  // accessor is untouched, so statistics/snapshot/like stay queue-only (test 3).
  assert.match(detail, /function currentCoverSong\(\) \{\s*return currentPlaybackContext \|\| externalLiveSong\(\) \|\| currentQueueSong\(\);/);
  assert.match(detail, /function currentLyricSong\(\) \{\s*return currentCoverSong\(\);/);
  assert.equal(/playQueue\s*=/.test(search), false, '07-search must never replace the queue');
  assert.equal(/currentIdx\s*=/.test(search), false, '07-search must never move the queue index');
});

test('5. publishing is three-state, evidence-only, and pauses MineRadio first', () => {
  // comment-proof: count CODE lines only. A comment that merely MENTIONS the call text used to fail this
  // (it did, during the amcContextContradicted fix) - the same class of false signal as the shipped-bug
  // assertion below.
  const codeOnly = search.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  const publishes = codeOnly.match(/setCurrentPlaybackContext\(/g) || [];
  assert.equal(publishes.length, 1, 'exactly one publish point');
  assert.match(search, /res\.ok === true && !amcContextContradicted/);
  assert.match(search, /disagreement === true && res\.verified === false/);
  assert.match(search, /identitySource: 'amc'/);
  assert.match(search, /identityConfidence: 'evidence-only'/);
  assert.equal(/identityConfidence: 'confirmed'/.test(search), false, 'alias/normalized must never be upgraded');
  // F1: the pause step must be a one-way stop. The old assertion here pinned the shipped bug
  // (it REQUIRED togglePlay in this path) - string-level tests happily encode defects.
  assert.match(search, /internalAudioPlayingNow\(\)/);
  // scope matters: 07-search.js uses togglePlay() for other UI too - only the PAUSE STEP must never toggle
  // comment-proof: strip comments first, then assert on CODE only
  const pauseCode = marked(search, 'F1-PAUSE').replace(/\/\/[^\n]*/g, '');
  assert.equal(/togglePlay\s*\(/.test(pauseCode), false, 'the pause step must never toggle');
  assert.match(pauseCode, /\.pause\s*\(/, 'the pause step must stop the deck');
  assert.match(search, /amInternalAudio\.pause\(\)/);
  assert.equal(/\bplaying\s*=/.test(search), false, 'the publish path must not write `playing` directly');
});
// ---- F5: behavioural assertions (the shipped bug was invisible to string matching) ----
const vm2 = require('node:vm');
const searchSrc = read(searchRel);
const renderSrc = read('public/js/modules/02-visual/15-ripples-cover-depth.js');

function marked(src, tag) {
  const m = src.match(new RegExp('// E-A ' + tag + '-BEGIN[\\s\\S]*?// E-A ' + tag + '-END'));
  assert.ok(m, 'marked block ' + tag + ' must exist');
  return m[0].replace(/^[ \t]*\/\/ E-A .*-(BEGIN|END).*$/gm, '');
}

test('6. the pause step is a one-way stop: it never toggles and never reaches playQueueAt()', () => {
  const calls = { pause: 0, toggle: 0, playQueueAt: 0, sync: 0 };
  const box = {
    audio: { pause() { calls.pause++; } },
    internalAudioPlayingNow: () => true,
    syncPlaybackStateFromAudioEvent: () => { calls.sync++; },
    togglePlay: () => { calls.toggle++; },
    playQueueAt: () => { calls.playQueueAt++; },
  };
  vm2.createContext(box);
  vm2.runInContext(marked(searchSrc, 'F1-PAUSE'), box);
  assert.equal(calls.pause, 1, 'the internal deck must be stopped exactly once');
  assert.equal(calls.toggle, 0, 'togglePlay must never be used as a pause');
  assert.equal(calls.playQueueAt, 0, 'the pause step must never trigger a queue play');
});

test('7. the pause step does nothing when MineRadio is silent', () => {
  const calls = { pause: 0 };
  const box = { audio: { pause() { calls.pause++; } }, internalAudioPlayingNow: () => false, togglePlay: () => { throw new Error('must not toggle'); } };
  vm2.createContext(box);
  vm2.runInContext(marked(searchSrc, 'F1-PAUSE'), box);
  assert.equal(calls.pause, 0);
});

test('8. queue-side bar repaints are suppressed while an AM context owns the UI', () => {
  const guard = marked(renderSrc, 'F1-GUARD');
  const fn = new Function('currentPlaybackContext', guard + '\nreturn "REACHED";');
  assert.equal(fn({ provider: 'apple', identitySource: 'amc' }), undefined, 'must return early');
  assert.equal(fn(null), 'REACHED', 'must fall through without an AM context');
});

test('9. publish stays three-state and alias/normalized never becomes verified', () => {
  assert.match(searchSrc, /res\.ok === true && !amcContextContradicted/);
  assert.match(searchSrc, /identityConfidence: 'evidence-only'/);
  assert.equal(/identityConfidence: 'confirmed'/.test(searchSrc), false);
  assert.match(searchSrc, /disagreement === true && res\.verified === false/);
});
test('11. an Apple playlist play action is scoped to its button (never intercepts other panel clicks)', () => {
  const panelSrc = read('public/js/modules/06-lyrics/02-playlist-detail.js');
  // the AM branch must sit INSIDE the playDetail block ...
  // (the window is a proxy for "inside this block": B-i added the whole-playlist branch in front of
  //  the first-track fallback, so the distance grew from ~300 to ~1500 characters)
  assert.match(panelSrc, /if \(playDetail\) \{[\s\S]{0,2600}?amcPlaylistFirst/);
  // ... and must never appear before the detection line (that would swallow every panel click)
  const detectionAt = panelSrc.indexOf('var playDetail = e.target');
  const firstAmcAt = panelSrc.indexOf('amcPlaylistFirst');
  assert.ok(detectionAt >= 0 && firstAmcAt > detectionAt, 'the AM branch must come after the detection');
  assert.match(panelSrc, /amcCand\.provider === 'apple' && amcCand\.catalogId/);
  assert.match(panelSrc, /playPlaylistPanelDetail\(\);/);
  // B-i: the whole-playlist branch must come FIRST - a failed playlist attempt is reported, never
  // quietly replaced by the first-track path (that fallback is only for a missing IPC bridge).
  const wholeAt = panelSrc.indexOf('playApplePlaylistInAppleMusic(detailName');
  assert.ok(wholeAt > detectionAt && wholeAt < firstAmcAt, 'the whole-playlist branch must precede the first-track fallback');
});
test('12. the control bar is painted from the published context, title included', () => {
  // The painter must exist separately from the guarded writer: the guard blocks QUEUE repaints while an
  // external context owns the UI, so the context's own repaint has to bypass it (it used to hit the guard
  // and paint nothing, leaving control-title/control-artist on the previous internal song).
  assert.match(renderSrc, /function applyControlTrackInfo\(song\) \{/);
  const utStart = renderSrc.indexOf('function updateControlTrackInfo(song) {');
  const utEnd = renderSrc.indexOf('\n}', utStart);
  assert.ok(utStart >= 0 && utEnd > utStart, 'updateControlTrackInfo must exist');
  const utBody = renderSrc.slice(utStart, utEnd);
  assert.match(utBody, /E-A F1-GUARD-BEGIN[\s\S]*E-A F1-GUARD-END/, 'the guard block must stay intact');
  assert.match(utBody, /applyControlTrackInfo\(song\);/, 'the guarded writer must delegate to the painter');
  assert.match(searchSrc, /applyControlTrackInfo\(currentPlaybackContext\)/);
  // The title source: the normalised AMC/web model carries `title`, not trackName/name.
  assert.match(searchSrc, /name: String\(model\.title \|\| model\.trackName \|\| model\.name \|\| ''\)/);
});

test('13. publishAmcPlaybackContext RUNS and reaches the bar painter (a ReferenceError used to kill it)', () => {
  // Regression the source-string tests could not see: the guard read `amcContextContradicted`, which only
  // existed as a local var inside amcPlayRow, so every publish threw
  // ReferenceError before setCurrentPlaybackContext() - the context was never established and
  // applyControlTrackInfo() never ran. This test EXECUTES the function with stubs and watches what happens.
  const start = searchSrc.indexOf('function publishAmcPlaybackContext(res, model, amcContextContradicted) {');
  const end = searchSrc.indexOf('// E-A F6: hand a canonical Apple playlist track');
  assert.ok(start >= 0 && end > start, 'publishAmcPlaybackContext must take the contradiction flag explicitly');
  const fnSrc = searchSrc.slice(start, end);
  const box = {
    internalAudioPlayingNow: () => false,
    audio: null,
    syncPlaybackStateFromAudioEvent: () => {},
    setAlbumBackground: () => {},
    currentPlaybackContext: null,
    calls: [],
  };
  box.setCurrentPlaybackContext = function (ctx) { box.calls.push(['context', ctx]); box.currentPlaybackContext = ctx; return ctx; };
  box.applyControlTrackInfo = function (song) { box.calls.push(['paint', song]); };
  vm.createContext(box);
  vm.runInContext(fnSrc + '\nthis.__publish = publishAmcPlaybackContext;', box);
  // publish case: the context is established AND the painter is reached with it
  box.__publish({ ok: true, verified: true, disagreement: false, artistLayer: 'exact' },
    { title: 'Kiss Land', artist: 'Abel Tesfaye', artworkUrl: 'u', trackId: 1, collectionId: 1499378108 }, false);
  assert.equal(box.calls.length, 2, 'both setCurrentPlaybackContext and applyControlTrackInfo must run');
  assert.equal(box.calls[0][0], 'context');
  assert.equal(box.calls[0][1].name, 'Kiss Land');
  assert.equal(box.calls[0][1].artist, 'Abel Tesfaye');
  assert.equal(box.calls[0][1].provider, 'apple');
  assert.equal(box.calls[0][1].identitySource, 'amc');
  // Step 4: the clicked result came from the public iTunes plane, so its collectionId IS a catalog album
  // id - carried explicitly so the album page opens for a published context without any lookup.
  assert.equal(box.calls[0][1].albumId, '1499378108');
  assert.equal(box.calls[1][0], 'paint');
  assert.equal(box.calls[1][1].name, 'Kiss Land', 'the painter must receive the context, not null');
  // three-state: an explicit contradiction must not publish at all
  box.calls.length = 0;
  box.__publish({ ok: true, verified: false, disagreement: true }, { title: 'X' }, true);
  assert.equal(box.calls.length, 0, 'a contradicted verdict must not publish');
  // and both call sites must pass the flag explicitly - that IS the fix
  assert.match(searchSrc, /publishAmcPlaybackContext\(res, model, amcContextContradictedOf\(res\)\)/);
  assert.match(searchSrc, /publishAmcPlaybackContext\(res, amModel, amcContextContradictedOf\(res\)\)/);
  assert.match(searchSrc, /function amcContextContradictedOf\(res\) \{/);
});

test('14. the bar mirrors the LIVE SMTC identity while an external session owns it', () => {
  const uiSrc = read('public/js/modules/12-smtc/03-smtc-ui.js');
  const start = uiSrc.indexOf('var smtcBarMirrorKey');
  const end = uiSrc.indexOf('function smtcSyncBarPlayIcon() {');
  assert.ok(start >= 0 && end > start, 'the mirror must sit above smtcSyncBarPlayIcon');
  const src = uiSrc.slice(start, end);
  const box = {
    smtcStore: { active: true, title: 'Out of Time', artist: 'Abel Tesfaye', album: 'Dawn FM' },
    internalAudioPlayingNow: () => false,
    calls: [],
  };
  box.applyControlTrackInfo = (song) => box.calls.push(song);
  vm.createContext(box);
  // the mirror builds its identity through externalLiveSong() (the same builder the unified accessor uses)
  vm.runInContext(grab('externalLiveSong') + '\n' + src + '\nthis.__own = smtcExternalOwnsUi; this.__mirror = smtcMirrorControlBarIdentity;', box);
  assert.equal(box.__own(), true, 'an active session with a silent deck owns the bar');
  assert.equal(box.__mirror(), true);
  assert.equal(box.calls.length, 1);
  assert.equal(box.calls[0].name, 'Out of Time');
  assert.equal(box.calls[0].artist, 'Abel Tesfaye');
  assert.equal(box.calls[0].provider, 'apple', 'the bar must keep its AM badge');
  assert.equal(box.__mirror(), false, 'the same identity must not rebuild the badges again');
  assert.equal(box.calls.length, 1);
  box.smtcStore.title = 'Kiss Land';
  assert.equal(box.__mirror(), true);
  assert.equal(box.calls.length, 2);
  assert.equal(box.calls[1].name, 'Kiss Land');
  // Apple Music hands SMTC "Artist <em dash> Album": the bar must show the ARTIST only, and keep the album
  // in its own field. A plain hyphen is never a separator (Jay-Z / T-Pain are single names).
  box.smtcStore.title = 'Out of Time';
  box.smtcStore.artist = 'Abel Tesfaye \u2014 Dawn FM';
  box.smtcStore.album = '';
  assert.equal(box.__mirror(), true);
  assert.equal(box.calls[2].artist, 'Abel Tesfaye');
  assert.equal(box.calls[2].album, 'Dawn FM');
  box.smtcStore.title = 'Blinding Lights';
  box.smtcStore.artist = 'The Weeknd';
  assert.equal(box.__mirror(), true);
  assert.equal(box.calls[3].artist, 'The Weeknd');
  box.smtcStore.title = 'Jay-Z Song';
  box.smtcStore.artist = 'Jay-Z';
  assert.equal(box.__mirror(), true);
  assert.equal(box.calls[4].artist, 'Jay-Z', 'a plain hyphen must never split an artist name');
  const painted = box.calls.length;   // every identity change above painted exactly once
  box.internalAudioPlayingNow = () => true;
  assert.equal(box.__own(), false, 'internal playback takes the bar back');
  assert.equal(box.__mirror(), false);
  assert.equal(box.calls.length, painted, 'yielding must not repaint');
  box.smtcStore.active = false;
  box.internalAudioPlayingNow = () => false;
  assert.equal(box.__mirror(), false, 'no session -> no mirror');
  assert.equal(box.calls.length, painted);
});

test('15. queue repaints cannot steal the bar back while the external session owns it', () => {
  const start = renderSrc.indexOf('function updateControlTrackInfo(song) {');
  const end = renderSrc.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'updateControlTrackInfo must exist');
  const fnSrc = renderSrc.slice(start, end + 2);
  const box = { currentPlaybackContext: null, calls: [] };
  box.applyControlTrackInfo = (song) => box.calls.push(song);
  vm.createContext(box);
  vm.runInContext(fnSrc + '\nthis.__update = updateControlTrackInfo;', box);
  box.smtcExternalOwnsUi = () => true;
  box.__update({ name: 'Kiss Land' });
  assert.equal(box.calls.length, 0, 'a queue repaint must not overwrite the live external identity');
  box.smtcExternalOwnsUi = () => false;
  box.__update({ name: 'Kiss Land' });
  assert.equal(box.calls.length, 1, 'without an external session the queue paints normally');
  box.currentPlaybackContext = { provider: 'apple' };
  box.__update({ name: 'Queue' });
  assert.equal(box.calls.length, 1, 'a published context still blocks queue repaints (F1 unchanged)');
});

test('19. the comment section is omitted for Apple Music and kept for every other provider', () => {
  const start = detail.indexOf('function detailCommentsEnabledForSong(song) {');
  const end = detail.indexOf('function renderDetailCommentComposer(config) {');
  assert.ok(start >= 0 && end > start, 'detailCommentsEnabledForSong must exist');
  const src = detail.slice(start, end);
  const box = { songProviderKey: (song) => (song && (song.provider || song.source)) || 'netease' };
  vm.createContext(box);
  vm.runInContext(src + '\nthis.__enabled = detailCommentsEnabledForSong;', box);
  assert.equal(box.__enabled({ provider: 'apple' }), false, 'Apple Music has no comment interface here');
  assert.equal(box.__enabled({ source: 'apple' }), false);
  assert.equal(box.__enabled({ provider: 'netease', id: 1 }), true);
  assert.equal(box.__enabled({ provider: 'qq' }), true);
  assert.equal(box.__enabled({ provider: 'qishui' }), true);
  assert.equal(box.__enabled(null), true, 'unknown input keeps the previous behaviour');
});

test('30. openSyncSettingsPanel really opens, and no rule hides the panel it just opened', () => {
  const css = read('public/css/index.css');
  assert.match(css, /\.lyric-timing-control\.sync-open #lyric-timing-popover \{/,
    'the 词 popover must be hidden BY ID - the sync panel shares the .lyric-timing-popover class');
  assert.ok(!/\.lyric-timing-control\.sync-open \.lyric-timing-popover/.test(css),
    'a class-scoped hide would also hide #sync-settings-panel: it would open invisible and unclickable');
  // the retired floating cluster is DELETED, not merely hidden: no element is created for it any more, and
  // only the hidden settings host remains (the three node ids are what 05/06 and the sync panel look up)
  const smtcUiSrc = read('public/js/modules/12-smtc/03-smtc-ui.js');
  assert.ok(smtcUiSrc.indexOf('function smtcEnsureSettingsHost()') > 0, 'the hidden settings host must exist');
  ['smtc-hover-container', 'smtc-hover-panel', 'smtc-cover', 'smtc-controls', 'smtc-hover-title'].forEach((id) => {
    assert.ok(smtcUiSrc.indexOf("'" + id + "'") < 0, 'the legacy element ' + id + ' must not be created any more');
  });
  assert.ok(!/#smtc-hover-container|#smtc-hover-panel/.test(css), 'and its CSS must be gone too');
  // nothing that must stay visible may live in that container
  const smtcUi = read('public/js/modules/12-smtc/03-smtc-ui.js');
  assert.ok(smtcUi.indexOf("chip.style.visibility = 'hidden'") > 0,
    'the status chip is body-level and already hidden by itself - it is not lost with the container');
  const mod = read('public/js/modules/06-lyrics/06-lyric-timing-offset.js');
  const slice = (name) => {
    const s = mod.indexOf('function ' + name + '(');
    const e = mod.indexOf('\n}', s);
    assert.ok(s >= 0 && e > s, name + ' must exist');
    return mod.slice(s, e + 2);
  };
  const mk = (id) => ({ id: id, classList: { _s: new Set(), add: function (c) { this._s.add(c); }, remove: function (c) { this._s.delete(c); }, contains: function (c) { return this._s.has(c); } }, contains: () => false, addEventListener: () => {} });
  const els = {};
  ['sync-settings-panel', 'sync-settings-session', 'sync-settings-body', 'lyric-timing-control'].forEach((id) => { els[id] = mk(id); });
  const box = {
    // the module-level flags live outside the sliced functions - they must exist or reading them throws
    syncSettingsOpen: false, syncSettingsAdopted: false, syncSettingsBound: false,
    document: { getElementById: (id) => els[id] || null, addEventListener: () => {} },
    console: { warn: () => {} },
  };
  vm.createContext(box);
  vm.runInContext([
    slice('syncSettingsPanelEl'), slice('syncSettingsControlRoot'), slice('syncSettingsAdoptExistingBlocks'),
    slice('syncSettingsRefreshValues'), slice('syncSettingsBindOnce'), slice('openSyncSettingsPanel'), slice('closeSyncSettingsPanel'),
  ].join('\n') + '\nthis.__open = openSyncSettingsPanel; this.__close = closeSyncSettingsPanel;', box);
  assert.equal(box.__open(), true, 'opening must succeed (a missing mount point used to return false silently)');
  assert.ok(els['sync-settings-panel'].classList.contains('open'), 'the panel gets .open');
  assert.ok(els['lyric-timing-control'].classList.contains('sync-open'), 'and the 词 control collapses its own popover');
  box.__close();
  assert.ok(!els['sync-settings-panel'].classList.contains('open'));
  assert.ok(!els['lyric-timing-control'].classList.contains('sync-open'));
  // moving the pointer between the two panels must not close it instantly (mouseleave fires on the target
  // chain, so crossing the gap between them would otherwise look like "the panel closed itself")
});

test('28. the 词 popover owns the sync entry, and the sync panel is a SINGLE-instance container', () => {
  const html = read('public/index.html');
  assert.match(html, /id="lyric-sync-entry-btn"[^>]*onclick="toggleSyncSettingsPanel\(event\)"/);
  assert.match(html, /id="lyric-source-entry-btn"[^>]*onclick="openLyricSourceSettingsFromBar\(event\)"/);
  assert.match(html, /id="sync-settings-panel"[^>]*class="[^"]*lyric-timing-popover[^"]*sync-settings-popover/);
  assert.match(html, /id="sync-settings-session"><\/div>/);
  assert.match(html, /id="sync-settings-body"><\/div>/);
  // the panel must live inside the 词 control (so hover / focus keeps it open) and before #volume-control
  const ctrl = html.indexOf('id="lyric-timing-control"');
  const panel = html.indexOf('id="sync-settings-panel"');
  const vol = html.indexOf('id="volume-control"');
  assert.ok(ctrl >= 0 && panel > ctrl && vol > panel, 'the sync panel belongs to the 词 control');
  // div balance inside that control: inserting markup here already broke the DOM once
  const seg = html.slice(ctrl, vol);
  assert.equal((seg.match(/<div\b/g) || []).length, (seg.match(/<\/div>/g) || []).length,
    'every <div> in the 词 control must be closed (a missing one swallows the rest of the bar)');
  // and the module must MOVE the existing SMTC nodes: never build a second set (no duplicate fixed ids)
  const mod = read('public/js/modules/06-lyrics/06-lyric-timing-offset.js');
  const start = mod.indexOf('function syncSettingsAdoptExistingBlocks() {');
  const end = mod.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'syncSettingsAdoptExistingBlocks must exist');
  const adopt = mod.slice(start, end);
  assert.ok(adopt.indexOf('appendChild') > 0 && adopt.indexOf('insertBefore') > 0, 'it relocates the existing nodes');
  assert.ok(adopt.indexOf('createElement') < 0 && adopt.indexOf('innerHTML') < 0, 'it never renders a second copy');
  assert.ok(adopt.indexOf("'smtc-session-row'") > 0, 'the SMTC session row is relocated');
  assert.ok(adopt.indexOf("'smtc-builtin-timer-block'") > 0, 'the timeline-source block is relocated');
  assert.ok(adopt.indexOf("'smtc-hover-delay-slot'") > 0, 'the session-delay slot is relocated');
});

test('29. 恢复默认 writes only through the existing setters', () => {
  const mod = read('public/js/modules/06-lyrics/06-lyric-timing-offset.js');
  const rs = mod.indexOf('function syncSettingsRefreshValues() {');
  const re = mod.indexOf('\n}', rs);
  const start = mod.indexOf('function resetSyncSettings() {');
  const end = mod.indexOf('\n}', start);
  assert.ok(rs >= 0 && re > rs && start >= 0 && end > start, 'resetSyncSettings must exist');
  const box = {
    calls: [],
    localStorage: { setItem: () => { throw new Error('reset must not write storage directly'); } },
  };
  box.smtcSetSessionDelayMs = (v) => { box.calls.push(['delay', v]); return 0; };
  box.smtcSetLyricTimelineMode = (m) => { box.calls.push(['mode', m]); return m; };
  box.smtcRenderSmtcSessionRow = () => box.calls.push(['paint-row']);
  box.smtcRenderSessionDelayValue = () => box.calls.push(['paint-delay']);
  box.smtcRenderBuiltinTimerUi = () => box.calls.push(['paint-timer']);
  box.smtcUpdateSessionDelayEnabledState = () => box.calls.push(['paint-enabled']);
  box.showToast = (t) => box.calls.push(['toast', t]);
  vm.createContext(box);
  vm.runInContext(mod.slice(rs, re + 2) + '\n' + mod.slice(start, end + 2) + '\nthis.__reset = resetSyncSettings;', box);
  const res = box.__reset();
  assert.deepEqual(box.calls.slice(0, 2), [['delay', 0], ['mode', 'SMTC']], 'the two settings go through their setters');
  assert.equal(res.delayMs, 0);
  assert.equal(res.timelineMode, 'SMTC');
  assert.equal(box.calls.filter((c) => c[0] === 'paint-delay').length, 1, 'the shown value is repainted');
  assert.ok(box.calls.some((c) => c[0] === 'toast'));
});

test('26. the bar prev/next follow the session; the internal auto-advance never does', () => {
  const ctrl = read('public/js/modules/05-playback/14-player-controls.js');
  const nStart = ctrl.indexOf('function nextTrack(userInitiated) {');
  const nEnd = ctrl.indexOf('\n}', nStart);
  const pStart = ctrl.indexOf('function prevTrack(userInitiated) {');
  const pEnd = ctrl.indexOf('\n}', pStart);
  assert.ok(nStart >= 0 && nEnd > nStart && pStart >= 0 && pEnd > pStart, 'nextTrack/prevTrack must exist');
  const box = {
    calls: [], playQueue: [{ name: 'A' }, { name: 'B' }], currentIdx: 0, playMode: 'normal',
    queueHydrationState: null, playToggleBusy: false,
    smtcExternalOwnsUi: () => true,
  };
  box.smtcControlCommand = (cmd) => box.calls.push(['smtc', cmd]);
  box.forcePlaybackControlsInteractive = () => {};
  box.playQueueAt = (i) => { box.calls.push(['internal', i]); return Promise.resolve(); };
  box.showToast = () => {};
  box.console = { warn: () => {} };
  vm.createContext(box);
  vm.runInContext(ctrl.slice(nStart, nEnd + 2) + '\n' + ctrl.slice(pStart, pEnd + 2) + '\nthis.__next = nextTrack; this.__prev = prevTrack;', box);
  box.__next(true);
  box.__prev(true);
  assert.deepEqual(box.calls, [['smtc', 'next'], ['smtc', 'previous']]);
  assert.equal(box.currentIdx, 0, 'a session-owned bar never moves MineRadio own queue');
  // the internal auto-advance (userInitiated === false) is never diverted to Apple Music
  box.calls.length = 0;
  box.__next(false);
  assert.equal(box.calls.filter((c) => c[0] === 'smtc').length, 0);
  assert.equal(box.calls.filter((c) => c[0] === 'internal').length, 1);
  assert.equal(box.currentIdx, 1);
  // no session owning the bar -> a user click is the internal path again
  box.smtcExternalOwnsUi = () => false;
  box.calls.length = 0;
  box.__prev(true);
  assert.equal(box.calls.filter((c) => c[0] === 'smtc').length, 0);
  assert.equal(box.calls.filter((c) => c[0] === 'internal').length, 1);
});

test('27. a MineRadio source keeps the bar until the user actually plays Apple Music', () => {
  const uiSrc = read('public/js/modules/12-smtc/03-smtc-ui.js');
  const start = uiSrc.indexOf('function smtcExternalOwnsUi() {');
  const end = uiSrc.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'smtcExternalOwnsUi must exist');
  const box = {
    smtcBarLatchKey: '',
    smtcStore: { active: true, isPlaying: false },
    internalAudioPlayingNow: () => false,
    currentPlaybackContext: null,
    queueSong: { provider: 'netease', id: 7, name: 'N', artist: 'A' },
    songProviderKey: (song) => (song && (song.provider || song.source)) || 'netease',
  };
  box.currentQueueSong = () => box.queueSong;
  vm.createContext(box);
  vm.runInContext(uiSrc.slice(start, end + 2) + '\nthis.__owns = smtcExternalOwnsUi;', box);
  // QQ/网易/酷狗 loaded in MineRadio and Apple Music merely sitting there -> MineRadio keeps the bar
  assert.equal(box.__owns(), false);
  // the user PLAYS Apple Music -> the session takes the bar ...
  box.smtcStore.isPlaying = true;
  assert.equal(box.__owns(), true);
  // ... and keeps it when Apple Music is paused again (no snap-back mid-session)
  box.smtcStore.isPlaying = false;
  assert.equal(box.__owns(), true);
  // the user picks another MineRadio song -> MineRadio's own logic is back
  box.queueSong = { provider: 'qq', id: 9, name: 'Q', artist: 'B' };
  assert.equal(box.__owns(), false);
  // Apple Music playing again re-takes it
  box.smtcStore.isPlaying = true;
  assert.equal(box.__owns(), true);
  box.smtcStore.isPlaying = false;
  // an Apple track loaded in MineRadio is never 'defended'
  box.queueSong = { provider: 'apple', id: '1', name: 'A' };
  assert.equal(box.__owns(), true);
  // nothing loaded at all -> the session owns the bar
  box.queueSong = null;
  assert.equal(box.__owns(), true);
  // a published context is an Apple play started from MineRadio -> always wins
  box.queueSong = { provider: 'netease', id: 7, name: 'N', artist: 'A' };
  box.currentPlaybackContext = { provider: 'apple' };
  assert.equal(box.__owns(), true);
  // the internal deck sounding always keeps the bar
  box.currentPlaybackContext = null;
  box.internalAudioPlayingNow = () => true;
  assert.equal(box.__owns(), false);
  // no session at all -> never
  box.internalAudioPlayingNow = () => false;
  box.smtcStore.active = false;
  assert.equal(box.__owns(), false);
});

test('23. the bar play button is the external session transport while it owns the bar', async () => {
  const ctrl = read('public/js/modules/05-playback/14-player-controls.js');
  const start = ctrl.indexOf('async function togglePlay(opts) {');
  const end = ctrl.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'togglePlay must accept opts');
  const fnSrc = ctrl.slice(start, end + 2);
  const box = {
    calls: [], playQueue: [{ name: 'Q' }], currentIdx: 0, audio: null, playToggleBusy: false,
    smtcExternalOwnsUi: () => true,
  };
  box.smtcControlCommand = (cmd) => box.calls.push(['smtc', cmd]);
  box.forcePlaybackControlsInteractive = () => box.calls.push(['force']);
  box.playQueueAt = () => { box.calls.push(['internal-play']); return Promise.resolve(); };
  box.attemptAudioPlay = () => { box.calls.push(['internal-attempt']); return Promise.resolve(); };
  box.console = { warn: () => {} };
  vm.createContext(box);
  vm.runInContext(fnSrc + '\nthis.__toggle = togglePlay;', box);
  await box.__toggle();
  assert.deepEqual(box.calls, [['smtc', 'toggle']], 'an owning session means SMTC toggle and nothing internal');
  assert.equal(box.playToggleBusy, false, 'the busy flag must not be taken by the external branch');
  // an explicit internal intent (the home dashboard resume) is never diverted to Apple Music
  box.calls.length = 0;
  await box.__toggle({ internal: true });
  assert.equal(box.calls.filter((c) => c[0] === 'smtc').length, 0);
  assert.ok(box.calls.some((c) => c[0] === 'internal-play'), 'internal intent drives MineRadio own deck');
  // no session owning the bar -> the plain internal path, exactly as before
  box.calls.length = 0;
  box.smtcExternalOwnsUi = () => false;
  await box.__toggle();
  assert.equal(box.calls.filter((c) => c[0] === 'smtc').length, 0);
  assert.ok(box.calls.some((c) => c[0] === 'internal-play'));
});

test('24. the bar play icon follows the owning session and is restored when it yields', () => {
  const uiSrc = read('public/js/modules/12-smtc/03-smtc-ui.js');
  const start = uiSrc.indexOf('function smtcSyncBarPlayIcon() {');
  const end = uiSrc.indexOf('function smtcControlCommand(cmd) {');
  assert.ok(start >= 0 && end > start, 'smtcSyncBarPlayIcon must exist');
  const box = { smtcStore: { isPlaying: true, active: true }, playing: false, icons: [] };
  box.smtcExternalOwnsUi = () => true;
  box.setPlayIcon = (p) => box.icons.push(p);
  box.playing = true;
  vm.createContext(box);
  vm.runInContext(uiSrc.slice(start, end) + '\nthis.__sync = smtcSyncBarPlayIcon;', box);
  assert.equal(box.__sync(), true);
  assert.deepEqual(box.icons, [true], 'Apple Music playing -> the pause icon');
  box.icons.length = 0;
  box.smtcStore.isPlaying = false;
  assert.equal(box.__sync(), true);
  assert.deepEqual(box.icons, [false], 'Apple Music paused -> the play icon');
  // yielding repaints from MineRadio own deck state, so the icon cannot stick on the external one
  box.icons.length = 0;
  box.smtcExternalOwnsUi = () => false;
  box.playing = false;
  assert.equal(box.__sync(), false);
  assert.deepEqual(box.icons, [false]);
  box.icons.length = 0;
  box.playing = true;
  box.__sync();
  assert.deepEqual(box.icons, [true]);
});

test('25. the bar timeline shows the owning session position, not MineRadio own audio', () => {
  const src = read('public/js/modules/06-lyrics/04-progress-seek.js');
  // slice from setProgressVisual: updatePlaybackProgressUi delegates its painting to it
  const start = src.indexOf('function setProgressVisual(percent) {');
  const end = src.indexOf('function playbackTransitionHasAudibleNextDeck() {');
  assert.ok(start >= 0 && end > start, 'setProgressVisual + updatePlaybackProgressUi must exist');
  const els = { 'progress-fill': { style: {} }, 'progress-thumb': { style: {} }, 'time-display': { textContent: '' } };
  const box = {
    smtcStore: { durationMs: 240000, positionMs: 60000 },
    progressDragState: { previewDuration: 0 },
    audio: { duration: 999, currentTime: 999 },
    document: { getElementById: (id) => els[id] || null },
    clampRange: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    formatProgramTime: (s) => { const t = Math.max(0, Math.round(Number(s) || 0)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); },
    isProgressDragPreviewActive: () => false,
    smtcExternalOwnsUi: () => true,
  };
  vm.createContext(box);
  vm.runInContext(src.slice(start, end) + '\nthis.__update = updatePlaybackProgressUi;', box);
  box.__update();
  assert.equal(els['progress-fill'].style.width, '25%', '60s of 240s');
  assert.equal(els['time-display'].textContent, '1:00 / 4:00');
  // a session without a duration must not divide by zero or show a fake total
  box.smtcStore.durationMs = 0;
  box.__update();
  assert.equal(els['progress-fill'].style.width, '0%');
  assert.equal(els['time-display'].textContent, '1:00 / 0:00');
  // hovering the external timeline never previews a scrub (the channel has no seek command)
  box.smtcStore.durationMs = 240000;
  box.isProgressDragPreviewActive = () => true;
  box.progressDragState.previewDuration = 240;
  box.__update();
  assert.equal(els['progress-fill'].style.width, '25%', 'the external branch runs before any drag preview');
});

test('22. Apple detail rows/albums lose the MineRadio-only actions; other providers keep them', () => {
  const start = detail.indexOf('function appleDetailActionsVisibleForSong(song) {');
  const end = detail.indexOf('function renderDetailCommentComposer(config) {');
  assert.ok(start >= 0 && end > start, 'appleDetailActionsVisibleForSong must exist');
  const pred = detail.slice(start, end);
  const box = { songProviderKey: (song) => (song && (song.provider || song.source)) || 'netease' };
  vm.createContext(box);
  vm.runInContext(pred + '\nthis.__visible = appleDetailActionsVisibleForSong;', box);
  assert.equal(box.__visible({ provider: 'apple' }), false);
  assert.equal(box.__visible({ source: 'apple' }), false);
  assert.equal(box.__visible({ provider: 'netease', id: 1 }), true);
  assert.equal(box.__visible({ provider: 'qq' }), true);
  assert.equal(box.__visible(null), true, 'unknown input keeps the previous behaviour');

  // and the album row renderer really drops them for an Apple track, keeps them otherwise
  const rs = detail.indexOf('function renderAlbumSongList(songs) {');
  const re = detail.indexOf('\n}', rs);
  assert.ok(rs >= 0 && re > rs, 'renderAlbumSongList must exist');
  const box2 = {
    detailAlbumSongs: [],
    songProviderKey: (song) => (song && (song.provider || song.source)) || 'netease',
    escHtml: (s) => String(s == null ? '' : s),
    cloneSong: (s) => Object.assign({}, s),
    songCoverSrc: () => '',
    songDurationLabel: () => '3:00',
    artistCollectTrayIconSvg: () => '<svg class="collect-icon"></svg>',
    artistNextPlusIconSvg: () => '<svg class="next-icon"></svg>',
  };
  vm.createContext(box2);
  vm.runInContext(pred + '\n' + detail.slice(rs, re + 2) + '\nthis.__render = renderAlbumSongList;', box2);
  const appleHtml = box2.__render([{ provider: 'apple', catalogId: '1499378120', name: 'Alone Again', artist: 'The Weeknd', duration: 251 }]);
  assert.ok(appleHtml.indexOf('artist-song-actions') < 0, 'an Apple row renders no row actions');
  assert.ok(appleHtml.indexOf('collectAlbumDetailSong') < 0, 'no 收藏到歌单 for an Apple row');
  assert.ok(appleHtml.indexOf('queueAlbumDetailSongNext') < 0, 'no 下一首播放 for an Apple row');
  assert.ok(appleHtml.indexOf('playAlbumDetailSong(0)') > 0, 'its click still plays it');
  const neteaseHtml = box2.__render([{ provider: 'netease', id: 2, name: 'N', artist: 'A', duration: 200 }]);
  assert.ok(neteaseHtml.indexOf('collectAlbumDetailSong(0)') > 0, 'a netease row keeps 收藏到歌单');
  assert.ok(neteaseHtml.indexOf('queueAlbumDetailSongNext(0)') > 0, 'a netease row keeps 下一首播放');
});

test('20. album-detail tracks carry an explicit catalogId, so an album row can reach the UIA chain', async () => {
  // Without this the renderer had nothing to route on: the album mapper sets id/appleId but no catalogId,
  // which is exactly what the playlist axis had to add for library tracks (playParams.catalogId).
  const webApi = require('../desktop/apple-music-web-api');
  const reads = require('../desktop/apple-music-web-reads-api');
  const savedCatalog = webApi.getCatalog;
  const savedToken = webApi.getMediaUserToken;
  webApi.getMediaUserToken = () => '';
  webApi.getCatalog = () => Promise.resolve({
    ok: true, status: 200,
    json: { data: [{
      id: '1499378108', type: 'albums',
      attributes: { name: 'After Hours', artistName: 'The Weeknd', trackCount: 2, artwork: { url: '' } },
      relationships: { tracks: { data: [
        { id: '1499378120', type: 'songs', attributes: { name: 'Alone Again', artistName: 'The Weeknd', albumName: 'After Hours', durationInMillis: 251000, trackNumber: 1, playParams: { id: '1499378120', kind: 'song', catalogId: '1499378120' } } },
        { id: '1499378121', type: 'songs', attributes: { name: 'Too Late', artistName: 'The Weeknd', albumName: 'After Hours', durationInMillis: 240000, trackNumber: 2 } },
      ] } },
    }] },
  });
  try {
    const r = await reads.handleAppleAlbumDetailWeb('1499378108', { limit: 10 });
    assert.equal(r.album.name, 'After Hours');
    assert.equal(r.songs.length, 2);
    assert.equal(r.songs[0].provider, 'apple');
    assert.equal(r.songs[0].storefront, 'us');
    assert.equal(r.songs[0].catalogId, '1499378120', 'playParams.catalogId wins when Apple sends it');
    assert.equal(r.songs[1].catalogId, '1499378121', 'and a catalog track without playParams still carries its own id');
  } finally {
    webApi.getCatalog = savedCatalog;
    webApi.getMediaUserToken = savedToken;
  }
});

test('21. an Apple album row goes through UIA; anything else keeps the internal deck', () => {
  const start = detail.indexOf('function playAlbumDetailSong(i) {');
  const end = detail.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'playAlbumDetailSong must exist');
  const fnSrc = detail.slice(start, end + 2);
  const box = {
    detailAlbumSongs: [
      { provider: 'apple', catalogId: '1499378120', name: 'Alone Again', artist: 'The Weeknd' },
      { provider: 'apple', name: 'No Explicit Id' },
      { provider: 'netease', id: 9, name: 'N' },
    ],
    detailAlbumContext: { provider: 'apple' },
    detailAlbumGaplessEnabled: false,
    playQueue: null,
    currentIdx: -1,
    calls: [],
  };
  box.playAmcTrackFromSong = (song) => { box.calls.push(['amc', song && song.name]); return Promise.resolve(true); };
  box.closeTrackDetailModal = () => box.calls.push(['close']);
  box.tagAlbumSongsForGapless = (songs) => songs;
  box.setAlbumGaplessPlaybackContext = () => box.calls.push(['gapless']);
  box.safeRenderQueuePanel = () => {};
  box.safeShelfRebuild = () => {};
  box.playQueueAt = (i) => { box.calls.push(['queueAt', i]); return Promise.resolve(); };
  box.console = { warn: () => {} };
  vm.createContext(box);
  vm.runInContext(fnSrc + '\nthis.__play = playAlbumDetailSong;', box);
  // an Apple row WITH an explicit catalogId -> the UIA chain, and the internal queue stays untouched
  box.__play(0);
  // order-independent: the modal closes and the track is handed to Apple Music, nothing else happens
  assert.deepEqual(box.calls.map((c) => c[0]).sort(), ['amc', 'close']);
  assert.equal(box.calls.filter((c) => c[0] === 'amc')[0][1], 'Alone Again');
  assert.equal(box.playQueue, null, 'the internal queue must not be replaced for an Apple track');
  assert.equal(box.currentIdx, -1);
  // an Apple row WITHOUT an explicit catalogId -> internal path (an id is never guessed)
  box.calls.length = 0;
  box.__play(1);
  assert.equal(box.calls.filter((c) => c[0] === 'amc').length, 0);
  assert.equal(box.calls.filter((c) => c[0] === 'queueAt').length, 1);
  assert.ok(Array.isArray(box.playQueue));
  // a non-Apple row -> internal path, exactly as before
  box.calls.length = 0;
  box.__play(2);
  assert.equal(box.calls.filter((c) => c[0] === 'amc').length, 0);
  assert.equal(box.currentIdx, 2);
});

test('17. the AM album id comes from the public catalog, and only ever between IDENTICAL entries', () => {
  const start = detail.indexOf('var appleAlbumIdLookup = {};');
  const end = detail.indexOf('function albumDetailUrlForSong(song) {');
  assert.ok(start >= 0 && end > start, 'the album-id resolver must sit above albumDetailUrlForSong');
  const src = detail.slice(start, end);
  const box = { window: { mineradio: { amc: { searchTracks: () => Promise.resolve({ results: [] }) } } } };
  vm.createContext(box);
  vm.runInContext(src + '\nthis.__token = appleAlbumMatchToken; this.__query = appleAlbumLookupQuery; this.__pick = pickAppleCatalogAlbumId; this.__resolve = resolveAppleCatalogAlbumId;', box);
  // comparison token: case/punctuation insensitive, CJK kept, decorations KEPT (they are other releases)
  assert.equal(box.__token('After Hours (Deluxe)'), 'after hours deluxe');
  assert.equal(box.__token('After Hours (Remixes) - EP'), 'after hours remixes ep');
  assert.equal(box.__token('My Dear Melancholy,'), 'my dear melancholy');
  assert.equal(box.__query({ artist: 'Liam Payne', album: 'LP1' }), 'Liam Payne LP1');
  const song = { name: 'Remember', album: 'LP1', artist: 'Liam Payne' };
  // iTunes search rows carry trackCount/releaseDate/country (verified against the live API) - that is what
  // the duplicate-entry signature is built from.
  const row = (id, album, artist, extra) => Object.assign({
    collectionId: id, album: album, artist: artist, trackName: 'Remember',
    trackCount: 10, releaseDate: '2019-01-01T00:00:00Z', country: 'USA',
  }, extra || {});
  // the exact album wins over a differently named one
  assert.equal(box.__pick([row(111, 'LP1', 'Liam Payne'), row(222, 'LP2', 'Liam Payne')], song), '111');
  // a deluxe edition is a DIFFERENT album, not the same one
  assert.equal(box.__pick([row(333, 'LP1 (Deluxe)', 'Liam Payne')], song), '');
  // a different artist is refused
  assert.equal(box.__pick([row(444, 'LP1', 'Someone Else')], song), '');
  // duplicate catalog entries of ONE release (identical trackCount/releaseDate/country) resolve, by lowest id
  assert.equal(box.__pick([row(555, 'LP1', 'Liam Payne'), row(666, 'LP1', 'Liam Payne')], song), '555');
  // a REAL difference (another trackCount = another release) is refused
  assert.equal(box.__pick([row(555, 'LP1', 'Liam Payne'), row(666, 'LP1', 'Liam Payne', { trackCount: 17 })], song), '');
  // the track playing right now narrows the pool before the signature check
  assert.equal(box.__pick([
    row(777, 'LP1', 'Liam Payne', { trackCount: 10, trackName: 'Another Song' }),
    row(888, 'LP1', 'Liam Payne', { trackCount: 17, trackName: 'Remember' }),
  ], song), '888');
  // no collectionId -> nothing to trust; no album -> no lookup at all
  assert.equal(box.__pick([{ album: 'LP1', artist: 'Liam Payne' }], song), '');
  assert.equal(box.__pick([row(999, 'LP1', 'Liam Payne')], { artist: 'Liam Payne' }), '');
  // the repo's validated alias pair: iTunes credits The Weeknd while SMTC reports Abel Tesfaye
  const dawn = { name: 'Take My Breath', album: 'Dawn FM', artist: 'Abel Tesfaye' };
  assert.equal(box.__pick([row(1234, 'Dawn FM', 'The Weeknd', { trackName: 'Take My Breath' })], dawn), '1234');
  assert.equal(box.__pick([row(1234, 'Dawn FM', 'Abel Tesfaye', { trackName: 'Take My Breath' })], dawn), '1234');
  // the alias never rescues an unrelated artist or a different album
  assert.equal(box.__pick([row(1234, 'Dawn FM', 'Someone Else', { trackName: 'Take My Breath' })], dawn), '');
  assert.equal(box.__pick([row(1234, 'After Hours', 'The Weeknd', { trackName: 'Take My Breath' })], dawn), '');
  // REAL DATA (measured 2026-09-26 through the live iTunes API): "After Hours" exists under two ids that
  // are byte-identical releases (14 tracks, same date/country/track list) -> resolvable; the deluxe and the
  // remix EP carry different names and are excluded by name.
  const afterHours = { name: 'Blinding Lights', album: 'After Hours', artist: 'Abel Tesfaye' };
  assert.equal(box.__pick([
    row(1499385848, 'After Hours', 'The Weeknd', { trackName: 'Blinding Lights', trackCount: 14, releaseDate: '2020-02-19T08:00:00Z' }),
    row(1499378108, 'After Hours', 'The Weeknd', { trackName: 'Blinding Lights', trackCount: 14, releaseDate: '2020-02-19T08:00:00Z' }),
    row(1505683705, 'After Hours (Deluxe)', 'The Weeknd', { trackName: 'Blinding Lights', trackCount: 17, releaseDate: '2020-03-20T07:00:00Z' }),
  ], afterHours), '1499378108');
  // ... and the same for "My Dear Melancholy," (also two identical entries)
  assert.equal(box.__pick([
    row(1363308558, 'My Dear Melancholy,', 'The Weeknd', { trackName: 'Call Out My Name', trackCount: 6, releaseDate: '2018-03-30T07:00:00Z' }),
    row(1363309866, 'My Dear Melancholy,', 'The Weeknd', { trackName: 'Call Out My Name', trackCount: 6, releaseDate: '2018-03-30T07:00:00Z' }),
  ], { name: 'Call Out My Name', album: 'My Dear Melancholy,', artist: 'Abel Tesfaye' }), '1363308558');
});

test('18. the album-id lookup runs once per album per session (hits AND misses are cached)', async () => {
  const start = detail.indexOf('var appleAlbumIdLookup = {};');
  const end = detail.indexOf('function albumDetailUrlForSong(song) {');
  const src = detail.slice(start, end);
  const box = {
    searchCalls: 0,
    window: { mineradio: { amc: { searchTracks: function () { box.searchCalls++; return Promise.resolve({ results: [{ collectionId: 111, album: 'LP1', artist: 'Liam Payne' }] }); } } } },
  };
  vm.createContext(box);
  vm.runInContext(src + '\nthis.__resolve = resolveAppleCatalogAlbumId;', box);
  const asked = (song) => new Promise((resolve) => box.__resolve(song, (id) => resolve(id)));
  assert.equal(await asked({ album: 'LP1', artist: 'Liam Payne' }), '111');
  assert.equal(await asked({ album: 'LP1', artist: 'Liam Payne' }), '111');
  assert.equal(box.searchCalls, 1, 'the second resolve must come from the cache');
  // a missing album is a MISS and stays cached too (no repeated network calls per open)
  assert.equal(await asked({ album: 'Nothing Like This', artist: 'Nobody' }), '');
  assert.equal(await asked({ album: 'Nothing Like This', artist: 'Nobody' }), '');
  assert.equal(box.searchCalls, 2);
});

test('16. the unified accessor prefers the LIVE external session; the queue-only accessor never does', () => {
  const box = sandbox();
  box.playQueue = [{ name: 'Queue Song', artist: 'Q' }];
  box.currentIdx = 0;
  box.smtcStore = {
    active: true, title: 'Out of Time', artist: 'Abel Tesfaye \u2014 Dawn FM', album: '',
    thumbnail: 'data:image/png;base64,AAAA', durationMs: 251000, positionMs: 12000,
  };
  box.internalAudioPlayingNow = () => false;
  box.smtcExternalOwnsUi = () => true;
  const live = box.currentCoverSong();
  assert.equal(live.name, 'Out of Time');
  assert.equal(live.artist, 'Abel Tesfaye');
  assert.equal(live.album, 'Dawn FM');
  assert.equal(live.provider, 'apple');
  assert.equal(live.artworkUrl, 'data:image/png;base64,AAAA', 'the modal cover comes from the SMTC thumbnail');
  // Step 4: the timeline is exported now that the bar shows it and the seek is disabled for sessions
  assert.equal(live.durationMs, 251000);
  assert.equal(live.duration, 251);
  assert.equal(live.positionMs, 12000);
  assert.equal(box.currentLyricSong().name, 'Out of Time', 'the lyric accessor follows the same fact');
  // E-A invariant untouched: statistics / snapshot / like-sync keep the queue-only accessor
  assert.equal(box.currentQueueSong().name, 'Queue Song');
  // a published context (which carries the chain verdict) still wins over the live session
  box.currentPlaybackContext = { provider: 'apple', identitySource: 'amc', name: 'Clicked Track' };
  assert.equal(box.currentCoverSong().name, 'Clicked Track');
  // internal playback takes the bar back: the predicate yields, so nothing external leaks in
  delete box.currentPlaybackContext;
  box.currentPlaybackContext = null;
  box.internalAudioPlayingNow = () => true;
  box.smtcExternalOwnsUi = () => false;
  assert.equal(box.currentCoverSong().name, 'Queue Song');
});