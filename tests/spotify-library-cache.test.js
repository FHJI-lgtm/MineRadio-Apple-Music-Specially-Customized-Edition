'use strict';
// ============================================================
// Spotify 资料库：落盘缓存 + 节流 + 分页 + 增量
//
// 起因：最初每次请求都现场重拉（索引一次 40+ 次 API 调用），
// 很快吃到 429，而且越重试越糟（实测 38 次请求即触发限流）。
// 现在：**先落盘、增量同步、全程节流、限流即停**。
// ============================================================
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const mod = require(path.join(ROOT, 'desktop', 'spotify-library-cache.js'));
const adapter = require(path.join(ROOT, 'spotify-library-adapter.js'));
const { createSpotifyLibraryCache, createThrottle, SPOTIFY_CACHE_SCHEMA_VERSION } = mod;

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cache-')), name);
}
function song(id, albumId) {
  return { provider: 'spotify', id: id, spotifyId: id, name: 'T' + id, artist: 'A', album: 'Al', albumId: albumId, artists: [{ id: 'ar1', name: 'A' }], cover: 'c', durationMs: 1000 };
}

test('节流器：请求串行且保持最小间隔，限流后退避', async (t) => {
  await t.test('相邻请求间隔不小于设定值', async () => {
    const th = createThrottle({ minIntervalMs: 60 });
    const stamps = [];
    for (let i = 0; i < 4; i += 1) {
      await th.run(async () => { stamps.push(Date.now()); });
    }
    for (let i = 1; i < stamps.length; i += 1) {
      assert.ok(stamps[i] - stamps[i - 1] >= 45, '间隔应 >= ~60ms（实际 ' + (stamps[i] - stamps[i - 1]) + '）');
    }
    assert.equal(th.snapshot().requests, 4);
  });

  await t.test('退避期内直接拒绝，不排队堆积', async () => {
    const th = createThrottle({ minIntervalMs: 1 });
    th.noteRateLimit(500);
    await assert.rejects(() => th.run(async () => 1), (e) => e.code === 'SPOTIFY_BACKOFF');
    const snap = th.snapshot();
    assert.equal(snap.backoffs, 1);
    assert.ok(snap.backoffRemainingMs > 0, '应报告剩余退避时间');
  });

  await t.test('单个任务失败不卡死后续', async () => {
    const th = createThrottle({ minIntervalMs: 1 });
    await assert.rejects(() => th.run(async () => { throw new Error('boom'); }));
    assert.equal(await th.run(async () => 'ok'), 'ok');
  });
});

