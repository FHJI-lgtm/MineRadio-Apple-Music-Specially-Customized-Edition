'use strict';
// ============================================================
// Spotify → 音乐资料库 适配层测试
//
// 实测事实（Spotify Web API，用户 token）：
//   - 曲目自带 albumId / artists[{id,name}] / cover / duration(毫秒)，与其它源一一对应
//   - 专辑详情接口已存在且带 releaseDate + trackCount
//   - 官方 Web API **不提供音频直链**：/api/spotify/song/url 返回
//     playable=false + reason=provider_limited + action=switch_source（自动换源）
//   - 艺人头像要单独请求 /v1/artists/{id}
// ============================================================
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const adapter = require(path.join(ROOT, 'spotify-library-adapter.js'));
const fs = require('node:fs');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SERVER = read('server.js');
const MUSIC_LIBRARY = read('public/js/modules/10-shell/06-music-library.js');

const TRACK = {
  provider: 'spotify', source: 'spotify', type: 'spotify',
  id: '5aAx2yezTd8zXrkmtKl66Z', spotifyId: '5aAx2yezTd8zXrkmtKl66Z',
  uri: 'spotify:track:5aAx2yezTd8zXrkmtKl66Z', spotifyUri: 'spotify:track:5aAx2yezTd8zXrkmtKl66Z',
  name: 'Starboy', artist: 'The Weeknd / Daft Punk',
  artists: [{ id: '1Xyo4u8uXC1ZmMpatF05PJ', name: 'The Weeknd' }, { id: '4tZwfgrHOc3mvqYlEYSvVi', name: 'Daft Punk' }],
  album: 'Starboy', albumId: '4yP0hdKOZPNshxUOjY0cZj', albumUri: 'spotify:album:4yP0hdKOZPNshxUOjY0cZj',
  cover: 'https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36',
  duration: 230453, durationMs: 230453, playable: true,
};

test('Spotify 适配层 · 曲目', async (t) => {
  await t.test('基本字段一一对应', () => {
    const s = adapter.toLibrarySong(TRACK);
    assert.ok(s, '应映射成功');
    assert.equal(s.provider, 'spotify');
    assert.equal(s.name, 'Starboy');
    assert.equal(s.albumName, 'Starboy');
    assert.equal(s.albumId, '4yP0hdKOZPNshxUOjY0cZj');
    assert.equal(s.artistId, '1Xyo4u8uXC1ZmMpatF05PJ', '艺人身份取 artists[0].id');
    assert.equal(s.durationMs, 230453, 'duration 本身就是毫秒（不是秒）');
    assert.equal(s.duration, 230, '秒 = 毫秒/1000 四舍五入');
  });

  await t.test('librarySongId 带 sp: 前缀（与其它源隔离）', () => {
    const s = adapter.toLibrarySong(TRACK);
    assert.equal(s.librarySongId, 'sp:5aAx2yezTd8zXrkmtKl66Z');
  });

  await t.test('缺 id / 缺名字的条目直接丢弃，不占位', () => {
    assert.equal(adapter.toLibrarySong({ name: 'x' }), null, '缺 id');
    assert.equal(adapter.toLibrarySong({ id: 'abc' }), null, '缺名字');
    assert.equal(adapter.toLibrarySong(null), null);
    assert.equal(adapter.toLibrarySongs([TRACK, null, { id: 'a' }]).length, 1, '只留合法的');
  });

  await t.test('不编造 Spotify 不提供的信息', () => {
    const s = adapter.toLibrarySong(TRACK);
    assert.equal(s.trackNumber, 0, '曲序不确定就 0');
    assert.equal(s.releaseDate, '', '曲目不带发行日就留空');
    assert.equal(s.genre, '', '不编造流派');
  });
});

