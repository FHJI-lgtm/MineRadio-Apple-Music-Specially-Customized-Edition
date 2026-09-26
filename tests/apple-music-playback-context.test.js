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
  assert.match(search, /internalAudioPlayingNow\(\)[\s\S]{0,80}togglePlay\(\)/);
  assert.equal(/\bplaying\s*=/.test(search), false, 'the publish path must not write `playing` directly');
});