test('同步引擎：分页取全 / 增量 / 落盘', async (t) => {
  await t.test('歌单曲目按页取全（Spotify 每页上限 50）', async () => {
    const pages = [
      { tracks: [song('a', 'al1'), song('b', 'al1')], total: 3, hasMore: true, nextOffset: 2 },
      { tracks: [song('c', 'al2')], total: 3, hasMore: false, nextOffset: 3 },
    ];
    let call = 0;
    const cache = createSpotifyLibraryCache({
      cachePath: tmpFile('x.json'),
      adapter: adapter,
      throttle: createThrottle({ minIntervalMs: 1 }),
      listPlaylists: async () => ({ playlists: [{ id: 'p1', name: 'P1', snapshotId: 's1', trackCount: 3 }] }),
      playlistTracks: async (id, o) => { const p = pages[call] || { tracks: [], hasMore: false }; call += 1; return p; },
    });
    const out = await cache.sync();
    assert.equal(out.ok, true);
    assert.equal(cache.playlistTracks('p1').length, 3, '应取满 3 首');
    assert.equal(out.playlistsRefetched, 1);
  });

  await t.test('snapshot 未变的歌单不重拉曲目（增量）', async () => {
    const file = tmpFile('inc.json');
    let trackCalls = 0;
    const mk = () => createSpotifyLibraryCache({
      cachePath: file,
      adapter: adapter,
      throttle: createThrottle({ minIntervalMs: 1 }),
      listPlaylists: async () => ({ playlists: [{ id: 'p1', name: 'P1', snapshotId: 'SAME', trackCount: 2 }] }),
      playlistTracks: async () => { trackCalls += 1; return { tracks: [song('a', 'al1'), song('b', 'al1')], total: 2, hasMore: false }; },
    });
    const c1 = mk();
    await c1.sync();
    assert.equal(trackCalls, 1);
    // 第二次：snapshot 相同 -> 不该再拉曲目
    const c2 = createSpotifyLibraryCache({
      cachePath: file,
      adapter: adapter,
      throttle: createThrottle({ minIntervalMs: 1 }),
      listPlaylists: async () => ({ playlists: [{ id: 'p1', name: 'P1', snapshotId: 'SAME', trackCount: 2 }] }),
      playlistTracks: async () => { trackCalls += 1; return { tracks: [], total: 2, hasMore: false }; },
    });
    c2.loadFromDisk();
    await c2.sync();
    assert.equal(trackCalls, 1, 'snapshot 未变时不得重复拉曲目');
  });

  await t.test('snapshot 变了就重拉', async () => {
    const file = tmpFile('chg.json');
    let trackCalls = 0;
    const c1 = createSpotifyLibraryCache({
      cachePath: file, adapter: adapter, throttle: createThrottle({ minIntervalMs: 1 }),
      listPlaylists: async () => ({ playlists: [{ id: 'p1', name: 'P1', snapshotId: 'V1', trackCount: 1 }] }),
      playlistTracks: async () => { trackCalls += 1; return { tracks: [song('a', 'al1')], total: 1, hasMore: false }; },
    });
    await c1.sync();
    const c2 = createSpotifyLibraryCache({
      cachePath: file, adapter: adapter, throttle: createThrottle({ minIntervalMs: 1 }),
      listPlaylists: async () => ({ playlists: [{ id: 'p1', name: 'P1', snapshotId: 'V2', trackCount: 1 }] }),
      playlistTracks: async () => { trackCalls += 1; return { tracks: [song('a', 'al1')], total: 1, hasMore: false }; },
    });
    c2.loadFromDisk();
    await c2.sync();
    assert.equal(trackCalls, 2, 'snapshot 变化必须重拉');
  });

  await t.test('喜欢的歌曲用 after 游标增量推进，游标不前进就停', async () => {
    const seen = [];
    const cache = createSpotifyLibraryCache({
      cachePath: tmpFile('liked.json'), adapter: adapter, throttle: createThrottle({ minIntervalMs: 1 }),
      listPlaylists: async () => ({ playlists: [] }),
      savedTracks: async (o) => {
        seen.push(o.after || '');
        if (!o.after) return { tracks: [song('a', 'al1')], total: 2, hasMore: true, cursor: 'CUR1' };
        return { tracks: [song('b', 'al1')], total: 2, hasMore: true, cursor: 'CUR1' };   // 游标不再前进
      },
    });
    await cache.sync();
    assert.ok(seen.length >= 2, '应该至少拉两页');
    assert.equal(seen[1], 'CUR1', '第二页要带上第一页的游标');
    assert.ok(seen.length <= 3, '游标不前进必须停止，不能死循环猛打（实际 ' + seen.length + ' 次）');
  });

  await t.test('数据落盘且能从盘上读回', async () => {
    const file = tmpFile('disk.json');
    const c1 = createSpotifyLibraryCache({
      cachePath: file, adapter: adapter, throttle: createThrottle({ minIntervalMs: 1 }),
      listPlaylists: async () => ({ playlists: [{ id: 'p1', name: 'P1', snapshotId: 's', trackCount: 1 }] }),
      playlistTracks: async () => ({ tracks: [song('z', 'al9')], total: 1, hasMore: false }),
    });
    await c1.sync();
    assert.ok(fs.existsSync(file), '必须写盘');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.schemaVersion, SPOTIFY_CACHE_SCHEMA_VERSION);
    assert.equal(raw.tracks.length, 1);
    // 新实例只读盘、不给任何依赖，也应该能读出内容
    const c2 = createSpotifyLibraryCache({ cachePath: file, adapter: adapter });
    assert.equal(c2.songs().length, 1, '重启后应直接读盘');
    assert.equal(c2.playlistTracks('p1').length, 1);
  });

  await t.test('schemaVersion 不符时当空缓存（不误用旧结构）', async () => {
    const file = tmpFile('ver.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 999, tracks: [song('x', 'al1')] }), 'utf8');
    const c = createSpotifyLibraryCache({ cachePath: file, adapter: adapter });
    assert.equal(c.songs().length, 0, '版本不符必须丢弃');
  });

  await t.test('原子写：不残留半截文件', async () => {
    const file = tmpFile('atomic.json');
    const c = createSpotifyLibraryCache({
      cachePath: file, adapter: adapter, throttle: createThrottle({ minIntervalMs: 1 }),
      listPlaylists: async () => ({ playlists: [] }),
    });
    c.loadFromDisk();
    c.setArtistImage('ar1', 'http://x/y.jpg');
    c.persist();
    assert.ok(fs.existsSync(file));
    assert.equal(fs.existsSync(file + '.tmpdir'), false, '临时文件必须改名，不残留');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).artistImage.length, 1);
  });
});

