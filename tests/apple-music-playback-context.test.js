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
  const box = { currentPlaybackContext: null, currentIdx: -1, playQueue: [], currentLocalSong: null };
  vm.createContext(box);
  vm.runInContext([grab('currentQueueSong'), grab('currentCoverSong'), grab('currentLyricSong')].join('\n'), box);
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
  assert.match(detail, /function currentCoverSong\(\) \{\s*return currentPlaybackContext \|\| currentQueueSong\(\);/);
  assert.match(detail, /function currentLyricSong\(\) \{\s*return currentCoverSong\(\);/);
  assert.equal(/playQueue\s*=/.test(search), false, '07-search must never replace the queue');
  assert.equal(/currentIdx\s*=/.test(search), false, '07-search must never move the queue index');
});

test('5. publishing is three-state, evidence-only, and pauses MineRadio first', () => {
  const publishes = search.match(/setCurrentPlaybackContext\(/g) || [];
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