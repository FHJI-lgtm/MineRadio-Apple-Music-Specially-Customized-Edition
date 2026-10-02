'use strict';
// ============================================================
// Apple Music 资料库 · 专辑轴接线契约
//
// 运行时行为在 tests/apple-library-albums-sort.test.js 里测。
// 这里只钉几件"描述符/接线"层面的不变量，防止后续重构把语义弄丢：
//   * handler 被导出（否则路由拿不到）
//   * server.js 真的注册了路由，且解析了 limit/offset
//   * 排序键是 dateAdded，releaseDate 不得进入排序路径
//   * 排序发生在"收完所有页"之后（sort 调用必须在 while 循环之后）
// 运行: node tests/apple-library-albums-wiring.test.js
// ============================================================
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const readsSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'apple-music-web-reads-api.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

test('library albums axis: exports, route wiring and ordering semantics', () => {
  // ---------- 导出 ----------
  assert.match(readsSrc, /handleAppleLibraryAlbums,/, 'handler must be exported from the reads module');
  const reads = require(path.join(ROOT, 'desktop', 'apple-music-web-reads-api.js'));
  assert.strictEqual(typeof reads.handleAppleLibraryAlbums, 'function', 'handler must be a function');

  // ---------- 路由 ----------
  assert.match(serverSrc, /handleAppleLibraryAlbums/, 'server must import the handler');
  assert.match(serverSrc, /pn === '\/api\/apple\/library\/albums'/, 'server must register the library albums route');
  const routeBlock = serverSrc.slice(
    serverSrc.indexOf("pn === '/api/apple/library/albums'"),
    serverSrc.indexOf("pn === '/api/apple/library/albums'") + 700
  );
  assert.match(routeBlock, /handleAppleLibraryAlbums\(\{ limit, offset \}\)/, 'route must pass limit and offset through');
  assert.match(routeBlock, /url\.searchParams\.get\('limit'\)/, 'route must read the limit query param');
  assert.match(routeBlock, /url\.searchParams\.get\('offset'\)/, 'route must read the offset query param');

  // ---------- 排序键与顺序 ----------
  const handlerStart = readsSrc.indexOf('async function handleAppleLibraryAlbums');
  assert.ok(handlerStart > 0, 'handler body must exist');
  const handlerSrc = readsSrc.slice(handlerStart);

  assert.match(handlerSrc, /sortedBy: 'dateAdded'/, 'the response must self-describe its sort key');
  assert.match(handlerSrc, /sortDirection: 'desc'/, 'the response must self-describe its direction');
  assert.match(handlerSrc, /compareAppleAlbumsByAddedAt/, 'handler must sort with the dateAdded comparator');

  // 比较器区块：排序键与沉底规则都在这里，且绝不能出现 releaseDate
  const comparatorStart = readsSrc.indexOf('function appleAlbumAddedAt');
  const comparatorEnd = readsSrc.indexOf('async function handleAppleLibraryAlbums');
  const sortPath = readsSrc.slice(comparatorStart, comparatorEnd);
  assert.match(sortPath, /album\.dateAdded/, 'the sort key must be album.dateAdded');
  assert.ok(sortPath.length > 0, 'comparator block must exist');
  assert.ok(!/releaseDate/.test(sortPath),
    'releaseDate must never be used as a sort key (publication date != library add date)');

  // 排序必须发生在读完全部页之后：sort 调用晚于 while 循环
  const whileIdx = handlerSrc.indexOf('while (true)');
  const sortIdx = handlerSrc.indexOf('ordered.sort(');
  assert.ok(whileIdx > 0, 'handler must page through the whole library');
  assert.ok(sortIdx > whileIdx,
    'sorting must happen AFTER the paging loop, otherwise the order would only be per-page');

  // ---------- 沉底规则 ----------
  assert.match(sortPath, /if \(ta === null\) return 1;/, 'missing dateAdded must sink');
  assert.match(sortPath, /if \(ta === null && tb === null\) return 0;/,
    'two missing dates must preserve their original relative order');

});