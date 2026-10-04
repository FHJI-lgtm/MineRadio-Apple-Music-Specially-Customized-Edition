'use strict';
// 酷狗 → 音乐资料库 适配层契约测试。
// 与网易云同一套策略：字段不确定就留空，绝不编造。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const A = require(path.join(__dirname, '..', 'kugou-library-adapter.js'));

const RAW = {
  provider: 'kugou', source: 'kugou', type: 'kugou',
  id: 'EA0EC380DA462F9028CBF9900BA81F6F',
  hash: 'EA0EC380DA462F9028CBF9900BA81F6F',
  fileHash: 'EA0EC380DA462F9028CBF9900BA81F6F',
  albumId: '80134514', mixSongId: '568502393', albumAudioId: '568502393',
  name: "T'aimer est une galère", artist: 'Molière / PETiTOM',
  artists: [{ id: 9601530, name: 'Molière' }, { id: 1662289, name: 'PETiTOM' }],
  artistId: 9601530, album: 'Molière, le spectacle musical',
  cover: 'http://imge.kugou.com/x.jpg', duration: 163000,
  fee: 0, playable: true, hqHash: '', sqHash: '',
};

test('酷狗适配：曲目映射', async (t) => {
  await t.test('关键字段就位，取流标识用 hash', () => {
    const s = A.toLibrarySong(RAW);
    assert.equal(s.librarySongId, 'kg:EA0EC380DA462F9028CBF9900BA81F6F');
    assert.equal(s.id, 'EA0EC380DA462F9028CBF9900BA81F6F', '播放器按 hash 取流');
    assert.equal(s.hash, RAW.hash);
    assert.equal(s.provider, 'kugou');
    assert.equal(s.type, 'kugou');
    assert.equal(s.name, "T'aimer est une galère");
    assert.equal(s.artist, 'Molière / PETiTOM');
    assert.equal(s.albumName, 'Molière, le spectacle musical', 'album -> albumName');
    assert.equal(s.albumId, '80134514');
    assert.equal(s.cover, 'http://imge.kugou.com/x.jpg');
    assert.equal(s.durationMs, 163000);
    assert.equal(s.duration, 163, '毫秒换算成秒（详情页 fmtDuration 期望秒）');
    assert.ok(s.duration < 3600, '若误留毫秒会显示成 2700+ 分钟');
  });

  await t.test('数据不确定的字段留空', () => {
    const s = A.toLibrarySong(RAW);
    assert.equal(s.releaseDate, '');
    assert.equal(s.trackNumber, 0);
    assert.equal(s.genre, '');
  });

  await t.test('缺 hash 或缺标题的条目丢弃', () => {
    assert.equal(A.toLibrarySong(null), null);
    assert.equal(A.toLibrarySong({ name: 'x' }), null, '没有 hash');
    assert.equal(A.toLibrarySong({ hash: 'abc' }), null, '没有标题');
    assert.equal(A.toLibrarySongs([RAW, null, { hash: 'x' }]).length, 1);
  });

  await t.test('hash 为 0/空时退回 id', () => {
    const s = A.toLibrarySong({ hash: '', id: 'FALLBACK', name: 'n', duration: 1000 });
    assert.equal(s.hash, 'FALLBACK');
  });
});

test('酷狗适配：歌单与专辑', async (t) => {
  await t.test('歌单映射，按名字识别「我喜欢」', () => {
    const p = A.toLibraryPlaylist({ id: 'collection_3_1_2_0', name: '我喜欢', trackCount: 475, cover: 'c' });
    assert.equal(p.id, 'collection_3_1_2_0');
    assert.equal(p.isLiked, true);
    assert.equal(p.trackCount, 475);
    assert.equal(A.toLibraryPlaylist({ id: 'x', name: '默认收藏' }).isLiked, false);
    assert.equal(A.toLibraryPlaylist({ name: '无 id' }), null);
  });

  await t.test('专辑卡与 Apple 索引同形，缺 id 不产出', () => {
    const c = A.toAppleShapedAlbumCard({ albumId: '80134514', name: 'A', artist: 'X', cover: 'c', trackCount: 3 });
    assert.equal(c.provider, 'kugou');
    assert.equal(c.id, 'kg:80134514');
    assert.equal(c.libraryId, 'kg:80134514');
    assert.equal(c.releaseDate, '');
    assert.equal(c.dateAdded, '');
    assert.deepEqual(c.genreNames, []);
    assert.equal(A.toAppleShapedAlbumCard({ name: 'x' }), null);
  });

  await t.test('按 albumId 归并专辑，缺 albumId 的不参与', () => {
    const songs = A.toLibrarySongs([
      { hash: 'h1', name: 'a', album: 'A', albumId: 10, artist: 'x', duration: 1000 },
      { hash: 'h2', name: 'b', album: 'A', albumId: 10, artist: 'x', duration: 1000, cover: 'cover-a' },
      { hash: 'h3', name: 'c', album: 'A', albumId: 0, duration: 1000 },
    ]);
    const albums = A.albumsFromSongs(songs);
    assert.equal(albums.length, 1, 'albumId=0 不算有效专辑');
    assert.equal(albums[0].trackCount, 2);
    assert.equal(albums[0].cover, 'cover-a', '取第一条有封面的');
  });
});

test('酷狗适配：艺人聚合（身份键 artistId）', async (t) => {
  await t.test('按 artistId 归并，同名不同 id 不合并', () => {
    const songs = A.toLibrarySongs([
      { hash: 'h1', name: 'a', artist: '同名', artists: [{ id: 1, name: '同名' }], album: 'A', albumId: 9, duration: 1000 },
      { hash: 'h2', name: 'b', artist: '同名', artists: [{ id: 2, name: '同名' }], album: 'A', albumId: 9, duration: 1000 },
      { hash: 'h3', name: 'c', artist: '同名 / Y', artists: [{ id: 1, name: '同名' }, { id: 3, name: 'Y' }], album: 'A', albumId: 9, duration: 1000 },
    ]);
    const artists = A.artistsFromSongs(songs);
    assert.equal(artists.length, 3);
    assert.equal(artists.filter(a => a.artistId === '1')[0].songCount, 2);
  });

  await t.test('头像留空：酷狗没有艺人详情接口，不得用曲目封面冒充', () => {
    const songs = A.toLibrarySongs([{ hash: 'h1', name: 'a', artist: 'X', artists: [{ id: 1, name: 'X' }], album: 'A', albumId: 9, duration: 1000, cover: 'cover-x' }]);
    const a = A.artistsFromSongs(songs)[0];
    assert.equal(a.image, '');
    assert.equal(a.hasImage, false);
  });
});
