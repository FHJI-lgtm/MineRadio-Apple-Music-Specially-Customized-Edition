'use strict';
/**
 * desktop/apple-music-control.js
 *
 * MineRadio -> Apple Music (Windows) control plane, MVP slice.
 *
 *   MineRadio search box
 *        -> iTunes Search API            (this file: searchTracks)
 *        -> unified result model         (trackId / title / artist / album / artwork / durationMs)
 *        -> Apple Music Windows UIA      (this file: playTrack -> the VERIFIED chain)
 *        -> SMTC                         (this file: verification)
 *        -> MineRadio lyrics / visualizer / artwork (unchanged, already fed by smtc-bridge.ps1)
 *
 * HARD RULES (deliberate, do not "optimise" them away)
 *   1. The iTunes `trackId` is MineRadio's OWN association id. It is never sent to Apple Music
 *      and is never expected to be accepted as a playback id. playTrack() only ever passes
 *      title + artist to the player (the chain's in-app search path).
 *   2. UI action is INTENT; SMTC is the FACT. playTrack() re-reads SMTC after the attempt and
 *      reports a mismatch instead of pretending success.
 *   3. No Apple Music developer token, no MusicKit, no credentials are involved anywhere here.
 *   4. No queue / album play / artist pages / background activation / COM in this slice.
 *
 * The playback half is intentionally NOT reimplemented: it shells out to the same chain that was
 * verified in the experiment (`poc/play-song.ps1` -> `Invoke-AmPlaySong`), and only interprets
 * its JSON result.
 */

const https = require('https');
const path = require('path');
const { spawn } = require('child_process');

const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';

const DEFAULT_CHAIN_SCRIPT = path.join(
  __dirname, '..', 'experiment', 'apple-music-windows-control', 'poc', 'play-song.ps1'
);

// ---------------------------------------------------------------------------
// search plane
// ---------------------------------------------------------------------------

function httpJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('itunes http ' + res.statusCode));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('itunes json: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('itunes timeout after ' + timeoutMs + 'ms')); });
    req.on('error', reject);
  });
}

/**
 * One iTunes Search API call, normalised into MineRadio's result model.
 * @param {string} term  free text (title, "title artist", ...)
 * @param {{country?:string, limit?:number, timeoutMs?:number}} [opts]
 */
async function searchTracks(term, opts = {}) {
  const country = (opts.country || 'us').toLowerCase();
  const limit = Math.max(1, Math.min(50, opts.limit || 12));
  const timeoutMs = opts.timeoutMs || 8000;
  if (!term || !String(term).trim()) return [];
  const qs = new URLSearchParams({
    term: String(term).trim(), country, media: 'music', entity: 'song', limit: String(limit),
  });
  const json = await httpJson(ITUNES_SEARCH_URL + '?' + qs.toString(), timeoutMs);
  return (json.results || []).map((r) => normalizeItunesTrack(r, country));
}

function normalizeItunesTrack(r, requestedCountry) {
  const art = r.artworkUrl100 || r.artworkUrl60 || null;
  return {
    source: 'itunes',
    trackId: r.trackId != null ? r.trackId : null,           // association id only
    collectionId: r.collectionId != null ? r.collectionId : null,
    title: r.trackName || '',
    artist: r.artistName || '',
    album: r.collectionName || '',
    artworkUrl: art ? String(art).replace(/\/\d+x\d+bb?\./, '/600x600bb.') : null,
    durationMs: r.trackTimeMillis != null ? r.trackTimeMillis : null,
    country: r.country || '',
    storefront: requestedCountry || '',
    previewUrl: r.previewUrl || null,
  };
}

// ---------------------------------------------------------------------------
// playback plane (delegates to the verified chain; interprets, never reimplements)
// ---------------------------------------------------------------------------

/**
 * Build the Apple Music URL used as the NAVIGATION input for the verified -Url route.
 * Verified shape (the G3/G4 fixtures): .../{storefront}/song/{slug}/{trackId}.
 * The trackId is used ONLY to address the song in that URL: it is still never sent as a playback
 * id, and SMTC remains the only judge of what actually played.
 */