test('Spotify 适配层 · 专辑与艺人', async (t) => {
  await t.test('专辑卡沿用 Apple 资料库形状', () => {
    const c = adapter.toAppleShapedAlbumCard({ albumId: '4yP', name: 'After Hours', artist: 'The Weeknd', cover: 'x', releaseDate: '2020-03-20', trackCount: 14 });
    assert.ok(c);
    assert.equal(c.provider, 'spotify');
    assert.equal(c.id, 'sp:4yP');
    assert.equal(c.libraryId, 'sp:4yP');
    assert.equal(c.albumId, 'sp:4yP');
    assert.equal(c.releaseDate, '2020-03-20');
    assert.equal(c.trackCount, 14);
  });

  await t.test('按 albumId 归并曲目为专辑', () => {
    // 约定：albumsFromSongs 吃的是**已映射**的曲目（字段是 albumName），
    // 所以先过 toLibrarySong —— 直接喂原始 Spotify 形状会拿到 0 张。
    const mapped = adapter.toLibrarySongs([TRACK, Object.assign({}, TRACK, { id: 'other', albumId: 'B1', album: 'Other' })]);
    const list = adapter.albumsFromSongs(mapped);
    assert.equal(list.length, 2);
    assert.equal(list.find((a) => a.albumId === '4yP0hdKOZPNshxUOjY0cZj').trackCount, 1);
    assert.equal(list.find((a) => a.albumId === 'B1').name, 'Other');
  });

  await t.test('缺 albumId 的曲目不参与归并（不确定就留空）', () => {
    const mapped = adapter.toLibrarySongs([Object.assign({}, TRACK, { albumId: '' })]);
    const list = adapter.albumsFromSongs(mapped);
    assert.equal(list.length, 0);
  });

  await t.test('艺人按 artists[].id 聚合，头像不由曲目封面冒充', () => {
    const arts = adapter.artistsFromSongs([TRACK]);
    assert.equal(arts.length, 2);
    const wk = arts.find((a) => a.artistId === '1Xyo4u8uXC1ZmMpatF05PJ');
    assert.equal(wk.name, 'The Weeknd');
    assert.equal(wk.songCount, 1);
    assert.equal(wk.image, '', '曲目封面不是艺人头像');
    assert.equal(wk.hasImage, false);
  });

  await t.test('「喜欢的歌曲」按 id 判断，不靠名字猜', () => {
    const pl = adapter.toLibraryPlaylist({ id: 'spotify-liked', name: '随便什么名字', trackCount: 10 });
    assert.equal(pl.virtual, true);
    assert.equal(pl.isLiked, true);
    const normal = adapter.toLibraryPlaylist({ id: 'abc123', name: 'spotify-liked', trackCount: 3 });
    assert.equal(normal.virtual, false, '名字里带 spotify-liked 不算');
  });
});

test('Spotify 资料库 · 服务端与前端接线', async (t) => {
  await t.test('四个资料库端点都在', () => {
    ['/api/spotify/library/index', '/api/spotify/library/playlist/tracks', '/api/spotify/library/album/tracks', '/api/spotify/library/artists', '/api/spotify/library/artist/detail'].forEach((p) => {
      assert.ok(SERVER.indexOf("'" + p + "'") > 0, '缺端点 ' + p);
    });
  });

  await t.test('前端已把 Spotify 登记为可用源并接上端点', () => {
    assert.ok(MUSIC_LIBRARY.indexOf("spotify: { label: 'Spotify', ready: true }") > 0, 'Spotify 必须 ready:true');
    assert.ok(MUSIC_LIBRARY.indexOf("index: '/api/spotify/library/index'") > 0, '端点表要有 Spotify');
    assert.ok(MUSIC_LIBRARY.indexOf('/api/spotify/library/artists') > 0);
  });

  await t.test('Spotify 不查维基（没有艺人简介接口，避免张冠李戴）', () => {
    const marker = "index: '/api/spotify/library/index'";
    const i = MUSIC_LIBRARY.indexOf(marker);
    assert.ok(i > 0, 'Spotify 端点条目应存在');
    const block = MUSIC_LIBRARY.slice(i, i + 900);
    assert.ok(block.indexOf('usesWikiApi: false') > 0, 'Spotify 必须关掉维基');
  });

  await t.test('播放走既有「自动换源」，不假装能取流', () => {
    // 官方 Web API 不提供音频直链，song/url 已返回 provider_limited + switch_source
    assert.ok(SERVER.indexOf("'/api/spotify/song/url'") > 0, 'song/url 端点应在');
    // 不得为 Spotify 编造直链逻辑
    assert.equal(/spotify[sS]{0,200}?directAudioUrl/i.test(SERVER), false, '不得为 Spotify 编造直链');
  });
});
