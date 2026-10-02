'use strict';
// ============================================================
// Apple Music 资料库 · 专辑轴排序契约测试
//
// 目标：把「最近添加」的语义钉在数据接口上，而不是 UI 上。
// 用真实的 handler + 真实的 mapLibraryAlbum，只在 https.request 这层注入假 payload。
// 运行: node tests/apple-library-albums-sort.test.js
// ============================================================
const assert = require('node:assert/strict');
const https = require('node:https');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const APP_ROOT = path.resolve(__dirname, '..');
const webApi = require(path.join(APP_ROOT, 'desktop', 'apple-music-web-api.js'));
const reads = require(path.join(APP_ROOT, 'desktop', 'apple-music-web-reads-api.js'));

// 时间轴：id 越大 = 加入越晚。夹具刻意让「按 id 升序」与「按时间新→旧」完全相反，
// 这样任何「没排序」或「按名字排」的实现都会被断言抓住。
const BASE = Date.parse('2024-01-01T00:00:00Z');
const DAY = 86400000;
function dateForId(n) { return new Date(BASE + n * DAY).toISOString(); }
function nameForId(n) { return 'Album ' + String(n).padStart(3, '0'); }

function makeAlbum(idNum, overrides) {
  const attrs = {
    name: nameForId(idNum),
    artistName: 'Artist ' + idNum,
    dateAdded: dateForId(idNum),
    releaseDate: '1999-01-01T00:00:00Z',   // 故意与 dateAdded 无关，用来抓 releaseDate 回退
    artwork: { url: 'https://example.test/{w}x{h}.jpg' },
    trackCount: 10,
    genreNames: ['Pop'],
    playParams: {},
  };
  Object.assign(attrs, (overrides && overrides.attributes) || {});
  return { id: (overrides && overrides.id) || ('l.' + idNum), type: 'library-albums', attributes: attrs };
}

const ALL_ALBUMS = [];
let pageSize = 100;   // stub 侧页长；handler 请求 limit=100，因此 pageSize<100 时才会多页
let capturedRequests = [];

function resetLibrary(count) {
  ALL_ALBUMS.length = 0;
  for (let i = 1; i <= count; i += 1) ALL_ALBUMS.push(makeAlbum(i));
}

function installHttpStub() {
  https.request = function (url, options, callback) {
    const parsed = new URL(String(url));
    const limit = Math.min(Number(parsed.searchParams.get('limit')) || 100, pageSize);
    const offset = Number(parsed.searchParams.get('offset')) || 0;
    capturedRequests.push({ path: parsed.pathname, limit, offset });
    const slice = ALL_ALBUMS.slice(offset, offset + limit);
    const isLast = offset + slice.length >= ALL_ALBUMS.length;
    const payload = { data: slice, meta: { total: ALL_ALBUMS.length } };
    if (!isLast) payload.next = '/v1/me/library/albums?offset=' + (offset + slice.length);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const emitter = new EventEmitter();
    emitter.statusCode = 200;
    emitter.headers = {};
    process.nextTick(function () {
      callback(emitter);
      emitter.emit('data', body);
      emitter.emit('end');
    });
    return { on: function () {}, end: function () {}, setTimeout: function () {} };
  };
}

function names(res) { return (res.albums || []).map(function (a) { return a.name; }); }
function expectedNewestFirst(list) {
  return list.slice().sort(function (a, b) {
    return Date.parse(b.attributes.dateAdded) - Date.parse(a.attributes.dateAdded);
  }).map(function (a) { return a.attributes.name; });
}

installHttpStub();
webApi.setCredentialSource(function () { return 'test-user-token'; });