test('同步引擎：限流处理与"已拿到的数据要留住"', async (t) => {
  await t.test('限流时如实返回 RATE_LIMITED 并进入退避', async () => {
    const th = createThrottle({ minIntervalMs: 1 });
    const cache = createSpotifyLibraryCache({
      cachePath: tmpFile('rl.json'), adapter: adapter, throttle: th,
      listPlaylists: async () => { const e = new Error('rate'); e.statusCode = 429; e.retryAfterSeconds = 2; throw e; },
    });
    const out = await cache.sync();
    assert.equal(out.ok, false);
    assert.equal(out.error, 'RATE_LIMITED');
    assert.equal(th.snapshot().backoffs, 1, '要记录退避');
  });

  await t.test('限流时**已经拿到的数据必须落盘**（否则下次从头再打）', async () => {
    const file = tmpFile('keep.json');
    const cache = createSpotifyLibraryCache({
      cachePath: file, adapter: adapter, throttle: createThrottle({ minIntervalMs: 1 }),
      listPlaylists: async () => ({ playlists: [{ id: 'p1', name: 'P1', snapshotId: 's', trackCount: 1 }] }),
      playlistTracks: async () => ({ tracks: [song('kept', 'al1')], total: 1, hasMore: false }),
      savedTracks: async () => { const e = new Error('rate'); e.statusCode = 429; throw e; },
    });
    const out = await cache.sync();
    assert.equal(out.error, 'RATE_LIMITED');
    assert.ok(fs.existsSync(file), '限流也必须落盘');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.tracks.length, 1, '限流前拿到的曲目要留在盘上');
    assert.equal(raw.sync.lastSyncAt, 0, '但不得把这次记为成功同步');
  });

  await t.test('依赖没接好时如实报错，不静默返回空', async () => {
    const cache = createSpotifyLibraryCache({ cachePath: tmpFile('nw.json') });
    const out = await cache.sync();
    assert.equal(out.ok, false);
    assert.equal(out.error, 'SYNC_NOT_WIRED');
  });
});

test('打包完整性：新增的缓存模块必须在白名单里', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = pkg.build.files;
  // desktop/**/* 覆盖 desktop/spotify-library-cache.js
  assert.ok(files.indexOf('desktop/**/*') >= 0, 'desktop 目录应在白名单');
  assert.ok(files.indexOf('*-library-adapter.js') >= 0, '适配层通配应在白名单');
  const modPath = path.join(ROOT, 'desktop', 'spotify-library-cache.js');
  assert.ok(fs.existsSync(modPath), '缓存模块文件应存在');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(server.indexOf("require('./desktop/spotify-library-cache')") > 0, 'server 必须引用它');
});