function canonicalUrl(result) {
  const id = result && result.trackId;
  const sf = (result && result.storefront) || '';
  if (!id || !sf) return '';
  const slug = slugify(result.title) || 'song';
  return 'https://music.apple.com/' + String(sf).toLowerCase() + '/song/' + slug + '/' + String(id);
}

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function runChain(result, opts) {
  const script = opts.chainScript || DEFAULT_CHAIN_SCRIPT;
  const route = opts.route || 'url';
  const url = route === 'url' ? canonicalUrl(result) : '';
  if (route === 'url' && !url) {
    return Promise.resolve({ ok: false, stage: 'NO_URL_INPUT', detail: 'route=url requires trackId + storefront', raw: null, url: '' });
  }
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Title', String(result.title || ''),
    '-Artist', String(result.artist || ''),
    '-Retries', String(opts.retries != null ? opts.retries : 0),
    '-TimeoutMs', String(opts.timeoutMs || 6000),
    '-SearchWaitMs', String(opts.searchWaitMs || 6000),
  ];
  if (url) args.push('-Url', url);
  if (opts.pauseFirst) args.push('-PauseFirst');
  if (opts.noLaunch) args.push('-NoLaunch');
  const powershell = opts.powershell || 'powershell.exe';

  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try {
      child = spawn(powershell, args, { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, stage: 'SPAWN_FAILED', detail: e.message, raw: null, url: url });
      return;
    }
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => resolve({ ok: false, stage: 'SPAWN_FAILED', detail: e.message, raw: null, url: url }));
    child.on('close', (code) => {
      const parsed = lastJsonLine(out);
      resolve({
        ok: !!(parsed && parsed.ok),
        stage: parsed ? parsed.stage : 'NO_JSON',
        exitCode: code,
        detail: parsed ? '' : (err.trim() || out.trim().slice(-400)),
        raw: parsed,
        url: url,
      });
    });
  });
}

/** The chain prints one JSON line on stdout (plus human lines with -Human). Take the last that parses. */
function lastJsonLine(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s || s[0] !== '{') continue;
    try { return JSON.parse(s); } catch (e) { /* keep looking */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// verification: UI action is intent, SMTC is fact
// ---------------------------------------------------------------------------

/**
 * Port of the frozen chain's Normalize-AmText (poc/lib/am-common.ps1:64-82), read-only reuse:
 * lowercase, full-width -> half-width, drop "(feat ...)"/"[ft ...]" noise, drop a dash followed by a
 * version marker, keep letters/digits of ANY script (CJK included), collapse spaces.
 * NOTE: this REPLACES the em-dash/en-dash with a space, which is why artist/album must be split
 * BEFORE normalising (see splitArtistAlbum).
 */
function normalizeAmText(s) {
  if (!s) return '';
  let t = String(s).toLowerCase();
  let out = '';
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if (c >= 0xFF01 && c <= 0xFF5E) out += String.fromCharCode(c - 0xFEE0);
    else if (c === 0x3000) out += ' ';
    else out += ch;
  }
  t = out;
  t = t.replace(/\((feat|ft|with)[^)]*\)/g, ' ');
  t = t.replace(/\[(feat|ft|with)[^\]]*\]/g, ' ');
  t = t.replace(/\s*[-\u2013\u2014]\s*(remaster(ed)?|single version|album version|radio edit|live|explicit)\b.*$/g, ' ');
  t = t.replace(/[^\p{L}\p{Nd}]+/gu, ' ');
  return t.trim().replace(/\s+/g, ' ');
}

/**
 * Artist identity rules. These live HERE, not inside verifyAgainstSmtc: the alias knowledge belongs
 * to artist identity, and the verifier only consumes its verdict.
 *
 * The alias table mirrors the resolver's validated table (phase3-resolve/lib/resolve35.ps1:41-43):
 * exactly one pair, observed in real storefront data. Anything not listed must match through the
 * normal layers, so two unrelated artists can never be merged.
 */
const ARTIST_ALIASES = [
  ['the weeknd', 'abel tesfaye'],
];

function artistKey(name) {
  return normalizeAmText(name).replace(/ /g, '');
}