test('apple music library albums: dateAdded ordering contract', async (t) => {
  await t.test('global Newest -> Oldest across every page', async () => {
    pageSize = 100;
    capturedRequests = [];
    resetLibrary(250);
    // limit 是窗口大小，不是「读多少页」：handler 始终读完整库再排序，然后按窗口切片。
    const res = await reads.handleAppleLibraryAlbums({ limit: 500 });
    assert.equal(res.error, '', 'handler must not report an error: ' + res.error + ' ' + res.message);
    assert.equal(res.total, 250, 'total must be the whole library');
    assert.deepEqual(names(res), expectedNewestFirst(ALL_ALBUMS),
      'the whole library must be Newest -> Oldest');
    assert.ok(capturedRequests.length >= 3,
      'must read every page before sorting, got ' + capturedRequests.length + ' request(s)');
  });

  await t.test('per-page order is NOT what callers see', async () => {
    pageSize = 40;
    capturedRequests = [];
    resetLibrary(250);
    const res = await reads.handleAppleLibraryAlbums({ limit: 500 });
    const globalOrder = names(res);
    const perPageOrder = [];
    for (let off = 0; off < ALL_ALBUMS.length; off += 40) {
      perPageOrder.push.apply(perPageOrder, expectedNewestFirst(ALL_ALBUMS.slice(off, off + 40)));
    }
    assert.ok(capturedRequests.length >= 6, 'smaller pages must produce more requests');
    assert.deepEqual(globalOrder, expectedNewestFirst(ALL_ALBUMS),
      'the result must equal the globally sorted library');
    assert.notDeepEqual(globalOrder, perPageOrder,
      'per-page sorting must NOT be what callers see');
    assert.equal(globalOrder[0], nameForId(250), 'newest item must be first');
    assert.equal(globalOrder[globalOrder.length - 1], nameForId(1), 'oldest item must be last');
  });

  await t.test('missing dateAdded sinks and keeps library order', async () => {
    pageSize = 100;
    resetLibrary(10);
    // 把 001/003/005 的 dateAdded 抹掉，并让 005 排在最后
    const undated = [ALL_ALBUMS[0], ALL_ALBUMS[4], ALL_ALBUMS[2]].map(function (a) {
      const copy = JSON.parse(JSON.stringify(a));
      copy.attributes.dateAdded = '';
      return copy;
    });
    const mixed = undated.slice(0, 1).concat(ALL_ALBUMS.slice(1, 4), undated.slice(1), ALL_ALBUMS.slice(5));
    ALL_ALBUMS.length = 0;
    mixed.forEach(function (a) { ALL_ALBUMS.push(a); });
    const res = await reads.handleAppleLibraryAlbums({ limit: 500 });
    const order = names(res);
    const datedCount = mixed.filter(function (a) { return a.attributes.dateAdded; }).length;
    assert.deepEqual(order.slice(0, datedCount),
      expectedNewestFirst(mixed.filter(function (a) { return a.attributes.dateAdded; })),
      'dated items must still be Newest -> Oldest');
    assert.deepEqual(order.slice(datedCount), ['Album 001', 'Album 005', 'Album 003'],
      'undated items must sink AND keep their original relative order, got ' + JSON.stringify(order.slice(datedCount)));
    // releaseDate 在夹具里全是 1999-01-01：若被当成排序键，会得到完全不同的顺序
    assert.notEqual(order[0], 'Album 001',
      'a missing dateAdded must never be back-filled from releaseDate');
  });

  await t.test('equal timestamps keep original relative order', async () => {
    pageSize = 100;
    resetLibrary(6);
    ALL_ALBUMS.forEach(function (a) { a.attributes.dateAdded = '2026-01-01T00:00:00Z'; });
    const expected = ALL_ALBUMS.map(function (a) { return a.attributes.name; });
    const res = await reads.handleAppleLibraryAlbums({ limit: 500 });
    assert.deepEqual(names(res), expected, 'stable sort must preserve the original order');
  });

  await t.test('not logged in returns empty with an explanation', async () => {
    resetLibrary(3);
    webApi.setCredentialSource(function () { return ''; });
    const res = await reads.handleAppleLibraryAlbums({});
    assert.deepEqual(res.albums, [], 'not logged in must return no albums');
    assert.equal(res.loggedIn, false);
    assert.match(res.message, /登录/, 'not logged in must explain itself: ' + res.message);
    webApi.setCredentialSource(function () { return 'test-user-token'; });
  });

  await t.test('id/catalogId rules and self-describing order', async () => {
    pageSize = 100;
    ALL_ALBUMS.length = 0;
    const older = makeAlbum(1);
    older.attributes.playParams = { catalogId: '6789678128' };
    ALL_ALBUMS.push(older, makeAlbum(2));
    const res = await reads.handleAppleLibraryAlbums({ limit: 100 });
    const newest = res.albums[0];
    assert.equal(newest.name, 'Album 002', 'newest must come first');
    assert.equal(newest.id, newest.libraryId, 'id must stay the LIBRARY id');
    assert.match(newest.id, /^l\./, 'library ids keep the l.* namespace');
    assert.equal(newest.catalogId, undefined, 'catalogId must never be inferred or synthesised');
    const withCatalog = res.albums.filter(function (a) { return a.name === 'Album 001'; })[0];
    assert.equal(withCatalog.catalogId, '6789678128', 'catalogId must be copied verbatim from playParams');
    assert.equal(res.sortedBy, 'dateAdded', 'the order must be self-describing');
    assert.equal(res.sortDirection, 'desc');
  });

  await t.test('paging windows are built after the global sort', async () => {
    pageSize = 100;
    resetLibrary(10);
    const p0 = await reads.handleAppleLibraryAlbums({ limit: 3, offset: 0 });
    const p1 = await reads.handleAppleLibraryAlbums({ limit: 3, offset: 3 });
    const p3 = await reads.handleAppleLibraryAlbums({ limit: 3, offset: 9 });
    assert.deepEqual(names(p0), ['Album 010', 'Album 009', 'Album 008'], 'page 0 = newest 3');
    assert.deepEqual(names(p1), ['Album 007', 'Album 006', 'Album 005'], 'page 1 continues the GLOBAL order');
    assert.equal(p0.total, 10);
    assert.equal(p1.hasMore, true);
    assert.equal(p3.hasMore, false, 'last window must report hasMore=false');
  });
});