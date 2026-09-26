// ============================================================
// Read-only shadow test: does the existing MineRadio canonical playlist/track model accept
// Apple Music WEB API payloads?  (mapper / schema compatibility — NOT an old-vs-new A/B test)
//
//   Usage:  node scripts/apple-music-web-mapper-compat.js --token-file="F:\USER TOKEN.txt"
//           (or set APPLE_MEDIA_USER_TOKEN_FILE)
//
// Rules enforced by this script:
//   - GET only. Any non-GET through the web api layer throws immediately (SHADOW_READ_ONLY).
//   - no Developer JWT, no old developer HTTP chain, no UI, no store writes.
//   - the media-user-token is never printed or written; only its length and a short SHA-256
//     fingerprint are reported.
//   - the old mappers are called as-is and never modified; if the old mapper yields undefined
//     fields, that is reported, not "fixed".
//   - ID semantics are reported as UNKNOWN when they cannot be established; nothing is merged.
// ============================================================

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const webApi = require('../desktop/apple-music-web-api');
const legacyApi = require('../apple-music-api');
// the legacy mappers live under _test (testability export), not at the top level
const legacy = (legacyApi && legacyApi._test) || {};

function argValue(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : '';
}

const tokenFile = argValue('token-file') || process.env.APPLE_MEDIA_USER_TOKEN_FILE || '';
if (!tokenFile || !fs.existsSync(tokenFile)) {
  console.error('missing token file: pass --token-file=<path> or set APPLE_MEDIA_USER_TOKEN_FILE');
  process.exit(2);
}
const token = fs.readFileSync(tokenFile, 'utf8').replace(/^\uFEFF/, '').trim().replace(/^["']|["']$/g, '').trim();
const fingerprint = crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 8);
console.log('[shadow] token source=' + path.basename(tokenFile) + ' len=' + token.length + ' sha256_8=' + fingerprint + ' (value never printed)');

// --- active read-only enforcement -------------------------------------------------
let callCount = 0;
const rawRequest = webApi.request;
webApi.request = function (p, o) {
  const method = String((o && o.method) || 'GET').toUpperCase();
  if (method !== 'GET') throw new Error('SHADOW_READ_ONLY: ' + method + ' is forbidden in this phase');
  callCount += 1;
  return rawRequest(p, o);
};
webApi.setCredentialSource(() => token);
webApi.setReadOnly(true);   // module-level guard: non-GET throws even from internal helpers

const STOREFRONT = 'us';

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
function keysOf(obj) {
  return obj && typeof obj === 'object' ? Object.keys(obj).sort() : [];
}
function isPrimitive(v) { return v === null || ['string', 'number', 'boolean'].includes(typeof v); }

function diffCanonical(label, oldObj, webObj) {
  const a = keysOf(oldObj);
  const b = keysOf(webObj);
  const missing = a.filter((k) => !b.includes(k));
  const extra = b.filter((k) => !a.includes(k));
  const typeMismatch = [];
  const valueMismatch = [];
  a.filter((k) => b.includes(k)).forEach((k) => {
    const va = oldObj[k];
    const vb = webObj[k];
    if (typeOf(va) !== typeOf(vb)) { typeMismatch.push(k + ' old:' + typeOf(va) + ' web:' + typeOf(vb)); return; }
    if (isPrimitive(va) && isPrimitive(vb) && String(va) !== String(vb)) valueMismatch.push(k + ' old=' + JSON.stringify(va) + ' web=' + JSON.stringify(vb));
  });
  const oldUndefined = a.filter((k) => oldObj[k] === undefined);
  console.log('  [' + label + '] oldKeys=' + a.length + ' webKeys=' + b.length
    + ' missing=' + missing.length + ' extra=' + extra.length
    + ' typeMismatch=' + typeMismatch.length + ' valueMismatch=' + valueMismatch.length
    + ' oldUndefinedKeys=' + oldUndefined.length);
  if (missing.length) console.log('     missing   : ' + missing.join(','));
  if (extra.length) console.log('     extra     : ' + extra.join(','));
  if (typeMismatch.length) console.log('     typeMismatch: ' + typeMismatch.join(' | '));
  if (valueMismatch.length) console.log('     valueMismatch: ' + valueMismatch.slice(0, 6).join(' | '));
  if (oldUndefined.length) console.log('     oldMapperUndefined: ' + oldUndefined.join(','));
}

// deliberately minimal extraction: it probes the web payload shape, it does NOT reimplement the
// legacy mapper's business rules.
function minimalWebPlaylist(item) {
  const at = (item && item.attributes) || {};
  return {
    id: item && item.id,
    name: at.name,
    trackCount: at.trackCount,
    artwork: at.artwork ? 'present' : undefined,
    description: at.description ? (at.description.standard || at.description.short || 'present') : undefined,
    canEdit: at.canEdit,
    isPublic: at.isPublic,
  };
}
function minimalWebTrack(item) {
  const at = (item && item.attributes) || {};
  return {
    id: item && item.id,
    title: at.name,
    artistName: at.artistName,
    albumName: at.albumName,
    durationMs: at.durationInMillis,
    isrc: at.isrc,
    artwork: at.artwork ? 'present' : undefined,
  };
}

function idAudit(kind, item) {
  const at = (item && item.attributes) || {};
  const pp = at.playParams || {};
  const bits = [
    'id=' + String(item && item.id),
    'type=' + String(item && item.type),
    'playParams.id=' + String(pp.id),
    'playParams.kind=' + String(pp.kind),
    'playParams.catalogId=' + String(pp.catalogId),
    'isrc=' + (at.isrc ? 'present' : 'absent'),
    'url=' + (at.url ? 'present' : 'absent'),
  ];
  return '     ' + kind + ': ' + bits.join('  ') + '   [semantics: UNKNOWN - do not normalize/merge]';
}

(async function main() {
  if (typeof legacy.mapAppleLibraryPlaylist !== 'function' || typeof legacy.mapAppleTrack !== 'function') {
    console.log('[shadow] ABORT: legacy mappers not reachable via _test');
    process.exit(3);
  }
  console.log('[shadow] layers: A web-json -> legacy mapper | B legacy vs minimal web mapper | C id semantics');

  // ---- fetch (GET only) ----
  const bearerLen = (await webApi.getBearer()).length;
  console.log('[shadow] bearer len=' + bearerLen + ' (value never printed)');
  const pls = await webApi.getLibrary('/playlists', { limit: 5 });
  console.log('[shadow] playlists GET status=' + pls.status + ' ok=' + pls.ok + ' code=' + (pls.code || '-') + ' calls=' + callCount);
  if (!pls.ok) { console.log('[shadow] cannot continue without a 200; ERRORS=' + JSON.stringify((pls.errors || []).map((e) => e.code + '/' + e.status))); process.exit(1); }
  const plItems = (pls.json && Array.isArray(pls.json.data)) ? pls.json.data : [];
  console.log('[shadow] playlists returned=' + plItems.length + ' meta.total=' + ((pls.json && pls.json.meta && pls.json.meta.total) || '-'));
  if (!plItems.length) { console.log('[shadow] no playlists to compare'); process.exit(0); }

  console.log('\n=== LAYER A: legacy mapper consumed the web JSON ===');
  plItems.forEach((item, i) => {
    const oldObj = legacy.mapAppleLibraryPlaylist(item);
    console.log('  playlist[' + i + '] legacyMapper=' + (oldObj ? 'object' : String(oldObj)) + ' keys=' + (oldObj ? keysOf(oldObj).length : 0));
    if (i === 0 && oldObj) console.log('     key sample: ' + keysOf(oldObj).slice(0, 14).join(','));
  });

  const first = plItems[0];
  const firstId = String((first && first.id) || '');
  const tr = await webApi.getLibrary('/playlists/' + encodeURIComponent(firstId) + '/tracks', { limit: 5 });
  console.log('  tracks GET status=' + tr.status + ' ok=' + tr.ok + ' code=' + (tr.code || '-'));
  const trItems = (tr.ok && tr.json && Array.isArray(tr.json.data)) ? tr.json.data : [];
  console.log('  tracks returned=' + trItems.length);
  trItems.forEach((item, i) => {
    const oldObj = legacy.mapAppleTrack(item, i, 'shadow:' + firstId, { storefront: STOREFRONT });
    console.log('  track[' + i + '] legacyMapper=' + (oldObj ? 'object' : String(oldObj)) + ' keys=' + (oldObj ? keysOf(oldObj).length : 0));
    if (i === 0 && oldObj) console.log('     key sample: ' + keysOf(oldObj).slice(0, 14).join(','));
  });

  console.log('\n=== LAYER B: legacy mapper vs minimal web mapper (same web JSON) ===');
  plItems.slice(0, 2).forEach((item, i) => {
    diffCanonical('playlist[' + i + ']', legacy.mapAppleLibraryPlaylist(item) || {}, minimalWebPlaylist(item));
  });
  trItems.slice(0, 2).forEach((item, i) => {
    diffCanonical('track[' + i + ']', legacy.mapAppleTrack(item, i, 'shadow:' + firstId, { storefront: STOREFRONT }) || {}, minimalWebTrack(item));
  });

  console.log('\n=== LAYER C: ID semantics (no normalization, no merging) ===');
  plItems.slice(0, 2).forEach((item, i) => console.log(idAudit('playlist[' + i + ']', item)));
  trItems.slice(0, 3).forEach((item, i) => console.log(idAudit('track[' + i + ']', item)));

  console.log('\n[shadow] done. GET-only calls=' + callCount + ' ; no Developer JWT used ; no writes attempted.');
})().catch((err) => {
  console.error('[shadow] failed: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