/**
 * Apple Music's SMTC artist string is "<artist> <separator> <album>" - verified live as
 * "Abel Tesfaye - Dawn FM" (U+2014). Split on a dash with surrounding spaces BEFORE normalising,
 * because normalising would turn the separator into a plain space.
 */
function splitArtistAlbum(smtcArtist) {
  const raw = String(smtcArtist || '');
  const parts = raw.split(/\s+[\u2014\u2013-]\s+/);
  return { artist: (parts[0] || '').trim(), album: parts.slice(1).join(' - ').trim() };
}

/**
 * Layers, aligned with the resolver's Test-AmArtistLayer order:
 *   exact      - raw trimmed case-insensitive equality
 *   normalized - Normalize-AmText equality, or the wanted artist contained in the observed one
 *                (this second form mirrors the frozen Test-AmSmtcArtistMatch, which accepts
 *                 Contains so that "Post Malone" matches "Post Malone, Swae Lee")
 *   alias      - the table above, space-stripped keys, either direction
 *   none       - no match
 * Containment is one-directional on purpose: the observed value may be longer than the wanted one,
 * never shorter - the same strictness as the frozen matcher.
 */
function artistLayer(expectedArtist, smtcArtist) {
  const want = String(expectedArtist || '').trim();
  const split = splitArtistAlbum(smtcArtist);
  const observed = split.artist;
  const base = { layer: 'none', observed: observed, observedAlbum: split.album };
  if (!want) return Object.assign(base, { ok: true, layer: 'none' });
  if (!observed) return Object.assign(base, { ok: false });
  if (want.toLowerCase() === observed.toLowerCase()) return Object.assign(base, { ok: true, layer: 'exact' });
  const w = normalizeAmText(want);
  const o = normalizeAmText(observed);
  if (w && o && (w === o || o.indexOf(w) >= 0)) return Object.assign(base, { ok: true, layer: 'normalized' });
  const wk = artistKey(want);
  const ok = artistKey(observed);
  for (const pair of ARTIST_ALIASES) {
    const a = artistKey(pair[0]);
    const b = artistKey(pair[1]);
    if ((wk === a && ok === b) || (wk === b && ok === a)) return Object.assign(base, { ok: true, layer: 'alias' });
  }
  return Object.assign(base, { ok: false });
}

/**
 * Version markers. If the OBSERVED title carries one that the EXPECTED title does not, the played
 * item is a different version and verification must fail - e.g. expected "Out of Time" vs observed
 * "Out of Time (Live)".
 * FIRST CUT: this list is hand-written here. It must be reconciled with the resolver's own version
 * taxonomy in `experiment/apple-music-windows-control/phase3-resolve/lib/version36-markers.json`
 * so that the search plane and the verification plane classify versions the same way.
 */
const VERSION_MARKERS = /\b(live|remix|remaster(?:ed)?|acoustic|instrumental|karaoke|demo|sped\s*up|slowed|extended|radio\s+edit|edit|version|mix|reprise|cover|session)\b/i;

/**
 * Compare the *expected* track (what MineRadio asked for) with the *observed* SMTC state.
 * Rules:
 *   - title: equal, or prefix match after stripping NON-version bracket decoration ("(feat. X)",
 *     "(From ...)") - but a version marker present only on the observed side is a mismatch;
 *   - artist: containment either way (SMTC artist often carries the album, e.g.
 *     "Billie Eilish - HIT ME HARD AND SOFT");
 *   - status must be Playing.
 * Known false-negative sources (alias credits such as "Abel Tesfaye" vs "The Weeknd", context
 * annotations) were quantified in the experiment's analyzer; here they surface as a mismatch with
 * the raw values attached, never silently forgiven.
 */
function verifyAgainstSmtc(expected, smtc) {
  const eTitleRaw = normalizeAmText(expected.title);
  const aTitleRaw = normalizeAmText(smtc && smtc.title);
  const aStatus = (smtc && smtc.status) || '';

  const bare = aTitleRaw.replace(/\s*[\(\[][^)\]]*[\)\]]/g, '').trim();
  const titleBase = !!eTitleRaw && (aTitleRaw === eTitleRaw || bare === eTitleRaw || aTitleRaw.indexOf(eTitleRaw) === 0);
  const versionMismatch = VERSION_MARKERS.test(aTitleRaw) && !VERSION_MARKERS.test(eTitleRaw);
  const titleOk = titleBase && !versionMismatch;

  const al = artistLayer(expected.artist, (smtc && smtc.artist) || '');
  const artistOk = al.ok;

  const mismatch = [];
  if (!titleBase) mismatch.push('title');
  if (versionMismatch) mismatch.push('title-version');
  if (!artistOk) mismatch.push('artist');
  if (aStatus !== 'Playing') mismatch.push('status:' + (aStatus || 'unknown'));

  return {
    verified: mismatch.length === 0,
    titleOk, artistOk,
    artistLayer: al.layer,
    artistObserved: al.observed,
    artistObservedAlbum: al.observedAlbum,
    status: aStatus,
    mismatch,
    expected: { title: expected.title || '', artist: expected.artist || '' },
    actual: { title: (smtc && smtc.title) || '', artist: (smtc && smtc.artist) || '' },
  };
}

/**
 * Play one search result.
 * @param {{title:string, artist:string, trackId?:number}} result  from searchTracks()
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, verified:boolean, stage:string, mismatch:string[],
 *                    expected:object, actual:object, matchedRow?:string, ambiguous?:boolean,
 *                    candidateCount?:number, attempts?:number, timings?:object, error?:string}>}
 */
/**
 * Full diagnostics from the chain result. Kept on BOTH the success and the failure path: a bare
 * SMTC_TIMEOUT once hid the real cause ("clicked a non-SelectionItem element named exactly
 * 'Out of Time' and played 'Visitor' from another EP"), so failures must explain themselves.
 */
function diagnosticsFrom(raw) {
  if (!raw) return {};
  return {
    matchedRow: raw.matchedRow || '',
    ambiguous: !!raw.ambiguous,
    candidateCount: raw.candidateCount != null ? raw.candidateCount : null,
    pickedByPosition: !!raw.pickedByPosition,
    artistFiltered: !!raw.artistFiltered,
    attempts: raw.attempts != null ? raw.attempts : null,
    stageHistory: raw.stageHistory || [],
    stageDetail: raw.stageDetail || '',
    mode: raw.mode || '',
    navigatedBy: raw.navigatedBy || '',
    searchSubmitted: !!raw.searchSubmitted,
    navigated: raw.navigated,
    triedCandidates: raw.triedCandidates || [],
    smtc: raw.smtc || null,
    baseline: raw.baseline || null,
    timings: raw.t || null,
  };
}

async function playTrack(result, opts = {}) {
  if (!result || !result.title) {
    return { ok: false, verified: false, stage: 'BAD_INPUT', mismatch: ['input'],
             expected: {}, actual: {}, error: 'title is required' };
  }
  const route = opts.route || 'url';
  const url = route === 'url' ? canonicalUrl(result) : '';
  // rule 1: result.trackId is used only to build the navigation URL; it is never a playback id.
  const run = await runChain(result, opts);
  const base = { route: route, url: url };
  if (!run.ok || !run.raw) {
    return Object.assign(base, {
      ok: false, verified: false, stage: run.stage || 'FAILED', mismatch: ['playback'],
      expected: { title: result.title, artist: result.artist || '' },
      actual: { title: '', artist: '' },
      error: run.detail || 'chain reported failure',
    }, diagnosticsFrom(run.raw));
  }
  const raw = run.raw;
  const verdict = verifyAgainstSmtc(result, raw.smtc || {});
  return Object.assign(base, { ok: !!raw.ok, stage: raw.stage || '' }, diagnosticsFrom(raw), verdict);
}

module.exports = {
  searchTracks,
  playTrack,
  verifyAgainstSmtc,
  normalizeItunesTrack,
  canonicalUrl,
  normalizeAmText,
  artistLayer,
  splitArtistAlbum,
  ARTIST_ALIASES,
  DEFAULT_CHAIN_SCRIPT,
};
